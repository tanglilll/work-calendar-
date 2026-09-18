/**
 * 会话失效：判据、文案与收尾钩子只有这一处。
 *
 * 服务端在「需要登录的接口没拿到有效会话」时统一回 401（server/routes.js 的
 * requireAccount）。这个响应意味着服务端已经结束了这次会话，前端要跟着回登录页。
 *
 * 边界只有一条：**只有 401 成立**。403 是「无权处置他人的事项」（人还正常登录着）、
 * 409 是版本冲突、400 是字段错误、5xx 与没有状态码的网络错误是别的问题——把它们当成
 * 会话失效，会把一个正常使用中的人莫名踢回登录页。边界由 test/session.test.js 钉住。
 *
 * 容易顺手写错的另一处是登录接口：密码错也是 401，但那是凭据错误。请求层因此把
 * 启动探测、登录与注册申请标为公开接口，不参与这里的判定（见 api.js）。
 *
 * 这里只回答「是不是会话失效」以及「失效了该说什么」；真正的收尾（关对话框、清状态、
 * 回登录页）由应用层注册的处理器做——请求层不碰 DOM。
 */
export const SESSION_EXPIRED_MESSAGE = '登录已失效，请重新登录';

/** 这个状态码是否意味着会话已失效。 */
export function isSessionExpired(status) {
  return status === 401;
}

let handler = null;

/** 应用层注册收尾动作；后注册的替换先前的。 */
export function setSessionExpiredHandler(fn) {
  handler = fn;
}

/** 请求层发现会话失效时调用。没有注册处理器时安静跳过。 */
export function notifySessionExpired() {
  if (handler) handler();
}
