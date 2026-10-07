/** 前端入口：登录态、状态管理、实时同步与事件委托。 */
import { api } from './api.js';
import { SESSION_EXPIRED_MESSAGE, setSessionExpiredHandler } from './session.js';
import { toast, formatMonth, setFieldErrors, showFormFailure } from './util.js';
import { buildGrid, assignItems, gridHtml } from './calendar.js';
import { renderPanels } from './sidebar.js';
import { STATUS, renderTable, renderTableRows } from './tableview.js';
import { openItemDialog } from './itemform.js';
import { openAdminDialog } from './admin.js';
import { openInvitesDialog } from './invites.js';

const els = {
  auth: document.getElementById('auth'),
  app: document.getElementById('app'),
  grid: document.getElementById('grid'),
  monthNav: document.getElementById('month-nav'),
  monthLabel: document.getElementById('month-label'),
  viewSwitch: document.getElementById('view-switch'),
  calendarView: document.getElementById('calendar-view'),
  tableView: document.getElementById('table-view'),
  tableToolbar: document.getElementById('table-toolbar'),
  tableBody: document.getElementById('table-body'),
  whoami: document.getElementById('whoami'),
  btnAdmin: document.getElementById('btn-admin'),
  btnInvites: document.getElementById('btn-invites'),
  inviteCount: document.getElementById('invite-count'),
  panelToday: document.getElementById('panel-today'),
  panelDue: document.getElementById('panel-due'),
  panelMulti: document.getElementById('panel-multi'),
  itemDialog: document.getElementById('item-dialog'),
  adminDialog: document.getElementById('admin-dialog'),
  invitesDialog: document.getElementById('invites-dialog'),
};

/** 权限由服务端下发（bootstrap），前端不自行比对角色字符串。 */
const NO_CAPABILITIES = Object.freeze({ seesAllItems: false, assignsOwner: false, managesAccounts: false });

/**
 * 前端状态的形状与写入权都只在这里。
 *
 * 字段按写入者分组，别处一律不要直接写 `state.x`：
 *
 * - **装载器**：`account` / `capabilities` / `roles` / `tags` / `quadrants` / `palette` / `today` /
 *   `inviteCount` / `anchor` / `owners` / `items` / `archivedItems` —— 只由 `runRefresh()` 按声明表
 *   （`REFRESH_PLAN`）写，写哪些字段由表决定。
 * - **本地视图**：`anchor` 也由 `shiftMonth()` 写（用户翻月）；日切重拉不动它。
 *   表格视图那一组（`view` / `table*` / `collapsedQuads` / `showArchived`）由表格的交互就地写。
 *   它们**不许放模块级变量**：`clearSession()` 只把这份字面量重置回未登录形状，放外面
 *   登出后换一个账号登录时，上一个账号的筛选、折叠与开关会跟着新账号。
 * - **会话收尾**：`clearSession()` 把整份重置回未登录形状——形状的定义只有这里一处。
 * - **连接**：`stream` 只由 `connectStream()` / `clearSession()` 写；**重拉字段一律不碰它**，
 *   这是「重拉不会重新建流」的结构保证（唯一建流点是 `boot()`）。
 *
 * `inviteCount` 以前不在这份字面量里：它由 bootstrap 的回调赋值、又在 render 里被读，
 * 于是漏赋值时角标停在 `undefined`。初值写进形状，最坏也只是 0。
 */
export function createState() {
  return {
    account: null,
    capabilities: { ...NO_CAPABILITIES },
    roles: [],
    tags: [],
    // 紧急重要度的白名单（顺序即分组顺序）。服务端还没下发时为空数组，
    // 表格的分组顺序退到「数据里首次出现的顺序」，不另抄一份四字面量。
    quadrants: [],
    palette: [],
    today: '',
    // 待接受邀请的条数：顶栏「邀请」入口的角标
    inviteCount: 0,
    // 事项对话框里可选的 owner 名单
    owners: [],
    items: [],
    // 归档视图（admin 专用，只读）。由装载器按 capabilities.managesAccounts 决定拉不拉，见 LOADERS
    archivedItems: [],
    // 日历正显示的月份；登录 / self 全量重拉时回到 today 所在月
    anchor: { year: 0, month: 0 },
    // —— 本地视图（用户自己的选择，重拉不动；登出即丢）——
    // 当前视图：'calendar' | 'table'
    view: 'calendar',
    // 表格视图的筛选与排序（值就是工具栏控件的值，见 tableview.js）
    tableStatus: '',
    tableQuadrant: '',
    tableKeyword: '',
    tableSort: 'due_date',
    tableDir: 'asc',
    // 折叠的分组键（象限字面量 / UNLABELED / ARCHIVED_GROUP）
    collapsedQuads: [],
    // 「显示已完成」：只对 admin 出现；数据在 archivedItems
    showArchived: false,
    stream: null,
  };
}

