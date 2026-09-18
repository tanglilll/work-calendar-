/**
 * 变更词表与 owner 差分。
 *
 * 变更描述（谁发给谁、哪种 kind）以前由四个领域 module 各自手写：拼错 `to` 会在
 * publish 的 if/else 里**静默丢弃**（不报错、不投递），词表外的 kind 会被原样推给
 * 客户端；owner 差分（谁出、谁进、谁留）被抄了三份，转移那份还丢了 itemId。
 * 这个文件钉住三件事：
 *
 * - 非法变更无从构造：kind 不在词表里，构造函数直接抛；手写的变更描述进不了 publish；
 * - 谁需要被通知只算一次：owner 差分只有 sse.js 一处实现，三个调用点产出同一形状；
 * - 领域 module 不再写回 to/kind 字面量（静态检查，见 contracts.test.js 的先例）。
 *
 * 写法的取舍：能跑真代码的就跑真代码（真中枢 + 桩连接、真领域调用、真 SQL），
 * 只有「领域 module 里是不是又写回了字面量」这类没有运行时表征的事才做静态检查。
 */
import { readFileSync } from 'node:fs';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { freshWorld, draft } from '../test-helpers/world.js';
import {
  CHANGE_KINDS,
  accountChanged,
  adminsChanged,
  createSse,
  isChange,
  ownerChanged,
  ownerChanges,
  ownerDiff,
} from '../server/sse.js';

const sourceOf = (file) => readFileSync(new URL(`../server/${file}`, import.meta.url), 'utf8');

/** 真中枢（不注入替身）：publish 这道关口本身就是要被测的对象。
 *  roleOf 是中枢唯一的必需依赖（推送时的权威角色，工单 04）——这里给个常量替身，
 *  本文件测的是词表与关口，不是角色判据。 */
const createHub = () => createSse({ roleOf: () => 'user' });

