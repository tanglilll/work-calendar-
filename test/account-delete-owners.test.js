/**
 * 删账号摘掉共享事项的成员资格时，剩下的 owner 要收到一条带 itemId 的
 * items/updated，那些事项的 version 也要一起推进。
 *
 * 缺口（本文件先复现、后守住）：账号被删除时，它会从所有共享事项的 owner 名单里
 * 消失（item_owners.account_id 的 ON DELETE CASCADE），但 changed 里没有 itemOwners
 * 那一路、事项的 version 也没动。两条后果：
 *  - 别人的窗口里那些色块的归属文案停在旧名单；
 *  - 谁手里正好开着编辑框，保存时不会撞版本冲突（版本没变），一存就把
 *    「被删账号已不在名单」这件事实又写回去。
 *
 * 写法的取舍与 test/item-delete-invitees.test.js 相同：走真实路由（登录、建流、
 * 删账号、PATCH、列表）+ 桩 res 按 SSE wire format 解析 —— 断言面对的是
 * 「这个连接实际收到了什么」，不靠代码推理。
 *
 * 顺带守住 02 留的那条：唯一拥有的已归档事项随账号删除时，挂在它上面的待接受
 * 邀请也随级联消失，而「它发出的邀请」这个读取器覆盖不到「别人（如 admin）替它
 * 的事件事发的邀请」——那批被邀请人同样要收到定向通知。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { freshWorld, draft } from '../test-helpers/world.js';

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

/** 一次接口调用，返回 { status, body, error, setCookie }；httpError 映射成状态码。 */
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

