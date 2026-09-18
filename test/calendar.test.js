/**
 * 日历网格的判据：42 格、周一起始、跨月裁剪、同格排序。
 *
 * calendar.js 是仓库里最纯的 module 之一（输入锚点与事项，输出格子与 HTML），
 * 但 test/ 此前从未导入它——「跨月染色不断裂」「周一列不错位」这些结论
 * 只能靠一轮真实浏览器会话换。这里只断言格子与染色结果：哪天落在哪格、
 * 哪些格被染色、同格内的次序；不逐字符串比对 HTML。
 *
 * 期望值用测试自己的 UTC 日期算术算出，不借用被测代码的 util.addDays，
 * 避免「用被测实现验被测实现」。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { GRID_SIZE, buildGrid, assignItems, gridHtml } from '../public/calendar.js';

const DAY = 24 * 60 * 60 * 1000;

/** 测试自己的日期算术：yyyy-mm-dd ↔ UTC 毫秒。 */
function utc(date) {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
const shift = (date, n) => new Date(utc(date) + n * DAY).toISOString().slice(0, 10);
/** 0 = 周日，1 = 周一。 */
const weekday = (date) => new Date(utc(date)).getUTCDay();
const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** 事项替身：只带格子需要的字段。 */
const event = (over) => ({
  id: 1,
  title: '写周报',
  event_date: '2026-09-10',
  due_date: '2026-09-10',
  color: 'blue',
  ...over,
});

/** 渲染结果里这条事项被染了几格——观察染色结果，不比对 HTML 文本。 */
const blocksFor = (html, id) => (html.match(new RegExp(`data-item-id="${id}"`, 'g')) ?? []).length;
const datesIn = (html) => [...html.matchAll(/data-date="([\d-]+)"/g)].map((m) => m[1]);
const cellsWith = (cells, id) => cells.filter((c) => c.items.some((i) => i.id === id)).map((c) => c.date);

/** 2026-09 的网格覆盖 2026-08-31 … 2026-10-11。 */
const grid = () => buildGrid({ year: 2026, month: 9 }, '2026-09-10');

describe('buildGrid：42 格、周一起始、锚定当月', () => {
  test('42 格是文档承诺的常量，任何月份都恰好 42 格', () => {
    assert.equal(GRID_SIZE, 42);
    for (const [year, month] of [
      [2026, 9],
      [2026, 6],
      [2026, 2],
      [2024, 2],
      [2026, 12],
      [2027, 1],
    ]) {
      assert.equal(buildGrid({ year, month }, '2026-09-10').length, 42, `${year}-${month} 应当是 42 格`);
    }
  });

  test('起点是当月 1 号所在周的周一，终点是起点后第 41 天', () => {
    const cases = [
      { year: 2026, month: 9, first: '2026-08-31', last: '2026-10-11' }, // 1 号周二，往前补 1 天
      { year: 2026, month: 6, first: '2026-06-01', last: '2026-07-12' }, // 1 号就是周一，不补
      { year: 2026, month: 2, first: '2026-01-26', last: '2026-03-08' }, // 1 号周日，往前补 6 天
      { year: 2024, month: 2, first: '2024-01-29', last: '2024-03-10' }, // 闰年的二月
    ];
    for (const { year, month, first, last } of cases) {
      const cells = buildGrid({ year, month }, '2026-09-10');
      assert.equal(cells[0].date, first, `${year}-${month} 的起点`);
      assert.equal(cells.at(-1).date, last, `${year}-${month} 的终点`);
    }
  });

  test('日期逐格 +1、day 与日期一致，且每第 7 格落在周一——否则整月错位', () => {
    for (const { year, month } of [
      { year: 2026, month: 9 },
      { year: 2026, month: 6 },
      { year: 2026, month: 2 },
    ]) {
      const cells = buildGrid({ year, month }, '2026-09-10');
      for (let i = 0; i < cells.length; i += 1) {
        assert.equal(Number(cells[i].date.slice(8)), cells[i].day, `${cells[i].date} 的 day 字段`);
        if (i > 0) assert.equal(utc(cells[i].date) - utc(cells[i - 1].date), DAY, '日期必须逐格 +1');
        if (i % 7 === 0) assert.equal(weekday(cells[i].date), 1, `第 ${i} 格应当是周一`);
      }
    }
  });

  test('当月每一天都在网格里，且只有当月那些格标 inMonth', () => {
    const cells = buildGrid({ year: 2026, month: 9 }, '2026-09-10');
    const inMonth = cells.filter((c) => c.inMonth).map((c) => c.date);
    const expected = Array.from(
      { length: daysInMonth(2026, 9) },
      (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`,
    );
    assert.deepEqual(inMonth, expected);
    for (const cell of cells) {
      assert.equal(cell.inMonth, cell.date.startsWith('2026-09'), `${cell.date} 的 inMonth`);
    }
  });

  test('isToday 只标今天那一格；今天落在补格时也标出，落在网格外则一格不标', () => {
    const mid = buildGrid({ year: 2026, month: 9 }, '2026-09-10').filter((c) => c.isToday);
    assert.deepEqual(mid.map((c) => c.date), ['2026-09-10']);

    const padding = buildGrid({ year: 2026, month: 9 }, '2026-08-31').filter((c) => c.isToday);
    assert.deepEqual(padding.map((c) => c.date), ['2026-08-31'], '上月末补格里的今天也要高亮');
    assert.equal(padding[0].inMonth, false);

    assert.equal(buildGrid({ year: 2026, month: 9 }, '2026-12-01').filter((c) => c.isToday).length, 0);
  });
});

describe('assignItems：铺到覆盖的每一格', () => {
  test('单日事项只染一格', () => {
    const cells = assignItems(grid(), [event({ id: 7, event_date: '2026-09-10', due_date: '2026-09-10' })]);

    assert.deepEqual(cellsWith(cells, 7), ['2026-09-10']);
  });

  test('跨多日事项逐格连续染色：格数等于天数，不跳格也不重复', () => {
    const cells = assignItems(grid(), [event({ id: 7, event_date: '2026-09-05', due_date: '2026-09-20' })]);
    const dates = cellsWith(cells, 7);

    assert.equal(dates.length, 16);
    assert.deepEqual(
      dates,
      Array.from({ length: 16 }, (_, i) => shift('2026-09-05', i)),
    );
  });

  test('上月末与下月初的补格照常染色——跨月事项的染色不在月界断裂', () => {
    const cells = assignItems(grid(), [
      event({ id: 1, event_date: '2026-08-25', due_date: '2026-09-02' }), // 起点在网格开始之前，裁到 08-31
      event({ id: 2, event_date: '2026-09-30', due_date: '2026-10-05' }), // 终点落在下月初的补格里
    ]);

    assert.deepEqual(cellsWith(cells, 1), ['2026-08-31', '2026-09-01', '2026-09-02']);
    assert.deepEqual(cellsWith(cells, 2), [
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
    ]);
    assert.equal(cells.find((c) => c.date === '2026-10-01').inMonth, false, '10-01 是补格，但照样染色');
  });

  test('完全落在 42 格之外的事项不出现——裁剪的是格子范围，不是当月', () => {
    const cells = assignItems(grid(), [
      event({ id: 1, event_date: '2026-08-01', due_date: '2026-08-30' }), // 网格开始前就结束
      event({ id: 2, event_date: '2026-10-20', due_date: '2026-10-25' }), // 网格结束后才开始
    ]);

    assert.deepEqual(cellsWith(cells, 1), []);
    assert.deepEqual(cellsWith(cells, 2), []);
  });
});

describe('同格排序：先起始日期，再标题', () => {
  const orderIn = (cells, date) => cells.find((c) => c.date === date).items.map((i) => i.title);

  test('起始日期早的在前，即使标题排序更靠后——跨多日事项在每个格子里位置一致', () => {
    const long = event({ id: 1, title: 'Zulu', event_date: '2026-09-01', due_date: '2026-09-10' });
    const short = event({ id: 2, title: 'Alpha', event_date: '2026-09-05', due_date: '2026-09-08' });
    const cells = assignItems(grid(), [short, long]); // 故意逆序输入

    for (const date of ['2026-09-05', '2026-09-06', '2026-09-08']) {
      assert.deepEqual(orderIn(cells, date), ['Zulu', 'Alpha'], `${date} 格子里的次序`);
    }
    assert.deepEqual(orderIn(cells, '2026-09-05'), orderIn(cells, '2026-09-08'), '同一条事项的位置不随格子变');
  });

  test('同一天起始按标题排（zh 排序），与输入顺序无关', () => {
    const a = event({ id: 1, title: '阿', event_date: '2026-09-07', due_date: '2026-09-07' });
    const b = event({ id: 2, title: '波', event_date: '2026-09-07', due_date: '2026-09-07' });

    assert.deepEqual(orderIn(assignItems(grid(), [b, a]), '2026-09-07'), ['阿', '波']);
    assert.deepEqual(orderIn(assignItems(grid(), [a, b]), '2026-09-07'), ['阿', '波']);
  });
});

describe('gridHtml：格子一个不少，染色与格子对应', () => {
  test('42 格全部渲染出来，日期与格子一一对应', () => {
    const cells = grid();
    const dates = datesIn(gridHtml(cells, {}));

    assert.equal(dates.length, 42);
    assert.deepEqual(dates, cells.map((c) => c.date));
  });

  test('每条事项在它覆盖的每一格各渲染一个色块，未覆盖的格子没有它', () => {
    const cells = assignItems(grid(), [
      event({ id: 7, event_date: '2026-09-10', due_date: '2026-09-12' }),
      event({ id: 8, event_date: '2026-09-10', due_date: '2026-09-10' }),
    ]);
    const html = gridHtml(cells, {});

    assert.equal(blocksFor(html, 7), 3, '跨三天就该有三块');
    assert.equal(blocksFor(html, 8), 1, '单日一块');
    assert.equal(blocksFor(html, 99), 0, '不在网格里的事项不出现');
  });

  test('同格超过 4 条：画 3 个色块并如实报出剩下几条', () => {
    const many = Array.from({ length: 5 }, (_, i) => event({ id: i + 1, title: `T${i + 1}` }));
    const html = gridHtml(assignItems(grid(), many), {});

    assert.equal(blocksFor(html, 1), 1);
    assert.equal(blocksFor(html, 3), 1);
    assert.equal(blocksFor(html, 4), 0, '第 4、5 条不再画色块');
    assert.equal(blocksFor(html, 5), 0);
    const more = html.match(/\+(\d+)\s*项/);
    assert.equal(more && Number(more[1]), 2, '「+N 项」里的 N 要等于被折叠的条数');
  });
});