const state = createState();

const canAssign = () => state.capabilities.assignsOwner;

/** 会话组字段：一次 `/api/bootstrap` 同时供这几个，装载时只写声明表要到的那些。 */
const SESSION_FIELDS = [
  'account',
  'capabilities',
  'roles',
  'tags',
  'quadrants',
  'palette',
  'today',
  'anchor',
  'inviteCount',
];

/**
 * 装载器表：一格 = 一次网络请求，`fields` 是它提供的字段。
 *
 * `providesSession` 的那格同时是会话的裁决者：它拿回「未登录」就代表会话不在了——
 * 收尾（关流、清状态、回登录页）后本轮到此为止，后面的装载器一个都不跑。未登录时去拉
 * 事项与名单只会拿到 401，再把「登录已失效」糊在一张刚打开的登录页上。
 *
 * 次序有意固定为「会话 → 名单 → 事项 → 归档」：名单拿不到时会退到当前账号，会话得先落地
 * （归档那一格按 `capabilities` 决定拉不拉，所以它必须排在会话之后）。
 */
const LOADERS = [
  {
    fields: SESSION_FIELDS,
    providesSession: true,
    async load(client) {
      const b = await client.bootstrap();
      if (!b.authenticated) return { account: null };
      const [year, month] = b.today.split('-').map(Number);
      return {
        account: b.account,
        capabilities: b.capabilities,
        roles: b.roles,
        tags: b.tags,
        // 象限白名单（顺序即分组顺序）。服务端还没下发时退到空数组：表格按数据里的
        // 出现顺序分组，不在这里抄一份四字面量——那正是 items.js:40-42 防过的那类脱钩。
        quadrants: b.quadrants ?? [],
        palette: b.palette,
        today: b.today,
        inviteCount: b.inviteCount ?? 0,
        // 锚点跟着今天走：全量重拉（登录 / self）把视图带回本月
        anchor: { year, month },
      };
    },
  },
  {
    fields: ['owners'],
    async load(client, target) {
      try {
        const { owners } = await client.owners();
        return { owners };
      } catch {
        // 拿不到账号列表时退到自己——至少不会把别人的名字弄丢
        return { owners: target.account ? [{ id: target.account.id, username: target.account.username }] : [] };
      }
    },
  },
  {
    fields: ['items'],
    async load(client) {
      const { items } = await client.listItems();
      return { items };
    },
  },
  {
    fields: ['archivedItems'],
    /**
     * 归档视图（admin 专用、只读）：「显示已完成」打开时表格要有一份归档行。
     *
     * 它是**常驻**视图的数据（不像管理面板那样开一次拉一次），所以按装载器接进来：
     * 别人归档一条事项时 `items` 触发会把这一页一起换新。非 admin 直接给空数组、
     * 连请求都不发——后端那条路只会回 403，而刚被降权的人更不该把旧行留在屏幕上
     * （capabilities 由排在前的会话装载器先落地，这里的次序是结构保证，见 LOADERS 说明）。
     */
    async load(client, target) {
      if (!target.capabilities.managesAccounts) return { archivedItems: [] };
      try {
        const { items } = await client.archiveList();
        return { archivedItems: items };
      } catch {
        // 拿不到归档那一页不该拖垮整次重拉（事项与能力照旧落地），而权限刚被收回时
        // （SSE 的 self 还在路上、capabilities 还是旧的）后端一定回 403——退到空，
        // 与 owners 那格的取舍同源：宁可少显示一页，也别把旧行留在屏幕上。
        return { archivedItems: [] };
      }
    },
  },
];

/** 执行器能重拉的字段全集（从装载器表派生，所以「表里写了个没人提供的字段」能被抓住）。 */
export const RELOADABLE_FIELDS = Object.freeze(LOADERS.flatMap((loader) => loader.fields));

