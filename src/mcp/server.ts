import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import pkg from '../../package.json';
import { normalizeAgent } from '../core/agents';
import { ACTIONS } from '../core/protocol';
import type { Synergy } from '../core/service';

export interface McpOptions {
  /** Used when a tool call omits agent_name (set via the SYNERGY_AGENT env var). */
  defaultAgent?: string;
}

/**
 * Build the Synergy MCP server. Tool descriptions are deliberately tiny:
 * they are loaded into every agent's context on every turn.
 */
export function createMcpServer(svc: Synergy, opts: McpOptions = {}) {
  const server = new McpServer({ name: 'synergy', version: pkg.version });
  const used = new Set<string>();
  const who = (name?: string) => {
    const a = normalizeAgent(name ?? opts.defaultAgent);
    used.add(a);
    return a;
  };
  const reply = (fn: () => string) => {
    try {
      return { content: [{ type: 'text' as const, text: fn() }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text' as const, text: `ERR ${(e as Error).message}` }] };
    }
  };
  const name = z.string().optional().describe('your agent name');

  server.registerTool(
    'post_status',
    {
      description: 'Tell the team what you changed. Summary max 20 words.',
      inputSchema: {
        action: z.enum(ACTIONS),
        file: z.string().describe('project-relative path, or - if none'),
        summary: z.string(),
        added: z.number().int().optional().describe('lines added'),
        removed: z.number().int().optional().describe('lines removed'),
        agent_name: name,
      },
    },
    (a) =>
      reply(() =>
        svc.postStatus({
          agent: who(a.agent_name),
          action: a.action,
          file: a.file,
          summary: a.summary,
          added: a.added,
          removed: a.removed,
        }),
      ),
  );

  server.registerTool(
    'read_feed',
    {
      description: 'Latest team messages and active file locks. Call at task start and before editing.',
      inputSchema: { limit: z.number().int().min(1).max(50).optional(), agent_name: name },
    },
    (a) => reply(() => svc.readFeed({ agent: who(a.agent_name), limit: a.limit })),
  );

  server.registerTool(
    'lock_file',
    {
      description: 'Lock a file before editing it. DENIED = someone else is editing; do not edit, ask them.',
      inputSchema: { file: z.string(), agent_name: name },
    },
    (a) => reply(() => svc.lockFile({ agent: who(a.agent_name), file: a.file })),
  );

  server.registerTool(
    'unlock_file',
    {
      description: 'Release your lock when you are done with a file.',
      inputSchema: { file: z.string(), agent_name: name },
    },
    (a) => reply(() => svc.unlockFile({ agent: who(a.agent_name), file: a.file })),
  );

  server.registerTool(
    'ask_agent',
    {
      description: "Leave a short question for another agent (or 'all'). Answer one by passing reply_to.",
      inputSchema: {
        to: z.string(),
        question: z.string(),
        reply_to: z.number().int().optional().describe('id of the message you answer'),
        from: z.string().optional().describe('your agent name'),
      },
    },
    (a) => reply(() => svc.askAgent({ from: who(a.from), to: a.to, question: a.question, replyTo: a.reply_to })),
  );

  /** Release locks of every agent name used in this session (call when the transport closes). */
  const releaseAll = () => {
    if (opts.defaultAgent) used.add(normalizeAgent(opts.defaultAgent));
    for (const a of used) svc.releaseAgentLocks(a);
  };

  return { server, releaseAll };
}
