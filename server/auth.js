/**
 * 密码哈希与会话。
 *
 * 上半部分（哈希、Cookie 解析）是纯函数，不需要数据库；
 * 下半部分的会话读写由 createSessions(store) 提供——store 由组合根注入。
 * 密码用 Node 内置 scrypt 加盐哈希存储，任何地方都不保存明文；
 * 注册申请表里存的也已经是哈希。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { LIMITS } from './config.js';
import { accountChanged } from './sse.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const COOKIE_NAME = 'rili_session';
const DAY_MS = 86400000;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('hex'), hash.toString('hex')].join('$');
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(password, salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function parseCookies(req) {
  const header = req.headers.cookie;
  const out = Object.create(null);
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[key] = part.slice(i + 1).trim();
    }
  }
  return out;
}

export function readSessionToken(req) {
  return parseCookies(req)[COOKIE_NAME] || null;
}

/** 签发会话 Cookie。纯 HTTP 局域网部署，故不设 Secure。 */
export function sessionCookie(token) {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${LIMITS.SESSION_TTL_DAYS * 86400}`,
  ].join('; ');
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** 会话的读写。需要 store 的部分都在这里。 */
export function createSessions(store) {
  const { db } = store;

  /** 签发会话。返回 token 与变更描述——「该账号其它客户端要重新拉取」在这里说。 */
  function createSession(accountId) {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    db.prepare(
      'INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    ).run(
      token,
      accountId,
      new Date(now).toISOString(),
      new Date(now + LIMITS.SESSION_TTL_DAYS * DAY_MS).toISOString(),
    );
    return {
      token,
      changed: [accountChanged([accountId], 'signed-in')],
    };
  }

  function deleteSession(token) {
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  /** 校验会话并滑动续期。返回当前账号，或 null。 */
  function getSessionAccount(token) {
    if (!token) return null;
    const row = db
      .prepare(
        `SELECT s.expires_at, a.id, a.username, a.role
           FROM sessions s JOIN accounts a ON a.id = s.account_id
          WHERE s.token = ?`,
      )
      .get(token);
    if (!row) return null;

    const now = Date.now();
    const expires = Date.parse(row.expires_at);
    if (!(expires > now)) {
      deleteSession(token);
      return null;
    }

    // 滑动续期：剩余时间不足一半时才写库，避免每个请求都产生一次写入。
    const ttl = LIMITS.SESSION_TTL_DAYS * DAY_MS;
    if (expires - now < ttl / 2) {
      db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(
        new Date(now + ttl).toISOString(),
        token,
      );
    }

    return { id: row.id, username: row.username, role: row.role, token };
  }

  function purgeExpiredSessions() {
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
  }

  return { createSession, deleteSession, getSessionAccount, purgeExpiredSessions };
}
