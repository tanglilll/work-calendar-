/**
 * SSE 广播中枢。
 *
 * 关键约束：可见性在【服务端】过滤，绝不全量广播。
 * 判据本身在 visibility.js —— 这里只负责把它用在推送上，
 * 不自己比对角色字符串（否则 REST 与 SSE 会各写一份规则）。
 */
import { canReceiveEvent } from './visibility.js';

const clients = new Set();
const HEARTBEAT_MS = 25_000;

function write(client, event, data) {
  try {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // 连接已断，交给 close 事件清理
  }
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
    if (canReceiveEvent(client, event)) write(client, 'items', event);
  }
}

/** 账号/申请变更：仅 admin 可收到。 */
export function broadcastAdmin(kind, payload = {}) {
  const event = { scope: 'admin', kind, ...payload };
  for (const client of clients) {
    if (canReceiveEvent(client, event)) write(client, 'admin', event);
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
