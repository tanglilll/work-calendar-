/**
 * PROTOTYPE —— 日历样式的四个变体，挑完就删。
 *
 * 挂在**真实页面**上（真实顶栏、真实侧栏、真实数据、真实密度），
 * 用 `?variant=A|B|C|D` 或底部浮动栏切换。四个变体在信息层级上不同，
 * 不是换配色：
 *
 *   A — 现状：42 格色块，块高在格内均分铺满，靠扫颜色找事
 *   B — 跨日甘特：周为一行，事项画成横跨多天的连续条，左侧周号栏，靠长度看工期
 *   C — 时间流：只列有事的日期，纵向按时间读，附月历缩略图定向
 *   D — 人×日矩阵：行是人、列是日，看谁哪天忙；此变体隐藏侧栏、占满宽度
 *
 * 生产闸门：本文件只存在于 prototype/calendar-styles 分支，不进 main，
 * 因此不需要额外的 NODE_ENV 判断——文件不存在即闸门生效。
 */
import { esc, addDays } from './util.js';
import { gridHtml } from './calendar.js';

export const VARIANTS = [
  { key: 'A', name: '现状 · 色块月网格' },
  { key: 'B', name: '跨日甘特 · 周行连续条' },
  { key: 'C', name: '时间流 · 只列有事的日期' },
  { key: 'D', name: '人 × 日 矩阵 · 看谁哪天忙' },
];

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

export function getVariant() {
  const raw = new URLSearchParams(location.search).get('variant');
  return VARIANTS.some((v) => v.key === raw) ? raw : 'A';
}

// ---------- 小工具 ----------

const colorOf = (item, palette) => palette[item.color] || '#e5e7eb';

function isoWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dow + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const fDow = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fDow + 3);
  return 1 + Math.round((date - firstThursday) / (7 * 86400000));
}

const md = (dateStr) => {
  const [, m, d] = dateStr.split('-');
  return `${Number(m)}/${Number(d)}`;
};

/** 事项在 42 格里的下标区间，越界裁剪到网格范围。 */
function spanOf(item, cells) {
  const first = cells[0].date;
  const last = cells[cells.length - 1].date;
  const from = item.event_date > first ? item.event_date : first;
  const to = item.due_date < last ? item.due_date : last;
  if (to < from) return null;
  const index = new Map(cells.map((c, i) => [c.date, i]));
  const start = index.get(from);
  const end = index.get(to);
  if (start === undefined || end === undefined) return null;
  return { start, end };
}

const tipText = (item) =>
  `${item.owner_name}: ${item.title}（${item.event_date} → ${item.due_date}${item.tag ? ' · ' + item.tag : ''}）`;

// ---------- 变体 A：现状 ----------

function renderA(ctx) {
  const { cells, palette } = ctx;
  return `<div class="weekdays">${WEEKDAYS.map((w) => `<span>${w}</span>`).join('')}</div>
    <div class="grid">${gridHtml(cells, palette)}</div>`;
}

// ---------- 变体 B：跨日甘特 ----------

const MAX_LANES = 5;

