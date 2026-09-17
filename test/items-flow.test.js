/**
 * 事项流程的决策层。用替身接替网络与 confirm，于是每条分支都能无头跑一遍——
 * 包括字段错误、409 版本冲突、用户取消这三条最容易被忽略的路径。
 *
 * 这些分支以前藏在 itemform.js 里，与 DOM 和原生 confirm 缠在一起，
 * 结果是「点一次弹 N 次」那类 bug 没有任何测试覆盖得到。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { archiveItem, removeItem, saveItem } from '../public/items-flow.js';

function fakeApi(failures = {}) {
  const calls = [];
  const record = (name) => async (...args) => {
    calls.push([name, ...args]);
    if (failures[name]) throw failures[name];
  };
  return {
    calls,
    api: {
      createItem: record('createItem'),
      updateItem: record('updateItem'),
      archiveItem: record('archiveItem'),
      deleteItem: record('deleteItem'),
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
