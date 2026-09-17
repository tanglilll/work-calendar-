/** 前端通用工具。所有插入 DOM 的用户数据都必须先过 esc()。 */

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

export function toDateString(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseDate(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(s, n) {
  const d = parseDate(s);
  return toDateString(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
}

export function formatMonth(year, month) {
  return `${year} 年 ${month} 月`;
}

/**
 * 归属文案。owner 是一个并列名单（见 docs/adr/0002）：
 * 一个人写名字，多个人写「第一个 +N」——名字按用户名排序，取第一个。
 */
export function ownerLabel(item) {
  const names = (item.owners ?? []).map((o) => o.username);
  if (!names.length) return '（无 owner）';
  return names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`;
}

/** 完整名单，给 tooltip 用。 */
export function ownerNames(item) {
  const names = (item.owners ?? []).map((o) => o.username);
  return names.length ? names.join('、') : '（无 owner）';
}

let toastTimer = null;

export function toast(message, kind = 'info') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, kind === 'error' ? 5000 : 2600);
}

/** 表单字段错误：把 message 写到 closest('.field') 内的 .field-error。 */
export function setFieldErrors(form, fields) {
  form.querySelectorAll('.field-error').forEach((el) => {
    el.textContent = '';
  });
  if (!fields) return;
  for (const [name, message] of Object.entries(fields)) {
    const el = form.querySelector(`[data-error-for="${name}"]`);
    if (el) el.textContent = message;
  }
}
