/**
 * 删事项级联删掉待接受邀请时，被邀请人要收到定向通知。
 *
 * 缺口（本文件先复现、后守住）：一条事项被删除时，它的待接受邀请随外键级联消失
 * （item_invites.item_id 的 ON DELETE CASCADE），但被邀请人收不到任何通知 ——
 * 他还不是 owner，收不到 items 那一路；他的「邀请」角标因此停在旧值，
 * 点进去那条邀请已经没了（或点了报错），直到下一次全量重拉才对上。
 * 对照：删账号级联删掉它发出的邀请时，被邀请人会收到定向通知
 * （accounts.deleteAccount → accountChanged(..., 'invites-changed')），本文件补的是删事项这半边。
 *
 * 写法的取舍：全部走真实路由（登录、建流、发邀请、DELETE 事项）+ 桩 res
 * 按 SSE 的 wire format 解析 —— 断言面对的是「这个连接实际收到了什么」，
 * 不靠代码推理。桩 res 与解析照 test/sse.test.js / test/viewer-authority.test.js 的既有写法。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { freshWorld, draft } from '../test-helpers/world.js';

const sourceOf = (file) => readFileSync(new URL(`../server/${file}`, import.meta.url), 'utf8');

/** 桩 res：只记下写出的内容，不真发。`events()` 按 SSE 的 wire format 解析。 */
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

/** 注册→批准一个与事项无关的账号（用来证明变更不外溢）。 */
function member(app, username) {
  app.accounts.submitRegistrationRequest({ username, password: 'password-2', note: '' });
  const pending = app.accounts.listRequests().find((r) => r.username === username);
  return app.accounts.approveRequest(pending.id).account;
}

const selfEvents = (res) => res.events().filter((e) => e.event === 'self');

describe('删事项：待接受邀请随级联消失时，被邀请人收到定向通知', () => {
  test('经 REST 删事项：被邀请人收到 self/invites-changed，他的角标立刻归零', async () => {
    const { app, zhao, lin } = freshWorld();
    const wang = member(app, 'wang'); // 与这条事项毫无关系的人

    // 各登录一次并复用 cookie：重复登录会给自己的连接再发一条 self/signed-in，
    // 那与本次要断言的东西无关，只会让事件流变噪。
    const zhaoCookie = await login(app, 'zhao');
    const linClient = await connect(app, await login(app, 'lin'));
    const wangClient = await connect(app, await login(app, 'wang'));
    const zhaoClient = await connect(app, zhaoCookie);

    // 前提：zhao 建一条事项，邀请 lin；lin 的角标是 1
    const created = await api(app, {
      method: 'POST',
      path: '/api/items',
      body: draft(),
      cookie: zhaoCookie,
    });
    assert.equal(created.status, 201);
    const itemId = created.body.item.id;
    app.invites.invite(itemId, lin.id, zhao);
    assert.equal(app.invites.countFor(lin), 1, '前提：lin 有一条待接受邀请');

    // 清掉连接上的历史事件，只看删除这一刻发生了什么
    linClient.chunks.length = 0;
    wangClient.chunks.length = 0;
    zhaoClient.chunks.length = 0;

    const deleted = await api(app, {
      method: 'DELETE',
      path: `/api/items/${itemId}`,
      cookie: zhaoCookie,
    });
    assert.equal(deleted.status, 200);

    assert.equal(app.invites.countFor(lin), 0, '邀请确实随事项级联消失了（前提）');
    assert.equal(app.invites.listFor(lin).length, 0);
    assert.deepEqual(
      selfEvents(linClient).map((e) => e.data),
      [{ scope: 'self', accountId: lin.id, kind: 'invites-changed' }],
      '被邀请人必须收到定向通知：他的角标要立刻准，而不是停在旧值等下一次全量重拉',
    );
    assert.deepEqual(
      linClient.events().map((e) => e.event),
      ['self'],
      '被邀请人还不是 owner，他不该收到 items 那一路（只有角标要动）',
    );

    // 发起人（owner）照旧收 items/deleted
    assert.deepEqual(
      zhaoClient.events(),
      [
        {
          event: 'items',
          data: { scope: 'items', ownerId: zhao.id, kind: 'deleted', itemId },
        },
      ],
      'owner 收的是 items/deleted',
    );

    // 无关账号：一条事件都不该收到
    assert.deepEqual(
      wangClient.events(),
      [],
      '与这条事项无关的账号收不到这次删除的任何变更',
    );
    app.close();
  });

  test('多个被邀请人各收一条；已是 owner 的人不重复出现在定向名单里', async () => {
    const { app, zhao, lin } = freshWorld();
    const wang = member(app, 'wang');

    const linClient = await connect(app, await login(app, 'lin'));
    const wangClient = await connect(app, await login(app, 'wang'));

    const { item } = app.items.createItem(zhao, draft());
    app.invites.invite(item.id, lin.id, zhao);
    app.invites.invite(item.id, wang.id, zhao);

    linClient.chunks.length = 0;
    wangClient.chunks.length = 0;

    const { changed } = app.items.deleteItem(zhao, item.id);
    app.sse.publish(changed);

    assert.deepEqual(
      changed,
      [
        { to: 'itemOwners', ownerIds: [zhao.id], itemId: item.id, kind: 'deleted' },
        { to: 'accounts', accountIds: [lin.id, wang.id], kind: 'invites-changed' },
      ],
      '两个被邀请人合成一条定向变更（owner 不在里面——他收的是上面那路）',
    );
    assert.deepEqual(selfEvents(linClient).map((e) => e.data.kind), ['invites-changed']);
    assert.deepEqual(selfEvents(wangClient).map((e) => e.data.kind), ['invites-changed']);
    app.close();
  });

  test('没有待接受邀请时，changed 里不出现多余的 accounts 一路', async () => {
    const { app, admin } = freshWorld();
    const adminClient = await connect(app, await login(app, 'admin', 'password-1'));

    const { item } = app.items.createItem(admin, draft());
    adminClient.chunks.length = 0;

    const { changed } = app.items.deleteItem(admin, item.id);

    assert.deepEqual(
      changed,
      [{ to: 'itemOwners', ownerIds: [admin.id], itemId: item.id, kind: 'deleted' }],
      '没有人受影响就不产生多余的定向变更',
    );
    assert.deepEqual(selfEvents(adminClient), [], '线上也不该多出一条 self 事件');
    app.close();
  });

  test('items.js 不 import invites.js：待邀请人经组合根注入（依赖不回流）', () => {
    assert.doesNotMatch(
      sourceOf('items.js'),
      /from '\.\/invites\.js'/,
      'invites 已经依赖 items（createInvites(store, items)），items 不能再 import invites',
    );
    assert.match(
      sourceOf('app.js'),
      /createPendingInviteesOf\(/,
      '组合根把「取待邀请人」的读取器接进 items',
    );
  });
});
