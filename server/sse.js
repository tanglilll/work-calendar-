/**
 * SSE 广播中枢 + 变更词表 —— 由组合根创建、注入 routes 的 module。
 *
 * 为什么是 createSse() 而不是模块级状态：中枢持有「此刻连着的客户端」。
 * 模块级 Set 会被同一进程里所有组合根共享 —— A 实例的广播会写到 B 实例的
 * 客户端上，测试里也就无法断言「这次变更谁收到了」。做成 module 之后，
 * 每个 createApp 各持一套，互不串台。
 *
 * 关键约束：可见性在【服务端】过滤，绝不全量广播。
 * 判据本身在 visibility.js —— 这里只负责把它用在推送上，三条路径都从同一个
 * 出口走（deliver），不自己比对角色字符串或账号 id。
 *
 * viewer 的权威来源也由组合根注入：连接里只留 accountId，**不存 role 副本**，
 * 每次推送现问 roleOf —— 降权之后旧连接立刻按新角色判，不必重连。
 *
 * 变更描述的**词表与构造函数**也住在这里：领域 module 只说「发生了什么、影响谁」，
 * 且只能用这里的构造函数来说 —— 拼错 `to` 曾经会被 publish 的 if/else 静默丢弃，
 * 现在在测试里炸。这里导出的是纯构造函数，连接表仍然只属于 createSse() 的实例。
 */
import { canReceiveEvent } from './visibility.js';

const HEARTBEAT_MS = 25_000;

/**
 * 变更的去向（`to`）—— 送达方式由中枢决定，领域层只知道这四个词：
 * 前三个是「通知谁」（客户端收到事件后自己重新拉取），最后一个是「断开谁」。
 */
