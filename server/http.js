/**
 * HTTP 层的小工具：JSON 读写、错误响应、静态文件。
 * 只依赖 node:http / node:fs，不引入任何框架。
 */
import { createReadStream, statSync } from 'node:fs';
import { extname, normalize, join, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

export function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

/** 统一错误形状：{ error: { message, code? , fields? } } */
export function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { error: { message, ...extra } });
}

/**
 * 读取并解析 JSON 请求体。超过 limit 字节或不是合法 JSON 时抛错（带 status）。
 */
export async function readJson(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const err = new Error('请求体过大');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const err = new Error('请求体必须是 JSON 对象');
      err.status = 400;
      throw err;
    }
    return parsed;
  } catch (e) {
    if (e.status) throw e;
    const err = new Error('请求体不是合法 JSON');
    err.status = 400;
    throw err;
  }
}

/** 带状态码的业务错误。 */
export function httpError(status, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
}

/**
 * 静态文件服务。严格限制在 rootDir 内，防目录穿越。
 * 返回 true 表示已处理；false 表示文件不存在，交给调用方决定 404。
 */
export function serveStatic(res, rootDir, urlPath, req) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel.endsWith('/')) rel += 'index.html';
  // 归一化后必须仍位于 rootDir 之内
  const target = normalize(join(rootDir, rel));
  if (target !== rootDir && !target.startsWith(rootDir + sep)) return false;

  let stat;
  try {
    stat = statSync(target);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const headers = {
    'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
  };
  // 开发期不缓存，避免改前端后仍加载旧文件
  headers['Cache-Control'] = 'no-cache';

  if (req && req.method === 'HEAD') {
    res.writeHead(200, headers);
    res.end();
    return true;
  }

  res.writeHead(200, headers);
  createReadStream(target).pipe(res);
  return true;
}
