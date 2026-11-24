import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createMcpServer } from '../src/mcp/server';
import { memSynergy } from './helpers';

async function connect(defaultAgent?: string) {
  const { svc } = memSynergy();
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
  it('exposes exactly the five tools with tiny descriptions', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['ask_agent', 'lock_file', 'post_status', 'read_feed', 'unlock_file']);
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
});