/** 走真实登录路由取回会话 cookie。 */
async function login(app, username, password = 'password-2') {
  const res = await api(app, { method: 'POST', path: '/api/login', body: { username, password } });
  assert.equal(res.status, 200, `${username} 登录应当成功`);
  return res.setCookie.split(';')[0];
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

/** 注册 → 批准一个新账号，可选地把角色改成 manager/admin（改角色本身也走领域 API）。 */
function join(app, actor, username, role = 'user') {
  app.accounts.submitRegistrationRequest({ username, password: 'password-2', note: '' });
  const pending = app.accounts.listRequests().find((r) => r.username === username);
  const { account } = app.accounts.approveRequest(pending.id);
  return role === 'user' ? account : app.accounts.changeRole(actor.id, account.id, role).account;
}

/** 一次删账号（领域 API）：返回 changed，便于断言「产出了哪几条变更」。 */
const deleteAccount = (app, admin, targetId) => app.accounts.deleteAccount(admin.id, targetId);

const itemsEvents = (res) => res.events().filter((e) => e.event === 'items');

describe('删账号：共享事项的名单变了，剩下的人收到 items/updated、版本一起推进', () => {
  test('每位仍有资格的收件人各收到带 itemId 的 items/updated；无关的人与事项都不受牵连', async () => {
    const { app, admin, zhao, lin } = freshWorld();
    join(app, admin, 'wang'); // 与这些事项毫无关系的人
    join(app, admin, 'mgr', 'manager'); // 看得见所有事项，但不是名单成员

    // 共享 A：admin + zhao → 删掉 zhao 后只剩 admin
    const sharedA = app.items.createItem(
      admin,
      draft({ title: '共享 A', owner_ids: [admin.id, zhao.id] }),
    ).item;
    // 共享 B：admin + lin + zhao → 删掉 zhao 后剩两个人（收件人不止一个）
    const sharedB = app.items.createItem(
      admin,
      draft({ title: '共享 B', owner_ids: [admin.id, lin.id, zhao.id] }),
    ).item;
    // 与 zhao 无关的事项：一条变更都不该因这次删除而产出，版本也不该动
    const untouched = app.items.createItem(admin, draft({ title: '与 zhao 无关' })).item;

    const adminCookie = await login(app, 'admin', 'password-1');
    const adminClient = await connect(app, adminCookie);
    const zhaoClient = await connect(app, await login(app, 'zhao'));
    const linClient = await connect(app, await login(app, 'lin'));
    const wangClient = await connect(app, await login(app, 'wang'));
    const mgrClient = await connect(app, await login(app, 'mgr'));
    for (const res of [adminClient, zhaoClient, linClient, wangClient, mgrClient]) res.chunks.length = 0;

    const deleted = await api(app, {
      method: 'DELETE',
      path: `/api/admin/accounts/${zhao.id}`,
      cookie: adminCookie,
    });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.error?.message));

    // 仍是名单成员的人：各收一条带 itemId 的 items/updated
    // （admin 同时是 admin：每次广播都过他的可见性，所以 B 的两条他也都收）
    assert.deepEqual(
      itemsEvents(adminClient).map((e) => e.data),
      [
        { scope: 'items', ownerId: admin.id, kind: 'updated', itemId: sharedA.id },
        { scope: 'items', ownerId: admin.id, kind: 'updated', itemId: sharedB.id },
        { scope: 'items', ownerId: lin.id, kind: 'updated', itemId: sharedB.id },
      ],
      '名单里剩下的人要收到「这条事项的名单变了」——不是 deleted，也不带被删账号',
    );
    assert.deepEqual(
      itemsEvents(linClient).map((e) => e.data),
      [{ scope: 'items', ownerId: lin.id, kind: 'updated', itemId: sharedB.id }],
      '只在共享 B 的名单里的人：只收 B 那一条',
    );
    // manager 的可见性覆盖全部事项：他不是名单成员也收得到（每条变更按 ownerId 逐条推送，
    // 所以 B 的两条他各收一次）——这正是「收件人 = 撤权后仍有资格看见它的人」
    assert.deepEqual(
      itemsEvents(mgrClient).map((e) => e.data),
      [
        { scope: 'items', ownerId: admin.id, kind: 'updated', itemId: sharedA.id },
        { scope: 'items', ownerId: admin.id, kind: 'updated', itemId: sharedB.id },
        { scope: 'items', ownerId: lin.id, kind: 'updated', itemId: sharedB.id },
      ],
      'manager 看得见所有事项，名单变更同样要让他重拉',
    );
    // 与这些事项无关的账号：一条都不收
    assert.deepEqual(wangClient.events(), [], '无关账号收不到这次删除的任何变更');
    // 被删账号：连接被断开，断开前也没收到任何 items 事件
    assert.deepEqual(itemsEvents(zhaoClient), [], '被删账号不再是名单成员，收不到名单变更');
    assert.equal(zhaoClient.ended, true, '账号没了，它的连接要被断开（connections/account-deleted）');

    // 无关事项：没有它的 items 事件，版本也没动
    assert.equal(
      itemsEvents(adminClient).some((e) => e.data.itemId === untouched.id),
      false,
      '与 zhao 无关的事项不产出变更',
    );
    assert.equal(app.items.getItem(untouched.id).version, untouched.version, '无关事项的版本不动');

    // 名单里的收件人也不该收到 admin 那一路（那是 admin 自己的重拉）
    assert.deepEqual(
      linClient.events().map((e) => e.event),
      ['items'],
      'lin 不是 admin，只收事项那一路',
    );
    app.close();
  });

  test('每条受影响的共享事项各有自己的变更（带 itemId），收件人就是剩下的名单', () => {
    const { app, admin, zhao, lin } = freshWorld();
    const withAdmin = app.items.createItem(
      admin,
      draft({ title: '与 admin 共享', owner_ids: [admin.id, zhao.id] }),
    ).item;
    const withLin = app.items.createItem(
      admin,
      draft({ title: '与 lin 共享', owner_ids: [lin.id, zhao.id] }),
    ).item;

    const { changed } = deleteAccount(app, admin, zhao.id);

    assert.deepEqual(
      changed,
      [
        { to: 'itemOwners', ownerIds: [admin.id], kind: 'updated', itemId: withAdmin.id },
        { to: 'itemOwners', ownerIds: [lin.id], kind: 'updated', itemId: withLin.id },
        { to: 'connections', accountIds: [zhao.id], kind: 'account-deleted' },
        { to: 'admins', kind: 'accounts' },
      ],
      '两条共享事项各一条带 itemId 的变更；收件人是摘掉它之后剩下的名单',
    );
    for (const change of changed) {
      assert.equal(
        (change.ownerIds ?? []).includes(zhao.id),
        false,
        '被删账号不该出现在任何一条的收件人里——它已经不在了',
      );
    }
    app.close();
  });

  test('版本推进：删账号前拿到的 version 再保存会撞 409；列表里的名单不再含被删账号', async () => {
    const { app, admin, zhao } = freshWorld();
    const item = app.items.createItem(
      admin,
      draft({ title: '共享的', owner_ids: [admin.id, zhao.id] }),
    ).item;
    const stale = item.version;
    const cookie = await login(app, 'admin', 'password-1');

    deleteAccount(app, admin, zhao.id);

    assert.equal(app.items.getItem(item.id).version, stale + 1, '名单真的变了，版本要一起推进');

    const list = await api(app, { method: 'GET', path: '/api/items', cookie });
    assert.equal(list.status, 200);
    const row = list.body.items.find((i) => i.id === item.id);
    assert.ok(row, '共享事项本身留着（只是少了一个 owner）');
    assert.deepEqual(
      row.owners.map((o) => o.id),
      [admin.id],
      '列表接口返回的名单不再包含被删账号',
    );

    // 过期编辑框保存：撞版本冲突，而不是把「被删账号还在名单里」写回去
    const save = await api(app, {
      method: 'PATCH',
      path: `/api/items/${item.id}`,
      cookie,
      body: { version: stale, title: '过期编辑框还在写' },
    });
    assert.equal(save.status, 409, '版本已推进，过期的编辑框必须撞 409');
    assert.equal(save.error?.code, 'VERSION_CONFLICT');
    // 名单也没被那次保存写回去
    assert.deepEqual(app.items.getItem(item.id).owners.map((o) => o.id), [admin.id]);
    app.close();
  });

  test('没有共享事项时不产出多余的 itemOwners 变更（回归）', () => {
    const { app, admin, zhao } = freshWorld();
    const mine = app.items.createItem(admin, draft({ title: 'admin 自己的' })).item;

    const { changed } = deleteAccount(app, admin, zhao.id);

    assert.deepEqual(changed, [
      { to: 'connections', accountIds: [zhao.id], kind: 'account-deleted' },
      { to: 'admins', kind: 'accounts' },
    ]);
    assert.equal(app.items.getItem(mine.id).version, mine.version, '没有共享事项，版本不该动');
    app.close();
  });

  test('唯一 owner 的未归档事项走到这里就抛错，而不是默默留下一条没有 owner 的事项', () => {
    const { app, admin, zhao } = freshWorld();
    // deleteAccount 的门槛本该拦住这种账号（要求先转移），这里直接走 items 的操作
    const shared = app.items.createItem(
      admin,
      draft({ title: '共享的', owner_ids: [admin.id, zhao.id] }),
    ).item;
    const sole = app.items.createItem(zhao, draft({ title: 'zhao 唯一的未归档事项' })).item;

    assert.throws(() => app.items.detachOwner(zhao.id), /唯一 owner/, '走不到的状态要如实报告');

    assert.deepEqual(
      app.items.getItem(sole.id).owners.map((o) => o.id),
      [zhao.id],
      '抛错之后名单原样：不会出现一条谁都看不见、却还在库里的事项',
    );
    assert.deepEqual(
      app.items.getItem(shared.id).owners.map((o) => o.id),
      [admin.id, zhao.id],
      '先算清再写：抛错前一行都不写，共享事项的名单也原样',
    );
    assert.equal(app.items.getItem(shared.id).version, shared.version, '版本同样原样');
    app.close();
  });

  test('已归档的共享事项：名单照样摘干净，但不产出变更、不推进版本', () => {
    const { app, admin, zhao } = freshWorld();
    const shared = app.items.createItem(
      admin,
      draft({ title: '共享·已归档', owner_ids: [admin.id, zhao.id] }),
    ).item;
    const archived = app.items.archiveItem(admin, shared.id, shared.version).item;

    const { changed } = deleteAccount(app, admin, zhao.id);

    assert.deepEqual(
      changed,
      [
        { to: 'connections', accountIds: [zhao.id], kind: 'account-deleted' },
        { to: 'admins', kind: 'accounts' },
      ],
      '已归档的事项没有编辑路径、也不在任何人的窗口里（归档视图由 admin 按需打开），不为它产出 items 变更',
    );
    const kept = app.items.listArchived(admin).find((row) => row.id === shared.id);
    assert.ok(kept, '共享的已归档事项不随账号删除而消失');
    assert.deepEqual(kept.owners.map((o) => o.id), [admin.id], '名单照样摘干净');
    assert.equal(kept.version, archived.version, '已归档的事项不可写，版本不必推进');
    app.close();
  });

  test('顺带覆盖 02 的观察：唯一拥有的已归档事项上、别人发出的邀请，收件人也收到定向通知', async () => {
    const { app, admin, zhao, lin } = freshWorld();
    // admin 替 zhao 建一条只有 zhao 的事项，并邀请 lin；随后 zhao 把它归档
    const sole = app.items.createItem(
      admin,
      draft({ title: 'zhao 唯一拥有的', owner_ids: [zhao.id] }),
    ).item;
    app.invites.invite(sole.id, lin.id, admin);
    app.items.archiveItem(zhao, sole.id, sole.version);
    assert.equal(app.invites.countFor(lin), 1, '前提：lin 有一条待接受邀请');
    assert.deepEqual(
      app.invites.pendingInviteesFrom(zhao.id),
      [],
      '前提：这条邀请不是 zhao 发出的，旧的「它发出的邀请」读取器看不见它',
    );

    const linClient = await connect(app, await login(app, 'lin'));
    linClient.chunks.length = 0;

    const { changed } = deleteAccount(app, admin, zhao.id);
    app.sse.publish(changed); // 与 02 同一写法：变更怎么算在领域侧断言，送达在中枢侧断言

    assert.equal(app.invites.countFor(lin), 0, '邀请随被删事项级联消失');
    assert.deepEqual(
      changed,
      [
        { to: 'connections', accountIds: [zhao.id], kind: 'account-deleted' },
        { to: 'admins', kind: 'accounts' },
        { to: 'accounts', accountIds: [lin.id], kind: 'invites-changed' },
      ],
      '被邀请人不在别的收件名单里，要单独定向通知',
    );
    assert.deepEqual(
      linClient.events().map((e) => e.data),
      [{ scope: 'self', accountId: lin.id, kind: 'invites-changed' }],
      '他的角标要立刻准，而不是停在旧值等下一次全量重拉',
    );
    app.close();
  });
});
