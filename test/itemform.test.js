/**
 * 事项表单的「值对象 → payload」映射。这段映射以前长在 collect() 里，与 DOM / FormData 缠在一起，
 * 于是「表单加了字段却忘了收集」只有真实浏览器会话能发现——21b42ba「进展被静默丢掉」的镜像风险。
 * 抽出 itemPayload / itemValues 后，字段契约在这里直接断言；真正读 FormData 的那一步仍在浏览器里。
 */
import { readFileSync } from 'node:fs';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ITEM_FORM_FIELDS, itemPayload, itemValues } from '../public/itemform.js';

/** 编辑框里一条填满的事项。 */
const VALUES = {
  title: '写周报',
  event_date: '2026-09-01',
  due_date: '2026-09-02',
  tag: '工作',
  progress: '已立项',
};

/** 勾选组不走字段表：要数已勾选的项，FormData.get 只给第一个（见 itemform.js 的注释）。 */
const READ_SEPARATELY = ['owner_ids', 'invite_ids'];

describe('itemPayload', () => {
  test('字段表里每个字段都原样进 payload——表就是表单与 payload 之间的唯一接口', () => {
    for (const { name } of ITEM_FORM_FIELDS) {
      const payload = itemPayload({ ...VALUES, [name]: `值-${name}` });
      assert.equal(payload[name], `值-${name}`, `${name} 必须出现在 payload 里`);
    }
  });

  test('填了进展就一定带着进展提交——21b42ba 那条静默丢数据的镜像', () => {
    assert.equal(itemPayload(VALUES).progress, '已立项');
  });

  test('文本字段：没填、或表单里没有这个控件，都归一成空字符串（不是 undefined）', () => {
    assert.deepEqual(itemPayload({ title: '写周报' }), {
      title: '写周报',
      event_date: '',
      due_date: '',
      tag: null,
      progress: '',
    });
  });

  test('标签：空即 null——服务端只接受白名单里的值或 null', () => {
    assert.equal(itemPayload({ ...VALUES, tag: '' }).tag, null);
    assert.equal(itemPayload({ ...VALUES, tag: null }).tag, null);
  });

  test('能改名单的人：勾选的 id 进 payload（字符串归一成数字，未勾选是空数组）', () => {
    const payload = itemPayload({ ...VALUES, owner_ids: ['7', '12'] }, { canAssign: true });
    assert.deepEqual(payload.owner_ids, [7, 12]);
    assert.deepEqual(itemPayload({ ...VALUES, owner_ids: [] }, { canAssign: true }).owner_ids, []);
  });

  test('不能改名单的人：payload 里没有 owner_ids 键，保存不会试图改名单', () => {
    assert.equal('owner_ids' in itemPayload({ ...VALUES, owner_ids: ['7'] }), false);
  });
});

describe('itemValues', () => {
  test('按字段表从表单读取器取原始值，读的是 form 控件名（浏览器里传的就是 FormData）', () => {
    const fd = new FormData();
    fd.set('title', '写周报');
    fd.set('event_date', '2026-09-01');
    fd.set('due_date', '2026-09-02');
    fd.set('progress', '已立项');

    const values = itemValues(fd);
    assert.deepEqual(
      Object.keys(values).sort(),
      ITEM_FORM_FIELDS.map((f) => f.name).sort(),
    );
    assert.equal(values.title, '写周报');
    assert.equal(values.progress, '已立项');
    assert.equal(values.tag, null, '表单没有这个控件时 FormData.get 给 null，归一交给 itemPayload');
  });

  test('整条纯链路：表单读取 → payload（浏览器里 collect() 走的正是这两步）', () => {
    const fd = new FormData();
    fd.set('title', '写周报');
    fd.set('tag', '');
    fd.set('progress', '已立项');

    assert.deepEqual(itemPayload(itemValues(fd)), {
      title: '写周报',
      event_date: '',
      due_date: '',
      tag: null,
      progress: '已立项',
    });
  });
});

describe('表单控件与字段表', () => {
  /**
   * 静态一致性检查：模块里 name="…" 出现的每个控件名，要么进 ITEM_FORM_FIELDS（由映射统一收集），
   * 要么在「单独读取」清单里。node:test 里没有 DOM 能看见表单，这一条补上「在表单里加了控件
   * 却忘了接线」这个缺口——它正是 21b42ba 的镜像风险。断言的是两张表是否同源，不是 HTML 字符串。
   */
  test('表单里的每个控件都已接线（加了控件忘了收集会在这里红）', () => {
    const source = readFileSync(new URL('../public/itemform.js', import.meta.url), 'utf8');
    const inMarkup = [
      ...new Set([...source.matchAll(/\bname="([^"${}]+)"/g)].map((m) => m[1])),
    ].sort();
    const wired = [...new Set([...ITEM_FORM_FIELDS.map((f) => f.name), ...READ_SEPARATELY])].sort();

    assert.deepEqual(inMarkup, wired, '控件名与字段表 / 单独读取清单必须一一对应');
  });
});