/** 桩 res：只记下写出的内容，不真发；`events()` 按 SSE 的 wire format 解析。 */
function stubRes() {
  const handlers = new Map();
  const chunks = [];
  return {
    writeHead() {},
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    end() {},
    on(event, fn) {
      handlers.set(event, fn);
    },
    /** 收到的 SSE 事件，按顺序：[{ event, data }]；retry 与注释行不进结果。 */
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

describe('变更词表', () => {
  test('四个去向，各自允许的 kind 就是这些——新增一种变更必须写进词表', () => {
    assert.deepEqual(Object.keys(CHANGE_KINDS).sort(), ['accounts', 'admins', 'connections', 'itemOwners']);
    assert.deepEqual([...CHANGE_KINDS.itemOwners].sort(), [
      'archived',
      'created',
      'deleted',
      'transferred-away',
      'transferred-in',
      'updated',
    ]);
    assert.deepEqual([...CHANGE_KINDS.admins].sort(), ['accounts', 'requests']);
    assert.deepEqual([...CHANGE_KINDS.accounts].sort(), [
      'approved',
      'invites-changed',
      'role-changed',
      'signed-in',
    ]);
    // 第四类不是「通知谁」而是「断开谁」：账号已删除，连接收不到任何事件（工单 04）
    assert.deepEqual([...CHANGE_KINDS.connections].sort(), ['account-deleted']);
  });

  test('词表是冻结的：闭集不会被运行时改写', () => {
    assert.ok(Object.isFrozen(CHANGE_KINDS));
    for (const kinds of Object.values(CHANGE_KINDS)) assert.ok(Object.isFrozen(kinds));
  });
});

describe('构造函数：非法变更无从构造', () => {
  test('构造出来的形状就是投递层要的：to / kind / ownerIds 或 accountIds / itemId', () => {
    assert.deepEqual(ownerChanged(42, [7, 9], 'updated'), {
      to: 'itemOwners',
      ownerIds: [7, 9],
      kind: 'updated',
      itemId: 42,
    });
    assert.deepEqual(accountChanged([7], 'role-changed'), {
      to: 'accounts',
      accountIds: [7],
      kind: 'role-changed',
    });
    assert.deepEqual(adminsChanged('requests'), { to: 'admins', kind: 'requests' });

    assert.ok(isChange(ownerChanged(42, [7], 'deleted')), '构造函数产出的变更带构造标记');
    assert.equal(isChange({ to: 'itemOwners', ownerIds: [7], kind: 'updated', itemId: 42 }), false, '手写的没有标记');
  });

  test('词表外的 kind 直接抛错，不会造出一条「看起来像变更」的东西', () => {
    assert.throws(() => ownerChanged(1, [7], 'updatd'), /变更词表/);
    assert.throws(() => accountChanged([7], 'role-change'), /变更词表/);
    assert.throws(() => adminsChanged('account'), /变更词表/);
  });

  test('负载不合规也构造不出来：事项事件必须带 itemId 与非空 ownerIds', () => {
    assert.throws(() => ownerChanged(null, [7], 'updated'), /itemId/);
    assert.throws(() => ownerChanged(1, [], 'updated'), /ownerIds/);
    assert.throws(() => ownerChanged(1, ['7'], 'updated'), /ownerIds/);
    assert.throws(() => accountChanged([], 'approved'), /accountIds/);
  });
});

describe('publish 只接受构造出来的变更', () => {
  test('未知 to：必须抛错，不能被静默丢弃', () => {
    const hub = createHub();
    const client = stubRes();
    hub.addClient(client, { id: 7, role: 'user' });
    assert.throws(
      () => hub.publish([{ to: 'itemOwner', ownerIds: [7], kind: 'updated', itemId: 1 }]),
      (err) => {
        assert.match(err.message, /变更/);
        return true;
      },
      '拼错的 to 必须炸：静默丢弃让「拼错」在测试与生产里同样无声',
    );
    assert.deepEqual(
      client.events().map((e) => e.event),
      ['hello'],
      '非法变更不该被投递',
    );
  });

  test('词表外的 kind：必须抛错，不能原样推给客户端', () => {
    const hub = createHub();
    const client = stubRes();
    hub.addClient(client, { id: 7, role: 'user' });

    assert.throws(
      () => hub.publish([{ to: 'itemOwners', ownerIds: [7], kind: 'updatd', itemId: 1 }]),
      (err) => {
        assert.match(err.message, /变更/);
        return true;
      },
      '词表外的 kind 必须炸：原样投递会让词表形同虚设',
    );
    assert.deepEqual(
      client.events().map((e) => e.event),
      ['hello'],
      '非法变更不该被投递',
    );
  });

  test('手写的变更描述即使看起来合法也进不了 publish', () => {
    const hub = createHub();
    assert.throws(
      () => hub.publish([{ to: 'itemOwners', ownerIds: [7], kind: 'updated', itemId: 1 }]),
      /构造函数/,
      '投递只认词表构造函数：这是「非法变更无从构造」在关口上的那一半',
    );
  });

  test('空变更数组照旧：没有变更就不发任何东西', () => {
    const hub = createHub();
    assert.doesNotThrow(() => hub.publish([]));
    assert.doesNotThrow(() => hub.publish());
  });
});

describe('owner 差分只有一处实现', () => {
  test('ownerDiff 分出谁出、谁进、谁留：并列名单只看成员，不看顺序', () => {
    assert.deepEqual(ownerDiff([1, 2, 3], [2, 3, 4]), { removed: [1], added: [4], stayed: [2, 3] });
    assert.deepEqual(ownerDiff([1], [1]), { removed: [], added: [], stayed: [1] });
    assert.deepEqual(ownerDiff([1, 2], [2, 1]), { removed: [], added: [], stayed: [2, 1] }, '换顺序不算换人');
  });

  test('ownerChanges：出的人收 transferred-away，进的人收 transferred-in，留下的人收 updated', () => {
    assert.deepEqual(ownerChanges({ itemId: 5, before: [1, 2], after: [2, 3] }), [
      { to: 'itemOwners', ownerIds: [1], kind: 'transferred-away', itemId: 5 },
      { to: 'itemOwners', ownerIds: [3], kind: 'transferred-in', itemId: 5 },
      { to: 'itemOwners', ownerIds: [2], kind: 'updated', itemId: 5 },
    ]);
  });

  test('名单没变时，当前名单上的每个人收 updated', () => {
    assert.deepEqual(ownerChanges({ itemId: 5, before: [1, 2], after: [1, 2] }), [
      { to: 'itemOwners', ownerIds: [1, 2], kind: 'updated', itemId: 5 },
    ]);
  });

  test('三个调用点产出同一形状：每条 itemOwners 变更都带 itemId，kind 都在词表里', () => {
    const { app, admin, zhao, lin } = freshWorld();

    // items.updateItem：admin 建一条，然后把名单换成 zhao（admin 出、zhao 进）
    const { item } = app.items.createItem(admin, draft());
    const updated = app.items.updateItem(admin, item.id, {
      owner_ids: [zhao.id],
      version: item.version,
    });

    // invites.accept：把 lin 邀进刚才这条（lin 进、zhao 留）
    const { invite } = app.invites.invite(item.id, lin.id, zhao);
    const accepted = app.invites.accept(invite.id, lin);

    // accounts.transferItems：zhao 名下的事项转给 admin
    const transferred = app.accounts.transferItems(zhao.id, admin.id);

    const sources = [
      ['items.updateItem', updated.changed],
      ['invites.accept', accepted.changed],
      ['accounts.transferItems', transferred.changed],
    ];
    for (const [label, changed] of sources) {
      const itemChanges = changed.filter((change) => change.to === 'itemOwners');
      assert.ok(itemChanges.length > 0, `${label}: 应当产出事项变更`);
      for (const change of itemChanges) {
        assert.ok(isChange(change), `${label}: 变更必须由词表构造函数产生`);
        assert.ok(
          CHANGE_KINDS.itemOwners.includes(change.kind),
          `${label}: kind「${change.kind}」不在词表里`,
        );
        assert.ok(
          Number.isInteger(change.itemId) && change.itemId > 0,
          `${label}: 每条事项变更都要带 itemId（转移那份曾经不带）`,
        );
        assert.ok(change.ownerIds.length > 0, `${label}: ownerIds 不能是空的`);
      }
    }
    app.close();
  });

  test('领域 module 不再写回 to/kind 字面量，也不自己算差分', () => {
    for (const file of ['items.js', 'invites.js', 'accounts.js', 'auth.js']) {
      const src = sourceOf(file);
      assert.match(src, /from '\.\/sse\.js'/, `${file}: 变更描述应当来自词表（sse.js）`);
      assert.doesNotMatch(src, /\bto:\s*['"]/, `${file}: 去向只能由词表构造函数写`);
      assert.doesNotMatch(src, /\bkind:\s*['"]/, `${file}: kind 只能由词表构造函数写`);
      assert.doesNotMatch(
        src,
        /transferred-(away|in)/,
        `${file}: 谁进谁出只有 sse.js 的 ownerChanges 一处实现`,
      );
      assert.doesNotMatch(src, /\bstayed\b/, `${file}: 「谁留下」只有 sse.js 一处实现`);
    }
    assert.match(sourceOf('sse.js'), /transferred-away/, '词表自己当然有这三个词');
  });
});

describe('accounts.transferItems：变更带上 itemId', () => {
  test('转移多条：每条事项各一组带 itemId 的变更，不再是一条无 itemId 的聚合', () => {
    const { app, admin, zhao } = freshWorld();
    const first = app.items.createItem(zhao, draft({ title: '第一件' })).item;
    const second = app.items.createItem(zhao, draft({ title: '第二件' })).item;

    const { moved, changed } = app.accounts.transferItems(zhao.id, admin.id);
    assert.equal(moved, 2);
    assert.deepEqual(
      changed.filter((c) => c.kind === 'transferred-away').map((c) => c.itemId).sort(),
      [first.id, second.id].sort(),
    );
    assert.deepEqual(
      changed.filter((c) => c.kind === 'transferred-in').map((c) => c.itemId).sort(),
      [first.id, second.id].sort(),
    );
    app.close();
  });

  test('目标已经是这条事项的成员时：不算「进」，算「留」——并列名单只看出入', () => {
    const { app, admin, zhao } = freshWorld();
    const { item } = app.items.createItem(admin, draft({ owner_ids: [admin.id, zhao.id] }));

    const { changed } = app.accounts.transferItems(zhao.id, admin.id);
    const label = (change) =>
      change.to === 'itemOwners'
        ? `itemOwners:${change.kind}:${change.ownerIds.join(',')}`
        : `${change.to}:${change.kind}`;
    assert.deepEqual(
      changed.map(label),
      [
        `itemOwners:transferred-away:${zhao.id}`,
        `itemOwners:updated:${admin.id}`,
        'admins:accounts',
      ],
      'admin 本来就在名单里（并列成员之一），它只该收到「名单变了」的通知',
    );
    assert.equal(app.items.getItem(item.id).owners.length, 1, '名单里只剩 admin，没有重复');
    app.close();
  });
});