function renderB(ctx) {
  const { cells, items, palette } = ctx;
  const weeks = [];
  for (let w = 0; w < 6; w += 1) {
    const slice = cells.slice(w * 7, w * 7 + 7);
    const segments = [];
    for (const item of items) {
      const span = spanOf(item, cells);
      if (!span) continue;
      const from = Math.max(span.start, w * 7);
      const to = Math.min(span.end, w * 7 + 6);
      if (to < from) continue;
      segments.push({
        item,
        col: from - w * 7, // 0..6
        len: to - from + 1,
        openLeft: span.start < w * 7,
        openRight: span.end > w * 7 + 6,
      });
    }
    // 贪心分道：长条优先，放不下就下一道
    segments.sort((a, b) => b.len - a.len || a.col - b.col || a.item.title.localeCompare(b.item.title, 'zh'));
    const lanes = [];
    const placed = [];
    for (const seg of segments) {
      let lane = lanes.findIndex((occ) => !occ.some((s) => seg.col < s.col + s.len && s.col < seg.col + seg.len));
      if (lane === -1) {
        if (lanes.length >= MAX_LANES) continue;
        lanes.push([]);
        lane = lanes.length - 1;
      }
      lanes[lane].push(seg);
      placed.push({ ...seg, lane });
    }
    const hidden = segments.length - placed.length;
    weeks.push({ slice, placed, laneCount: Math.max(1, lanes.length), hidden, w });
  }

  const rows = weeks
    .map(({ slice, placed, laneCount, hidden, w }) => {
      const heads = slice
        .map((c, i) => {
          const cls = ['gt-day'];
          if (!c.inMonth) cls.push('out-month');
          if (c.isToday) cls.push('is-today');
          const dow = (w * 7 + i) % 7;
          return `<div class="${cls.join(' ')}" style="grid-column:${i + 1};grid-row:1">
            <span class="gt-dow">${WEEKDAYS[dow]}</span><span class="gt-num">${c.day}</span>
          </div>`;
        })
        .join('');
      const bars = placed
        .map(
          ({ item, col, len, openLeft, openRight, lane }) => {
            const cls = ['gt-bar'];
            if (openLeft) cls.push('open-left');
            if (openRight) cls.push('open-right');
            const label = len >= 2 ? `${esc(item.owner_name)}: ${esc(item.title)}` : esc(item.title);
            return `<div class="${cls.join(' ')}" style="grid-column:${col + 1} / span ${len};grid-row:${lane + 2};background:${colorOf(item, palette)}"
              title="${esc(tipText(item))}">${label}</div>`;
          },
        )
        .join('');
      const more = hidden > 0 ? `<div class="gt-more" style="grid-column:1 / span 7;grid-row:${laneCount + 2}">还有 ${hidden} 条未显示</div>` : '';
      return `<div class="gt-week">
        <div class="gt-gutter"><span class="gt-wnum">W${isoWeek(slice[0].date)}</span>
          <span class="gt-wrange">${md(slice[0].date)}–${md(slice[6].date)}</span></div>
        <div class="gt-grid" style="grid-template-rows: 30px repeat(${laneCount}, 24px)">${heads}${bars}${more}</div>
      </div>`;
    })
    .join('');

  return `<div class="gantt">${rows}</div>`;
}

// ---------- 变体 C：时间流 ----------

function renderC(ctx) {
  const { cells, palette, today } = ctx;
  const inMonth = cells.filter((c) => c.inMonth);
  const busy = inMonth.filter((c) => c.items.length > 0);

  const mini = `<div class="mini">
    <div class="mini-head">${ctx.anchor.year} 年 ${ctx.anchor.month} 月</div>
    <div class="mini-grid">
      ${WEEKDAYS.map((w) => `<span class="mini-dow">${w}</span>`).join('')}
      ${cells
        .map((c) => {
          const cls = ['mini-cell'];
          if (!c.inMonth) cls.push('out-month');
          if (c.isToday) cls.push('is-today');
          if (c.items.length) cls.push('has-items');
          return `<span class="${cls.join(' ')}"${c.items.length && c.inMonth ? ` data-jump="${c.date}"` : ''}>${c.day}</span>`;
        })
        .join('')}
    </div>
    <div class="mini-legend">有安排的日子带点，点一下跳到下面</div>
  </div>`;

  if (!busy.length) {
    return `<div class="stream-wrap">${mini}<div class="stream"><p class="stream-empty">本月还没有安排。</p></div></div>`;
  }

  const sections = busy
    .map((cell) => {
      const rows = cell.items
        .map((item) => {
          const days = Math.round((new Date(item.due_date) - new Date(item.event_date)) / 86400000) + 1;
          const rel = item.due_date < today ? 'overdue' : item.due_date === today ? 'due-today' : '';
          return `<div class="stream-row ${rel}" style="--c:${colorOf(item, palette)}">
            <span class="sr-title">${esc(item.title)}</span>
            <span class="sr-owner">${esc(item.owner_name)}</span>
            <span class="sr-dates">${md(item.event_date)}${days > 1 ? ` → ${md(item.due_date)} · ${days} 天` : ''}</span>
            ${item.tag ? `<span class="tag-chip">${esc(item.tag)}</span>` : ''}
          </div>`;
        })
        .join('');
      const isToday = cell.date === today;
      const past = cell.date < today;
      return `<section class="stream-day ${isToday ? 'is-today' : ''} ${past ? 'is-past' : ''}" data-date="${cell.date}">
        <h3><span class="sd-date">${md(cell.date)}</span>
          <span class="sd-dow">${WEEKDAYS[(new Date(cell.date).getDay() + 6) % 7]}</span>
          ${isToday ? '<span class="sd-badge">今天</span>' : ''}
          <span class="sd-count">${cell.items.length} 项</span></h3>
        <div class="stream-rows">${rows}</div>
      </section>`;
    })
    .join('');

  return `<div class="stream-wrap">${mini}<div class="stream">${sections}</div></div>`;
}

