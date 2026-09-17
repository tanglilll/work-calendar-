/**
 * 事项领域逻辑。每个用例一套独立的 :memory: 实例——不需要 HTTP 服务器、
 * 不需要临时数据库文件、用例之间不会互相污染。这是把「创建依赖」换成
 * 「接受依赖」之后才可能有的测试。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../server/app.js';

const STATUS = (fn, status) =>
  assert.throws(fn, (err) => {
    assert.equal(err.status, status, `期望状态码 ${status}，实际 ${err.status}（${err.message}）`);
    return true;
  });

/** 一套最小世界：一个 admin、两个 user（走真实的申请→批准路径）。 */
function freshWorld() {
  const app = createApp({ dbPath: ':memory:' });
  app.accounts.ensureBootstrapAdmin({ username: 'admin', password: 'password-1' });
  const admin = app.accounts.findAccountByUsername('admin');

  const member = (username) => {
    app.accounts.submitRegistrationRequest({ username, password: 'password-2', note: '' });
    const pending = app.accounts.listRequests().find((r) => r.username === username);
    return app.accounts.approveRequest(pending.id).account;
  };

  return { app, admin, zhao: member('zhao'), lin: member('lin') };
}

const draft = (over = {}) => ({
  title: '写周报',
  event_date: '2026-09-01',
  due_date: '2026-09-01',
  tag: null,
  ...over,
});

describe('createItem', () => {
  test('建成功并返回该 owner 的变更描述', () => {
    const { app, admin } = freshWorld();
    const { item, changed } = app.items.createItem(admin, draft({ title: '写周报' }));

    assert.equal(item.title, '写周报');
    assert.deepEqual(item.owners.map((o) => o.username), ['admin']);
    assert.equal(item.version, 1);
    assert.equal(item.archived_at, null);
    assert.deepEqual(changed, [
      { to: 'itemOwners', ownerIds: [admin.id], kind: 'created', itemId: item.id },
    ]);
    app.close();
  });

  test('首个事项拿到调色板的第 0 号色', () => {
    const { app, admin } = freshWorld();
    const { item } = app.items.createItem(admin, draft());
    assert.equal(item.color, 0);
    app.close();
  });

  test('空标题报字段错误', () => {
    const { app, admin } = freshWorld();
    try {
      app.items.createItem(admin, draft({ title: '   ' }));
      assert.fail('应当抛错');
    } catch (err) {
      assert.equal(err.status, 400);
      assert.equal(err.fields.title, '标题不能为空');
    }
    app.close();
  });

  test('不存在的日期报字段错误', () => {
    const { app, admin } = freshWorld();
    try {
      app.items.createItem(admin, draft({ event_date: '2026-02-30' }));
      assert.fail('应当抛错');
    } catch (err) {
      assert.equal(err.fields.event_date, '起始日期格式须为 yyyy-mm-dd 的真实日期');
    }
    app.close();
  });

  test('截止早于起始报字段错误', () => {
    const { app, admin } = freshWorld();
    try {
      app.items.createItem(admin, draft({ event_date: '2026-09-05', due_date: '2026-09-01' }));
      assert.fail('应当抛错');
    } catch (err) {
      assert.equal(err.fields.due_date, '截止日期不得早于起始日期');
    }
    app.close();
  });

  test('user 不能把事项分配给他人', () => {
    const { app, zhao, admin } = freshWorld();
    try {
      app.items.createItem(zhao, draft({ owner_ids: [admin.id] }));
      assert.fail('应当抛错');
    } catch (err) {
      assert.equal(err.fields.owner_ids, '只有 manager/admin 能把事项分配给他人');
    }
    app.close();
  });

  test('admin 能替他人建事项，且归属就是那个人', () => {
    const { app, admin, zhao } = freshWorld();
    const { item, changed } = app.items.createItem(admin, draft({ owner_ids: [zhao.id] }));
    assert.deepEqual(item.owners.map((o) => o.id), [zhao.id]);
    assert.deepEqual(changed[0].ownerIds, [zhao.id]);
    app.close();
  });
});

