import type { EventRow, LockRow } from './types';

export const ACTIONS = [
  'CREATED',
  'MODIFIED',
  'DELETED',
  'RENAMED',
  'TESTING',
  'BLOCKED',
  'DONE',
  'INFO',
] as const;
export type Action = (typeof ACTIONS)[number];

export const MAX_WORDS = 20;
export const MAX_HUMAN_CHARS = 500;

/** Collapse whitespace and cap to `max` words. */
export function capWords(text: string, max = MAX_WORDS): { text: string; trimmed: boolean } {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= max) return { text: words.join(' '), trimmed: false };
  return { text: words.slice(0, max).join(' '), trimmed: true };
}

/** Compact relative age: 30s, 5m, 2h, 3d. */
export function fmtAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function displayName(agent: string): string {
  return agent === 'human' ? '[Human]' : agent;
}

/** One feed line. Intentionally tiny: `#42 2m claude MODIFIED auth.ts | Added role field`. */
export function formatEvent(e: EventRow, now: number): string {
  const head = `#${e.id} ${fmtAge(now - e.ts)} ${displayName(e.agent)}`;
  switch (e.type) {
    case 'status':
      return `${head} ${e.action ?? 'INFO'} ${e.file ?? '-'} | ${e.text}`;
    case 'lock':
      return `${head} LOCKED ${e.file ?? '-'}`;
    case 'unlock':
      return `${head} UNLOCKED ${e.file ?? '-'}`;
    case 'ask': {
      const re = e.reply_to ? ` re#${e.reply_to}` : '';
      return `${head}\u2192${e.to_agent ?? 'all'}${re} ? ${e.text}`;
    }
    case 'human':
      return `${head}${e.to_agent ? `\u2192${e.to_agent}` : ''} ! ${e.text}`;
    default:
      return `#${e.id} ${fmtAge(now - e.ts)} * ${e.text}`;
  }
}

export function formatLocks(locks: LockRow[], now: number): string {
  if (locks.length === 0) return 'LOCKS: none';
  return 'LOCKS: ' + locks.map((l) => `${l.file}@${l.agent}(${fmtAge(now - l.ts)})`).join(' ');
}
