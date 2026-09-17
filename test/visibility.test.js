/**
 * 可见性判据。这是全应用唯一的权限规则，也是这个仓库里第一组真正跑得起来的测试——
 * 判据是纯谓词，不需要数据库、不需要 HTTP 服务。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ROLES,
  capabilitiesOf,
  canAccessItem,
  canReceiveEvent,
  ownerScope,
} from '../server/visibility.js';

const USER = { id: 7, role: 'user' };
const OTHER_USER = { id: 8, role: 'user' };
const MANAGER = { id: 9, role: 'manager' };
const ADMIN = { id: 10, role: 'admin' };

const VIEWER = (id, role) => ({ accountId: id, role });
const OWN_ITEM = { id: 1, owners: [{ id: 7, username: 'self' }] };
const OTHERS_ITEM = { id: 2, owners: [{ id: 8, username: 'other' }] };
// 并列名单：7 和 8 都是成员，没有主次
const SHARED_ITEM = { id: 3, owners: [{ id: 7, username: 'self' }, { id: 8, username: 'other' }] };

describe('capabilitiesOf', () => {
  test('user 三者皆无', () => {
    assert.deepEqual(capabilitiesOf(USER), {
      seesAllItems: false,
      assignsOwner: false,
      managesAccounts: false,
    });
  });

  test('manager 有全事项视野与分配权，但没有账号管理', () => {
    assert.deepEqual(capabilitiesOf(MANAGER), {
      seesAllItems: true,
      assignsOwner: true,
      managesAccounts: false,
    });
  });

  test('admin 三者齐全', () => {
    assert.deepEqual(capabilitiesOf(ADMIN), {
      seesAllItems: true,
      assignsOwner: true,
      managesAccounts: true,
    });
  });

  test('未登录（null）一律 false，不抛错', () => {
    assert.deepEqual(capabilitiesOf(null), {
      seesAllItems: false,
      assignsOwner: false,
      managesAccounts: false,
    });
  });
});

describe('canAccessItem', () => {
  test('user 能处置自己的事项', () => {
    assert.equal(canAccessItem(USER, OWN_ITEM), true);
  });

  test('名单里有他一个就看得见，不论名单里有几个人', () => {
    assert.equal(canAccessItem(USER, SHARED_ITEM), true, '并列意味着不是"主负责人"也算数');
    assert.equal(canAccessItem(OTHER_USER, SHARED_ITEM), true);
  });

  test('user 不能处置自己不在名单上的事项', () => {
    assert.equal(canAccessItem(USER, OTHERS_ITEM), false);
    assert.equal(canAccessItem(OTHER_USER, OWN_ITEM), false);
  });

  test('manager 与 admin 能处置任何人的事项', () => {
    assert.equal(canAccessItem(MANAGER, OTHERS_ITEM), true);
    assert.equal(canAccessItem(ADMIN, OTHERS_ITEM), true);
  });
});

describe('ownerScope — 让 SQL 过滤与内存判据同源', () => {
  test('manager / admin 不加过滤', () => {
    assert.deepEqual(ownerScope(MANAGER), { sql: '', params: [] });
    assert.deepEqual(ownerScope(ADMIN), { sql: '', params: [] });
  });

  test('user 的过滤片段带上自己的账号 id', () => {
    const scope = ownerScope(USER);
    assert.deepEqual(scope.params, [7]);
    assert.match(scope.sql, /item_owners/, '过滤落在成员表上');
  });

  // 片段本身是否真能筛出正确的集合，由 test/items.test.js 的行为测试证明——
  // 在这里断言 SQL 字符串只会让任何一次重写都变红，却证明不了筛选对不对。
});

describe('canReceiveEvent — SSE 在服务端过滤', () => {
  const itemsEvent = (ownerId) => ({ scope: 'items', ownerId, kind: 'created' });

  test('user 收不到他人的事项事件（关键安全断言）', () => {
    assert.equal(canReceiveEvent(VIEWER(7, 'user'), itemsEvent(8)), false);
  });

  test('user 收得到自己事项的事件', () => {
    assert.equal(canReceiveEvent(VIEWER(7, 'user'), itemsEvent(7)), true);
  });

  test('manager / admin 收得到任何人的事项事件', () => {
    assert.equal(canReceiveEvent(VIEWER(9, 'manager'), itemsEvent(8)), true);
    assert.equal(canReceiveEvent(VIEWER(10, 'admin'), itemsEvent(8)), true);
  });

  test('admin 专属事件不外泄给 user 与 manager', () => {
    assert.equal(canReceiveEvent(VIEWER(7, 'user'), { scope: 'admin' }), false);
    assert.equal(canReceiveEvent(VIEWER(9, 'manager'), { scope: 'admin' }), false);
    assert.equal(canReceiveEvent(VIEWER(10, 'admin'), { scope: 'admin' }), true);
  });

  test('self 事件走账号定向，不由这里裁决', () => {
    assert.equal(canReceiveEvent(VIEWER(7, 'user'), { scope: 'self' }), false);
  });
});

describe('角色词表', () => {
  test('就是 CONTEXT.md 里的三级，逐级包含', () => {
    assert.deepEqual(ROLES, ['user', 'manager', 'admin']);
  });
});
