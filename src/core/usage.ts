import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeAgent } from './agents';
import type { Synergy } from './service';
import type { UsageItem } from './types';

export const FIVE_HOURS_MS = 5 * 60 * 60_000;
const MAX_JSONL_FILES = 20;
const MAX_JSONL_BYTES = 4 * 1024 * 1024;
const CLAUDE_5H_BASELINE = 1_000_000;
const SESSION_WINDOW_TOKENS = 50_000;

function formatCompactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function scanClaudeWindowTokens(windowStart: number): number {
  const base = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(base)) return 0;
  const candidates: Array<{ file: string; mtime: number }> = [];

  try {
    for (const d of fs.readdirSync(base, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const sub = path.join(base, d.name);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(sub, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
        const p = path.join(sub, e.name);
        try {
          const st = fs.statSync(p);
          if (st.mtimeMs >= windowStart && st.size <= MAX_JSONL_BYTES) {
            candidates.push({ file: p, mtime: st.mtimeMs });
          }
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    return 0;
  }

  candidates.sort((a, b) => b.mtime - a.mtime);
  let total = 0;

  for (const c of candidates.slice(0, MAX_JSONL_FILES)) {
    try {
      for (const line of fs.readFileSync(c.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let obj: any;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const ts = typeof obj?.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
        if (!Number.isNaN(ts) && ts < windowStart) continue;
        const u = obj?.message?.usage ?? obj?.usage;
        if (!u || typeof u !== 'object') continue;
        total +=
          (Number(u.input_tokens) || 0) +
          (Number(u.output_tokens) || 0) +
          (Number(u.cache_creation_input_tokens) || 0) +
          (Number(u.cache_read_input_tokens) || 0);
      }
    } catch {
      /* ignore */
    }
  }

  return total;
}

function scanAntigravityWindowTokens(windowStart: number): number {
  const base = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
  if (!fs.existsSync(base)) return 0;
  const candidates: Array<{ file: string; mtime: number }> = [];

  try {
    for (const d of fs.readdirSync(base, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const p = path.join(base, d.name, '.system_generated', 'logs', 'transcript.jsonl');
      try {
        const st = fs.statSync(p);
        if (st.isFile() && st.mtimeMs >= windowStart && st.size <= MAX_JSONL_BYTES) {
          candidates.push({ file: p, mtime: st.mtimeMs });
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    return 0;
  }

  candidates.sort((a, b) => b.mtime - a.mtime);
  let total = 0;

  for (const c of candidates.slice(0, MAX_JSONL_FILES)) {
    try {
      for (const line of fs.readFileSync(c.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let obj: any;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const ts = typeof obj?.created_at === 'string' ? Date.parse(obj.created_at) : NaN;
        if (!Number.isNaN(ts) && ts < windowStart) continue;
        if (obj?.type !== 'PLANNER_RESPONSE') continue;
        total += (Number(obj.input_tokens) || 0) + (Number(obj.output_tokens) || 0);
      }
    } catch {
      /* ignore */
    }
  }

  return total;
}

export function collectUsageWindow(svc: Synergy, includeLocalLogs = true): { resetInMs: number; items: UsageItem[] } {
  const state = svc.state();
  const now = state.now;
  const windowStart = Math.floor(now / FIVE_HOURS_MS) * FIVE_HOURS_MS;
  const resetInMs = Math.max(0, windowStart + FIVE_HOURS_MS - now);
  const claudeTokens = includeLocalLogs ? scanClaudeWindowTokens(windowStart) : 0;
  const agTokens = includeLocalLogs ? scanAntigravityWindowTokens(windowStart) : 0;

  const eventRows = svc.db
    .prepare(
      "SELECT agent, COUNT(*) AS ops, COALESCE(SUM(LENGTH(text)),0) AS chars FROM events WHERE ts >= ? AND agent NOT IN ('human','system') GROUP BY agent",
    )
    .all(windowStart) as Array<{ agent: string; ops: number; chars: number }>;
  const eventMap = new Map(eventRows.map((r) => [r.agent, r]));

  const diffRows = svc.db
    .prepare('SELECT agent, COALESCE(SUM(LENGTH(patch)),0) AS pchars FROM diffs WHERE ts >= ? GROUP BY agent')
    .all(windowStart) as Array<{ agent: string; pchars: number }>;
  const diffMap = new Map(diffRows.map((r) => [r.agent, r.pchars]));

  const items: UsageItem[] = [];
  let hasClaude = false;
  let hasAg = false;

  for (const a of state.agents) {
    const isClaude = a.name === 'claude' || a.name === 'claude-code';
    if (isClaude) hasClaude = true;
    if (a.name === 'antigravity') hasAg = true;

    if (isClaude && claudeTokens > 0) {
      const percent = Math.min(100, Math.max(1, Math.round((claudeTokens / CLAUDE_5H_BASELINE) * 100)));
      const ev = eventMap.get(a.name);
      items.push({
        agent: a.name,
        display: a.display,
        kind: a.kind,
        percent,
        tokens: claudeTokens,
        ops: ev?.ops ?? 0,
        label: `${formatCompactTokens(claudeTokens)} tok`,
        source: 'logs',
      });
      continue;
    }

    if (a.name === 'antigravity' && agTokens > 0) {
      const percent = Math.min(100, Math.max(1, Math.round((agTokens / CLAUDE_5H_BASELINE) * 100)));
      const ev = eventMap.get(a.name);
      items.push({
        agent: a.name,
        display: a.display,
        kind: a.kind,
        percent,
        tokens: agTokens,
        ops: ev?.ops ?? 0,
        label: `${formatCompactTokens(agTokens)} tok`,
        source: 'logs',
      });
      continue;
    }

    const ev = eventMap.get(a.name);
    const ops = ev?.ops ?? 0;
    const chars = (ev?.chars ?? 0) + (diffMap.get(a.name) ?? 0);
    const tokens = ops === 0 && chars === 0 ? 0 : Math.max(ops * 40, Math.ceil(chars / 4));
    const percent = tokens > 0 ? Math.min(100, Math.max(1, Math.round((tokens / SESSION_WINDOW_TOKENS) * 100))) : 0;
    items.push({
      agent: a.name,
      display: a.display,
      kind: a.kind,
      percent,
      tokens,
      ops,
      label: `${formatCompactTokens(tokens)} tok`,
      source: 'session',
    });
  }

  if (!hasClaude && claudeTokens > 0) {
    const desc = describeAgent('claude-code');
    items.push({
      agent: 'claude-code',
      display: desc.display,
      kind: 'claude-code',
      percent: Math.min(100, Math.max(1, Math.round((claudeTokens / CLAUDE_5H_BASELINE) * 100))),
      tokens: claudeTokens,
      ops: 0,
      label: `${formatCompactTokens(claudeTokens)} tok`,
      source: 'logs',
    });
  }

  if (!hasAg && agTokens > 0) {
    const desc = describeAgent('antigravity');
    items.push({
      agent: 'antigravity',
      display: desc.display,
      kind: 'antigravity',
      percent: Math.min(100, Math.max(1, Math.round((agTokens / CLAUDE_5H_BASELINE) * 100))),
      tokens: agTokens,
      ops: 0,
      label: `${formatCompactTokens(agTokens)} tok`,
      source: 'logs',
    });
  }

  return { resetInMs, items };
}

export function collectUsage(svc: Synergy): UsageItem[] {
  return collectUsageWindow(svc).items;
}
