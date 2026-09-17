/**
 * 数据访问层。整个应用只有这里直接接触 node:sqlite，
 * 便于日后替换（该模块目前是实验性接口，见 docs/adr/0001）。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

export const DB_PATH = process.env.RILI_DB || join(ROOT, 'data', 'rili.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN ('user','manager','admin')),
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS registration_requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  note          TEXT    NOT NULL DEFAULT '',
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT    PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL,
  expires_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);

CREATE TABLE IF NOT EXISTS items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id    INTEGER NOT NULL REFERENCES accounts(id),
  title       TEXT    NOT NULL,
  event_date  TEXT    NOT NULL,
  due_date    TEXT    NOT NULL,
  tag         TEXT,
  color       INTEGER NOT NULL,
  archived_at TEXT,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  CHECK (due_date >= event_date),
  CHECK (color >= 0 AND color <= 11),
  CHECK (length(trim(title)) > 0)
);
CREATE INDEX IF NOT EXISTS idx_items_owner    ON items(owner_id);
CREATE INDEX IF NOT EXISTS idx_items_span     ON items(event_date, due_date);
CREATE INDEX IF NOT EXISTS idx_items_archived ON items(archived_at);
`);

/** 一次性执行写事务。回调内抛错即整体回滚。 */
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 回滚失败时不掩盖原始错误 */
    }
    throw err;
  }
}

/** 账号名是否已被账号表占用（大小写不敏感）。 */
export function usernameTaken(username) {
  return !!db
    .prepare('SELECT 1 FROM accounts WHERE username = ? COLLATE NOCASE')
    .get(username);
}
