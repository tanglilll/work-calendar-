/** admin 管理面板：待批准申请 / 账号管理 / 归档（只读）。 */
import { api } from './api.js';
import { esc, formatDateTime, ownerLabel, toast } from './util.js';
import { bindDialogForThisOpen } from './dialog.js';

export function openAdminDialog(dialog, ctx) {
  const { me, palette, roles, onDone } = ctx;
  if (dialog.open) dialog.close();
  let tab = 'requests';

  dialog.innerHTML = `
    <div class="dialog-head">
      <span>管理</span>
      <button type="button" data-act="close" title="关闭">✕</button>
    </div>
    <div class="admin-tabs">
      <button type="button" class="tab is-active" data-tab="requests">待批准申请</button>
      <button type="button" class="tab" data-tab="accounts">账号</button>
      <button type="button" class="tab" data-tab="archive">归档</button>
    </div>
    <div class="dialog-body" id="admin-body"></div>`;

  const body = dialog.querySelector('#admin-body');

  async function render() {
    dialog.querySelectorAll('[data-tab]').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.tab === tab);
    });
    body.innerHTML = '<p class="panel-empty">加载中…</p>';
    try {
      if (tab === 'requests') await renderRequests();
      else if (tab === 'accounts') await renderAccounts();
      else await renderArchive();
    } catch (err) {
      body.innerHTML = `<p class="form-msg" data-kind="error">${esc(err.message)}</p>`;
    }
  }

  async function renderRequests() {
    const { requests } = await api.adminRequests();
    if (!requests.length) {
      body.innerHTML = '<p class="panel-empty">没有待批准的申请。</p>';
      return;
    }
    body.innerHTML = `<table class="data">
      <thead><tr><th>用户名</th><th>备注</th><th>提交时间</th><th>操作</th></tr></thead>
      <tbody>${requests
        .map(
          (r) => `<tr>
            <td>${esc(r.username)}</td>
            <td>${esc(r.note) || '<span class="panel-empty">（无）</span>'}</td>
            <td>${esc(formatDateTime(r.created_at))}</td>
            <td><div class="inline-actions">
              <button type="button" class="primary" data-approve="${r.id}">批准</button>
              <button type="button" class="danger" data-reject="${r.id}">拒绝</button>
            </div></td>
          </tr>`,
        )
        .join('')}</tbody></table>
      <p class="hint">批准后账号立即生成，角色为 user（之后可在「账号」里调整）。拒绝会删除该申请，对方可重新提交。申请里的密码已加密存储，任何人都看不到明文。</p>`;
  }

  async function renderAccounts() {
    const { accounts } = await api.adminAccounts();
    body.innerHTML = `<table class="data">
      <thead><tr><th>用户名</th><th>角色</th><th>未归档事项</th><th>归档事项</th><th>操作</th></tr></thead>
      <tbody>${accounts
        .map(
          (a) => `<tr>
            <td>${esc(a.username)}${a.id === me.id ? ' <span class="pill">自己</span>' : ''}</td>
            <td><span class="pill ${esc(a.role)}">${esc(a.role)}</span></td>
            <td>${a.active_items}</td>
            <td>${a.archived_items}</td>
            <td><div class="inline-actions">
              ${roles
                .filter((r) => r !== a.role)
                .map((r) => `<button type="button" data-role="${r}" data-id="${a.id}">改为 ${r}</button>`)
                .join('')}
              <button type="button" data-transfer="${a.id}">转移事项</button>
              <button type="button" class="danger" data-del="${a.id}">删除</button>
            </div></td>
          </tr>`,
        )
        .join('')}</tbody></table>
      <p class="hint">删除账号前必须先把它名下的未归档事项转走；已归档事项会随账号一并删除。系统始终至少保留一个 admin。</p>`;
  }

  async function renderArchive() {
    const { items } = await api.archiveList();
    if (!items.length) {
      body.innerHTML = '<p class="panel-empty">还没有已归档的事项。</p>';
      return;
    }
    body.innerHTML = `<table class="data">
      <thead><tr><th>颜色</th><th>owner</th><th>标题</th><th>标签</th><th>起止</th><th>归档时间</th></tr></thead>
      <tbody>${items
        .map(
          (i) => `<tr class="archived">
            <td><span class="color-dot" style="background:${palette[i.color] || '#e5e7eb'}"></span></td>
            <td>${esc(ownerLabel(i))}</td>
            <td>${esc(i.title)}</td>
            <td>${esc(i.tag) || '—'}</td>
            <td>${esc(i.event_date)} → ${esc(i.due_date)}</td>
            <td>${esc(formatDateTime(i.archived_at))}</td>
          </tr>`,
        )
        .join('')}</tbody></table>
      <p class="hint">归档是只读的：这里只能查看，不能恢复为未完成。归档不可逆是刻意的设计，见 ADR 相关的设计记录。</p>`;
  }

  // 「哪一种操作该做什么」都在这里；监听器由 bindDialogForThisOpen 按次注册，
  // 因此这个函数每次打开只注册一组，不会累积。
  const onAction = async (ev) => {
    const el = ev.target.closest('button');
    if (!el) return;

    if (el.dataset.act === 'close') {
      dialog.close();
      return;
    }
    if (el.dataset.tab) {
      tab = el.dataset.tab;
      await render();
      return;
    }

    try {
      if (el.dataset.approve) {
        await api.approve(Number(el.dataset.approve));
        toast('已批准，账号已生成');
        await render();
        onDone();
      } else if (el.dataset.reject) {
        if (!confirm('确认拒绝并删除这条申请？对方可以重新提交。')) return;
        await api.reject(Number(el.dataset.reject));
        toast('已拒绝');
        await render();
        onDone();
      } else if (el.dataset.role) {
        await api.setRole(Number(el.dataset.id), el.dataset.role);
        toast('角色已更新');
        await render();
        onDone();
      } else if (el.dataset.transfer) {
        await doTransfer(Number(el.dataset.transfer));
      } else if (el.dataset.del) {
        await doDelete(Number(el.dataset.del));
      }
    } catch (err) {
      toast(err.message, 'error');
      if (err.status === 409 || err.status === 400) await render();
    }
  };
  // 同 itemform.js：监听器按「这一次打开」注册，下次打开整体解除
  bindDialogForThisOpen(dialog, { click: onAction });

  async function doTransfer(fromId) {
    const { accounts } = await api.adminAccounts();
    const targets = accounts.filter((a) => a.id !== fromId);
    if (!targets.length) {
      toast('没有可转移的目标账号', 'error');
      return;
    }
    const list = targets.map((a, i) => `${i + 1}. ${a.username}`).join('\n');
    const answer = prompt(`把该账号名下的全部事项转移给谁？输入序号：\n\n${list}`);
    if (answer === null) return;
    const idx = Number(answer) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= targets.length) {
      toast('序号无效', 'error');
      return;
    }
    const res = await api.transferItems(fromId, targets[idx].id);
    toast(`已转移 ${res.moved} 条事项给 ${targets[idx].username}`);
    await render();
    onDone();
  }

  async function doDelete(id) {
    if (!confirm('确认删除该账号？此操作不可撤销。若其名下还有未归档事项，系统会拒绝。')) return;
    try {
      const res = await api.deleteAccount(id);
      const extra = res.deletedArchivedItems ? `，并删除了 ${res.deletedArchivedItems} 条归档记录` : '';
      toast(`账号已删除${extra}`);
      await render();
      onDone();
    } catch (err) {
      toast(err.message, 'error');
      await render();
    }
  }

  render();
  dialog.showModal();
}
