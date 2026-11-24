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
  removed INTEGER NOT NULL DEFAULT 0
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
`;

export const SCHEMA_VERSION = 2;

/** Open (and migrate) the Synergy database. Use ':memory:' for tests. */
export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);
  db.prepare(
    "INSERT INTO meta(key,value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(String(SCHEMA_VERSION));
  return db;
}
