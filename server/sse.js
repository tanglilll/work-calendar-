/**
 * SSE 广播中枢。
 *
 * 关键约束：可见性在【服务端】过滤，绝不全量广播。
 * - user 只会收到 ownerId === 自己 的事项事件；
 * - manager / admin 收到全部事项事件；
 * - 账号与注册申请相关的事件只发给 admin。
 */

const clients = new Set();
const HEARTBEAT_MS = 25_000;

function write(client, event, data) {
  try {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // 连接已断，交给 close 事件清理
  }
}

function canReceive(client, event) {
  if (event.scope === 'admin') return client.role === 'admin';

  // scope === 'items'
  if (client.role === 'manager' || client.role === 'admin') return true;
  return event.ownerId === client.accountId;
}

export function addClient(res, account) {
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
export function broadcastItems(ownerId, kind, itemId) {
  const event = { scope: 'items', ownerId: Number(ownerId), kind, itemId };
  for (const client of clients) {
    if (canReceive(client, event)) write(client, 'items', event);
  }
}

/** 账号/申请变更：仅 admin 可收到。 */
export function broadcastAdmin(kind, payload = {}) {
  const event = { scope: 'admin', kind, ...payload };
  for (const client of clients) {
    if (canReceive(client, event)) write(client, 'admin', event);
  }
}

/**
 * 某人失去了可见性（被删账号、改角色）时，强制其客户端重新拉取。
 * 主要用于角色变更：越权数据必须立刻从该客户端消失。
 */
export function broadcastToAccount(accountId, kind, payload = {}) {
  const event = { scope: 'self', kind, ...payload };
  for (const client of clients) {
    if (client.accountId === accountId) write(client, 'self', event);
  }
}

export function clientCount() {
  return clients.size;
}

export function startHeartbeat() {
  const timer = setInterval(() => {
    for (const client of clients) {
      try {
        client.res.write(': ping\n\n');
      } catch {
        clients.delete(client);
      }
    }
  }, HEARTBEAT_MS);
  timer.unref();
  return timer;
}
