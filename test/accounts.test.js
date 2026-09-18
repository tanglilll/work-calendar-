/**
 * 账号与注册申请：申请 → 批准 → 改角色 → 转移 → 删除的完整路径，
 * 以及几条「系统必须始终可用」的守卫（至少留一个 admin、不能删自己）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createApp } from '../server/app.js';

const sourceOf = (file) => readFileSync(new URL(`../server/${file}`, import.meta.url), 'utf8');

const STATUS = (fn, status) =>
  assert.throws(fn, (err) => {
    assert.equal(err.status, status, `期望状态码 ${status}，实际 ${err.status}（${err.message}）`);
    return true;
  });

function freshWorld() {
  const app = createApp({ dbPath: ':memory:' });
  app.accounts.ensureBootstrapAdmin({ username: 'admin', password: 'password-1' });
  return { app, admin: app.accounts.findAccountByUsername('admin') };
}

const apply = (app, username, password = 'password-2') => {
  app.accounts.submitRegistrationRequest({ username, password, note: '' });
  const pending = app.accounts.listRequests().find((r) => r.username === username);
  return pending;
};

describe('注册申请与批准', () => {
  test('账号在「批准」那一刻才诞生，角色是 user', () => {
    const { app, admin } = freshWorld();
    const pending = apply(app, 'zhao');

    // 申请还在时，账号表里没有这个人
    assert.equal(app.accounts.findAccountByUsername('zhao'), undefined);

    const { account, changed } = app.accounts.approveRequest(pending.id);
    assert.equal(account.username, 'zhao');
    assert.equal(account.role, 'user');
    assert.ok(app.accounts.findAccountByUsername('zhao'));
    assert.deepEqual(changed, [
      { to: 'admins', kind: 'accounts' },
      { to: 'admins', kind: 'requests' },
      { to: 'accounts', accountIds: [account.id], kind: 'approved' },
    ]);
    // 申请被消费掉
    assert.equal(app.accounts.listRequests().length, 0);
    assert.ok(admin.id);
    app.close();
  });

  test('用户名已被占用时拒绝申请', () => {
    const { app } = freshWorld();
    STATUS(() => app.accounts.submitRegistrationRequest({ username: 'ADMIN', password: 'password-2', note: '' }), 409);
    app.close();
  });

  test('同名申请不能重复提交', () => {
    const { app } = freshWorld();
    apply(app, 'zhao');
    STATUS(() => app.accounts.submitRegistrationRequest({ username: 'zhao', password: 'password-3', note: '' }), 409);
    app.close();
  });

  test('密码太短报字段错误', () => {
    const { app } = freshWorld();
    try {
      app.accounts.submitRegistrationRequest({ username: 'zhao', password: '123', note: '' });
      assert.fail('应当抛错');
    } catch (err) {
      assert.equal(err.fields.password, '密码至少 8 位');
    }
    app.close();
  });
});

describe('changeRole', () => {
  test('正常改角色：通知 admins 与被改的那个人', () => {
    const { app, admin } = freshWorld();
    const pending = apply(app, 'lin');
    const { account: lin } = app.accounts.approveRequest(pending.id);

    const { account, changed } = app.accounts.changeRole(admin.id, lin.id, 'manager');
    assert.equal(account.role, 'manager');
    assert.deepEqual(changed, [
      { to: 'admins', kind: 'accounts' },
      { to: 'accounts', accountIds: [lin.id], kind: 'role-changed' },
    ]);
    app.close();
  });

  test('角色没变时什么都不发生，也不广播', () => {
    const { app, admin } = freshWorld();
    const pending = apply(app, 'lin');
    const { account: lin } = app.accounts.approveRequest(pending.id);

    const { changed } = app.accounts.changeRole(admin.id, lin.id, 'user');
    assert.deepEqual(changed, []);
    app.close();
  });

  test('系统里必须至少保留一个 admin', () => {
    const { app, admin } = freshWorld();
    STATUS(() => app.accounts.changeRole(admin.id, admin.id, 'user'), 409);
    app.close();
  });

  test('角色取值必须在词表内', () => {
    const { app, admin } = freshWorld();
    STATUS(() => app.accounts.changeRole(admin.id, admin.id, 'owner'), 400);
    app.close();
  });
});

describe('deleteAccount', () => {
  test('不能删自己', () => {
    const { app, admin } = freshWorld();
    STATUS(() => app.accounts.deleteAccount(admin.id, admin.id), 409);
    app.close();
  });

  test('名下有未归档事项时拒绝，并报出条数', () => {
    const { app, admin } = freshWorld();
    const pending = apply(app, 'zhao');
    const { account: zhao } = app.accounts.approveRequest(pending.id);
    app.items.createItem(zhao, { title: '一件事', event_date: '2026-09-01', due_date: '2026-09-01', tag: null });

    try {
      app.accounts.deleteAccount(admin.id, zhao.id);
      assert.fail('应当抛错');
    } catch (err) {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'HAS_ACTIVE_ITEMS');
      assert.equal(err.activeItems, 1);
    }
    app.close();
  });

  test('转移会把含已归档的全部事项一并转走', () => {
    const { app, admin } = freshWorld();
    const pending = apply(app, 'zhao');
    const { account: zhao } = app.accounts.approveRequest(pending.id);

    const { item } = app.items.createItem(zhao, {
      title: '会被归档的',
      event_date: '2026-09-01',
      due_date: '2026-09-01',
      tag: null,
    });
    app.items.archiveItem(zhao, item.id, item.version);

    const { moved, changed } = app.accounts.transferItems(zhao.id, admin.id);
    assert.equal(moved, 1, '已归档的事项也算被转移');
    // 转移不是一条聚合变更：每条受影响的事项各有一组带 itemId 的差分
    assert.deepEqual(changed, [
      { to: 'itemOwners', ownerIds: [zhao.id], kind: 'transferred-away', itemId: item.id },
      { to: 'itemOwners', ownerIds: [admin.id], kind: 'transferred-in', itemId: item.id },
      { to: 'admins', kind: 'accounts' },
    ]);
    // 转走之后 zhao 名下再无事项
    assert.equal(app.items.countSoleOwnedActiveItems(zhao.id), 0);
    assert.equal(app.items.listArchived(admin).length, 1);
    app.close();
  });

  test('名下只剩归档项时可直接删账号，归档项随之删除并告知数量', () => {
    const { app, admin } = freshWorld();
    const pending = apply(app, 'zhao');
    const { account: zhao } = app.accounts.approveRequest(pending.id);

    const { item } = app.items.createItem(zhao, {
      title: '归档后就没人管了',
      event_date: '2026-09-01',
      due_date: '2026-09-01',
      tag: null,
    });
    app.items.archiveItem(zhao, item.id, item.version);

    // 未归档事项为 0，所以删除守卫放过——但归档项还在他名下
    const { removed, changed } = app.accounts.deleteAccount(admin.id, zhao.id);
    assert.equal(removed.deletedArchivedItems, 1);
    assert.deepEqual(changed, [
      // 账号没了：它的连接立刻断开（词表的 connections 去向），不是通知
      { to: 'connections', accountIds: [zhao.id], kind: 'account-deleted' },
      { to: 'admins', kind: 'accounts' },
    ]);
    assert.equal(app.accounts.findAccountByUsername('zhao'), undefined);
    assert.equal(app.items.listArchived(admin).length, 0, '归档项随账号一起删除');
    app.close();
  });
});

describe('删账号的连带后果：会话与邀请', () => {
  test('旧会话立刻失效（靠外键级联，不靠 accounts 直写 sessions）', () => {
    const { app, admin } = freshWorld();
    const pending = apply(app, 'zhao');
    const { account: zhao } = app.accounts.approveRequest(pending.id);
    const { token } = app.sessions.createSession(zhao.id);
    assert.equal(app.sessions.getSessionAccount(token).id, zhao.id, '前提：会话可用');

    app.accounts.deleteAccount(admin.id, zhao.id);

    assert.equal(app.sessions.getSessionAccount(token), null, '账号没了，旧会话必须立刻失效');
    assert.equal(
      app.store.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?').get(zhao.id).n,
      0,
      '库里也不该留下孤儿会话行（ON DELETE CASCADE + PRAGMA foreign_keys = ON）',
    );
    app.close();
  });

  test('accounts.js 不再直写 sessions 表：这个表的写入归 auth', () => {
    assert.doesNotMatch(sourceOf('accounts.js'), /(FROM|INTO|UPDATE|DELETE\s+FROM)\s+sessions/i);
  });

  test('它发出的待接受邀请随账号级联消失，被邀请人收到定向通知', () => {
    const { app, admin } = freshWorld();
    const { account: zhao } = app.accounts.approveRequest(apply(app, 'zhao').id);
    const { account: lin } = app.accounts.approveRequest(apply(app, 'lin').id);
    // zhao 与 admin 共享一条事项：它不是唯一 owner，所以账号删得掉
    const { item } = app.items.createItem(admin, {
      title: '共享的',
      event_date: '2026-09-01',
      due_date: '2026-09-01',
      tag: null,
      owner_ids: [admin.id, zhao.id],
    });
    app.invites.invite(item.id, lin.id, zhao);
    assert.equal(app.invites.countFor(lin), 1, '前提：lin 有一条待接受邀请');

    const { changed } = app.accounts.deleteAccount(admin.id, zhao.id);

    assert.equal(app.invites.countFor(lin), 0, '邀请随发起人级联消失');
    assert.deepEqual(
      changed,
      [
        // 共享事项的名单少了一个人：剩下的人要重拉，过期编辑框要撞 409（工单 03）
        { to: 'itemOwners', ownerIds: [admin.id], kind: 'updated', itemId: item.id },
        { to: 'connections', accountIds: [zhao.id], kind: 'account-deleted' },
        { to: 'admins', kind: 'accounts' },
        // 不是 admin 的人是这条邀请的收件人：他的角标要立刻准，而不是等下一次全量
        { to: 'accounts', accountIds: [lin.id], kind: 'invites-changed' },
      ],
      '受级联影响的是被邀请人，要定向通知',
    );
    app.close();
  });

  test('没有连累任何人时不产生多余的定向通知（回归）', () => {
    const { app, admin } = freshWorld();
    const { account: zhao } = app.accounts.approveRequest(apply(app, 'zhao').id);

    const { changed } = app.accounts.deleteAccount(admin.id, zhao.id);
    assert.deepEqual(changed, [
      { to: 'connections', accountIds: [zhao.id], kind: 'account-deleted' },
      { to: 'admins', kind: 'accounts' },
    ]);
    app.close();
  });
});

describe('ensureBootstrapAdmin — 首次启动引导', () => {
  test('账号表为空且没给密码时不创建任何账号', () => {
    const app = createApp({ dbPath: ':memory:' });
    assert.equal(app.accounts.ensureBootstrapAdmin({}).state, 'no-password');
    assert.equal(app.accounts.listAccounts().length, 0);
    app.close();
  });

  test('给出用户名与密码则创建 admin；再调一次就跳过', () => {
    const app = createApp({ dbPath: ':memory:' });
    const first = app.accounts.ensureBootstrapAdmin({ username: 'boss', password: 'password-1' });
    assert.deepEqual(first, { state: 'created', username: 'boss' });
    assert.equal(app.accounts.findAccountByUsername('boss').role, 'admin');
    assert.equal(app.accounts.ensureBootstrapAdmin({ username: 'other', password: 'password-2' }).state, 'skipped');
    app.close();
  });

  test('用户名或密码不合规时如实报出，不创建', () => {
    const app = createApp({ dbPath: ':memory:' });
    assert.equal(app.accounts.ensureBootstrapAdmin({ username: 'a', password: 'password-1' }).state, 'bad-username');
    assert.equal(app.accounts.ensureBootstrapAdmin({ username: 'boss', password: '123' }).state, 'bad-password');
    assert.equal(app.accounts.listAccounts().length, 0);
    app.close();
  });
});
