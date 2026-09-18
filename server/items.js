/**
 * 事项的读写与校验。可见性判据在 visibility.js，这里只调用它；
 * 路由层不自行拼 SQL、不自行比对角色。
 *
 * 「能不能动这条事项」收成一道门：requireItemAccess(actor, itemId, purpose)。
 * 它同时管访问与「已归档」这件事，invites 也走它——两边不再各判一遍。
 *
 * owner 是一个名单（见 docs/adr/0002）：成员并列、无主次。
 * 变更描述由 changes.js 的词表构造函数产生——这个 module 不自己拼 to/kind。
 *
 * store 与 colors 由组合根注入 —— 这个 module 不再自己创建数据库连接。
 */
import { LIMITS, isValidDateString, isTagAllowed, TAGS } from './config.js';
import { canAccessItem, capabilitiesOf, ownerScope } from './visibility.js';
import { ownerChanged, ownerChanges } from './changes.js';
import { httpError } from './http.js';

const ITEM_COLUMNS = `
  i.id, i.title, i.event_date, i.due_date, i.tag, i.color,
  i.version, i.archived_at, i.created_at, i.updated_at,
  i.progress, i.progress_updated_at
`;

const FROM_ITEMS = 'FROM items i';

/**
 * 派生肖 progress_updated_at 的唯一规则：有进展才记它的更新时间；没有进展
 * （新建时没填、更新时清空）这一列也是空。新建与更新两条写路径都调它取值。
 */
const progressUpdatedAtFor = (progress) =>
  progress === null || progress === undefined ? null : new Date().toISOString();

/**
 * 事项可写字段表 —— 「一条事项有哪些可写字段」的唯一落点。
 *
 * 每条字段声明四件事：
 * - name：字段名，同时也是 SQL 列名；新建的 INSERT 与更新的动态 SET 都按它拼，
 *   写入层不再手写列清单（`21b42ba` 那次「新建时填的进展被静默丢掉」正是手写清单
 *   与校验层脱钩的产物）；
 * - parse(raw)：解析并校验一个值，返回 { value } 或 { error }；
 * - requiredOnCreate：新建时缺了它算不算字段错误（更新是部分更新，没带就不动这列）；
 * - default：新建时没带的可选字段用什么值补齐。
 *
 * 两类东西刻意不在表里：
 * - owner_ids 写的是 item_owners（另一张表），语义是「名单」而不是行上的列：
 *   它的校验留在 normalizeItemInput 的收尾处、写入留在 writeOwners；
 * - progress_updated_at 是派生肖，不是调用方能写的字段，规则见 progressUpdatedAtFor。
 *
 * DB schema 不由这张表生成（见工单 01 被否掉的方案）：db.js 继续手写建表，
 * 表与 schema 的对齐由 test/items.test.js 的表驱动往返断言守住。
 */
export const ITEM_FIELDS = [
  {
    name: 'title',
    requiredOnCreate: true,
    parse(raw) {
      if (typeof raw !== 'string') return { error: '标题必须是文本' };
      const title = raw.trim();
      if (!title) return { error: '标题不能为空' };
      if (title.length > LIMITS.TITLE_MAX) return { error: `标题最多 ${LIMITS.TITLE_MAX} 个字符` };
      return { value: title };
    },
  },
  {
    name: 'event_date',
    requiredOnCreate: true,
    parse(raw) {
      if (!isValidDateString(raw)) return { error: '起始日期格式须为 yyyy-mm-dd 的真实日期' };
      return { value: raw };
    },
  },
  {
    name: 'due_date',
    requiredOnCreate: true,
    parse(raw) {
      if (!isValidDateString(raw)) return { error: '截止日期格式须为 yyyy-mm-dd 的真实日期' };
      return { value: raw };
    },
  },
  {
    name: 'tag',
    requiredOnCreate: false,
    default: null,
    parse(raw) {
      if (raw === null || raw === '') return { value: null };
      if (!isTagAllowed(raw)) return { error: `标签必须取自白名单：${TAGS.join('、')}` };
      return { value: raw };
    },
  },
  {
    name: 'progress',
    requiredOnCreate: false,
    default: null,
    // 一段自由文本，覆盖式更新，不保留历史（见 CONTEXT.md「进展」）
    parse(raw) {
      if (raw === null || raw === '') return { value: null };
      if (typeof raw !== 'string') return { error: '进展必须是文本' };
      const progress = raw.trim();
      if (progress.length > LIMITS.PROGRESS_MAX) {
        return { error: `进展最多 ${LIMITS.PROGRESS_MAX} 个字符` };
      }
      return { value: progress || null };
    },
  },
];

