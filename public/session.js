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
 * 容易顺手写错的另一处是登录接口：密码错也是 401，但那是凭据错误，不是会话失效——
 * 无差别按 401 处理，会在每次输错密码时清空状态、并顶掉「用户名或密码不正确」那句提示。
 * 哪些端点豁免因此**不能散在请求层的每个方法上**（漏标一个，它的凭据错误就会被当成会话失效）；
 * 清单与判据同住这里，api.js 只按路径问一次。
 *
 * 这里只回答「是不是会话失效」以及「失效了该说什么」；真正的收尾（关对话框、清状态、
 * 回登录页）由应用层注册的处理器做——请求层不碰 DOM。
 */
export const SESSION_EXPIRED_MESSAGE = '登录已失效，请重新登录';

/**
 * 公开端点：未登录也能调，它们回 401 时是凭据错误而不是会话失效。
 * 新增公开端点只改这一份清单——少写一条，凭据错误就会触发会话收尾；
 * 多写一条，真正的会话失效会被放过。两个方向都由 test/contracts.test.js 拿真路由核对。
 */
export const PUBLIC_ENDPOINTS = Object.freeze([
  '/api/bootstrap', // 启动探测：未登录也要能问「我是谁」
  '/api/login', // 登录：密码错就是 401，但那是凭据错误
  '/api/logout', // 登出：没有会话时也要能调
  '/api/register-request', // 注册申请：还没账号的人本来就该能提交
]);

/** 这个状态码是否意味着会话已失效。 */
export function isSessionExpired(status) {
  return status === 401;
}

/** 这个路径是否豁免会话失效判定。 */
export function isPublicEndpoint(path) {
  return PUBLIC_ENDPOINTS.includes(path);
}

/**
 * 请求层的判据：这个响应是否意味着「服务端已经结束了这次会话」。
 * 豁免就长在判据里，调用点没有「记得传 flag」的机会。
 */
export function shouldEndSession(status, path) {
  return isSessionExpired(status) && !isPublicEndpoint(path);
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
