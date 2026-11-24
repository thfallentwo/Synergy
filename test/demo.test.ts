import { describe, expect, it } from 'vitest';
import { runDemo, seedProject } from '../src/demo/scenario';
import { Synergy } from '../src/core/service';
import { openDb } from '../src/core/store';
import { tmpRoot } from './helpers';

describe('demo scenario', () => {
  it('runs one pass with real diffs, a denied lock, a Q&A and a clean end state', async () => {
    const root = tmpRoot();
    seedProject(root);
    const svc = new Synergy(openDb(':memory:'), { root });
    await runDemo(svc, root, { speed: 2000, loop: false });
    const st = svc.state();
    const by = Object.fromEntries(st.agents.map((a) => [a.name, a]));
    expect(Object.keys(by).sort()).toEqual(['antigravity', 'claude-code', 'cursor', 'gemini']);
    expect(by['claude-code'].added).toBeGreaterThan(by['claude-code'].removed); // green card
    expect(by['antigravity'].removed).toBeGreaterThan(by['antigravity'].added); // red card
    expect(st.locks).toHaveLength(0);
    const ev = svc.recentEvents(200);
    expect(ev.some((e) => e.type === 'ask' && e.reply_to)).toBe(true);
    expect(ev.some((e) => e.type === 'human')).toBe(true);
    expect(svc.diffsForFile('tests/auth.test.ts')).toHaveLength(1);
  });

  it('answers in Turkish when the summary language is tr', async () => {
    const root = tmpRoot();
    seedProject(root);
    const svc = new Synergy(openDb(':memory:'), { root });
    svc.setLang('tr');
    await runDemo(svc, root, { speed: 2000, loop: false });
    expect(svc.recentEvents(200).some((e) => e.text.includes('role alanı'))).toBe(true);
  });
});
