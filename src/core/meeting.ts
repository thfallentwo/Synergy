import fs from 'node:fs';
import path from 'node:path';
import type { MeetingFileInfo, MeetingState } from './types';

/** Fixed 13-seat roster covering every supported AI provider in Agora. */
export const SUPPORTED_MEETING_AGENTS: readonly string[] = [
  'antigravity',
  'claude-code',
  'claude',
  'cursor',
  'codex',
  'gemini',
  'deepseek',
  'nemotron',
  'hermes',
  'grok',
  'perplexity',
  'copilot',
  'kimi',
];

/** Shuffle seat assignments using Fisher-Yates so every meeting randomizes chair positions. */
export function shuffleSeats(agents: readonly string[] = SUPPORTED_MEETING_AGENTS): string[] {
  const arr = [...agents];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Directory where Agora stores saved meeting note files. */
export function meetingsDir(root: string): string {
  return path.join(root, '.synergy', 'meetings');
}

function slugify(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9\u00c0-\u024f]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || 'meeting';
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Format and persist accepted meeting notes (and key discussion) into `.synergy/meetings/YYYY-MM-DD_<slug>.md`. */
export function saveMeetingMarkdown(root: string, meeting: MeetingState): string {
  const dir = meetingsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const dateStr = formatDate(meeting.startedAt);
  const baseName = meeting.savedFile || `${dateStr}_${slugify(meeting.title)}_${meeting.id.slice(-4)}.md`;
  const filePath = path.join(dir, baseName);

  const lines: string[] = [
    `# ${meeting.title}`,
    '',
    `- **Date:** ${new Date(meeting.startedAt).toISOString()}`,
    `- **Started by:** ${meeting.startedBy}`,
    `- **Meeting ID:** ${meeting.id}`,
    `- **Status:** ${meeting.status}`,
    '',
    '## Accepted Decisions & Notes',
  ];

  if (meeting.notes.length === 0) {
    lines.push('_No explicit notes recorded yet._');
  } else {
    for (const n of meeting.notes) {
      const t = new Date(n.ts).toISOString().slice(11, 19);
      lines.push(`- **[${t}] (${n.author}):** ${n.text}`);
    }
  }

  lines.push('', '## Discussion Highlights');
  const acceptedMsgs = meeting.messages.filter((m) => m.accepted || m.from === 'human');
  const list = acceptedMsgs.length > 0 ? acceptedMsgs : meeting.messages.slice(-20);
  if (list.length === 0) {
    lines.push('_No messages yet._');
  } else {
    for (const m of list) {
      const t = new Date(m.ts).toISOString().slice(11, 19);
      const badge = m.accepted ? ' [ACCEPTED]' : '';
      lines.push(`- **[${t}] ${m.from}${badge}:** ${m.text}`);
    }
  }

  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
  return baseName;
}

/** List all saved meeting markdown files newest-first without flooding agent context. */
export function listMeetingFiles(root: string): MeetingFileInfo[] {
  const dir = meetingsDir(root);
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out: MeetingFileInfo[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const full = path.join(dir, e.name);
    try {
      const st = fs.statSync(full);
      const head = fs.readFileSync(full, 'utf8').split(/\r?\n/, 3);
      const titleLine = head.find((l) => l.startsWith('# '));
      const title = titleLine ? titleLine.slice(2).trim() : e.name.replace(/\.md$/, '');
      const dateMatch = e.name.match(/^(\d{4}-\d{2}-\d{2})/);
      const date = dateMatch ? dateMatch[1] : formatDate(st.mtimeMs);
      out.push({ file: e.name, title, date, mtime: Math.floor(st.mtimeMs) });
    } catch {
      /* ignore unreadable */
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** Read a specific meeting markdown file safely (prevents path traversal). */
export function readMeetingFile(root: string, file: string): string | null {
  const safe = path.basename(file);
  if (!safe.endsWith('.md')) return null;
  const full = path.join(meetingsDir(root), safe);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, 'utf8');
}
