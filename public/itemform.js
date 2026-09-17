/** 新建 / 编辑事项的对话框。流程决策在 items-flow.js，这里只负责呈现与绑定。 */
import { api } from './api.js';
import { esc, setFieldErrors, toast } from './util.js';
import { bindDialogForThisOpen } from './dialog.js';
import { archiveItem, removeItem, saveItem } from './items-flow.js';

export function openItemDialog(dialog, ctx) {
  const { item, today, tags, owners, canAssign, onDone } = ctx;
  const editing = !!item;

  if (dialog.open) dialog.close();

  const tagOptions = ['<option value="">（无标签）</option>']
    .concat(
      tags.map(
        (t) =>
          `<option value="${esc(t)}"${item && item.tag === t ? ' selected' : ''}>${esc(t)}</option>`,
      ),
    )
    .join('');

  const ownerOptions = owners
    .map(
      (o) =>
        `<option value="${o.id}"${item && item.owner_id === o.id ? ' selected' : ''}>${esc(o.username)}</option>`,
    )
    .join('');

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
          ${
            canAssign
              ? `<div class="field">
                   <span>owner</span>
                   <select name="owner_id">${ownerOptions}</select>
                   <div class="field-error" data-error-for="owner_id"></div>
                 </div>`
              : ''
          }
        </div>

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

  function collect() {
    const fd = new FormData(form);
    const payload = {
      title: String(fd.get('title') || ''),
      event_date: String(fd.get('event_date') || ''),
      due_date: String(fd.get('due_date') || ''),
      tag: String(fd.get('tag') || '') || null,
    };
    if (canAssign) payload.owner_id = Number(fd.get('owner_id'));
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
