import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Synergy } from '../src/core/service';
import { openDb } from '../src/core/store';

export function makeClock(start = 1_000_000) {
  let t = start;
  const clock = () => t;
  clock.advance = (ms: number) => void (t += ms);
  return clock;
}

export function memSynergy(opts: { ttl?: number } = {}) {
  const clock = makeClock();
  const svc = new Synergy(openDb(':memory:'), { root: '/proj', clock, lockTtlMs: opts.ttl });
  return { svc, clock };
}

export function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'synergy-'));
}