// ---------- 变体 D：人 × 日 矩阵 ----------

function renderD(ctx) {
  const { cells, palette, today } = ctx;
  const inMonth = cells.filter((c) => c.inMonth);
  const owners = [];
  const seen = new Map();
  for (const item of ctx.items) {
    if (!seen.has(item.owner_id)) {
      seen.set(item.owner_id, { id: item.owner_id, name: item.owner_name, items: [] });
      owners.push(seen.get(item.owner_id));
    }
    seen.get(item.owner_id).items.push(item);
  }
  owners.sort((a, b) => a.name.localeCompare(b.name, 'zh'));

  const cols = `112px repeat(${inMonth.length}, minmax(0, 1fr))`;

  const head = `<div class="mx-head" style="grid-template-columns:${cols}">
      <div class="mx-corner">owner</div>
      ${inMonth
        .map((c) => {
          const dow = (new Date(c.date).getDay() + 6) % 7;
          const cls = ['mx-day'];
          if (dow >= 5) cls.push('weekend');
          if (c.isToday) cls.push('is-today');
          return `<div class="${cls.join(' ')}" title="${c.date}"><span>${c.day}</span><em>${WEEKDAYS[dow]}</em></div>`;
        })
        .join('')}
    </div>`;

  const rows = owners
    .map((owner) => {
      const perDay = new Map(inMonth.map((c) => [c.date, []]));
      for (const item of owner.items) {
        const span = spanOf(item, cells);
        if (!span) continue;
        for (let i = span.start; i <= span.end; i += 1) {
          const list = perDay.get(cells[i].date);
          if (list) list.push(item);
        }
      }
      const totalInMonth = [...perDay.values()].reduce((n, l) => n + l.length, 0);
      const cellsHtml = inMonth
        .map((c) => {
          const list = perDay.get(c.date) || [];
          const dow = (new Date(c.date).getDay() + 6) % 7;
          const cls = ['mx-cell'];
          if (dow >= 5) cls.push('weekend');
          if (c.isToday) cls.push('is-today');
          if (!list.length) return `<div class="${cls.join(' ')}"></div>`;
          const marks = list.slice(0, 3).map((it) => `<i style="background:${colorOf(it, palette)}"></i>`).join('');
          const extra = list.length > 3 ? `<b>+${list.length - 3}</b>` : '';
          return `<div class="${cls.join(' ')} has-items" title="${esc(list.map((it) => it.title).join('、'))}">${marks}${extra}</div>`;
        })
        .join('');
      return `<div class="mx-row" style="grid-template-columns:${cols}">
        <div class="mx-name">${esc(owner.name)}<span class="mx-total">${totalInMonth} 条次</span></div>
        ${cellsHtml}
      </div>`;
    })
    .join('');

  const legend = `<p class="mx-legend">每格最多画 3 条竖标（颜色 = 事项颜色），多出的显示 +N。悬停看标题。周末列已压暗，今天列高亮。</p>`;
  return `<div class="matrix">${head}${rows}${legend}</div>`;
}

// ---------- 渲染入口 ----------

export function renderCalendar(ctx) {
  const wrap = document.querySelector('.calendar-wrap');
  if (!wrap) return;
  const variant = getVariant();
  document.body.dataset.variant = variant;

  let html;
  if (variant === 'B') html = renderB(ctx);
  else if (variant === 'C') html = renderC(ctx);
  else if (variant === 'D') html = renderD(ctx);
  else html = renderA(ctx);

  wrap.innerHTML = html;

  if (variant === 'C') {
    wrap.querySelectorAll('.mini-cell[data-jump]').forEach((el) => {
      el.addEventListener('click', () => {
        wrap.querySelector(`.stream-day[data-date="${el.dataset.jump}"]`)?.scrollIntoView({ block: 'start' });
      });
    });
  }
}

// ---------- 底部浮动切换栏 ----------

