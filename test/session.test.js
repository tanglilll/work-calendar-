/**
 * 会话失效的判据与接线。
 *
 * 服务端在「需要登录的接口上没拿到有效会话」时统一回 401（server/routes.js 的
 * requireAccount）。前端据此结束本地会话。判据是纯函数，边界在这里钉死——**只有
 * 401 成立**：403 是「无权处置他人的事项」（人还正常登录着）、409 是版本冲突、
 * 400 是字段错误、5xx 与没有状态码的网络错误是别的问题。把那些当成会话失效，
 * 会把一个正常使用中的人莫名踢回登录页。
 *
 * 「请求层真的会调用判据、并把收尾交给应用层注册的处理器」也在这一层验：用替身
 * 接替全局 fetch，不需要浏览器，也不碰网络。
 *
 * 登录接口是最容易被顺手写错的一处：密码错也是 401，但那是凭据错误，不是会话失效。
 * 无差别地按 401 处理，会在每次输错密码时清空状态、并顶掉「用户名或密码不正确」那句
 * 提示，所以下面单独有一条把它钉住。
 */
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { SESSION_EXPIRED_MESSAGE, isSessionExpired, setSessionExpiredHandler } from '../public/session.js';
import { api } from '../public/api.js';

const realFetch = globalThis.fetch;

/** 替身 fetch：只关心状态码与响应体。 */
function stubFetch(status, payload) {
  globalThis.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return payload === undefined ? '' : JSON.stringify(payload);
    },
  });
}

/** 记下「会话失效收尾」被转交了没有。 */
function captureSessionEnd() {
  const ended = [];
  setSessionExpiredHandler(() => ended.push('session-ended'));
  return ended;
}

describe('isSessionExpired：会话失效的唯一判据', () => {
  test('401 意味着会话已失效', () => {
    assert.equal(isSessionExpired(401), true);
  });

  test('403 不是会话失效：那是「无权处置他人的事项」，人还正常登录着', () => {
    assert.equal(isSessionExpired(403), false);
  });

  test('字段错误 / 不存在 / 版本冲突 / 服务端故障 / 网络错误都不是会话失效', () => {
    const notExpired = [
      [400, '字段错误'],
      [404, '事项或接口不存在'],
      [409, '版本冲突'],
      [500, '服务端故障'],
      [503, '服务端故障'],
      [undefined, '网络错误（没有状态码）'],
      [null, '没有状态码'],
    ];
    for (const [status, why] of notExpired) {
      assert.equal(isSessionExpired(status), false, `${why}（${status}）不该被当成会话失效`);
    }
  });
});

describe('请求层的接线', () => {
  beforeEach(() => setSessionExpiredHandler(null));
  after(() => {
    globalThis.fetch = realFetch;
  });

  test('需要登录的接口回 401：转交处理器，提示说清是登录已失效', async () => {
    const ended = captureSessionEnd();
    stubFetch(401, { error: { message: '请先登录' } });

    await assert.rejects(api.listItems(), (err) => {
      assert.equal(err.status, 401);
      assert.equal(err.message, SESSION_EXPIRED_MESSAGE);
      return true;
    });
    assert.deepEqual(ended, ['session-ended'], '401 应当恰好转交一次收尾');
  });

  test('403 / 409 / 5xx：不转交处理器，错误原样交给调用点', async () => {
    const cases = [
      [403, '无权处置他人的事项'],
      [409, '此事项已被他人修改，请刷新后重试'],
      [500, '服务器内部错误'],
    ];
    for (const [status, message] of cases) {
      const ended = captureSessionEnd();
      stubFetch(status, { error: { message } });

      await assert.rejects(api.listItems(), (err) => {
        assert.equal(err.status, status);
        assert.equal(err.message, message);
        return true;
      });
      assert.deepEqual(ended, [], `${status} 不该被当成会话失效`);
    }
  });

  test('登录失败也是 401，但那是凭据错误：不转交处理器，提示仍是服务端那句', async () => {
    const ended = captureSessionEnd();
    stubFetch(401, { error: { message: '用户名或密码不正确' } });

    await assert.rejects(api.login('zhao', '错的密码'), (err) => {
      assert.equal(err.status, 401);
      assert.equal(err.message, '用户名或密码不正确');
      return true;
    });
    assert.deepEqual(ended, [], '登录失败不是会话失效，否则登录页会被顶成「登录已失效」');
  });

  test('未登录时的启动探测照常返回：200 不会误判', async () => {
    const ended = captureSessionEnd();
    stubFetch(200, { authenticated: false, account: null, capabilities: {} });

    const boot = await api.bootstrap();
    assert.equal(boot.authenticated, false);
    assert.deepEqual(ended, []);
  });
});
