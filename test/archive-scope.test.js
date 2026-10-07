/**
 * 归档视图的可见范围：每个人都能看**自己参与过的**已完成事项，别人的看不到；admin 看全部。
 *
 * 这一条同时钉两个面：
 * - 领域层（`items.listArchived`）——可见范围用 visibility.js 的 memberScope，不看角色；
 * - 接口层（`GET /api/archive`）——路径与形状是契约：它在 `/api/archive`，不在 admin 命名空间下
 *   （那个前缀留给 admin 独占的操作），返回体仍是 `{ items }`。
 *
 * 判据的**唯一落点**在服务端：`test/tableview.test.js` 那边只断言前端不自己判角色（开关对所有人都在），
 * 范围对不对由这里说了算——前端不被信任（见 visibility.js 的说明）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { freshWorld, draft } from '../test-helpers/world.js';

/** 一次接口调用。返回 { status, body }；cookie 由 login 取出后回传（与 invites-http.test.js 同形）。 */
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

/** 用 admin 建一条、归档一条，返回归档后的行。 */
function archivedBy(app, owner, over = {}) {
  const { item } = app.items.createItem(owner, draft(over));
  return app.items.archiveItem(owner, item.id, item.version).item;
}

describe('归档视图的可见范围（领域层）', () => {
  test('user 只看得到自己参与过的归档事项，别人的看不到', () => {
    const { app, admin, zhao, lin } = freshWorld();
    const zhaoArchived = archivedBy(app, zhao, { title: '赵做完的' });
    archivedBy(app, lin, { title: '林做完的' });

    assert.deepEqual(
      app.items.listArchived(zhao).map((row) => row.id),
      [zhaoArchived.id],
    );
    assert.deepEqual(app.items.listArchived(lin).map((row) => row.title), ['林做完的']);
    app.close();
  });

  test('manager 也一样：归档视图不给「全事项视野」那条短路', () => {
    const { app, admin, zhao } = freshWorld();
    // 把 zhao 提成 manager：未归档那边他及于全部，归档这边仍只给自己参与过的。
    // 角色改完要重新取一次账号对象——能力是从账号对象上读的，手里那个还是旧角色。
    app.accounts.changeRole(admin.id, zhao.id, 'manager');
    const zhaoAsManager = app.accounts.findAccountByUsername('zhao');
    const mineArchived = archivedBy(app, zhao, { title: '我做完的' });
    archivedBy(app, admin, { title: 'admin 做完的' });
    const adminActive = app.items.createItem(admin, draft({ title: 'admin 还没做完的' })).item;

    assert.deepEqual(
      app.items.listItems(zhaoAsManager).map((row) => row.id),
      [adminActive.id],
      '未归档：manager 看得到 admin 的事项（及于全部）',
    );
    assert.deepEqual(
      app.items.listArchived(zhaoAsManager).map((row) => row.id),
      [mineArchived.id],
      '归档：仍按「自己参与过的」过滤',
    );
    app.close();
  });

  test('共享事项：名单里任何一个人都看得到它（并列 owner，无主次）', () => {
    const { app, admin, zhao, lin } = freshWorld();
    const { item } = app.items.createItem(admin, draft({ owner_ids: [zhao.id, lin.id] }));
    app.items.archiveItem(admin, item.id, item.version);

    assert.deepEqual(app.items.listArchived(zhao).map((row) => row.id), [item.id]);
    assert.deepEqual(app.items.listArchived(lin).map((row) => row.id), [item.id]);
    app.close();
  });

  test('admin 看得到所有人的归档事项', () => {
    const { app, admin, zhao, lin } = freshWorld();
    archivedBy(app, zhao);
    archivedBy(app, lin);

    assert.equal(app.items.listArchived(admin).length, 2);
    app.close();
  });

  test('归档行带着 owner 名单（表格要标谁做的），且按归档时间倒序', () => {
    const { app, zhao } = freshWorld();
    const first = archivedBy(app, zhao, { title: '先归档的' });
    const second = archivedBy(app, zhao, { title: '后归档的' });
    const rows = app.items.listArchived(zhao);

    assert.deepEqual(rows.map((row) => row.id), [second.id, first.id], '最近归档的排前面');
    assert.deepEqual(rows[0].owners.map((o) => o.username), ['zhao']);
    app.close();
  });
});

describe('归档视图的接口（GET /api/archive）', () => {
  test('未登录 → 401；登录后各自只拿到自己那部分', async () => {
    const { app, admin, zhao, lin } = freshWorld();
    const zhaoArchived = archivedBy(app, zhao, { title: '赵做完的' });
    const linArchived = archivedBy(app, lin, { title: '林做完的' });

    assert.equal((await api(app, { path: '/api/archive' })).status, 401);

    const zhaoCookie = await login(app, 'zhao');
    const zhaoRes = await api(app, { path: '/api/archive', cookie: zhaoCookie });
    assert.equal(zhaoRes.status, 200);
    assert.deepEqual(
      zhaoRes.body.items.map((row) => row.id),
      [zhaoArchived.id],
    );

    const adminCookie = await login(app, 'admin', 'password-1');
    const adminRes = await api(app, { path: '/api/archive', cookie: adminCookie });
    assert.deepEqual(
      adminRes.body.items.map((row) => row.id).sort((a, b) => a - b),
      [zhaoArchived.id, linArchived.id].sort((a, b) => a - b),
      'admin 拿到的是两个人的',
    );
    app.close();
  });

  test('旧的 /api/admin/archive 已经不在（归档不属于 admin 命名空间）', async () => {
    const { app } = freshWorld();
    const adminCookie = await login(app, 'admin', 'password-1');
    const res = await api(app, { path: '/api/admin/archive', cookie: adminCookie });

    assert.equal(res.status, 404);
    app.close();
  });
});
