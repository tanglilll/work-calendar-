/**
 * 入口层的错误映射。测试不走 index.js 的 main()（那会开端口、碰数据库），
 * 而是用 import.meta.main 守着的那个接缝：createRequestHandler + errorResponse。
 *
 * 这里守的是那条收紧过的规则：>= 500 不外泄内部错误码（连带 message），
 * 只有业务错误才带 code / fields。以前这条规则埋在 createServer 的回调里，
 * 测试只能自己抄一份，等于没有回归网。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRequestHandler, errorResponse } from '../server/index.js';
import { httpError } from '../server/http.js';
import { freshWorld } from '../test-helpers/world.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, '..', 'public');

/** 跑一次请求处理，取回状态码与已解析的响应体。 */
async function call(handler, { method = 'GET', path = '/api/whatever', body } = {}) {
  const req = {
    method,
    url: path,
    headers: { host: 'local' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
  const captured = { status: 0, raw: null };
  const res = {
    headersSent: false,
    writeHead(status) {
      captured.status = status;
    },
    write() {},
    end(chunk) {
      captured.raw = chunk ?? null;
    },
    on() {},
  };
  await handler(req, res);
  return { status: captured.status, body: captured.raw ? JSON.parse(captured.raw) : null };
}

const throwingApp = (err) => ({ handleApi: async () => { throw err; } });

/** 5xx 会走 console.error（入口刻意保留的行为）；测试里静音，别把日志当断言。 */
async function quiet(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

describe('入口层错误映射', () => {
  test('>= 500：只说「服务器内部错误」，内部错误码与字段不外泄', async () => {
    // 存储层错误的典型形状：带 status 500 与 SQLite 错误码
    const storageError = Object.assign(new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: accounts.username'), {
      status: 500,
      code: 'SQLITE_CONSTRAINT_UNIQUE',
      fields: { username: '已被占用' },
    });
    const res = await quiet(() =>
      call(createRequestHandler({ app: throwingApp(storageError), publicDir: PUBLIC_DIR })),
    );

    assert.equal(res.status, 500);
    assert.equal(res.body.error.message, '服务器内部错误');
    assert.equal(res.body.error.code, undefined, '内部错误码不该外泄');
    assert.equal(res.body.error.fields, undefined, '内部字段细节不该外泄');
  });

  test('运行时错误（没有 status）同样按 500 处理', async () => {
    const res = await quiet(() =>
      call(createRequestHandler({ app: throwingApp(new TypeError('x is not a function')), publicDir: PUBLIC_DIR })),
    );
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: { message: '服务器内部错误' } });
  });

  test('业务错误：status 与 message 如实回报，code / fields 带上', async () => {
    const conflict = httpError(409, '这条事项已被他人修改', {
      code: 'version_conflict',
      fields: { version: 3 },
    });
    const res = await call(createRequestHandler({ app: throwingApp(conflict), publicDir: PUBLIC_DIR }));

    assert.equal(res.status, 409);
    assert.equal(res.body.error.message, '这条事项已被他人修改');
    assert.equal(res.body.error.code, 'version_conflict');
    assert.deepEqual(res.body.error.fields, { version: 3 });
  });

  test('真实的组合根 + 真实路由：业务错误如实回报，且不凭空造 code / fields', async () => {
    const { app } = freshWorld();
    const handler = createRequestHandler({ app, publicDir: PUBLIC_DIR });

    const denied = await call(handler, { method: 'GET', path: '/api/items' });
    assert.equal(denied.status, 401);
    assert.equal(denied.body.error.message, '请先登录');

    const wrongPassword = await call(handler, {
      method: 'POST',
      path: '/api/login',
      body: { username: 'zhao', password: 'not-the-password' },
    });
    assert.equal(wrongPassword.status, 401);
    assert.equal(wrongPassword.body.error.message, '用户名或密码不正确');
    assert.equal(wrongPassword.body.error.code, undefined, '业务错误没带 code 时不该凭空造一个');

    app.close();
  });

  test('errorResponse 是纯函数：映射规则可以脱离 HTTP 直接断言', () => {
    assert.deepEqual(errorResponse(new Error('boom')), {
      status: 500,
      message: '服务器内部错误',
      extra: {},
    });
    assert.deepEqual(errorResponse(httpError(404, '接口不存在')), {
      status: 404,
      message: '接口不存在',
      extra: {},
    });
  });
});
