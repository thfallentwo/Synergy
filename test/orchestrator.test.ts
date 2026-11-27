import { describe, expect, it } from 'vitest';
import { readProjectMemory } from '../src/core/memory';
import { runOrchestration, type UnifiedRunnerFn } from '../src/core/orchestrator';
import { Synergy } from '../src/core/service';
import { openDb } from '../src/core/store';
import { tmpRoot } from './helpers';

describe('multi-agent orchestrator', () => {
  it('runs debate (2 rounds + synthesis + decision capture)', async () => {
    const root = tmpRoot();
    const svc = new Synergy(openDb(':memory:'), { root });
    const calls: Array<{ agent: string; prompt: string }> = [];

    const mockRunner: UnifiedRunnerFn = async (_root, agent, prompt) => {
      calls.push({ agent, prompt });
      if (prompt.includes('Synthesize')) {
        return { ok: true, reply: 'Agreed: use SQLite WAL mode + short locks.', transport: 'cli' };
      }
      if (prompt.includes('ROUND 1 PROPOSALS')) {
        return { ok: true, reply: `${agent} R2 critique: agrees on WAL mode.`, transport: 'cli' };
      }
      return { ok: true, reply: `${agent} R1 proposal: keep locks under 5m.`, transport: 'cli' };
    };

    const res = await runOrchestration(
      svc,
      { mode: 'debate', prompt: 'Pick locking architecture', agents: ['codex', 'gemini'] },
      mockRunner,
    );

    expect(res.mode).toBe('debate');
    // 2 agents x 2 rounds = 4 debate turns (+ 1 synthesis call)
    expect(res.turns).toHaveLength(4);
    expect(calls).toHaveLength(5);
    expect(res.synthesis).toContain('WAL mode');

    const mem = readProjectMemory(root);
    expect(mem.decisions.at(-1)?.text).toContain('WAL mode');
  });

  it('runs code_review pipeline and optionally hands off to MCP IDE target', async () => {
    const root = tmpRoot();
    const svc = new Synergy(openDb(':memory:'), { root });
    const modesSeen: Array<string | undefined> = [];

    const mockRunner: UnifiedRunnerFn = async (_root, agent, prompt, opts) => {
      modesSeen.push(opts?.mode);
      if (agent === 'codex') {
        return { ok: true, reply: 'Added validateToken() in src/auth.ts', transport: 'cli' };
      }
      expect(prompt).toContain('Added validateToken()');
      return { ok: true, reply: 'PASS: handle empty header case too.', transport: 'api' };
    };

    const res = await runOrchestration(
      svc,
      {
        mode: 'code_review',
        prompt: 'Harden JWT check',
        agents: ['codex', 'deepseek'],
        allowWrite: true,
        mcpTarget: 'antigravity',
      },
      mockRunner,
    );

    expect(modesSeen).toEqual(['workspace_write', 'advisory']);
    expect(res.turns).toHaveLength(2);
    expect(res.handoffTo).toBe('antigravity');
    expect(svc.readFeed({ agent: 'antigravity' })).toContain('[HANDOFF] Harden JWT check');
  });

  it('runs relay sequentially passing previous agent output', async () => {
    const root = tmpRoot();
    const svc = new Synergy(openDb(':memory:'), { root });
    const mockRunner: UnifiedRunnerFn = async (_root, agent, prompt) => {
      if (agent === 'gemini') {
        expect(prompt).toContain('Step1 schema ready');
        return { ok: true, reply: 'Step2 endpoints implemented', transport: 'cli' };
      }
      return { ok: true, reply: 'Step1 schema ready', transport: 'cli' };
    };

    const res = await runOrchestration(
      svc,
      { mode: 'relay', prompt: 'Build user API', agents: ['codex', 'gemini'] },
      mockRunner,
    );

    expect(res.turns.map((t) => t.agent)).toEqual(['codex', 'gemini']);
    expect(res.synthesis).toBe('Step2 endpoints implemented');
  });
});
