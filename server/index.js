/**
 * 服务端入口：一个 node:http 服务，/api/* 走 JSON 接口，其余走 public/ 静态文件。
 *
 * 这里是唯一读环境变量的地方：数据库路径、端口、初始 admin 都从这里传进
 * 组合根与领域 module，它们自己不碰 process.env。
 *
 * 只有被当作入口直接运行（node server/index.js）时才启动 —— 判据用
 * import.meta.main 守着。这样测试可以 import 这里的错误映射与请求处理函数
 * （errorResponse / createRequestHandler），而不开端口、不碰数据库。
 */
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from './app.js';
import { sendError, serveStatic } from './http.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, '..', 'public');

/**
 * 错误 → 响应 的唯一映射点。
 *
 * 规则（收紧过的那条）：带整数 status 的才是我们自己抛的业务错误，可以如实回报；
 * 只有业务错误才带 code / fields；status >= 500 一律只说「服务器内部错误」，
 * 存储层与运行时的错误码、字段细节都不外泄。
 * 独立成纯函数是为了可测：这段逻辑原先埋在 createServer 的回调里，测试只能
 * 自己抄一份，规则就没有回归网。
 */
export function errorResponse(err) {
  const status = Number(err && err.status) || 500;
  const isBusinessError = Number.isInteger(err && err.status) && status < 500;
  return {
    status,
    message: isBusinessError ? err.message : '服务器内部错误',
    extra: {
      ...(isBusinessError && err.code ? { code: err.code } : {}),
      ...(isBusinessError && err.fields ? { fields: err.fields } : {}),
    },
  };
}

/** 入口的请求处理：/api/* 交给组合根，其余走静态文件。 */
export function createRequestHandler({ app, publicDir }) {
  return async function handleRequest(req, res) {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      sendError(res, 400, '非法请求路径');
      return;
    }

    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        await app.handleApi(req, res, url);
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendError(res, 405, '只支持 GET 与 HEAD');
        return;
      }

      if (serveStatic(res, publicDir, url.pathname, req)) return;
      // 非 API 的未知路径回退到单页入口
      if (serveStatic(res, publicDir, '/index.html', req)) return;
      sendError(res, 404, '未找到');
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const { status, message, extra } = errorResponse(err);
      if (status >= 500) console.error('[error]', err);
      sendError(res, status, message, extra);
    }
  };
}

function localAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

function main() {
  const PORT = Number(process.env.PORT || 3000);
  const HOST = process.env.HOST || '0.0.0.0';
  const DB_PATH = process.env.RILI_DB || join(HERE, '..', 'data', 'rili.db');

  const app = createApp({ dbPath: DB_PATH });
  const server = createServer(createRequestHandler({ app, publicDir: PUBLIC_DIR }));

  // SSE 是长连接，必须关掉请求超时，否则 Node 会在默认 5 分钟后掐断
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 72_000;

  const bootstrap = app.accounts.ensureBootstrapAdmin({
    username: process.env.RILI_ADMIN_USER,
    password: process.env.RILI_ADMIN_PASSWORD,
  });
  app.sessions.purgeExpiredSessions();
  // 心跳由入口层用中枢起：中枢是实例状态，不由模块自己启动
  app.sse.startHeartbeat();

  // 每小时清理一次过期会话
  const purgeTimer = setInterval(() => app.sessions.purgeExpiredSessions(), 3_600_000);
  purgeTimer.unref();

  server.listen(PORT, HOST, () => {
    const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
    console.log(`rili 已启动：http://${shown}:${PORT}`);
    for (const addr of localAddresses()) {
      console.log(`  局域网访问：http://${addr}:${PORT}`);
    }
    console.log(`  数据库：${DB_PATH}`);

    if (bootstrap.state === 'created') {
      console.log(`  已创建初始 admin 账号：${bootstrap.username}`);
    } else if (bootstrap.state === 'no-password') {
      console.log('');
      console.log('  ⚠ 账号表为空，且未设置 RILI_ADMIN_PASSWORD，因此没有创建任何账号。');
      console.log('    没有账号就没人能批准注册申请，系统会卡死。请这样启动：');
      console.log(`      RILI_ADMIN_USER=${bootstrap.username} RILI_ADMIN_PASSWORD=<至少8位的密码> npm start`);
    } else if (bootstrap.state === 'bad-username' || bootstrap.state === 'bad-password') {
      console.log(`  ⚠ 无法创建初始 admin：${bootstrap.message}`);
    }
  });

  function shutdown(signal) {
    console.log(`\n收到 ${signal}，正在关闭…`);
    app.sse.closeAll(); // 长连接不关，server.close 等不到所有人
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (import.meta.main) main();
