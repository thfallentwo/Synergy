import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Synergy } from '../src/core/service';
import { openDb } from '../src/core/store';
import { listProjectFiles } from '../src/core/tree';
import { makeClock, tmpRoot } from './helpers';

function setup() {
  const root = tmpRoot();
  const clock = makeClock();
  const svc = new Synergy(openDb(':memory:'), { root, clock });
  const write = (f: string, t: string) => {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), t);
  };
  return { root, svc, write, clock };
}

describe('measured diffs', () => {
  it('counts added/removed lines between lock and post_status, then moves the snapshot', () => {
    const { svc, write } = setup();
    write('a.ts', 'one\ntwo\nthree\n');
    svc.lockFile({ agent: 'claude', file: 'a.ts' });
    write('a.ts', 'one\nTWO\nthree\nfour\n');
    svc.postStatus({ agent: 'claude', action: 'MODIFIED', file: 'a.ts', summary: 'edit', added: 999, removed: 999 });
    const a = svc.state().agents[0];
    expect([a.added, a.removed]).toEqual([2, 1]); // measured wins over claimed
    const d = svc.diffsForFile('a.ts');
    expect(d).toHaveLength(1);
    expect(d[0].patch).toContain('+TWO');
    expect(d[0].patch).toContain('-two');

    write('a.ts', 'one\nTWO\nthree\nfour\nfive\n');
    svc.unlockFile({ agent: 'claude', file: 'a.ts' });
    const b = svc.state().agents[0];
    expect([b.added, b.removed]).toEqual([3, 1]); // only the extra line counted at unlock
    expect(svc.recentEvents().at(-1)).toMatchObject({ type: 'unlock', added: 1, removed: 0 });
    expect(svc.diffsForFile('a.ts')).toHaveLength(2);
  });

  it('does not double count when nothing changed, and ignores other agents', () => {
    const { svc, write } = setup();
    write('a.ts', 'x\n');
    svc.lockFile({ agent: 'claude', file: 'a.ts' });
    svc.postStatus({ agent: 'claude', action: 'MODIFIED', file: 'a.ts', summary: 'noop', added: 4 });
    expect(svc.state().agents[0].added).toBe(4); // no measured change -> claimed counts used
    write('a.ts', 'y\n');
    svc.postStatus({ agent: 'cursor', action: 'MODIFIED', file: 'a.ts', summary: 'x' }); // not the lock holder
    expect(svc.diffsForFile('a.ts')).toHaveLength(0);
  });

  it('handles created and deleted files', () => {
    const { svc, write, root } = setup();
    svc.lockFile({ agent: 'claude', file: 'new.ts' });
    write('new.ts', 'a\nb\n');
    svc.postStatus({ agent: 'claude', action: 'CREATED', file: 'new.ts', summary: 'made' });
    expect(svc.state().agents[0]).toMatchObject({ added: 2, removed: 0 });
    fs.rmSync(path.join(root, 'new.ts'));
    svc.unlockFile({ agent: 'claude', file: 'new.ts' });
    expect(svc.state().agents[0]).toMatchObject({ added: 2, removed: 2 });
  });

  it('captures the diff when a lock expires or the session ends', () => {
    const { svc, write, clock } = setup();
    write('a.ts', '1\n');
    svc.lockFile({ agent: 'claude', file: 'a.ts' });
    write('a.ts', '1\n2\n');
    clock.advance(11 * 60_000);
    svc.readFeed({ agent: 'cursor' }); // sweeps
    expect(svc.state().agents.find((a) => a.name === 'claude')?.added).toBe(1);
    write('b.ts', 'x\n');
    svc.lockFile({ agent: 'cursor', file: 'b.ts' });
    write('b.ts', 'x\ny\nz\n');
    svc.releaseAgentLocks('cursor');
    expect(svc.state().agents.find((a) => a.name === 'cursor')?.added).toBe(2);
  });
});

describe('language + tree', () => {
  it('only mentions LANG to agents when it is not English', () => {
    const { svc } = setup();
    expect(svc.readFeed({ agent: 'claude' })).not.toContain('LANG');
    svc.setLang('tr');
    expect(svc.readFeed({ agent: 'claude' })).toMatch(/^LANG tr/);
    expect(() => svc.setLang('<script>')).toThrow();
  });

  it('lists project files, skipping node_modules and dot-directories', () => {
    const { root, write } = setup();
    write('src/a.ts', '');
    write('node_modules/x/i.js', '');
    write('.git/config', '');
    write('README.md', '');
    expect(listProjectFiles(root)).toEqual(['README.md', 'src/a.ts']);
  });
});
