import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeAgent } from './agents';
import { SYNERGY_DIR } from './paths';
import { formatEvent, formatLocks } from './protocol';
import type { Synergy } from './service';
import type { LockRow } from './types';

export interface MemoryDecision {
  id: string;
  ts: number;
  agent: string;
  text: string;
}

export interface MemoryHandoff {
  id: string;
  ts: number;
  from: string;
  to: string;
  goal: string;
  files: string[];
  notes: string;
}

export interface ProjectMemory {
  goal: string;
  decisions: MemoryDecision[];
  handoffs: MemoryHandoff[];
  updatedAt: number;
}

const MAX_DECISIONS = 40;
const MAX_HANDOFFS = 25;

function memoryJsonPath(root: string): string {
  return path.join(root, SYNERGY_DIR, 'memory.json');
}

function contextMdPath(root: string): string {
  return path.join(root, SYNERGY_DIR, 'context.md');
}

function emptyMemory(): ProjectMemory {
  return { goal: '', decisions: [], handoffs: [], updatedAt: Date.now() };
}

/** Read persistent project memory (`.synergy/memory.json`). */
export function readProjectMemory(root: string): ProjectMemory {
  const file = memoryJsonPath(root);
  if (!fs.existsSync(file)) return emptyMemory();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ProjectMemory>;
    return {
      goal: String(parsed.goal ?? ''),
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
      handoffs: Array.isArray(parsed.handoffs) ? parsed.handoffs : [],
      updatedAt: Number(parsed.updatedAt) || Date.now(),
    };
  } catch {
    return emptyMemory();
  }
}

/** Render human- and agent-readable markdown for `.synergy/context.md`. */
export function renderContextMarkdown(mem: ProjectMemory, locks: LockRow[] = [], diffSummary = ''): string {
  const lines: string[] = [
    '# Project Context (Masiva Labs)',
    '',
    `Updated: ${new Date(mem.updatedAt || Date.now()).toISOString()}`,
    '',
    '## Goal',
    mem.goal.trim() || '_No project goal recorded yet._',
    '',
    '## Active File Locks',
    locks.length ? locks.map((l) => `- \`${l.file}\` (held by \`${l.agent}\`)`).join('\n') : '_No active locks._',
    '',
    '## Recent Decisions',
  ];
  if (mem.decisions.length) {
    for (const d of mem.decisions.slice(-12)) {
      lines.push(`- [${d.agent}] ${d.text}`);
    }
  } else {
    lines.push('_No recorded decisions yet._');
  }
  lines.push('', '## Recent Handoffs');
  if (mem.handoffs.length) {
    for (const h of mem.handoffs.slice(-8)) {
      const files = h.files.length ? ` (${h.files.join(', ')})` : '';
      lines.push(`- \`${h.from}\` -> \`${h.to}\`${files}: ${h.goal}${h.notes ? ` — ${h.notes}` : ''}`);
    }
  } else {
    lines.push('_No handoffs recorded yet._');
  }
  if (diffSummary.trim()) {
    lines.push('', '## Git Working Tree', '```', diffSummary.trim(), '```');
  }
  return lines.join('\n') + '\n';
}

