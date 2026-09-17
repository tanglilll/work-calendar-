/**
 * 数据访问的入口：打开数据库、建表、提供事务。
 *
 * 这里**不创建**连接——路径由组合根（server/app.js）决定，因此测试可以指向
 * ':memory:' 拿到一套全新实例，而不必依赖进程级环境变量。打开即建表，
 * 所以拿到 store 就能直接用。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
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
`;

/**
 * 打开一个 store。path 传 ':memory:' 即得到内存库（node:sqlite 自带，无需任何依赖）。
 */
export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);

  return {
    db,
    path,
    /** 一次性执行写事务。回调内抛错即整体回滚。 */
    tx(fn) {
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
    },
    close() {
      db.close();
    },
  };
}
