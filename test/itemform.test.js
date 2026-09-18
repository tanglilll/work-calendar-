/**
 * 事项表单的「值对象 → payload」映射。这段映射以前长在 collect() 里，与 DOM / FormData 缠在一起，
 * 于是「表单加了字段却忘了收集」只有真实浏览器会话能发现——21b42ba「进展被静默丢掉」的镜像风险。
 * 抽出 itemPayload / itemValues 后，字段契约在这里直接断言；真正读 FormData 的那一步仍在浏览器里。
 */
import { readFileSync } from 'node:fs';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ITEM_FORM_FIELDS,
  initialOwnerIds,
  itemPayload,
  itemValues,
  openItemDialog,
} from '../public/itemform.js';

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
      [...ITEM_FORM_FIELDS.map((f) => f.name), 'owner_ids'].sort(),
      '字段表 + 勾选组：两类值都从表单读出来（勾选组必须在这里取，漏掉它 manager/admin 就建不出事项）',
    );
    assert.deepEqual(values.owner_ids, [], '没勾选时是空数组，不是 undefined');
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

/**
 * 新建事项时的 owner 预勾选。
 *
 * 产品取舍（见 .scratch/arch-deepening-2-followups/issues/04）：勾选组对管理员可见，
 * 常见情形正是「给自己建一条」，取消勾选的成本低于漏勾导致服务端 400
 * 「owner 名单至少要有一个人」的成本——上一轮段界冒烟就是这么撞上的。
 * 编辑既有事项时预勾选必须**完全不生效**：勾选状态来自该事项，不该把当前账号添进去。
 */
describe('选中谁：新建预勾自己，编辑以该事项的名单为准', () => {
  const ME = { id: 9, username: '我' };
  const EDITING_SOMEONE_ELSE = { owners: [{ id: 1, username: '甲' }, { id: 2, username: '乙' }] };

  test('新建：当前账号被预勾上', () => {
    assert.deepEqual(initialOwnerIds({ item: null, me: ME, canAssign: true }), [9]);
  });

  test('编辑别人的事项：勾选仍来自该事项，当前账号不被添进去', () => {
    const ids = initialOwnerIds({ item: EDITING_SOMEONE_ELSE, me: ME, canAssign: true });
    assert.deepEqual(ids, [1, 2], '编辑态的勾选只由该事项的 owner 名单决定');
    assert.equal(ids.includes(ME.id), false, '别人建的事项不该因为是我在编辑就多一个 owner');
  });

  test('编辑自己名下的多条 owner 事项：原样给回全部 id', () => {
    const item = { owners: [{ id: 9, username: '我' }, { id: 2, username: '乙' }] };
    assert.deepEqual(initialOwnerIds({ item, me: ME, canAssign: true }), [9, 2]);
  });

  test('不能改名单的人（canAssign 为假）：没有勾选组可预勾，恒为空', () => {
    assert.deepEqual(initialOwnerIds({ item: null, me: ME, canAssign: false }), []);
    assert.deepEqual(initialOwnerIds({ item: EDITING_SOMEONE_ELSE, me: ME, canAssign: false }), []);
  });

  test('拿不到当前账号（名单加载退化的路径）不炸，也不预勾任何人', () => {
    assert.deepEqual(initialOwnerIds({ item: null, me: null, canAssign: true }), []);
    assert.deepEqual(initialOwnerIds({ canAssign: true }), []);
  });
});

