/**
 * 数据访问的入口：打开数据库、建表、提供事务、迁移老库。
 *
 * 这里**不创建**连接——路径由组合根（server/app.js）决定，因此测试可以指向
 * ':memory:' 拿到一套全新实例，而不必依赖进程级环境变量。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** items 的定义。owner 不在这一行上——见下面的 item_owners。 */
const ITEMS_TABLE = `
CREATE TABLE IF NOT EXISTS items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  event_date  TEXT    NOT NULL,
  due_date    TEXT    NOT NULL,
  tag         TEXT,
  color       INTEGER NOT NULL,
  archived_at TEXT,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  progress    TEXT,
  progress_updated_at TEXT,
  CHECK (due_date >= event_date),
  CHECK (color >= 0 AND color <= 11),
  CHECK (length(trim(title)) > 0)
)`;

const ITEMS_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_items_span     ON items(event_date, due_date);
CREATE INDEX IF NOT EXISTS idx_items_archived ON items(archived_at);
`;

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

${ITEMS_TABLE};

-- 事项的 owner 名单。成员之间并列、没有顺序语义（见 docs/adr/0002）。
CREATE TABLE IF NOT EXISTS item_owners (
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_item_owners_account ON item_owners(account_id);

-- 待接受的邀请。被邀请人还不是 owner，所以它自成一类：有自己的表和自己的读法。
CREATE TABLE IF NOT EXISTS item_invites (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  invited_by INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL,
  UNIQUE (item_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_item_invites_account ON item_invites(account_id);

${ITEMS_INDEXES}`;

/**
 * 老库迁移：items 曾经直接挂一个 owner_id。
 *
 * 幂等——迁过一次就不再动（判据是 items 里还有没有那一列）。
 * 先把归属读进内存，再重建表：重建之后那一列就不在了。
 */
function migrateToOwnerList(db) {
  const columns = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
  if (!columns.includes('owner_id')) return { migrated: false };

  const memberships = db.prepare('SELECT id, owner_id FROM items').all();

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(ITEMS_TABLE.replace('IF NOT EXISTS items', 'items_migrated'));
    db.exec(`INSERT INTO items_migrated
               (id, title, event_date, due_date, tag, color, archived_at, version, created_at, updated_at)
             SELECT id, title, event_date, due_date, tag, color, archived_at, version, created_at, updated_at
               FROM items`);
    db.exec('DROP TABLE items');
    db.exec('ALTER TABLE items_migrated RENAME TO items');
    db.exec(ITEMS_INDEXES);

    const insert = db.prepare('INSERT OR IGNORE INTO item_owners (item_id, account_id) VALUES (?, ?)');
    for (const row of memberships) insert.run(row.id, row.owner_id);

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 回滚失败时不掩盖原始错误 */
    }
    throw err;
  }

  return { migrated: true, items: memberships.length };
}

/**
 * 后加的列：已存在的库用 ALTER 补上（幂等）。SQLite 加可空列不必重建表。
 */
function ensureColumns(db) {
  const columns = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
  if (!columns.includes('progress')) {
    db.exec('ALTER TABLE items ADD COLUMN progress TEXT');
    db.exec('ALTER TABLE items ADD COLUMN progress_updated_at TEXT');
  }
}

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

  const migration = migrateToOwnerList(db);
  ensureColumns(db);

  return {
    db,
    path,
    migration,
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