describe('listItems — 可见范围', () => {
  test('user 只看见自己的，admin 看见全部', () => {
    const { app, admin, zhao } = freshWorld();
    app.items.createItem(admin, draft({ title: 'admin 的事' }));
    app.items.createItem(zhao, draft({ title: 'zhao 的事' }));

    assert.equal(app.items.listItems(admin).length, 2);
    const mine = app.items.listItems(zhao);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].title, 'zhao 的事');
    app.close();
  });

  test('已归档的不出现在列表里', () => {
    const { app, admin } = freshWorld();
    const { item } = app.items.createItem(admin, draft());
    app.items.archiveItem(admin, item.id, item.version);
    assert.equal(app.items.listItems(admin).length, 0);
    app.close();
  });
});

describe('updateItem', () => {
  test('改标题后 version 自增', () => {
    const { app, admin } = freshWorld();
    const { item } = app.items.createItem(admin, draft());
    const { item: updated, changed } = app.items.updateItem(admin, item.id, {
      title: '改后的标题',
      version: item.version,
    });
    assert.equal(updated.title, '改后的标题');
    assert.equal(updated.version, item.version + 1);
    assert.deepEqual(changed, [
      { to: 'itemOwners', ownerIds: [admin.id], kind: 'updated', itemId: item.id },
    ]);
    app.close();
  });

  test('版本不符返回 409 VERSION_CONFLICT，且不落库', () => {
    const { app, admin } = freshWorld();
    const { item } = app.items.createItem(admin, draft());
    app.items.updateItem(admin, item.id, { title: '第一次', version: item.version });

    try {
      app.items.updateItem(admin, item.id, { title: '第二次', version: item.version });
      assert.fail('应当抛错');
    } catch (err) {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'VERSION_CONFLICT');
    }
    assert.equal(app.items.getItem(item.id).title, '第一次');
    app.close();
  });

  test('缺 version 报 400', () => {
    const { app, admin } = freshWorld();
    const { item } = app.items.createItem(admin, draft());
    STATUS(() => app.items.updateItem(admin, item.id, { title: 'x' }), 400);
    app.close();
  });

  test('user 改不了他人的事项', () => {
    const { app, admin, zhao } = freshWorld();
    const { item } = app.items.createItem(admin, draft());
    STATUS(() => app.items.updateItem(zhao, item.id, { title: '越权', version: item.version }), 403);
    app.close();
  });

  test('归档后不可修改', () => {
    const { app, admin } = freshWorld();
    const { item } = app.items.createItem(admin, draft());
    const { item: archived } = app.items.archiveItem(admin, item.id, item.version);
    STATUS(
      () => app.items.updateItem(admin, item.id, { title: 'x', version: archived.version }),
      409,
    );
    app.close();
  });

  test('改 owner 产生两条变更描述，新旧各一条', () => {
    const { app, admin, zhao } = freshWorld();
    const { item } = app.items.createItem(admin, draft());
    const { item: moved, changed } = app.items.updateItem(admin, item.id, {
      owner_ids: [zhao.id],
      version: item.version,
    });

    assert.deepEqual(moved.owners.map((o) => o.id), [zhao.id]);
    assert.deepEqual(changed, [
      { to: 'itemOwners', ownerIds: [admin.id], kind: 'transferred-away', itemId: item.id },
      { to: 'itemOwners', ownerIds: [zhao.id], kind: 'transferred-in', itemId: item.id },
    ]);
    app.close();
  });
});

describe('archiveItem', () => {
  test('归档后带 archived_at，再归档返回 409', () => {
    const { app, admin } = freshWorld();
    const { item } = app.items.createItem(admin, draft());
    const { item: archived, changed } = app.items.archiveItem(admin, item.id, item.version);

    assert.ok(archived.archived_at);
    assert.deepEqual(changed, [
      { to: 'itemOwners', ownerIds: [admin.id], kind: 'archived', itemId: item.id },
    ]);
    STATUS(() => app.items.archiveItem(admin, item.id, archived.version), 409);
    app.close();
  });

  test('归档视图只给 admin，且列出已归档项', () => {
    const { app, admin, zhao } = freshWorld();
    const { item } = app.items.createItem(admin, draft());
    app.items.archiveItem(admin, item.id, item.version);

    assert.equal(app.items.listArchived(admin).length, 1);
    STATUS(() => app.items.listArchived(zhao), 403);
    app.close();
  });
});

