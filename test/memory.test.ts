import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendMemoryDecision,
  buildHandoffBrief,
  buildSharedContextPrompt,
  getGitDiffSummary,
  readProjectMemory,
  recordHandoff,
  setProjectGoal,
} from '../src/core/memory';
import { Synergy } from '../src/core/service';
import { openDb } from '../src/core/store';
import { tmpRoot } from './helpers';

describe('shared project memory', () => {
  it('stores goal, decisions, and handoffs and renders .synergy/context.md', () => {
    const root = tmpRoot();
    const svc = new Synergy(openDb(':memory:'), { root });

    setProjectGoal(root, 'Build zero-conflict multi-agent auth refactor');
    appendMemoryDecision(root, 'codex', 'Split JWT verification into middleware');
    recordHandoff(root, {
      from: 'antigravity',
      to: 'codex',
      goal: 'Implement refresh token rotation',
      files: ['src/auth.ts'],
      notes: 'Preserve existing cookie name',
    });

    const mem = readProjectMemory(root);
    expect(mem.goal).toBe('Build zero-conflict multi-agent auth refactor');
    expect(mem.decisions).toHaveLength(1);
    expect(mem.handoffs).toHaveLength(1);

    const ctxPath = path.join(root, '.synergy', 'context.md');
    expect(fs.existsSync(ctxPath)).toBe(true);
    const md = fs.readFileSync(ctxPath, 'utf8');
    expect(md).toContain('Build zero-conflict multi-agent auth refactor');
    expect(md).toContain('[codex] Split JWT verification into middleware');
    expect(md).toContain('`antigravity` -> `codex` (src/auth.ts): Implement refresh token rotation');

    svc.lockFile({ agent: 'codex', file: 'src/auth.ts' });
    const promptBlock = buildSharedContextPrompt(svc, { includeDiff: false });
    expect(promptBlock).toContain('PROJECT GOAL:');
    expect(promptBlock).toContain('RECENT DECISIONS:');
    expect(promptBlock).toContain('LOCKS: src/auth.ts@codex');

    const brief = buildHandoffBrief(svc, 'gemini');
    expect(brief).toContain('Target Agent: gemini');
    expect(brief).toContain('Split JWT verification into middleware');
  });

  it('returns empty string safely from getGitDiffSummary outside a git repository', () => {
    const root = tmpRoot();
    expect(getGitDiffSummary(root)).toBe('');
  });
});