export function mountSwitcher({ onChange }) {
  if (document.getElementById('proto-switcher')) return;

  const bar = document.createElement('div');
  bar.id = 'proto-switcher';
  bar.className = 'proto-switcher';
  bar.innerHTML = `<button type="button" data-dir="-1" title="上一个（←）">‹</button>
    <span class="proto-label"></span>
    <button type="button" data-dir="1" title="下一个（→）">›</button>`;
  document.body.appendChild(bar);

  const label = bar.querySelector('.proto-label');
  const paint = () => {
    const current = VARIANTS.find((v) => v.key === getVariant());
    label.textContent = `${current.key} — ${current.name}`;
  };

  const go = (delta) => {
    const i = VARIANTS.findIndex((v) => v.key === getVariant());
    const next = VARIANTS[(i + delta + VARIANTS.length) % VARIANTS.length];
    const url = new URL(location.href);
    url.searchParams.set('variant', next.key);
    history.replaceState(null, '', url);
    paint();
    onChange();
  };

  bar.addEventListener('click', (ev) => {
    const dir = ev.target.closest('[data-dir]')?.dataset.dir;
    if (dir) go(Number(dir));
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    ev.preventDefault();
    go(ev.key === 'ArrowLeft' ? -1 : 1);
  });

  paint();
}

// ---------- 样式：由本模块自己注入，生产 CSS 一行不动 ----------

