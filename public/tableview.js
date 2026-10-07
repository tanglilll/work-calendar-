/**
 * 表格视图：「工作日志」那张表在本项目的落地。
 *
 * 和 calendar.js / sidebar.js 同一种分工：派生口径全是纯函数（node:test 直接 import 断言），
 * 呈现集中在 toolbarHtml / tableHtml 两处字符串构造里，DOM 与事件由 app.js 接线（委托在 #app 上）。
 *
 * 三条口径要一起看（口径本身不落库，全部由前端从既有字段推导）：
 *
 * - **状态**：已归档 → 已完成；否则按「今天」与起止日期分成 待开始 / 已逾期 / 进行中。
 *   注意「截止当天即算已逾期」——这与侧栏的逾期基线（README「侧栏三个面板的口径」）同源：
 *   两边都是 `due_date <= 今天`。这条判据在仓库里有两处实现，test/tableview.test.js 用
 *   「statusOf 判为已逾期的集合 === sidebar.computeGroups 的逾期基线集合」把分叉钉红。
 * - **今天**一律取 state.today（服务端视图下发的同一天），这里不自己 new Date()——
 *   否则每个浏览器各算各的「今天」，跨时区/跨午夜就对不上。
 * - **归档时间**（archived_at）是 UTC ISO 串，展示一律换本机日期（util.js:34 的约定，
 *   admin.js:172 的归档表同源）。直接 slice(0,10) 取的是 UTC 日期，本机在东八区时
 *   00:00–07:59 归档的那些会早一天，并连带把「是否按时交付」判反。
 */
import { esc, ownerLabel, ownerNames, toDateString } from './util.js';

