/**
 * 账号与注册申请。账号只在「批准」那一刻诞生；申请表里存的密码已经是哈希。
 *
 * store、items 与 invites 由组合根注入：删账号前要数它名下的事项，也要问出
 * 它发出的、以及挂在被删事项上的待接受邀请都发给了谁（那些人要收到定向通知）；
 * 共享事项的名单摘除与 version 推进走 items（名单与事项表都归那个 module）。
 * 两个领域依赖都是显式的。
 *
 * 会话表的写入归 auth（auth.js 的 createSessions）：这里不删会话——
 * 账号行删除后由 sessions.account_id 的 ON DELETE CASCADE 接手
 * （db.js 打开库时 `PRAGMA foreign_keys = ON`），旧会话因此立刻失效。
 */
import { hashPassword } from './auth.js';
import { LIMITS } from './config.js';
import { ROLES } from './visibility.js';
import { accountChanged, accountDeleted, adminsChanged, ownerChanged, ownerChanges } from './changes.js';
import { httpError } from './http.js';

const USERNAME_RE = /^[\p{L}\p{N}_.-]+$/u;

export function createAccounts(store, items, invites) {
  const { db, tx } = store;

  function normalizeUsername(raw) {
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

  function validatePassword(raw) {
    if (typeof raw !== 'string') return { error: '密码必须是文本' };
    if (raw.length < LIMITS.PASSWORD_MIN) return { error: `密码至少 ${LIMITS.PASSWORD_MIN} 位` };
    if (raw.length > LIMITS.PASSWORD_MAX) return { error: `密码最多 ${LIMITS.PASSWORD_MAX} 位` };
    return { value: raw };
  }

  /** 账号名是否已被账号表占用（大小写不敏感）。 */
  function usernameTaken(username) {
    return !!db.prepare('SELECT 1 FROM accounts WHERE username = ? COLLATE NOCASE').get(username);
  }

  /** 访客提交注册申请。此时不产生账号。 */
  function submitRegistrationRequest(input) {
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

    return { changed: [adminsChanged('requests')] };
  }

  /** 待批准申请列表。刻意不返回 password_hash。 */
  function listRequests() {
    return db
      .prepare('SELECT id, username, note, created_at FROM registration_requests ORDER BY created_at ASC, id ASC')
      .all();
  }

  /** 批准申请：账号在这一刻生成，角色固定为 user。 */
  function approveRequest(id) {
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
        adminsChanged('accounts'),
        adminsChanged('requests'),
        // 申请人自己的其它客户端立刻可用
        accountChanged([account.id], 'approved'),
      ],
    };
  }

  /** 拒绝申请：直接删除记录，对方可重新提交。 */
  function rejectRequest(id) {
    const info = db.prepare('DELETE FROM registration_requests WHERE id = ?').run(id);
    if (info.changes === 0) throw httpError(404, '注册申请不存在');
    return { changed: [adminsChanged('requests')] };
  }

  /**
   * 账号列表。两个计数是「这个账号参与了多少条」（含与别人共享的），
   * 用于管理面板展示；删除门槛看的是「它是唯一 owner 的那些」，见 deleteAccount。
   */
  function listAccounts() {
    return db
      .prepare(
        `SELECT a.id, a.username, a.role, a.created_at,
                (SELECT COUNT(*) FROM items i JOIN item_owners m ON m.item_id = i.id
                  WHERE m.account_id = a.id AND i.archived_at IS NULL) AS active_items,
                (SELECT COUNT(*) FROM items i JOIN item_owners m ON m.item_id = i.id
                  WHERE m.account_id = a.id AND i.archived_at IS NOT NULL) AS archived_items
           FROM accounts a
          ORDER BY a.created_at ASC, a.id ASC`,
      )
      .all();
  }

  /** 供 manager/admin 在事项的 owner 名单里挑人。只暴露 id 与用户名。 */
  function listOwners() {
    return db.prepare('SELECT id, username FROM accounts ORDER BY username ASC').all();
  }

  function findAccountByUsername(username) {
    return db
      .prepare('SELECT id, username, password_hash, role FROM accounts WHERE username = ? COLLATE NOCASE')
      .get(username);
  }

  /**
   * 按 id 取权威角色 —— SSE 中枢在【推送时】问它（组合根接进 createSse 的 roleOf）。
   * 连接里不存 role 副本，所以降权、删号立刻在旧连接上生效；账号已不存在返回 null。
   */
  function roleOf(accountId) {
    const row = db.prepare('SELECT role FROM accounts WHERE id = ?').get(accountId);
    return row?.role ?? null;
  }

  function changeRole(actorId, targetId, role) {
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
        adminsChanged('accounts'),
        // 角色变了，对方必须重新拉取，越权数据要立刻从他的客户端消失
        accountChanged([targetId], 'role-changed'),
      ],
    };
  }

  /**
   * 删除账号。要求「它是唯一 owner」的未归档事项为零（那些必须先转移）；
   * 与别人共享的事项只是把它从 owner 名单里摘掉，事项本身留着 —— 摘除与 version
   * 推进交给 items.detachOwner（名单与 version 都归那张表），剩下的人各收一条带
   * itemId 的 items 变更；否则他们的窗口停在旧名单，手里的过期编辑框也撞不上版本冲突。
   * 已归档且只属于它的事项随账号一并删除，数量在返回值里告知；
   * 挂在这些事项上的待接受邀请也随级联消失，收件人一并定向通知。
   * 会话随账号级联消失（见文件头）：不在这里写 sessions。
   */
  function deleteAccount(actorId, targetId) {
    const target = db.prepare('SELECT id, username, role FROM accounts WHERE id = ?').get(targetId);
    if (!target) throw httpError(404, '账号不存在');
    if (target.id === actorId) throw httpError(409, '不能删除自己的账号');

    const active = items.countSoleOwnedActiveItems(target.id);
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

    const archived = items.countSoleOwnedArchivedItems(target.id);
    // 它发出的待接受邀请也随它级联消失：被邀请人不是 admin，得单独告诉一声，
    // 否则他们的角标要等下一次全量重拉才准（删除前问，删除后就查不到了）
    const inviteesOfItsInvites = invites.pendingInviteesFrom(target.id);

    const { detachments, inviteesOfDeletedItems } = tx(() => {
      // 顺序有讲究：先给仍然有效的共享事项摘名单并推进 version（账号行一删，
      // 「它原来在哪些名单里、剩下谁」就查不到了），再删「唯一 owner 的已归档事项」
      // （挂在它们上面的待邀请人在这一步报出来），最后删账号行。
      const detached = items.detachOwner(target.id);
      const soleOwned = items.deleteSoleOwnedItems(target.id);
      db.prepare('DELETE FROM accounts WHERE id = ?').run(target.id);
      return { detachments: detached, inviteesOfDeletedItems: soleOwned.orphanedInvitees };
    });

    // 两批被邀请人合成一条定向通知（同一批人不重复出现）：前者是它发出的邀请，
    // 后者挂在被它连累删除的事项上——可能是别人（如 admin）替它的事件事发的
    const orphanedInvitees = [...new Set([...inviteesOfItsInvites, ...inviteesOfDeletedItems])].sort(
      (a, b) => a - b,
    );

    return {
      removed: { ...target, deletedArchivedItems: archived },
      // 账号没了，它的连接立刻断开（走词表的 connections 去向）；
      // admin 面板再各自刷新名单；受级联影响的人各收自己那一路定向通知。
      changed: [
        // 每条受影响的共享事项各一条（带 itemId）：剩下的人要重拉，过期编辑框要撞 409
        ...detachments.map(({ itemId, ownerIds }) => ownerChanged(itemId, ownerIds, 'updated')),
        accountDeleted(target.id),
        adminsChanged('accounts'),
        ...(orphanedInvitees.length ? [accountChanged(orphanedInvitees, 'invites-changed')] : []),
      ],
    };
  }

  /** 把 fromId 名下全部事项转给 toId。 */
  function transferItems(fromId, toId) {
    const from = db.prepare('SELECT id, username FROM accounts WHERE id = ?').get(fromId);
    if (!from) throw httpError(404, '源账号不存在');
    const to = db.prepare('SELECT id, username FROM accounts WHERE id = ?').get(toId);
    if (!to) throw httpError(404, '目标账号不存在');
    if (from.id === to.id) throw httpError(400, '源账号与目标账号相同');

    // 每条受影响的事项各产生一组差分变更（带上 itemId）：转移不是「一条变更」，
    // 而是「这批事项的名单都变了」——谁需要被通知由词表的 ownerChanges 算，与另两处同源。
    const moves = items.transferAllItems(from.id, to.id);
    return {
      from,
      to,
      moved: moves.length,
      changed: [
        ...moves.flatMap(({ itemId, before, after }) => ownerChanges({ itemId, before, after })),
        adminsChanged('accounts'),
      ],
    };
  }

  /**
   * 首次启动引导：账号表为空时，用给定的用户名与密码创建第一个 admin。
   * 环境变量由入口读取后传进来，这里不碰 process.env。
   * 返回值描述实际发生了什么，交给启动日志打印。
   */
  function ensureBootstrapAdmin({ username: rawUsername, password } = {}) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
    if (count > 0) return { state: 'skipped' };

    const username = (rawUsername || 'admin').trim();
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

  return {
    submitRegistrationRequest,
    listRequests,
    approveRequest,
    rejectRequest,
    listAccounts,
    listOwners,
    findAccountByUsername,
    roleOf,
    changeRole,
    deleteAccount,
    transferItems,
    ensureBootstrapAdmin,
  };
}
