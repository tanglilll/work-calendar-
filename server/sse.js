/**
 * SSE 广播中枢 —— 由组合根创建、注入 routes 的 module。
 *
 * 为什么是 createSse() 而不是模块级状态：中枢持有「此刻连着的客户端」。
 * 模块级 Set 会被同一进程里所有组合根共享 —— A 实例的广播会写到 B 实例的
 * 客户端上，测试里也就无法断言「这次变更谁收到了」。做成 module 之后，
 * 每个 createApp 各持一套，互不串台。
 *
 * 关键约束：可见性在【服务端】过滤，绝不全量广播。
 * 判据本身在 visibility.js —— 这里只负责把它用在推送上，
 * 不自己比对角色字符串（否则 REST 与 SSE 会各写一份规则）。
 */
import { canReceiveEvent } from './visibility.js';

const HEARTBEAT_MS = 25_000;

function write(client, event, data) {
  try {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // 连接已断，交给 close 事件清理
  }
}

/**
 * @param {{ heartbeatMs?: number }} [options] heartbeatMs 只是测试接缝：
 *   真实间隔 25 秒，测试里没法等它。
 */
export function createSse({ heartbeatMs = HEARTBEAT_MS } = {}) {
  const clients = new Set();

  function addClient(res, account) {
    const client = { res, accountId: account.id, role: account.role };

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // 建议客户端 3 秒后重连
    res.write('retry: 3000\n\n');
    write(client, 'hello', { accountId: account.id, role: account.role });

    clients.add(client);
    res.on('close', () => clients.delete(client));
    res.on('error', () => clients.delete(client));
    return client;
  }

  /** 事项变更：ownerId 决定谁能收到。 */
  function broadcastItems(ownerId, kind, itemId) {
    const event = { scope: 'items', ownerId: Number(ownerId), kind, itemId };
    for (const client of clients) {
      if (canReceiveEvent(client, event)) write(client, 'items', event);
    }
  }

  /** 账号/申请变更：仅 admin 可收到。 */
  function broadcastAdmin(kind, payload = {}) {
    const event = { scope: 'admin', kind, ...payload };
    for (const client of clients) {
      if (canReceiveEvent(client, event)) write(client, 'admin', event);
    }
  }

  /**
   * 某人失去了可见性（被删账号、改角色）时，强制其客户端重新拉取。
   * 主要用于角色变更：越权数据必须立刻从该客户端消失。
   */
  function broadcastToAccount(accountId, kind, payload = {}) {
    const event = { scope: 'self', kind, ...payload };
    for (const client of clients) {
      if (client.accountId === accountId) write(client, 'self', event);
    }
  }

  /**
   * 把领域层返回的「变更描述」翻译成推送。
   *
   * 领域操作只说发生了什么、影响谁（to: itemOwners / admins / accounts），
   * 由这里决定怎么送达 —— 于是 routes 里不再有广播策略。
   */
  function publish(changes = []) {
    for (const change of changes) {
      if (change.to === 'itemOwners') {
        for (const ownerId of change.ownerIds) broadcastItems(ownerId, change.kind, change.itemId ?? null);
      } else if (change.to === 'admins') {
        broadcastAdmin(change.kind);
      } else if (change.to === 'accounts') {
        for (const accountId of change.accountIds) broadcastToAccount(accountId, change.kind);
      }
    }
  }

  function startHeartbeat() {
    const timer = setInterval(() => {
      for (const client of clients) {
        try {
          client.res.write(': ping\n\n');
        } catch {
          clients.delete(client);
        }
      }
    }, heartbeatMs);
    timer.unref();
    return timer;
  }

  /** 关掉所有连接（组合根 close 时调用；也是测试的收尾手段）。 */
  function closeAll() {
    for (const client of clients) {
      try {
        client.res.end();
      } catch {
        // 已经断开
      }
    }
    clients.clear();
  }

  return { addClient, publish, broadcastToAccount, startHeartbeat, closeAll };
}
