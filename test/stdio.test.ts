import { execSync, spawn } from 'node:child_process';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Synergy } from '../src/core/service';
import { openDb } from '../src/core/store';
import { tmpRoot } from './helpers';

const CLI = path.resolve(__dirname, '../dist/cli/index.js');

beforeAll(() => {
  execSync('npx tsup', { cwd: path.resolve(__dirname, '..'), stdio: 'ignore' });
});

describe('real stdio server', () => {
  it('keeps stdout pure JSON-RPC, logs to stderr, releases locks when stdin closes', async () => {
    const root = tmpRoot();
    const child = spawn('node', [CLI, 'serve', '--root', root], {
      env: { ...process.env, SYNERGY_AGENT: 'claude' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const exited = new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
    const send = (o: object) => child.stdin.write(JSON.stringify(o) + '\n');
    const waitFor = async (id: number) => {
      for (let i = 0; i < 200; i++) {
        const hit = out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === id);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('timeout waiting for id ' + id + '\nstderr: ' + err);
    };

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    await waitFor(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect((await waitFor(2)).result.tools).toHaveLength(10);
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lock_file', arguments: { file: 'a.ts' } } });
    expect((await waitFor(3)).result.content[0].text).toMatch(/^OK a\.ts locked/);

    // every stdout line must be a JSON-RPC message
    for (const line of out.split('\n').filter(Boolean)) expect(JSON.parse(line).jsonrpc).toBe('2.0');
    expect(err).toContain('[synergy] MCP server ready');

    child.stdin.end();
    expect(await exited).toBe(0);
    const svc = new Synergy(openDb(path.join(root, '.synergy', 'synergy.db')), { root });
    expect(svc.state().locks).toHaveLength(0);
    expect(svc.recentEvents().map((e) => e.type)).toEqual(['lock', 'unlock']);
  });
});
