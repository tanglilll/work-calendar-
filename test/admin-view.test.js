/**
 * admin 面板的视图迁移。以前「页签 + 转移视图的源账号」两个变量与候选账号的计算混在 render() 的
 * 分支里，验收只能换一轮真实浏览器会话；现在迁移与候选计算都是纯函数，这里直接断言：
 * 切页签、进出转移视图、候选不含源账号、没有候选时是空视图、取消不改数据。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  adminTransition,
  adminView,
  initialAdminState,
  transferCandidates,
} from '../public/admin.js';

const ACCOUNTS = [
  { id: 1, username: 'ada', active_items: 3 },
  { id: 2, username: 'bob', active_items: 0 },
  { id: 3, username: 'cyd', active_items: 5 },
];

const openTransfer = (state, accountId) =>
  adminTransition(state, { type: 'open-transfer', accountId });

describe('adminView', () => {
  test('打开面板先看到待批准申请', () => {
    assert.equal(adminView(initialAdminState()), 'requests');
  });

  test('切页签渲染对应视图（三个页签都要能到）', () => {
    let state = initialAdminState();
    for (const tab of ['accounts', 'archive', 'requests']) {
      state = adminTransition(state, { type: 'select-tab', tab });
      assert.equal(adminView(state), tab);
    }
  });

  test('转移视图优先于页签：进入之后整块取代当前页签视图', () => {
    const state = openTransfer(initialAdminState(), 2);
    assert.equal(adminView(state), 'transfer');
  });
});

describe('adminTransition', () => {
  test('切页签顺便离开转移视图，不会停在旧的转移状态上', () => {
    const inTransfer = openTransfer(
      adminTransition(initialAdminState(), { type: 'select-tab', tab: 'accounts' }),
      2,
    );
    const after = adminTransition(inTransfer, { type: 'select-tab', tab: 'archive' });

    assert.deepEqual(after, { tab: 'archive', transferFrom: null });
    assert.equal(adminView(after), 'archive');
  });

  test('取消转移：只清掉源账号，页签不动，回到账号列表（不是空视图）', () => {
    const inTransfer = openTransfer(
      adminTransition(initialAdminState(), { type: 'select-tab', tab: 'accounts' }),
      2,
    );
    const after = adminTransition(inTransfer, { type: 'close-transfer' });

    assert.deepEqual(after, { tab: 'accounts', transferFrom: null });
    assert.equal(adminView(after), 'accounts');
  });

  test('转移完成、渲染出错、源账号已不存在，都与取消同路：回到页签视图', () => {
    const inTransfer = { tab: 'accounts', transferFrom: 2 };
    assert.deepEqual(adminTransition(inTransfer, { type: 'close-transfer' }), {
      tab: 'accounts',
      transferFrom: null,
    });
  });

  test('迁移是纯的：不改传进来的状态（取消因此不可能改动任何数据）', () => {
    const before = { tab: 'accounts', transferFrom: 2 };
    const snapshot = { ...before };

    adminTransition(before, { type: 'close-transfer' });
    adminTransition(before, { type: 'select-tab', tab: 'archive' });
    adminTransition(before, { type: 'open-transfer', accountId: 3 });

    assert.deepEqual(before, snapshot);
  });
});

describe('transferCandidates', () => {
  test('候选里不含源账号自己', () => {
    const { from, targets } = transferCandidates(ACCOUNTS, 2);

    assert.equal(from.username, 'bob');
    assert.deepEqual(targets.map((a) => a.id), [1, 3]);
  });

  test('没有别的账号可接收：targets 为空，渲染成空视图而不是停住', () => {
    const { from, targets } = transferCandidates([ACCOUNTS[0]], 1);

    assert.equal(from.id, 1);
    assert.deepEqual(targets, []);
  });

  test('源账号已不存在：给 null，调用方据此退回账号列表，而不是指向一个不存在的账号', () => {
    assert.equal(transferCandidates(ACCOUNTS, 99), null);
  });

  test('只读：不改动账号列表，也不动列表里的账号（取消因此不改数据）', () => {
    const accounts = ACCOUNTS.map((a) => ({ ...a }));
    const snapshot = structuredClone(accounts);

    transferCandidates(accounts, 2);

    assert.deepEqual(accounts, snapshot);
  });
});
