/**
 * 侧栏三个聚合面板。数据已由服务端按角色过滤过可见性，这里只做分类。
 *
 * 两个口径要一起看：
 * - 「逾期基线」= due_date <= 今天（截止当天就进提醒）；
 * - 「截止提醒」分两组展示：已逾期（due_date < 今天，红字高亮）与今天截止（due_date == 今天）。
 *   两组不重叠，其合计正是 due_date <= 今天 的全部事项。
 */
import { esc } from './util.js';

function row(item, palette, cls = '') {
  const color = palette[item.color] || '#e5e7eb';
  const tag = item.tag ? `<span class="tag-chip">${esc(item.tag)}</span>` : '';
  return `<div class="row ${cls}" data-item-id="${item.id}" style="border-left-color:${color}">
    <div class="row-title">${esc(item.title)}${tag}</div>
    <div class="row-meta">${esc(item.owner_name)} · ${esc(item.event_date)} → ${esc(item.due_date)}</div>
  </div>`;
}

const panelShell = (title, count, countClass = '', body) =>
  `<h2>${esc(title)}<span class="count ${countClass}">${count}</span></h2>${body}`;

export function computeGroups(items, today) {
  const covering = items
    .filter((i) => i.event_date <= today && today <= i.due_date)
    .sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0));

  const overdue = items
    .filter((i) => i.due_date < today)
    .sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0));

  const dueToday = items
    .filter((i) => i.due_date === today)
    .sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh'));

  const multi = items
    .filter((i) => i.event_date < i.due_date)
    .sort((a, b) => (a.event_date < b.event_date ? -1 : a.event_date > b.event_date ? 1 : 0));

  return { covering, overdue, dueToday, multi };
}

export function renderPanels(els, items, today, palette) {
  const { covering, overdue, dueToday, multi } = computeGroups(items, today);

  els.today.innerHTML = panelShell(
    '今日任务',
    covering.length,
    '',
    covering.length
      ? covering.map((i) => row(i, palette)).join('')
      : '<p class="panel-empty">今天没有安排。</p>',
  );

  const dueBody = [];
  dueBody.push(`<p class="panel-sub">已逾期<span class="count danger">${overdue.length}</span></p>`);
  dueBody.push(
    overdue.length ? overdue.map((i) => row(i, palette, 'overdue')).join('') : '<p class="panel-empty">没有逾期事项。</p>',
  );
  dueBody.push(`<p class="panel-sub">今天截止<span class="count">${dueToday.length}</span></p>`);
  dueBody.push(
    dueToday.length ? dueToday.map((i) => row(i, palette, 'due-today')).join('') : '<p class="panel-empty">今天没有截止事项。</p>',
  );
  els.due.innerHTML = `<h2>截止提醒<span class="count ${overdue.length ? 'danger' : ''}">${overdue.length + dueToday.length}</span></h2>${dueBody.join('')}`;

  els.multi.innerHTML = panelShell(
    '多日任务清单',
    multi.length,
    '',
    multi.length
      ? multi.map((i) => row(i, palette)).join('')
      : '<p class="panel-empty">没有跨多日的事项。</p>',
  );
}