/** 列顺序：与截图逐列一致（任务描述 … 紧急重要度）。 */
export const COLUMNS = Object.freeze([
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

/** 状态词表。四个字面量既是筛选下拉的值，也是单元格里的字。 */
export const STATUS = Object.freeze({
  done: '已完成',
  doing: '进行中',
  todo: '待开始',
  overdue: '已逾期',
});

/** 状态 → 徽章类名（只有区分，不做装饰）。 */
const STATUS_CLASS = Object.freeze({
  [STATUS.done]: 'st-done',
  [STATUS.doing]: 'st-doing',
  [STATUS.todo]: 'st-todo',
  [STATUS.overdue]: 'st-overdue',
});

/** 「是否按时交付」的两个取值。 */
export const ON_TIME = '按时交付';
export const LATE = '逾期交付';

/** 未标注象限的分组键，也是筛选下拉里「未标注」那一项的值。 */
export const UNLABELED = '未标注';

/** 归档行单独成一组（不参与象限分组），殿后。 */
export const ARCHIVED_GROUP = '已归档（只读）';

/**
 * 归档组是「最近一页」而不是全部：服务端按 archived_at DESC 取 LIMITS.ARCHIVE_PAGE_SIZE 条
 * （server/config.js 的 ARCHIVE_PAGE_SIZE、server/items.js 的 listArchived）。前端不持有 limits，
 * 所以这里只把话说清楚，不让底部统计冒充全集。
 */
const ARCHIVE_PAGE_NOTE = '归档仅显示最近 200 条';

/** 排序列的词表：值就是 state 里存的那个键。 */
export const SORT_KEYS = Object.freeze({
  due_date: '预计完成日期',
  event_date: '开始日期',
  percent_done: '完成度',
});

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** yyyy-mm-dd → UTC 天数序号。用 UTC 做差，避开夏令时那天少/多一小时；非法日期给 null。 */
function dayNumber(date) {
  const s = String(date ?? '');
  if (!DATE_RE.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const at = Date.UTC(y, m - 1, d);
  const dt = new Date(at);
  // 2026-02-30 这类不存在的日子会被 Date.UTC 顺延成三月：按非法处理
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return at / DAY_MS;
}

/**
 * 任务状态。已归档即「已完成」（归档是本项目的终态与完成态，见 CONTEXT.md）；
 * 其余按今天分桶；`today >= due_date` 就是逾期基线，截止当天算已逾期。
 */
export function statusOf(item, today) {
  if (item.archived_at) return STATUS.done;
  if (today < item.event_date) return STATUS.todo;
  if (today >= item.due_date) return STATUS.overdue;
  return STATUS.doing;
}

/** 预计所需天数：含首尾的整数天（同日事项算 1 天）；日期不全给 null。 */
export function estimatedDays(item) {
  const from = dayNumber(item.event_date);
  const to = dayNumber(item.due_date);
  if (from === null || to === null) return null;
  return to - from + 1;
}

/** 实际完成日期：归档时间的**本机**日期；未归档给 null。 */
export function actualDoneDate(item) {
  if (!item.archived_at) return null;
  const at = new Date(item.archived_at);
  if (Number.isNaN(at.getTime())) return null;
  return toDateString(at);
}

/** 是否按时交付：未归档给 null；已归档比「本机完成日期」与截止日期，当天算按时。 */
export function onTimeOf(item) {
  const done = actualDoneDate(item);
  if (done === null) return null;
  return done <= item.due_date ? ON_TIME : LATE;
}

/**
 * 完成度（percent_done）：0–100 的整数，未填给 null。
 * 上下限的源头是 server/config.js 的 LIMITS.PERCENT_DONE_MIN / MAX（服务端校验用它）；
 * 这里只负责把「没填 / 不是整数 / 越界」统一成 null，好让单元格显示「—」、排序把它放末尾。
 */
export function percentDoneOf(item) {
  const raw = item.percent_done;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 100) return null;
  return n;
}

/** 紧急重要度：空串 / 空白一律当未标注（null）。 */
export function quadrantOf(item) {
  const q = String(item.quadrant ?? '').trim();
  return q || null;
}

/**
 * 按紧急重要度分组。顺序即白名单顺序（state.quadrants，由 bootstrap 下发）；
 * 白名单之外的取值按首次出现顺序补齐——不静默丢行，也不在前端抄第二份白名单；
 * 未标注（null）独立成组殿后；空组不渲染（不会出现在结果里）。
 */
export function groupByQuadrant(rows, quadrants = []) {
  const order = [];
  const seen = new Set();
  const push = (value) => {
    const q = String(value ?? '').trim();
    if (q && !seen.has(q)) {
      seen.add(q);
      order.push(q);
    }
  };
  for (const q of quadrants ?? []) push(q);
  for (const row of rows) push(quadrantOf(row));

  const buckets = new Map(order.map((q) => [q, []]));
  const unlabeled = [];
  for (const row of rows) {
    const q = quadrantOf(row);
    if (q === null) unlabeled.push(row);
    else buckets.get(q).push(row);
  }

  const groups = order
    .map((quadrant) => ({ quadrant, items: buckets.get(quadrant) }))
    .filter((group) => group.items.length);
  if (unlabeled.length) groups.push({ quadrant: UNLABELED, items: unlabeled });
  return groups;
}

/** 筛选下拉里的象限选项：白名单在前，数据里出现过的值补齐（顺序稳定）。 */
export function quadrantOptions(items, quadrants = []) {
  const out = [];
  const add = (value) => {
    const q = String(value ?? '').trim();
    if (q && !out.includes(q)) out.push(q);
  };
  for (const q of quadrants ?? []) add(q);
  for (const item of items ?? []) add(quadrantOf(item));
  return out;
}

/**
 * 筛选：状态（词表字面量）/ 象限（白名单字面量或 UNLABELED）/ 关键词
 * （匹配标题、owner 用户名、进展；忽略大小写与首尾空白）。空串 = 该条不过滤。
 */
export function filterRows(rows, { today = '', status = '', quadrant = '', keyword = '' } = {}) {
  const needle = String(keyword ?? '').trim().toLowerCase();
  return rows.filter((row) => {
    if (status && statusOf(row, today) !== status) return false;
    if (quadrant) {
      const q = quadrantOf(row);
      if (quadrant === UNLABELED ? q !== null : q !== quadrant) return false;
    }
    if (needle) {
      const haystack = [row.title, ...(row.owners ?? []).map((o) => o.username), row.progress].map((v) =>
        String(v ?? '').toLowerCase(),
      );
      if (!haystack.some((text) => text.includes(needle))) return false;
    }
    return true;
  });
}

/**
 * 排序：截止日期 / 起始日期 / 完成度，可升降。
 *
 * - 完成度未填（null）一律排在已填之后——升降序都一样：没填不该在升序里冒充 0；
 * - 同一排序键并列时按标题 `localeCompare(…, 'zh')`（与 calendar.js:56、sidebar.js:38 同源）；
 * - 键或方向写错直接抛：选择项由工具栏给，写错名字必须出声（与 fieldsFor 同一种取舍）。
 */
export function sortRows(rows, { key = 'due_date', dir = 'asc' } = {}) {
  if (!Object.hasOwn(SORT_KEYS, key)) throw new Error(`未知的排序列：${key}`);
  if (dir !== 'asc' && dir !== 'desc') throw new Error(`未知的排序方向：${dir}`);
  const sign = dir === 'asc' ? 1 : -1;

  const valueOf = (row) => {
    if (key === 'percent_done') return percentDoneOf(row);
    const value = String(row[key] ?? '');
    return value === '' ? null : value;
  };

  return [...rows].sort((a, b) => {
    const av = valueOf(a);
    const bv = valueOf(b);
    if (av === null && bv !== null) return 1;
    if (av !== null && bv === null) return -1;
    if (av !== null && bv !== null && av !== bv) return av < bv ? -sign : sign;
    return String(a.title).localeCompare(String(b.title), 'zh');
  });
}

/** 一屏表格的数据：筛选 → 排序 → 分组，外加底部统计要的两个数。 */
export function tableModel(view = {}) {
  const {
    items = [],
    archivedItems = [],
    today = '',
    quadrants = [],
    canArchive = false,
    showArchived = false,
    status = '',
    quadrant = '',
    keyword = '',
    sortKey = 'due_date',
    sortDir = 'asc',
  } = view;

  const filters = { today, status, quadrant, keyword };
  const sorter = { key: sortKey, dir: sortDir };
  const active = sortRows(filterRows(items, filters), sorter);
  const archived =
    canArchive && showArchived ? sortRows(filterRows(archivedItems, filters), sorter) : [];

  const groups = groupByQuadrant(active, quadrants);
  if (archived.length) groups.push({ quadrant: ARCHIVED_GROUP, items: archived });

  return {
    groups,
    count: active.length + archived.length,
    archivedCount: archived.length,
    // 归档组显示不等于「用户想看归档」：非 admin 即便 state 里开着也拿不到数据
    showsArchive: canArchive && showArchived,
  };
}

/** 空单元格一律「—」：不显示 null / undefined / 空串。 */
const dash = (value) => (value === null || value === undefined || value === '' ? '—' : esc(value));

/** 完成度单元格：进度条 + 百分数；未填「—」。 */
function percentHtml(percent) {
  if (percent === null) return '—';
  return `<span class="bar"><span style="width:${percent}%"></span></span>${percent}%`;
}

function rowHtml(item, view) {
  const color = (view.palette ?? [])[item.color] || '#e5e7eb';
  const status = statusOf(item, view.today);
  const percent = percentDoneOf(item);
  const days = estimatedDays(item);
  const onTime = onTimeOf(item);
  const quadrant = quadrantOf(item);
  const archived = !!item.archived_at;
  // 归档行**不产出 data-item-id**：app.js 的委托会把任何 [data-item-id] 交给 openItem，
  // 而 state.items 里永远没有归档行（列表按 archived_at IS NULL 过滤），点开只会报
  // 「该事项已不存在」——「归档行只读」就被这条路径悄悄推翻了。类名 tr.archived 够用。
  const openAttr = archived ? '' : ` data-item-id="${item.id}"`;

  return `<tr class="${archived ? 'archived' : ''}"${openAttr}>
      <td class="cell-title"><span class="color-dot" style="background:${color}"></span>${esc(item.title)}${
        item.tag ? `<span class="tag-chip">${esc(item.tag)}</span>` : ''
      }</td>
      <td title="${esc(ownerNames(item))}">${esc(ownerLabel(item))}</td>
      <td><span class="pill ${STATUS_CLASS[status]}">${esc(status)}</span></td>
      <td class="cell-percent">${percentHtml(percent)}</td>
      <td>${dash(days === null ? null : `${days} 天`)}</td>
      <td>${onTime ? `<span class="pill ${onTime === ON_TIME ? 'ontime' : 'late'}">${esc(onTime)}</span>` : '—'}</td>
      <td class="cell-progress" title="${esc(item.progress)}">${dash(item.progress)}</td>
      <td>${dash(item.event_date)}</td>
      <td>${dash(item.due_date)}</td>
      <td>${dash(actualDoneDate(item))}</td>
      <td>${quadrant ? `<span class="pill">${esc(quadrant)}</span>` : '—'}</td>
    </tr>`;
}

function groupHeadHtml(group, collapsed) {
  return `<tr class="group-row" data-quadrant-toggle="${esc(group.quadrant)}" title="点击折叠 / 展开">
      <td colspan="${COLUMNS.length}">
        <span class="group-caret">${collapsed ? '▸' : '▾'}</span>${esc(group.quadrant)}
        <span class="count">记录数 ${group.items.length}</span>
      </td>
    </tr>`;
}

/** 底部统计：记录数 N（= 当前表里真正画出来的行数），归档组另把「只有一页」说明白。 */
function statsHtml(model) {
  const note =
    model.showsArchive && model.archivedCount
      ? `<span class="hint">（${esc(ARCHIVE_PAGE_NOTE)}）</span>`
      : '';
  return `<p class="table-stats">记录数 <span class="count">${model.count}</span>${note}</p>`;
}

/** 表体：分组头 + 行 + 底部统计。所有组都为空时只剩一句空态，不渲染统计行。 */
export function tableHtml(view = {}) {
  const model = tableModel(view);
  if (model.count === 0) return '<p class="panel-empty">没有符合条件的事项。</p>';

  const collapsed = view.collapsed ?? [];
  const body = [];
  for (const group of model.groups) {
    const isCollapsed = collapsed.includes(group.quadrant);
    body.push(groupHeadHtml(group, isCollapsed));
    if (!isCollapsed) body.push(group.items.map((item) => rowHtml(item, view)).join(''));
  }

  return `<table class="data">
      <thead><tr>${COLUMNS.map((label) => `<th>${esc(label)}</th>`).join('')}</tr></thead>
      <tbody>${body.join('')}</tbody>
    </table>
    ${statsHtml(model)}`;
}

function optionHtml(value, label, selected) {
  return `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`;
}

/**
 * 工具栏：添加一行 / 筛选（状态、象限、关键词）/ 排序（列 + 升降）/ 显示已完成。
 *
 * 「显示已完成」只对 admin 出现（归档视图是 admin 独有的，后端同样会 403）；
 * 状态里也因此只在开关打开时才给「已完成」——否则普通成员选中它必然是一张空表。
 * 控件的值都从 state 回写（selected / value），重画不会把用户的选择弄丢。
 */
export function toolbarHtml(view = {}) {
  const {
    items = [],
    archivedItems = [],
    quadrants = [],
    canArchive = false,
    showArchived = false,
    status = '',
    quadrant = '',
    keyword = '',
    sortKey = 'due_date',
    sortDir = 'asc',
  } = view;

  const statuses = [STATUS.todo, STATUS.doing, STATUS.overdue];
  if (canArchive && showArchived) statuses.push(STATUS.done);

  const quadrantsForFilter = quadrantOptions([...items, ...archivedItems], quadrants);

  const archiveToggle = canArchive
    ? `<label class="tool-check"><input type="checkbox" data-table-field="archived"${
        showArchived ? ' checked' : ''
      }>显示已完成</label>`
    : '';

  return `<button type="button" class="primary" data-new-item>+ 添加一行</button>
    <label class="tool">状态<select data-table-field="status">${optionHtml('', '全部', status)}${statuses
      .map((s) => optionHtml(s, s, status))
      .join('')}</select></label>
    <label class="tool">紧急重要度<select data-table-field="quadrant">${optionHtml('', '全部', quadrant)}${quadrantsForFilter
      .map((q) => optionHtml(q, q, quadrant))
      .join('')}${optionHtml(UNLABELED, UNLABELED, quadrant)}</select></label>
    <label class="tool">关键词<input type="search" data-table-keyword value="${esc(keyword)}" placeholder="标题 / owner / 进展"></label>
    <label class="tool">排序<select data-table-field="sort">${Object.entries(SORT_KEYS)
      .map(([key, label]) => optionHtml(key, label, sortKey))
      .join('')}</select></label>
    <button type="button" data-table-dir title="切换升序 / 降序">${sortDir === 'asc' ? '↑ 升序' : '↓ 降序'}</button>
    ${archiveToggle}`;
}

/** 整块重画表格视图（工具栏 + 表体）：视图切换、重拉、筛选/排序变更时用。 */
export function renderTable(els, view) {
  els.toolbar.innerHTML = toolbarHtml(view);
  els.body.innerHTML = tableHtml(view);
}

/**
 * 只重画表体，工具栏不动。
 * 关键词输入与分组折叠走这里：重画工具栏会把输入框换成新节点，焦点与光标位置就没了。
 */
export function renderTableRows(els, view) {
  els.body.innerHTML = tableHtml(view);
}
