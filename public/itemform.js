/** 新建 / 编辑事项的对话框。流程决策在 items-flow.js，这里只负责呈现与绑定。 */
import { api } from './api.js';
import { esc, ownerNames, setFieldErrors, toast } from './util.js';
import { bindDialogForThisOpen } from './dialog.js';
import { archiveItem, invitePeople, removeItem, saveItem } from './items-flow.js';

export function openItemDialog(dialog, ctx) {
  const { item, today, tags, owners, canAssign, onDone } = ctx;
  const editing = !!item;

  if (dialog.open) dialog.close();

  const isOwner = (id) => (item?.owners ?? []).some((o) => o.id === id);
  const invitable = owners.filter((o) => !isOwner(o.id));

  const tagOptions = ['<option value="">（无标签）</option>']
    .concat(
      tags.map(
        (t) =>
          `<option value="${esc(t)}"${item && item.tag === t ? ' selected' : ''}>${esc(t)}</option>`,
      ),
    )
    .join('');

  // 管理员/经理改名单直接生效；普通成员只能邀请，且需要对方接受
  const ownerField = canAssign
    ? `<div class="field">
         <span>owner 名单（可多选，改动直接生效）</span>
         <div class="owner-picker">
           ${owners
             .map(
               (o) => `<label class="owner-option">
                 <input type="checkbox" name="owner_ids" value="${o.id}"${isOwner(o.id) ? ' checked' : ''}>
                 <span>${esc(o.username)}</span>
               </label>`,
             )
             .join('')}
         </div>
         <div class="field-error" data-error-for="owner_ids"></div>
       </div>`
    : `<div class="field">
         <span>owner 名单</span>
         <div class="owner-chips">
           ${(item?.owners ?? [])
             .map((o) => `<span class="pill">${esc(o.username)}</span>`)
             .join('') || '<span class="panel-empty">（保存后确定）</span>'}
         </div>
       </div>`;

  const inviteField =
    editing && !canAssign && invitable.length
      ? `<div class="field">
           <span>邀请他人一起做（需要对方接受；接受之前对方看不到这条事项）</span>
           <div class="owner-picker">
             ${invitable
               .map(
                 (o) => `<label class="owner-option">
                   <input type="checkbox" name="invite_ids" value="${o.id}">
                   <span>${esc(o.username)}</span>
                 </label>`,
               )
               .join('')}
           </div>
           <div><button type="button" data-act="invite">发出邀请</button></div>
           <div class="field-error" data-error-for="invite_ids"></div>
         </div>`
      : '';

  dialog.innerHTML = `
    <div class="dialog-head">
      <span>${editing ? '编辑事项' : '新建事项'}</span>
      <button type="button" data-act="cancel" title="关闭">✕</button>
    </div>
    <div class="dialog-body">
      <form id="item-form" autocomplete="off">
        <div class="field">
          <span>标题</span>
          <input name="title" maxlength="200" value="${editing ? esc(item.title) : ''}" placeholder="要做什么">
          <div class="field-error" data-error-for="title"></div>
        </div>

        <div class="field">
          <span>进展（这件事现在做到哪了，可留空）</span>
          <textarea name="progress" rows="2" maxlength="500" placeholder="覆盖式更新，不保留历史">${editing ? esc(item.progress ?? '') : ''}</textarea>
          <div class="field-error" data-error-for="progress"></div>
        </div>

        <div class="field-row">
          <div class="field">
            <span>起始日期</span>
            <input type="date" name="event_date" value="${editing ? esc(item.event_date) : today}">
            <div class="field-error" data-error-for="event_date"></div>
          </div>
          <div class="field">
            <span>截止日期</span>
            <input type="date" name="due_date" value="${editing ? esc(item.due_date) : today}">
            <div class="field-error" data-error-for="due_date"></div>
          </div>
        </div>

        <div class="field-row">
          <div class="field">
            <span>标签</span>
            <select name="tag">${tagOptions}</select>
            <div class="field-error" data-error-for="tag"></div>
          </div>
        </div>

        ${ownerField}
        ${inviteField}

        <p class="hint">颜色由系统自动分配，不可手选。截止日期不得早于起始日期。</p>
      </form>
    </div>
    <div class="dialog-foot">
      ${editing ? '<button type="button" class="danger" data-act="delete">删除</button>' : ''}
      ${editing ? '<button type="button" class="primary" data-act="archive">标记完成</button>' : ''}
      <button type="button" data-act="cancel">取消</button>
      <button type="button" class="primary" data-act="save">保存</button>
    </div>`;

  const form = dialog.querySelector('#item-form');
  const busy = (on) => {
    dialog.querySelectorAll('button').forEach((b) => {
      b.disabled = on;
    });
  };

  const checkedIds = (name) =>
    [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((el) => Number(el.value));

  function collect() {
    const fd = new FormData(form);
    const payload = {
      title: String(fd.get('title') || ''),
      event_date: String(fd.get('event_date') || ''),
      due_date: String(fd.get('due_date') || ''),
      tag: String(fd.get('tag') || '') || null,
      progress: String(fd.get('progress') || ''),
    };
    if (canAssign) payload.owner_ids = checkedIds('owner_ids');
    return payload;
  }

  /** 执行一个流程决策，并按它的结果决定怎么呈现。 */
  async function run(action) {
    setFieldErrors(form, null);
    busy(true);
    try {
      const result = await action();
      if (result.fields) setFieldErrors(form, result.fields);
      if (result.message) toast(result.message, 'error');
      if (result.toast) toast(result.toast);
      if (result.close) {
        dialog.close();
        onDone();
      }
    } finally {
      busy(false);
    }
  }

  const onAction = (act) => {
    if (act === 'cancel') {
      dialog.close();
      return undefined;
    }
    if (act === 'save') return run(() => saveItem({ api, item, payload: collect() }));
    if (act === 'archive') return run(() => archiveItem({ api, item, confirm }));
    if (act === 'delete') return run(() => removeItem({ api, item, confirm }));
    if (act === 'invite') {
      return run(() => invitePeople({ api, item, accountIds: checkedIds('invite_ids') }));
    }
    return undefined;
  };

  // 监听器按「这一次打开」注册，下次打开会整体解除——见 dialog.js
  bindDialogForThisOpen(dialog, {
    click: (ev) => {
      const act = ev.target.closest('[data-act]')?.dataset.act;
      if (act) onAction(act);
    },
    submit: (ev) => {
      ev.preventDefault();
      run(() => saveItem({ api, item, payload: collect() }));
    },
  });

  dialog.showModal();
  form.querySelector('[name="title"]')?.focus();
}

export { ownerNames };
