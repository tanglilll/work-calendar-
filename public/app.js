/** 前端入口：登录态、状态管理、实时同步与事件委托。 */
import { api } from './api.js';
import { SESSION_EXPIRED_MESSAGE, setSessionExpiredHandler } from './session.js';
import { toast, formatMonth } from './util.js';
import { buildGrid, assignItems, gridHtml } from './calendar.js';
import { renderPanels } from './sidebar.js';
import { openItemDialog } from './itemform.js';
import { openAdminDialog } from './admin.js';
import { openInvitesDialog } from './invites.js';

const els = {
  auth: document.getElementById('auth'),
  app: document.getElementById('app'),
  grid: document.getElementById('grid'),
  monthLabel: document.getElementById('month-label'),
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

const state = {
  account: null,
  // 权限由服务端下发（bootstrap），前端不自行比对角色字符串
  capabilities: { seesAllItems: false, assignsOwner: false, managesAccounts: false },
  roles: [],
  tags: [],
  palette: [],
  today: '',
  items: [],
  owners: [],
  anchor: { year: 0, month: 0 },
  stream: null,
};

let refreshTimer = null;

const canAssign = () => state.capabilities.assignsOwner;

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refresh().catch((err) => toast(err.message, 'error'));
  }, 120);
}

async function refresh() {
  const { items } = await api.listItems();
  state.items = items;
  render();
}

function render() {
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

async function loadOwners() {
  try {
    const { owners } = await api.owners();
    state.owners = owners;
  } catch {
    // 拿不到账号列表时退到自己——至少不会把别人的名字弄丢
    state.owners = state.account ? [{ id: state.account.id, username: state.account.username }] : [];
  }
}

function connectStream() {
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }
  const es = new EventSource('/api/events');
  // 事项事件已由服务端按可见性过滤，这里只做「重新拉取」
  es.addEventListener('items', scheduleRefresh);
  es.addEventListener('admin', () => {
    // 账号增删改会改变事项对话框里可选的 owner 名单，两样都要重拉
    scheduleRefresh();
    loadOwners();
  });
  es.addEventListener('self', () => {
    // 自己的角色/账号被改动：重新走一次 bootstrap，权限变化立刻生效
    boot().catch(() => {});
  });
  es.onerror = () => {
    // 已登出时不再重连
    if (!state.account) es.close();
  };
  state.stream = es;
}

async function enterApp() {
  showAuthOff();
  await loadOwners();
  await refresh();
  connectStream();
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
      // 可能刚被别人归档或删除
      await refresh();
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
    owners: state.owners,
    canAssign: canAssign(),
    onDone: () => {
      refresh().catch((err) => toast(err.message, 'error'));
    },
  });
}

function openAdmin() {
  openAdminDialog(els.adminDialog, {
    me: state.account,
    roles: state.roles,
    palette: state.palette,
    onDone: () => {
      refresh().catch((err) => toast(err.message, 'error'));
    },
  });
}

function openInvites() {
  openInvitesDialog(els.invitesDialog, {
    // 接受/拒绝都会改变看板内容与角标，重走一次 bootstrap 最省心
    onDone: () => {
      boot().catch((err) => toast(err.message, 'error'));
    },
  });
}

async function onLogin(ev) {
  ev.preventDefault();
  const form = ev.currentTarget;
  const msg = form.querySelector('[data-msg]');
  msg.dataset.kind = 'error';
  msg.textContent = '';
  const fd = new FormData(form);
  try {
    await api.login(String(fd.get('username') || ''), String(fd.get('password') || ''));
    form.reset();
    // 与 self 事件同理：权限、角色与邀请角标都由 bootstrap 下发，
    // 只走 enterApp 的话它们停在未登录时的值（管理入口要手动刷新才出现）
    await boot();
  } catch (err) {
    msg.textContent = err.message;
  }
}

async function onApply(ev) {
  ev.preventDefault();
  const form = ev.currentTarget;
  const msg = form.querySelector('[data-msg]');
  msg.textContent = '';
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
    msg.dataset.kind = 'error';
    msg.textContent = err.message;
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

/** 清空本地会话：断开实时流、清状态、回登录页。主动登出与会话失效共用。 */
function clearSession() {
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }
  state.account = null;
  state.items = [];
  state.capabilities = { seesAllItems: false, assignsOwner: false, managesAccounts: false };
  state.inviteCount = 0;
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

  document.querySelector('.month-nav').addEventListener('click', (ev) => {
    const nav = ev.target.closest('[data-nav]')?.dataset.nav;
    if (nav === 'prev') shiftMonth(-1);
    else if (nav === 'next') shiftMonth(1);
  });

  document.getElementById('btn-new').addEventListener('click', () => openItem(null));
  document.getElementById('btn-invites').addEventListener('click', openInvites);
  document.getElementById('btn-admin').addEventListener('click', openAdmin);
  document.getElementById('btn-logout').addEventListener('click', onLogout);

  // 日历与侧栏都是重绘出来的，事件用委托挂在 #app 上
  els.app.addEventListener('click', (ev) => {
    const addBtn = ev.target.closest('[data-add-date]');
    if (addBtn) {
      openItem(null, addBtn.dataset.addDate).catch((err) => toast(err.message, 'error'));
      return;
    }
    const row = ev.target.closest('[data-item-id]');
    if (row) {
      openItem(Number(row.dataset.itemId)).catch((err) => toast(err.message, 'error'));
    }
  });
}

async function boot() {
  const b = await api.bootstrap();
  state.today = b.today;
  state.tags = b.tags;
  state.palette = b.palette;
  state.capabilities = b.capabilities;
  state.roles = b.roles;
  state.inviteCount = b.inviteCount ?? 0;

  const [y, m] = b.today.split('-').map(Number);
  state.anchor = { year: y, month: m };

  if (b.authenticated) {
    state.account = b.account;
    await enterApp();
  } else {
    if (state.stream) {
      state.stream.close();
      state.stream = null;
    }
    state.account = null;
    showAuth();
  }
}

bindEvents();
boot().catch((err) => {
  console.error(err);
  toast(`初始化失败：${err.message}`, 'error');
});