/**
 * 声明表：**什么变了 → 重拉哪些字段**。重拉范围只在这里决定。
 *
 * SSE 回调、登录、对话框收尾、日切都只报「什么变了」，字段集合从这张表出：
 *
 * | 触发    | 什么时候                                        | 重拉                    |
 * | ------- | ----------------------------------------------- | ----------------------- |
 * | `items` | 事项有增删改（SSE `items` / 本机刚写完一条）    | 事项 + 归档             |
 * | `admin` | 账号、注册申请有变（SSE `admin`）               | 事项 + owner 名单 + 能力 + 归档 |
 * | `self`  | 自己的账号状态变了（SSE `self` / 接受或拒绝邀请）| 全部                    |
 * | `login` | 登录之后                                        | 全部（一律全量）        |
 * | `day`   | 跨过午夜（日切定时器）                          | 只有 `today`，不动月份  |
 *
 * 归档跟着 `items` 一起重拉：表格视图是常驻视图，「显示已完成」开着时别人归档一条
 * 事项，归档组不能停在旧的一页（非 admin 的那一格不发请求，代价是零）。
 *
 * `login` 全量是 `f24d4e7` 的教训：权限、角色、邀请角标、标签与调色板都只在 bootstrap 里
 * 下发，登录时只做局部重拉的话它们会停在未登录时的值——「管理」入口要刷新才出现。
 */
export const REFRESH_PLAN = Object.freeze({
  items: Object.freeze(['items', 'archivedItems']),
  admin: Object.freeze(['items', 'owners', 'capabilities', 'archivedItems']),
  self: Object.freeze([...RELOADABLE_FIELDS]),
  login: Object.freeze([...RELOADABLE_FIELDS]),
  day: Object.freeze(['today']),
});

/**
 * 把若干触发合并成一个字段集合：SSE 事件会成串到达，120ms 内的多次触发合成一次执行。
 * 触发名与字段名写错都直接抛——少拉一项必须出声，不能静默。
 */
export function fieldsFor(triggers) {
  const names = Array.isArray(triggers) ? triggers : [triggers];
  const fields = [];
  for (const name of names) {
    const planned = REFRESH_PLAN[name];
    if (!planned) throw new Error(`未知的刷新触发：${name}`);
    for (const field of planned) {
      if (!RELOADABLE_FIELDS.includes(field)) throw new Error(`未知的状态字段：${field}`);
      if (!fields.includes(field)) fields.push(field);
    }
  }
  return fields;
}

/**
 * 执行器：按声明表把字段拉回来写进状态。**不碰连接**——`stream` 不在任何装载器里，
 * 所以重拉无论触发多少次都不会重新建流（建流只在 `boot()`）。
 *
 * `client` 与 `state` 可注入，判据用替身断言（见 `test/refresh.test.js`）。
 */
export async function runRefresh(triggers, { client = api, state: target = state } = {}) {
  const wanted = new Set(fieldsFor(triggers));
  for (const loader of LOADERS) {
    if (!loader.fields.some((field) => wanted.has(field))) continue;
    const patch = await loader.load(client, target);
    // 只写声明表要到的字段：同一次请求顺带拿回来的东西不算数
    for (const [field, value] of Object.entries(patch)) {
      if (wanted.has(field)) target[field] = value;
    }
    if (loader.providesSession && !target.account) {
      clearSession();
      return;
    }
  }
}

/** 触发一次重拉并重绘。调用点只报「什么变了」，范围由 `REFRESH_PLAN` 决定。 */
async function reload(triggers) {
  await runRefresh(triggers);
  render();
}

/**
 * SSE 事件可能成串到达（一次操作既发 items 又发 admin），120ms 内合并成一次执行。
 * 合并取**并集**：先到的 `admin` 不会被后到的 `items` 顶掉，owner 名单不会漏拉。
 */
let refreshTimer = null;
const pendingTriggers = new Set();

function reloadSoon(trigger) {
  pendingTriggers.add(trigger);
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    const triggers = [...pendingTriggers];
    pendingTriggers.clear();
    reload(triggers).catch((err) => toast(err.message, 'error'));
  }, 120);
}

/**
 * 表格视图的一屏数据：把 state 里的字段按 tableview.js 期望的形状交出去。
 * 只读——表格的交互由下面的委托处理器写回 state，再重画。
 */
function tableViewOf() {
  return {
    items: state.items,
    archivedItems: state.archivedItems,
    today: state.today,
    palette: state.palette,
    quadrants: state.quadrants,
    canArchive: state.capabilities.managesAccounts,
    showArchived: state.showArchived,
    status: state.tableStatus,
    quadrant: state.tableQuadrant,
    keyword: state.tableKeyword,
    sortKey: state.tableSort,
    sortDir: state.tableDir,
    collapsed: state.collapsedQuads,
  };
}

