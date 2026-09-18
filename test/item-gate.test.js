/**
 * 事项的门 —— 「能不能动这条事项」的唯一落点（items.js 的 requireItemAccess）。
 *
 * 门里同时管两件事：**访问**（是不是这条事项的参与者，判据仍在 visibility.js）
 * 与**生命周期**（已归档的事项一律拒绝，delete 是唯一的例外）。items 与 invites
 * 都走这道门，不再各写一份。
 *
 * 先红的那条在第一个 describe：invites.js 曾经复刻了一份访问判据、漏了归档检查，
 * 于是「给已归档事项发邀请」领域层会接受，且经 REST 可达。
 *
 * 判据全走公开接口（门 / 领域操作 / 桩 req-res 喂 handleApi），不碰实现细节；
 * 只有「这几处调用是不是同源」用静态检查，因为它断言的就是结构本身。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import { freshWorld, draft } from '../test-helpers/world.js';
import { ITEM_ACCESS_PURPOSES } from '../server/items.js';

const STATUS = (fn, status) =>
  assert.throws(fn, (err) => {
    assert.equal(err.status, status, `期望状态码 ${status}，实际 ${err.status}（${err.message}）`);
    return true;
  });

const serverSource = (file) => readFileSync(new URL(`../server/${file}`, import.meta.url), 'utf8');

const serverFiles = () =>
  readdirSync(new URL('../server/', import.meta.url)).filter((file) => file.endsWith('.js'));

/** 建一条事项并归档，返回归档后的行。 */
function archivedItem(app, owner) {
  const { item } = app.items.createItem(owner, draft());
  return app.items.archiveItem(owner, item.id, item.version).item;
}

// ——— REST 接缝（与 test/invites-http.test.js 同一写法）：桩 req/res 直接喂 handleApi ———

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
    // handleApi 把错误抛出来，映射成响应是入口的职责；这里只取状态码
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

describe('先红的那条：给已归档事项发邀请', () => {
  test('领域层拒绝，且不落库', () => {
    const { app, zhao, lin } = freshWorld();
    const item = archivedItem(app, zhao);

    STATUS(() => app.invites.invite(item.id, lin.id, zhao), 409);
    assert.deepEqual(app.invites.listFor(lin), [], '被拒的邀请不能留下任何痕迹');
    assert.equal(app.invites.countFor(lin), 0, '角标也不能动');
    app.close();
  });

  test('经 REST 同样进不去：POST /api/items/:id/invites 拿 409', async () => {
    const { app, zhao, lin } = freshWorld();
    const zhaoCookie = await login(app, 'zhao');
    const created = await api(app, { method: 'POST', path: '/api/items', body: draft(), cookie: zhaoCookie });
    const item = created.body.item;

    const marked = await api(app, {
      method: 'POST',
      path: `/api/items/${item.id}/archive`,
      body: { version: item.version },
      cookie: zhaoCookie,
    });
    assert.equal(marked.status, 200, '前提：事项已归档');

    const invited = await api(app, {
      method: 'POST',
      path: `/api/items/${item.id}/invites`,
      body: { account_id: lin.id },
      cookie: zhaoCookie,
    });
    assert.equal(invited.status, 409, '已归档的事项邀请不到人');
    app.close();
  });
});

describe('门：用途是闭集，已归档的政策写在表里', () => {
  test('五个用途各自写明「已归档还让不让动」，只有 delete 放行', () => {
    assert.deepEqual(Object.keys(ITEM_ACCESS_PURPOSES).sort(), [
      'archive',
      'delete',
      'invite',
      'read',
      'write',
    ]);
    assert.equal(ITEM_ACCESS_PURPOSES.delete, null, 'delete 是唯一被写下来的例外');
    for (const [purpose, refusal] of Object.entries(ITEM_ACCESS_PURPOSES)) {
      if (purpose === 'delete') continue;
      assert.equal(typeof refusal, 'string', `${purpose} 必须写明拒绝理由，不能留空子`);
      assert.ok(refusal.length > 0);
    }
  });

  test('purpose 不在表里直接炸，不静默放行', () => {
    const { app, zhao } = freshWorld();
    const { item } = app.items.createItem(zhao, draft());
    assert.throws(() => app.items.requireItemAccess(zhao, item.id, 'purge'), TypeError);
    app.close();
  });
});

