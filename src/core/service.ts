import fs from 'node:fs';
import path from 'node:path';
import { createPatch, diffLines } from 'diff';
import { describeAgent, normalizeAgent } from './agents';
import { readAgentPrefs } from './customization';
import {
  SUPPORTED_MEETING_AGENTS,
  listMeetingFiles,
  readMeetingFile,
  saveMeetingMarkdown,
  shuffleSeats,
} from './meeting';
import { normalizeFile } from './paths';
import {
  ACTIONS,
  MAX_HUMAN_CHARS,
  MAX_WORDS,
  capWords,
  fmtAge,
  formatEvent,
  formatLocks,
} from './protocol';
import type { DB } from './store';
import type {
  AgentRow,
  ChatRow,
  CommandRow,
  CommandStatus,
  DiffInfo,
  DiffRow,
  AgentStatus,
  AgentView,
  EventRow,
  EventType,
  LockRow,
  MeetingFileInfo,
  MeetingProposal,
  MeetingState,
  ResearchRow,
  RoleRow,
  StateSnapshot,
} from './types';

const DEFAULT_ROLES: Array<[string, string]> = [
  ['Çevirmen', 'Limiti en bol modeller (DeepSeek, Gemini CLI) ile prompttaki teknik terimleri koruyarak seçilen dile çevirir.'],
];

export interface SynergyOptions {
  root: string;
  clock?: () => number;
  lockTtlMs?: number;
  maxEvents?: number;
}

const ASK_MAX_WORDS = 40;
const CMD_MAX_WORDS = 60;
const DIGEST_MAX = 10;
const MAX_SNAPSHOT_BYTES = 1_000_000;
const MAX_PATCH_CHARS = 60_000;
const DIFF_ACTIONS = ['MODIFIED', 'CREATED', 'DELETED', 'RENAMED'];
const WORKING_MS = 60_000;
const IDLE_MS = 15 * 60_000;
const INCOGNITO_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CONVERSATIONS = 1000;
const IMAGE_CAPABLE_AGENTS = new Set(['gemini', 'codex', 'antigravity', 'grok', 'copilot']);

type NewEvent = {
  agent: string;
  type: EventType;
  action?: string | null;
  file?: string | null;
  text?: string;
  to?: string | null;
  replyTo?: number | null;
  added?: number;
  removed?: number;
  image?: string | null;
};

/** Transport-agnostic core: every MCP tool, CLI command and HTTP route goes through this class. */
export class Synergy {
  readonly root: string;
  readonly lockTtlMs: number;
  private readonly clock: () => number;
  private readonly maxEvents: number;

  constructor(readonly db: DB, opts: SynergyOptions) {
    this.root = opts.root;
    this.clock = opts.clock ?? Date.now;
    this.lockTtlMs = opts.lockTtlMs ?? 10 * 60_000;
    this.maxEvents = opts.maxEvents ?? 5000;
    this.ensureDefaultChat();
    this.seedDefaultRoles();
    this.prune();
  }

  sweepExpiredChats(): number {
    const now = this.clock();
    const expired = this.db
      .prepare('SELECT id FROM chats WHERE incognito=1 AND expires_at IS NOT NULL AND expires_at<=?')
      .all(now) as Array<{ id: number }>;
    if (!expired.length) return 0;
    for (const row of expired) {
      this.db.prepare('DELETE FROM events WHERE chat_id=?').run(row.id);
      this.db.prepare('DELETE FROM chats WHERE id=?').run(row.id);
    }
    this.bumpChatRev();
    return expired.length;
  }