/** 表格的整块重画（工具栏 + 表体）：重拉、视图切换、筛选/排序变更都走这里。 */
function paintTable() {
  renderTable({ toolbar: els.tableToolbar, body: els.tableBody }, tableViewOf());
}

/** 折叠 / 展开一个分组：只动本地视图的 collapsedQuads，重画表体。 */
function toggleQuadrant(key) {
  state.collapsedQuads = state.collapsedQuads.includes(key)
    ? state.collapsedQuads.filter((k) => k !== key)
    : [...state.collapsedQuads, key];
  renderTableRows({ toolbar: els.tableToolbar, body: els.tableBody }, tableViewOf());
}

function render() {
  // 未登录时界面是登录页，没有看板可渲染（会话在重拉途中消失时，runRefresh 已 clearSession）
  if (!state.account) return;

  const calendar = state.view === 'calendar';
  els.monthNav.hidden = !calendar;
  els.calendarView.hidden = !calendar;
  els.tableView.hidden = calendar;
  els.viewSwitch.querySelectorAll('[data-view]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.view === state.view);
  });

  if (calendar) {
    els.monthLabel.textContent = formatMonth(state.anchor.year, state.anchor.month);

    const cells = buildGrid(state.anchor, state.today);
    assignItems(cells, state.items);
    els.grid.innerHTML = gridHtml(cells, state.palette);

    renderPanels(
      { today: els.panelToday, due: els.panelDue, multi: els.panelMulti },
      state.items,
      state.today,
      state.palette,
    );
  } else {
    paintTable();
  }

  els.whoami.textContent = `${state.account.username}（${state.account.role}）`;
  els.btnAdmin.hidden = !state.capabilities.managesAccounts;
  // 有待接受的邀请才显示入口，角标给出条数
  els.btnInvites.hidden = state.inviteCount === 0;
  els.inviteCount.textContent = state.inviteCount > 0 ? String(state.inviteCount) : '';
}

function shiftMonth(delta) {
  let { year, month } = state.anchor;
  month += delta;
  while (month < 1) {
    month += 12;
    year -= 1;
  }
  while (month > 12) {
    month -= 12;
    year += 1;
  }
  state.anchor = { year, month };
  render();
}

function showAuth() {
  els.app.hidden = true;
  els.auth.hidden = false;
}

/**
 * 建流。这是**唯一**建立 EventSource 的地方（由 `boot()` 调用）。
 * 所有重拉都走声明表、都不经过这里，所以事件路径不会再建第二条流。
 */
function connectStream() {
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }
  const es = new EventSource('/api/events');
  // 服务端已按可见性过滤，这里只按声明表重拉（范围见 REFRESH_PLAN）
  es.addEventListener('items', () => reloadSoon('items'));
  es.addEventListener('admin', () => reloadSoon('admin'));
  // 自己的角色/账号被改动：全量重拉（含能力与角标）。连接保留——服务端推送时取权威 role，
  // 重连既无必要，也正是要避免的那类循环。
  es.addEventListener('self', () => reloadSoon('self'));
  es.onerror = () => {
    // 已登出时不再重连
    if (!state.account) es.close();
  };
  state.stream = es;
}

function showAuthOff() {
  els.auth.hidden = true;
  els.app.hidden = false;
}

function findItem(id) {
  return state.items.find((i) => i.id === id) || null;
}

async function openItem(id, presetDate) {
  let item = null;
  if (id) {
    item = findItem(id);
    if (!item) {
      // 可能刚被别人归档或删除：先把事项重拉一次再找
      await reload('items');
      item = findItem(id);
      if (!item) {
        toast('该事项已不存在（可能已被归档或删除）', 'error');
        return;
      }
    }
  }

  openItemDialog(els.itemDialog, {
    item,
    today: presetDate || state.today,
    tags: state.tags,
    quadrants: state.quadrants,
    owners: state.owners,
    canAssign: canAssign(),
    // 当前账号：新建时用来预勾自己（编辑时由该事项的名单决定，见 itemform.js）
    me: state.account,
    onDone: () => {
      // 事项被写过：只重拉事项（范围见 REFRESH_PLAN.items）
      reload('items').catch((err) => toast(err.message, 'error'));
    },
  });
}

