import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import pkg from '../../package.json';
import { normalizeAgent } from '../core/agents';
import { createSkill } from '../core/customization';
import { buildSharedContextPrompt, recordHandoff } from '../core/memory';
import { queryPerplexityApi } from '../core/perplexity';
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

  server.registerTool(
    'send_command',
    {
      description: 'Send a command/task to another agent. Requires human approval unless always-allowed.',
      inputSchema: {
        to: z.string(),
        command: z.string(),
        from: z.string().optional().describe('your agent name'),
      },
    },
    (a) => reply(() => svc.sendCommand({ from: who(a.from), to: a.to, command: a.command })),
  );

  server.registerTool(
    'ask_perplexity',
    {
      description: 'Ask Perplexity to research a topic and post a report to the team.',
      inputSchema: {
        query: z.string(),
        from: z.string().optional().describe('your agent name'),
      },
    },
    async (a) => {
      try {
        const req = svc.queueResearch({ from: who(a.from), query: a.query });
        const answer = await queryPerplexityApi(req.query, undefined, svc.root);
        if (answer) {
          const { eventId } = svc.completeResearch(req.id, answer);
          return { content: [{ type: 'text' as const, text: `REPORT #${eventId}: ${answer}` }] };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: `PENDING research#${req.id} opened for Perplexity web bridge (human will paste report)`,
            },
          ],
        };
      } catch (e) {
        return { isError: true, content: [{ type: 'text' as const, text: `ERR ${(e as Error).message}` }] };
      }
    },
  );

  server.registerTool(
    'get_project_memory',
    {
      description: 'Read shared project goal, recent decisions, active file locks, and git diff summary.',
      inputSchema: {
        include_diff: z.boolean().optional(),
        agent_name: name,
      },
    },
    (a) =>
      reply(() => {
        who(a.agent_name);
        return buildSharedContextPrompt(svc, { includeDiff: a.include_diff !== false, maxEvents: 10 });
      }),
  );

  server.registerTool(
    'handoff_task',
    {
      description: 'Hand off a task with goal, files, and notes cleanly to another agent (IDE MCP or CLI/API).',
      inputSchema: {
        to: z.string(),
        goal: z.string(),
        files: z.array(z.string()).optional(),
        notes: z.string().optional(),
        from: z.string().optional().describe('your agent name'),
      },
    },
    (a) =>
      reply(() => {
        const from = who(a.from);
        const to = normalizeAgent(a.to);
        recordHandoff(svc.root, { from, to, goal: a.goal, files: a.files, notes: a.notes });
        const filesNote = a.files?.length ? ` [${a.files.join(', ')}]` : '';
        const msg = `[HANDOFF] ${a.goal}${filesNote}${a.notes ? ` — ${a.notes}` : ''}`;
        return svc.askAgent({ from, to, question: msg, preserveFull: true });
      }),
  );

  server.registerTool(
    'create_skill',
    {
      description: 'Create a workspace skill under .agents/skills/<name>/SKILL.md with optional scripts/references.',
      inputSchema: {
        name: z.string().max(20),
        description: z.string(),
        instructions: z.string().optional(),
        agent: z.string().optional(),
        scripts: z.array(z.object({ filename: z.string(), content: z.string() })).optional(),
        references: z.array(z.object({ filename: z.string(), content: z.string() })).optional(),
      },
    },
    (a) =>
      reply(() => {
        const whoAgent = who(a.agent);
        const list = createSkill(svc.root, {
          name: a.name,
          description: a.description,
          instructions: a.instructions,
          agent: a.agent ?? null,
          scripts: a.scripts,
          references: a.references,
        });
        svc.postNotice(whoAgent, `Created workspace skill "${a.name}" (${list.length} total)`);
        return `SKILL_CREATED ${a.name} (${list.length} skills total)`;
      }),
  );

  /** Release locks of every agent name used in this session (call when the transport closes). */
  const releaseAll = () => {
    if (opts.defaultAgent) used.add(normalizeAgent(opts.defaultAgent));
    for (const a of used) svc.releaseAgentLocks(a);
  };

  return { server, releaseAll };
}
