/**
 * 邀请：非管理员要把别人加进 owner 名单，得先发邀请、由对方接受。
 *
 * 邀请不是参与者状态——待接受期间被邀请人在日历与面板里看不到这条事项，
 * 只在自己的「待接受邀请」里看到标题、日期与发起人。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { freshWorld, draft } from '../test-helpers/world.js';

const STATUS = (fn, status) =>
  assert.throws(fn, (err) => {
    assert.equal(err.status, status, `期望状态码 ${status}，实际 ${err.status}（${err.message}）`);
    return true;
  });

describe('邀请', () => {
  test('非管理员加人要先发邀请，对方接受后才进名单、才看得见事项', () => {
    const { app, zhao, lin } = freshWorld();
    const { item } = app.items.createItem(zhao, draft());

    // zhao 邀请 lin
    const { invite } = app.invites.invite(item.id, lin.id, zhao);
    assert.equal(invite.item_id, item.id);
    assert.equal(invite.account_id, lin.id);
    assert.equal(invite.invited_by, zhao.id);
    assert.deepEqual(
      app.items.getItem(item.id).owners.map((o) => o.id),
      [zhao.id],
      '还没接受，名单不变',
    );
    assert.equal(app.items.listItems(lin).length, 0, '待接受期间 lin 在日历里看不到它');

    // lin 在自己的待接受列表里看到它
    const pending = app.invites.listFor(lin);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].title, '写周报', '看得到标题，才判断得了要不要接');
    assert.equal(pending[0].invited_by_name, 'zhao', '看得到是谁发的');

    // 接受
    const { item: after, changed } = app.invites.accept(invite.id, lin);
    assert.deepEqual(after.owners.map((o) => o.username).sort(), ['lin', 'zhao']);
    assert.equal(app.invites.listFor(lin).length, 0, '接受后不再是待处理');
    assert.equal(app.items.listItems(lin).length, 1, 'lin 现在看得见这条了');
    // 接受会牵动三处：新成员的看板要出现、原有成员的色块要改标注、被邀请人的角标要减一
    assert.deepEqual(
      changed.map((c) => `${c.to}:${c.kind}`).sort(),
      ['accounts:invites-changed', 'itemOwners:transferred-in', 'itemOwners:updated'],
    );
    app.close();
  });
});

describe('邀请的边界', () => {
  test('看不见这条事项的人就不能邀请别人进来', () => {
    const { app, admin, zhao, lin } = freshWorld();
    const { item } = app.items.createItem(zhao, draft());
    STATUS(() => app.invites.invite(item.id, admin.id, lin), 403);
    app.close();
  });

  test('manager/admin 看得见全部，所以能替任何人发邀请', () => {
    const { app, admin, zhao, lin } = freshWorld();
    const { item } = app.items.createItem(zhao, draft());
    const { invite } = app.invites.invite(item.id, lin.id, admin);
    assert.equal(invite.account_id, lin.id);
    assert.equal(invite.invited_by, admin.id);
    app.close();
  });

  test('已经在名单里的人不能再被邀请', () => {
    const { app, admin, zhao, lin } = freshWorld();
    // 普通 user 建不了带别人的事项（那是分配），所以由 admin 来建
    const { item } = app.items.createItem(admin, draft({ owner_ids: [zhao.id, lin.id] }));
    STATUS(() => app.invites.invite(item.id, lin.id, admin), 409);
    app.close();
  });

  test('同一个人不能重复邀请', () => {
    const { app, zhao, lin } = freshWorld();
    const { item } = app.items.createItem(zhao, draft());
    app.invites.invite(item.id, lin.id, zhao);
    STATUS(() => app.invites.invite(item.id, lin.id, zhao), 409);
    app.close();
  });

  test('只有被邀请人本人能接受或拒绝', () => {
    const { app, admin, zhao, lin } = freshWorld();
    const { item } = app.items.createItem(zhao, draft());
    const { invite } = app.invites.invite(item.id, lin.id, zhao);

    STATUS(() => app.invites.accept(invite.id, admin), 403);
    STATUS(() => app.invites.reject(invite.id, zhao), 403);
    assert.equal(app.items.listItems(lin).length, 0, '别人试过之后邀请仍然有效');
    app.close();
  });

  test('拒绝即删掉这条邀请，名单不变，发起人可以再邀', () => {
    const { app, zhao, lin } = freshWorld();
    const { item } = app.items.createItem(zhao, draft());
    const { invite } = app.invites.invite(item.id, lin.id, zhao);

    const { changed } = app.invites.reject(invite.id, lin);
    assert.equal(app.invites.listFor(lin).length, 0);
    assert.deepEqual(app.items.getItem(item.id).owners.map((o) => o.id), [zhao.id]);
    assert.deepEqual(changed, [{ to: 'accounts', accountIds: [lin.id], kind: 'invites-changed' }]);

    // 再邀一次是允许的——拒绝不留否决状态
    app.invites.invite(item.id, lin.id, zhao);
    assert.equal(app.invites.listFor(lin).length, 1);
    assert.equal(app.invites.countFor(lin), 1, '角标计数跟着走');
    app.close();
  });
});

describe('分派与邀请的分工', () => {
  test('管理员改名单直接生效，不发邀请', () => {
    const { app, admin, zhao, lin } = freshWorld();
    const { item } = app.items.createItem(admin, draft());

    const { item: updated, changed } = app.items.updateItem(admin, item.id, {
      owner_ids: [zhao.id, lin.id],
      version: item.version,
    });

    assert.deepEqual(updated.owners.map((o) => o.username).sort(), ['lin', 'zhao']);
    assert.equal(app.invites.countFor(zhao), 0, '被分派的人没有待接受的邀请');
    assert.equal(app.invites.countFor(lin), 0);
    assert.deepEqual(
      changed.map((c) => `${c.to}:${c.kind}`).sort(),
      ['itemOwners:transferred-away', 'itemOwners:transferred-in'],
      'admin 自己不在新名单里，所以是 away + in',
    );
    app.close();
  });

  test('非管理员不能直接改名单，只能走邀请', () => {
    const { app, zhao, lin } = freshWorld();
    const { item } = app.items.createItem(zhao, draft());

    try {
      app.items.updateItem(zhao, item.id, { owner_ids: [zhao.id, lin.id], version: item.version });
      assert.fail('应当抛错');
    } catch (err) {
      assert.equal(err.status, 400);
      assert.match(err.fields.owner_ids, /邀请/, '错误信息要指出正确的做法');
    }
    assert.deepEqual(
      app.items.getItem(item.id).owners.map((o) => o.id),
      [zhao.id],
      '名单没被动过',
    );
    app.close();
  });
});
