/**
 * 事项的读写与校验。可见性判据在 visibility.js，这里只调用它；
 * 路由层不自行拼 SQL、不自行比对角色。
 *
 * owner 是一个名单（见 docs/adr/0002）：成员并列、无主次。
 *
 * store 与 colors 由组合根注入 —— 这个 module 不再自己创建数据库连接。
 */
import { LIMITS, isValidDateString, isTagAllowed, TAGS } from './config.js';
import { canAccessItem, capabilitiesOf, ownerScope } from './visibility.js';
import { httpError } from './http.js';

const ITEM_COLUMNS = `
  i.id, i.title, i.event_date, i.due_date, i.tag, i.color,
  i.version, i.archived_at, i.created_at, i.updated_at,
  i.progress, i.progress_updated_at
`;

const FROM_ITEMS = 'FROM items i';

export function createItems(store, colors) {
  const { db, tx } = store;

  /** 一次把一批事项的 owner 名单捞出来，避免逐条查询。 */
  function withOwners(rows) {
    if (!rows.length) return rows;
    const marks = rows.map(() => '?').join(',');
    const members = db
      .prepare(
        `SELECT m.item_id, a.id, a.username
           FROM item_owners m JOIN accounts a ON a.id = m.account_id
          WHERE m.item_id IN (${marks})
          ORDER BY a.username ASC`,
      )
      .all(...rows.map((r) => r.id));

    const byItem = new Map();
    for (const m of members) {
      if (!byItem.has(m.item_id)) byItem.set(m.item_id, []);
      byItem.get(m.item_id).push({ id: m.id, username: m.username });
    }
    for (const row of rows) row.owners = byItem.get(row.id) ?? [];
    return rows;
  }

  const ownerIdsOf = (item) => item.owners.map((o) => o.id);

  /**
   * 变更描述：领域层只说「发生了什么、影响谁」，怎么送达由适配层决定。
   * 写操作一律返回 { item, changed }，routes 拿到后交给 sse.publish。
   */
  const ownerChanged = (kind, item) => ({
    to: 'itemOwners',
    ownerIds: ownerIdsOf(item),
    kind,
    itemId: item.id,
  });

  /**
   * 校验并归一化事项输入。requireAll=true 时所有必填字段都必须出现（新建）；
   * 否则只校验出现的字段（部分更新）。current 是这条事项的现有值——部分更新时
   * 用它补齐没传的字段，否则「截止不得早于起始」这条不变量会漏判。
   */
  function normalizeItemInput(input, { requireAll, current = null }) {
    const errors = {};
    const values = {};

    if (requireAll || input.title !== undefined) {
      if (typeof input.title !== 'string') {
        errors.title = '标题必须是文本';
      } else {
        const t = input.title.trim();
        if (!t) errors.title = '标题不能为空';
        else if (t.length > LIMITS.TITLE_MAX) errors.title = `标题最多 ${LIMITS.TITLE_MAX} 个字符`;
        else values.title = t;
      }
    }

    if (requireAll || input.event_date !== undefined) {
      if (!isValidDateString(input.event_date)) errors.event_date = '起始日期格式须为 yyyy-mm-dd 的真实日期';
      else values.event_date = input.event_date;
    }

    if (requireAll || input.due_date !== undefined) {
      if (!isValidDateString(input.due_date)) errors.due_date = '截止日期格式须为 yyyy-mm-dd 的真实日期';
      else values.due_date = input.due_date;
    }

    if (input.tag !== undefined) {
      const raw = input.tag;
      if (raw === null || raw === '') values.tag = null;
      else if (!isTagAllowed(raw)) errors.tag = `标签必须取自白名单：${TAGS.join('、')}`;
      else values.tag = raw;
    } else if (requireAll) {
      values.tag = null;
    }

    // 进展：一段自由文本，覆盖式更新，不保留历史（见 CONTEXT.md「进展」）
    if (input.progress !== undefined) {
      if (input.progress === null || input.progress === '') {
        values.progress = null;
      } else if (typeof input.progress !== 'string') {
        errors.progress = '进展必须是文本';
      } else {
        const p = input.progress.trim();
        if (p.length > LIMITS.PROGRESS_MAX) errors.progress = `进展最多 ${LIMITS.PROGRESS_MAX} 个字符`;
        else values.progress = p || null;
      }
    } else if (requireAll) {
      values.progress = null;
    }

    // owner 名单：必须是非空、去重、且账号都存在的 id 数组
    if (input.owner_ids !== undefined) {
      if (!Array.isArray(input.owner_ids) || input.owner_ids.length === 0) {
        errors.owner_ids = 'owner 名单至少要有一个人';
      } else {
        const ids = [...new Set(input.owner_ids.map(Number))];
        const exists = db.prepare('SELECT 1 FROM accounts WHERE id = ?');
        const bad = ids.find((id) => !Number.isInteger(id) || id <= 0 || !exists.get(id));
        if (bad !== undefined) errors.owner_ids = 'owner 名单里有不存在的账号';
        else values.owner_ids = ids.sort((a, b) => a - b);
      }
    }

    // 截止不得早于起始：合并「已有值 + 新值」后判断——这条不变量的唯一落点。
    // 它不看调用方这次传了哪些字段，也不看名单有没有变：曾经这两处条件是分开写的，
    // 于是「只带 event_date」的 PATCH 从两处都漏过去，最后由 SQL CHECK 兜底，
    // 用户拿到的是 500 加一个内部错误码。
    const merged = {
      event_date: values.event_date ?? current?.event_date,
      due_date: values.due_date ?? current?.due_date,
    };
    if (merged.event_date && merged.due_date && merged.due_date < merged.event_date) {
      errors.due_date = '截止日期不得早于起始日期';
    }

    return { values, errors };
  }

  /** 可见范围：user 只及于自己是成员之一的事项，manager/admin 及于全部。 */
  function listItems(account, from, to) {
    const scope = ownerScope(account);
    const params = [...scope.params];
    let sql = `SELECT ${ITEM_COLUMNS} ${FROM_ITEMS} WHERE i.archived_at IS NULL${scope.sql}`;

    if (from && to) {
      sql += ' AND i.event_date <= ? AND i.due_date >= ?';
      params.push(to, from);
    }
    sql += ' ORDER BY i.event_date ASC, i.title ASC';
    return withOwners(db.prepare(sql).all(...params));
  }

  /** 归档视图：admin 专用，展示全部账号的已归档事项，只读。 */
  function listArchived(account) {
    if (!capabilitiesOf(account).managesAccounts) throw httpError(403, '需要 admin 权限');
    return withOwners(
      db
        .prepare(
          `SELECT ${ITEM_COLUMNS} ${FROM_ITEMS}
            WHERE i.archived_at IS NOT NULL
            ORDER BY i.archived_at DESC, i.id DESC
            LIMIT ?`,
        )
        .all(LIMITS.ARCHIVE_PAGE_SIZE),
    );
  }

  function getItem(id) {
    const row = db.prepare(`SELECT ${ITEM_COLUMNS} ${FROM_ITEMS} WHERE i.id = ?`).get(id);
    return row ? withOwners([row])[0] : undefined;
  }

  /** 读一条事项并要求当前账号有权处置它（名单成员，或 manager/admin）。 */
  function requireItemAccess(account, id) {
    const item = getItem(id);
    if (!item) throw httpError(404, '事项不存在');
    if (!canAccessItem(account, item)) {
      throw httpError(403, '无权处置他人的事项');
    }
    return item;
  }

  /** 把 owner 名单写进关联表（调用方负责事务）。 */
  function writeOwners(itemId, ownerIds) {
    db.prepare('DELETE FROM item_owners WHERE item_id = ?').run(itemId);
    const insert = db.prepare('INSERT INTO item_owners (item_id, account_id) VALUES (?, ?)');
    for (const accountId of ownerIds) insert.run(itemId, accountId);
  }

  function createItem(account, input) {
    const { values, errors } = normalizeItemInput(input, { requireAll: true, current: null });

    const ownerIds = values.owner_ids ?? [account.id];
    if (!capabilitiesOf(account).assignsOwner && !(ownerIds.length === 1 && ownerIds[0] === account.id)) {
      errors.owner_ids = '只有 manager/admin 能把事项分配给他人';
    }
    if (Object.keys(errors).length) throw httpError(400, '输入有误', { fields: errors });

    const now = new Date().toISOString();
    const item = tx(() => {
      const color = colors.pickColor();
      const info = db
        .prepare(
          `INSERT INTO items (title, event_date, due_date, tag, color, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(values.title, values.event_date, values.due_date, values.tag, color, now, now);
      const id = Number(info.lastInsertRowid);
      writeOwners(id, ownerIds);
      return getItem(id);
    });

    return { item, changed: [ownerChanged('created', item)] };
  }

  function updateItem(account, id, input) {
    const current = requireItemAccess(account, id);
    if (current.archived_at) throw httpError(409, '已归档的事项不可修改');

    const { values, errors } = normalizeItemInput(input, { requireAll: false, current });
    const nextOwnerIds = values.owner_ids ?? null;
    delete values.owner_ids;

    if (nextOwnerIds && !capabilitiesOf(account).assignsOwner) {
      errors.owner_ids = '只有 manager/admin 能直接改 owner 名单；要把别人加进来请用邀请';
    }
    if (Object.keys(errors).length) throw httpError(400, '输入有误', { fields: errors });

    const expectedVersion = Number(input.version);
    if (!Number.isInteger(expectedVersion)) throw httpError(400, '更新时必须带上 version');

    const updated = tx(() => {
      const now = new Date().toISOString();
      const sets = [];
      const params = [];
      for (const [key, value] of Object.entries(values)) {
        sets.push(`${key} = ?`);
        params.push(value);
      }
      // 改写进展时顺手记下它是什么时候写的
      if ('progress' in values) {
        sets.push('progress_updated_at = ?');
        params.push(now);
      }
      sets.push('version = version + 1', 'updated_at = ?');
      params.push(now);
      params.push(id, expectedVersion);

      const info = db
        .prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ? AND version = ?`)
        .run(...params);

      if (info.changes === 0) {
        // 版本不符：说明期间有人改过这条事项
        throw httpError(409, '此事项已被他人修改，请刷新后重试', { code: 'VERSION_CONFLICT' });
      }
      if (nextOwnerIds) writeOwners(id, nextOwnerIds);
      return getItem(id);
    });

    const before = new Set(ownerIdsOf(current));
    const after = new Set(ownerIdsOf(updated));
    const removed = [...before].filter((x) => !after.has(x));
    const added = [...after].filter((x) => !before.has(x));
    const stayed = [...after].filter((x) => before.has(x));

    // 名单变了要说清谁进了谁出了：只有这里知道这件事
    const changed = [];
    if (removed.length || added.length) {
      if (removed.length) changed.push({ to: 'itemOwners', ownerIds: removed, kind: 'transferred-away', itemId: id });
      if (added.length) changed.push({ to: 'itemOwners', ownerIds: added, kind: 'transferred-in', itemId: id });
      if (stayed.length) changed.push({ to: 'itemOwners', ownerIds: stayed, kind: 'updated', itemId: id });
    } else {
      changed.push(ownerChanged('updated', updated));
    }

    return { item: updated, changed };
  }

  /** 归档（不可逆）。需要版本匹配，避免覆盖他人刚做的修改。 */
  function archiveItem(account, id, expectedVersion) {
    const current = requireItemAccess(account, id);
    if (current.archived_at) throw httpError(409, '该事项已经归档');

    const version = Number(expectedVersion);
    if (!Number.isInteger(version)) throw httpError(400, '归档时必须带上 version');

    const item = tx(() => {
      const info = db
        .prepare(
          `UPDATE items SET archived_at = ?, version = version + 1 WHERE id = ? AND version = ?`,
        )
        .run(new Date().toISOString(), id, version);

      if (info.changes === 0) {
        throw httpError(409, '此事项已被他人修改，请刷新后重试', { code: 'VERSION_CONFLICT' });
      }
      return getItem(id);
    });

    return { item, changed: [ownerChanged('archived', item)] };
  }

  function deleteItem(account, id) {
    const item = requireItemAccess(account, id);
    const info = db.prepare('DELETE FROM items WHERE id = ?').run(id);
    if (info.changes === 0) throw httpError(404, '事项不存在');
    return { item, changed: [ownerChanged('deleted', item)] };
  }

  /**
   * 某账号是**唯一** owner 且未归档的事项数——删账号前必须先把这些转走。
   * 还有别人的事项不算：那种情况下删账号只是把它从名单里摘掉。
   */
  function countSoleOwnedActiveItems(accountId) {
    return db
      .prepare(
        `SELECT COUNT(*) AS n FROM items i
          WHERE i.archived_at IS NULL
            AND EXISTS (SELECT 1 FROM item_owners m WHERE m.item_id = i.id AND m.account_id = ?)
            AND (SELECT COUNT(*) FROM item_owners m2 WHERE m2.item_id = i.id) = 1`,
      )
      .get(accountId).n;
  }

  /** 某账号是唯一 owner 的已归档事项数（删账号时它们会一并消失）。 */
  function countSoleOwnedArchivedItems(accountId) {
    return db
      .prepare(
        `SELECT COUNT(*) AS n FROM items i
          WHERE i.archived_at IS NOT NULL
            AND EXISTS (SELECT 1 FROM item_owners m WHERE m.item_id = i.id AND m.account_id = ?)
            AND (SELECT COUNT(*) FROM item_owners m2 WHERE m2.item_id = i.id) = 1`,
      )
      .get(accountId).n;
  }

  /** 删掉某账号是唯一 owner 的全部事项（含已归档）。共享事项由外键级联摘除成员。 */
  function deleteSoleOwnedItems(accountId) {
    return db
      .prepare(
        `DELETE FROM items WHERE id IN (
           SELECT i.id FROM items i
            WHERE EXISTS (SELECT 1 FROM item_owners m WHERE m.item_id = i.id AND m.account_id = ?)
              AND (SELECT COUNT(*) FROM item_owners m2 WHERE m2.item_id = i.id) = 1
         )`,
      )
      .run(accountId).changes;
  }

  /**
   * 把 fromOwnerId 从它参与的每条事项里换成 toOwnerId。
   * 目标已经是成员时不会重复插入（INSERT OR IGNORE）。
   */
  function transferAllItems(fromOwnerId, toOwnerId) {
    const affected = db
      .prepare('SELECT item_id FROM item_owners WHERE account_id = ?')
      .all(fromOwnerId);

    return tx(() => {
      const add = db.prepare('INSERT OR IGNORE INTO item_owners (item_id, account_id) VALUES (?, ?)');
      const drop = db.prepare('DELETE FROM item_owners WHERE item_id = ? AND account_id = ?');
      const touch = db.prepare('UPDATE items SET version = version + 1, updated_at = ? WHERE id = ?');
      const now = new Date().toISOString();

      for (const { item_id: itemId } of affected) {
        add.run(itemId, toOwnerId);
        drop.run(itemId, fromOwnerId);
        touch.run(now, itemId);
      }
      return affected.length;
    });
  }

  return {
    normalizeItemInput,
    listItems,
    listArchived,
    getItem,
    createItem,
    updateItem,
    archiveItem,
    deleteItem,
    countSoleOwnedActiveItems,
    countSoleOwnedArchivedItems,
    deleteSoleOwnedItems,
    transferAllItems,
  };
}
