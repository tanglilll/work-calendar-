/**
 * 待接受邀请：列表 + 接受/拒绝。
 * 邀请不是参与者状态，所以它自成一屏，而不是挂在日历或某个面板里。
 */
import { api } from './api.js';
import { esc, toast } from './util.js';
import { bindDialogForThisOpen } from './dialog.js';
import { respondToInvite } from './items-flow.js';

export function openInvitesDialog(dialog, ctx) {
  const { onDone } = ctx;
  if (dialog.open) dialog.close();

  dialog.innerHTML = `
    <div class="dialog-head">
      <span>待接受邀请</span>
      <button type="button" data-act="close" title="关闭">✕</button>
    </div>
    <div class="dialog-body" id="invites-body"><p class="panel-empty">加载中…</p></div>`;

  const body = dialog.querySelector('#invites-body');

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

  async function onAction(ev) {
    const el = ev.target.closest('button');
    if (!el) return;

    if (el.dataset.act === 'close') {
      dialog.close();
      return;
    }

    const id = el.dataset.accept ?? el.dataset.reject;
    if (!id) return;

    const result = await respondToInvite({
      api,
      invite: { id: Number(id) },
      accept: !!el.dataset.accept,
    });
    if (result.message) toast(result.message, 'error');
    if (result.toast) toast(result.toast);

    try {
      await render();
      onDone();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  bindDialogForThisOpen(dialog, { click: onAction });

  render().catch((err) => {
    body.innerHTML = `<p class="form-msg" data-kind="error">${esc(err.message)}</p>`;
  });
  dialog.showModal();
}
