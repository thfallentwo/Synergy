import { describe, expect, it } from 'vitest';
import { memSynergy } from './helpers';

describe('post_status', () => {
  it('stores and returns an id; trims long summaries', () => {
    const { svc } = memSynergy();
    const long = Array.from({ length: 25 }, (_, i) => `w${i}`).join(' ');
    const out = svc.postStatus({ agent: 'claude', action: 'modified', file: 'src/auth.ts', summary: long });
    expect(out).toMatch(/^OK #1 \(trimmed to 20w\)/);
    expect(svc.recentEvents()[0].text.split(' ')).toHaveLength(20);
  });
  it('rejects bad action, empty summary, outside paths', () => {
    const { svc } = memSynergy();
    expect(() => svc.postStatus({ agent: 'a', action: 'NOPE', file: 'a', summary: 'x' })).toThrow(/action/);
    expect(() => svc.postStatus({ agent: 'a', action: 'INFO', file: 'a', summary: ' ' })).toThrow(/empty/);
    expect(() => svc.postStatus({ agent: 'a', action: 'INFO', file: '../a', summary: 'x' })).toThrow(/outside/);
  });
  it('allows no file and accumulates line counts', () => {
    const { svc } = memSynergy();
    svc.postStatus({ agent: 'claude', action: 'INFO', file: '-', summary: 'hi', added: 10, removed: 2 });
    svc.postStatus({ agent: 'claude', action: 'MODIFIED', file: 'a.ts', summary: 'x', added: 5, removed: 1 });
    const a = svc.state().agents[0];
    expect([a.added, a.removed, a.last_file]).toEqual([15, 3, 'a.ts']);
  });
  it('warns when the file is locked by another agent', () => {
    const { svc } = memSynergy();
    svc.lockFile({ agent: 'cursor', file: 'a.ts' });
    expect(svc.postStatus({ agent: 'claude', action: 'MODIFIED', file: 'a.ts', summary: 'x' })).toContain('WARN a.ts is locked by cursor');
  });
});

describe('locks', () => {
  it('grants, denies others, renews own', () => {
    const { svc, clock } = memSynergy();
    expect(svc.lockFile({ agent: 'claude', file: 'a.ts' })).toMatch(/^OK a\.ts locked 10m/);
    clock.advance(180_000);
    expect(svc.lockFile({ agent: 'cursor', file: 'a.ts' })).toMatch(/^DENIED a\.ts held by claude 3m, expires in 7m/);
    expect(svc.lockFile({ agent: 'claude', file: './a.ts' })).toMatch(/^OK a\.ts renewed/);
  });
  it('expires and tells the room', () => {
    const { svc, clock } = memSynergy({ ttl: 60_000 });
    svc.lockFile({ agent: 'claude', file: 'a.ts' });
    clock.advance(61_000);
    expect(svc.lockFile({ agent: 'cursor', file: 'a.ts' })).toMatch(/^OK a\.ts locked/);
    expect(svc.recentEvents().some((e) => e.type === 'system' && /expired/.test(e.text))).toBe(true);
  });
  it('only the owner unlocks; unlocking free file is ok', () => {
    const { svc } = memSynergy();
    svc.lockFile({ agent: 'claude', file: 'a.ts' });
    expect(svc.unlockFile({ agent: 'cursor', file: 'a.ts' })).toMatch(/^DENIED a\.ts held by claude/);
    expect(svc.unlockFile({ agent: 'claude', file: 'a.ts' })).toMatch(/^OK a\.ts unlocked/);
    expect(svc.unlockFile({ agent: 'claude', file: 'a.ts' })).toMatch(/^OK a\.ts not locked/);
  });
  it('releases all locks of an agent', () => {
    const { svc } = memSynergy();
    svc.lockFile({ agent: 'claude', file: 'a.ts' });
    svc.lockFile({ agent: 'claude', file: 'b.ts' });
    expect(svc.releaseAgentLocks('Claude')).toBe(2);
    expect(svc.state().locks).toHaveLength(0);
  });
  it('human /lock and /unlock', () => {
    const { svc } = memSynergy();
    svc.humanSend('/lock config.ts');
    expect(svc.lockFile({ agent: 'claude', file: 'config.ts' })).toMatch(/DENIED config\.ts held by human/);
    svc.humanSend('/unlock config.ts');
    expect(svc.lockFile({ agent: 'claude', file: 'config.ts' })).toMatch(/^OK/);
  });
});

describe('feed + digest', () => {
  it('piggybacks unread messages on any tool reply, once', () => {
    const { svc } = memSynergy();
    svc.readFeed({ agent: 'cursor' }); // register cursor
    svc.postStatus({ agent: 'claude', action: 'MODIFIED', file: 'a.ts', summary: 'Added role' });
    const out = svc.lockFile({ agent: 'cursor', file: 'b.ts' });
    expect(out).toContain('NEW(1):');
    expect(out).toContain('claude MODIFIED a.ts | Added role');
    expect(svc.unlockFile({ agent: 'cursor', file: 'b.ts' })).not.toContain('NEW');
  });
  it('does not echo your own events and caps the digest', () => {
    const { svc } = memSynergy();
    svc.readFeed({ agent: 'cursor' });
    for (let i = 0; i < 14; i++) svc.postStatus({ agent: 'claude', action: 'INFO', file: '-', summary: `m${i}` });
    const out = svc.postStatus({ agent: 'cursor', action: 'INFO', file: '-', summary: 'mine' });
    expect(out).toContain('NEW(14):');
    expect(out).toContain('(+4 older, call read_feed)');
    expect(out).not.toContain('cursor INFO');
  });
  it('read_feed shows latest N plus locks', () => {
    const { svc } = memSynergy();
    expect(svc.readFeed({ agent: 'claude' })).toBe('FEED: empty\nLOCKS: none');
    svc.lockFile({ agent: 'claude', file: 'a.ts' });
    svc.postStatus({ agent: 'claude', action: 'MODIFIED', file: 'a.ts', summary: 'x' });
    const out = svc.readFeed({ agent: 'cursor', limit: 1 });
    expect(out.split('\n')).toHaveLength(2);
    expect(out).toContain('claude MODIFIED a.ts | x');
    expect(out).toContain('LOCKS: a.ts@claude(0s)');
  });
});

describe('ask + human', () => {
  it('directed questions reach only the target (and read_feed)', () => {
    const { svc } = memSynergy();
    svc.readFeed({ agent: 'claude' });
    svc.readFeed({ agent: 'gemini' });
    svc.askAgent({ from: 'cursor', to: 'Claude', question: 'Is role optional?' });
    expect(svc.postStatus({ agent: 'claude', action: 'INFO', file: '-', summary: 'ok' })).toContain('cursor\u2192claude ? Is role optional?');
    expect(svc.postStatus({ agent: 'gemini', action: 'INFO', file: '-', summary: 'ok' })).not.toContain('Is role optional');
    expect(svc.readFeed({ agent: 'gemini' })).toContain('Is role optional');
  });
  it('replies carry reply_to; "all" reaches everyone', () => {
    const { svc } = memSynergy();
    const id = svc.askAgent({ from: 'cursor', to: 'all', question: 'anyone on db?' });
    expect(id).toMatch(/^OK #1/);
    svc.askAgent({ from: 'claude', to: 'cursor', question: 'no', replyTo: 1 });
    expect(svc.readFeed({ agent: 'cursor' })).toContain('re#1');
  });
  it('human broadcast and @mention', () => {
    const { svc } = memSynergy();
    svc.readFeed({ agent: 'claude' });
    svc.readFeed({ agent: 'cursor' });
    svc.humanSend('@claude finish auth first');
    svc.humanSend('everyone pause');
    expect(svc.postStatus({ agent: 'claude', action: 'INFO', file: '-', summary: 'k' })).toContain('[Human]\u2192claude ! finish auth first');
    const c = svc.postStatus({ agent: 'cursor', action: 'INFO', file: '-', summary: 'k' });
    expect(c).toContain('[Human] ! everyone pause');
    expect(c).not.toContain('finish auth first');
    expect(() => svc.humanSend('  ')).toThrow();
  });
});

describe('state', () => {
  it('derives status from activity and locks; hides human', () => {
    const { svc, clock } = memSynergy();
    svc.humanSend('hi');
    svc.lockFile({ agent: 'claude', file: 'a.ts' });
    svc.readFeed({ agent: 'cursor' });
    expect(svc.state().agents.map((a) => [a.name, a.status])).toEqual([['claude', 'working'], ['cursor', 'working']]);
    clock.advance(5 * 60_000);
    expect(svc.state().agents.map((a) => [a.name, a.status])).toEqual([['claude', 'working'], ['cursor', 'idle']]);
    clock.advance(10 * 60_000); // lock expired (10m ttl), claude idle too
    expect(svc.state().agents.map((a) => a.status)).toEqual(['offline', 'offline']);
  });
  it('prunes old events', () => {
    const { svc } = memSynergy();
    const small = new (svc.constructor as any)(svc.db, { root: '/proj', maxEvents: 3 });
    for (let i = 0; i < 6; i++) small.postStatus({ agent: 'a', action: 'INFO', file: '-', summary: `m${i}` });
    small.prune();
    expect(small.recentEvents(100).map((e: any) => e.text)).toEqual(['m3', 'm4', 'm5']);
  });
});
