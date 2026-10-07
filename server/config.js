/**
 * 全局常量与纯工具函数。这里不放任何 I/O 或状态。
 * 角色词表与「谁能看见什么」的规则在 visibility.js，不在这里。
 */

/**
 * 12 色调色板。色相每 30° 一档，亮度统一在 70%–79%，
 * 保证深色文字压在色块上仍然可读。颜色只以索引（0–11）落库。
 */
export const PALETTE = [
  'hsl(0 68% 74%)', // 红
  'hsl(30 70% 74%)', // 橙
  'hsl(45 68% 73%)', // 琥珀
  'hsl(70 48% 72%)', // 黄绿
  'hsl(120 42% 74%)', // 绿
  'hsl(155 45% 72%)', // 青绿
  'hsl(180 48% 73%)', // 青
  'hsl(205 60% 76%)', // 天蓝
  'hsl(230 55% 79%)', // 蓝
  'hsl(265 48% 80%)', // 紫
  'hsl(300 45% 79%)', // 品红
  'hsl(330 55% 79%)', // 玫红
];

/**
 * 标签白名单。事项最多挂一个，且必须取自这里。
 *
 * 「紧急」在 2026-10-07 按用户要求停用：紧急与否已经由「紧急重要度」那张四象限表表达，
 * 再留一个同名的标签只会让人在两处做同一件事。**存量事项上已经写着的「紧急」不迁移、
 * 不抹掉**——宽限写在 server/items.js 的 tag.parse 里（只放行「本来就是它」的那一条），
 * 编辑框把它显示成「紧急（已停用）」，用户自己决定要不要清掉。
 */
export const TAGS = ['工作', '个人', '会议', '出差'];

/**
 * 紧急重要度白名单。事项最多挂一个，且必须取自这里；
 * **顺序即展示顺序**——前端的分组、筛选下拉与事项对话框的选项都按这个次序排，不要另行排序。
 *
 * 这个次序是产品定的优先级（用户 2026-10-07 指定）：要做的、要立刻分出去的、
 * 要排期的、可以放着的。它不是四象限的教科书顺序（教科书是「重要不紧急」在「紧急但不重要」之前），
 * 改这里就等于改全站顺序，改之前先确认。每个取值对应的颜色在 public/tableview.js 的
 * QUADRANT_CLASS 里，与顺序无关——按值配，所以调整次序不会串色。
 */
export const QUADRANTS = ['重要且紧急', '紧急但不重要', '重要不紧急', '不紧急不重要'];

export const LIMITS = {
  TITLE_MAX: 200,
  /** 进展是一段自由文本，覆盖式更新 */
  PROGRESS_MAX: 500,
  NOTE_MAX: 500,
  USERNAME_MIN: 3,
  USERNAME_MAX: 32,
  PASSWORD_MIN: 8,
  PASSWORD_MAX: 200,
  /** 会话 30 天滑动过期 */
  SESSION_TTL_DAYS: 30,
  /** 归档视图单页条数 */
  ARCHIVE_PAGE_SIZE: 200,
  /** 完成度是 0–100 的整数 */
  PERCENT_DONE_MIN: 0,
  PERCENT_DONE_MAX: 100,
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 判断 yyyy-mm-dd 是否为真实存在的日历日（2026-02-30 不合法）。 */
export function isValidDateString(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** 服务器本地日期，作为全团队统一的「今天」。 */
export function todayLocal() {
  return toDateString(new Date());
}

/** 把 Date 按本地时区格式化为 yyyy-mm-dd。仅本模块内部使用。 */
function toDateString(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function isTagAllowed(tag) {
  return tag === null || tag === undefined || tag === '' || TAGS.includes(tag);
}

/** 与 isTagAllowed 同形：空值与白名单里的字面量放行，其余拒绝。 */
export function isQuadrantAllowed(quadrant) {
  return quadrant === null || quadrant === undefined || quadrant === '' || QUADRANTS.includes(quadrant);
}
