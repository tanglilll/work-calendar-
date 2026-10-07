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

/** 库里的时间戳是 UTC 的 ISO 串，展示时一律换成本机时间——界面上其余时间都是本机的。 */
export function formatDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${toDateString(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

/**
 * 表单字段错误：清空表单里的 .field-error，再把 message 写到对应的
 * `[data-error-for="<字段名>"]` 上（字段名就是服务端 fields 的键）。
 *
 * **返回没有落点的字段**（`[name, message]` 数组）：表单还没为这个键准备落点时，
 * 写不进去也不许静默——调用方要兜底显示（见 showFormFailure），否则错误只是
 * 从调用点挪到了这里丢。
 */
export function setFieldErrors(form, fields) {
  form.querySelectorAll('.field-error').forEach((el) => {
    el.textContent = '';
  });
  if (!fields) return [];
  const orphaned = [];
  for (const [name, message] of Object.entries(fields)) {
    const el = form.querySelector(`[data-error-for="${name}"]`);
    if (el) el.textContent = message;
    else orphaned.push([name, message]);
  }
  return orphaned;
}

/**
 * 一次表单提交失败的行内呈现：表单级 message（[data-msg]）+ 字段级 fields（落点），两路都不许丢。
 *
 * 登录 / 申请两个表单共用这一条路径。以前 catch 里只写 err.message，服务端 400 的
 * `error.fields`（「密码至少 8 位」这类字段级细节）在 app.js 被静默丢掉，用户只看到
 * 一行「输入有误」——字段有消息却还没有落点时，折回表单级提示里，仍然看得见。
 *
 * `form` 只要求 querySelector / querySelectorAll，所以 node:test 里用替身就能断言
 * （见 test/auth-form-errors.test.js）；真实浏览器的渲染仍只能在浏览器里验。
 */
export function showFormFailure(form, err) {
  const msg = form.querySelector('[data-msg]');
  const orphaned = setFieldErrors(form, err.fields);
  if (!msg) return;
  msg.dataset.kind = 'error';
  const messages = [err.message, ...orphaned.map(([, message]) => message)].filter(Boolean);
  msg.textContent = [...new Set(messages)].join('；');
}