/** 字段表给出的列名：写入层照它拼 SQL。 */
const FIELD_NAMES = ITEM_FIELDS.map((field) => field.name);

/** 新建时还要一并写入的、由路径自己产生的列：颜色与三个时间戳。 */
const INSERT_COLUMNS = [...FIELD_NAMES, 'color', 'created_at', 'updated_at', 'progress_updated_at'];
const INSERT_SQL = `INSERT INTO items (${INSERT_COLUMNS.join(', ')})
    VALUES (${INSERT_COLUMNS.map(() => '?').join(', ')})`;

/**
 * 门的用途表 —— purpose 的闭集，也是「已归档还让不让动」的**唯一声明处**：
 * 值是已归档时给的拒绝理由，null 表示放行（只有删除）。
 *
 * 为什么把归档政策写在用途旁边：以前「能不能动这条事项」在 items 与 invites
 * 各判一遍，且两边都只管访问、不管生命周期——给一条已归档事项发邀请因此
 * 一路通到数据库。现在每个用途都必须在这里交代它对已归档的立场，而表是闭集
 * （门拒绝表外的 purpose）：新增用途而不写政策，测试会当场逮住。
 *
 * delete 放行是**写下来的例外**，不是疏漏：删除的语义是「这事本就不该存在」，
 * 与它是否完成过无关；归档视图只读、不提供入口，所以这条能力只经 REST 可达。
 *
 * read 今天没有调用点（列表在 SQL 侧按 ownerScope 过滤，单条读只在内部），
 * 留着它是因为它是门接口的一部分：这条「已归档读不到」的规则本身就写在这里。
 */
