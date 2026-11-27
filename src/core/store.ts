import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agents(
  name TEXT PRIMARY KEY,
  display TEXT NOT NULL,
  kind TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  last_file TEXT,
  last_summary TEXT,
  read_cursor INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  agent TEXT NOT NULL,
  type TEXT NOT NULL,
  action TEXT,
  file TEXT,
  text TEXT NOT NULL DEFAULT '',
  to_agent TEXT,
  reply_to INTEGER,
  added INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  chat_id INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE TABLE IF NOT EXISTS locks(
  file TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  ts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots(
  file TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  content TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS diffs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  agent TEXT NOT NULL,
  file TEXT NOT NULL,
  added INTEGER NOT NULL,
  removed INTEGER NOT NULL,
  patch TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS diffs_file ON diffs(file, id);
CREATE TABLE IF NOT EXISTS commands(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  command TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS commands_status ON commands(status, id);
CREATE TABLE IF NOT EXISTS trusted_agents(
  agent TEXT PRIMARY KEY,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS research_requests(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  from_agent TEXT NOT NULL,
  query TEXT NOT NULL,
  ask_event_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS research_status ON research_requests(status, id);
CREATE TABLE IF NOT EXISTS paused_agents(
  agent TEXT PRIMARY KEY,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS roles(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  agent TEXT,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chats(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  cleared_at INTEGER NOT NULL DEFAULT 0,
  incognito INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  participants TEXT,
  named_by TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  live_sessions TEXT
);
`;

export const SCHEMA_VERSION = 13;

/** Open (and migrate) the Synergy database. Use ':memory:' for tests. */
export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);
  const cols = db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'image')) db.exec('ALTER TABLE events ADD COLUMN image TEXT');
  if (!cols.some((c) => c.name === 'chat_id')) db.exec('ALTER TABLE events ADD COLUMN chat_id INTEGER NOT NULL DEFAULT 1');
  const chatCols = db.prepare('PRAGMA table_info(chats)').all() as Array<{ name: string }>;
  if (!chatCols.some((c) => c.name === 'archived')) db.exec('ALTER TABLE chats ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
  if (!chatCols.some((c) => c.name === 'cleared_at')) db.exec('ALTER TABLE chats ADD COLUMN cleared_at INTEGER NOT NULL DEFAULT 0');
  if (!chatCols.some((c) => c.name === 'incognito')) db.exec('ALTER TABLE chats ADD COLUMN incognito INTEGER NOT NULL DEFAULT 0');
  if (!chatCols.some((c) => c.name === 'expires_at')) db.exec('ALTER TABLE chats ADD COLUMN expires_at INTEGER');
  if (!chatCols.some((c) => c.name === 'participants')) db.exec('ALTER TABLE chats ADD COLUMN participants TEXT');
  if (!chatCols.some((c) => c.name === 'named_by')) db.exec('ALTER TABLE chats ADD COLUMN named_by TEXT');
  if (!chatCols.some((c) => c.name === 'pinned')) db.exec('ALTER TABLE chats ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
  if (!chatCols.some((c) => c.name === 'live_sessions')) db.exec('ALTER TABLE chats ADD COLUMN live_sessions TEXT');
  db.prepare(
    "INSERT INTO meta(key,value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(String(SCHEMA_VERSION));
  return db;
}
