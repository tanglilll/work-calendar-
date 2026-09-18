/**
 * 事项流程的决策层。用替身接替网络与 confirm，于是每条分支都能无头跑一遍——
 * 包括字段错误、409 版本冲突、用户取消这三条最容易被忽略的路径，
 * 以及邀请的两个分支（发出邀请 / 回应邀请）。
 *
 * 这些分支以前藏在 itemform.js 里，与 DOM 和原生 confirm 缠在一起，
 * 结果是「点一次弹 N 次」那类 bug 没有任何测试覆盖得到。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { archiveItem, invitePeople, removeItem, respondToInvite, saveItem } from '../public/items-flow.js';

/** failures 里可以放一个错误，也可以放「按调用参数决定要不要抛」的函数。 */
function fakeApi(failures = {}) {
  const calls = [];
  const record = (name) => async (...args) => {
    calls.push([name, ...args]);
    const failure = failures[name];
    if (typeof failure === 'function') {
      const err = failure(...args);
      if (err) throw err;
    } else if (failure) {
      throw failure;
    }
  };
  return {
    calls,
    api: {
      createItem: record('createItem'),
      updateItem: record('updateItem'),
      archiveItem: record('archiveItem'),
      deleteItem: record('deleteItem'),
      invite: record('invite'),
      acceptInvite: record('acceptInvite'),
      rejectInvite: record('rejectInvite'),
    },
  };
}

const withStatus = (status, message, extra = {}) =>
  Object.assign(new Error(message), { status, ...extra });

const ITEM = { id: 42, title: '写周报', version: 3 };
const PAYLOAD = { title: '写周报', event_date: '2026-09-01', due_date: '2026-09-01', tag: null };

describe('saveItem', () => {
  test('新建：调 createItem，成功则关闭并刷新', async () => {
    const { api, calls } = fakeApi();
    const result = await saveItem({ api, item: null, payload: PAYLOAD });

    assert.deepEqual(result, { ok: true, close: true });
    assert.deepEqual(calls, [['createItem', PAYLOAD]]);
  });

  test('编辑：带上 version 调 updateItem', async () => {
    const { api, calls } = fakeApi();
    const result = await saveItem({ api, item: ITEM, payload: PAYLOAD });

    assert.deepEqual(result, { ok: true, close: true });
    assert.deepEqual(calls, [['updateItem', 42, { ...PAYLOAD, version: 3 }]]);
  });

  test('字段错误：对话框不关，把 fields 交回呈现层', async () => {
    const fields = { title: '标题不能为空' };
    const { api } = fakeApi({ createItem: withStatus(400, '输入有误', { fields }) });
    const result = await saveItem({ api, item: null, payload: PAYLOAD });

    assert.equal(result.ok, false);
    assert.equal(result.close, false);
    assert.deepEqual(result.fields, fields);
    assert.equal(result.message, undefined, '字段错误不该同时弹全局提示');
  });

  test('409 版本冲突：关闭对话框并刷新，避免对着过期数据继续改', async () => {
    const { api } = fakeApi({ updateItem: withStatus(409, '此事项已被他人修改，请刷新后重试') });
    const result = await saveItem({ api, item: ITEM, payload: PAYLOAD });

    assert.equal(result.ok, false);
    assert.equal(result.close, true);
    assert.equal(result.message, '此事项已被他人修改，请刷新后重试');
  });

  test('其它错误：只提示，不关对话框', async () => {
    const { api } = fakeApi({ createItem: withStatus(500, '服务器内部错误') });
    const result = await saveItem({ api, item: null, payload: PAYLOAD });

    assert.deepEqual(result, { ok: false, close: false, message: '服务器内部错误' });
  });
});

describe('archiveItem', () => {
  test('确认框文案：点明不可撤销', async () => {
    const { api } = fakeApi();
    let asked = null;
    const confirm = (msg) => {
      asked = msg;
      return true;
    };
    await archiveItem({ api, item: ITEM, confirm });

    assert.match(asked, /确认把「写周报」标记为完成/);
    assert.match(asked, /无法撤销/);
  });

  test('用户取消：不碰网络', async () => {
    const { api, calls } = fakeApi();
    const result = await archiveItem({ api, item: ITEM, confirm: () => false });

    assert.deepEqual(result, { ok: false, close: false, reason: 'cancelled' });
    assert.deepEqual(calls, [], '取消不该发出任何请求');
  });

  test('确认：带 version 归档，成功后关对话框并提示', async () => {
    const { api, calls } = fakeApi();
    const result = await archiveItem({ api, item: ITEM, confirm: () => true });

    assert.deepEqual(result, { ok: true, close: true, toast: '已标记完成（已归档）' });
    assert.deepEqual(calls, [['archiveItem', 42, 3]]);
  });

  test('归档撞上版本冲突：同样关掉并刷新', async () => {
    const { api } = fakeApi({ archiveItem: withStatus(409, '此事项已被他人修改，请刷新后重试') });
    const result = await archiveItem({ api, item: ITEM, confirm: () => true });

    assert.equal(result.close, true);
    assert.equal(result.message, '此事项已被他人修改，请刷新后重试');
  });

  test('其它错误：不关对话框', async () => {
    const { api } = fakeApi({ archiveItem: withStatus(500, '服务器内部错误') });
    const result = await archiveItem({ api, item: ITEM, confirm: () => true });

    assert.deepEqual(result, { ok: false, close: false, message: '服务器内部错误' });
  });
});

