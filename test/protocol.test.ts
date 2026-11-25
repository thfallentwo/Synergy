import { describe, expect, it } from 'vitest';
import { normalizeAgent } from '../src/core/agents';
import { capWords, fmtAge, formatEvent, formatLocks } from '../src/core/protocol';
import type { EventRow } from '../src/core/types';

const ev = (p: Partial<EventRow>): EventRow => ({
  id: 1, ts: 0, agent: 'claude', type: 'status', action: 'MODIFIED', file: 'auth.ts',
  text: 'Added role', to_agent: null, reply_to: null, added: 0, removed: 0, ...p,
});

describe('capWords', () => {
  it('keeps short text and collapses whitespace', () => {
    expect(capWords('  a   b\nc ')).toEqual({ text: 'a b c', trimmed: false });
  });
  it('trims to 20 words', () => {
    const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ');
    const r = capWords(long);
    expect(r.trimmed).toBe(true);
    expect(r.text.split(' ')).toHaveLength(20);
  });
});

describe('fmtAge', () => {
  it('formats compactly', () => {
    expect(fmtAge(5_000)).toBe('5s');
    expect(fmtAge(125_000)).toBe('2m');
    expect(fmtAge(2 * 3_600_000)).toBe('2h');
    expect(fmtAge(3 * 86_400_000)).toBe('3d');
    expect(fmtAge(-5)).toBe('0s');
  });
});

describe('formatEvent', () => {
  it('formats each event type', () => {
    const now = 120_000;
    expect(formatEvent(ev({}), now)).toBe('#1 2m claude MODIFIED auth.ts | Added role');
    expect(formatEvent(ev({ type: 'lock' }), now)).toBe('#1 2m claude LOCKED auth.ts');
    expect(formatEvent(ev({ type: 'unlock' }), now)).toBe('#1 2m claude UNLOCKED auth.ts');
    expect(formatEvent(ev({ type: 'ask', to_agent: 'cursor', text: 'why?' }), now)).toBe('#1 2m claude\u2192cursor ? why?');
    expect(formatEvent(ev({ type: 'ask', to_agent: 'cursor', reply_to: 7, text: 'ok' }), now)).toContain('re#7');
    expect(formatEvent(ev({ type: 'human', agent: 'human', text: 'stop' }), now)).toBe('#1 2m [Human] ! stop');
    expect(formatEvent(ev({ type: 'system', agent: 'system', text: 'x expired' }), now)).toBe('#1 2m * x expired');
  });
  it('formats locks', () => {
    expect(formatLocks([], 0)).toBe('LOCKS: none');
    expect(formatLocks([{ file: 'a.ts', agent: 'claude', ts: 0, expires_at: 9 }], 240_000)).toBe('LOCKS: a.ts@claude(4m)');
  });
});

describe('normalizeAgent', () => {
  it('maps aliases to one key', () => {
    for (const n of ['Claude', 'CLAUDE', ' claude ']) expect(normalizeAgent(n)).toBe('claude');
    for (const n of ['Claude Code', 'claude-code', 'ClaudeCode']) expect(normalizeAgent(n)).toBe('claude-code');
    expect(normalizeAgent('Kimi CLI')).toBe('kimi');
    expect(normalizeAgent('Hermes Agent')).toBe('hermes');
    expect(normalizeAgent('Grok Bot')).toBe('grok');
    expect(normalizeAgent('Cursor')).toBe('cursor');
    expect(normalizeAgent('Gemini CLI')).toBe('gemini');
    expect(normalizeAgent('OpenAI Codex')).toBe('codex');
    expect(normalizeAgent('Antigravity')).toBe('antigravity');
    expect(normalizeAgent('Human')).toBe('human');
  });
  it('slugs unknown names and defaults', () => {
    expect(normalizeAgent('My Bot 2')).toBe('my-bot-2');
    expect(normalizeAgent('')).toBe('agent');
    expect(normalizeAgent(undefined)).toBe('agent');
  });
});
