/**
 * 登录限速：每 IP 每窗口最多 N 次尝试。
 *
 * 工厂而非模块级单例，时钟也可注入——这样「窗口到期后重新计数」不必真的等 60 秒。
 */
import { httpError } from './http.js';

export function createLoginRateLimiter({ max = 10, windowMs = 60_000, now = Date.now } = {}) {
  const attempts = new Map();

  return function check(ip) {
    const t = now();
    const rec = attempts.get(ip);
    if (!rec || t > rec.resetAt) {
      attempts.set(ip, { count: 1, resetAt: t + windowMs });
      return;
    }
    rec.count += 1;
    if (rec.count > max) throw httpError(429, '登录尝试过于频繁，请稍后再试');
  };
}