describe('已归档事项：读、改、归档、邀请一律拒绝', () => {
  for (const purpose of Object.keys(ITEM_ACCESS_PURPOSES).filter((p) => p !== 'delete')) {
    test(`purpose=${purpose} 被拒，理由是表里那句`, () => {
      const { app, zhao } = freshWorld();
      const item = archivedItem(app, zhao);

      try {
        app.items.requireItemAccess(zhao, item.id, purpose);
        assert.fail(`已归档事项不该放行 purpose=${purpose}`);
      } catch (err) {
        assert.equal(err.status, 409);
        assert.equal(err.message, ITEM_ACCESS_PURPOSES[purpose]);
      }
      app.close();
    });
  }

  test('回归：改已归档事项仍被拒，且不落库', () => {
    const { app, zhao } = freshWorld();
    const item = archivedItem(app, zhao);

    STATUS(() => app.items.updateItem(zhao, item.id, { title: '改不动', version: item.version }), 409);
    assert.equal(app.items.getItem(item.id).title, item.title);
    assert.equal(app.items.getItem(item.id).version, item.version, '被拒的更新不该动版本号');
    app.close();
  });

  test('回归：归档已归档事项仍被拒', () => {
    const { app, zhao } = freshWorld();
    const item = archivedItem(app, zhao);
    STATUS(() => app.items.archiveItem(zhao, item.id, item.version), 409);
    app.close();
  });
});

describe('删除已归档事项：写下来的例外，不是疏漏', () => {
  test('门对 delete 放行已归档事项', () => {
    const { app, zhao } = freshWorld();
    const item = archivedItem(app, zhao);
    assert.equal(app.items.requireItemAccess(zhao, item.id, 'delete').id, item.id);
    app.close();
  });

  test('deleteItem 删得掉已归档事项，并广播 deleted', () => {
    const { app, admin, zhao } = freshWorld();
    const item = archivedItem(app, zhao);

    const { changed } = app.items.deleteItem(zhao, item.id);
    assert.equal(app.items.getItem(item.id), undefined, '删除的语义是「这事本就不该存在」');
    assert.equal(changed[0].kind, 'deleted');
    assert.equal(app.items.listArchived(admin).length, 0);
    app.close();
  });

  test('经 REST：DELETE 一条已归档事项仍然成功', async () => {
    const { app, zhao } = freshWorld();
    const zhaoCookie = await login(app, 'zhao');
    const created = await api(app, { method: 'POST', path: '/api/items', body: draft(), cookie: zhaoCookie });
    const item = created.body.item;
    await api(app, {
      method: 'POST',
      path: `/api/items/${item.id}/archive`,
      body: { version: item.version },
      cookie: zhaoCookie,
    });

    const deleted = await api(app, { method: 'DELETE', path: `/api/items/${item.id}`, cookie: zhaoCookie });
    assert.equal(deleted.status, 200, '归档视图只读、不提供入口，但这条能力经接口仍然成立');
    app.close();
  });
});

describe('门是唯一入口：invites 不再有自己那份判据', () => {
  test('invites.js 里既没有访问判据，也没有那句错误文案', () => {
    const src = serverSource('invites.js');
    assert.doesNotMatch(src, /canAccessItem/, '访问判据只该在门里问一次');
    assert.doesNotMatch(src, /无权处置他人的事项/, '那句话只该由门说出来');
  });

  test('「无权处置他人的事项」在整个 server/ 里只有一处来源', () => {
    const owners = serverFiles().filter((file) => serverSource(file).includes('无权处置他人的事项'));
    assert.deepEqual(owners, ['items.js'], '重复的文案消失了：会话层认得的那句话只有一个出处');
  });

  test('「已归档」的立场只写在用途表里：各操作不再自己拼拒绝理由', () => {
    const src = serverSource('items.js');
    for (const reason of Object.values(ITEM_ACCESS_PURPOSES).filter(Boolean)) {
      assert.equal(
        src.split(`'${reason}'`).length - 1,
        1,
        `「${reason}」只该在用途表里出现一次（加回某个操作里就是第二份判据）`,
      );
    }
  });

  test('非参与者：invites 与 items 给出同一句拒绝', () => {
    const { app, admin, zhao, lin } = freshWorld();
    const { item } = app.items.createItem(zhao, draft());

    try {
      app.invites.invite(item.id, admin.id, lin);
      assert.fail('不是参与者就邀请不了别人');
    } catch (err) {
      assert.equal(err.status, 403);
      assert.equal(err.message, '无权处置他人的事项');
    }
    app.close();
  });

  test('不存在的 id：invites 与 items 也给出同一句话（都来自门）', () => {
    const { app, admin, lin } = freshWorld();
    for (const call of [
      () => app.invites.invite(9999, lin.id, admin),
      () => app.items.updateItem(admin, 9999, { title: 'x', version: 1 }),
      () => app.items.archiveItem(admin, 9999, 1),
      () => app.items.deleteItem(admin, 9999),
    ]) {
      try {
        call();
        assert.fail('不存在的 id 应当 404');
      } catch (err) {
        assert.equal(err.status, 404);
        assert.equal(err.message, '事项不存在');
      }
    }
    app.close();
  });
});

