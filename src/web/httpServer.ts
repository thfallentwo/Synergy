import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Synergy } from '../core/service';
import { listProjectFiles } from '../core/tree';

export interface UiServer {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

export interface UiOptions {
  port?: number;
  /** Directory holding index.html and icons/. */
  uiDir: string;
  pollMs?: number;
}

const HOST = '127.0.0.1';
const MAX_BODY = 10_000;

function json(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(v && typeof v === 'object' ? v : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

interface Client {
  res: http.ServerResponse;
  lastId: number;
  lastDiffId: number;
  sig: string;
}

/**
 * Local dashboard server: static UI, a small JSON API and one SSE stream.
 * Security: bound to 127.0.0.1, Host header allow-list (DNS rebinding), and a per-run token
 * that only the served page knows is required for every write.
 */
export async function startUiServer(svc: Synergy, opts: UiOptions): Promise<UiServer> {
  const token = crypto.randomBytes(16).toString('hex');
  const indexTpl = fs.readFileSync(path.join(opts.uiDir, 'index.html'), 'utf8');
  const clients = new Set<Client>();
  let port = 0;

  const hostOk = (req: http.IncomingMessage) => {
    const h = req.headers.host ?? '';
    return h === `${HOST}:${port}` || h === `localhost:${port}`;
  };

  const snapshot = () => {
    const state = svc.state();
    const sig = JSON.stringify({
      a: state.agents.map((a) => [a.name, a.status, a.added, a.removed, a.last_file, a.last_summary]),
      l: state.locks.map((l) => [l.file, l.agent]),
    });
    return { state, sig };
  };

  const send = (c: Client, event: string, data: unknown, id?: number) => {
    c.res.write(`${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const sendInit = (c: Client) => {
    const { state, sig } = snapshot();
    c.lastId = state.lastId;
    c.lastDiffId = svc.maxDiffId();
    c.sig = sig;
    send(c, 'init', { state, events: svc.recentEvents(150), diffs: svc.recentDiffs(40), lang: svc.getLang(), project: path.basename(svc.root) });
  };

  const tick = () => {
    if (clients.size === 0) return;
    try {
      if (svc.hasExpiredLocks()) svc.sweepLocks();
      const { state, sig } = snapshot();
      const diffMax = svc.maxDiffId();
      for (const c of clients) {
        if (state.lastId < c.lastId || diffMax < c.lastDiffId) {
          sendInit(c); // store was reset (demo loop) -> resync
          continue;
        }
        if (state.lastId > c.lastId) {
          const events = svc.eventsSince(c.lastId);
          if (events.length) {
            c.lastId = events[events.length - 1].id;
            send(c, 'events', events, c.lastId);
          }
        }
        if (diffMax > c.lastDiffId) {
          const diffs = svc.diffsSince(c.lastDiffId);
          if (diffs.length) {
            c.lastDiffId = diffs[diffs.length - 1].id;
            send(c, 'diffs', diffs);
          }
        }
        if (sig !== c.sig) {
          c.sig = sig;
          send(c, 'state', { state, lang: svc.getLang() });
        }
      }
    } catch (e) {
      console.error('[synergy] ui tick error:', e);
    }
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostOk(req)) return json(res, 403, { error: 'bad host' });
      const url = new URL(req.url ?? '/', `http://${HOST}:${port}`);
      const p = url.pathname;

      if (req.method === 'GET') {
        if (p === '/' || p === '/index.html') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          return void res.end(indexTpl.replace('__SYNERGY_TOKEN__', token));
        }
        if (/^\/icons\/[a-z0-9-]+\.png$/.test(p)) {
          const f = path.join(opts.uiDir, p);
          if (!fs.existsSync(f)) return json(res, 404, { error: 'not found' });
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
          return void res.end(fs.readFileSync(f));
        }
        if (p === '/events') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          res.write('retry: 1000\n\n');
          const c: Client = { res, lastId: 0, lastDiffId: 0, sig: '' };
          clients.add(c);
          sendInit(c);
          req.on('close', () => clients.delete(c));
          return;
        }
        if (p === '/api/state') {
          return json(res, 200, { state: svc.state(), events: svc.recentEvents(150), diffs: svc.recentDiffs(40), lang: svc.getLang(), project: path.basename(svc.root) });
        }
        if (p === '/api/tree') return json(res, 200, { files: listProjectFiles(svc.root) });
        if (p === '/api/diff') {
          const file = url.searchParams.get('file') ?? '';
          return json(res, 200, { diffs: svc.diffsForFile(file, 5) });
        }
        return json(res, 404, { error: 'not found' });
      }

      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && origin !== `http://${req.headers.host}`) return json(res, 403, { error: 'bad origin' });
        if (req.headers['x-synergy-token'] !== token) return json(res, 403, { error: 'bad token' });
        const body = await readBody(req);
        if (p === '/api/message') {
          return json(res, 200, svc.humanSend(String(body.text ?? '')));
        }
        if (p === '/api/unlock') {
          return json(res, 200, { unlocked: svc.forceUnlock(String(body.file ?? '')) });
        }
        if (p === '/api/lang') {
          svc.setLang(String(body.lang ?? ''));
          return json(res, 200, { lang: svc.getLang() });
        }
        return json(res, 404, { error: 'not found' });
      }

      json(res, 405, { error: 'method not allowed' });
    } catch (e) {
      if (!res.headersSent) json(res, 400, { error: (e as Error).message });
      else res.end();
    }
  });

  const start = opts.port ?? 4777;
  await new Promise<void>((resolve, reject) => {
    let attempt = 0;
    const tryListen = () => {
      port = start + attempt;
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && opts.port === undefined && attempt < 20) {
          attempt++;
          tryListen();
        } else reject(err);
      });
      server.listen(port, HOST, () => {
        server.removeAllListeners('error');
        port = (server.address() as AddressInfo).port; // matters when port 0 asks the OS for a free one
        resolve();
      });
    };
    tryListen();
  });

  const timer = setInterval(tick, opts.pollMs ?? 400);
  const heartbeat = setInterval(() => {
    for (const c of clients) c.res.write(': hb\n\n');
  }, 15_000);
  timer.unref();
  heartbeat.unref();

  return {
    url: `http://${HOST}:${port}/`,
    port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(timer);
        clearInterval(heartbeat);
        for (const c of clients) c.res.end();
        clients.clear();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
