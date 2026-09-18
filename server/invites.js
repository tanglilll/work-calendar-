/**
 * 邀请：把某个账号加进一条事项的 owner 名单，但要对方同意。
 *
 * 邀请**不是参与者状态**——被邀请人还不是 owner，所以它自成一类：
 * 有自己的表、自己的读法（他看不到事项本身，只看得到邀请里的标题与日期）。
 * 管理员直接改名单不走这里，那是分派，不是协商（见 docs/adr/0002）。
 */
import { canAccessItem } from './visibility.js';
import { accountChanged, ownerChanges } from './sse.js';
import { httpError } from './http.js';

export function createInvites(store, items) {
  const { db, tx } = store;

  /** 发起邀请。actor 必须本来就看得见这条事项——名单成员，或 manager/admin。 */
  function invite(itemId, accountId, actor) {
    const item = items.getItem(itemId);
    if (!item) throw httpError(404, '事项不存在');
    if (!canAccessItem(actor, item)) throw httpError(403, '无权处置他人的事项');

    const targetId = Number(accountId);
    if (!Number.isInteger(targetId) || targetId <= 0) throw httpError(400, '请指定要邀请的账号');
    const target = db.prepare('SELECT id, username FROM accounts WHERE id = ?').get(targetId);
    if (!target) throw httpError(400, '要邀请的账号不存在');
    if (item.owners.some((o) => o.id === targetId)) {
      throw httpError(409, `「${target.username}」已经在名单里了`);
    }
    if (db.prepare('SELECT 1 FROM item_invites WHERE item_id = ? AND account_id = ?').get(itemId, targetId)) {
      throw httpError(409, `已经邀请过「${target.username}」，等对方处理`);
    }

    const info = db
      .prepare(
        'INSERT INTO item_invites (item_id, account_id, invited_by, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(itemId, targetId, actor.id, new Date().toISOString());

    return {
      invite: {
        id: Number(info.lastInsertRowid),
        item_id: itemId,
        account_id: targetId,
        invited_by: actor.id,
      },
      // 被邀请人的角标要立刻动
      changed: [accountChanged([targetId], 'invites-changed')],
    };
  }

  /** 我的待接受邀请。带上判断所需的一切：标题、日期、发起人。 */
  function listFor(account) {
    return db
      .prepare(
        `SELECT v.id, v.item_id, v.created_at,
                i.title, i.event_date, i.due_date, i.tag,
                a.username AS invited_by_name
           FROM item_invites v
           JOIN items i ON i.id = v.item_id
           JOIN accounts a ON a.id = v.invited_by
          WHERE v.account_id = ?
          ORDER BY v.created_at ASC, v.id ASC`,
      )
      .all(account.id);
  }

  function countFor(account) {
    return db.prepare('SELECT COUNT(*) AS n FROM item_invites WHERE account_id = ?').get(account.id).n;
  }

  function requireMine(inviteId, account) {
    const row = db.prepare('SELECT * FROM item_invites WHERE id = ?').get(Number(inviteId));
    if (!row) throw httpError(404, '邀请不存在或已被处理');
    if (row.account_id !== account.id) throw httpError(403, '这条邀请不是发给你的');
    return row;
  }

  /** 接受：成为名单成员之一，与其他人并列。 */
  function accept(inviteId, account) {
    const row = requireMine(inviteId, account);

    const item = tx(() => {
      db.prepare('INSERT OR IGNORE INTO item_owners (item_id, account_id) VALUES (?, ?)').run(
        row.item_id,
        account.id,
      );
      db.prepare('DELETE FROM item_invites WHERE id = ?').run(row.id);
      return items.getItem(row.item_id);
    });

    // 接受 = 名单里多了一个人：差分与「谁需要被通知」走词表那一处实现
    const before = item.owners.filter((o) => o.id !== account.id).map((o) => o.id);
    const changed = [
      accountChanged([account.id], 'invites-changed'),
      ...ownerChanges({ itemId: item.id, before, after: item.owners.map((o) => o.id) }),
    ];

    return { item, changed };
  }

  /**
   * 拒绝：删掉这条邀请，发起人可以再邀——与「拒绝注册申请」同一语义
   * （拒绝即删除记录，不留下一个否定的状态）。
   */
  function reject(inviteId, account) {
    const row = requireMine(inviteId, account);
    db.prepare('DELETE FROM item_invites WHERE id = ?').run(row.id);
    return { changed: [accountChanged([account.id], 'invites-changed')] };
  }

  return { invite, listFor, countFor, accept, reject };
}
