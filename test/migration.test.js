/**
 * 老库迁移。这是本次唯一近乎不可逆的操作，必须有回归网：
 * 带上 owner_id 的旧库要能回填成 owner 名单、一条事项都不能少，而且再开一次不再迁。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../server/db.js';

/** 造一个老形状的库：items 直接挂 owner_id，没有名单表、没有进展列。 */
function oldShapeDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user','manager','admin')),
      created_at TEXT NOT NULL
    );
    CREATE TABLE items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL REFERENCES accounts(id),
      title TEXT NOT NULL,
      event_date TEXT NOT NULL,
      due_date TEXT NOT NULL,
      tag TEXT,
      color INTEGER NOT NULL,
      archived_at TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (due_date >= event_date),
      CHECK (color >= 0 AND color <= 11),
      CHECK (length(trim(title)) > 0)
    );
    INSERT INTO accounts (username, password_hash, role, created_at) VALUES
      ('admin', 'x', 'admin', '2026-01-01'),
      ('zhao',  'x', 'user',  '2026-01-01'),
      ('lin',   'x', 'user',  '2026-01-01');
    INSERT INTO items (owner_id, title, event_date, due_date, tag, color, archived_at, version, created_at, updated_at) VALUES
      (2, '老事项A', '2026-09-01', '2026-09-02', '工作', 0, NULL,       1, '2026-01-01', '2026-01-01'),
      (3, '老事项B', '2026-09-03', '2026-09-03', NULL,   1, '2026-02-01', 3, '2026-01-01', '2026-02-01');
  `);
  db.close();
}

/** 临时库房：Windows 上句柄没释放时目录删不掉，所以清理要容错，别掩盖真正的断言错误。 */
function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rili-migration-'));
  const opened = [];
  const track = (store) => {
    opened.push(store);
    return store;
  };
  try {
    fn(join(dir, 'db.sqlite'), track);
  } finally {
    for (const store of opened) {
      try {
        store.close();
      } catch {
        /* 已经关过了 */
      }
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 句柄未释放时删不掉，留个临时目录无妨，绝不能因此盖住断言失败 */
    }
  }
}

test('老库迁移：归属回填成名单，事项一条不少，再开一次不再迁', () => {
  withTempDir((path, track) => {
    oldShapeDb(path);

    // —— 第一次打开：应当迁移 ——
    const store = track(openDb(path));
    assert.equal(store.migration.migrated, true, '第一次打开应当执行迁移');
    assert.equal(store.migration.items, 2, '两条事项都要走这一趟');

    const columns = store.db.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
    assert.ok(!columns.includes('owner_id'), '旧列应当被去掉，避免出现两个真相来源');
    assert.ok(columns.includes('progress'), '后加的列也要在迁移后的表上');

    const items = store.db.prepare('SELECT id, title, version, archived_at FROM items ORDER BY id').all();
    assert.deepEqual(
      items.map((i) => i.title),
      ['老事项A', '老事项B'],
      '一条都不能丢',
    );
    assert.equal(items[0].version, 1, '版本号保持原样');
    assert.equal(items[1].archived_at, '2026-02-01', '归档状态保持原样');

    // 用字符串归一化再比：node:sqlite 返回的行不是普通对象，直接 deepEqual 会因
    // 原型或数值类型不同而失败，且失败信息看起来和大括号里的内容一模一样。
    const members = store.db
      .prepare('SELECT item_id, account_id FROM item_owners ORDER BY item_id')
      .all()
      .map((m) => `${m.item_id}:${m.account_id}`);
    assert.deepEqual(members, ['1:2', '2:3'], '归属要原样回填进名单表');
    store.close();

    // —— 第二次打开：不该再迁，数据也不动 ——
    const again = track(openDb(path));
    assert.equal(again.migration.migrated, false, '第二次打开不该重复迁移');
    assert.equal(again.db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 2);
    assert.equal(again.db.prepare('SELECT COUNT(*) AS n FROM item_owners').get().n, 2);
    assert.equal(again.db.prepare('SELECT title FROM items WHERE id = 1').get().title, '老事项A');
  });
});

test('新库不需要迁移', () => {
  withTempDir((path, track) => {
    const store = track(openDb(path));
    assert.equal(store.migration.migrated, false);
    const columns = store.db.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
    assert.ok(columns.includes('progress'));
    assert.ok(!columns.includes('owner_id'));
  });
});
