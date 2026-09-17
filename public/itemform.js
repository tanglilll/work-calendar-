/** 新建 / 编辑事项的对话框。 */
import { api } from './api.js';
import { esc, setFieldErrors, toast } from './util.js';

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

  async function save() {
    setFieldErrors(form, null);
    busy(true);
    try {
      if (editing) {
        await api.updateItem(item.id, { ...collect(), version: item.version });
      } else {
        await api.createItem(collect());
      }
      dialog.close();
      onDone();
    } catch (err) {
      if (err.fields) setFieldErrors(form, err.fields);
      else if (err.status === 409) {
        toast(err.message, 'error');
        dialog.close();
        onDone();
      } else {
        toast(err.message, 'error');
      }
    } finally {
      busy(false);
    }
  }

  async function archive() {
    // 归档不可逆，先二次确认
    if (!confirm(`确认把「${item.title}」标记为完成？\n\n完成后该事项会从日历和所有面板消失，且无法撤销。`)) return;
    busy(true);
    try {
      await api.archiveItem(item.id, item.version);
      dialog.close();
      onDone();
      toast('已标记完成（已归档）');
    } catch (err) {
      toast(err.message, 'error');
      if (err.status === 409) {
        dialog.close();
        onDone();
      }
    } finally {
      busy(false);
    }
  }

  async function remove() {
    if (!confirm(`确认删除「${item.title}」？\n\n删除是物理移除，与「标记完成」不同，记录不会保留。`)) return;
    busy(true);
    try {
      await api.deleteItem(item.id);
      dialog.close();
      onDone();
      toast('已删除');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      busy(false);
    }
  }

  dialog.addEventListener('click', (ev) => {
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'cancel') dialog.close();
    else if (act === 'save') save();
    else if (act === 'archive') archive();
    else if (act === 'delete') remove();
  });

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    save();
  });

  dialog.showModal();
  form.querySelector('[name="title"]')?.focus();
}
