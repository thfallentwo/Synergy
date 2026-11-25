import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dbPath, requireRoot } from '../core/paths';
import { Synergy } from '../core/service';
import { openDb } from '../core/store';
import { runDemo, seedProject } from '../demo/scenario';
import { startUiServer } from '../web/httpServer';
import { findUiDir } from '../web/uiDir';

const say = (s: string) => process.stdout.write(s + '\n');

export interface UiCliOptions {
  root?: string;
  port?: string;
  noOpen?: boolean;
  demo?: boolean;
  speed?: string;
}

export async function ui(opts: UiCliOptions): Promise<void> {
  let root: string;
  let cleanup = () => {};
  if (opts.demo) {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'synergy-demo-'));
    seedProject(root);
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  } else {
    root = requireRoot({ root: opts.root });
  }
  const db = openDb(dbPath(root));
  const svc = new Synergy(db, { root });
  const port = opts.port ? Number(opts.port) : undefined;
  if (port !== undefined && !(port > 0 && port < 65536)) throw new Error('invalid --port');
  const server = await startUiServer(svc, { port, uiDir: findUiDir() });

  say(`Synergy dashboard: ${server.url}${opts.demo ? '  (demo mode, simulated agents)' : `  (project: ${root})`}`);
  say('Press Ctrl+C to stop.');
  if (!opts.noOpen) {
    try {
      const { default: open } = await import('open');
      await open(server.url);
    } catch {
      /* headless: the URL above is enough */
    }
  }

  const ctl = new AbortController();
  const stop = async () => {
    ctl.abort();
    await server.close();
    db.close();
    cleanup();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  if (opts.demo) {
    const speed = opts.speed ? Number(opts.speed) : 1;
    if (!(speed > 0)) throw new Error('invalid --speed');
    await runDemo(svc, root, { speed, loop: true, signal: ctl.signal });
  } else {
    await new Promise(() => {}); // run until signal
  }
}