export const ITEM_ACCESS_PURPOSES = Object.freeze({
  read: '已归档的事项只在归档视图里可见',
  write: '已归档的事项不可修改',
  archive: '该事项已经归档',
  invite: '已归档的事项不可再邀请他人',
  delete: null,
});

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

  // 变更描述由 changes.js 的词表构造函数产生（ownerChanged / ownerChanges）：领域层只说
  // 「这条事项的名单出了什么事、影响谁」，怎么送达由适配层决定。
  // 写操作一律返回 { item, changed }，routes 拿到后交给 sse.publish。

  /**
   * 校验并归一化事项输入。requireAll=true 时所有必填字段都必须出现（新建）；
   * 否则只校验出现的字段（部分更新）。字段清单与每条字段的解析/校验全部来自
   * ITEM_FIELDS —— 这里只做「按表走一遍」，新增可写字段不必改这个函数。
   * current 是这条事项的现有值——部分更新时用它补齐没传的字段，否则
   * 「截止不得早于起始」这条不变量会漏判。
   */
  function normalizeItemInput(input, { requireAll, current = null }) {
    const errors = {};
    const values = {};

    for (const field of ITEM_FIELDS) {
      if (input[field.name] === undefined) {
        if (!requireAll) continue; // 部分更新：没带就不动这一列
        if (!field.requiredOnCreate) {
          values[field.name] = field.default; // 新建：可选字段缺省时用默认值补齐
          continue;
        }
      }
      const { value, error } = field.parse(input[field.name]);
      if (error !== undefined) errors[field.name] = error;
      else values[field.name] = value;
    }

    // owner_ids 不在字段表里（见表的说明）：它写的是 item_owners，语义是「名单」
    // 而不是 items 行上的列，所以校验与写入仍留在表外。
    // 必须是非空、去重、且账号都存在的 id 数组
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

  /**
   * 事项的门 —— 「能不能动这条事项」的**唯一落点**：items 与 invites 都走它。
   *
   * 两件事一起管：**访问**（是不是这条事项的参与者，判据在 visibility.js，
   * 这里只问一次）与**生命周期**（已归档的立场写在 ITEM_ACCESS_PURPOSES 里）。
   * 除 delete 之外，已归档一律拒绝——读不到、改不动、归档不了、也邀请不了别人；
   * 以前 invites 复刻了一份访问判据、漏了归档检查，邀请就一路通到了数据库。
   *
   * 表外的 purpose 直接抛 TypeError，不做默认放行：门是闭集，新增用途必须
   * 连同它的归档政策一起写进表里。
   */
  function requireItemAccess(actor, itemId, purpose) {
    if (!Object.hasOwn(ITEM_ACCESS_PURPOSES, purpose)) {
      throw new TypeError(
        `未知的 purpose=${purpose}：门的用途只有 ${Object.keys(ITEM_ACCESS_PURPOSES).join(' / ')}`,
      );
    }
    const item = getItem(itemId);
    if (!item) throw httpError(404, '事项不存在');
    if (!canAccessItem(actor, item)) {
      throw httpError(403, '无权处置他人的事项');
    }
    if (item.archived_at && ITEM_ACCESS_PURPOSES[purpose]) {
      throw httpError(409, ITEM_ACCESS_PURPOSES[purpose]);
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
      // 列清单与取值顺序都从字段表派生（INSERT_SQL / FIELD_NAMES），写入层没有
      // 可漏的手写清单——校验层备好的每个字段都会原样落库（21b42ba 的根因）。
      // 参数顺序与 INSERT_COLUMNS 一致：先是字段表，然后是 color 与三个时间戳。
      const info = db
        .prepare(INSERT_SQL)
        .run(
          ...FIELD_NAMES.map((name) => values[name]),
          color,
          now,
          now,
          progressUpdatedAtFor(values.progress),
        );
      const id = Number(info.lastInsertRowid);
      writeOwners(id, ownerIds);
      return getItem(id);
    });

    return { item, changed: [ownerChanged(item.id, ownerIdsOf(item), 'created')] };
  }

  function updateItem(account, id, input) {
    // 门管着「已归档不可改」（write 这一格）：这里不再自己看 archived_at
    const current = requireItemAccess(account, id, 'write');

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
      // 动态 SET 同样从字段表派生：表里有哪些可写列，这里就能改哪些列。
      for (const field of ITEM_FIELDS) {
        if (!(field.name in values)) continue;
        sets.push(`${field.name} = ?`);
        params.push(values[field.name]);
      }
      // 派生肖跟随 progress 一起写：有进展才有时间戳，清空进展则时间戳也清空
      // （规则唯一实现在 progressUpdatedAtFor，新建路径调的是同一个）
      if ('progress' in values) {
        sets.push('progress_updated_at = ?');
        params.push(progressUpdatedAtFor(values.progress));
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

    // 名单变了要说清谁进了谁出了：差分与「谁需要被通知」只有 changes.js 一处实现
    // （invites.accept 与 accounts.transferItems 调的是同一个 ownerChanges）
    const changed = ownerChanges({
      itemId: id,
      before: ownerIdsOf(current),
      after: ownerIdsOf(updated),
    });

    return { item: updated, changed };
  }

  /** 归档（不可逆）。需要版本匹配，避免覆盖他人刚做的修改。 */
  function archiveItem(account, id, expectedVersion) {
    // 「已经归档」由门拦下（archive 这一格），这里只管版本
    const current = requireItemAccess(account, id, 'archive');

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

    return { item, changed: [ownerChanged(item.id, ownerIdsOf(item), 'archived')] };
  }

  /**
   * 删除：门的 delete 这一格是**唯一放行已归档事项**的用途（理由写在
   * ITEM_ACCESS_PURPOSES 上面）。归档视图只读、不提供入口，所以这条能力
   * 只从 REST 接口可达——它以前就在，这里只是把它写进门里。
   */
  function deleteItem(account, id) {
    const item = requireItemAccess(account, id, 'delete');
    const info = db.prepare('DELETE FROM items WHERE id = ?').run(id);
    if (info.changes === 0) throw httpError(404, '事项不存在');
    return { item, changed: [ownerChanged(item.id, ownerIdsOf(item), 'deleted')] };
  }

  /**
   * 「某账号是**唯一** owner 的事项」的 WHERE 片段 —— 唯一实现，删账号的三条
   * 路径共用（删前的门槛、随删的归档计数、以及真正删除）。三条只在**归档条件**
   * 上分叉：archived 为 true 只算已归档、false 只算未归档、不传两类都算。
   * 以前这段 EXISTS + `count = 1` 抄了三遍，只有归档那一行不同。
   *
   * 片段里只有一个占位符：账号 id。
   */
  function soleOwnedWhere(archived) {
    const scope = archived === undefined ? '' : `i.archived_at IS ${archived ? 'NOT NULL' : 'NULL'} AND `;
    return `${scope}EXISTS (SELECT 1 FROM item_owners m WHERE m.item_id = i.id AND m.account_id = ?)
      AND (SELECT COUNT(*) FROM item_owners m2 WHERE m2.item_id = i.id) = 1`;
  }

  /** 某账号是唯一 owner 的未归档事项数——删账号前必须先把这些转走。 */
  function countSoleOwnedActiveItems(accountId) {
    return db.prepare(`SELECT COUNT(*) AS n FROM items i WHERE ${soleOwnedWhere(false)}`).get(accountId).n;
  }

  /** 某账号是唯一 owner 的已归档事项数（删账号时它们会一并消失）。 */
  function countSoleOwnedArchivedItems(accountId) {
    return db.prepare(`SELECT COUNT(*) AS n FROM items i WHERE ${soleOwnedWhere(true)}`).get(accountId).n;
  }

  /** 删掉某账号是唯一 owner 的全部事项（含已归档）。共享事项由外键级联摘除成员。 */
  function deleteSoleOwnedItems(accountId) {
    return db
      .prepare(`DELETE FROM items WHERE id IN (SELECT i.id FROM items i WHERE ${soleOwnedWhere()})`)
      .run(accountId).changes;
  }

  /**
   * 把 fromOwnerId 从它参与的每条事项里换成 toOwnerId。
   * 目标已经是成员时不会重复插入（INSERT OR IGNORE）。
   *
   * 返回每条受影响事项的名单差分（{ itemId, before, after }）——这里只提供事实，
   * 「谁需要被通知」由调用方交给词表的 ownerChanges 算，与另外两处同源。
   */
  function transferAllItems(fromOwnerId, toOwnerId) {
    const affected = db
      .prepare('SELECT item_id FROM item_owners WHERE account_id = ?')
      .all(fromOwnerId);

    return tx(() => {
      const add = db.prepare('INSERT OR IGNORE INTO item_owners (item_id, account_id) VALUES (?, ?)');
      const drop = db.prepare('DELETE FROM item_owners WHERE item_id = ? AND account_id = ?');
      const touch = db.prepare('UPDATE items SET version = version + 1, updated_at = ? WHERE id = ?');
      const owners = db.prepare('SELECT account_id FROM item_owners WHERE item_id = ? ORDER BY account_id ASC');
      const now = new Date().toISOString();

      const moves = [];
      for (const { item_id: itemId } of affected) {
        const before = owners.all(itemId).map((row) => row.account_id);
        add.run(itemId, toOwnerId);
        drop.run(itemId, fromOwnerId);
        touch.run(now, itemId);
        moves.push({ itemId, before, after: owners.all(itemId).map((row) => row.account_id) });
      }
      return moves;
    });
  }

  return {
    normalizeItemInput,
    requireItemAccess,
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
