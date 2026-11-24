import { describeAgent, normalizeAgent } from './agents';
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
  AgentStatus,
  AgentView,
  EventRow,
  EventType,
  LockRow,
  StateSnapshot,
} from './types';

export interface SynergyOptions {
  root: string;
  clock?: () => number;
  lockTtlMs?: number;
  maxEvents?: number;
}

const ASK_MAX_WORDS = 40;
const DIGEST_MAX = 10;
const WORKING_MS = 60_000;
const IDLE_MS = 15 * 60_000;

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
    this.prune();
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
    const info = this.db
      .prepare(
        `INSERT INTO events(ts,agent,type,action,file,text,to_agent,reply_to,added,removed)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        this.clock(),
        e.agent,
        e.type,
        e.action ?? null,
        e.file ?? null,
        e.text ?? '',
        e.to ?? null,
        e.replyTo ?? null,
        e.added ?? 0,
        e.removed ?? 0,
      );
    const id = Number(info.lastInsertRowid);
    if (id % 500 === 0) this.prune();
    return id;
  }

  prune(): void {
    this.db
      .prepare('DELETE FROM events WHERE id <= (SELECT COALESCE(MAX(id),0) FROM events) - ?')
      .run(this.maxEvents);
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
        this.db.prepare('DELETE FROM locks WHERE file=?').run(l.file);
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
    const where = `id>? AND agent!=? AND (to_agent IS NULL OR to_agent IN (?, 'all'))`;
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM events WHERE ${where}`).get(cursor, agent, agent) as {
        c: number;
      }
    ).c;
    const rows = (
      this.db
        .prepare(`SELECT * FROM events WHERE ${where} ORDER BY id DESC LIMIT ?`)
        .all(cursor, agent, agent, DIGEST_MAX) as EventRow[]
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
    const added = Math.max(0, Math.trunc(input.added ?? 0));
    const removed = Math.max(0, Math.trunc(input.removed ?? 0));

    return this.db
      .transaction(() => {
        this.ensureAgent(agent);
        this.sweepLocks();
        const id = this.addEvent({ agent, type: 'status', action, file, text, added, removed });
        this.db
          .prepare(
            'UPDATE agents SET last_file=?, last_summary=?, added=added+?, removed=removed+? WHERE name=?',
          )
          .run(file, text, added, removed, agent);
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
          out = `OK ${file} renewed ${ttlMin}m`;
        } else {
          this.db
            .prepare('INSERT INTO locks(file,agent,ts,expires_at) VALUES(?,?,?,?)')
            .run(file, agent, now, now + this.lockTtlMs);
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
          this.db.prepare('DELETE FROM locks WHERE file=?').run(file);
          this.addEvent({ agent, type: 'unlock', file });
          out = `OK ${file} unlocked`;
        }
        return out + this.digest(agent);
      })
      .immediate();
  }

  askAgent(input: { from?: string; to: string; question: string; replyTo?: number }): string {
    const from = normalizeAgent(input.from);
    const to = input.to.trim().toLowerCase() === 'all' ? 'all' : normalizeAgent(input.to);
    const { text, trimmed } = capWords(input.question, ASK_MAX_WORDS);
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

  readFeed(input: { agent?: string; limit?: number }): string {
    const agent = normalizeAgent(input.agent);
    const limit = Math.min(50, Math.max(1, Math.trunc(input.limit ?? 10)));
    return this.db
      .transaction(() => {
        this.ensureAgent(agent);
        this.sweepLocks();
        const rows = (
          this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit) as EventRow[]
        ).reverse();
        this.db.prepare('UPDATE agents SET read_cursor=? WHERE name=?').run(this.maxId(), agent);
        const now = this.clock();
        const feed = rows.length ? rows.map((r) => formatEvent(r, now)).join('\n') : 'FEED: empty';
        return `${feed}\n${formatLocks(this.activeLocks(), now)}`;
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
          this.db.prepare('DELETE FROM locks WHERE file=?').run(l.file);
          this.addEvent({ agent: name, type: 'unlock', file: l.file });
        }
        return rows.length;
      })
      .immediate();
  }

  // ---------- human / dashboard operations ----------

  /** Plain text broadcasts; `@agent text` is directed; `/lock f` and `/unlock f` manage locks. */
  humanSend(raw: string): { id: number } {
    const msg = raw.trim().slice(0, MAX_HUMAN_CHARS);
    if (!msg) throw new Error('message is empty');
    const cmd = msg.match(/^\/(lock|unlock)\s+(.+)$/i);
    if (cmd) {
      const file = this.file(cmd[2]);
      if (cmd[1].toLowerCase() === 'unlock') {
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
    const mention = msg.match(/^@(\S+)\s+([\s\S]+)$/);
    return this.db
      .transaction(() => {
        this.ensureAgent('human');
        const to = mention ? (mention[1].toLowerCase() === 'all' ? 'all' : normalizeAgent(mention[1])) : null;
        const text = mention ? mention[2].trim() : msg;
        return { id: this.addEvent({ agent: 'human', type: 'human', text, to }) };
      })
      .immediate();
  }

  forceUnlock(rawFile: string): boolean {
    const file = this.file(rawFile);
    return this.db
      .transaction(() => {
        const row = this.db.prepare('SELECT * FROM locks WHERE file=?').get(file) as LockRow | undefined;
        if (!row) return false;
        this.db.prepare('DELETE FROM locks WHERE file=?').run(file);
        this.addEvent({ agent: 'system', type: 'system', file, text: `human force-unlocked ${file} (was ${row.agent})` });
        return true;
      })
      .immediate();
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
    return { agents, locks, lastId: this.maxId(), now };
  }

  eventsSince(afterId: number, limit = 500): EventRow[] {
    return this.db
      .prepare('SELECT * FROM events WHERE id>? ORDER BY id LIMIT ?')
      .all(afterId, limit) as EventRow[];
  }

  recentEvents(limit = 100): EventRow[] {
    return (
      this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit) as EventRow[]
    ).reverse();
  }
}
