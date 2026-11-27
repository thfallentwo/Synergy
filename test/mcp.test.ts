import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { Synergy } from '../src/core/service';
import { openDb } from '../src/core/store';
import { createMcpServer } from '../src/mcp/server';
import { memSynergy, tmpRoot } from './helpers';

async function connect(defaultAgent?: string, root?: string) {
  const svc = root ? new Synergy(openDb(':memory:'), { root }) : memSynergy().svc;
  const { server, releaseAll } = createMcpServer(svc, { defaultAgent });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '1' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { err: !!r.isError, text: r.content[0].text };
  };
  return { svc, client, call, releaseAll };
}

describe('MCP tools', () => {
  it('exposes the ten tools with tiny descriptions', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'ask_agent',
      'ask_perplexity',
      'create_skill',
      'get_project_memory',
      'handoff_task',
      'lock_file',
      'post_status',
      'read_feed',
      'send_command',
      'unlock_file',
    ]);
    for (const t of tools) expect((t.description ?? '').length).toBeLessThan(120);
  });

  it('post_status / lock_file / read_feed round trip using the default agent', async () => {
    const { call } = await connect('Claude');
    expect((await call('lock_file', { file: 'src/auth.ts' })).text).toMatch(/^OK src\/auth\.ts locked/);
    expect((await call('post_status', { action: 'MODIFIED', file: 'src/auth.ts', summary: 'Added role field to User' })).text).toMatch(/^OK #2/);
    const feed = (await call('read_feed', { limit: 5 })).text;
    expect(feed).toContain('claude MODIFIED src/auth.ts | Added role field to User');
    expect(feed).toContain('LOCKS: src/auth.ts@claude');
  });

  it('explicit agent_name overrides the default; ask_agent works', async () => {
    const { call, svc } = await connect('claude');
    await call('ask_agent', { from: 'cursor', to: 'claude', question: 'ready?' });
    expect(svc.recentEvents()[0]).toMatchObject({ agent: 'cursor', to_agent: 'claude' });
  });

  it('returns isError for invalid input instead of throwing', async () => {
    const { call } = await connect('claude');
    const r = await call('lock_file', { file: '../../etc/passwd' });
    expect(r.err).toBe(true);
    expect(r.text).toMatch(/^ERR .*outside/);
  });

  it('releaseAll frees the locks of the session', async () => {
    const { call, svc, releaseAll } = await connect('claude');
    await call('lock_file', { file: 'a.ts' });
    releaseAll();
    expect(svc.state().locks).toHaveLength(0);
  });

  it('send_command queues a pending command for human approval', async () => {
    const { call, svc } = await connect('cursor');
    const r = await call('send_command', { to: 'claude', command: 'Run unit tests on auth.ts' });
    expect(r.err).toBe(false);
    expect(r.text).toMatch(/^PENDING cmd#1 awaiting human approval/);
    expect(svc.state().pendingCommands).toHaveLength(1);
  });

  it('ask_perplexity opens a pending research request when no API key is set', async () => {
    const prev = process.env.PERPLEXITY_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    try {
      const { call, svc } = await connect('codex');
      const r = await call('ask_perplexity', { query: 'Report copyright rules for brand X' });
      expect(r.err).toBe(false);
      expect(r.text).toMatch(/^PENDING research#1/);
      expect(svc.state().pendingResearch).toHaveLength(1);
    } finally {
      if (prev !== undefined) process.env.PERPLEXITY_API_KEY = prev;
    }
  });

  it('get_project_memory and handoff_task share context and persist handoff records', async () => {
    const root = tmpRoot();
    const { call, svc } = await connect('antigravity', root);
    await call('lock_file', { file: 'src/auth.ts' });
    const h = await call('handoff_task', {
      to: 'codex',
      goal: 'Add refresh token rotation',
      files: ['src/auth.ts'],
      notes: 'Keep backwards compatibility with existing cookie header',
    });
    expect(h.err).toBe(false);
    expect(h.text).toMatch(/^OK #2/);

    const mem = await call('get_project_memory', { include_diff: false });
    expect(mem.err).toBe(false);
    expect(mem.text).toContain('LAST HANDOFF:');
    expect(mem.text).toContain('antigravity -> codex: Add refresh token rotation');
    expect(svc.readFeed({ agent: 'codex' })).toContain('[HANDOFF] Add refresh token rotation');
  });
});
