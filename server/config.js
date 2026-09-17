/**
 * 全局常量与纯工具函数。这里不放任何 I/O 或状态。
 */

/** 角色，逐级包含。管理器 = manager + admin。 */
export const ROLES = ['user', 'manager', 'admin'];

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

/** 标签白名单。事项最多挂一个，且必须取自这里。 */
export const TAGS = ['工作', '个人', '会议', '出差', '紧急'];

export const LIMITS = {
  TITLE_MAX: 200,
  NOTE_MAX: 500,
  USERNAME_MIN: 3,
  USERNAME_MAX: 32,
  PASSWORD_MIN: 8,
  PASSWORD_MAX: 200,
  /** 会话 30 天滑动过期 */
  SESSION_TTL_DAYS: 30,
  /** 归档视图单页条数 */
  ARCHIVE_PAGE_SIZE: 200,
};

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

/** 把 Date 按本地时区格式化为 yyyy-mm-dd。 */
export function toDateString(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** yyyy-mm-dd -> 本地零点的 Date。 */
export function parseDateString(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(dateString, n) {
  const d = parseDateString(dateString);
  d.setDate(d.getDate() + n);
  return toDateString(d);
}

export function isManager(role) {
  return role === 'manager' || role === 'admin';
}

export function isTagAllowed(tag) {
  return tag === null || tag === undefined || tag === '' || TAGS.includes(tag);
}
