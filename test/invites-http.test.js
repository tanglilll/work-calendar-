/**
 * 邀请接口。在 HTTP 接缝上测：桩 req/res 直接喂给 handleApi，
 * 不开监听端口、不碰网络——这一层只验接口形状、状态码与越权，细节交给领域测试。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { freshWorld, draft } from '../test-helpers/world.js';

/** 一次接口调用。返回 { status, body }；body 已解析。cookie 由 login 取出后回传。 */
async function api(app, { method = 'GET', path, body, cookie } = {}) {
  const req = {
    method,
    headers: { host: 'local', ...(cookie ? { cookie } : {}) },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };

  const captured = { status: 0, headers: null, raw: null };
  const res = {
    headersSent: false,
    writeHead(status, headers) {
      captured.status = status;
      captured.headers = headers;
    },
    write() {},
    end(chunk) {
      captured.raw = chunk ?? null;
    },
    on() {},
  };

  try {
    await app.handleApi(req, res, new URL(path, 'http://local'));
  } catch (err) {
    // handleApi 是把错误抛出来的，映射成响应是入口（index.js）的职责。
    // 这里只取状态码，不复制那份映射逻辑。
    return { status: Number(err?.status) || 500, error: err, body: null, setCookie: null };
  }
  return {
    status: captured.status,
    body: captured.raw ? JSON.parse(captured.raw) : null,
    setCookie: captured.headers?.['Set-Cookie'] ?? null,
  };
}

async function login(app, username, password = 'password-2') {
  const res = await api(app, { method: 'POST', path: '/api/login', body: { username, password } });
  assert.equal(res.status, 200, `${username} 登录应当成功`);
  return res.setCookie.split(';')[0];
}

describe('邀请接口', () => {
  test('发邀请 → 对方看到待接受 → 接受 → 该事项出现在对方列表里', async () => {
    const { app, zhao, lin } = freshWorld();
    const zhaoCookie = await login(app, 'zhao');
    const linCookie = await login(app, 'lin');

    const created = await api(app, { method: 'POST', path: '/api/items', body: draft(), cookie: zhaoCookie });
    assert.equal(created.status, 201);
    const itemId = created.body.item.id;

    const invited = await api(app, {
      method: 'POST',
      path: `/api/items/${itemId}/invites`,
      body: { account_id: lin.id },
      cookie: zhaoCookie,
    });
    assert.equal(invited.status, 201);

    const pending = await api(app, { method: 'GET', path: '/api/invites', cookie: linCookie });
    assert.equal(pending.status, 200);
    assert.equal(pending.body.items.length, 1);
    assert.equal(pending.body.items[0].title, '写周报');
    assert.equal(pending.body.items[0].invited_by_name, 'zhao');
    assert.equal(pending.body.count, 1, '角标计数与列表一起给，前端不必再算');

    // 待接受期间还看不见事项
    const before = await api(app, { method: 'GET', path: '/api/items', cookie: linCookie });
    assert.equal(before.body.items.length, 0);

    const accepted = await api(app, {
      method: 'POST',
      path: `/api/invites/${pending.body.items[0].id}/accept`,
      cookie: linCookie,
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.body.item.owners.map((o) => o.username).sort(), ['lin', 'zhao']);

    const after = await api(app, { method: 'GET', path: '/api/items', cookie: linCookie });
    assert.equal(after.body.items.length, 1, '接受之后才看得见');
    const empty = await api(app, { method: 'GET', path: '/api/invites', cookie: linCookie });
    assert.equal(empty.body.count, 0);
    app.close();
  });

  test('拒绝即消失，且事项不会出现', async () => {
    const { app, zhao, lin } = freshWorld();
    const zhaoCookie = await login(app, 'zhao');
    const linCookie = await login(app, 'lin');

    const itemId = (
      await api(app, { method: 'POST', path: '/api/items', body: draft(), cookie: zhaoCookie })
    ).body.item.id;
    await api(app, {
      method: 'POST',
      path: `/api/items/${itemId}/invites`,
      body: { account_id: lin.id },
      cookie: zhaoCookie,
    });

    const pending = await api(app, { method: 'GET', path: '/api/invites', cookie: linCookie });
    const rejected = await api(app, {
      method: 'POST',
      path: `/api/invites/${pending.body.items[0].id}/reject`,
      cookie: linCookie,
    });
    assert.equal(rejected.status, 200);

    const after = await api(app, { method: 'GET', path: '/api/invites', cookie: linCookie });
    assert.equal(after.body.count, 0);
    const items = await api(app, { method: 'GET', path: '/api/items', cookie: linCookie });
    assert.equal(items.body.items.length, 0);
    app.close();
  });

  test('别人的邀请轮不到你处理', async () => {
    const { app, zhao, lin } = freshWorld();
    const zhaoCookie = await login(app, 'zhao');
    const linCookie = await login(app, 'lin');

    const itemId = (
      await api(app, { method: 'POST', path: '/api/items', body: draft(), cookie: zhaoCookie })
    ).body.item.id;
    await api(app, {
      method: 'POST',
      path: `/api/items/${itemId}/invites`,
      body: { account_id: lin.id },
      cookie: zhaoCookie,
    });
    const pending = await api(app, { method: 'GET', path: '/api/invites', cookie: linCookie });

    const stolen = await api(app, {
      method: 'POST',
      path: `/api/invites/${pending.body.items[0].id}/accept`,
      cookie: zhaoCookie,
    });
    assert.equal(stolen.status, 403, '只有被邀请人本人能处理');
    app.close();
  });

  test('未登录碰不到邀请接口', async () => {
    const { app } = freshWorld();
    for (const [method, path] of [
      ['GET', '/api/invites'],
      ['POST', '/api/invites/1/accept'],
      ['POST', '/api/items/1/invites'],
    ]) {
      const res = await api(app, { method, path, body: method === 'POST' ? {} : undefined });
      assert.equal(res.status, 401, `${method} ${path} 应当要求登录`);
    }
    app.close();
  });
});
