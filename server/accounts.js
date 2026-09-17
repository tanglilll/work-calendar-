/**
 * 账号与注册申请。账号只在「批准」那一刻诞生；申请表里存的密码已经是哈希。
 */
import { db, tx, usernameTaken } from './db.js';
import { hashPassword, verifyPassword } from './auth.js';
import { LIMITS } from './config.js';
import { ROLES } from './visibility.js';
import { httpError } from './http.js';
import { countActiveItems, transferAllItems } from './items.js';

const USERNAME_RE = /^[\p{L}\p{N}_.-]+$/u;

export function normalizeUsername(raw) {
  if (typeof raw !== 'string') return { error: '用户名必须是文本' };
  const value = raw.trim();
  if (value.length < LIMITS.USERNAME_MIN || value.length > LIMITS.USERNAME_MAX) {
    return { error: `用户名长度须在 ${LIMITS.USERNAME_MIN}–${LIMITS.USERNAME_MAX} 之间` };
  }
  if (!USERNAME_RE.test(value)) {
    return { error: '用户名只能包含字母、数字、下划线、点和连字符' };
  }
  return { value };
}

export function validatePassword(raw) {
  if (typeof raw !== 'string') return { error: '密码必须是文本' };
  if (raw.length < LIMITS.PASSWORD_MIN) return { error: `密码至少 ${LIMITS.PASSWORD_MIN} 位` };
  if (raw.length > LIMITS.PASSWORD_MAX) return { error: `密码最多 ${LIMITS.PASSWORD_MAX} 位` };
  return { value: raw };
}

/** 访客提交注册申请。此时不产生账号。 */
export function submitRegistrationRequest(input) {
  const errors = {};
  const u = normalizeUsername(input.username);
  if (u.error) errors.username = u.error;
  const p = validatePassword(input.password);
  if (p.error) errors.password = p.error;

  let note = '';
  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== 'string') errors.note = '备注必须是文本';
    else {
      note = input.note.trim();
      if (note.length > LIMITS.NOTE_MAX) errors.note = `备注最多 ${LIMITS.NOTE_MAX} 个字符`;
    }
  }

  if (Object.keys(errors).length) throw httpError(400, '输入有误', { fields: errors });

  if (usernameTaken(u.value)) {
    throw httpError(409, '该用户名已被占用', { fields: { username: '该用户名已被占用' } });
  }
  const pending = db
    .prepare('SELECT 1 FROM registration_requests WHERE username = ? COLLATE NOCASE')
    .get(u.value);
  if (pending) {
    throw httpError(409, '该用户名已有一条待批准的申请', {
      fields: { username: '该用户名已有一条待批准的申请' },
    });
  }

  db.prepare(
    'INSERT INTO registration_requests (username, password_hash, note, created_at) VALUES (?, ?, ?, ?)',
  ).run(u.value, hashPassword(p.value), note, new Date().toISOString());

  return { changed: [{ to: 'admins', kind: 'requests' }] };
}

/** 待批准申请列表。刻意不返回 password_hash。 */
export function listRequests() {
  return db
    .prepare('SELECT id, username, note, created_at FROM registration_requests ORDER BY created_at ASC, id ASC')
    .all();
}