function openAdmin() {
  openAdminDialog(els.adminDialog, {
    me: state.account,
    roles: state.roles,
    palette: state.palette,
    onDone: () => {
      // 同上：管理员改动的是事项
      reload('items').catch((err) => toast(err.message, 'error'));
    },
  });
}

function openInvites() {
  openInvitesDialog(els.invitesDialog, {
    // 接受/拒绝都会改角标与可见事项，属于「自己的状态变了」→ self 全量（见 REFRESH_PLAN）
    onDone: () => {
      reload('self').catch((err) => toast(err.message, 'error'));
    },
  });
}

async function onLogin(ev) {
  ev.preventDefault();
  const form = ev.currentTarget;
  const msg = form.querySelector('[data-msg]');
  msg.dataset.kind = 'error';
  msg.textContent = '';
  // 上一次失败留下的字段红字先清掉，否则它会一直挂到下次成功提交
  setFieldErrors(form, null);
  const fd = new FormData(form);
  try {
    await api.login(String(fd.get('username') || ''), String(fd.get('password') || ''));
    form.reset();
    // 登录之后一律全量（REFRESH_PLAN.login）：权限、角色、邀请角标都只在 bootstrap 里下发，
    // 只走局部重拉的话它们停在未登录时的值——「管理」入口要刷新才出现（f24d4e7）。
    await boot();
  } catch (err) {
    // 失败呈现只有一条路径（见 util.showFormFailure）：message 与 err.fields 都不丢
    showFormFailure(form, err);
  }
}

async function onApply(ev) {
  ev.preventDefault();
  const form = ev.currentTarget;
  const msg = form.querySelector('[data-msg]');
  msg.textContent = '';
  setFieldErrors(form, null);
  const fd = new FormData(form);
  try {
    await api.apply({
      username: String(fd.get('username') || ''),
      password: String(fd.get('password') || ''),
      note: String(fd.get('note') || ''),
    });
    form.reset();
    msg.dataset.kind = 'ok';
    msg.textContent = '申请已提交。管理员批准后才能登录。';
  } catch (err) {
    // 服务端 400 的字段级细节在 err.fields 里（api.js:33）：「输入有误」不再是唯一可见信息
    showFormFailure(form, err);
  }
}

async function onLogout() {
  try {
    await api.logout();
  } catch {
    /* 忽略：本地照样清状态 */
  }
  clearSession();
}

/**
 * 清空本地会话：断开实时流、停掉日切定时器、回到未登录形状、回登录页。
 * 主动登出与会话失效共用；未登录形状只在 `createState()` 里定义这一处。
 */
function clearSession() {
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }
  clearTimeout(dayTimer);
  dayTimer = null;
  Object.assign(state, createState());
  showAuth();
}

/**
 * 会话失效的收尾（判据与文案见 session.js，那里是唯一落点）。
 *
 * 先关掉打开的对话框：会话都失效了，保存必定失败，留一个半开的编辑框只会让人
 * 白填一遍。然后清状态回登录页，最后说明原因。
 */
function endSession() {
  for (const dialog of [els.itemDialog, els.adminDialog, els.invitesDialog]) {
    if (dialog.open) dialog.close();
  }
  clearSession();
  toast(SESSION_EXPIRED_MESSAGE, 'error');
}

setSessionExpiredHandler(endSession);

/**
 * 表格工具栏的控件 → 本地视图字段。按键名派发：表里没有的键会当场 TypeError，不静默。
 * 关掉「显示已完成」时把「已完成」筛选一并收回——归档数据不再拉取，留着它只会得到空表。
 */
const TABLE_FIELDS = {
  status: (value) => {
    state.tableStatus = value;
  },
  quadrant: (value) => {
    state.tableQuadrant = value;
  },
  sort: (value) => {
    state.tableSort = value;
  },
  archived: (value) => {
    state.showArchived = value;
    if (!value && state.tableStatus === STATUS.done) state.tableStatus = '';
  },
};

