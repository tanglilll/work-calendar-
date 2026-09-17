/**
 * API 路由。所有鉴权与可见性判断都在这里或更下层完成，前端不被信任。
 */
import { sendJson, sendError, readJson, httpError } from './http.js';
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
import { addClient, broadcastItems, broadcastAdmin, broadcastToAccount } from './sse.js';
import { TAGS, PALETTE, LIMITS, isManager, todayLocal } from './config.js';

function requireAccount(account) {
  if (!account) throw httpError(401, '请先登录');
  return account;
}

function requireManager(account) {
  requireAccount(account);
  if (!isManager(account.role)) throw httpError(403, '需要 manager 或 admin 权限');
  return account;
}

function requireAdmin(account) {
  requireAccount(account);
  if (account.role !== 'admin') throw httpError(403, '需要 admin 权限');
  return account;
}

// —— 极简登录限速：每 IP 每分钟最多 10 次尝试 ——
const loginAttempts = new Map();
const LOGIN_MAX = 10;
const LOGIN_WINDOW_MS = 60_000;

function checkLoginRate(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || now > rec.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  rec.count += 1;
  if (rec.count > LOGIN_MAX) throw httpError(429, '登录尝试过于频繁，请稍后再试');
}

export async function handleApi(req, res, url) {
  const method = req.method;
  const pathname = url.pathname;

  const token = readSessionToken(req);
  const account = getSessionAccount(token);

  // ——— 公开路由 ———

  if (method === 'GET' && pathname === '/api/bootstrap') {
    return sendJson(res, 200, {
      authenticated: !!account,
      account: account ? { id: account.id, username: account.username, role: account.role } : null,
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

  if (method === 'POST' && pathname === '/api/register-request') {
    const body = await readJson(req);
    accounts.submitRegistrationRequest(body);
    broadcastAdmin('requests');
    return sendJson(res, 201, { ok: true });
  }

  if (method === 'POST' && pathname === '/api/login') {
    checkLoginRate(req.socket.remoteAddress || 'unknown');
    const body = await readJson(req);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    const found = username ? accounts.findAccountByUsername(username) : null;
    if (!found || !verifyPassword(password, found.password_hash)) {
      throw httpError(401, '用户名或密码不正确');
    }

    const newToken = createSession(found.id);
    broadcastToAccount(found.id, 'signed-in');
    return sendJson(
      res,
      200,
      { account: { id: found.id, username: found.username, role: found.role } },
      { 'Set-Cookie': sessionCookie(newToken) },
    );
  }

  if (method === 'POST' && pathname === '/api/logout') {
    if (token) deleteSession(token);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
  }

  // ——— 以下均需登录 ———

  const me = requireAccount(account);

  if (method === 'GET' && pathname === '/api/events') {
    addClient(res, me);
    return undefined; // 连接保持打开
  }

  if (method === 'GET' && pathname === '/api/items') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    return sendJson(res, 200, { items: items.listItems(me, from, to) });
  }

  if (method === 'POST' && pathname === '/api/items') {
    const body = await readJson(req);
    const created = items.createItem(me, body);
    broadcastItems(created.owner_id, 'created', created.id);
    return sendJson(res, 201, { item: created });
  }

  if (method === 'GET' && pathname === '/api/owners') {
    requireManager(me);
    return sendJson(res, 200, { owners: accounts.listOwners() });
  }

  let m = pathname.match(/^\/api\/items\/(\d+)$/);
  if (m && method === 'PATCH') {
    const id = Number(m[1]);
    const before = items.getItem(id);
    const body = await readJson(req);
    const updated = items.updateItem(me, id, body);

    if (before && before.owner_id !== updated.owner_id) {
      // 归属易主：新旧 owner 的看板都要刷新
      broadcastItems(before.owner_id, 'transferred-away', id);
      broadcastItems(updated.owner_id, 'transferred-in', id);
    } else {
      broadcastItems(updated.owner_id, 'updated', id);
    }
    return sendJson(res, 200, { item: updated });
  }

  if (m && method === 'DELETE') {
    const removed = items.deleteItem(me, Number(m[1]));
    broadcastItems(removed.owner_id, 'deleted', removed.id);
    return sendJson(res, 200, { ok: true });
  }

  m = pathname.match(/^\/api\/items\/(\d+)\/archive$/);
  if (m && method === 'POST') {
    const body = await readJson(req);
    const archived = items.archiveItem(me, Number(m[1]), body.version);
    broadcastItems(archived.owner_id, 'archived', archived.id);
    return sendJson(res, 200, { item: archived });
  }

  // ——— admin 路由 ———

  if (method === 'GET' && pathname === '/api/admin/requests') {
    requireAdmin(me);
    return sendJson(res, 200, { requests: accounts.listRequests() });
  }

  m = pathname.match(/^\/api\/admin\/requests\/(\d+)\/(approve|reject)$/);
  if (m && method === 'POST') {
    requireAdmin(me);
    const id = Number(m[1]);
    if (m[2] === 'approve') {
      const created = accounts.approveRequest(id);
      broadcastAdmin('accounts');
      broadcastAdmin('requests');
      broadcastToAccount(created.id, 'approved');
      return sendJson(res, 200, { account: created });
    }
    accounts.rejectRequest(id);
    broadcastAdmin('requests');
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/admin/accounts') {
    requireAdmin(me);
    return sendJson(res, 200, { accounts: accounts.listAccounts() });
  }

  m = pathname.match(/^\/api\/admin\/accounts\/(\d+)$/);
  if (m && method === 'PATCH') {
    requireAdmin(me);
    const body = await readJson(req);
    const targetId = Number(m[1]);
    const updated = accounts.changeRole(me.id, targetId, body.role);
    broadcastAdmin('accounts');
    broadcastToAccount(targetId, 'role-changed');
    return sendJson(res, 200, { account: updated });
  }

  if (m && method === 'DELETE') {
    requireAdmin(me);
    const targetId = Number(m[1]);
    const removed = accounts.deleteAccount(me.id, targetId);
    broadcastAdmin('accounts');
    return sendJson(res, 200, { ok: true, ...removed });
  }

  m = pathname.match(/^\/api\/admin\/accounts\/(\d+)\/transfer$/);
  if (m && method === 'POST') {
    requireAdmin(me);
    const body = await readJson(req);
    const targetId = Number(m[1]);
    const toId = Number(body.to_account_id);
    const result = accounts.transferItems(targetId, toId);
    broadcastItems(targetId, 'transferred-away', null);
    broadcastItems(toId, 'transferred-in', null);
    broadcastAdmin('accounts');
    return sendJson(res, 200, { ok: true, moved: result.moved });
  }

  if (method === 'GET' && pathname === '/api/admin/archive') {
    requireAdmin(me);
    return sendJson(res, 200, { items: items.listArchived() });
  }

  throw httpError(404, '接口不存在');
}
