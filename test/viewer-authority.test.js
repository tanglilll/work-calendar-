/**
 * viewer 的权威来源 —— 推送时现取，连接里不存 role 副本。
 *
 * 缺口（本文件先复现、后守住）：SSE 客户端在连接那一刻把 role 抄进连接表，
 * 于是把一个人从 admin 降为 user，他的旧连接**仍然收到 admin 事件** ——
 * 「可见性在服务端过滤、前端不被信任」这条承诺在长连接上漏了。
 *
 * 判据的输入没有变（仍是 visibility.js 的 canReceiveEvent(viewer, event)），
 * 变的是 viewer 从哪来：role 在每次推送时向 accounts 现查（组合根注入的 roleOf）。
 *
 * 写法的取舍：全部走真实路由（登录、建流、改角色、删账号）+ 桩 res 按 SSE 的
 * wire format 解析 —— 断言面对的是「这个连接实际收到了什么」，不靠代码推理。
 * 桩 res 与解析照 test/sse.test.js 的既有写法。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { freshWorld, draft } from '../test-helpers/world.js';
import {
  CHANGE_KINDS,
  accountChanged,
  accountDeleted,
  adminsChanged,
  isChange,
  ownerChanged,
} from '../server/changes.js';
import { createSse } from '../server/sse.js';

const sourceOf = (file) => readFileSync(new URL(`../server/${file}`, import.meta.url), 'utf8');

/**
 * 桩 res：只记下写出的内容，不真发。`events()` 按 SSE 的 wire format 解析成
 * 客户端实际收到的事件；`emit` 用来模拟浏览器断开或写入失败。
 */