describe('sole-owner：三条路径一份实现', () => {
  test('三条路径对同一批事项给出一致的答案', () => {
    const { app, admin, zhao, lin } = freshWorld();
    // zhao 名下四类事项各一条：唯一/共享 × 未归档/已归档
    const soleActive = app.items.createItem(zhao, draft({ title: '唯一·未归档' })).item;
    const soleArchived = archivedItem(app, zhao);
    const sharedActive = app.items.createItem(
      admin,
      draft({ title: '共享·未归档', owner_ids: [zhao.id, lin.id] }),
    ).item;
    const shared = app.items.createItem(
      admin,
      draft({ title: '共享·已归档', owner_ids: [zhao.id, lin.id] }),
    ).item;
    const sharedArchived = app.items.archiveItem(admin, shared.id, shared.version).item;

    // 期望值从公开读法算出来，不抄 SQL
    const expectedActive = app.items
      .listItems(zhao)
      .filter((row) => row.owners.length === 1 && row.owners[0].id === zhao.id);
    const expectedArchived = app.items
      .listArchived(admin)
      .filter((row) => row.owners.length === 1 && row.owners[0].id === zhao.id);
    assert.deepEqual(expectedActive.map((row) => row.id), [soleActive.id], '前提：唯一·未归档一条');
    assert.deepEqual(
      expectedArchived.map((row) => row.id),
      [soleArchived.id],
      '前提：唯一·已归档一条',
    );

    assert.equal(app.items.countSoleOwnedActiveItems(zhao.id), expectedActive.length);
    assert.equal(app.items.countSoleOwnedArchivedItems(zhao.id), expectedArchived.length);
    assert.equal(
      app.items.deleteSoleOwnedItems(zhao.id),
      expectedActive.length + expectedArchived.length,
      '删掉的是「唯一 owner」的并集：未归档与已归档都算',
    );

    // 共享的两条都还在：删除只针对「唯一 owner」的那些，共享事项的成员摘除
    // 由删账号时的外键级联负责，不在这里
    assert.deepEqual(app.items.listItems(lin).map((row) => row.id), [sharedActive.id]);
    const keptArchived = app.items.listArchived(admin).find((row) => row.id === sharedArchived.id);
    assert.ok(keptArchived, '共享的已归档事项不随唯一 owner 的清理而消失');

    // 三条路径看的是同一批事项：清完之后两个计数都归零，zhao 只剩下共享的那条
    assert.equal(app.items.countSoleOwnedActiveItems(zhao.id), 0);
    assert.equal(app.items.countSoleOwnedArchivedItems(zhao.id), 0);
    assert.deepEqual(app.items.listItems(zhao).map((row) => row.id), [sharedActive.id]);
    app.close();
  });

  test('谓词只有一处实现：EXISTS 子查询与 count = 1 在 items.js 各只出现一次', () => {
    const src = serverSource('items.js');
    assert.equal(
      (src.match(/EXISTS \(SELECT 1 FROM item_owners m WHERE m\.item_id = i\.id AND m\.account_id = \?\)/g) ?? [])
        .length,
      1,
      '「是不是名单成员」的子查询只该写一遍',
    );
    assert.equal(
      (src.match(/\(SELECT COUNT\(\*\) FROM item_owners m2 WHERE m2\.item_id = i\.id\) = 1/g) ?? []).length,
      1,
      '「是不是唯一 owner」的判定只该写一遍',
    );
  });
});
