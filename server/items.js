/**
 * 事项的读写与校验。可见性判据在 visibility.js，这里只调用它；
 * 路由层不自行拼 SQL、不自行比对角色。
 */
import { db, tx } from './db.js';
import { pickColor } from './colors.js';
import { LIMITS, isValidDateString, isTagAllowed, TAGS } from './config.js';
import { canAccessItem, capabilitiesOf, ownerScope } from './visibility.js';
import { httpError } from './http.js';

const ITEM_COLUMNS = `
  i.id, i.owner_id, a.username AS owner_name, i.title,
  i.event_date, i.due_date, i.tag, i.color,
  i.version, i.archived_at, i.created_at, i.updated_at
`;

const FROM_ITEMS = 'FROM items i JOIN accounts a ON a.id = i.owner_id';

/**
 * 校验并归一化事项输入。requireAll=true 时所有必填字段都必须出现（新建）；
 * 否则只校验出现的字段（部分更新）。
 */
export function normalizeItemInput(input, { requireAll }) {
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

  if (input.owner_id !== undefined) {
    const ownerId = Number(input.owner_id);
    if (!Number.isInteger(ownerId) || ownerId <= 0) {
      errors.owner_id = 'owner_id 必须是正整数';
    } else if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(ownerId)) {
      errors.owner_id = '指定的 owner 不存在';
    } else {
      values.owner_id = ownerId;
    }
  }

  // 截止不得早于起始：合并已有值与新值后判断
  if (values.event_date && values.due_date && values.due_date < values.event_date) {
    errors.due_date = '截止日期不得早于起始日期';
  }

  return { values, errors };
}

/** 可见范围：user 只及于自己，manager/admin 及于全部。 */
export function listItems(account, from, to) {
  const scope = ownerScope(account);
  const params = [...scope.params];
  let sql = `SELECT ${ITEM_COLUMNS} ${FROM_ITEMS} WHERE i.archived_at IS NULL${scope.sql}`;

  if (from && to) {
    sql += ' AND i.event_date <= ? AND i.due_date >= ?';
    params.push(to, from);
  }
  sql += ' ORDER BY i.event_date ASC, i.title ASC';
  return db.prepare(sql).all(...params);
}

/** 归档视图：admin 专用，展示全部账号的已归档事项，只读。 */
export function listArchived(account) {
  if (!capabilitiesOf(account).managesAccounts) throw httpError(403, '需要 admin 权限');
  return db
    .prepare(
      `SELECT ${ITEM_COLUMNS} ${FROM_ITEMS}
        WHERE i.archived_at IS NOT NULL
        ORDER BY i.archived_at DESC, i.id DESC
        LIMIT ?`,
    )
    .all(LIMITS.ARCHIVE_PAGE_SIZE);
}

export function getItem(id) {
  return db.prepare(`SELECT ${ITEM_COLUMNS} ${FROM_ITEMS} WHERE i.id = ?`).get(id);
}

/** 读一条事项并要求当前账号有权处置它（owner 本人，或 manager/admin）。 */
function requireItemAccess(account, id) {
  const item = getItem(id);
  if (!item) throw httpError(404, '事项不存在');
  if (!canAccessItem(account, item)) {
    throw httpError(403, '无权处置他人的事项');
  }
  return item;
}

export function createItem(account, input) {
  const { values, errors } = normalizeItemInput(input, { requireAll: true });

  if (
    values.owner_id !== undefined &&
    !capabilitiesOf(account).assignsOwner &&
    values.owner_id !== account.id
  ) {
    errors.owner_id = '只有 manager/admin 能把事项分配给他人';
  }
  if (Object.keys(errors).length) throw httpError(400, '输入有误', { fields: errors });

  const ownerId = values.owner_id ?? account.id;
  const now = new Date().toISOString();

  return tx(() => {
    const color = pickColor();
    const info = db
      .prepare(
        `INSERT INTO items (owner_id, title, event_date, due_date, tag, color, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ownerId, values.title, values.event_date, values.due_date, values.tag, color, now, now);
    return getItem(Number(info.lastInsertRowid));
  });
}

export function updateItem(account, id, input) {
  const current = requireItemAccess(account, id);
  if (current.archived_at) throw httpError(409, '已归档的事项不可修改');

  const { values, errors } = normalizeItemInput(input, { requireAll: false });

  if (values.owner_id !== undefined && !capabilitiesOf(account).assignsOwner) {
    errors.owner_id = '只有 manager/admin 能修改 owner';
  }
  if (values.owner_id !== undefined) {
    const merged = { event_date: current.event_date, due_date: current.due_date, ...values };
    if (merged.due_date < merged.event_date) errors.due_date = '截止日期不得早于起始日期';
  }
  if (Object.keys(errors).length) throw httpError(400, '输入有误', { fields: errors });

  const expectedVersion = Number(input.version);
  if (!Number.isInteger(expectedVersion)) throw httpError(400, '更新时必须带上 version');

  return tx(() => {
    const sets = [];
    const params = [];
    for (const [key, value] of Object.entries(values)) {
      sets.push(`${key} = ?`);
      params.push(value);
    }
    sets.push('version = version + 1', 'updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id, expectedVersion);

    const info = db
      .prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ? AND version = ?`)
      .run(...params);

    if (info.changes === 0) {
      // 版本不符：说明期间有人改过这条事项
      throw httpError(409, '此事项已被他人修改，请刷新后重试', { code: 'VERSION_CONFLICT' });
    }
    return getItem(id);
  });
}

/** 归档（不可逆）。需要版本匹配，避免覆盖他人刚做的修改。 */
export function archiveItem(account, id, expectedVersion) {
  const current = requireItemAccess(account, id);
  if (current.archived_at) throw httpError(409, '该事项已经归档');

  const version = Number(expectedVersion);
  if (!Number.isInteger(version)) throw httpError(400, '归档时必须带上 version');

  return tx(() => {
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
}

export function deleteItem(account, id) {
  const current = requireItemAccess(account, id);
  const info = db.prepare('DELETE FROM items WHERE id = ?').run(id);
  if (info.changes === 0) throw httpError(404, '事项不存在');
  return current;
}

/** 某账号名下未归档事项数（删账号前的转移检查用）。 */
export function countActiveItems(ownerId) {
  return db
    .prepare('SELECT COUNT(*) AS n FROM items WHERE owner_id = ? AND archived_at IS NULL')
    .get(ownerId).n;
}

/** 把某账号名下全部事项（含已归档）转给另一个账号。 */
export function transferAllItems(fromOwnerId, toOwnerId) {
  return tx(() => {
    const info = db
      .prepare('UPDATE items SET owner_id = ?, version = version + 1, updated_at = ? WHERE owner_id = ?')
      .run(toOwnerId, new Date().toISOString(), fromOwnerId);
    return Number(info.changes);
  });
}