describe('removeItem', () => {
  test('确认文案区分「删除」与「标记完成」', async () => {
    const { api } = fakeApi();
    let asked = null;
    await removeItem({
      api,
      item: ITEM,
      confirm: (msg) => {
        asked = msg;
        return true;
      },
    });

    assert.match(asked, /确认删除「写周报」/);
    assert.match(asked, /记录不会保留/);
  });

  test('取消：不碰网络', async () => {
    const { api, calls } = fakeApi();
    const result = await removeItem({ api, item: ITEM, confirm: () => false });

    assert.deepEqual(result, { ok: false, close: false, reason: 'cancelled' });
    assert.deepEqual(calls, []);
  });

  test('确认：删除成功关对话框并提示', async () => {
    const { api, calls } = fakeApi();
    const result = await removeItem({ api, item: ITEM, confirm: () => true });

    assert.deepEqual(result, { ok: true, close: true, toast: '已删除' });
    assert.deepEqual(calls, [['deleteItem', 42]]);
  });
});

describe('invitePeople', () => {
  test('未保存的事项：不碰网络，把「先保存」交回表单', async () => {
    const { api, calls } = fakeApi();
    const result = await invitePeople({ api, item: null, accountIds: [7, 8] });

    assert.deepEqual(result, { ok: false, close: false, fields: { invite_ids: '先保存这条事项，才能邀请别人' } });
    assert.deepEqual(calls, [], '事项还没有 id，一条邀请也不能发出去');
  });

  test('没勾人：不碰网络，提示先勾选', async () => {
    const { api, calls } = fakeApi();
    const result = await invitePeople({ api, item: ITEM, accountIds: [] });

    assert.deepEqual(result, { ok: false, close: false, fields: { invite_ids: '先勾选要邀请的人' } });
    assert.deepEqual(calls, []);
  });

  test('逐个发出邀请：成功不关对话框，条数如实', async () => {
    const { api, calls } = fakeApi();
    const result = await invitePeople({ api, item: ITEM, accountIds: [7, 8] });

    assert.deepEqual(result, { ok: true, close: false, toast: '已发出 2 条邀请，等对方接受' });
    assert.deepEqual(
      calls,
      [
        ['invite', 42, 7],
        ['invite', 42, 8],
      ],
      '每个人一条，顺序与勾选一致',
    );
  });

  test('服务端拒绝其中一条：不再发后面的，如实报出这条错误', async () => {
    const { api, calls } = fakeApi({
      invite: (id, accountId) => (accountId === 8 ? withStatus(400, '该账号已被邀请过') : null),
    });
    const result = await invitePeople({ api, item: ITEM, accountIds: [7, 8, 9] });

    assert.deepEqual(
      calls,
      [
        ['invite', 42, 7],
        ['invite', 42, 8],
      ],
      '出错之后第三条不能再发，也不许弹成功提示',
    );
    assert.deepEqual(result, { ok: false, close: false, message: '该账号已被邀请过' });
  });
});

describe('respondToInvite', () => {
  const INVITE = { id: 9, title: '写周报' };

  test('接受：只调 acceptInvite，提示事项已进自己的看板', async () => {
    const { api, calls } = fakeApi();
    const result = await respondToInvite({ api, invite: INVITE, accept: true });

    assert.deepEqual(result, { ok: true, toast: '已接受，这条事项现在在你的看板上' });
    assert.deepEqual(calls, [['acceptInvite', 9]], '不能顺手把同一张邀请也拒绝掉');
  });

  test('拒绝：只调 rejectInvite，提示对方可以再邀', async () => {
    const { api, calls } = fakeApi();
    const result = await respondToInvite({ api, invite: INVITE, accept: false });

    assert.deepEqual(result, { ok: true, toast: '已拒绝，对方可以再邀' });
    assert.deepEqual(calls, [['rejectInvite', 9]]);
  });

  test('接受失败（邀请已失效 / 事项已归档）：不谎报成功，把服务端消息交给提示层', async () => {
    const { api } = fakeApi({ acceptInvite: withStatus(409, '该邀请已失效') });
    const result = await respondToInvite({ api, invite: INVITE, accept: true });

    assert.deepEqual(result, { ok: false, message: '该邀请已失效' });
  });

  test('拒绝失败：同样如实报错，不弹成功提示', async () => {
    const { api } = fakeApi({ rejectInvite: withStatus(500, '服务器内部错误') });
    const result = await respondToInvite({ api, invite: INVITE, accept: false });

    assert.deepEqual(result, { ok: false, message: '服务器内部错误' });
  });
});