const TARGET = Object.freeze({
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

function write(client, event, data) {
  try {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // 连接已断，交给 close 事件清理
  }
}

/**
 * @param {{
 *   roleOf: (accountId: number) => string | null,
 *   heartbeatMs?: number,
 * }} [options] 两个依赖都是显式的：
 *   - roleOf：**推送时**的权威角色（组合根接到 accounts 上）。缺了就没有判据，直接炸；
 *   - heartbeatMs 只是测试接缝：真实间隔 25 秒，测试里没法等它。
 */
export function createSse({ roleOf, heartbeatMs = HEARTBEAT_MS } = {}) {
  if (typeof roleOf !== 'function') {
    throw new TypeError('createSse 需要注入 roleOf —— 推送时的权威角色由组合根提供，连接里不存副本');
  }

  const clients = new Set();
  // accountId -> 该账号此刻连着的客户端：按账号断开的定点寻址，不扫全表，
  // sse.js 里因此没有任何自己的账号比较（判据与寻址都不靠比较）。
  const byAccount = new Map();

  /** 把一条连接从两张表里摘掉。 */
  function detach(client) {
    clients.delete(client);
    const held = byAccount.get(client.accountId);
    if (!held) return;
    held.delete(client);
    if (held.size === 0) byAccount.delete(client.accountId);
  }

  /** 结束一条连接：先摘表（桩 res 不会回投 close），再关传输。 */
  function close(client) {
    detach(client);
    try {
      client.res.end();
    } catch {
      // 已经断开
    }
  }

  function addClient(res, account) {
    const client = { res, accountId: account.id };

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // 建议客户端 3 秒后重连
    res.write('retry: 3000\n\n');
    // hello 是握手回执（连接那一刻的会话角色），不是投递判据：投递一律现查 roleOf
    write(client, 'hello', { accountId: account.id, role: account.role });

    clients.add(client);
    const held = byAccount.get(account.id);
    if (held) held.add(client);
    else byAccount.set(account.id, new Set([client]));

    res.on('close', () => detach(client));
    res.on('error', () => detach(client));
    return client;
  }

  /** 连接此刻的权威 viewer：accountId 来自连接，role 现查。账号已不存在 → null。 */
  function viewerOf(client) {
    const role = roleOf(client.accountId);
    return role ? { accountId: client.accountId, role } : null;
  }

  /**
   * 唯一的投递出口：三条路径（事项事件、admin 事件、账号定向）都从这里走，
   * 判据在 visibility.js。每个连接现查 viewer —— 降权的旧连接立刻按新角色判，
   * 不需要重连，也不会被整体打死。
   */
  function deliver(event, eventName) {
    for (const client of clients) {
      if (canReceiveEvent(viewerOf(client), event)) write(client, eventName, event);
    }
  }

  /** 事项变更：ownerId 决定谁能收到。 */
  function broadcastItems(ownerId, kind, itemId) {
    deliver({ scope: 'items', ownerId: Number(ownerId), kind, itemId }, 'items');
  }

  /** 账号/申请变更：仅 admin 可收到。 */
  function broadcastAdmin(kind, payload = {}) {
    deliver({ scope: 'admin', kind, ...payload }, 'admin');
  }

  /**
   * 某人失去了可见性（被改角色）时，强制其客户端重新拉取。
   * 事件带上收件账号 accountId：账号定向同样由判据裁决，这里不再自己比。
   */
  function broadcastToAccount(accountId, kind, payload = {}) {
    if (!CHANGE_KINDS[TARGET.ACCOUNTS].includes(kind)) {
      throw new TypeError(`账号定向事件的 kind 不在词表里：${kind}`);
    }
    deliver({ scope: 'self', accountId, kind, ...payload }, 'self');
  }

  /**
   * 按账号断开连接（账号已删除）：连接收不到任何事件，留着只是占着句柄。
   * 只从 byAccount 索引里取，不扫全表也不比 id。
   */
  function disconnectAccount(accountId) {
    for (const client of [...(byAccount.get(accountId) ?? [])]) close(client);
  }

  /**
   * 把领域层返回的「变更描述」翻译成推送。
   *
   * 领域操作只说发生了什么、影响谁（to: itemOwners / admins / accounts / connections），
   * 由这里决定怎么送达 —— 于是 routes 里不再有广播策略。
   *
   * 只接受词表构造函数产生的变更：手写的、拼错的、词表外的 kind 一律抛错。
   * 以前这里靠 if/else 认三个 `to`，认不出的变更被静默丢弃——拼错只会在生产里无声消失。
   */
  function publish(changes = []) {
    for (const change of changes) {
      if (!isChange(change)) {
        throw new TypeError(`publish 只接受变更词表构造函数产生的变更，收到：${JSON.stringify(change)}`);
      }
      switch (change.to) {
        case TARGET.ITEM_OWNERS:
          for (const ownerId of change.ownerIds) broadcastItems(ownerId, change.kind, change.itemId);
          break;
        case TARGET.ADMINS:
          broadcastAdmin(change.kind);
          break;
        case TARGET.ACCOUNTS:
          for (const accountId of change.accountIds) broadcastToAccount(accountId, change.kind);
          break;
        case TARGET.CONNECTIONS:
          for (const accountId of change.accountIds) disconnectAccount(accountId);
          break;
        default:
          // 词表是闭集：构造过的变更到不了这里；留着是为了 publish 里不再有静默丢弃的路径
          throw new TypeError(`未知的变更去向 to=${change.to}`);
      }
    }
  }

  function startHeartbeat() {
    const timer = setInterval(() => {
      for (const client of clients) {
        try {
          client.res.write(': ping\n\n');
        } catch {
          detach(client);
        }
      }
    }, heartbeatMs);
    timer.unref();
    return timer;
  }

  /** 关掉所有连接（组合根 close 时调用；也是测试的收尾手段）。 */
  function closeAll() {
    for (const client of [...clients]) close(client);
  }

  return { addClient, publish, broadcastToAccount, startHeartbeat, closeAll };
}