  private ensureDefaultChat(): number {
    this.sweepExpiredChats();
    const activeCount = (this.db.prepare('SELECT COUNT(*) AS c FROM chats WHERE archived=0').get() as { c: number }).c;
    if (activeCount === 0) {
      const now = this.clock();
      this.db.prepare('INSERT INTO chats(title,created_at,updated_at,archived) VALUES(?,?,?,0)').run('Main Chat', now, now);
    }
    const active = this.db.prepare("SELECT value FROM meta WHERE key='active_chat_id'").get() as
      | { value: string }
      | undefined;
    const activeNum = Number(active?.value ?? 0);
    if (!activeNum || !this.db.prepare('SELECT 1 FROM chats WHERE id=? AND archived=0').get(activeNum)) {
      const first = (this.db.prepare('SELECT id FROM chats WHERE archived=0 ORDER BY id LIMIT 1').get() as { id: number }).id;
      this.db
        .prepare("INSERT INTO meta(key,value) VALUES('active_chat_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(String(first));
      return first;
    }
    return activeNum;
  }

  activeChatId(): number {
    return this.ensureDefaultChat();
  }

  private seedDefaultRoles(): void {
    const done = this.db.prepare("SELECT value FROM meta WHERE key='roles_v2_seeded'").get() as
      | { value: string }
      | undefined;
    if (done?.value === '1') return;
    const now = this.clock();
    const hasTranslator = this.db.prepare("SELECT 1 FROM roles WHERE title='Çevirmen'").get();
    if (!hasTranslator) {
      // Remove legacy multi-role defaults if unassigned so fixed role becomes Çevirmen cleanly
      this.db.prepare("DELETE FROM roles WHERE agent IS NULL").run();
      const stmt = this.db.prepare('INSERT INTO roles(title,description,agent,ts) VALUES(?,?,NULL,?)');
      for (const [title, description] of DEFAULT_ROLES) stmt.run(title, description, now);
    }
    this.db
      .prepare("INSERT INTO meta(key,value) VALUES('roles_v2_seeded','1') ON CONFLICT(key) DO UPDATE SET value='1'")
      .run();
  }

  // ---------- internals ----------

  maxId(): number {
    return (this.db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM events').get() as { m: number }).m;
  }

  private ensureAgent(name: string): void {
    const now = this.clock();
    const { display, kind } = describeAgent(name);
    this.db
      .prepare(
        'INSERT OR IGNORE INTO agents(name,display,kind,first_seen,last_seen,read_cursor) VALUES(?,?,?,?,?,?)',
      )
      .run(name, display, kind, now, now, this.maxId());
    this.db.prepare('UPDATE agents SET last_seen=? WHERE name=?').run(now, name);
  }

  private addEvent(e: NewEvent): number {
    const now = this.clock();
    const chatId = this.activeChatId();
    const info = this.db
      .prepare(
        `INSERT INTO events(ts,agent,type,action,file,text,to_agent,reply_to,added,removed,image,chat_id)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        now,
        e.agent,
        e.type,
        e.action ?? null,
        e.file ?? null,
        e.text ?? '',
        e.to ?? null,
        e.replyTo ?? null,
        e.added ?? 0,
        e.removed ?? 0,
        e.image ?? null,
        chatId,
      );
    this.db.prepare('UPDATE chats SET updated_at=? WHERE id=?').run(now, chatId);
    const id = Number(info.lastInsertRowid);
    if (id % 500 === 0) this.prune();
    return id;
  }

  prune(): void {
    this.db
      .prepare('DELETE FROM events WHERE id <= (SELECT COALESCE(MAX(id),0) FROM events) - ?')
      .run(this.maxEvents);
  }

  private readText(file: string): string | null {
    try {
      const p = path.join(this.root, file);
      const st = fs.statSync(p);
      if (!st.isFile() || st.size > MAX_SNAPSHOT_BYTES) return null;
      const txt = fs.readFileSync(p, 'utf8');
      return txt.includes('\0') ? null : txt;
    } catch {
      return null;
    }
  }

  private takeSnapshot(agent: string, file: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO snapshots(file,agent,content) VALUES(?,?,?)')
      .run(file, agent, this.readText(file) ?? '');
  }

  /**
   * Compare the file now with the snapshot taken when `agent` locked it, record the diff,
   * add it to the agent's totals and move the snapshot forward. Null when nothing changed.
   */
  private captureDiff(agent: string, file: string): { added: number; removed: number } | null {
    const snap = this.db.prepare('SELECT agent, content FROM snapshots WHERE file=?').get(file) as
      | { agent: string; content: string }
      | undefined;
    if (!snap || snap.agent !== agent) return null;
    const exists = fs.existsSync(path.join(this.root, file));
    const cur = exists ? this.readText(file) : '';
    if (cur === null || cur === snap.content) return null;
    let added = 0;
    let removed = 0;
    for (const part of diffLines(snap.content, cur)) {
      if (part.added) added += part.count ?? 0;
      else if (part.removed) removed += part.count ?? 0;
    }
    let patch = createPatch(file, snap.content, cur, '', '', { context: 3 });
    if (patch.length > MAX_PATCH_CHARS) patch = patch.slice(0, MAX_PATCH_CHARS) + '\n\\ (truncated)\n';
    this.db
      .prepare('INSERT INTO diffs(ts,agent,file,added,removed,patch) VALUES(?,?,?,?,?,?)')
      .run(this.clock(), agent, file, added, removed, patch);
    this.db.prepare('UPDATE snapshots SET content=? WHERE file=?').run(cur, file);
    this.db.prepare('UPDATE agents SET added=added+?, removed=removed+? WHERE name=?').run(added, removed, agent);
    return { added, removed };
  }

  private dropLock(l: LockRow): { added: number; removed: number } | null {
    const d = this.captureDiff(l.agent, l.file);
    this.db.prepare('DELETE FROM locks WHERE file=?').run(l.file);
    this.db.prepare('DELETE FROM snapshots WHERE file=?').run(l.file);
    return d;
  }

  private activeLocks(): LockRow[] {
    return this.db
      .prepare('SELECT * FROM locks WHERE expires_at > ? ORDER BY ts')
      .all(this.clock()) as LockRow[];
  }

  /** Remove expired locks and tell the room. Called from write paths and the UI timer. */
  sweepLocks(): number {
    const run = this.db.transaction(() => {
      const gone = this.db
        .prepare('SELECT * FROM locks WHERE expires_at <= ?')
        .all(this.clock()) as LockRow[];
      for (const l of gone) {
        this.dropLock(l);
        this.addEvent({
          agent: 'system',
          type: 'system',
          file: l.file,
          text: `lock on ${l.file} by ${l.agent} expired`,
        });
      }
      return gone.length;
    });
    return run.immediate();
  }

  /** Unread events for `agent` since its last call, then advance its cursor. */
  private digest(agent: string): string {
    const cursor = (
      this.db.prepare('SELECT read_cursor FROM agents WHERE name=?').get(agent) as {
        read_cursor: number;
      }
    ).read_cursor;
    const chatId = this.activeChatId();
    const where = `id>? AND chat_id=? AND agent!=? AND (to_agent IS NULL OR to_agent IN (?, 'all'))`;
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM events WHERE ${where}`).get(cursor, chatId, agent, agent) as {
        c: number;
      }
    ).c;
    const rows = (
      this.db
        .prepare(`SELECT * FROM events WHERE ${where} ORDER BY id DESC LIMIT ?`)
        .all(cursor, chatId, agent, agent, DIGEST_MAX) as EventRow[]
    ).reverse();
    this.db.prepare('UPDATE agents SET read_cursor=? WHERE name=?').run(this.maxId(), agent);
    if (total === 0) return '';
    const now = this.clock();
    const lines = rows.map((r) => formatEvent(r, now));
    const more = total > rows.length ? `\n(+${total - rows.length} older, call read_feed)` : '';
    return `\nNEW(${total}):\n${lines.join('\n')}${more}`;
  }

  private file(raw: string): string {
    return normalizeFile(this.root, raw);
  }

  // ---------- agent-facing operations (each returns the compact text sent to the agent) ----------

  postStatus(input: {
    agent?: string;
    action: string;
    file?: string;
    summary: string;
    added?: number;
    removed?: number;
  }): string {
    const agent = normalizeAgent(input.agent);
    const action = input.action.trim().toUpperCase();
    if (!(ACTIONS as readonly string[]).includes(action)) {
      throw new Error(`action must be one of ${ACTIONS.join('|')}`);
    }
    const file = input.file && input.file.trim() && input.file.trim() !== '-' ? this.file(input.file) : null;
    const { text, trimmed } = capWords(input.summary, MAX_WORDS);
    if (!text) throw new Error('summary is empty');
    let added = Math.max(0, Math.trunc(input.added ?? 0));
    let removed = Math.max(0, Math.trunc(input.removed ?? 0));

    return this.db
      .transaction(() => {
        this.ensureAgent(agent);
        this.sweepLocks();
        // Measured diff (from the lock snapshot) beats whatever the agent claims.
        const measured = file && DIFF_ACTIONS.includes(action) ? this.captureDiff(agent, file) : null;
        if (measured) ({ added, removed } = measured);
        const id = this.addEvent({ agent, type: 'status', action, file, text, added, removed });
        this.db
          .prepare(
            'UPDATE agents SET last_file=?, last_summary=?, added=added+?, removed=removed+? WHERE name=?',
          )
          .run(file, text, measured ? 0 : added, measured ? 0 : removed, agent);
        let out = `OK #${id}`;
        if (trimmed) out += ` (trimmed to ${MAX_WORDS}w)`;
        if (file) {
          const lock = this.db.prepare('SELECT * FROM locks WHERE file=?').get(file) as LockRow | undefined;
          if (lock && lock.agent !== agent) out += `\nWARN ${file} is locked by ${lock.agent}`;
        }
        return out + this.digest(agent);
      })
      .immediate();
  }

  lockFile(input: { agent?: string; file: string }): string {
    const agent = normalizeAgent(input.agent);
    const file = this.file(input.file);
    return this.db
      .transaction(() => {
        this.ensureAgent(agent);
        this.sweepLocks();
        const now = this.clock();
        const row = this.db.prepare('SELECT * FROM locks WHERE file=?').get(file) as LockRow | undefined;
        const ttlMin = Math.round(this.lockTtlMs / 60_000);
        let out: string;
        if (row && row.agent !== agent) {
          const free = fmtAge(Math.max(0, row.expires_at - now));
          out = `DENIED ${file} held by ${row.agent} ${fmtAge(now - row.ts)}, expires in ${free}`;
        } else if (row) {
          this.db.prepare('UPDATE locks SET expires_at=? WHERE file=?').run(now + this.lockTtlMs, file);
          if (!this.db.prepare('SELECT 1 FROM snapshots WHERE file=?').get(file)) this.takeSnapshot(agent, file);
          out = `OK ${file} renewed ${ttlMin}m`;
        } else {
          this.db
            .prepare('INSERT INTO locks(file,agent,ts,expires_at) VALUES(?,?,?,?)')
            .run(file, agent, now, now + this.lockTtlMs);
          this.takeSnapshot(agent, file);
          this.addEvent({ agent, type: 'lock', file });
          this.db.prepare('UPDATE agents SET last_file=? WHERE name=?').run(file, agent);
          out = `OK ${file} locked ${ttlMin}m`;
        }
        return out + this.digest(agent);
      })
      .immediate();
  }

  unlockFile(input: { agent?: string; file: string }): string {
    const agent = normalizeAgent(input.agent);
    const file = this.file(input.file);
    return this.db
      .transaction(() => {
        this.ensureAgent(agent);
        this.sweepLocks();
        const row = this.db.prepare('SELECT * FROM locks WHERE file=?').get(file) as LockRow | undefined;
        let out: string;
        if (!row) out = `OK ${file} not locked`;
        else if (row.agent !== agent) out = `DENIED ${file} held by ${row.agent}`;
        else {
          const d = this.dropLock(row);
          this.addEvent({ agent, type: 'unlock', file, added: d?.added, removed: d?.removed });
          out = `OK ${file} unlocked`;
        }
        return out + this.digest(agent);
      })
      .immediate();
  }

  askAgent(input: { from?: string; to: string; question: string; replyTo?: number; maxWords?: number; preserveFull?: boolean }): string {
    const from = normalizeAgent(input.from);
    const to = input.to.trim().toLowerCase() === 'all' ? 'all' : normalizeAgent(input.to);
    const { text, trimmed } = input.preserveFull
      ? { text: String(input.question ?? '').trim().slice(0, 6000), trimmed: false }
      : capWords(input.question, input.maxWords ?? ASK_MAX_WORDS);
    if (!text) throw new Error('question is empty');
    return this.db
      .transaction(() => {
        this.ensureAgent(from);
        const id = this.addEvent({ agent: from, type: 'ask', to, text, replyTo: input.replyTo ?? null });
        const out = `OK #${id}${trimmed ? ` (trimmed to ${ASK_MAX_WORDS}w)` : ''}`;
        return out + this.digest(from);
      })
      .immediate();
  }

  sendCommand(input: { from?: string; to: string; command: string }): string {
    const from = normalizeAgent(input.from);
    const to = input.to.trim().toLowerCase() === 'all' ? 'all' : normalizeAgent(input.to);
    const { text } = capWords(input.command, CMD_MAX_WORDS);
    if (!text) throw new Error('command is empty');
    return this.db
      .transaction(() => {
        this.ensureAgent(from);
        const trusted = !!this.db.prepare('SELECT 1 FROM trusted_agents WHERE agent=?').get(from);
        const status: CommandStatus = trusted ? 'approved' : 'pending';
        const info = this.db
          .prepare('INSERT INTO commands(ts,from_agent,to_agent,command,status) VALUES(?,?,?,?,?)')
          .run(this.clock(), from, to, text, status);
        const cmdId = Number(info.lastInsertRowid);
        if (trusted) {
          const eventId = this.addEvent({ agent: from, type: 'command', to, text });
          return `OK #${eventId} (auto-approved)` + this.digest(from);
        }
        return `PENDING cmd#${cmdId} awaiting human approval` + this.digest(from);
      })
      .immediate();
  }

  readFeed(input: { agent?: string; limit?: number }): string {
    const agent = normalizeAgent(input.agent);
    const limit = Math.min(50, Math.max(1, Math.trunc(input.limit ?? 10)));
    return this.db
      .transaction(() => {
        this.ensureAgent(agent);
        this.sweepLocks();
        const chatId = this.activeChatId();
        const rows = (
          this.db.prepare('SELECT * FROM events WHERE chat_id=? ORDER BY id DESC LIMIT ?').all(chatId, limit) as EventRow[]
        ).reverse();
        this.db.prepare('UPDATE agents SET read_cursor=? WHERE name=?').run(this.maxId(), agent);
        const now = this.clock();
        const feed = rows.length ? rows.map((r) => formatEvent(r, now)).join('\n') : 'FEED: empty';
        const lang = this.getLang();
        const roleRows = this.db
          .prepare('SELECT title, description FROM roles WHERE agent=? ORDER BY id')
          .all(agent) as Array<{ title: string; description: string }>;
        const roleHead = roleRows.length
          ? roleRows.map((r) => `ROLE: ${r.title}${r.description ? ` — ${r.description}` : ''}`).join('\n') + '\n'
          : '';
        const head = lang === 'en' ? '' : `LANG ${lang} (write summaries in this language)\n`;
        const chatMeta = this.db.prepare('SELECT incognito, participants FROM chats WHERE id=?').get(chatId) as
          | { incognito?: number; participants?: string | null }
          | undefined;
        const incogHead = chatMeta?.incognito
          ? 'INCOGNITO CHAT (24h auto-delete): DO NOT save any facts, notes, or memories from this chat to persistent memory or files.\n'
          : '';
        let partHead = '';
        if (chatMeta?.participants) {
          try {
            const p = JSON.parse(chatMeta.participants) as string[];
            if (Array.isArray(p) && p.length) partHead = `CHAT PARTICIPANTS: ${p.join(', ')}\n`;
          } catch {
            /* ignore */
          }
        }
        const mt = this.getMeeting();
        let meetingHead = '';
        if (mt && mt.status === 'active' && !mt.deafAgents.includes(agent)) {
          const muted = mt.mutedAgents.includes(agent);
          const hasFloor = mt.floorAgent === agent;
          const recent = mt.messages
            .slice(-4)
            .map((m) => `  [${m.from}] ${m.text}`)
            .join('\n');
          meetingHead =
            `MEETING ACTIVE: "${mt.title}" (discussion only — NO code edits/file locks during meeting)\n` +
            `FLOOR: ${mt.floorAgent ?? 'none (use meeting_turn action=raise_hand to request permission)'}` +
            (hasFloor ? ' — YOU HAVE THE FLOOR: call meeting_turn action=speak' : '') +
            (muted ? ' — YOU ARE MUTED by human' : '') +
            (recent ? `\nMEETING CHAT:\n${recent}` : '') +
            '\n';
        }
        let sourcesHead = '';
        try {
          const idxFile = path.join(this.root, '.synergy', 'sources.json');
          if (fs.existsSync(idxFile)) {
            const arr = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
            if (Array.isArray(arr) && arr.length) {
              const names = arr.map((s: any) => String(s?.name ?? '')).filter(Boolean).slice(0, 40);
              if (names.length) {
                sourcesHead = `PROJECT SOURCES (.synergy/sources/): ${names.join(', ')} (shared project files/images — inspect anytime without asking user to re-upload)\n`;
              }
            }
          }
        } catch {
          /* ignore */
        }
        let prefHead = '';
        const ap = readAgentPrefs()[agent];
        if (ap?.behavior) prefHead += `AGENT BEHAVIOR: ${ap.behavior}\n`;
        if (ap?.message) prefHead += `USER DIRECTIVE TO YOU: ${ap.message}\n`;
        return `${roleHead}${prefHead}${incogHead}${partHead}${sourcesHead}${meetingHead}${head}${feed}\n${formatLocks(this.activeLocks(), now)}`;
      })
      .immediate();
  }

  /** Locks held by `agent` are released when its session ends. */
  releaseAgentLocks(agent: string): number {
    const name = normalizeAgent(agent);
    return this.db
      .transaction(() => {
        const rows = this.db.prepare('SELECT * FROM locks WHERE agent=?').all(name) as LockRow[];
        for (const l of rows) {
          const d = this.dropLock(l);
          this.addEvent({ agent: name, type: 'unlock', file: l.file, added: d?.added, removed: d?.removed });
        }
        return rows.length;
      })
      .immediate();
  }

  // ---------- human / dashboard operations ----------

  private autoNameChatIfDefault(chatId: number, promptText: string): void {
    const chat = this.db.prepare('SELECT id, title, participants, named_by FROM chats WHERE id=?').get(chatId) as
      | ChatRow
      | undefined;
    if (!chat || chat.named_by || (chat.title !== 'New Chat' && chat.title !== 'Incognito Chat')) return;
    const stop = new Set([
      'deneme', 'yapıyorum', 'ama', 'bir', 'şey', 'olsun', 'ver', 'bana', 'lütfen', 'please',
      'can', 'you', 'just', 'test', 'make', 'give', 'me', 'the', 'a', 'an', 'for', 'with',
      've', 'ile', 'için', 'bu', 'şu', 'nasıl', 'neden', 'basit', 'bişey', 'bi',
    ]);
    const cleaned = promptText
      .replace(/@\S+/g, ' ')
      .replace(/\/[a-z]+/gi, ' ')
      .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const topic = cleaned.filter((w) => !stop.has(w.toLowerCase()));
    const chosen = (topic.length ? topic : cleaned).slice(0, 4);
    if (!chosen.length) return;
    const autoTitle = chosen
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
      .slice(0, 60);
    let pool: string[] = [...SUPPORTED_MEETING_AGENTS];
    if (chat.participants) {
      try {
        const p = JSON.parse(chat.participants) as string[];
        if (Array.isArray(p) && p.length) pool = p;
      } catch {
        /* ignore */
      }
    }
    const namer = pool[Math.floor(Math.random() * pool.length)] || 'antigravity';
    this.db.prepare('UPDATE chats SET title=?, named_by=? WHERE id=?').run(autoTitle, namer, chatId);
    this.bumpChatRev();
  }

  /** Plain text broadcasts; multi `@agent` mentions and `/` commands supported. */
  humanSend(raw: string, image?: string | null): { id: number } {
    const msg = raw.trim().slice(0, MAX_HUMAN_CHARS);
    const img = image && /^\/uploads\/[a-z0-9-]+\.(png|jpg|jpeg|webp|gif)$/i.test(image.trim()) ? image.trim() : null;
    if (!msg && !img) throw new Error('message is empty');

    const targets: string[] = [];
    let body = msg;
    while (true) {
      const m = body.match(/^@(\S+)(?:\s+([\s\S]*))?$/);
      if (!m) break;
      const t = m[1].toLowerCase() === 'all' ? 'all' : normalizeAgent(m[1]);
      if (!targets.includes(t)) targets.push(t);
      body = (m[2] ?? '').trim();
    }

    const slashMatch = body.match(/^\/([a-z]+)(?:\s+([\s\S]*))?$/i);
    if (slashMatch) {
      const cmd = slashMatch[1].toLowerCase();
      const rest = (slashMatch[2] ?? '').trim();
      if (cmd === 'meeting') {
        this.startMeeting({ startedBy: 'human', title: rest || undefined });
        return { id: this.maxId() };
      }
      if (cmd === 'newchat') {
        this.createChat(rest ? { title: rest } : undefined);
        return { id: this.maxId() };
      }
      if (cmd === 'lock' || cmd === 'unlock') {
        if (!rest) throw new Error('specify file path');
        const file = this.file(rest);
        if (cmd === 'unlock') {
          this.forceUnlock(file);
          return { id: this.maxId() };
        }
        return this.db
          .transaction(() => {
            this.ensureAgent('human');
            const now = this.clock();
            this.db
              .prepare('INSERT OR REPLACE INTO locks(file,agent,ts,expires_at) VALUES(?,?,?,?)')
              .run(file, 'human', now, now + 60 * 60_000);
            return { id: this.addEvent({ agent: 'human', type: 'lock', file }) };
          })
          .immediate();
      }
      const heartCmds = new Set(['goal', 'plan', 'think', 'list', 'image', 'doc', 'explain', 'search']);
      if (heartCmds.has(cmd)) {
        if (!targets.length) throw new Error(`/${cmd} requires at least one @agent first`);
        if (cmd === 'think' && !rest) throw new Error('/think requires what to think about');
        if (cmd === 'image' && !targets.some((t) => IMAGE_CAPABLE_AGENTS.has(t))) {
          throw new Error('/image requires an image-capable AI (@gemini, @codex, @antigravity, @grok, @copilot)');
        }
        const to = targets.join(',');
        let finalPrompt = body;
        if (cmd === 'goal') finalPrompt = `[GOAL] Focus strictly on this goal${rest ? `: ${rest}` : '.'}`;
        else if (cmd === 'plan') finalPrompt = `[PLAN] Stop coding and build a step-by-step plan${rest ? `: ${rest}` : '.'}`;
        else if (cmd === 'think') finalPrompt = `[THINK] Deeply overthink and analyze: ${rest}`;
        else if (cmd === 'list') {
          if (/^(chats|conversations)$/i.test(rest)) {
            const list = this.listChats().filter((c) => !c.archived).map((c) => c.title).join(', ');
            finalPrompt = `[LIST] Conversations (${list || 'none'})`;
          } else if (/^agents$/i.test(rest)) {
            const list = (this.db.prepare("SELECT name FROM agents WHERE name!='human'").all() as Array<{ name: string }>).map((a) => a.name).join(', ');
            finalPrompt = `[LIST] Agents (${list || 'none connected'})`;
          } else {
            finalPrompt = `[LIST] List ${rest || 'items'}`;
          }
        } else if (cmd === 'image') finalPrompt = `[IMAGE] Generate visual asset${rest ? `: ${rest}` : '.'}`;
        else if (cmd === 'doc') finalPrompt = `[DOC] Create documentation${rest ? ` for: ${rest}` : '.'}`;
        else if (cmd === 'explain') finalPrompt = `[EXPLAIN] Explain your code or plan${rest ? `: ${rest}` : '.'}`;
        else if (cmd === 'search') finalPrompt = `[SEARCH] Research directly without waiting for Perplexity${rest ? `: ${rest}` : '.'}`;

        return this.db
          .transaction(() => {
            this.ensureAgent('human');
            const id = this.addEvent({ agent: 'human', type: 'human', text: finalPrompt, to, image: img });
            this.autoNameChatIfDefault(this.activeChatId(), rest || body);
            return { id };
          })
          .immediate();
      }
    }

    const to = targets.length ? targets.join(',') : null;
    const text = targets.length ? body : msg;
    if (!text && !img) throw new Error('message is empty');
    return this.db
      .transaction(() => {
        this.ensureAgent('human');
        const id = this.addEvent({ agent: 'human', type: 'human', text, to, image: img });
        this.autoNameChatIfDefault(this.activeChatId(), text);
        return { id };
      })
      .immediate();
  }

  editHumanMessage(id: number, raw: string): { ok: true } {
    if (!Number.isInteger(id) || id <= 0) throw new Error('invalid message id');
    const msg = raw.trim().slice(0, MAX_HUMAN_CHARS);
    if (!msg) throw new Error('message is empty');
    return this.db
      .transaction(() => {
        const row = this.db.prepare('SELECT id, type FROM events WHERE id=?').get(id) as
          | { id: number; type: string }
          | undefined;
        if (!row) throw new Error('message not found');
        if (row.type !== 'human') throw new Error('only human messages can be edited');
        const mention = msg.match(/^@(\S+)\s+([\s\S]+)$/);
        const to = mention ? (mention[1].toLowerCase() === 'all' ? 'all' : normalizeAgent(mention[1])) : null;
        const text = mention ? mention[2].trim() : msg;
        this.db.prepare('UPDATE events SET text=?, to_agent=? WHERE id=?').run(text, to, id);
        this.bumpChatRev();
        return { ok: true as const };
      })
      .immediate();
  }

  deleteHumanMessage(id: number): { ok: true; text: string; image: string | null } {
    if (!Number.isInteger(id) || id <= 0) throw new Error('invalid message id');
    return this.db
      .transaction(() => {
        const row = this.db
          .prepare('SELECT id, type, text, to_agent, image FROM events WHERE id=?')
          .get(id) as { id: number; type: string; text: string; to_agent: string | null; image: string | null } | undefined;
        if (!row) throw new Error('message not found');
        if (row.type !== 'human') throw new Error('only human messages can be recalled');
        this.db.prepare('DELETE FROM events WHERE id=?').run(id);
        this.bumpChatRev();
        const fullText = row.to_agent ? `@${row.to_agent} ${row.text}` : row.text;
        return { ok: true as const, text: fullText, image: row.image ?? null };
      })
      .immediate();
  }

  recallLastHumanMessage(): { ok: true; text: string; image: string | null } {
    const row = this.db
      .prepare("SELECT id FROM events WHERE type='human' ORDER BY id DESC LIMIT 1")
      .get() as { id: number } | undefined;
    if (!row) throw new Error('no human message to recall');
    return this.deleteHumanMessage(row.id);
  }

  setAgentPaused(rawAgent: string, paused: boolean): { agent: string; paused: boolean } {
    const agent = normalizeAgent(rawAgent);
    return this.db
      .transaction(() => {
        this.ensureAgent('human');
        if (paused) {
          this.db.prepare('INSERT OR REPLACE INTO paused_agents(agent,ts) VALUES(?,?)').run(agent, this.clock());
          this.addEvent({
            agent: 'human',
            type: 'human',
            to: agent,
            text: 'PAUSE: stop editing and wait for the human.',
          });
        } else {
          this.db.prepare('DELETE FROM paused_agents WHERE agent=?').run(agent);
          this.addEvent({
            agent: 'human',
            type: 'human',
            to: agent,
            text: 'RESUME: you may continue.',
          });
        }
        return { agent, paused };
      })
      .immediate();
  }

  pausedAgents(): string[] {
    return (this.db.prepare('SELECT agent FROM paused_agents ORDER BY agent').all() as { agent: string }[]).map(
      (r) => r.agent,
    );
  }

  listRoles(): RoleRow[] {
    return this.db.prepare('SELECT * FROM roles ORDER BY id').all() as RoleRow[];
  }

  createRole(input: { title: string; description?: string; agent?: string | null }): RoleRow {
    const title = input.title.trim().slice(0, 80);
    if (!title) throw new Error('role title is empty');
    const description = (input.description ?? '').trim().slice(0, 240);
    const agent = input.agent && input.agent.trim() ? normalizeAgent(input.agent) : null;
    const info = this.db
      .prepare('INSERT INTO roles(title,description,agent,ts) VALUES(?,?,?,?)')
      .run(title, description, agent, this.clock());
    return this.db.prepare('SELECT * FROM roles WHERE id=?').get(Number(info.lastInsertRowid)) as RoleRow;
  }

  assignRole(id: number, rawAgent: string | null): RoleRow {
    if (!Number.isInteger(id) || id <= 0) throw new Error('invalid role id');
    const row = this.db.prepare('SELECT * FROM roles WHERE id=?').get(id) as RoleRow | undefined;
    if (!row) throw new Error('role not found');
    const agent = rawAgent && rawAgent.trim() ? normalizeAgent(rawAgent) : null;
    this.db.prepare('UPDATE roles SET agent=? WHERE id=?').run(agent, id);
    return this.db.prepare('SELECT * FROM roles WHERE id=?').get(id) as RoleRow;
  }

  deleteRole(id: number): boolean {
    if (!Number.isInteger(id) || id <= 0) throw new Error('invalid role id');
    return this.db.prepare('DELETE FROM roles WHERE id=?').run(id).changes > 0;
  }

  private pruneEmptyDraftChats(keepId?: number): void {
    const nonDraftOther = (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM chats WHERE archived=0 AND id != ? AND NOT ((title='New Chat' OR title='Incognito Chat') AND NOT EXISTS (SELECT 1 FROM events e WHERE e.chat_id=chats.id))")
        .get(keepId ?? -1) as { c: number }
    ).c;
    if (nonDraftOther === 0 && !keepId) return;
    const drafts = this.db
      .prepare(
        "SELECT id FROM chats WHERE id != ? AND (title='New Chat' OR title='Incognito Chat') AND NOT EXISTS (SELECT 1 FROM events e WHERE e.chat_id=chats.id)",
      )
      .all(keepId ?? -1) as Array<{ id: number }>;
    if (!drafts.length) return;
    for (const d of drafts) {
      this.db.prepare('DELETE FROM chats WHERE id=?').run(d.id);
    }
    this.bumpChatRev();
  }

  listChats(): ChatRow[] {
    this.ensureDefaultChat();
    return this.db
      .prepare(
        'SELECT c.*, (SELECT COUNT(*) FROM events e WHERE e.chat_id=c.id) AS event_count FROM chats c ORDER BY COALESCE(c.pinned,0) DESC, c.updated_at DESC, c.id DESC',
      )
      .all() as ChatRow[];
  }

  createChat(input?: string | { title?: string; incognito?: boolean; participants?: string[]; liveSessions?: string[] }): ChatRow {
    const rawTitle = typeof input === 'string' ? input : input?.title;
    const incognito = typeof input === 'object' && Boolean(input?.incognito);
    const rawParticipants = typeof input === 'object' && Array.isArray(input?.participants) ? input.participants : [];
    const participants = [...new Set(rawParticipants.map((p) => normalizeAgent(String(p))).filter(Boolean))];
    const participantsJson = participants.length ? JSON.stringify(participants) : null;
    const rawSessions = typeof input === 'object' && Array.isArray(input?.liveSessions) ? input.liveSessions : [];
    const liveSessions = [...new Set(rawSessions.map((s) => String(s).trim()).filter(Boolean))];
    const liveSessionsJson = liveSessions.length ? JSON.stringify(liveSessions) : null;
    const clean = (rawTitle ?? '').trim().slice(0, 60);
    const title = clean || (incognito ? 'Incognito Chat' : 'New Chat');
    const now = this.clock();
    const expiresAt = incognito ? now + INCOGNITO_TTL_MS : null;
    return this.db
      .transaction(() => {
        this.sweepExpiredChats();
        const total = (this.db.prepare('SELECT COUNT(*) AS c FROM chats').get() as { c: number }).c;
        if (total >= MAX_CONVERSATIONS) throw new Error('conversation limit reached');
        if (!clean && !incognito && !participantsJson && !liveSessionsJson) {
          const empty = this.db
            .prepare(
              "SELECT c.*, 0 AS event_count FROM chats c WHERE c.archived=0 AND c.incognito=0 AND c.title='New Chat' AND c.live_sessions IS NULL AND NOT EXISTS (SELECT 1 FROM events e WHERE e.chat_id=c.id) ORDER BY c.id DESC LIMIT 1",
            )
            .get() as ChatRow | undefined;
          if (empty) {
            this.db
              .prepare("INSERT INTO meta(key,value) VALUES('active_chat_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
              .run(String(empty.id));
            this.bumpChatRev();
            return empty;
          }
        }
        if (liveSessions.length) this.stripLiveSessionsFromOtherChats(-1, liveSessions);
        const info = this.db
          .prepare('INSERT INTO chats(title,created_at,updated_at,cleared_at,incognito,expires_at,participants,live_sessions) VALUES(?,?,?,?,?,?,?,?)')
          .run(title, now, now, now, incognito ? 1 : 0, expiresAt, participantsJson, liveSessionsJson);
        const id = Number(info.lastInsertRowid);
        this.pruneEmptyDraftChats(id);
        this.db
          .prepare("INSERT INTO meta(key,value) VALUES('active_chat_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .run(String(id));
        this.bumpChatRev();
        return this.db
          .prepare('SELECT c.*, (SELECT COUNT(*) FROM events e WHERE e.chat_id=c.id) AS event_count FROM chats c WHERE c.id=?')
          .get(id) as ChatRow;
      })
      .immediate();
  }

  private stripLiveSessionsFromOtherChats(keepChatId: number, sessionIds: string[]): void {
    if (!sessionIds.length) return;
    const drop = new Set(sessionIds);
    const others = this.db.prepare('SELECT id, live_sessions FROM chats WHERE id!=? AND live_sessions IS NOT NULL').all(keepChatId) as Array<{
      id: number;
      live_sessions: string;
    }>;
    const upd = this.db.prepare('UPDATE chats SET live_sessions=? WHERE id=?');
    for (const row of others) {
      try {
        const parsed = JSON.parse(row.live_sessions);
        if (!Array.isArray(parsed)) continue;
        const next = parsed.map(String).filter((s) => !drop.has(s));
        if (next.length !== parsed.length) upd.run(next.length ? JSON.stringify(next) : null, row.id);
      } catch {
        /* ignore malformed JSON */
      }
    }
  }

  bindChatLiveSessions(chatId: number, sessionIds: string[]): ChatRow {
    if (!Number.isInteger(chatId) || chatId <= 0) throw new Error('invalid chat id');
    const clean = [...new Set(sessionIds.map((s) => String(s).trim()).filter(Boolean))];
    return this.db
      .transaction(() => {
        const row = this.db.prepare('SELECT * FROM chats WHERE id=?').get(chatId) as ChatRow | undefined;
        if (!row) throw new Error('chat not found');
        this.stripLiveSessionsFromOtherChats(chatId, clean);
        this.db.prepare('UPDATE chats SET live_sessions=? WHERE id=?').run(clean.length ? JSON.stringify(clean) : null, chatId);
        this.bumpChatRev();
        return this.db
          .prepare('SELECT c.*, (SELECT COUNT(*) FROM events e WHERE e.chat_id=c.id) AS event_count FROM chats c WHERE c.id=?')
          .get(chatId) as ChatRow;
      })
      .immediate();
  }

  switchChat(id: number): ChatRow {
    if (!Number.isInteger(id) || id <= 0) throw new Error('invalid chat id');
    return this.db
      .transaction(() => {
        const row = this.db.prepare('SELECT * FROM chats WHERE id=?').get(id) as ChatRow | undefined;
        if (!row) throw new Error('chat not found');
        this.pruneEmptyDraftChats(id);
        this.db
          .prepare("INSERT INTO meta(key,value) VALUES('active_chat_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .run(String(id));
        this.bumpChatRev();
        return row;
      })
      .immediate();
  }

  clearChat(id?: number): number {
    const chatId = id ?? this.activeChatId();
    const now = this.clock();
    return this.db
      .transaction(() => {
        const info = this.db.prepare('DELETE FROM events WHERE chat_id=?').run(chatId);
        this.db.prepare('UPDATE chats SET cleared_at=? WHERE id=?').run(now, chatId);
        this.bumpChatRev();
        return info.changes;
      })
      .immediate();
  }

  deleteChat(id: number): boolean {
    if (!Number.isInteger(id) || id <= 0) throw new Error('invalid chat id');
    return this.db
      .transaction(() => {
        this.db.prepare('DELETE FROM events WHERE chat_id=?').run(id);
        const changes = this.db.prepare('DELETE FROM chats WHERE id=?').run(id).changes;
        this.ensureDefaultChat();
        this.bumpChatRev();
        return changes > 0;
      })
      .immediate();
  }

  archiveChat(id: number, archived: boolean): ChatRow {
    if (!Number.isInteger(id) || id <= 0) throw new Error('invalid chat id');
    return this.db
      .transaction(() => {
        const row = this.db.prepare('SELECT * FROM chats WHERE id=?').get(id) as ChatRow | undefined;
        if (!row) throw new Error('chat not found');
        if (archived && row.incognito) throw new Error('incognito chats cannot be archived; delete instead');
        this.db.prepare('UPDATE chats SET archived=? WHERE id=?').run(archived ? 1 : 0, id);
        if (!archived) {
          this.db
            .prepare("INSERT INTO meta(key,value) VALUES('active_chat_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
            .run(String(id));
        } else {
          this.ensureDefaultChat();
        }
        this.bumpChatRev();
        return this.db.prepare('SELECT * FROM chats WHERE id=?').get(id) as ChatRow;
      })
      .immediate();
  }

  pinChat(id: number, pinned: boolean): ChatRow {
    if (!Number.isInteger(id) || id <= 0) throw new Error('invalid chat id');
    return this.db
      .transaction(() => {
        const row = this.db.prepare('SELECT * FROM chats WHERE id=?').get(id) as ChatRow | undefined;
        if (!row) throw new Error('chat not found');
        this.db.prepare('UPDATE chats SET pinned=? WHERE id=?').run(pinned ? 1 : 0, id);
        this.bumpChatRev();
        return this.db.prepare('SELECT * FROM chats WHERE id=?').get(id) as ChatRow;
      })
      .immediate();
  }

  postNotice(agent: string, text: string): number {
    return this.addEvent({ agent, type: 'system', text });
  }

  branchChat(fromEventId?: number): ChatRow {
    const parentId = this.activeChatId();
    const now = this.clock();
    return this.db
      .transaction(() => {
        const parent = this.db.prepare('SELECT * FROM chats WHERE id=?').get(parentId) as ChatRow | undefined;
        const baseTitle = parent?.title || 'Chat';
        const title = ('Branch \u00b7 ' + baseTitle).slice(0, 60);
        const total = (this.db.prepare('SELECT COUNT(*) AS c FROM chats').get() as { c: number }).c;
        if (total >= MAX_CONVERSATIONS) throw new Error('conversation limit reached');
        const info = this.db
          .prepare('INSERT INTO chats(title,created_at,updated_at,cleared_at,incognito,participants) VALUES(?,?,?,?,0,?)')
          .run(title, now, now, 0, parent?.participants ?? null);
        const newId = Number(info.lastInsertRowid);
        const rows = (
          fromEventId !== undefined
            ? this.db.prepare('SELECT * FROM events WHERE chat_id=? AND id<=? ORDER BY id').all(parentId, fromEventId)
            : this.db.prepare('SELECT * FROM events WHERE chat_id=? ORDER BY id').all(parentId)
        ) as EventRow[];
        const ins = this.db.prepare(
          `INSERT INTO events(ts,agent,type,action,file,text,to_agent,reply_to,added,removed,image,chat_id)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        );
        for (const r of rows) {
          ins.run(r.ts, r.agent, r.type, r.action ?? null, r.file ?? null, r.text, r.to_agent ?? null, r.reply_to ?? null, r.added ?? 0, r.removed ?? 0, r.image ?? null, newId);
        }
        this.db
          .prepare("INSERT INTO meta(key,value) VALUES('active_chat_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .run(String(newId));
        this.bumpChatRev();
        return this.db
          .prepare('SELECT c.*, (SELECT COUNT(*) FROM events e WHERE e.chat_id=c.id) AS event_count FROM chats c WHERE c.id=?')
          .get(newId) as ChatRow;
      })
      .immediate();
  }

  deleteAllArchivedChats(): number {
    return this.db
      .transaction(() => {
        const rows = this.db.prepare('SELECT id FROM chats WHERE archived=1').all() as Array<{ id: number }>;
        for (const r of rows) this.db.prepare('DELETE FROM events WHERE chat_id=?').run(r.id);
        const info = this.db.prepare('DELETE FROM chats WHERE archived=1').run();
        this.ensureDefaultChat();
        this.bumpChatRev();
        return info.changes;
      })
      .immediate();
  }

  chatRev(): number {
    const r = this.db.prepare("SELECT value FROM meta WHERE key='chat_rev'").get() as { value: string } | undefined;
    return Number(r?.value ?? 0) || 0;
  }

  private bumpChatRev(): void {
    const next = this.chatRev() + 1;
    this.db
      .prepare("INSERT INTO meta(key,value) VALUES('chat_rev',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(String(next));
  }

  forceUnlock(rawFile: string): boolean {
    const file = this.file(rawFile);
    return this.db
      .transaction(() => {
        const row = this.db.prepare('SELECT * FROM locks WHERE file=?').get(file) as LockRow | undefined;
        if (!row) return false;
        this.dropLock(row);
        this.addEvent({ agent: 'system', type: 'system', file, text: `human force-unlocked ${file} (was ${row.agent})` });
        return true;
      })
      .immediate();
  }

  clearAgents(): number {
    return this.db
      .transaction(() => {
        const info = this.db.prepare("DELETE FROM agents WHERE name != 'human'").run();
        return info.changes;
      })
      .immediate();
  }

  resolveCommand(
    id: number,
    decision: 'allow' | 'deny' | 'always',
  ): { status: CommandStatus; eventId?: number } {
    if (!Number.isInteger(id) || id <= 0) throw new Error('invalid command id');
    if (decision !== 'allow' && decision !== 'deny' && decision !== 'always') {
      throw new Error('decision must be allow, deny, or always');
    }
    return this.db
      .transaction(() => {
        const cmd = this.db.prepare('SELECT * FROM commands WHERE id=?').get(id) as CommandRow | undefined;
        if (!cmd) throw new Error('command not found');
        if (cmd.status !== 'pending') throw new Error(`command already ${cmd.status}`);
        if (decision === 'deny') {
          this.db.prepare("UPDATE commands SET status='denied' WHERE id=?").run(id);
          this.addEvent({
            agent: 'system',
            type: 'system',
            text: `human denied command from ${cmd.from_agent} to ${cmd.to_agent}`,
          });
          return { status: 'denied' as const };
        }
        if (decision === 'always') {
          this.db
            .prepare('INSERT OR REPLACE INTO trusted_agents(agent,ts) VALUES(?,?)')
            .run(cmd.from_agent, this.clock());
        }
        this.db.prepare("UPDATE commands SET status='approved' WHERE id=?").run(id);
        const eventId = this.addEvent({
          agent: cmd.from_agent,
          type: 'command',
          to: cmd.to_agent,
          text: cmd.command,
        });
        return { status: 'approved' as const, eventId };
      })
      .immediate();
  }

  revokeTrustedAgent(rawAgent: string): boolean {
    const agent = normalizeAgent(rawAgent);
    const info = this.db.prepare('DELETE FROM trusted_agents WHERE agent=?').run(agent);
    return info.changes > 0;
  }

  pendingCommands(): CommandRow[] {
    return this.db.prepare("SELECT * FROM commands WHERE status='pending' ORDER BY id").all() as CommandRow[];
  }

  trustedAgents(): string[] {
    return (this.db.prepare('SELECT agent FROM trusted_agents ORDER BY agent').all() as { agent: string }[]).map(
      (r) => r.agent,
    );
  }

  queueResearch(input: { from?: string; query: string }): {
    id: number;
    askEventId: number;
    from: string;
    query: string;
  } {
    const from = normalizeAgent(input.from);
    const { text } = capWords(input.query, CMD_MAX_WORDS);
    if (!text) throw new Error('query is empty');
    return this.db
      .transaction(() => {
        this.ensureAgent(from);
        this.ensureAgent('perplexity');
        const askEventId = this.addEvent({ agent: from, type: 'ask', to: 'perplexity', text });
        const info = this.db
          .prepare("INSERT INTO research_requests(ts,from_agent,query,ask_event_id,status) VALUES(?,?,?,?,'pending')")
          .run(this.clock(), from, text, askEventId);
        return { id: Number(info.lastInsertRowid), askEventId, from, query: text };
      })
      .immediate();
  }

  completeResearch(id: number, report: string): { eventId: number } {
    if (!Number.isInteger(id) || id <= 0) throw new Error('invalid research id');
    const { text } = capWords(report, CMD_MAX_WORDS);
    if (!text) throw new Error('report is empty');
    return this.db
      .transaction(() => {
        const req = this.db.prepare('SELECT * FROM research_requests WHERE id=?').get(id) as ResearchRow | undefined;
        if (!req) throw new Error('research request not found');
        if (req.status !== 'pending') throw new Error(`research already ${req.status}`);
        this.ensureAgent('perplexity');
        this.db.prepare("UPDATE research_requests SET status='done' WHERE id=?").run(id);
        this.db.prepare('UPDATE agents SET last_summary=? WHERE name=?').run(text, 'perplexity');
        const eventId = this.addEvent({
          agent: 'perplexity',
          type: 'ask',
          to: req.from_agent,
          replyTo: req.ask_event_id,
          text,
        });
        return { eventId };
      })
      .immediate();
  }

  pendingResearch(): ResearchRow[] {
    return this.db.prepare("SELECT * FROM research_requests WHERE status='pending' ORDER BY id").all() as ResearchRow[];
  }

  // ---------- meeting room ("Toplantı Masası") ----------

  getMeeting(): MeetingState | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key='active_meeting'").get() as { value: string } | undefined;
    if (!row?.value) return null;
    try {
      return JSON.parse(row.value) as MeetingState;
    } catch {
      return null;
    }
  }

  private saveMeeting(mt: MeetingState | null): void {
    if (!mt) {
      this.db.prepare("DELETE FROM meta WHERE key='active_meeting'").run();
    } else {
      this.db
        .prepare("INSERT INTO meta(key,value) VALUES('active_meeting',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(JSON.stringify(mt));
    }
    this.bumpChatRev();
  }

  getMeetingProposal(): MeetingProposal | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key='meeting_proposal'").get() as { value: string } | undefined;
    if (!row?.value) return null;
    try {
      return JSON.parse(row.value) as MeetingProposal;
    } catch {
      return null;
    }
  }

  private saveMeetingProposal(p: MeetingProposal | null): void {
    if (!p) {
      this.db.prepare("DELETE FROM meta WHERE key='meeting_proposal'").run();
    } else {
      this.db
        .prepare("INSERT INTO meta(key,value) VALUES('meeting_proposal',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(JSON.stringify(p));
    }
    this.bumpChatRev();
  }

  proposeMeeting(input: { by?: string; reason: string }): string {
    const by = normalizeAgent(input.by);
    const { text } = capWords(input.reason, 60);
    if (!text) throw new Error('reason is empty');
    return this.db
      .transaction(() => {
        this.ensureAgent(by);
        const existing = this.getMeeting();
        if (existing && existing.status === 'active') {
          return `MEETING ALREADY ACTIVE: "${existing.title}"` + this.digest(by);
        }
        const proposal: MeetingProposal = { by, reason: text, ts: this.clock() };
        this.saveMeetingProposal(proposal);
        this.addEvent({ agent: by, type: 'system', to: 'human', text: `Meeting proposed: ${text}` });
        return `PROPOSED meeting (${text}) awaiting human confirmation` + this.digest(by);
      })
      .immediate();
  }

  dismissMeetingProposal(): void {
    this.saveMeetingProposal(null);
  }

  startMeeting(input?: { startedBy?: string; title?: string; connectedAgents?: string[] }): MeetingState {
    const startedBy = input?.startedBy === 'human' ? 'human' : normalizeAgent(input?.startedBy ?? 'human');
    const cleanTitle = (input?.title ?? '').trim().slice(0, 80);
    const proposal = this.getMeetingProposal();
    const title = cleanTitle || proposal?.reason?.slice(0, 80) || 'Team Strategy Meeting';
    return this.db
      .transaction(() => {
        const current = this.getMeeting();
        if (current && current.status === 'active') return current;
        const now = this.clock();
        const connected = input?.connectedAgents
          ? [...new Set(input.connectedAgents.map((a) => normalizeAgent(a)).filter((a) => a !== 'human'))]
          : (this.db.prepare("SELECT * FROM agents WHERE name!='human' ORDER BY first_seen").all() as AgentRow[])
              .filter((a) => now - a.last_seen < IDLE_MS)
              .map((a) => a.name);
        const mt: MeetingState = {
          id: `mtg-${now}`,
          title,
          startedBy,
          startedAt: now,
          status: 'active',
          seats: shuffleSeats(connected),
          floorAgent: null,
          handsRaised: [],
          mutedAgents: [],
          deafAgents: [],
          messages: [],
          notes: [],
        };
        this.saveMeeting(mt);
        this.saveMeetingProposal(null);
        this.ensureAgent('human');
        this.addEvent({ agent: startedBy, type: 'system', text: `Opened meeting table: ${title}` });
        return mt;
      })
      .immediate();
  }

  private requireActiveMeeting(): MeetingState {
    const mt = this.getMeeting();
    if (!mt || mt.status !== 'active') throw new Error('no active meeting');
    return mt;
  }

  meetingRaiseHand(input: { agent: string; reason?: string }): MeetingState {
    const agent = normalizeAgent(input.agent);
    const { text: reason } = capWords(input.reason ?? '', 25);
    return this.db
      .transaction(() => {
        this.ensureAgent(agent);
        const mt = this.requireActiveMeeting();
        if (mt.deafAgents.includes(agent)) throw new Error('agent is not included in this meeting');
        if (mt.mutedAgents.includes(agent)) throw new Error('agent is muted');
        if (mt.floorAgent === agent) return mt;
        const idx = mt.handsRaised.findIndex((h) => h.agent === agent);
        const entry = { agent, reason: reason || undefined, ts: this.clock() };
        if (idx >= 0) mt.handsRaised[idx] = entry;
        else mt.handsRaised.push(entry);
        this.saveMeeting(mt);
        return mt;
      })
      .immediate();
  }

  meetingGrantFloor(agentRaw: string | null): MeetingState {
    return this.db
      .transaction(() => {
        const mt = this.requireActiveMeeting();
        if (!agentRaw) {
          mt.floorAgent = null;
          this.saveMeeting(mt);
          return mt;
        }
        const agent = normalizeAgent(agentRaw);
        if (mt.deafAgents.includes(agent)) throw new Error('agent is hidden from meeting');
        if (mt.mutedAgents.includes(agent)) throw new Error('agent is muted');
        mt.floorAgent = agent;
        mt.handsRaised = mt.handsRaised.filter((h) => h.agent !== agent);
        this.saveMeeting(mt);
        return mt;
      })
      .immediate();
  }

  meetingSpeak(input: { from: string; text: string }): { meeting: MeetingState; messageId: number } {
    const isHuman = input.from.trim().toLowerCase() === 'human';
    const from = isHuman ? 'human' : normalizeAgent(input.from);
    const { text } = capWords(input.text, 120);
    if (!text) throw new Error('message is empty');
    return this.db
      .transaction(() => {
        this.ensureAgent(from);
        const mt = this.requireActiveMeeting();
        if (!isHuman) {
          if (mt.deafAgents.includes(from)) throw new Error('agent is excluded from meeting');
          if (mt.mutedAgents.includes(from)) throw new Error('agent is muted');
          if (mt.floorAgent !== from) {
            throw new Error('you do not have the floor; raise hand first and wait for human permission');
          }
          mt.floorAgent = null;
          mt.handsRaised = mt.handsRaised.filter((h) => h.agent !== from);
        }
        const messageId = (mt.messages[mt.messages.length - 1]?.id ?? 0) + 1;
        mt.messages.push({ id: messageId, from, text, ts: this.clock() });
        this.saveMeeting(mt);
        return { meeting: mt, messageId };
      })
      .immediate();
  }

  meetingToggleMute(agentRaw: string, muted?: boolean): MeetingState {
    const agent = normalizeAgent(agentRaw);
    return this.db
      .transaction(() => {
        const mt = this.requireActiveMeeting();
        const isMuted = mt.mutedAgents.includes(agent);
        const next = muted !== undefined ? muted : !isMuted;
        if (next && !isMuted) mt.mutedAgents.push(agent);
        if (!next) mt.mutedAgents = mt.mutedAgents.filter((a) => a !== agent);
        if (next) {
          mt.handsRaised = mt.handsRaised.filter((h) => h.agent !== agent);
          if (mt.floorAgent === agent) mt.floorAgent = null;
        }
        this.saveMeeting(mt);
        return mt;
      })
      .immediate();
  }

  meetingToggleDeaf(agentRaw: string, deaf?: boolean): MeetingState {
    const agent = normalizeAgent(agentRaw);
    return this.db
      .transaction(() => {
        const mt = this.requireActiveMeeting();
        const isDeaf = mt.deafAgents.includes(agent);
        const next = deaf !== undefined ? deaf : !isDeaf;
        if (next && !isDeaf) mt.deafAgents.push(agent);
        if (!next) mt.deafAgents = mt.deafAgents.filter((a) => a !== agent);
        if (next) {
          mt.handsRaised = mt.handsRaised.filter((h) => h.agent !== agent);
          if (mt.floorAgent === agent) mt.floorAgent = null;
        }
        this.saveMeeting(mt);
        return mt;
      })
      .immediate();
  }

  meetingAcceptNote(messageId: number): MeetingState {
    if (!Number.isInteger(messageId) || messageId <= 0) throw new Error('invalid message id');
    return this.db
      .transaction(() => {
        const mt = this.requireActiveMeeting();
        const msg = mt.messages.find((m) => m.id === messageId);
        if (!msg) throw new Error('meeting message not found');
        if (!msg.accepted) {
          msg.accepted = true;
          const noteId = (mt.notes[mt.notes.length - 1]?.id ?? 0) + 1;
          mt.notes.push({ id: noteId, author: msg.from, text: msg.text, ts: this.clock() });
        }
        mt.savedFile = saveMeetingMarkdown(this.root, mt);
        this.saveMeeting(mt);
        return mt;
      })
      .immediate();
  }

  meetingAddNote(input: { author?: string; text: string }): MeetingState {
    const author = input.author === 'human' || !input.author ? 'human' : normalizeAgent(input.author);
    const { text } = capWords(input.text, 120);
    if (!text) throw new Error('note is empty');
    return this.db
      .transaction(() => {
        const mt = this.requireActiveMeeting();
        const noteId = (mt.notes[mt.notes.length - 1]?.id ?? 0) + 1;
        mt.notes.push({ id: noteId, author, text, ts: this.clock() });
        mt.savedFile = saveMeetingMarkdown(this.root, mt);
        this.saveMeeting(mt);
        return mt;
      })
      .immediate();
  }

  endMeeting(): MeetingState | null {
    return this.db
      .transaction(() => {
        const mt = this.getMeeting();
        if (!mt) return null;
        mt.status = 'ended';
        mt.endedAt = this.clock();
        mt.floorAgent = null;
        mt.handsRaised = [];
        if (mt.notes.length > 0 || mt.messages.length > 0) {
          mt.savedFile = saveMeetingMarkdown(this.root, mt);
        }
        this.saveMeeting(null);
        this.addEvent({
          agent: 'human',
          type: 'system',
          text: `Ended meeting "${mt.title}"${mt.savedFile ? ` (notes: ${mt.savedFile})` : ''}`,
        });
        return mt;
      })
      .immediate();
  }

  listMeetingNotes(): MeetingFileInfo[] {
    return listMeetingFiles(this.root);
  }

  readMeetingNote(file: string): string | null {
    return readMeetingFile(this.root, file);
  }

  // ---------- read side for the dashboard ----------

  state(): StateSnapshot {
    const now = this.clock();
    const locks = this.activeLocks();
    const holders = new Set(locks.map((l) => l.agent));
    const agents = (this.db.prepare("SELECT * FROM agents WHERE name!='human' ORDER BY first_seen").all() as AgentRow[]).map(
      (a): AgentView => {
        const age = now - a.last_seen;
        const status: AgentStatus =
          holders.has(a.name) || age < WORKING_MS ? 'working' : age < IDLE_MS ? 'idle' : 'offline';
        return { ...a, status };
      },
    );
    return {
      agents,
      locks,
      pendingCommands: this.pendingCommands(),
      trustedAgents: this.trustedAgents(),
      pendingResearch: this.pendingResearch(),
      pausedAgents: this.pausedAgents(),
      roles: this.listRoles(),
      chats: this.listChats(),
      activeChatId: this.activeChatId(),
      meeting: this.getMeeting(),
      meetingProposal: this.getMeetingProposal(),
      lastId: this.maxId(),
      now,
    };
  }

  eventsSince(afterId: number, limit = 500): EventRow[] {
    const chatId = this.activeChatId();
    return this.db
      .prepare('SELECT * FROM events WHERE chat_id=? AND id>? ORDER BY id LIMIT ?')
      .all(chatId, afterId, limit) as EventRow[];
  }

  recentEvents(limit = 100): EventRow[] {
    const chatId = this.activeChatId();
    return (
      this.db.prepare('SELECT * FROM events WHERE chat_id=? ORDER BY id DESC LIMIT ?').all(chatId, limit) as EventRow[]
    ).reverse();
  }

  hasExpiredLocks(): boolean {
    return !!this.db.prepare('SELECT 1 FROM locks WHERE expires_at <= ? LIMIT 1').get(this.clock());
  }

  maxDiffId(): number {
    return (this.db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM diffs').get() as { m: number }).m;
  }

  /** Latest diffs of one file, newest first, with patches (for the code preview). */
  diffsForFile(rawFile: string, limit = 5): DiffRow[] {
    return this.db
      .prepare('SELECT * FROM diffs WHERE file=? ORDER BY id DESC LIMIT ?')
      .all(this.file(rawFile), limit) as DiffRow[];
  }

  /** Diff metadata without patches. */
  diffsSince(afterId: number, limit = 100): DiffInfo[] {
    return this.db
      .prepare('SELECT id,ts,agent,file,added,removed FROM diffs WHERE id>? ORDER BY id LIMIT ?')
      .all(afterId, limit) as DiffInfo[];
  }

  recentDiffs(limit = 30): DiffInfo[] {
    return (
      this.db
        .prepare('SELECT id,ts,agent,file,added,removed FROM diffs ORDER BY id DESC LIMIT ?')
        .all(limit) as DiffInfo[]
    ).reverse();
  }

  // ---------- summary language (agents are told via read_feed) ----------

  getLang(): string {
    const r = this.db.prepare("SELECT value FROM meta WHERE key='lang'").get() as { value: string } | undefined;
    return r?.value ?? 'en';
  }

  setLang(lang: string): void {
    const l = lang.trim().toLowerCase();
    if (!/^[a-z]{2,3}(-[a-z]{2,4})?$/.test(l)) throw new Error('invalid language code');
    this.db
      .prepare("INSERT INTO meta(key,value) VALUES('lang',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(l);
  }
}
