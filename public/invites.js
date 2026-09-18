/**
 * 待接受邀请：列表 + 接受/拒绝。
 * 邀请不是参与者状态，所以它自成一屏，而不是挂在日历或某个面板里。
 */
import { api } from './api.js';
import { esc, toast } from './util.js';
import {
  DIALOG_ACT,
  actAttr,
  openDialog,
  outcomeOf,
  presentResult,
  readAct,
  runAct,
} from './contracts.js';
import { respondToInvite } from './items-flow.js';

export function openInvitesDialog(dialog, ctx) {
  const { onDone } = ctx;
  // 内容由 openDialog 写进 dialog，所以开框之后才拿得到列表主体
  let body = null;

  const html = `
    <div class="dialog-head">
      <span>待接受邀请</span>
      <button type="button" ${actAttr(DIALOG_ACT.close)} title="关闭">✕</button>
    </div>
    <div class="dialog-body" id="invites-body"><p class="panel-empty">加载中…</p></div>`;

  const ui = {
    toast,
    refresh: () => render(),
    close: () => dialog.close(),
    done: onDone,
  };

  async function render() {
    const { items } = await api.invites();
    if (!items.length) {
      body.innerHTML = '<p class="panel-empty">没有待接受的邀请。</p>';
      return;
    }
    body.innerHTML = items
      .map(
        (v) => `<div class="invite-row">
        <div class="invite-main">
          <div class="invite-title">${esc(v.title)}</div>
          <div class="invite-meta">${esc(v.invited_by_name)} 邀请你一起做 ·
            ${esc(v.event_date)} → ${esc(v.due_date)}${v.tag ? ' · ' + esc(v.tag) : ''}</div>
        </div>
        <div class="inline-actions">
          <button type="button" class="primary" data-accept="${v.id}">接受</button>
          <button type="button" data-reject="${v.id}">拒绝</button>
        </div>
      </div>`,
      )
      .join('');
  }

  const actHandlers = {
    [DIALOG_ACT.close]: () => dialog.close(),
  };

  async function onAction(ev) {
    const el = ev.target.closest('button');
    if (!el) return;

    const act = readAct(el);
    if (act) return runAct(actHandlers, act);

    const id = el.dataset.accept ?? el.dataset.reject;
    if (!id) return;

    // 回应之后列表与应用状态都要重拉——成败都一样：失败常意味着这条邀请已经不在待处理里了
    const result = await outcomeOf(() =>
      respondToInvite({ api, invite: { id: Number(id) }, accept: !!el.dataset.accept }),
    );
    await presentResult({ ...result, refresh: true, done: true }, ui);
  }

  // 开框仪式与监听器生命周期各有落点：openDialog 见 contracts.js，按次解除见 dialog.js
  openDialog(dialog, {
    html,
    listeners: { click: onAction },
    onOpen: () => {
      body = dialog.querySelector('#invites-body');
      // 初次加载失败时把话说在框里（列表还没画出来，没有别的落点）
      render().catch((err) => {
        body.innerHTML = `<p class="form-msg" data-kind="error">${esc(err.message)}</p>`;
      });
    },
  });
}
