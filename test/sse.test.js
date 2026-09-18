/**
 * SSE 广播中枢。在组合根层测：两个 createApp 各持一套中枢、互不串台，
 * 且一次 publish 之后「哪些客户端收到了什么事件」可以被断言。
 *
 * 客户端用桩 res 记录写出的字节（这就是真实连接上收到的内容），
 * 不开监听端口、不碰网络、不等心跳的真实间隔。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { freshWorld, draft } from '../test-helpers/world.js';
import { createSse } from '../server/sse.js';
import { adminsChanged, ownerChanged } from '../server/changes.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 桩 res：只记下写出的内容，不真发。`events()` 按 SSE 的 wire format 解析，
 * 于是断言面对的是「客户端实际收到的事件」而不是内部状态。
 */
function stubRes() {
  const handlers = new Map();
  const chunks = [];
  return {
    chunks,
    headersSent: false,
    status: 0,
    headers: null,
    ended: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    end() {
      this.ended = true;
    },
    on(event, fn) {
      handlers.set(event, fn);
    },
    /** 触发一次连接事件（close / error），模拟浏览器断开或写入失败 */
    emit(event) {
      handlers.get(event)?.();
    },
    /** 收到的 SSE 事件，按顺序：[{ event, data }]；`retry:` 与注释行（: ping）不进结果。 */
    events() {
      return chunks
        .join('')
        .split('\n\n')
        .map((block) => block.trim())
        .map((block) => {
          const lines = block.split('\n');
          const name = lines.find((l) => l.startsWith('event: '));
          if (!name) return null;
          const data = lines.find((l) => l.startsWith('data: '));
          return { event: name.slice('event: '.length), data: data ? JSON.parse(data.slice('data: '.length)) : null };
        })
        .filter(Boolean);
    },
  };
}

/** 走真实路由登录一次，取回会话 cookie。 */
async function login(app, username, password = 'password-2') {
  const req = {
    method: 'POST',
    headers: { host: 'local' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ username, password }));
    },
  };
  let cookie = null;
  const res = {
    headersSent: false,
    writeHead(status, headers) {
      cookie = headers['Set-Cookie'] ?? null;
    },
    write() {},
    end() {},
    on() {},
  };
  await app.handleApi(req, res, new URL('/api/login', 'http://local'));
  assert.ok(cookie, `${username} 登录应当拿到 cookie`);
  return cookie.split(';')[0];
}

/** 走真实的 /api/events 路由建一条连接，返回记录收到的字节的桩 res。 */
async function connect(app, cookie) {
  const res = stubRes();
  const req = {
    method: 'GET',
    headers: { host: 'local', cookie },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {},
  };
  await app.handleApi(req, res, new URL('/api/events', 'http://local'));
  return res;
}