function writeMemory(root: string, mem: ProjectMemory, locks: LockRow[] = [], diffSummary = ''): ProjectMemory {
  mem.updatedAt = Date.now();
  const dir = path.join(root, SYNERGY_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(memoryJsonPath(root), JSON.stringify(mem, null, 2), 'utf8');
  fs.writeFileSync(contextMdPath(root), renderContextMarkdown(mem, locks, diffSummary), 'utf8');
  return mem;
}

/** Update the shared project goal and sync `.synergy/context.md`. */
export function setProjectGoal(root: string, goal: string): ProjectMemory {
  const mem = readProjectMemory(root);
  mem.goal = String(goal ?? '').trim().slice(0, 1000);
  return writeMemory(root, mem);
}

/** Append an architectural or implementation decision and sync `.synergy/context.md`. */
export function appendMemoryDecision(root: string, agent: string, text: string): ProjectMemory {
  const clean = String(text ?? '').trim().slice(0, 800);
  if (!clean) throw new Error('decision text is empty');
  const mem = readProjectMemory(root);
  mem.decisions.push({
    id: `dec-${crypto.randomUUID().slice(0, 8)}`,
    ts: Date.now(),
    agent: normalizeAgent(agent),
    text: clean,
  });
  if (mem.decisions.length > MAX_DECISIONS) {
    mem.decisions = mem.decisions.slice(-MAX_DECISIONS);
  }
  return writeMemory(root, mem);
}

/** Record an explicit task/context handoff between agents and sync `.synergy/context.md`. */
export function recordHandoff(
  root: string,
  entry: { from: string; to: string; goal: string; files?: string[]; notes?: string },
): ProjectMemory {
  const goal = String(entry.goal ?? '').trim().slice(0, 800);
  if (!goal) throw new Error('handoff goal is empty');
  const mem = readProjectMemory(root);
  mem.handoffs.push({
    id: `hof-${crypto.randomUUID().slice(0, 8)}`,
    ts: Date.now(),
    from: normalizeAgent(entry.from),
    to: normalizeAgent(entry.to),
    goal,
    files: Array.isArray(entry.files) ? entry.files.map((f) => String(f).trim()).filter(Boolean).slice(0, 20) : [],
    notes: String(entry.notes ?? '').trim().slice(0, 1000),
  });
  if (mem.handoffs.length > MAX_HANDOFFS) {
    mem.handoffs = mem.handoffs.slice(-MAX_HANDOFFS);
  }
  return writeMemory(root, mem);
}

/** Return a compact git status + diff summary inside `root`, returning empty string outside git repos. */
export function getGitDiffSummary(root: string, maxChars = 3000): string {
  try {
    const inside = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 2000,
    }).trim();
    if (inside !== 'true') return '';
    const status = execFileSync('git', ['status', '--short'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 2000,
    }).trim();
    const diffStat = execFileSync('git', ['diff', '--stat'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 2000,
    }).trim();
    const diffBody = execFileSync('git', ['diff', '--unified=2'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 2500,
    }).trim();
    const parts = [
      status ? `STATUS:\n${status}` : '',
      diffStat ? `DIFF STAT:\n${diffStat}` : '',
      diffBody ? `PATCH:\n${diffBody}` : '',
    ].filter(Boolean);
    const combined = parts.join('\n\n');
    return combined.length > maxChars ? combined.slice(0, maxChars) + '\n... [truncated]' : combined;
  } catch {
    return '';
  }
}

/** Build a structured context prompt block from shared memory, locks, recent room events, and optional git diff. */
export function buildSharedContextPrompt(
  svc: Synergy,
  opts: { includeDiff?: boolean; maxEvents?: number } = {},
): string {
  const mem = readProjectMemory(svc.root);
  const state = svc.state();
  const events = svc.recentEvents(opts.maxEvents ?? 12);
  const now = Date.now();
  const diff = opts.includeDiff ? getGitDiffSummary(svc.root, 2000) : '';

  const sections: string[] = [];
  if (mem.goal) sections.push(`PROJECT GOAL:\n${mem.goal}`);
  if (mem.decisions.length) {
    sections.push(
      'RECENT DECISIONS:\n' +
        mem.decisions
          .slice(-6)
          .map((d) => `- [${d.agent}] ${d.text}`)
          .join('\n'),
    );
  }
  if (mem.handoffs.length) {
    const last = mem.handoffs[mem.handoffs.length - 1];
    sections.push(
      `LAST HANDOFF:\n${last.from} -> ${last.to}: ${last.goal}${last.files.length ? ` (files: ${last.files.join(', ')})` : ''}${last.notes ? ` | ${last.notes}` : ''}`,
    );
  }
  sections.push(formatLocks(state.locks, now));
  if (events.length) {
    sections.push('RECENT ROOM ACTIVITY:\n' + events.map((e) => formatEvent(e, now)).join('\n'));
  }
  if (diff) sections.push(`GIT WORKING TREE:\n${diff}`);

  return sections.join('\n\n');
}

/** Build a zero-copy-paste continuation brief for switching models when hitting quota/limit walls. */
export function buildHandoffBrief(svc: Synergy, targetAgent?: string): string {
  const mem = readProjectMemory(svc.root);
  const state = svc.state();
  const diff = getGitDiffSummary(svc.root, 2500);
  const events = svc.recentEvents(10);
  const now = Date.now();
  const targetLine = targetAgent ? `Target Agent: ${normalizeAgent(targetAgent)}` : 'Target Agent: next available agent';

  return [
    '# Continuation Handoff Brief',
    targetLine,
    `Workspace Root: ${svc.root}`,
    '',
    `## Project Goal`,
    mem.goal || '(Not explicitly set — infer from recent activity & diff below)',
    '',
    `## Key Decisions (${mem.decisions.length})`,
    mem.decisions.length
      ? mem.decisions.slice(-8).map((d) => `- [${d.agent}] ${d.text}`).join('\n')
      : '- None recorded yet.',
    '',
    `## Active Locks`,
    formatLocks(state.locks, now),
    '',
    `## Recent Room Messages`,
    events.length ? events.map((e) => formatEvent(e, now)).join('\n') : 'No recent messages.',
    '',
    `## Uncommitted Changes`,
    diff || 'Clean working tree.',
    '',
    'Continue directly from the last decision/diff above without repeating completed steps.',
  ].join('\n');
}
