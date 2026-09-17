/**
 * API 路由 —— 薄适配层：HTTP 进 → 领域调用 → JSON 出。
 *
 * 分工：
 * - 鉴权与可见性判据在 visibility.js；
 * - 广播策略由领域操作的返回值描述（changed），这里只交给 sse.publish 送达；
 * - 登录限速在 ratelimit.js。
 * 所以这个文件里只剩下「路径匹配 + 读入参 + 写响应」三件事。
 */
import { sendJson, readJson, httpError } from './http.js';
import {
  readSessionToken,
  getSessionAccount,
  createSession,
  deleteSession,
  sessionCookie,
  clearSessionCookie,
  verifyPassword,
} from './auth.js';
import * as items from './items.js';
import * as accounts from './accounts.js';
import { addClient, publish } from './sse.js';
import { TAGS, PALETTE, LIMITS, todayLocal } from './config.js';
import { capabilitiesOf, ROLES } from './visibility.js';
import { createLoginRateLimiter } from './ratelimit.js';

const checkLoginRate = createLoginRateLimiter();

function requireAccount(account) {
  if (!account) throw httpError(401, '请先登录');
  return account;
}

function requireManager(account) {
  requireAccount(account);
  if (!capabilitiesOf(account).seesAllItems) throw httpError(403, '需要 manager 或 admin 权限');
  return account;
}

function requireAdmin(account) {
  requireAccount(account);
  if (!capabilitiesOf(account).managesAccounts) throw httpError(403, '需要 admin 权限');
  return account;
}

// ——————————————— 公开路由 ———————————————

function handleBootstrap(res, account) {
  return sendJson(res, 200, {
    authenticated: !!account,
    account: account ? { id: account.id, username: account.username, role: account.role } : null,
    // 前端不自行比对角色字符串：要用到权限时读这两个字段
    roles: ROLES,
    capabilities: capabilitiesOf(account),
    tags: TAGS,
    palette: PALETTE,
    today: todayLocal(),
    limits: {
      titleMax: LIMITS.TITLE_MAX,
      noteMax: LIMITS.NOTE_MAX,
      passwordMin: LIMITS.PASSWORD_MIN,
      usernameMin: LIMITS.USERNAME_MIN,
      usernameMax: LIMITS.USERNAME_MAX,
    },
  });
}

async function handleRegisterRequest(req, res) {
  const { changed } = accounts.submitRegistrationRequest(await readJson(req));
  publish(changed);
  return sendJson(res, 201, { ok: true });
}

async function handleLogin(req, res) {
  checkLoginRate(req.socket.remoteAddress || 'unknown');
  const body = await readJson(req);
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  const found = username ? accounts.findAccountByUsername(username) : null;
  if (!found || !verifyPassword(password, found.password_hash)) {
    throw httpError(401, '用户名或密码不正确');
  }

  const { token, changed } = createSession(found.id);
  publish(changed);
  return sendJson(
    res,
    200,
    { account: { id: found.id, username: found.username, role: found.role } },
    { 'Set-Cookie': sessionCookie(token) },
  );
}

function handleLogout(res, token) {
  if (token) deleteSession(token);
  return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
}

// ——————————————— 以下均需登录 ———————————————

function handleEvents(res, me) {
  addClient(res, me);
  return undefined; // 连接保持打开，不写响应
}

function handleListItems(res, url, me) {
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  return sendJson(res, 200, { items: items.listItems(me, from, to) });
}

async function handleCreateItem(req, res, me) {
  const { item, changed } = items.createItem(me, await readJson(req));
  publish(changed);
  return sendJson(res, 201, { item });
}

function handleListOwners(res, me) {
  requireManager(me);
  return sendJson(res, 200, { owners: accounts.listOwners() });
}

async function handleUpdateItem(req, res, me, id) {
  const { item, changed } = items.updateItem(me, id, await readJson(req));
  publish(changed);
  return sendJson(res, 200, { item });
}

function handleDeleteItem(res, me, id) {
  const { changed } = items.deleteItem(me, id);
  publish(changed);
  return sendJson(res, 200, { ok: true });
}

async function handleArchiveItem(req, res, me, id) {
  const body = await readJson(req);
  const { item, changed } = items.archiveItem(me, id, body.version);
  publish(changed);
  return sendJson(res, 200, { item });
}

