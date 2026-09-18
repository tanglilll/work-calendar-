/**
 * 侧栏分桶的判据：README「侧栏三个面板的口径」那张表第一次有断言。
 *
 * 最该点名的是「逾期基线」这条写在 README 里的承诺：截止提醒的两组
 * （已逾期 / 今天截止）**不重叠**，合计**恰好等于** `due_date <= 今天` 的全部事项，
 * 也就是面板标题上那个汇总计数。此前零覆盖——sidebar.js 与 calendar.js 一样，
 * test/ 从未导入过。
 *
 * computeGroups 只认日期：「未归档」由上游保证（server/items.js 的列表只发未归档项，
 * 见 test/items.test.js「已归档的不出现在列表里」），所以这里只钉日期口径。
 * 期望值在测试里独立算一遍，用集合比较而不是数组次序。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { computeGroups, renderPanels } from '../public/sidebar.js';

const TODAY = '2026-09-10';

const make = (id, event_date, due_date) => ({ id, title: `事项 ${id}`, event_date, due_date });

/**
 * 覆盖四类边界的混合盘：
 * - 1 单日、昨天截止；2 单日、今天截止；3 / 9 单日、未来
 * - 4 跨今天且今天截止；5 已结束的跨多日；6 今天开始、15 日截止
 * - 7 未来的跨多日；8 昨天截止的跨多日；10 覆盖整个九月
 */
const ALL = [
  make(1, '2026-09-08', '2026-09-08'),
  make(2, '2026-09-10', '2026-09-10'),
  make(3, '2026-09-12', '2026-09-12'),
  make(4, '2026-09-05', '2026-09-10'),
  make(5, '2026-09-01', '2026-09-03'),
  make(6, '2026-09-10', '2026-09-15'),
  make(7, '2026-09-20', '2026-09-25'),
  make(8, '2026-08-30', '2026-09-09'),
  make(9, '2026-09-11', '2026-09-11'),
  make(10, '2026-09-01', '2026-09-30'),
];

/** 独立算一遍各口径，不与 computeGroups 相互印证。 */
const baselineOf = (items) => items.filter((i) => i.due_date <= TODAY);
const overdueOf = (items) => items.filter((i) => i.due_date < TODAY);
const dueTodayOf = (items) => items.filter((i) => i.due_date === TODAY);
const coveringOf = (items) => items.filter((i) => i.event_date <= TODAY && TODAY <= i.due_date);
const multiOf = (items) => items.filter((i) => i.event_date < i.due_date);

const idList = (items) => items.map((i) => i.id).sort((a, b) => a - b);

describe('computeGroups：分桶不变量', () => {
  test('逾期基线 = 已逾期 + 今天截止，两组不重叠（README 的承诺，此前零断言）', () => {
    const { overdue, dueToday } = computeGroups(ALL, TODAY);
    const baseline = baselineOf(ALL);

    assert.deepEqual(idList([...overdue, ...dueToday]), idList(baseline), '两组合起来必须恰好是基线');
    assert.equal(overdue.length + dueToday.length, baseline.length, '合计等于基线，就说明两组没有重叠');
    const inBoth = overdue.filter((i) => dueToday.some((d) => d.id === i.id));
    assert.deepEqual(idList(inBoth), [], '同一条不能同时落进已逾期与今天截止');
  });

  test('基线的边界：截止当天归「今天截止」，昨天截止归「已逾期」', () => {
    const { overdue, dueToday } = computeGroups(
      [make(1, '2026-09-09', '2026-09-09'), make(2, '2026-09-10', '2026-09-10')],
      TODAY,
    );

    assert.deepEqual(idList(overdue), [1]);
    assert.deepEqual(idList(dueToday), [2]);
  });

  test('今日任务 = 覆盖今天的事项（起始与截止都含今天）', () => {
    const { covering } = computeGroups(ALL, TODAY);

    assert.deepEqual(idList(covering), idList(coveringOf(ALL)));
  });

  test('多日任务 = event_date < due_date，单日不算、已结束的也算', () => {
    const { multi } = computeGroups(ALL, TODAY);

    assert.deepEqual(idList(multi), idList(multiOf(ALL)));
  });

  test('今天做且今天截止的单日事项同时出现在两个面板——README 写明的重叠，不是 bug', () => {
    const { covering, dueToday } = computeGroups([make(2, TODAY, TODAY)], TODAY);

    assert.deepEqual(idList(covering), [2]);
    assert.deepEqual(idList(dueToday), [2], '有人把它当 bug 从某一组里删掉，这条就会红');
  });

  test('空列表：四组皆空，不抛错', () => {
    const groups = computeGroups([], TODAY);

    assert.deepEqual(groups, { covering: [], overdue: [], dueToday: [], multi: [] });
  });
});

/** 渲染结果里第一个计数就是面板标题上的汇总计数。 */
const firstCount = (html) => {
  const m = html.match(/class="count[^"]*">\s*(\d+)\s*</);
  return m ? Number(m[1]) : null;
};
const idsInHtml = (html) => [...html.matchAll(/data-item-id="(\d+)"/g)].map((m) => Number(m[1])).sort((a, b) => a - b);

describe('renderPanels：面板上的计数与行就是分桶结果', () => {
  const render = (items) => {
    const els = { today: {}, due: {}, multi: {} };
    renderPanels(els, items, TODAY, {});
    return els;
  };

  test('截止提醒：标题汇总计数 = 两组之和 = 逾期基线口径的总数，行正好是两组', () => {
    const els = render(ALL);

    assert.equal(firstCount(els.due.innerHTML), baselineOf(ALL).length, '汇总计数必须等于逾期基线');
    assert.equal(
      firstCount(els.due.innerHTML),
      overdueOf(ALL).length + dueTodayOf(ALL).length,
      '也必须等于已逾期 + 今天截止',
    );
    assert.deepEqual(idsInHtml(els.due.innerHTML), idList(baselineOf(ALL)));
  });

  test('今日任务与多日任务：各自的计数与行等于本组', () => {
    const els = render(ALL);

    assert.equal(firstCount(els.today.innerHTML), coveringOf(ALL).length);
    assert.deepEqual(idsInHtml(els.today.innerHTML), idList(coveringOf(ALL)));
    assert.equal(firstCount(els.multi.innerHTML), multiOf(ALL).length);
    assert.deepEqual(idsInHtml(els.multi.innerHTML), idList(multiOf(ALL)));
  });

  test('空列表：三个面板都渲染空态，计数为 0', () => {
    const els = render([]);

    for (const key of ['today', 'due', 'multi']) {
      assert.equal(firstCount(els[key].innerHTML), 0, `${key} 面板的计数`);
      assert.deepEqual(idsInHtml(els[key].innerHTML), [], `${key} 面板不该有行`);
    }
  });
});
