import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeAgent } from './agents';
import type { AgentView, LiveSessionInfo, LiveStep, LiveTurn } from './types';

const ACTIVE_WINDOW_MS = 60 * 60_000;
const SESSION_WINDOW_MS = 24 * 60 * 60_000;
const WORKING_IDLE_MS = 2 * 60_000;
const MAX_TAIL_BYTES = 512 * 1024;
const MAX_TURNS = 20;
const MAX_SESSIONS = 12;

function unwrapArg(val: unknown): string {
  if (typeof val !== 'string') return val == null ? '' : String(val);
  const trimmed = val.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    } catch {
      return val;
    }
  }
  return val;
}

function lineCount(s: string): number {
  if (!s) return 0;
  return s.split(/\r?\n/).length;
}

function baseName(p: string): string {
  if (!p) return 'file';
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

/** Compress verbose AI responses into a crisp 2-3 line summary for Agora. */
export function summarizeFinalText(raw: string): string {
  const withoutCode = raw.replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]+)`/g, '$1');
  const lines = withoutCode
    .split(/\r?\n/)
    .map((l) => l.replace(/^#{1,6}\s+/, '').replace(/^[-*]\s+/, '').replace(/\*\*([^*]+)\*\*/g, '$1').trim())
    .filter((l) => l.length > 0);
  if (!lines.length) return '';
  const kept = lines.slice(0, 3).join('\n');
  if (kept.length <= 220) return kept;
  return kept.slice(0, 217).trimEnd() + '…';
}

function parseTs(raw: unknown, fallback: number): number {
  if (typeof raw === 'string') {
    const t = Date.parse(raw);
    if (!Number.isNaN(t)) return t;
  } else if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  return fallback;
}

function makeToolStep(
  agent: string,
  turnId: string,
  ts: number,
  seq: number,
  name: string,
  args: Record<string, unknown>,
): LiveStep | null {
  const id = `${turnId}-s${seq}`;
  if (name === 'update_steps' || name === 'exit_plan_mode' || name === 'enter_plan_mode') return null;
  if (name === 'update_focus') {
    const focus = unwrapArg(args.focus).trim();
    if (!focus) return null;
    return { id, ts, agent, turnId, kind: 'focus', label: focus };
  }
  if (name === 'read_file' || name === 'Read') {
    const file = unwrapArg(args.Path ?? args.file_path ?? args.path);
    return {
      id,
      ts,
      agent,
      turnId,
      kind: 'read',
      label: `reading ${baseName(file)}`,
      detail: file || undefined,
      file: file || undefined,
    };
  }
  if (name === 'edit_file' || name === 'Edit' || name === 'MultiEdit') {
    const file = unwrapArg(args.Path ?? args.file_path ?? args.path);
    const target = unwrapArg(args.Target ?? args.old_string);
    const repl = unwrapArg(args.Replacement ?? args.new_string);
    const removed = lineCount(target);
    const added = lineCount(repl);
    return {
      id,
      ts,
      agent,
      turnId,
      kind: 'edit',
      label: `edited ${baseName(file)}; +${added} -${removed}`,
      detail: file || undefined,
      file: file || undefined,
      added,
      removed,
    };
  }
  if (name === 'write_file' || name === 'Write') {
    const file = unwrapArg(args.Path ?? args.file_path ?? args.path);
    const content = unwrapArg(args.Content ?? args.content);
    const added = lineCount(content);
    return {
      id,
      ts,
      agent,
      turnId,
      kind: 'edit',
      label: `wrote ${baseName(file)}; +${added} -0`,
      detail: file || undefined,
      file: file || undefined,
      added,
      removed: 0,
    };
  }
  if (name === 'run_command' || name === 'Bash') {
    const summary = unwrapArg(args.toolSummary ?? args.description).trim();
    const cmd = unwrapArg(args.CommandLine ?? args.command).trim();
    return {
      id,
      ts,
      agent,
      turnId,
      kind: 'cmd',
      label: summary || (cmd ? `running: ${cmd.slice(0, 48)}` : 'running command'),
      detail: cmd || undefined,
    };
  }
  if (
    name === 'search_web' ||
    name === 'grep_search' ||
    name === 'find_by_name' ||
    name === 'Grep' ||
    name === 'Glob' ||
    name === 'WebSearch' ||
    name === 'WebFetch'
  ) {
    const q = unwrapArg(args.query ?? args.Query ?? args.pattern ?? args.Pattern ?? args.url).trim();
    return {
      id,
      ts,
      agent,
      turnId,
      kind: 'research',
      label: q ? `researching ${q.slice(0, 52)}` : 'researching...',
      detail: q || undefined,
    };
  }
  return { id, ts, agent, turnId, kind: 'focus', label: name.replace(/_/g, ' ') };
}

export function parseAntigravityLines(lines: string[]): LiveTurn[] {
  const turns: LiveTurn[] = [];
  let cur: LiveTurn | null = null;
  let seq = 0;

  const ensureTurn = (ts: number, key: string): LiveTurn => {
    if (!cur || cur.status === 'done') {
      seq = 0;
      cur = {
        turnId: `ag-${key}`,
        agent: 'antigravity',
        startedAt: ts,
        status: 'working',
        steps: [],
        tokensIn: 0,
        tokensOut: 0,
      };
      turns.push(cur);
    }
    return cur;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = parseTs(o.created_at, Date.now());
    const stepKey = String(o.step_index ?? i);

    if (o.type === 'USER_INPUT') {
      seq = 0;
      cur = {
        turnId: `ag-${stepKey}`,
        agent: 'antigravity',
        startedAt: ts,
        status: 'working',
        steps: [],
        tokensIn: 0,
        tokensOut: 0,
      };
      turns.push(cur);
      continue;
    }

    if (o.type === 'PLANNER_RESPONSE') {
      const turn = ensureTurn(ts, stepKey);
      if (o.model) turn.model = String(o.model);
      turn.tokensIn += Number(o.input_tokens) || 0;
      turn.tokensOut += Number(o.output_tokens) || 0;

      const tcs = Array.isArray(o.tool_calls) ? o.tool_calls : [];
      let hadFocus = false;
      for (const tc of tcs) {
        const name = String(tc?.name ?? '');
        if (name === 'update_focus') hadFocus = true;
        const args = tc?.args && typeof tc.args === 'object' ? tc.args : {};
        const step = makeToolStep('antigravity', turn.turnId, ts, ++seq, name, args);
        if (step) turn.steps.push(step);
      }

      if (!hadFocus && typeof o.thinking === 'string' && o.thinking.trim() && tcs.length === 0 && !o.content) {
        const firstLine = o.thinking.trim().split(/\r?\n/)[0].slice(0, 72);
        turn.steps.push({
          id: `${turn.turnId}-s${++seq}`,
          ts,
          agent: 'antigravity',
          turnId: turn.turnId,
          kind: 'think',
          label: firstLine || 'thinking...',
          detail: o.thinking.trim().slice(0, 600),
        });
      }

      if (typeof o.content === 'string' && o.content.trim() && tcs.length === 0) {
        turn.status = 'done';
        turn.finishedAt = ts;
        turn.finalText = summarizeFinalText(o.content);
      }
    }
  }

  return turns.slice(-MAX_TURNS);
}

export function parseClaudeLines(lines: string[]): LiveTurn[] {
  const turns: LiveTurn[] = [];
  let cur: LiveTurn | null = null;
  let seq = 0;

  const ensureTurn = (ts: number, key: string): LiveTurn => {
    if (!cur || cur.status === 'done') {
      seq = 0;
      cur = {
        turnId: `cc-${key}`,
        agent: 'claude-code',
        startedAt: ts,
        status: 'working',
        steps: [],
        tokensIn: 0,
        tokensOut: 0,
      };
      turns.push(cur);
    }
    return cur;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = parseTs(o.timestamp, Date.now());
    const key = String(o.uuid ?? i);

    if (o.type === 'user' && !o.isMeta) {
      const content = o.message?.content;
      const isToolResult = Array.isArray(content) && content.every((c: any) => c?.type === 'tool_result');
      if (!isToolResult) {
        seq = 0;
        cur = {
          turnId: `cc-${key}`,
          agent: 'claude-code',
          startedAt: ts,
          status: 'working',
          steps: [],
          tokensIn: 0,
          tokensOut: 0,
        };
        turns.push(cur);
      }
      continue;
    }

    if (o.type === 'assistant' && o.message) {
      const turn = ensureTurn(ts, key);
      if (o.message.model) turn.model = String(o.message.model);
      const u = o.message.usage;
      if (u && typeof u === 'object') {
        turn.tokensIn += (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0);
        turn.tokensOut += Number(u.output_tokens) || 0;
      }

      const blocks = Array.isArray(o.message.content) ? o.message.content : [];
      let hasToolUse = false;
      const textParts: string[] = [];
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'tool_use') {
          hasToolUse = true;
          const args = b.input && typeof b.input === 'object' ? b.input : {};
          const step = makeToolStep('claude-code', turn.turnId, ts, ++seq, String(b.name ?? ''), args);
          if (step) turn.steps.push(step);
        } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
          const first = b.thinking.trim().split(/\r?\n/)[0].slice(0, 72);
          turn.steps.push({
            id: `${turn.turnId}-s${++seq}`,
            ts,
            agent: 'claude-code',
            turnId: turn.turnId,
            kind: 'think',
            label: first || 'thinking...',
            detail: b.thinking.trim().slice(0, 600),
          });
        } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          textParts.push(b.text.trim());
        }
      }

      if (textParts.length && !hasToolUse) {
        turn.status = 'done';
        turn.finishedAt = ts;
        turn.finalText = summarizeFinalText(textParts.join('\n\n'));
      }
    }
  }

  return turns.slice(-MAX_TURNS);
}

function extractSessionTitle(lines: string[], kind: 'antigravity' | 'claude-code', fallback: string): string {
  for (const raw of lines) {
    const line = raw?.trim();
    if (!line) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    let text = '';
    if (kind === 'antigravity' && o.type === 'USER_INPUT' && typeof o.content === 'string') {
      text = o.content;
    } else if (kind === 'claude-code' && o.type === 'user' && !o.isMeta) {
      const c = o.message?.content;
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) {
        const part = c.find((p: any) => p?.type === 'text' && typeof p?.text === 'string');
        if (part) text = part.text;
      }
    }
    if (!text) continue;
    const cleaned = text
      .replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, ' ')
      .replace(/<\/?USER_REQUEST>/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned) return cleaned.length > 64 ? cleaned.slice(0, 61).trimEnd() + '...' : cleaned;
  }
  return fallback;
}

function findRecentTranscripts(
  baseDir: string,
  matcher: (entryPath: string) => boolean,
  now: number,
  windowMs = SESSION_WINDOW_MS,
  maxCount = MAX_SESSIONS,
): Array<{ file: string; mtimeMs: number }> {
  if (!fs.existsSync(baseDir)) return [];
  const minMtime = now - windowMs;
  const found: Array<{ file: string; mtimeMs: number }> = [];

  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p, depth + 1);
      } else if (e.isFile() && matcher(p)) {
        try {
          const st = fs.statSync(p);
          if (st.mtimeMs >= minMtime) found.push({ file: p, mtimeMs: st.mtimeMs });
        } catch {
          /* ignore */
        }
      }
    }
  };

  walk(baseDir, 0);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found.slice(0, maxCount);
}

function readTailLines(file: string): string[] {
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - MAX_TAIL_BYTES);
  const fd = fs.openSync(file, 'r');
  try {
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const txt = buf.toString('utf8');
    const lines = txt.split(/\r?\n/);
    return start > 0 ? lines.slice(1) : lines;
  } finally {
    fs.closeSync(fd);
  }
}

interface CachedSession {
  file: string;
  mtimeMs: number;
  size: number;
  agent: 'antigravity' | 'claude-code';
  sessionId: string;
  title: string;
  turns: LiveTurn[];
}

export class LiveObserver {
  private rev = 0;
  private sig = '';
  private sessionCache = new Map<string, CachedSession>();

  constructor(private readonly clock: () => number = Date.now) {}

  poll(): boolean {
    const now = this.clock();
    const agDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
    const ccDir = path.join(os.homedir(), '.claude', 'projects');

    const agFiles = findRecentTranscripts(
      agDir,
      (p) => p.endsWith('transcript.jsonl') && p.includes('.system_generated'),
      now,
    );
    const ccFiles = findRecentTranscripts(ccDir, (p) => p.endsWith('.jsonl'), now);

    const seen = new Set<string>();
    for (const f of agFiles) {
      const convId = path.basename(path.dirname(path.dirname(path.dirname(f.file))));
      const sessionId = `antigravity:${convId}`;
      seen.add(sessionId);
      this.checkSession('antigravity', sessionId, f.file, parseAntigravityLines);
    }
    for (const f of ccFiles) {
      const convId = path.basename(f.file, '.jsonl');
      const sessionId = `claude-code:${convId}`;
      seen.add(sessionId);
      this.checkSession('claude-code', sessionId, f.file, parseClaudeLines);
    }
    for (const id of [...this.sessionCache.keys()]) {
      if (!seen.has(id)) this.sessionCache.delete(id);
    }

    const allTurns = this.allTurns();
    const nextSig = JSON.stringify([
      allTurns.map((t) => [t.turnId, t.status, t.steps.length, t.finalText?.length ?? 0]),
      [...this.sessionCache.values()].map((s) => [s.sessionId, s.mtimeMs]),
    ]);
    if (nextSig !== this.sig) {
      this.sig = nextSig;
      this.rev++;
      return true;
    }
    return false;
  }

  private checkSession(
    agent: 'antigravity' | 'claude-code',
    sessionId: string,
    file: string,
    parser: (lines: string[]) => LiveTurn[],
  ): void {
    try {
      const st = fs.statSync(file);
      const prev = this.sessionCache.get(sessionId);
      if (prev && prev.file === file && prev.mtimeMs === st.mtimeMs && prev.size === st.size) return;
      const lines = readTailLines(file);
      const fallback = `${describeAgent(agent).display} (${sessionId.split(':')[1]?.slice(0, 6) ?? ''})`;
      const title = extractSessionTitle(lines, agent, fallback);
      const turns = parser(lines).map((t) => ({
        ...t,
        turnId: `${sessionId}:${t.turnId}`,
        sessionId,
        sessionTitle: title,
      }));
      this.sessionCache.set(sessionId, { file, mtimeMs: st.mtimeMs, size: st.size, agent, sessionId, title, turns });
    } catch {
      /* ignore transient read locks */
    }
  }

  private allTurns(): LiveTurn[] {
    const all: LiveTurn[] = [];
    for (const sess of this.sessionCache.values()) all.push(...sess.turns);
    all.sort((a, b) => a.startedAt - b.startedAt);
    return all.slice(-120);
  }

  snapshot(): { rev: number; turns: LiveTurn[]; agents: AgentView[]; sessions: LiveSessionInfo[] } {
    const now = this.clock();
    const turns = this.allTurns();
    const agents: AgentView[] = [];
    const sessions: LiveSessionInfo[] = [];
    const activeByAgent = new Map<string, LiveTurn[]>();

    for (const sess of this.sessionCache.values()) {
      sessions.push({
        sessionId: sess.sessionId,
        agent: sess.agent,
        title: sess.title,
        updatedAt: sess.mtimeMs,
        turnCount: sess.turns.length,
        active: now - sess.mtimeMs < 15 * 60_000,
      });
      if (now - sess.mtimeMs <= ACTIVE_WINDOW_MS && sess.turns.length) {
        const list = activeByAgent.get(sess.agent) ?? [];
        list.push(...sess.turns);
        activeByAgent.set(sess.agent, list);
      }
    }
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);

    for (const [agent, list] of activeByAgent.entries()) {
      if (!list.length) continue;
      list.sort((a, b) => a.startedAt - b.startedAt);
      const lastTurn = list[list.length - 1];
      let added = 0;
      let removed = 0;
      let lastFile: string | null = null;
      let lastSummary: string | null = null;

      for (const t of list) {
        for (const s of t.steps) {
          added += s.added ?? 0;
          removed += s.removed ?? 0;
          if (s.file) lastFile = s.file;
          lastSummary = s.label;
        }
        if (t.finalText) lastSummary = t.finalText.slice(0, 120);
      }

      const lastStepTs = lastTurn.steps.length ? lastTurn.steps[lastTurn.steps.length - 1].ts : lastTurn.startedAt;
      const lastSeen = Math.max(lastTurn.finishedAt ?? 0, lastStepTs);
      const isWorking = lastTurn.status === 'working' && now - lastSeen < WORKING_IDLE_MS;
      const desc = describeAgent(agent);

      agents.push({
        name: agent,
        display: desc.display,
        kind: desc.kind,
        first_seen: list[0].startedAt,
        last_seen: lastSeen,
        last_file: lastFile,
        last_summary: lastSummary,
        read_cursor: 0,
        added,
        removed,
        status: isWorking ? 'working' : now - lastSeen < 15 * 60_000 ? 'idle' : 'offline',
      });
    }

    return { rev: this.rev, turns, agents, sessions };
  }
}