/** 批准申请：账号在这一刻生成，角色固定为 user。 */
export function approveRequest(id) {
  const req = db.prepare('SELECT * FROM registration_requests WHERE id = ?').get(id);
  if (!req) throw httpError(404, '注册申请不存在');
  if (usernameTaken(req.username)) {
    throw httpError(409, `用户名「${req.username}」已被占用，无法批准；可先拒绝该申请`);
  }

  const account = tx(() => {
    const info = db
      .prepare('INSERT INTO accounts (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
      .run(req.username, req.password_hash, 'user', new Date().toISOString());
    db.prepare('DELETE FROM registration_requests WHERE id = ?').run(id);
    return { id: Number(info.lastInsertRowid), username: req.username, role: 'user' };
  });

  return {
    account,
    changed: [
      { to: 'admins', kind: 'accounts' },
      { to: 'admins', kind: 'requests' },
      // 申请人自己的其它客户端立刻可用
      { to: 'accounts', accountIds: [account.id], kind: 'approved' },
    ],
  };
}

/** 拒绝申请：直接删除记录，对方可重新提交。 */
export function rejectRequest(id) {
  const info = db.prepare('DELETE FROM registration_requests WHERE id = ?').run(id);
  if (info.changes === 0) throw httpError(404, '注册申请不存在');
  return { changed: [{ to: 'admins', kind: 'requests' }] };
}

export function listAccounts() {
  return db
    .prepare(
      `SELECT a.id, a.username, a.role, a.created_at,
              (SELECT COUNT(*) FROM items i WHERE i.owner_id = a.id AND i.archived_at IS NULL) AS active_items,
              (SELECT COUNT(*) FROM items i WHERE i.owner_id = a.id AND i.archived_at IS NOT NULL) AS archived_items
         FROM accounts a
        ORDER BY a.created_at ASC, a.id ASC`,
    )
    .all();
}

/** 供 manager/admin 分配事项时挑选 owner。只暴露 id 与用户名。 */
export function listOwners() {
  return db.prepare('SELECT id, username FROM accounts ORDER BY username ASC').all();
}

export function findAccountByUsername(username) {
  return db
    .prepare('SELECT id, username, password_hash, role FROM accounts WHERE username = ? COLLATE NOCASE')
    .get(username);
}

export function changeRole(actorId, targetId, role) {
  if (!ROLES.includes(role)) throw httpError(400, '角色不合法');
  const target = db.prepare('SELECT id, username, role FROM accounts WHERE id = ?').get(targetId);
  if (!target) throw httpError(404, '账号不存在');
  if (target.role === role) return { account: target, changed: [] };

  if (target.role === 'admin' && role !== 'admin') {
    const admins = db.prepare(`SELECT COUNT(*) AS n FROM accounts WHERE role = 'admin'`).get().n;
    if (admins <= 1) throw httpError(409, '系统里必须至少保留一个 admin');
  }

  db.prepare('UPDATE accounts SET role = ? WHERE id = ?').run(role, targetId);
  return {
    account: { ...target, role },
    changed: [
      { to: 'admins', kind: 'accounts' },
      // 角色变了，对方必须重新拉取，越权数据要立刻从他的客户端消失
      { to: 'accounts', accountIds: [targetId], kind: 'role-changed' },
    ],
  };
}

/**
 * 删除账号。要求名下没有未归档事项（必须先转移）；
 * 已归档事项随账号一并删除（它们的 owner 已不存在），数量在返回值里告知。
 */
export function deleteAccount(actorId, targetId) {
  const target = db.prepare('SELECT id, username, role FROM accounts WHERE id = ?').get(targetId);
  if (!target) throw httpError(404, '账号不存在');
  if (target.id === actorId) throw httpError(409, '不能删除自己的账号');

  const active = countActiveItems(target.id);
  if (active > 0) {
    throw httpError(409, `该账号名下还有 ${active} 条未归档事项，请先转移给他人`, {
      code: 'HAS_ACTIVE_ITEMS',
      activeItems: active,
    });
  }

  if (target.role === 'admin') {
    const admins = db.prepare(`SELECT COUNT(*) AS n FROM accounts WHERE role = 'admin'`).get().n;
    if (admins <= 1) throw httpError(409, '系统里必须至少保留一个 admin');
  }

  const archived = db
    .prepare('SELECT COUNT(*) AS n FROM items WHERE owner_id = ? AND archived_at IS NOT NULL')
    .get(target.id).n;

  const removed = tx(() => {
    db.prepare('DELETE FROM items WHERE owner_id = ?').run(target.id);
    db.prepare('DELETE FROM sessions WHERE account_id = ?').run(target.id);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(target.id);
    return { ...target, deletedArchivedItems: archived };
  });

  return { removed, changed: [{ to: 'admins', kind: 'accounts' }] };
}

/** 把 fromId 名下全部事项转给 toId。 */
export function transferItems(fromId, toId) {
  const from = db.prepare('SELECT id, username FROM accounts WHERE id = ?').get(fromId);
  if (!from) throw httpError(404, '源账号不存在');
  const to = db.prepare('SELECT id, username FROM accounts WHERE id = ?').get(toId);
  if (!to) throw httpError(404, '目标账号不存在');
  if (from.id === to.id) throw httpError(400, '源账号与目标账号相同');

  const moved = transferAllItems(from.id, to.id);
  return {
    from,
    to,
    moved,
    changed: [
      { to: 'itemOwners', ownerIds: [from.id], kind: 'transferred-away' },
      { to: 'itemOwners', ownerIds: [to.id], kind: 'transferred-in' },
      { to: 'admins', kind: 'accounts' },
    ],
  };
}

/**
 * 首次启动引导：账号表为空时，用环境变量创建第一个 admin。
 * 返回值描述实际发生了什么，交给启动日志打印。
 */
export function ensureBootstrapAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
  if (count > 0) return { state: 'skipped' };

  const username = (process.env.RILI_ADMIN_USER || 'admin').trim();
  const password = process.env.RILI_ADMIN_PASSWORD;

  if (!password) return { state: 'no-password', username };

  const u = normalizeUsername(username);
  if (u.error) return { state: 'bad-username', username, message: u.error };
  const p = validatePassword(password);
  if (p.error) return { state: 'bad-password', username, message: p.error };

  db.prepare('INSERT INTO accounts (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)').run(
    u.value,
    hashPassword(p.value),
    'admin',
    new Date().toISOString(),
  );
  return { state: 'created', username: u.value };
}

export { verifyPassword };
