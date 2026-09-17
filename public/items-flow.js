/**
 * 事项流程的决策层：新建 / 编辑 / 归档 / 删除分别该怎么走。
 *
 * 只做决定，不碰 DOM：网络与「要不要确认」都作为依赖传入，因此每条分支——包括
 * 字段错误、409 版本冲突、用户取消——都能在无头环境里跑一遍
 * （见 test/items-flow.test.js）。
 *
 * 返回结果而不是自己弹提示、关对话框：呈现是 itemform.js 的事。
 * close 表示「这次操作后该把对话框关掉并刷新」——409 就是这种情况（你手上的副本已过期）。
 */

/** 新建（item 为空）或编辑（带 version）。 */
export async function saveItem({ api, item, payload }) {
  try {
    if (item) await api.updateItem(item.id, { ...payload, version: item.version });
    else await api.createItem(payload);
    return { ok: true, close: true };
  } catch (err) {
    if (err.fields) return { ok: false, close: false, fields: err.fields };
    // 版本冲突：关掉对话框并刷新，否则用户会对着过期数据继续改
    if (err.status === 409) return { ok: false, close: true, message: err.message };
    return { ok: false, close: false, message: err.message };
  }
}

/** 归档（不可逆）。先二次确认；用户取消则什么都不做。 */
export async function archiveItem({ api, item, confirm }) {
  const agreed = confirm(
    `确认把「${item.title}」标记为完成？\n\n完成后该事项会从日历和所有面板消失，且无法撤销。`,
  );
  if (!agreed) return { ok: false, close: false, reason: 'cancelled' };

  try {
    await api.archiveItem(item.id, item.version);
    return { ok: true, close: true, toast: '已标记完成（已归档）' };
  } catch (err) {
    if (err.status === 409) return { ok: false, close: true, message: err.message };
    return { ok: false, close: false, message: err.message };
  }
}

/** 删除：物理移除，与归档相对（记录不保留）。 */
export async function removeItem({ api, item, confirm }) {
  const agreed = confirm(
    `确认删除「${item.title}」？\n\n删除是物理移除，与「标记完成」不同，记录不会保留。`,
  );
  if (!agreed) return { ok: false, close: false, reason: 'cancelled' };

  try {
    await api.deleteItem(item.id);
    return { ok: true, close: true, toast: '已删除' };
  } catch (err) {
    return { ok: false, close: false, message: err.message };
  }
}

/**
 * 邀请他人一起做（需要对方接受）。
 * 逐个人发；已经发过或已在名单里会被服务端拒绝，这里如实把第一条错误报出来。
 */
export async function invitePeople({ api, item, accountIds }) {
  if (!item) return { ok: false, close: false, fields: { invite_ids: '先保存这条事项，才能邀请别人' } };
  if (!accountIds.length) return { ok: false, close: false, fields: { invite_ids: '先勾选要邀请的人' } };

  try {
    for (const accountId of accountIds) await api.invite(item.id, accountId);
    return { ok: true, close: false, toast: `已发出 ${accountIds.length} 条邀请，等对方接受` };
  } catch (err) {
    return { ok: false, close: false, message: err.message };
  }
}

/** 回应邀请：接受就让这条事项出现在自己的看板上，拒绝就删掉它。 */
export async function respondToInvite({ api, invite, accept }) {
  try {
    if (accept) {
      await api.acceptInvite(invite.id);
      return { ok: true, toast: '已接受，这条事项现在在你的看板上' };
    }
    await api.rejectInvite(invite.id);
    return { ok: true, toast: '已拒绝，对方可以再邀' };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}
