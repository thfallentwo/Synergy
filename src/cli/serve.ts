import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { dbPath, requireRoot } from '../core/paths';
import { Synergy } from '../core/service';
import { openDb } from '../core/store';
import { createMcpServer } from '../mcp/server';

/** Run the stdio MCP server. stdout belongs to the protocol: log to stderr only. */
export async function serve(opts: { root?: string }): Promise<void> {
  // Guard: any stray console.log (ours or a dependency's) must not corrupt the JSON-RPC stream.
  console.log = (...a: unknown[]) => console.error(...a);
  console.info = console.log;
  console.debug = console.log;

  const root = requireRoot({ root: opts.root });
  const db = openDb(dbPath(root));
  const svc = new Synergy(db, { root });
  const { server, releaseAll } = createMcpServer(svc, { defaultAgent: process.env.SYNERGY_AGENT });

  let closed = false;
  const shutdown = () => {
    if (closed) return;
    closed = true;
    try {
      releaseAll();
      db.close();
    } catch (e) {
      console.error('[synergy] shutdown error:', e);
    }
    process.exit(0);
  };
  server.server.onclose = shutdown;
  process.stdin.on('end', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(new StdioServerTransport());
  console.error(`[synergy] MCP server ready (root: ${root})`);
}
