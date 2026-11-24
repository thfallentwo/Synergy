import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { Synergy } from '../src/core/service';
import { openDb } from '../src/core/store';
import { startUiServer, type UiServer } from '../src/web/httpServer';
import { findUiDir } from '../src/web/uiDir';
import { tmpRoot } from './helpers';

let srv: UiServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

async function boot() {
  const svc = new Synergy(openDb(':memory:'), { root: tmpRoot() });
  srv = await startUiServer(svc, { port: 0, uiDir: findUiDir(), pollMs: 40 });
  return { svc, srv, base: srv.url.replace(/\/$/, '') };
}

const postJson = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

/** Minimal SSE reader: resolves once `want` events have arrived. */
async function readSse(url: string, want: string[], trigger?: () => void, ms = 4000) {
  const ac = new AbortController();
  const res = await fetch(url, { signal: ac.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const got: { event: string; data: any }[] = [];
  let buf = '';
  const timer = setTimeout(() => ac.abort(), ms);
  let triggered = false;
  try {
    while (!want.every((w) => got.some((g) => g.event === w))) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (ev && data) got.push({ event: ev, data: JSON.parse(data) });
        if (ev === 'init' && trigger && !triggered) {
          triggered = true;
          trigger();
        }
      }
    }
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return got;
}

describe('dashboard server', () => {
  it('serves the page with a token and the icons; blocks traversal', async () => {
    const { base, srv } = await boot();
    const html = await (await fetch(base + '/')).text();
    expect(html).toContain(srv.token);
    expect(html).not.toContain('__SYNERGY_TOKEN__');
    const png = await fetch(base + '/icons/claude-code.png');
    expect(png.headers.get('content-type')).toBe('image/png');
    expect((await fetch(base + '/icons/nope.png')).status).toBe(404);
    expect((await fetch(base + '/icons/..%2Findex.html')).status).toBe(404);
  });

  it('requires the token (and a sane Origin) for writes', async () => {
    const { base, srv, svc } = await boot();
    expect((await postJson(base, '/api/message', { text: 'hi' })).status).toBe(403);
    expect((await postJson(base, '/api/message', { text: 'hi' }, { 'X-Synergy-Token': 'wrong' })).status).toBe(403);
    expect((await postJson(base, '/api/message', { text: 'hi' }, { 'X-Synergy-Token': srv.token, Origin: 'http://evil.example' })).status).toBe(403);
    const ok = await postJson(base, '/api/message', { text: '@claude hello' }, { 'X-Synergy-Token': srv.token });
    expect(ok.status).toBe(200);
    expect(svc.recentEvents().at(-1)).toMatchObject({ type: 'human', to_agent: 'claude', text: 'hello' });
    expect((await postJson(base, '/api/message', { text: '  ' }, { 'X-Synergy-Token': srv.token })).status).toBe(400);
  });

  it('supports force-unlock and language changes', async () => {
    const { base, srv, svc } = await boot();
    svc.lockFile({ agent: 'claude', file: 'a.ts' });
    const h = { 'X-Synergy-Token': srv.token };
    expect((await (await postJson(base, '/api/unlock', { file: 'a.ts' }, h)).json()).unlocked).toBe(true);
    expect(svc.state().locks).toHaveLength(0);
    await postJson(base, '/api/lang', { lang: 'tr' }, h);
    expect(svc.getLang()).toBe('tr');
    expect((await postJson(base, '/api/lang', { lang: '<x>' }, h)).status).toBe(400);
  });

  it('rejects foreign Host headers (DNS rebinding)', async () => {
    const { srv } = await boot();
    const status = await new Promise<number>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: srv.port, path: '/api/state', headers: { Host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      r.on('error', reject);
      r.end();
    });
    expect(status).toBe(403);
  });

  it('streams init, then events, state and diffs live over SSE', async () => {
    const { base, svc } = await boot();
    const got = await readSse(base + '/events', ['init', 'events', 'state', 'diffs'], () => {
      svc.lockFile({ agent: 'claude', file: 'a.ts' });
      svc.postStatus({ agent: 'claude', action: 'INFO', file: '-', summary: 'live!', added: 3 });
      svc.db.prepare("INSERT INTO diffs(ts,agent,file,added,removed,patch) VALUES(1,'claude','a.ts',1,0,'x')").run();
    });
    const names = got.map((g) => g.event);
    expect(names[0]).toBe('init');
    expect(names).toEqual(expect.arrayContaining(['events', 'state', 'diffs']));
    const evs = got.filter((g) => g.event === 'events').flatMap((g) => g.data);
    expect(evs.some((e: any) => e.text === 'live!')).toBe(true);
    const state = got.filter((g) => g.event === 'state').at(-1)!.data.state;
    expect(state.agents[0]).toMatchObject({ name: 'claude', added: 3 });
    expect(state.locks[0].file).toBe('a.ts');
  });

  it('resyncs clients when the store is reset (demo loop)', async () => {
    const { base, svc } = await boot();
    svc.postStatus({ agent: 'claude', action: 'INFO', file: '-', summary: 'one' });
    svc.postStatus({ agent: 'claude', action: 'INFO', file: '-', summary: 'two' });
    const got = await readSse(base + '/events', ['init'], undefined, 500).catch(() => []);
    expect(got[0].event).toBe('init');
    // second connection: reset after init, expect a second init
    const second = await readSse(base + '/events', ['init'], () => {
      for (const t of ['events', 'agents', 'locks', 'snapshots', 'diffs', 'sqlite_sequence']) svc.db.exec(`DELETE FROM ${t}`);
    }, 800).catch(() => []);
    expect(second[0].event).toBe('init');
  });
});
