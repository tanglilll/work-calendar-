/**
 * 表格视图的判据：派生口径（状态 / 预计所需天数 / 实际完成日期 / 按时交付 / 完成度）、
 * 分组顺序与记录数、筛选与排序、以及一屏渲染的空态、组头与底部统计。
 *
 * 期望值在测试里独立算一遍（自己的日期算术、自己的集合运算），不借用被测实现。
 * 一条要点名的断言：`statusOf` 判为「已逾期」的集合必须**恰好等于** sidebar 的 `overdue` 组
 * （`due_date < 今天`）——这条口径在仓库里有两处实现，分叉了必须在这里红，而不是只在浏览器里看得出来。
 * 别与 README 的「逾期基线」（`due_date <= 今天`，侧栏面板汇总计数用的并集）混起来：
 * 基线 = 侧栏的「已逾期」+「今天截止」两组，截止当天归「今天截止」，状态列把它算「进行中」。
 *
 * 归档时间那条用固定 ISO 串钉「本机日期」口径：本仓库开发机是 UTC+8，
 * `archived_at.slice(0,10)` 取的是 UTC 日期，本机 00:00–07:59 归档的会差一天，
 * 连带把「按时交付」判反；下面用条件断言把那个窗口钉住（在 UTC 机器上自动跳过）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ARCHIVED_GROUP,
  COLUMNS,
  LATE,
  ON_TIME,
  STATUS,
  UNLABELED,
  actualDoneDate,
  estimatedDays,
  filterRows,
  groupByQuadrant,
  onTimeOf,
  percentDoneOf,
  quadrantClass,
  quadrantOptions,
  quadrantPillClass,
  renderTable,
  renderTableRows,
  sortRows,
  statusOf,
  tableHtml,
  tableModel,
  toolbarHtml,
} from '../public/tableview.js';
import { computeGroups } from '../public/sidebar.js';
import { QUADRANTS } from '../server/config.js';

const TODAY = '2026-09-10';
const DAY = 24 * 60 * 60 * 1000;

/** 测试自己的日期算术：yyyy-mm-dd ↔ UTC 毫秒差。 */
const utc = (date) => {
  const [y, m, d] = String(date).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const daysBetween = (from, to) => (utc(to) - utc(from)) / DAY + 1;

/** 测试自己的本机日期格式化（与 util.js 的 toDateString 同规则，独立实现一遍）。 */
const localDate = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const make = (id, over = {}) => ({
  id,
  title: `事项 ${id}`,
  event_date: '2026-09-01',
  due_date: '2026-09-10',
  owners: [{ id: 1, username: '甲' }],
  color: 0,
  tag: null,
  progress: null,
  percent_done: null,
  quadrant: null,
  archived_at: null,
  ...over,
});

const idList = (rows) => rows.map((r) => r.id).sort((a, b) => a - b);
const idsIn = (html) => [...html.matchAll(/data-item-id="(\d+)"/g)].map((m) => Number(m[1]));
const headsIn = (html) => [...html.matchAll(/<th>([^<]+)<\/th>/g)].map((m) => m[1]);
/** 组头 → 该组的「记录数 N」，按渲染顺序。 */
const groupCountsIn = (html) =>
  [...html.matchAll(/data-quadrant-toggle="([^"]+)"[\s\S]*?记录数 (\d+)/g)].map(([, q, n]) => [q, Number(n)]);
const statsCountIn = (html) => {
  const m = html.match(/class="table-stats">[\s\S]*?class="count">(\d+)</);
  return m ? Number(m[1]) : null;
};
/** 某一行的 HTML 片段（按 data-item-id 定位）。 */
const rowHtmlOf = (html, id) => {
  const at = html.indexOf(`data-item-id="${id}"`);
  assert.ok(at >= 0, `表里没有第 ${id} 行`);
  return html.slice(html.lastIndexOf('<tr', at), html.indexOf('</tr>', at));
};

describe('statusOf：状态由归档 + 今天 + 起止日期推导', () => {
  test('截止当天算进行中（已逾期只到「截止日期已过」为止）', () => {
    assert.equal(statusOf(make(1, { event_date: '2026-09-01', due_date: TODAY }), TODAY), STATUS.doing);
  });

  test('昨天截止已逾期、明天截止进行中、明天开始待开始', () => {
    assert.equal(statusOf(make(1, { event_date: '2026-09-01', due_date: '2026-09-09' }), TODAY), STATUS.overdue);
    assert.equal(statusOf(make(2, { event_date: '2026-09-01', due_date: '2026-09-11' }), TODAY), STATUS.doing);
    assert.equal(statusOf(make(3, { event_date: '2026-09-11', due_date: '2026-09-20' }), TODAY), STATUS.todo);
  });

  test('起始当天是进行中（待开始只到「今天 < 起始」为止）', () => {
    assert.equal(statusOf(make(1, { event_date: TODAY, due_date: TODAY }), TODAY), STATUS.doing, '当天起当天止：还在做');
    assert.equal(statusOf(make(2, { event_date: TODAY, due_date: '2026-09-12' }), TODAY), STATUS.doing);
  });

  test('已归档即已完成：即便截止日期在未来', () => {
    const archived = make(1, { due_date: '2026-10-01', archived_at: '2026-09-05T02:00:00.000Z' });
    assert.equal(statusOf(archived, TODAY), STATUS.done);
  });

  test('已逾期的集合 === sidebar 的 overdue 组（两边都不把截止当天算逾期）', () => {
    const rows = [
      make(1, { event_date: '2026-09-08', due_date: '2026-09-08' }),
      make(2, { event_date: '2026-09-10', due_date: '2026-09-10' }),
      make(3, { event_date: '2026-09-12', due_date: '2026-09-12' }),
      make(4, { event_date: '2026-09-01', due_date: '2026-09-30' }),
    ];
    const { overdue, dueToday } = computeGroups(rows, TODAY);
    const mine = rows.filter((r) => statusOf(r, TODAY) === STATUS.overdue);

    assert.deepEqual(idList(mine), idList(overdue), '两处逾期判据必须同源');
    assert.deepEqual(idList(mine), idList(rows.filter((r) => r.due_date < TODAY)));
    for (const row of dueToday) {
      assert.ok(statusOf(row, TODAY) !== STATUS.overdue, '今天截止的那条不能被算作逾期');
    }
    assert.equal(statusOf(dueToday[0], TODAY), STATUS.doing, '今天截止 → 进行中（id 2 当天起当天止）');
  });
});

describe('estimatedDays：含首尾的整数天', () => {
  test('同日算 1 天，跨月与跨年都按真实日历日', () => {
    assert.equal(estimatedDays(make(1, { event_date: '2026-09-10', due_date: '2026-09-10' })), 1);
    assert.equal(estimatedDays(make(2, { event_date: '2026-09-01', due_date: '2026-09-10' })), 10);
    assert.equal(estimatedDays(make(3, { event_date: '2026-08-30', due_date: '2026-09-02' })), 4);
    assert.equal(estimatedDays(make(4, { event_date: '2026-12-30', due_date: '2027-01-02' })), 4);
    assert.equal(
      estimatedDays(make(5, { event_date: '2028-02-27', due_date: '2028-03-01' })),
      daysBetween('2028-02-27', '2028-03-01'),
      '闰年 2 月 29 日要算进去',
    );
  });

  test('日期不全或不是 yyyy-mm-dd 真实日期时给 null（单元格显示「—」）', () => {
    assert.equal(estimatedDays(make(1, { due_date: null })), null);
    assert.equal(estimatedDays(make(2, { event_date: '2026-9-1' })), null);
    assert.equal(estimatedDays(make(3, { event_date: '2026-02-30' })), null);
  });
});

describe('actualDoneDate / onTimeOf：归档时间取本机日期', () => {
  test('未归档：两项都是 null', () => {
    assert.equal(actualDoneDate(make(1)), null);
    assert.equal(onTimeOf(make(1)), null);
  });

  test('UTC ISO 换本机日期；UTC 与 LATE/ON_TIME 的判据都走同一个日期', () => {
    const iso = '2026-09-17T16:30:00.000Z'; // 本机若在 UTC+8，这是 09-18 00:30
    const done = localDate(iso);

    assert.equal(actualDoneDate(make(1, { archived_at: iso })), done);
    assert.equal(onTimeOf(make(2, { archived_at: iso, due_date: done })), ON_TIME, '当天交付算按时');
    assert.equal(onTimeOf(make(3, { archived_at: iso, due_date: '2026-09-01' })), LATE);

    // 这一片正是 slice(0,10) 会取错的日子：本机在 UTC 以东时，两边必须不同
    if (new Date(iso).getTimezoneOffset() < 0) {
      assert.notEqual(done, iso.slice(0, 10));
      assert.equal(actualDoneDate(make(4, { archived_at: iso })), '2026-09-18');
      assert.equal(
        onTimeOf(make(5, { archived_at: iso, due_date: '2026-09-17' })),
        LATE,
        '按 UTC 日期会误判成按时交付',
      );
    }
  });

  test('归档时间不是合法时间戳时给 null，不显示 NaN', () => {
    assert.equal(actualDoneDate(make(1, { archived_at: '不是时间' })), null);
    assert.equal(onTimeOf(make(2, { archived_at: '不是时间' })), null);
  });
});

describe('percentDoneOf：0–100 的整数，未填与非法一律 null', () => {
  test('0 是合法值，不能被当成未填', () => {
    assert.equal(percentDoneOf(make(1, { percent_done: 0 })), 0);
  });

  test('数字与数字串都认，越界/小数/非数字给 null', () => {
    assert.equal(percentDoneOf(make(1, { percent_done: 50 })), 50);
    assert.equal(percentDoneOf(make(2, { percent_done: '50' })), 50);
    assert.equal(percentDoneOf(make(3, { percent_done: 100 })), 100);
    assert.equal(percentDoneOf(make(4, { percent_done: 101 })), null);
    assert.equal(percentDoneOf(make(5, { percent_done: -1 })), null);
    assert.equal(percentDoneOf(make(6, { percent_done: 50.5 })), null);
    assert.equal(percentDoneOf(make(7, { percent_done: 'abc' })), null);
  });

  test('未填（缺字段 / null / 空串）给 null', () => {
    assert.equal(percentDoneOf(make(1)), null);
    assert.equal(percentDoneOf(make(2, { percent_done: null })), null);
    assert.equal(percentDoneOf(make(3, { percent_done: '' })), null);
  });
});

describe('groupByQuadrant：白名单顺序即分组顺序，未标注殿后，空组不渲染', () => {
  const QUADRANTS = ['紧急又重要', '重要不紧急', '紧急不重要', '不紧急不重要'];

  test('组的顺序按白名单走，不按数据出现顺序；空组不出现', () => {
    const rows = [
      make(1, { quadrant: '紧急不重要' }),
      make(2, { quadrant: '紧急又重要' }),
      make(3, { quadrant: '紧急又重要' }),
    ];
    const groups = groupByQuadrant(rows, QUADRANTS);

    assert.deepEqual(
      groups.map((g) => g.quadrant),
      ['紧急又重要', '紧急不重要'],
      '「重要不紧急」「不紧急不重要」两条空组不渲染',
    );
    assert.deepEqual(idList(groups[0].items), [2, 3]);
    assert.deepEqual(idList(groups[1].items), [1]);
  });

  test('未标注的进「未标注」组殿后（缺字段 / null / 空白都算未标注）', () => {
    const rows = [
      make(1),
      make(2, { quadrant: '' }),
      make(3, { quadrant: '   ' }),
      make(4, { quadrant: '紧急又重要' }),
    ];
    const groups = groupByQuadrant(rows, QUADRANTS);

    assert.deepEqual(groups.map((g) => g.quadrant), ['紧急又重要', UNLABELED]);
    assert.deepEqual(idList(groups[1].items), [1, 2, 3]);
  });

  test('白名单之外的取值按首次出现顺序补上，不静默丢行', () => {
    const groups = groupByQuadrant([make(1, { quadrant: '奇怪的象限' })], QUADRANTS);

    assert.deepEqual(groups.map((g) => g.quadrant), ['奇怪的象限']);
    assert.deepEqual(idList(groups[0].items), [1]);
  });

  test('没有白名单（服务端还没下发）时退到数据出现顺序，不在前端抄一份字面量', () => {
    const groups = groupByQuadrant([make(1, { quadrant: '乙' }), make(2, { quadrant: '甲' })]);

    assert.deepEqual(groups.map((g) => g.quadrant), ['乙', '甲']);
  });

  test('空列表：不渲染任何组', () => {
    assert.deepEqual(groupByQuadrant([], QUADRANTS), []);
    assert.deepEqual(groupByQuadrant([]), []);
  });

  test('象限选项：白名单在前，数据里的值补齐，去重', () => {
    assert.deepEqual(quadrantOptions([make(1, { quadrant: '紧急又重要' }), make(2, { quadrant: '甲' })], QUADRANTS), [
      ...QUADRANTS,
      '甲',
    ]);
    assert.deepEqual(quadrantOptions([], []), []);
  });
});

describe('filterRows：状态 / 象限 / 关键词', () => {
  const rows = [
    make(1, { title: '写周报', owners: [{ id: 1, username: 'Alice' }], progress: '收集数据', due_date: '2026-09-01' }),
    make(2, {
      title: '评审设计',
      owners: [{ id: 2, username: '小明' }],
      quadrant: '紧急又重要',
      event_date: '2026-09-05',
      due_date: '2026-09-20',
    }),
    make(3, { title: '团建', progress: null }),
  ];

  test('状态筛选按派生状态（含已逾期）', () => {
    // id 1 截止在昨天 → 已逾期；id 3 截止就是今天 → 进行中（截止当天不算逾期，见 statusOf）
    assert.deepEqual(idList(filterRows(rows, { today: TODAY, status: STATUS.overdue })), [1]);
    assert.deepEqual(idList(filterRows(rows, { today: TODAY, status: STATUS.doing })), [2, 3]);
    assert.deepEqual(idList(filterRows(rows, { today: TODAY, status: '' })), [1, 2, 3]);
  });

  test('象限筛选，含「未标注」这一档', () => {
    assert.deepEqual(idList(filterRows(rows, { today: TODAY, quadrant: '紧急又重要' })), [2]);
    assert.deepEqual(idList(filterRows(rows, { today: TODAY, quadrant: UNLABELED })), [1, 3]);
  });

  test('关键词匹配标题、owner 用户名与进展，忽略大小写与首尾空白', () => {
    assert.deepEqual(idList(filterRows(rows, { today: TODAY, keyword: '周报' })), [1]);
    assert.deepEqual(idList(filterRows(rows, { today: TODAY, keyword: 'alice' })), [1]);
    assert.deepEqual(idList(filterRows(rows, { today: TODAY, keyword: ' 收集 ' })), [1]);
    assert.deepEqual(idList(filterRows(rows, { today: TODAY, keyword: '不存在' })), []);
  });

  test('三个条件是「与」的关系', () => {
    assert.deepEqual(idList(filterRows(rows, { today: TODAY, status: STATUS.doing, keyword: '评审' })), [2]);
    assert.deepEqual(idList(filterRows(rows, { today: TODAY, status: STATUS.overdue, keyword: '评审' })), []);  });

  test('一条都不筛时原样返回（不复制出意外顺序）', () => {
    assert.deepEqual(idList(filterRows(rows, { today: TODAY })), [1, 2, 3]);
  });
});

describe('sortRows：截止日期 / 起始日期 / 完成度，可升降', () => {
  /** 顺序本身就是判据：这里**不能**用 idList（它会按 id 排回去）。 */
  const order = (rows) => rows.map((r) => r.id);

  test('截止日期升序与降序', () => {
    const rows = [make(1, { due_date: '2026-09-20' }), make(2, { due_date: '2026-09-05' })];
    assert.deepEqual(order(sortRows(rows, { key: 'due_date', dir: 'asc' })), [2, 1]);
    assert.deepEqual(order(sortRows(rows, { key: 'due_date', dir: 'desc' })), [1, 2]);
  });

  test('起始日期升序', () => {
    const rows = [make(1, { event_date: '2026-09-20' }), make(2, { event_date: '2026-09-05' })];
    assert.deepEqual(order(sortRows(rows, { key: 'event_date', dir: 'asc' })), [2, 1]);
  });

  test('完成度：未填（null）升序降序都排在已填之后', () => {
    const rows = [
      make(1, { percent_done: null }),
      make(2, { percent_done: 80 }),
      make(3, { percent_done: 0 }),
    ];
    assert.deepEqual(sortRows(rows, { key: 'percent_done', dir: 'asc' }).map((r) => r.id), [3, 2, 1]);
    assert.deepEqual(sortRows(rows, { key: 'percent_done', dir: 'desc' }).map((r) => r.id), [2, 3, 1]);
  });

  test('并列时按标题 localeCompare(…, "zh")', () => {
    const rows = [
      make(1, { title: '乙', due_date: '2026-09-10' }),
      make(2, { title: '甲', due_date: '2026-09-10' }),
    ];
    assert.deepEqual(sortRows(rows, { key: 'due_date', dir: 'asc' }).map((r) => r.id), [2, 1]);
  });

  test('不改动传入的数组', () => {
    const rows = [make(1, { due_date: '2026-09-20' }), make(2, { due_date: '2026-09-05' })];
    sortRows(rows, { key: 'due_date', dir: 'asc' });
    assert.deepEqual(rows.map((r) => r.id), [1, 2]);
  });

  test('列或方向写错直接抛，不静默不排序', () => {
    assert.throws(() => sortRows([], { key: 'title' }), /未知的排序列/);
    assert.throws(() => sortRows([], { key: 'due_date', dir: 'up' }), /未知的排序方向/);
  });
});

describe('tableModel / tableHtml：分组、记录数与底部统计', () => {
  const view = (over = {}) => ({ today: TODAY, quadrants: ['甲', '乙'], ...over });

  test('列顺序与列头逐列一致（任务描述 … 紧急重要度）', () => {
    assert.deepEqual(COLUMNS, [
      '任务描述',
      '任务负责人',
      '任务状态',
      '完成度',
      '预计所需天数',
      '是否按时交付',
      '项目进展描述',
      '开始日期',
      '预计完成日期',
      '实际完成日期',
      '紧急重要度',
    ]);
    assert.deepEqual(headsIn(tableHtml(view({ items: [make(1)] }))), [...COLUMNS]);
  });

  test('组头带「记录数 N」，底部统计 = 各组合计', () => {
    const rows = [
      make(1, { title: '甲一', quadrant: '甲' }),
      make(2, { title: '甲二', quadrant: '甲' }),
      make(3, { title: '乙一', quadrant: '乙' }),
      make(4, { title: '未标注一' }),
    ];
    const html = tableHtml(view({ items: rows }));

    assert.deepEqual(groupCountsIn(html), [['甲', 2], ['乙', 1], [UNLABELED, 1]]);
    assert.equal(statsCountIn(html), 4);
    assert.deepEqual(idsIn(html).sort((a, b) => a - b), [1, 2, 3, 4]);
  });

  test('折叠的分组只留组头，行不渲染（记录数照旧）', () => {
    const rows = [make(1, { quadrant: '甲' }), make(2, { quadrant: '乙' })];
    const html = tableHtml(view({ items: rows, collapsed: ['甲'] }));

    assert.deepEqual(groupCountsIn(html), [['甲', 1], ['乙', 1]]);
    assert.deepEqual(idsIn(html), [2]);
    assert.equal(statsCountIn(html), 2, '统计的是筛选后的记录数，与折叠无关');
  });

  test('空列表：只有「没有符合条件的事项。」，不渲染统计行', () => {
    const html = tableHtml(view({ items: [] }));

    assert.ok(html.includes('没有符合条件的事项。'));
    assert.equal(statsCountIn(html), null);
    assert.deepEqual(idsIn(html), []);
  });

  test('筛选后一条都不剩：同样只有空态', () => {
    const html = tableHtml(view({ items: [make(1, { quadrant: '甲' })], quadrant: '乙' }));

    assert.ok(html.includes('没有符合条件的事项。'));
    assert.equal(statsCountIn(html), null);
  });

  test('归档行单独成一组殿后，只读（不产出 data-item-id）', () => {
    const items = [make(1, { quadrant: '甲' })];
    const archived = [make(9, { archived_at: '2026-09-05T02:00:00.000Z' })];
    const html = tableHtml(view({ items, archivedItems: archived, archivesAll: true, showArchived: true }));

    assert.deepEqual(groupCountsIn(html), [['甲', 1], [ARCHIVED_GROUP, 1]]);
    assert.equal(statsCountIn(html), 2);
    assert.deepEqual(idsIn(html), [1], '归档行不带 data-item-id，点它不会走 openItem');
    assert.ok(/<tr class="archived">/.test(html));
    assert.ok(html.includes('归档仅显示最近 200 条'), '归档只是最近一页，不许冒充全集');
  });

  test('归档组的显示文案分「全部 / 我的」，但分组键不变（折叠状态认的是键）', () => {
    const archived = [make(9, { archived_at: '2026-09-05T02:00:00.000Z' })];

    const admin = tableHtml(view({ items: [make(1)], archivedItems: archived, archivesAll: true, showArchived: true }));
    const member = tableHtml(view({ items: [make(1)], archivedItems: archived, showArchived: true }));

    assert.ok(admin.includes('已归档（全部，只读）'), 'admin 看的是全库');
    assert.ok(member.includes('已归档（我的，只读）'), '其余人只看自己参与过的，标签要说清');
    assert.deepEqual(groupCountsIn(admin), groupCountsIn(member), '两边的分组键都是 ARCHIVED_GROUP');
  });

  test('开关没开时不渲染归档行，哪怕 state 里带着数据', () => {
    const archived = [make(9, { archived_at: '2026-09-05T02:00:00.000Z' })];
    const html = tableHtml(view({ items: [make(1)], archivedItems: archived, showArchived: false }));

    assert.equal(statsCountIn(html), 1);
    assert.ok(!html.includes(ARCHIVED_GROUP));
    assert.ok(!/<tr class="archived">/.test(html));
  });

  test('归档行沿用同一套筛选（状态 = 已完成只在开关打开时才有行）', () => {
    const archived = [make(9, { archived_at: '2026-09-05T02:00:00.000Z' })];
    const html = tableHtml(
      view({ items: [make(1)], archivedItems: archived, archivesAll: true, showArchived: true, status: STATUS.done }),
    );

    assert.equal(statsCountIn(html), 1);
    assert.deepEqual(idsIn(html), []);
    assert.ok(html.includes(ARCHIVED_GROUP));
  });

  test('单元格：没有值显示「—」，不出现 null / undefined', () => {
    const html = tableHtml(view({ items: [make(1, { title: '光杆事项' })] }));
    const row = rowHtmlOf(html, 1);

    assert.ok(row.includes('光杆事项'));
    // 空的是：完成度、是否按时交付、进展、实际完成日期、紧急重要度（起止日期与天数由 make 给足）
    assert.equal((row.match(/—/g) ?? []).length, 5);
    assert.ok(!row.includes('null') && !row.includes('undefined'));
  });

  test('单元格：有值的列按口径渲染（完成度进度条、状态与象限徽章、日期原样）', () => {
    const row = rowHtmlOf(
      tableHtml(
        view({
          items: [
            make(1, {
              event_date: '2026-09-01',
              due_date: '2026-09-08',
              percent_done: 40,
              quadrant: '甲',
              progress: '写了一半',
              owners: [{ id: 1, username: '甲' }, { id: 2, username: '乙' }],
            }),
          ],
        }),
      ),
      1,
    );

    assert.ok(row.includes('width:40%'), '完成度用进度条');
    assert.ok(row.includes('40%'));
    assert.ok(row.includes('8 天'), '预计所需天数含首尾');
    assert.ok(row.includes(STATUS.overdue));
    assert.ok(row.includes('甲 +1'), 'owner 是并列名单，用 util.js 的归属文案');
    assert.ok(row.includes('2026-09-01') && row.includes('2026-09-08'));
    assert.ok(row.includes('写了一半'));
    assert.ok(row.includes('甲</span>'), '象限徽章');
  });

  test('表格的文本一律转义：标题里的尖括号不会变成标签', () => {
    const html = tableHtml(view({ items: [make(1, { title: '<img src=x onerror=alert(1)>' })] }));

    assert.ok(!html.includes('<img src=x'));
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  });
});

/**
 * 象限的色号：行内徽章与组头字样共用同一套。
 *
 * 这里有一处前端的字面量副本（QUADRANT_CLASS 的键就是白名单的值），所以第一条用例拿
 * server/config.js 的 QUADRANTS **逐值核一遍**——象限改名或增删时红在这里，
 * 而不是在界面上悄悄少了一种颜色。色号按值配、与顺序无关：调整 QUADRANTS 的次序不串色。
 */
describe('象限色号：白名单每个取值一种颜色，行内与组头共用', () => {
  /** 这个 describe 自己一份 view 替身：只需要 today（白名单由行里的值本身给出）。 */
  const viewWith = (over = {}) => ({ today: TODAY, ...over });

  test('白名单里每个取值都有色号；白名单之外不给色，不猜', () => {
    for (const q of QUADRANTS) assert.ok(quadrantClass(q), `「${q}」没有色号`);
    assert.ok(quadrantClass(UNLABELED), '「未标注」也要有色号');
    assert.equal(quadrantClass('不在白名单里的值'), '');
    assert.equal(quadrantPillClass('不在白名单里的值'), 'pill', '没有色号时只剩 pill，不留悬空空格');
  });

  test('五种取值五种颜色，没有两种象限共用一色', () => {
    const classes = [...QUADRANTS, UNLABELED].map(quadrantClass);
    assert.equal(new Set(classes).size, classes.length, '颜色重复等于没标注');
  });

  test('行内徽章与组头字样都带上同一个色号类', () => {
    const html = tableHtml(viewWith({ items: [make(1, { quadrant: QUADRANTS[0] })] }));
    const cls = quadrantClass(QUADRANTS[0]);

    assert.ok(html.includes(`<span class="pill ${cls}">`), '行内徽章带色号');
    assert.ok(html.includes(`<span class="group-name ${cls}">`), '组头字样带同一色号');
    assert.ok(html.includes(`${cls}`) && html.includes(`${QUADRANTS[0]}</span>`), '字还是那个字，只是换了颜色');
  });
});

describe('toolbarHtml：筛选 / 排序 / 显示已完成', () => {
  test('「显示已完成」对所有人都在——归档视图不再是 admin 独占，范围由服务端过滤', () => {
    const html = toolbarHtml({ items: [], showArchived: false });

    assert.ok(html.includes('显示已完成'), '普通成员也要能打开自己那份归档');
    assert.ok(!html.includes('checked'), '默认不打开');
    assert.ok(!html.includes(`>${STATUS.done}<`), '开关没开时不给「已完成」这一档——选中它必然是一张空表');
    for (const s of [STATUS.todo, STATUS.doing, STATUS.overdue]) assert.ok(html.includes(`>${s}<`));
  });

  test('打开开关后有「显示已完成」（带 checked）与「已完成」这一档', () => {
    const html = toolbarHtml({ items: [], showArchived: true });

    assert.ok(html.includes('显示已完成'));
    assert.ok(html.includes('checked'));
    assert.ok(html.includes(`>${STATUS.done}<`));
  });

  test('控件回写 state：筛选、排序与方向的当前值都带在标记上', () => {
    const html = toolbarHtml({
      items: [make(1, { quadrant: '甲' })],
      quadrants: ['甲', '乙'],
      status: STATUS.doing,
      quadrant: '甲',
      keyword: '周报',
      sortKey: 'percent_done',
      sortDir: 'desc',
    });

    assert.ok(html.includes(`<option value="${STATUS.doing}" selected>${STATUS.doing}</option>`));
    assert.ok(html.includes('<option value="甲" selected>甲</option>'));
    assert.ok(html.includes('<option value="percent_done" selected>完成度</option>'));
    assert.ok(html.includes('value="周报"'));
    assert.ok(html.includes('↓ 降序'));
    assert.ok(html.includes('>+ 添加一行<'));
    assert.ok(html.includes(`>${UNLABELED}<`), '筛选里保留「未标注」这一档');
  });

  test('象限选项来自白名单（含数据里补齐的值），不硬编码四字面量', () => {
    const html = toolbarHtml({ items: [make(1, { quadrant: '甲' }), make(2, { quadrant: '丙' })], quadrants: ['甲', '乙'] });

    for (const q of ['甲', '乙', '丙']) assert.ok(html.includes(`<option value="${q}"`), `缺了象限选项 ${q}`);
  });

  test('关键词里带引号也不会破坏标记', () => {
    const html = toolbarHtml({ items: [], keyword: '" onfocus="x' });

    assert.ok(!html.includes('onfocus="x"'));
    assert.ok(html.includes('&quot; onfocus=&quot;x'));
  });
});

describe('renderTable / renderTableRows：写进 els 的两个容器', () => {
  test('renderTable 同时写工具栏与表体', () => {
    const els = { toolbar: { innerHTML: '' }, body: { innerHTML: '' } };

    renderTable(els, { items: [make(1)], today: TODAY });

    assert.ok(els.toolbar.innerHTML.includes('data-table-field="status"'));
    assert.ok(els.body.innerHTML.includes('data-item-id="1"'));
  });

  test('renderTableRows 只写表体：关键词输入与折叠分组走它，工具栏原地不动', () => {
    const els = { toolbar: { innerHTML: '原样' }, body: { innerHTML: '' } };

    renderTableRows(els, { items: [make(2)], today: TODAY });

    assert.equal(els.toolbar.innerHTML, '原样');
    assert.ok(els.body.innerHTML.includes('data-item-id="2"'));
  });
});
