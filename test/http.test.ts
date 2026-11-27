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
    expect((await fetch(base + '/icons/llama.png')).status).toBe(200);
    expect((await fetch(base + '/icons/muse.png')).status).toBe(200);
    const css = await fetch(base + '/styles/base.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    const js = await fetch(base + '/app/main.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect((await fetch(base + '/icons/nope.png')).status).toBe(404);
    expect((await fetch(base + '/icons/..%2Findex.html')).status).toBe(404);
    expect((await fetch(base + '/app/..%2Findex.html')).status).toBe(404);
    expect((await fetch(base + '/styles/..%2Findex.html')).status).toBe(404);
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

  it('supports clearing agents and resolving/revoking agent commands', async () => {
    const { base, srv, svc } = await boot();
    const h = { 'X-Synergy-Token': srv.token };
    svc.readFeed({ agent: 'claude' });
    svc.sendCommand({ from: 'cursor', to: 'claude', command: 'run vitest' });
    expect(svc.state().pendingCommands).toHaveLength(1);

    const resResolve = await postJson(base, '/api/command/resolve', { id: 1, decision: 'always' }, h);
    expect(resResolve.status).toBe(200);
    expect(await resResolve.json()).toMatchObject({ status: 'approved' });
    expect(svc.state().trustedAgents).toEqual(['cursor']);

    const resRevoke = await postJson(base, '/api/command/revoke', { agent: 'cursor' }, h);
    expect(resRevoke.status).toBe(200);
    expect(await resRevoke.json()).toEqual({ revoked: true });
    expect(svc.state().trustedAgents).toEqual([]);

    const resClear = await postJson(base, '/api/clear-agents', {}, h);
    expect(resClear.status).toBe(200);
    expect(await resClear.json()).toEqual({ cleared: 2 });
    expect(svc.state().agents).toHaveLength(0);
  });

  it('serves /api/usage and completes /api/research/reply', async () => {
    const { base, srv, svc } = await boot();
    const h = { 'X-Synergy-Token': srv.token };
    const req = svc.queueResearch({ from: 'codex', query: 'Copyright check for X' });

    const uRes = await fetch(base + '/api/usage');
    expect(uRes.status).toBe(200);
    const uJson = await uRes.json();
    expect(Array.isArray(uJson.items)).toBe(true);
    expect(typeof uJson.resetInMs).toBe('number');
    expect(uJson.items.some((x: any) => x.agent === 'codex')).toBe(true);

    const rRes = await postJson(base, '/api/research/reply', { id: req.id, report: 'X is MIT licensed.' }, h);
    expect(rRes.status).toBe(200);
    expect(await rRes.json()).toMatchObject({ ok: true });
    expect(svc.state().pendingResearch).toHaveLength(0);
  });

  it('supports image upload, message edit, and message recall', async () => {
    const { base, srv } = await boot();
    const h = { 'X-Synergy-Token': srv.token };
    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

    const up = await postJson(base, '/api/upload', { dataUrl: tinyPng }, h);
    expect(up.status).toBe(200);
    const { url } = await up.json();
    expect(url).toMatch(/^\/uploads\/[a-z0-9-]+\.png$/);
    expect((await fetch(base + url)).status).toBe(200);

    const msg = await (await postJson(base, '/api/message', { text: 'oops', image: url }, h)).json();
    const ed = await postJson(base, '/api/message/edit', { id: msg.id, text: '@claude fixed' }, h);
    expect(ed.status).toBe(200);

    const del = await postJson(base, '/api/message/delete', { id: msg.id }, h);
    expect(del.status).toBe(200);
    expect(await del.json()).toMatchObject({ ok: true, text: '@claude fixed', image: url });
  });

  it('supports per-agent pause, recall-last, and Perplexity API key settings', async () => {
    const { base, srv, svc } = await boot();
    const h = { 'X-Synergy-Token': srv.token };

    const pRes = await postJson(base, '/api/agent/pause', { agent: 'gemini', paused: true }, h);
    expect(pRes.status).toBe(200);
    expect(svc.state().pausedAgents).toEqual(['gemini']);

    await postJson(base, '/api/message', { text: 'oops sent' }, h);
    const rec = await postJson(base, '/api/message/recall-last', {}, h);
    expect(rec.status).toBe(200);
    expect(await rec.json()).toMatchObject({ ok: true, text: 'oops sent' });

    const prevEnv = process.env.PERPLEXITY_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    try {
      const s1 = await postJson(base, '/api/settings/perplexity', { apiKey: 'pplx-1234567890abcdef' }, h);
      expect(s1.status).toBe(200);
      expect(await s1.json()).toMatchObject({ configured: true });
      const g = await (await fetch(base + '/api/settings/perplexity')).json();
      expect(g.configured).toBe(true);
      expect(g.masked).not.toContain('1234567890');
    } finally {
      if (prevEnv !== undefined) process.env.PERPLEXITY_API_KEY = prevEnv;
    }
  });

  it('supports creating, assigning, and deleting roles', async () => {
    const { base, srv, svc } = await boot();
    const h = { 'X-Synergy-Token': srv.token };
    const created = await (
      await postJson(base, '/api/roles/create', { title: 'Cyber Security', description: 'Audit auth' }, h)
    ).json();
    expect(created.title).toBe('Cyber Security');

    const assigned = await (
      await postJson(base, '/api/roles/assign', { id: created.id, agent: 'antigravity' }, h)
    ).json();
    expect(assigned.agent).toBe('antigravity');

    const del = await (await postJson(base, '/api/roles/delete', { id: created.id }, h)).json();
    expect(del).toEqual({ deleted: true });
    expect(svc.listRoles()).toHaveLength(1);
  });

  it('supports multi-chat endpoints and opening another project folder', async () => {
    const { base, srv } = await boot();
    const h = { 'X-Synergy-Token': srv.token };

    const c2 = await (await postJson(base, '/api/chats/new', { title: 'Sprint 2' }, h)).json();
    expect(c2.title).toBe('Sprint 2');
    await postJson(base, '/api/message', { text: 'hello sprint' }, h);
    expect((await (await postJson(base, '/api/chats/clear', {}, h)).json()).cleared).toBe(1);
    expect((await (await postJson(base, '/api/chats/switch', { id: 1 }, h)).json()).id).toBe(1);
    expect((await (await postJson(base, '/api/chats/delete', { id: c2.id }, h)).json()).deleted).toBe(true);

    const otherDir = tmpRoot();
    const opened = await (await postJson(base, '/api/project/open', { dir: otherDir }, h)).json();
    expect(opened.ok).toBe(true);
    expect(opened.root).toBe(otherDir);
  });

  it('supports chat archiving/purging, custom fs list, and project creation with uploaded files', async () => {
    const { base, srv } = await boot();
    const h = { 'X-Synergy-Token': srv.token };

    const c2 = await (await postJson(base, '/api/chats/new', { title: 'Archive Me' }, h)).json();
    const arch = await (await postJson(base, '/api/chats/archive', { id: c2.id, archived: true }, h)).json();
    expect(arch.archived).toBe(1);
    const purged = await (await postJson(base, '/api/chats/purge-archived', {}, h)).json();
    expect(purged.deleted).toBe(1);

    const parent = tmpRoot();
    const fsRes = await (await fetch(base + '/api/fs/list?dir=' + encodeURIComponent(parent))).json();
    expect(fsRes.dir).toBe(parent);
    expect(Array.isArray(fsRes.folders)).toBe(true);

    const created = await (
      await postJson(
        base,
        '/api/project/create',
        {
          name: 'CustomProj',
          parentDir: parent,
          emoji: '🎮',
          color: '#3fb950',
          files: [{ name: 'hello.luau', dataBase64: Buffer.from('print("hi")').toString('base64') }],
        },
        h,
      )
    ).json();
    expect(created.ok).toBe(true);
    expect(created.project).toMatchObject({ name: 'CustomProj', emoji: '🎮', color: '#3fb950' });
  });

  it('supports meeting room start, hand/floor, mute/deaf, notes, and end endpoints', async () => {
    const { base, srv, svc } = await boot();
    const h = { 'X-Synergy-Token': srv.token };
    svc.readFeed({ agent: 'claude' });
    svc.readFeed({ agent: 'deepseek' });

    const mt = await (await postJson(base, '/api/meeting/start', { title: 'API Bug Meeting' }, h)).json();
    expect(mt.status).toBe('active');
    expect(mt.seats.slice().sort()).toEqual(['claude', 'deepseek']);

    await postJson(base, '/api/meeting/raise-hand', { agent: 'claude', reason: 'Check logs' }, h);
    await postJson(base, '/api/meeting/grant', { agent: 'claude' }, h);
    const spoke = await (await postJson(base, '/api/meeting/speak', { from: 'claude', text: 'Inspect trace first' }, h)).json();
    expect(spoke.messageId).toBe(1);

    await postJson(base, '/api/meeting/mute', { agent: 'deepseek', muted: true }, h);
    const deafened = await (await postJson(base, '/api/meeting/deaf', { agent: 'codex', deaf: true }, h)).json();
    expect(deafened.mutedAgents).toContain('deepseek');
    expect(deafened.deafAgents).toContain('codex');

    const accepted = await (await postJson(base, '/api/meeting/accept-note', { messageId: 1 }, h)).json();
    expect(accepted.notes).toHaveLength(1);

    const listRes = await (await fetch(base + '/api/meeting/notes')).json();
    expect(listRes.files).toHaveLength(1);
    const fileRes = await (await fetch(base + '/api/meeting/notes?file=' + encodeURIComponent(listRes.files[0].file))).json();
    expect(fileRes.content).toContain('Inspect trace first');

    const ended = await (await postJson(base, '/api/meeting/end', {}, h)).json();
    expect(ended.ended.status).toBe('ended');
  });

  it('supports incognito chat creation, provider API keys, and skills listing endpoints', async () => {
    const { base, srv } = await boot();
    const h = { 'X-Synergy-Token': srv.token };

    const inc = await (await postJson(base, '/api/chats/new', { incognito: true, participants: ['claude', 'deepseek'] }, h)).json();
    expect(inc.incognito).toBe(1);
    expect(inc.title).toBe('Incognito Chat');
    expect((await (await postJson(base, '/api/chats/delete', { id: inc.id }, h)).json()).deleted).toBe(true);

    const saved = await (await postJson(base, '/api/settings/api-keys', { provider: 'deepseek', apiKey: 'sk-test-123456' }, h)).json();
    const ds = saved.keys.find((k: any) => k.provider === 'deepseek');
    expect(ds.configured).toBe(true);
    expect(ds.masked).toBe('sk-t...3456');

    const keysGet = await (await fetch(base + '/api/settings/api-keys')).json();
    expect(keysGet.keys.length).toBeGreaterThanOrEqual(5);

    const skillsRes = await (await fetch(base + '/api/skills')).json();
    expect(Array.isArray(skillsRes.skills)).toBe(true);

    const trRes = await (await postJson(base, '/api/translate', { text: '@gemini /goal UI API', targetLang: 'en' }, h)).json();
    expect(trRes.translated).toBe('@gemini /goal UI API');

    const skRes = await (await postJson(base, '/api/skills/create', { name: 'api-helper', description: 'API helper skill', agent: 'deepseek' }, h)).json();
    expect(skRes.skills.some((s: any) => s.name === 'api-helper' && s.agent === 'deepseek')).toBe(true);

    const saveRes = await (await postJson(base, '/api/file/save', { path: 'notes.txt', content: 'hello disk' }, h)).json();
    expect(saveRes.ok).toBe(true);
    const readRes = await (await fetch(base + '/api/file?path=notes.txt')).json();
    expect(readRes.content).toBe('hello disk');

    const badSave = await postJson(base, '/api/file/save', { path: '../escape.txt', content: 'x' }, h);
    expect(badSave.status).toBe(400);

    const bundleRes = await (
      await postJson(base, '/api/upload/bundle', { kind: 'folder', files: [{ path: 'sub/a.ts', dataBase64: Buffer.from('export const a=1;').toString('base64') }] }, h)
    ).json();
    expect(bundleRes.count).toBe(1);
    expect(bundleRes.names).toEqual(['sub/a.ts']);

    const gitSt = await (await fetch(base + '/api/git/status')).json();
    expect(typeof gitSt.isRepo).toBe('boolean');
    expect(typeof gitSt.hasGithubAuth).toBe('boolean');

    const cBound = await (await postJson(base, '/api/chats/new', { title: 'Bound A', liveSessions: ['antigravity:sess-1'] }, h)).json();
    expect(JSON.parse(cBound.live_sessions)).toEqual(['antigravity:sess-1']);
    const cMainBound = await (await postJson(base, '/api/chats/bind-sessions', { chatId: 1, sessionIds: ['antigravity:sess-1'] }, h)).json();
    expect(JSON.parse(cMainBound.live_sessions)).toEqual(['antigravity:sess-1']);
    const afterReassign = await (await fetch(base + '/api/state')).json();
    const oldBound = afterReassign.state.chats.find((c: any) => c.id === cBound.id);
    expect(oldBound.live_sessions).toBeNull();

    const wfUpd = await (await postJson(base, '/api/workflow/update', { rules: 'Strict TS', running: false }, h)).json();
    expect(wfUpd.rules).toBe('Strict TS');
    const wfTask = await (await postJson(base, '/api/workflow/task', { action: 'add', title: 'Write E2E spec', agent: 'codex' }, h)).json();
    expect(wfTask.tasks).toHaveLength(1);
    const wfFile = await (
      await postJson(base, '/api/workflow/upload', { name: 'spec.txt', kind: 'file', dataBase64: Buffer.from('spec').toString('base64') }, h)
    ).json();
    expect(wfFile.files).toHaveLength(1);

    const archProj = await (await postJson(base, '/api/project/create', { name: 'ArchTest', parentDir: tmpRoot() }, h)).json();
    const archRes = await (await postJson(base, '/api/project/archive', { dir: archProj.root, archived: true }, h)).json();
    expect(archRes.projects.some((pr: any) => pr.dir === archProj.root && pr.archived === true)).toBe(true);
    const delRes = await (await postJson(base, '/api/project/delete', { dir: archProj.root }, h)).json();
    expect(delRes.projects.some((pr: any) => pr.dir === archProj.root)).toBe(false);

    // Pushing to GitHub without a remote or GitHub account must return an error cleanly
    const badPush = await postJson(base, '/api/git/commit', { message: 'test push', push: true }, h);
    expect(badPush.status).toBe(400);

    // Persisting per-agent CLI sub-model & reasoning effort preferences
    const prefRes = await (
      await postJson(base, '/api/agents/prefs', { agent: 'codex', selectedModel: 'gpt-6-luna', reasoningEffort: 'low' }, h)
    ).json();
    expect(prefRes.prefs.codex.selectedModel).toBe('gpt-6-luna');
    expect(prefRes.prefs.codex.reasoningEffort).toBe('low');

    const cliRes = await (await fetch(base + '/api/agents/cli-status')).json();
    expect(Array.isArray(cliRes.cli.codex.models)).toBe(true);
    expect(Array.isArray(cliRes.cli.claude.efforts)).toBe(true);

    // 3-class honest agent catalog & MCP IDE separation
    const catRes = await (await fetch(base + '/api/agents/catalog')).json();
    expect(Array.isArray(catRes.agents)).toBe(true);
    const agyEntry = catRes.agents.find((a: any) => a.agent === 'antigravity');
    expect(agyEntry).toMatchObject({ capability: 'mcp_ide', transport: 'mcp_ide' });
    expect(catRes.agents.some((a: any) => a.agent === 'hermes' || a.agent === 'muse')).toBe(false);

    // Shared memory decision + handoff + brief
    const decRes = await (
      await postJson(base, '/api/memory/decision', { goal: 'Ship clean v1', agent: 'codex', text: 'Use WAL mode' }, h)
    ).json();
    expect(decRes.ok).toBe(true);
    expect(decRes.memory.goal).toBe('Ship clean v1');
    const memGet = await (await fetch(base + '/api/memory')).json();
    expect(memGet.contextMarkdown).toContain('Use WAL mode');
    expect(memGet.handoffBrief).toContain('Ship clean v1');

    const hofRes = await (
      await postJson(base, '/api/memory/handoff', { from: 'codex', to: 'antigravity', goal: 'Review diff', files: ['src/index.ts'] }, h)
    ).json();
    expect(hofRes.ok).toBe(true);
    expect(hofRes.memory.handoffs.at(-1)?.to).toBe('antigravity');

    // Ollama RAM recommendation & MCP setup snippets
    const olRes = await (await fetch(base + '/api/ollama/status')).json();
    expect(olRes.totalRamGb).toBeGreaterThan(0);
    expect(olRes.recommendedModel).toMatch(/^qwen2\.5-coder:/);

    const mcpSetup = await (await fetch(base + '/api/mcp/setup')).json();
    expect(mcpSetup.antigravity.json.mcpServers.synergy.env.SYNERGY_AGENT).toBe('antigravity');
    expect(mcpSetup.codex.toml).toContain('SYNERGY_AGENT = "codex"');

    // Orchestration validation + sync unconfigured error handling
    const badOrc = await postJson(base, '/api/orchestrate', { mode: 'direct', prompt: 'hi', agents: [] }, h);
    expect(badOrc.status).toBe(400);
    const orcRes = await (
      await postJson(base, '/api/orchestrate', { mode: 'direct', prompt: 'hi', agents: ['deepseek'], sync: true }, h)
    ).json();
    expect(orcRes.mode).toBe('direct');
    expect(orcRes.turns).toHaveLength(1);
    expect(orcRes.turns[0].transport).toBe('none');
  });
});