describe('deleteItem', () => {
  test('物理移除并广播 deleted', () => {
    const { app, admin } = freshWorld();
    const { item } = app.items.createItem(admin, draft());
    const { changed } = app.items.deleteItem(admin, item.id);
    assert.equal(app.items.getItem(item.id), undefined);
    assert.equal(changed[0].kind, 'deleted');
    STATUS(() => app.items.deleteItem(admin, item.id), 404);
    app.close();
  });

  test('user 删不掉他人的事项', () => {
    const { app, admin, zhao } = freshWorld();
    const { item } = app.items.createItem(admin, draft());
    STATUS(() => app.items.deleteItem(zhao, item.id), 403);
    app.close();
  });
});

describe('日期不变量只有一处落点', () => {
  const span = { event_date: '2026-09-01', due_date: '2026-09-10' };

  test('只带 event_date 的部分更新不能绕过（这条路径曾经漏成 500）', () => {
    const { app, admin } = freshWorld();
    const { item } = app.items.createItem(admin, draft(span));

    try {
      app.items.updateItem(admin, item.id, { event_date: '2026-09-30', version: item.version });
      assert.fail('应当抛错');
    } catch (err) {
      assert.equal(err.status, 400, '应当是字段错误，而不是存储层抛出的 500');
      assert.equal(err.fields.due_date, '截止日期不得早于起始日期');
    }
    assert.equal(app.items.getItem(item.id).event_date, span.event_date, '不合法就不该落库');
    app.close();
  });

  test('只带 due_date 的部分更新不能绕过', () => {
    const { app, admin } = freshWorld();
    const { item } = app.items.createItem(admin, draft(span));

    try {
      app.items.updateItem(admin, item.id, { due_date: '2026-08-01', version: item.version });
      assert.fail('应当抛错');
    } catch (err) {
      assert.equal(err.status, 400);
      assert.equal(err.fields.due_date, '截止日期不得早于起始日期');
    }
    app.close();
  });

  test('同时带两个日期也同样报错', () => {
    const { app, admin } = freshWorld();
    const { item } = app.items.createItem(admin, draft(span));

    try {
      app.items.updateItem(admin, item.id, {
        event_date: '2026-09-20',
        due_date: '2026-09-05',
        version: item.version,
      });
      assert.fail('应当抛错');
    } catch (err) {
      assert.equal(err.status, 400);
      assert.equal(err.fields.due_date, '截止日期不得早于起始日期');
    }
    app.close();
  });

  test('合法改动照常通过，version 自增', () => {
    const { app, admin } = freshWorld();
    const { item } = app.items.createItem(admin, draft(span));
    const { item: updated } = app.items.updateItem(admin, item.id, {
      event_date: '2026-09-05',
      version: item.version,
    });
    assert.equal(updated.event_date, '2026-09-05');
    assert.equal(updated.due_date, span.due_date, '没传的字段保持原值');
    assert.equal(updated.version, item.version + 1);
    app.close();
  });
});

describe('多个 owner 并列', () => {
  test('一条事项可以挂在多个账号名下，名单里每个人都能看见它', () => {
    const { app, admin, zhao, lin } = freshWorld();
    const { item } = app.items.createItem(admin, draft({ owner_ids: [zhao.id, lin.id] }));

    assert.deepEqual(
      item.owners.map((o) => o.username).sort(),
      ['lin', 'zhao'],
      'owner 名单是并列的：只有成员，没有主次',
    );
    assert.equal(app.items.listItems(zhao).length, 1, 'zhao 是成员之一，就该看得见');
    assert.equal(app.items.listItems(lin).length, 1, 'lin 同理');
    app.close();
  });
});

describe('进展', () => {
  test('名单里每个人都能填写，覆盖式更新并记下更新时间', () => {
    const { app, admin, zhao } = freshWorld();
    const { item } = app.items.createItem(admin, draft({ owner_ids: [admin.id, zhao.id] }));

    assert.equal(item.progress, null, '默认没有进展');
    assert.equal(item.progress_updated_at, null);

    const { item: once } = app.items.updateItem(zhao, item.id, {
      progress: '接口联调完成',
      version: item.version,
    });
    assert.equal(once.progress, '接口联调完成');
    assert.match(once.progress_updated_at, /^\d{4}-\d{2}-\d{2}T/, '记下更新时间');

    const { item: twice } = app.items.updateItem(admin, item.id, {
      progress: '已提测',
      version: once.version,
    });
    assert.equal(twice.progress, '已提测', '覆盖式：只有一段进展，不保留历史');
    app.close();
  });
});
