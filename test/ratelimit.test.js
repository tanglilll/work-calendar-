/**
 * 登录限速。时钟注入，所以窗口过期不用真的等。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createLoginRateLimiter } from '../server/ratelimit.js';

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('登录限速', () => {
  test('窗口内允许 max 次，第 max+1 次拒绝', () => {
    const clock = fakeClock();
    const check = createLoginRateLimiter({ max: 3, windowMs: 1000, now: clock.now });
    check('1.2.3.4');
    check('1.2.3.4');
    check('1.2.3.4');
    assert.throws(() => check('1.2.3.4'), (err) => err.status === 429);
  });

  test('窗口过期后重新计数', () => {
    const clock = fakeClock();
    const check = createLoginRateLimiter({ max: 2, windowMs: 1000, now: clock.now });
    check('1.2.3.4');
    check('1.2.3.4');
    assert.throws(() => check('1.2.3.4'), (err) => err.status === 429);

    clock.advance(1001);
    check('1.2.3.4');
    check('1.2.3.4');
    assert.throws(() => check('1.2.3.4'), (err) => err.status === 429);
  });

  test('不同 IP 各自独立计数', () => {
    const clock = fakeClock();
    const check = createLoginRateLimiter({ max: 1, windowMs: 1000, now: clock.now });
    check('1.1.1.1');
    check('2.2.2.2');
    assert.throws(() => check('1.1.1.1'), (err) => err.status === 429);
  });

  test('两个限速器互不共享状态', () => {
    const clock = fakeClock();
    const a = createLoginRateLimiter({ max: 1, windowMs: 1000, now: clock.now });
    const b = createLoginRateLimiter({ max: 1, windowMs: 1000, now: clock.now });
    a('1.1.1.1');
    b('1.1.1.1');
    assert.throws(() => a('1.1.1.1'), (err) => err.status === 429);
  });
});
