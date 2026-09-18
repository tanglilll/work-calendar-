/**
 * SSE 广播中枢 —— 由组合根创建、注入 routes 的 module。
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
 * 变更描述的**词表与构造函数不住在这里**（见 changes.js）：领域层只说
 * 「发生了什么、影响谁」，且只能用那边的构造函数来说。这里只剩投递 ——
 * 连接表、deliver、按账号断开、心跳，以及 publish 这唯一策略入口的分发。
 */
import { canReceiveEvent } from './visibility.js';
import { CHANGE_KINDS, TARGET, isChange } from './changes.js';

const HEARTBEAT_MS = 25_000;

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