const CSS = `
.proto-switcher {
  position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 10px; z-index: 999;
  background: #111827; color: #fff; border-radius: 999px; padding: 6px 8px;
  box-shadow: 0 12px 32px rgba(0,0,0,.32); font-size: 13px; border: 1px solid #000;
}
.proto-switcher button {
  background: transparent; border: none; color: #fff; font-size: 18px; line-height: 1;
  padding: 2px 10px; cursor: pointer; border-radius: 999px;
}
.proto-switcher button:hover { background: rgba(255,255,255,.16); }
.proto-label { min-width: 210px; text-align: center; letter-spacing: .2px; }

/* ---------- B：跨日甘特 ---------- */
.gantt { display: grid; }
.gt-week { display: grid; grid-template-columns: 74px minmax(0, 1fr); border-bottom: 1px solid var(--line-soft); }
.gt-week:last-child { border-bottom: none; }
.gt-gutter {
  border-right: 1px solid var(--line); background: #fafbfd; padding: 6px 8px;
  display: flex; flex-direction: column; gap: 2px; justify-content: flex-start;
}
.gt-wnum { font-weight: 700; font-size: 12px; color: var(--muted); }
.gt-wrange { font-size: 10px; color: #9aa4b2; }
.gt-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); }
.gt-day {
  display: flex; align-items: baseline; gap: 4px; padding: 5px 6px 3px;
  font-size: 12px; color: var(--muted); border-right: 1px solid var(--line-soft);
}
.gt-day:nth-child(7n) { border-right: none; }
.gt-dow { font-size: 10px; color: #9aa4b2; }
.gt-num { font-size: 13px; font-weight: 600; color: var(--text); }
.gt-day.out-month .gt-num { color: #b6bec9; font-weight: 400; }
.gt-day.is-today .gt-num { color: var(--accent); }
.gt-bar {
  margin: 0 2px 2px; border-radius: 4px; font-size: 11px; line-height: 22px;
  padding: 0 6px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  border: 1px solid rgba(0,0,0,.09); cursor: default;
}
.gt-bar.open-left { border-top-left-radius: 0; border-bottom-left-radius: 0; border-left-style: dashed; }
.gt-bar.open-right { border-top-right-radius: 0; border-bottom-right-radius: 0; border-right-style: dashed; }
.gt-more { font-size: 11px; color: var(--muted); padding: 1px 8px; }

/* ---------- C：时间流 ---------- */
.stream-wrap { display: grid; grid-template-columns: 208px minmax(0, 1fr); align-items: start; }
.mini { padding: 12px; border-right: 1px solid var(--line-soft); position: sticky; top: 0; }
.mini-head { font-weight: 600; font-size: 13px; margin-bottom: 8px; }
.mini-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; text-align: center; }
.mini-dow { font-size: 10px; color: #9aa4b2; padding-bottom: 2px; }
.mini-cell {
  font-size: 11px; color: var(--muted); border-radius: 5px; padding: 3px 0; position: relative;
}
.mini-cell.out-month { color: #d3d9e1; }
.mini-cell.has-items { color: var(--text); font-weight: 600; cursor: pointer; }
.mini-cell.has-items::after {
  content: ''; position: absolute; left: 50%; bottom: 1px; transform: translateX(-50%);
  width: 4px; height: 4px; border-radius: 50%; background: var(--accent);
}
.mini-cell.has-items:hover { background: var(--accent-soft); }
.mini-cell.is-today { background: var(--accent); color: #fff; }
.mini-cell.is-today::after { background: #fff; }
.mini-legend { margin-top: 10px; font-size: 11px; color: var(--muted); line-height: 1.5; }
.stream { padding: 4px 0 8px; max-height: 74vh; overflow: auto; }
.stream-empty { color: var(--muted); font-size: 13px; padding: 16px; }
.stream-day { padding: 8px 14px 12px; border-bottom: 1px solid var(--line-soft); }
.stream-day h3 {
  margin: 0 0 6px; font-size: 13px; display: flex; align-items: center; gap: 8px;
  position: sticky; top: 0; background: var(--panel); padding: 4px 0;
}
.sd-date { font-weight: 700; }
.sd-dow { color: var(--muted); font-weight: 400; }
.sd-badge { background: var(--accent); color: #fff; border-radius: 8px; padding: 0 7px; font-size: 11px; }
.sd-count { margin-left: auto; font-size: 11px; color: var(--muted); font-weight: 400; }
.stream-day.is-past h3 { opacity: .6; }
.stream-rows { display: grid; gap: 4px; }
.stream-row {
  display: grid; grid-template-columns: minmax(0,1fr) auto auto auto; align-items: center; gap: 10px;
  padding: 6px 10px; border-radius: 6px; border-left: 4px solid var(--c); background: #fafbfd;
}
.stream-row.overdue { background: var(--danger-soft); }
.stream-row.overdue .sr-title { color: var(--danger); font-weight: 600; }
.stream-row.due-today { background: var(--warn-soft); }
.stream-row.due-today .sr-title { color: var(--warn); }
.sr-title { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sr-owner { font-size: 11px; color: var(--muted); }
.sr-dates { font-size: 11px; color: var(--muted); }

/* ---------- D：人 × 日 矩阵 ---------- */
body[data-variant="D"] .layout { grid-template-columns: minmax(0, 1fr); }
body[data-variant="D"] .sidebar { display: none; }
.matrix { padding: 12px; }
.mx-head, .mx-row { display: grid; }
.mx-head { border-bottom: 1px solid var(--line); }
.mx-corner, .mx-day, .mx-name, .mx-cell { border-right: 1px solid var(--line-soft); }
.mx-corner { font-size: 11px; color: var(--muted); padding: 4px 8px 6px; }
.mx-day {
  text-align: center; padding: 4px 0 6px; font-size: 11px; color: var(--muted);
  display: flex; flex-direction: column; align-items: center; line-height: 1.2;
}
.mx-day em { font-style: normal; font-size: 9px; color: #b6bec9; }
.mx-day.weekend { background: #f7f9fc; }
.mx-day.is-today { background: var(--accent); color: #fff; border-radius: 6px 6px 0 0; }
.mx-day.is-today em { color: rgba(255,255,255,.8); }
.mx-row { border-bottom: 1px solid var(--line-soft); }
.mx-name {
  font-size: 12px; padding: 8px 10px; display: flex; flex-direction: column; gap: 2px;
  font-weight: 600; background: #fafbfd;
}
.mx-total { font-size: 10px; color: var(--muted); font-weight: 400; }
.mx-cell {
  min-height: 40px; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 2px; padding: 3px 0;
}
.mx-cell.weekend { background: #f7f9fc; }
.mx-cell.is-today { background: var(--accent-soft); }
.mx-cell i { display: block; width: 60%; height: 5px; border-radius: 2px; }
.mx-cell b { font-size: 9px; color: var(--muted); font-weight: 600; }
.mx-legend { font-size: 11px; color: var(--muted); margin: 10px 0 0; }
`;

if (!document.getElementById('proto-calendar-styles')) {
  const style = document.createElement('style');
  style.id = 'proto-calendar-styles';
  style.textContent = CSS;
  document.head.appendChild(style);
}
