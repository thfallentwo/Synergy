import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Synergy } from '../src/core/service';
import { openDb } from '../src/core/store';
import { tmpRoot } from './helpers';

describe('two processes (two connections) share one store', () => {
  it('only one agent wins a lock; the other sees the loser message and the feed', () => {
    const root = tmpRoot();
    const file = path.join(root, '.synergy', 'synergy.db');
    const a = new Synergy(openDb(file), { root });
    const b = new Synergy(openDb(file), { root });
    const ra = a.lockFile({ agent: 'claude', file: 'x.ts' });
    const rb = b.lockFile({ agent: 'cursor', file: 'x.ts' });
    expect([ra.startsWith('OK'), rb.startsWith('OK')]).toEqual([true, false]);
    b.postStatus({ agent: 'cursor', action: 'INFO', file: '-', summary: 'waiting' });
    expect(a.readFeed({ agent: 'claude' })).toContain('cursor INFO - | waiting');
  });

  it('many interleaved writers produce unique ordered ids', () => {
    const root = tmpRoot();
    const file = path.join(root, '.synergy', 'synergy.db');
    const svcs = ['claude', 'cursor', 'gemini'].map((n) => ({ n, s: new Synergy(openDb(file), { root }) }));
    for (let i = 0; i < 30; i++) {
      const { n, s } = svcs[i % 3];
      s.postStatus({ agent: n, action: 'INFO', file: '-', summary: `m${i}` });
    }
    const ids = svcs[0].s.recentEvents(100).map((e) => e.id);
    expect(ids).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });
});