function stubRes() {
  const handlers = new Map();
  const chunks = [];
  return {
    chunks,
    status: 0,
    ended: false,
    writeHead(status) {
      this.status = status;
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
    emit(event) {
      handlers.get(event)?.();
    },
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
          return {
            event: name.slice('event: '.length),
            data: data ? JSON.parse(data.slice('data: '.length)) : null,
          };
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

const eventsNamed = (res, name) => res.events().filter((e) => e.event === name);

describe('降权：旧连接按推送时的权威 role 重判', () => {
  test('降权后旧连接不再收到 admin 事件，且仍收到定向的 self 事件', async () => {
    const { app, zhao } = freshWorld();
    const adminCookie = await login(app, 'admin', 'password-1');
    const zhaoCookie = await login(app, 'zhao');

    // 先把 zhao 提为 admin 再连接：连接那一刻的快照确实是 admin
    const promoted = await api(app, {
      method: 'PATCH',
      path: `/api/admin/accounts/${zhao.id}`,
      body: { role: 'admin' },
      cookie: adminCookie,
    });
    assert.equal(promoted.status, 200);

    const zhaoClient = await connect(app, zhaoCookie);
    assert.deepEqual(zhaoClient.events()[0], {
      event: 'hello',
      data: { accountId: zhao.id, role: 'admin' },
    });

    // 前提：此刻他确实收得到 admin 事件
    app.sse.publish([adminsChanged('accounts')]);
    assert.equal(eventsNamed(zhaoClient, 'admin').length, 1, '前提：admin 的旧连接收得到 admin 事件');

    // 降为 user：旧连接保留，但判据必须按**新**角色重判
    const before = zhaoClient.events().length;
    const demoted = await api(app, {
      method: 'PATCH',
      path: `/api/admin/accounts/${zhao.id}`,
      body: { role: 'user' },
      cookie: adminCookie,
    });
    assert.equal(demoted.status, 200);

    const afterDemotion = zhaoClient.events().slice(before);
    assert.deepEqual(
      afterDemotion.filter((e) => e.event === 'admin'),
      [],
      '降权后旧连接仍然收到 admin 事件（连接里存的是连接那一刻的 role 快照）',
    );
    assert.deepEqual(
      afterDemotion.filter((e) => e.event === 'self').map((e) => e.data.kind),
      ['role-changed'],
      '连接不能被打死：定向通知照常到达',
    );

    // 之后的 admin 事件同样到不了这条旧连接
    app.sse.publish([adminsChanged('requests')]);
    assert.deepEqual(
      zhaoClient.events().slice(before).filter((e) => e.event === 'admin'),
      [],
      '降权之后每一次推送都按当前角色判',
    );
    app.close();
  });

  test('降权后旧连接仍收得到它按新角色应得的事项事件', async () => {
    const { app, admin, zhao, lin } = freshWorld();
    const adminCookie = await login(app, 'admin', 'password-1');
    const zhaoCookie = await login(app, 'zhao');

    await api(app, {
      method: 'PATCH',
      path: `/api/admin/accounts/${zhao.id}`,
      body: { role: 'admin' },
      cookie: adminCookie,
    });
    const { item } = app.items.createItem(zhao, draft({ title: '降权前建的' }));
    const zhaoClient = await connect(app, zhaoCookie);
    const linClient = await connect(app, await login(app, 'lin'));

    await api(app, {
      method: 'PATCH',
      path: `/api/admin/accounts/${zhao.id}`,
      body: { role: 'user' },
      cookie: adminCookie,
    });

    const before = zhaoClient.events().length;
    app.sse.publish([ownerChanged(item.id, [zhao.id], 'updated')]);

    assert.deepEqual(
      zhaoClient.events().slice(before).map((e) => e.event),
      ['items'],
      '降权只是按新角色过滤，不是把连接打死',
    );
    assert.deepEqual(
      linClient.events().map((e) => e.event),
      ['hello'],
      '回归：与这条事项无关的 user 收不到任何事件',
    );
    app.close();
  });
});

describe('删账号：连接被断开', () => {
  test('删账号之后该账号的连接被结束，且不再向它写入', async () => {
    const { app, admin, zhao } = freshWorld();
    const adminCookie = await login(app, 'admin', 'password-1');
    const zhaoClient = await connect(app, await login(app, 'zhao'));
    const adminClient = await connect(app, adminCookie);

    const deleted = await api(app, {
      method: 'DELETE',
      path: `/api/admin/accounts/${zhao.id}`,
      cookie: adminCookie,
    });
    assert.equal(deleted.status, 200);

    assert.equal(zhaoClient.ended, true, '账号已删除，它的连接应当被断开而不是留着占位');

    const before = zhaoClient.chunks.length;
    app.sse.publish([ownerChanged(1, [zhao.id], 'updated')]);
    assert.equal(zhaoClient.chunks.length, before, '断开之后不再向它写入');
    assert.equal(eventsNamed(adminClient, 'items').length, 1, '其余连接照常收到（控制）');
    app.close();
  });

  test('中枢的断开能力由词表表达：connections / account-deleted', () => {
    const change = accountDeleted(7);
    assert.deepEqual(change, { to: 'connections', accountIds: [7], kind: 'account-deleted' });
    assert.ok(isChange(change), '断开是词表构造函数产出的变更');
    assert.ok(CHANGE_KINDS.connections.includes('account-deleted'), 'kind 在词表里');
    assert.throws(() => accountDeleted('7'), /账号 id/);
  });

  test('同一个账号的多条连接：先关掉一条不影响按账号断开的寻址', () => {
    const hub = createSse({ roleOf: () => 'user' });
    const first = stubRes();
    const second = stubRes();
    const other = stubRes();
    hub.addClient(first, { id: 7, role: 'user' });
    hub.addClient(second, { id: 7, role: 'user' });
    hub.addClient(other, { id: 8, role: 'user' });

    first.emit('close'); // 对端先断一条：索引里必须还留着同账号的另一条

    hub.publish([accountDeleted(7)]);
    assert.equal(second.ended, true, '同账号的另一条连接也要被结束');
    assert.equal(other.ended, false, '别的账号的连接不动');

    const before = second.chunks.length;
    hub.publish([ownerChanged(1, [7], 'updated')]);
    assert.equal(second.chunks.length, before, '断开之后不再向它写入');
  });

  test('publish 里的断开：只断指定账号，手写的进不来', () => {
    const hub = createSse({ roleOf: () => 'user' });
    const mine = stubRes();
    const theirs = stubRes();
    hub.addClient(mine, { id: 7, role: 'user' });
    hub.addClient(theirs, { id: 8, role: 'user' });

    assert.throws(
      () => hub.publish([{ to: 'connections', accountIds: [7], kind: 'account-deleted' }]),
      /构造函数/,
      '手写的断开描述进不了 publish —— 与其余变更同一个关口',
    );
    assert.equal(mine.ended, false, '非法变更不产生任何断开');

    hub.publish([accountDeleted(7)]);
    assert.equal(mine.ended, true, '被删账号的连接被结束');
    assert.equal(theirs.ended, false, '别的账号的连接不动');

    const before = mine.chunks.length;
    hub.publish([ownerChanged(1, [7], 'updated')]);
    assert.equal(mine.chunks.length, before, '断开之后不再向它写入');

    hub.publish([ownerChanged(2, [8], 'updated')]);
    assert.equal(eventsNamed(theirs, 'items').length, 1, '其余连接照常收到');
    assert.equal(mine.chunks.length, before, '被断开的那条始终没再收到东西');
  });
});

describe('viewer 现取：同一条连接随权威 role 变化重判', () => {
  test('三条投递路径都按推送时的 role 判，不按连接时的角色', () => {
    let role = 'admin';
    const hub = createSse({ roleOf: () => role });
    const client = stubRes();
    hub.addClient(client, { id: 7, role: 'admin' });

    hub.publish([adminsChanged('accounts')]);
    assert.equal(eventsNamed(client, 'admin').length, 1, '前提：admin 时期收得到 admin 事件');

    role = 'user'; // 权威值变了，连接没有重连
    hub.publish([adminsChanged('requests')]);
    assert.equal(eventsNamed(client, 'admin').length, 1, '降权后同一条连接不再收 admin 事件');

    hub.publish([ownerChanged(42, [7], 'updated')]);
    assert.equal(eventsNamed(client, 'items').length, 1, '自己的事项事件照常到（连接没被打死）');

    hub.publish([ownerChanged(43, [8], 'updated')]);
    assert.equal(eventsNamed(client, 'items').length, 1, '回归：user 收不到他人的事项事件');

    hub.publish([accountChanged([7], 'invites-changed')]);
    assert.equal(eventsNamed(client, 'self').length, 1, '发给自己的定向事件到得了');
    hub.publish([accountChanged([8], 'invites-changed')]);
    assert.equal(eventsNamed(client, 'self').length, 1, '别人的定向事件不外溢');

    role = null; // 账号已不存在
    hub.publish([ownerChanged(44, [7], 'updated'), adminsChanged('accounts'), accountChanged([7], 'signed-in')]);
    assert.equal(eventsNamed(client, 'items').length, 1, '账号不在了什么都收不到');
    assert.equal(eventsNamed(client, 'admin').length, 1);
    assert.equal(eventsNamed(client, 'self').length, 1);
  });

  test('close 之后 authorities 不再被查（连接表已摘掉）', () => {
    let lookups = 0;
    const hub = createSse({
      roleOf: () => {
        lookups += 1;
        return 'user';
      },
    });
    const client = stubRes();
    hub.addClient(client, { id: 7, role: 'user' });

    client.emit('close');
    hub.publish([ownerChanged(1, [7], 'updated')]);
    assert.equal(lookups, 0, '已经摘掉的连接不会再问权威值');
  });
});

describe('三条投递路径同源（静态检查）', () => {
  test('sse.js 只有一个投递判据调用点，投递与寻址都不自己比较账号 id', () => {
    const src = sourceOf('sse.js');
    assert.equal(
      (src.match(/canReceiveEvent\(/g) ?? []).length,
      1,
      '三条路径都从 deliver 这一个出口走，判据只有一处',
    );
    assert.doesNotMatch(
      src,
      /accountId\s*(===|!==|==|!=)|(===|!==|==|!=)\s*accountId/,
      'sse.js 不再自己做账号比较（定向与断开都靠词表寻址 + 判据）',
    );
    assert.doesNotMatch(src, /client\.role/, '连接记录里没有 role 可读：role 一律现查');
  });

  test('viewer 的权威来源由组合根接线：中枢问 accounts.roleOf', () => {
    assert.match(sourceOf('app.js'), /createSse\(\{\s*roleOf/, '组合根把权威角色接进中枢');
    assert.match(sourceOf('accounts.js'), /function roleOf\(accountId\)/, 'accounts 现查角色');
    assert.match(sourceOf('visibility.js'), /export function canReceiveEvent/, '判据仍只有一处');
  });

  test('createSse 缺 roleOf 直接炸：没有权威来源就没有判据', () => {
    assert.throws(() => createSse(), /roleOf/);
    assert.throws(() => createSse({ heartbeatMs: 5 }), /roleOf/);
  });
});
