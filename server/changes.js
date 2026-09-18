/**
 * 变更描述 —— 领域层说「发生了什么、影响谁」的词汇表。
 *
 * 为什么单独一个 module：四个生产者（items / invites / accounts / auth）都要构造
 * 变更，中枢（sse.js）只负责投递。词表曾经住在 sse.js 里，于是 auth.js 为了说一句
 * 「这个会话签发了」不得不 import 广播中枢 —— 会话模块挂到了投递层上。现在
 * 生产者与投递层都指向这里，谁也不指向谁。
 *
 * 这里只有词表、构造函数、owner 差分与校验（isChange）；连接表、心跳与 publish
 * 的分发策略在 sse.js —— 变更描述的**词表是闭集**：拼错 `to` 曾经会被 publish 的
 * if/else 静默丢弃，现在在构造函数里就炸，测试与生产同样有声。
 */

/**
 * 变更的去向（`to`）—— 送达方式由中枢决定，领域层只知道这四个词：
 * 前三个是「通知谁」（客户端收到事件后自己重新拉取），最后一个是「断开谁」。
 */
export const TARGET = Object.freeze({
  ITEM_OWNERS: 'itemOwners',
  ADMINS: 'admins',
  ACCOUNTS: 'accounts',
  CONNECTIONS: 'connections',
});

/**
 * 变更词表：谁可以发哪种变更。构造函数与 publish 都问它，它是闭集——
 * 新增一种变更 = 在这里加一个词、写它的构造函数、给中枢加一条送达路径。
 */
export const CHANGE_KINDS = Object.freeze({
  [TARGET.ITEM_OWNERS]: Object.freeze([
    'created',
    'updated',
    'transferred-away',
    'transferred-in',
    'archived',
    'deleted',
  ]),
  [TARGET.ADMINS]: Object.freeze(['accounts', 'requests']),
  [TARGET.ACCOUNTS]: Object.freeze(['invites-changed', 'approved', 'role-changed', 'signed-in']),
  [TARGET.CONNECTIONS]: Object.freeze(['account-deleted']),
});

/** 只有词表的构造函数能盖上这个标记：publish 只认它。 */
const CONSTRUCTED = Symbol('change');

const isIdList = (value) =>
  Array.isArray(value) && value.length > 0 && value.every((id) => Number.isInteger(id) && id > 0);

/** 构造一条变更描述：kind 不在词表里就没有这条变更。 */
function constructed(to, kind, fields) {
  if (!CHANGE_KINDS[to]?.includes(kind)) throw new TypeError(`变更词表里没有 ${to}/${kind}`);
  return Object.defineProperty({ to, kind, ...fields }, CONSTRUCTED, { value: true });
}

/**
 * 事项事件的构造函数：发给 ownerIds 里的每个人，kind 说明这条事项出了什么事。
 * 不涉及名单增减的变更（created / archived / deleted，以及名单没变时的 updated）
 * 用当前名单调用它；名单有进有出时用下面的 ownerChanges，别自己算差集。
 */
export function ownerChanged(itemId, ownerIds, kind) {
  if (!Number.isInteger(itemId) || itemId <= 0) throw new TypeError('事项事件必须带上 itemId');
  if (!isIdList(ownerIds)) throw new TypeError('事项事件必须带上 ownerIds（非空的账号 id 数组）');
  return constructed(TARGET.ITEM_OWNERS, kind, { ownerIds: [...ownerIds], itemId });
}

/** admin 事件：只有 admin 收得到。 */
export function adminsChanged(kind) {
  return constructed(TARGET.ADMINS, kind, {});
}

/** 账号定向事件：只发给 accountIds 里列出的账号。 */
export function accountChanged(accountIds, kind) {
  if (!isIdList(accountIds)) throw new TypeError('账号定向事件必须带上 accountIds（非空的账号 id 数组）');
  return constructed(TARGET.ACCOUNTS, kind, { accountIds: [...accountIds] });
}

/**
 * 账号已删除：它的连接不再有意义，**断开**（不是通知谁）。
 * 与 accountChanged 的差别只在送达方式：那条让客户端重新拉取，这条直接结束连接 ——
 * 账号与它的会话都已不存在，留着只是一个收不到任何事件、却仍占着句柄的连接。
 */
export function accountDeleted(accountId) {
  if (!Number.isInteger(accountId) || accountId <= 0) throw new TypeError('断开变更必须带上账号 id');
  return constructed(TARGET.CONNECTIONS, 'account-deleted', { accountIds: [accountId] });
}

/** 这条变更描述是不是词表构造函数产生的。 */
export function isChange(value) {
  return Boolean(value) && value[CONSTRUCTED] === true;
}

/**
 * owner 名单的差分：谁出（removed）、谁进（added）、谁留（stayed）。
 * 名单是并列的（ADR-0002）：只比较成员在不在，不看顺序，也没有主次。
 */
export function ownerDiff(beforeIds, afterIds) {
  const before = new Set(beforeIds);
  const after = new Set(afterIds);
  return {
    removed: [...before].filter((id) => !after.has(id)),
    added: [...after].filter((id) => !before.has(id)),
    stayed: [...after].filter((id) => before.has(id)),
  };
}

/**
 * 名单变化要通知谁 —— 「谁需要被通知」的唯一实现，三个调用点共用
 * （items.updateItem / invites.accept / accounts.transferItems）：
 * 出的人收 transferred-away，进的人收 transferred-in，留下的人收 updated；
 * 名单没变时，当前名单上的每个人都收 updated。
 */
export function ownerChanges({ itemId, before, after }) {
  const { removed, added, stayed } = ownerDiff(before, after);
  if (!removed.length && !added.length) return [ownerChanged(itemId, after, 'updated')];

  const changes = [];
  if (removed.length) changes.push(ownerChanged(itemId, removed, 'transferred-away'));
  if (added.length) changes.push(ownerChanged(itemId, added, 'transferred-in'));
  if (stayed.length) changes.push(ownerChanged(itemId, stayed, 'updated'));
  return changes;
}
