/**
 * 服务端入口：一个 node:http 服务，/api/* 走 JSON 接口，其余走 public/ 静态文件。
 */
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleApi } from './routes.js';
import { sendError, serveStatic } from './http.js';
import { ensureBootstrapAdmin } from './accounts.js';
import { purgeExpiredSessions } from './auth.js';
import { startHeartbeat } from './sse.js';
import { DB_PATH } from './db.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, '..', 'public');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

function localAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

const server = createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    sendError(res, 400, '非法请求路径');
    return;
  }

  try {
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, '只支持 GET 与 HEAD');
      return;
    }

    if (serveStatic(res, PUBLIC_DIR, url.pathname, req)) return;
    // 非 API 的未知路径回退到单页入口
    if (serveStatic(res, PUBLIC_DIR, '/index.html', req)) return;
    sendError(res, 404, '未找到');
  } catch (err) {
    if (res.headersSent) {
      res.end();
      return;
    }
    const status = Number(err && err.status) || 500;
    if (status >= 500) console.error('[error]', err);
    sendError(res, status, status >= 500 ? '服务器内部错误' : err.message, {
      ...(err && err.code ? { code: err.code } : {}),
      ...(err && err.fields ? { fields: err.fields } : {}),
    });
  }
});

// SSE 是长连接，必须关掉请求超时，否则 Node 会在默认 5 分钟后掐断
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 72_000;

const bootstrap = ensureBootstrapAdmin();
purgeExpiredSessions();
startHeartbeat();

// 每小时清理一次过期会话
const purgeTimer = setInterval(purgeExpiredSessions, 3_600_000);
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
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