function bindEvents() {
  document.querySelectorAll('[data-auth-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const which = btn.dataset.authTab;
      document.querySelectorAll('[data-auth-tab]').forEach((b) => b.classList.toggle('is-active', b === btn));
      document.getElementById('login-form').hidden = which !== 'login';
      document.getElementById('apply-form').hidden = which !== 'apply';
    });
  });

  document.getElementById('login-form').addEventListener('submit', onLogin);
  document.getElementById('apply-form').addEventListener('submit', onApply);

  els.monthNav.addEventListener('click', (ev) => {
    const nav = ev.target.closest('[data-nav]')?.dataset.nav;
    if (nav === 'prev') shiftMonth(-1);
    else if (nav === 'next') shiftMonth(1);
  });

  // 视图切换：日历 / 表格。只改本地视图字段再重绘，不碰装载器（见 REFRESH_PLAN）
  els.viewSwitch.addEventListener('click', (ev) => {
    const view = ev.target.closest('[data-view]')?.dataset.view;
    if (view !== 'calendar' && view !== 'table') return;
    if (view === state.view) return;
    state.view = view;
    render();
  });

  document.getElementById('btn-new').addEventListener('click', () => openItem(null));
  document.getElementById('btn-invites').addEventListener('click', openInvites);
  document.getElementById('btn-admin').addEventListener('click', openAdmin);
  document.getElementById('btn-logout').addEventListener('click', onLogout);

  // 日历、侧栏与表格都是重绘出来的，事件用委托挂在 #app 上
  els.app.addEventListener('click', (ev) => {
    const addBtn = ev.target.closest('[data-add-date]');
    if (addBtn) {
      openItem(null, addBtn.dataset.addDate).catch((err) => toast(err.message, 'error'));
      return;
    }
    // 表格工具栏的「+ 添加一行」：与顶栏「新建事项」同一条路径
    if (ev.target.closest('[data-new-item]')) {
      openItem(null).catch((err) => toast(err.message, 'error'));
      return;
    }
    // 分组头折叠 / 展开
    const groupHead = ev.target.closest('[data-quadrant-toggle]');
    if (groupHead) {
      toggleQuadrant(groupHead.dataset.quadrantToggle);
      return;
    }
    // 排序方向的升 / 降
    if (ev.target.closest('[data-table-dir]')) {
      state.tableDir = state.tableDir === 'asc' ? 'desc' : 'asc';
      paintTable();
      return;
    }
    // 归档行不带 data-item-id（见 tableview.js 的 rowHtml）：点它不会走到这里
    const row = ev.target.closest('[data-item-id]');
    if (row) {
      openItem(Number(row.dataset.itemId)).catch((err) => toast(err.message, 'error'));
    }
  });

  // 表格工具栏的 select / 复选：按键名执行写入（表里没有的键会当场 TypeError，不静默）
  els.app.addEventListener('change', (ev) => {
    const el = ev.target.closest('[data-table-field]');
    if (!el) return;
    TABLE_FIELDS[el.dataset.tableField](el.type === 'checkbox' ? el.checked : el.value);
    paintTable();
  });

  // 关键词是逐字输入的：只重画表体——重画工具栏会把输入框换成新节点，焦点与光标就没了
  els.app.addEventListener('input', (ev) => {
    const el = ev.target.closest('[data-table-keyword]');
    if (!el) return;
    state.tableKeyword = el.value;
    renderTableRows({ toolbar: els.tableToolbar, body: els.tableBody }, tableViewOf());
  });
}

/**
 * 启动与登录之后的入口：按声明表全量取一次状态（`login`），已登录时再建流。
 *
 * 「取状态」与「建流」刻意留在同一个函数里、不拆成可被事件路径单独调用的两半：
 * 拆开正是重连循环的来源。重拉路径永不经过这里——SSE 事件只按表改字段。
 */
async function boot() {
  await reload('login');
  // 未登录：runRefresh 里的会话装载器已经 clearSession() 回了登录页
  if (!state.account) return;
  showAuthOff();
  connectStream();
  scheduleDayRollover();
}

let dayTimer = null;

/** 距下一个本机午夜的毫秒数（多给 1 秒余量，避开正好落在 23:59:59.999 的抖动）。 */
export function msUntilNextDay(now = new Date()) {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
  return next.getTime() - now.getTime();
}

/**
 * 日切：页面长开跨过午夜时 `today` 会停在前一天，「今日任务」面板与日历上的「今天」都会错位。
 * 到下一个本机午夜触发一次 `day` 重拉（只换 `today`），再排下一次。
 * **不碰连接**；也不动 `anchor`——用户翻到的月份不该被跨午夜抢回本月。
 */
function scheduleDayRollover() {
  clearTimeout(dayTimer);
  dayTimer = setTimeout(() => {
    dayTimer = null;
    reload('day')
      .catch((err) => toast(err.message, 'error'))
      .finally(() => {
        if (state.account) scheduleDayRollover();
      });
  }, msUntilNextDay());
}

bindEvents();
boot().catch((err) => {
  console.error(err);
  toast(`初始化失败：${err.message}`, 'error');
});