// ——————————————— admin 路由 ———————————————

function handleListRequests(res, me) {
  requireAdmin(me);
  return sendJson(res, 200, { requests: accounts.listRequests() });
}

function handleRequestDecision(res, me, id, action) {
  requireAdmin(me);
  if (action === 'approve') {
    const { account, changed } = accounts.approveRequest(id);
    publish(changed);
    return sendJson(res, 200, { account });
  }
  const { changed } = accounts.rejectRequest(id);
  publish(changed);
  return sendJson(res, 200, { ok: true });
}

function handleListAccounts(res, me) {
  requireAdmin(me);
  return sendJson(res, 200, { accounts: accounts.listAccounts() });
}

async function handleChangeRole(req, res, me, targetId) {
  requireAdmin(me);
  const body = await readJson(req);
  const { account, changed } = accounts.changeRole(me.id, targetId, body.role);
  publish(changed);
  return sendJson(res, 200, { account });
}

function handleDeleteAccount(res, me, targetId) {
  requireAdmin(me);
  const { removed, changed } = accounts.deleteAccount(me.id, targetId);
  publish(changed);
  return sendJson(res, 200, { ok: true, ...removed });
}

async function handleTransfer(req, res, me, targetId) {
  requireAdmin(me);
  const body = await readJson(req);
  const { moved, changed } = accounts.transferItems(targetId, Number(body.to_account_id));
  publish(changed);
  return sendJson(res, 200, { ok: true, moved });
}

function handleArchiveList(res, me) {
  requireAdmin(me);
  return sendJson(res, 200, { items: items.listArchived(me) });
}

// ——————————————— 分派 ———————————————

export async function handleApi(req, res, url) {
  const method = req.method;
  const pathname = url.pathname;

  const token = readSessionToken(req);
  const account = getSessionAccount(token);

  // ——— 公开 ———

  if (method === 'GET' && pathname === '/api/bootstrap') return handleBootstrap(res, account);
  if (method === 'POST' && pathname === '/api/register-request') return handleRegisterRequest(req, res);
  if (method === 'POST' && pathname === '/api/login') return handleLogin(req, res);
  if (method === 'POST' && pathname === '/api/logout') return handleLogout(res, token);

  // ——— 需登录 ———

  const me = requireAccount(account);

  if (method === 'GET' && pathname === '/api/events') return handleEvents(res, me);
  if (method === 'GET' && pathname === '/api/items') return handleListItems(res, url, me);
  if (method === 'POST' && pathname === '/api/items') return handleCreateItem(req, res, me);
  if (method === 'GET' && pathname === '/api/owners') return handleListOwners(res, me);

  const itemMatch = pathname.match(/^\/api\/items\/(\d+)$/);
  if (itemMatch && method === 'PATCH') return handleUpdateItem(req, res, me, Number(itemMatch[1]));
  if (itemMatch && method === 'DELETE') return handleDeleteItem(res, me, Number(itemMatch[1]));

  const archiveMatch = pathname.match(/^\/api\/items\/(\d+)\/archive$/);
  if (archiveMatch && method === 'POST') return handleArchiveItem(req, res, me, Number(archiveMatch[1]));

  // ——— admin 路由 ———

  if (method === 'GET' && pathname === '/api/admin/requests') return handleListRequests(res, me);

  const requestMatch = pathname.match(/^\/api\/admin\/requests\/(\d+)\/(approve|reject)$/);
  if (requestMatch && method === 'POST') {
    return handleRequestDecision(res, me, Number(requestMatch[1]), requestMatch[2]);
  }

  if (method === 'GET' && pathname === '/api/admin/accounts') return handleListAccounts(res, me);

  const accountMatch = pathname.match(/^\/api\/admin\/accounts\/(\d+)$/);
  if (accountMatch && method === 'PATCH') return handleChangeRole(req, res, me, Number(accountMatch[1]));
  if (accountMatch && method === 'DELETE') return handleDeleteAccount(res, me, Number(accountMatch[1]));

  const transferMatch = pathname.match(/^\/api\/admin\/accounts\/(\d+)\/transfer$/);
  if (transferMatch && method === 'POST') return handleTransfer(req, res, me, Number(transferMatch[1]));

  if (method === 'GET' && pathname === '/api/admin/archive') return handleArchiveList(res, me);

  throw httpError(404, '接口不存在');
}