/** 一次接口调用。返回 { status, body }。 */
async function api(app, { method = 'GET', path, body, cookie } = {}) {
  const req = {
    method,
    headers: { host: 'local', ...(cookie ? { cookie } : {}) },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
  const captured = { status: 0, raw: null };
  const res = {
    headersSent: false,
    writeHead(status) {
      captured.status = status;
    },
    write() {},
    end(chunk) {
      captured.raw = chunk ?? null;
    },
    on() {},
  };
  await app.handleApi(req, res, new URL(path, 'http://local'));
  return { status: captured.status, body: captured.raw ? JSON.parse(captured.raw) : null };
}

describe('SSE 广播中枢', () => {
  test('向 A 的客户端 publish，B 的客户端收不到', async () => {
    const a = freshWorld();
    const b = freshWorld();
    const aCookie = await login(a.app, 'zhao');
    const bCookie = await login(b.app, 'zhao');
    const aClient = await connect(a.app, aCookie);
    const bClient = await connect(b.app, bCookie);

    assert.notEqual(a.app.sse, b.app.sse, '两个组合根各自创建中枢，不共用模块状态');

    // 在 A 里建一条事项：领域层会产生一条 items 变更，经 routes 交给 A 的中枢
    const created = await api(a.app, { method: 'POST', path: '/api/items', body: draft(), cookie: aCookie });
    assert.equal(created.status, 201);

    assert.deepEqual(
      aClient.events().map((e) => e.event),
      ['hello', 'items'],
      'A 的客户端应当收到 A 的 items 事件',
    );
    assert.deepEqual(
      bClient.events().map((e) => e.event),
      ['hello'],
      'B 的客户端不该收到 A 的事件：两个组合根各持一套中枢',
    );

    a.app.close();
    b.app.close();
  });

  test('一次 publish 之后，哪些客户端收到什么事件可以逐条断言', async () => {
    const { app, admin, zhao, lin } = freshWorld();
    const hub = app.sse;
    const zhaoClient = await connect(app, await login(app, 'zhao'));
    const linClient = await connect(app, await login(app, 'lin'));
    const adminClient = await connect(app, await login(app, 'admin', 'password-1'));

    // 事项事件：owner 收到，能看全部事项的 admin 也收到，其他 user 收不到
    hub.publish([ownerChanged(42, [zhao.id], 'updated')]);

    const itemsPayload = { scope: 'items', ownerId: zhao.id, kind: 'updated', itemId: 42 };
    assert.deepEqual(zhaoClient.events(), [
      { event: 'hello', data: { accountId: zhao.id, role: 'user' } },
      { event: 'items', data: itemsPayload },
    ]);
    assert.deepEqual(adminClient.events(), [
      { event: 'hello', data: { accountId: admin.id, role: 'admin' } },
      { event: 'items', data: itemsPayload },
    ]);
    assert.deepEqual(
      linClient.events().map((e) => e.event),
      ['hello'],
      '与这条事项无关的 user 不该收到任何事件',
    );

    // admin 事件：只到 admin
    hub.publish([adminsChanged('accounts')]);
    assert.deepEqual(adminClient.events().at(-1), { event: 'admin', data: { scope: 'admin', kind: 'accounts' } });
    assert.deepEqual(linClient.events().map((e) => e.event), ['hello'], 'user 收不到 admin 事件');

    // 账号定向事件：只到那个账号（这里是 lin）；事件带上收件账号，判据据此裁决
    hub.broadcastToAccount(lin.id, 'invites-changed');
    assert.deepEqual(linClient.events().at(-1), {
      event: 'self',
      data: { scope: 'self', accountId: lin.id, kind: 'invites-changed' },
    });
    assert.deepEqual(zhaoClient.events().map((e) => e.event), ['hello', 'items'], '定向事件不外溢到别的账号');

    // 断开连接后再 publish，不再写给它
    const before = zhaoClient.events().length;
    zhaoClient.emit('close');
    hub.publish([ownerChanged(43, [zhao.id], 'deleted')]);
    assert.equal(zhaoClient.events().length, before, 'close 之后该客户端已被移出连接表');
    assert.equal(adminClient.events().at(-1).data.kind, 'deleted', '其余连接照常收到');

    app.close();
  });

  test('closeAll 关掉全部连接，之后不再写入', async () => {
    const hub = createSse({ roleOf: () => 'user' });
    const client = stubRes();
    hub.addClient(client, { id: 7, role: 'user' });

    hub.closeAll();
    assert.equal(client.ended, true, 'closeAll 应当结束连接');

    hub.publish([ownerChanged(1, [7], 'updated')]);
    assert.deepEqual(
      client.events().map((e) => e.event),
      ['hello'],
      '关掉之后的中枢不再持有任何客户端',
    );
  });

  test('心跳只写自己这套中枢的客户端', async () => {
    const stubAuthority = { roleOf: () => 'user' };
    const pinged = createSse({ ...stubAuthority, heartbeatMs: 5 });
    const other = createSse({ ...stubAuthority, heartbeatMs: 5 });
    const mine = stubRes();
    const theirs = stubRes();
    pinged.addClient(mine, { id: 1, role: 'user' });
    other.addClient(theirs, { id: 1, role: 'user' });

    const timer = pinged.startHeartbeat();
    const gotPing = await waitFor(() => mine.chunks.some((c) => c.includes(': ping')));
    clearInterval(timer);

    assert.ok(gotPing, '自己的客户端应当收到心跳');
    assert.ok(
      !theirs.chunks.some((c) => c.includes(': ping')),
      '心跳不该写到另一套中枢的客户端上',
    );
  });

  test('routes.js 与入口都不再直接依赖 sse.js（中枢由组合根注入）', () => {
    const source = (p) => readFileSync(join(HERE, '..', 'server', p), 'utf8');
    assert.ok(!/from '\.\/sse\.js'/.test(source('routes.js')), 'routes.js 不该 import sse.js');
    assert.ok(!/from '\.\/sse\.js'/.test(source('index.js')), '入口不该 import sse.js，心跳走注入的中枢');
    assert.match(source('app.js'), /createSse\(\{/, '组合根是唯一创建中枢的地方');
    assert.match(source('app.js'), /createApi\(\{[^}]*\bsse\b[^}]*\}\)/, '中枢随其余 module 一起注入 routes');
  });
});

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !predicate()) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}