/** 只记录 openDialog 写进来的标记：node:test 没有 DOM，断言落在**渲染出来的 HTML** 上。 */
function fakeDialog() {
  let html = '';
  const form = { querySelector: () => ({ focus() {} }), querySelectorAll: () => [] };
  return {
    open: false,
    get innerHTML() {
      return html;
    },
    set innerHTML(value) {
      html = value;
    },
    close() {
      this.open = false;
    },
    showModal() {
      this.open = true;
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector: (sel) => (sel === '#item-form' ? form : null),
    querySelectorAll: () => [],
  };
}

/** 从渲染出来的标记里读出某个勾选组已勾选的 id（属性顺序无关）。 */
function checkedInMarkup(html, name = 'owner_ids') {
  return [...html.matchAll(/<input[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => tag.includes(`name="${name}"`) && /\bchecked\b/.test(tag))
    .map((tag) => Number(tag.match(/value="(\d+)"/)?.[1]));
}

/** 从渲染出来的标记里读出某个勾选组的全部控件名/值。 */
function optionsInMarkup(html, name = 'owner_ids') {
  return [...html.matchAll(/<input[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => tag.includes(`name="${name}"`))
    .map((tag) => Number(tag.match(/value="(\d+)"/)?.[1]));
}

describe('owner 勾选组在标记里的预勾选状态', () => {
  const ME = { id: 9, username: '我' };
  const OTHERS = [
    { id: 1, username: '甲' },
    { id: 2, username: '乙' },
  ];
  const open = (ctx) => {
    const dialog = fakeDialog();
    openItemDialog(dialog, {
      item: null,
      today: '2026-09-18',
      tags: [],
      owners: [...OTHERS, ME],
      canAssign: true,
      onDone() {},
      ...ctx,
    });
    return dialog.innerHTML;
  };

  test('新建：当前账号那一格渲染成已勾选，别人都不勾', () => {
    const html = open({ me: ME });
    assert.deepEqual(optionsInMarkup(html), [1, 2, 9], '管理员看得见全部候选人');
    assert.deepEqual(checkedInMarkup(html), [9], '新建时预勾当前账号');
  });

  test('编辑一条 owner 是别人的事项：勾选来自该事项，当前账号不被勾上', () => {
    const html = open({ item: { owners: [{ id: 2, username: '乙' }] }, me: ME });
    assert.deepEqual(checkedInMarkup(html), [2], '编辑态不看当前账号');
  });

  test('普通成员（canAssign 为假）：表单里根本没有勾选组，本票无影响', () => {
    const html = open({ me: ME, canAssign: false });
    assert.deepEqual(optionsInMarkup(html), [], '没有 name="owner_ids" 的控件可预勾');
    assert.doesNotMatch(html, /name="owner_ids"/);
  });

  /** 传参这一环是「改了 itemform 却忘了改调用点」的落点：两条一起断言。 */
  test('app.js 的调用点把当前账号传给了 openItemDialog', () => {
    const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    const call = source.slice(source.indexOf('openItemDialog(els.itemDialog'));
    assert.match(call.slice(0, call.indexOf('})')), /me:\s*state\.account/, '当前账号由调用点传入（见工单 04）');
  });
});

describe('itemValues 的读取面（勾选组必须在这里取值）', () => {
  /** 冒充 FormData：get(name) 给单值，getAll(name) 给勾选组的全部已选项。 */
  const reader = (single, multi = {}) => ({
    get: (n) => single[n] ?? null,
    getAll: (n) => multi[n] ?? [],
  });

  test('已勾选的 owner_ids 进 payload——manager/admin 建不出事项那个 bug 的回归', () => {
    const values = itemValues(reader(VALUES, { owner_ids: ['2', '3'] }));
    assert.deepEqual(itemPayload(values, { canAssign: true }).owner_ids, [2, 3], '勾选组必须由 itemValues 取值');
  });

  test('没有勾选组时（普通成员的表单根本没有这个控件）值对象给空数组，payload 里不出现 owner_ids', () => {
    const values = itemValues(reader(VALUES));
    assert.deepEqual(values.owner_ids, []);
    assert.equal('owner_ids' in itemPayload(values, { canAssign: false }), false);
  });

  test('读取器没有 getAll（纯对象）也不炸——勾选组只在真的能读多值时取值', () => {
    const values = itemValues({ get: (n) => VALUES[n] });
    assert.equal(values.owner_ids, undefined);
  });
});
