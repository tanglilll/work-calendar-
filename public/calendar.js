/**
 * 日历渲染：固定 42 格、周一起始、可跨月。
 * 跨多日事项从 event_date 到 due_date 逐格连续染色；同格内纵向均分铺满。
 */
import { esc, toDateString, addDays, ownerLabel, ownerNames } from './util.js';

export const GRID_SIZE = 42;
/** 同格最多画 4 个色块；超过则画前 3 个 + 一条「+N」 */
const MAX_BLOCKS = 4;

export function buildGrid(anchor, today) {
  const first = new Date(anchor.year, anchor.month - 1, 1);
  // JS 的 getDay() 以周日为 0；转成「周一为首」的偏移
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(anchor.year, anchor.month - 1, 1 - offset);

  const cells = [];
  for (let i = 0; i < GRID_SIZE; i += 1) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const date = toDateString(d);
    cells.push({
      date,
      day: d.getDate(),
      inMonth: d.getMonth() === anchor.month - 1,
      isToday: date === today,
      items: [],
    });
  }
  return cells;
}

/** 把事项铺到它覆盖的每一格上。相邻月的格子照常渲染。 */
export function assignItems(cells, items) {
  const byDate = new Map(cells.map((c) => [c.date, c]));
  const gridStart = cells[0].date;
  const gridEnd = cells[cells.length - 1].date;

  for (const item of items) {
    const from = item.event_date > gridStart ? item.event_date : gridStart;
    const to = item.due_date < gridEnd ? item.due_date : gridEnd;
    if (to < from) continue;
    let cur = from;
    // 区间已被 42 格裁剪，循环次数有上界
    for (;;) {
      const cell = byDate.get(cur);
      if (cell) cell.items.push(item);
      if (cur === to) break;
      cur = addDays(cur, 1);
    }
  }

  for (const cell of cells) {
    // 同格排序：先起始日期，再标题 —— 跨多日事项在每个格子里位置一致
    cell.items.sort((a, b) => {
      if (a.event_date !== b.event_date) return a.event_date < b.event_date ? -1 : 1;
      return String(a.title).localeCompare(String(b.title), 'zh');
    });
  }
  return cells;
}

function blockHtml(item, palette) {
  const color = palette[item.color] || '#e5e7eb';
  const tip = [
    `${ownerNames(item)}: ${item.title}`,
    `${item.event_date} → ${item.due_date}`,
    item.tag || null,
    item.progress ? `进展：${item.progress}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return `<button type="button" class="cell-item" data-item-id="${item.id}"
    style="background:${color}"
    title="${esc(tip)}"
  >${esc(ownerLabel(item))}: ${esc(item.title)}</button>`;
}

export function gridHtml(cells, palette) {
  const parts = [];
  for (const cell of cells) {
    const cls = ['cell'];
    if (!cell.inMonth) cls.push('out-month');
    if (cell.isToday) cls.push('is-today');

    const visible = cell.items.length > MAX_BLOCKS ? cell.items.slice(0, MAX_BLOCKS - 1) : cell.items;
    const hidden = cell.items.length - visible.length;

    let blocks = visible.map((it) => blockHtml(it, palette)).join('');
    if (hidden > 0) blocks += `<span class="cell-more">+${hidden} 项</span>`;

    parts.push(`<div class="${cls.join(' ')}" data-date="${cell.date}">
      <div class="cell-day"><span>${cell.day}</span>
        <button type="button" class="cell-add" data-add-date="${cell.date}" title="在这天新建事项">+</button>
      </div>
      <div class="cell-items">${blocks}</div>
    </div>`);
  }
  return parts.join('');
}
