/**
 * /api/bootstrap 的契约。它是 routes 层的接口，不属于事项领域，所以单独一个文件，
 * 不塞进 test/items.test.js 里。
 *
 * 这里钉两件事：下发的 limits 与 config.js 的 LIMITS 同源（曾经它是手挑的 5 个
 * key，漏掉了 PROGRESS_MAX；断言整份同源之后，LIMITS 增删一条接口自动跟上）；
 * 下发的 quadrant 白名单与 QUADRANTS 同源（前端的分组顺序、事项对话框的下拉都读它，
 * 一份白名单只有服务端这一处）。
 * 用桩 req/res 直接喂 handleApi：不开端口、不碰网络（与 invites-http.test.js 同形状）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { freshWorld } from '../test-helpers/world.js';
import { LIMITS, QUADRANTS } from '../server/config.js';

/** 未登录访问 bootstrap。返回 { status, body }。 */
async function bootstrap(app) {
  const req = {
    method: 'GET',
    headers: { host: 'local' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {},
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

  await app.handleApi(req, res, new URL('/api/bootstrap', 'http://local'));
  return { status: captured.status, body: JSON.parse(captured.raw) };
}

describe('bootstrap 下发的 limits', () => {
  test('与 config.js 的 LIMITS 同源：完整下发，一个不少', async () => {
    const { app } = freshWorld();
    const res = await bootstrap(app);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.limits, LIMITS, 'limits 必须是 LIMITS 本身，不能再手挑 key');
    assert.ok(res.body.limits.PROGRESS_MAX > 0, '手挑时代漏掉的那个 key 必须在');
    app.close();
  });
});

describe('bootstrap 下发的象限白名单', () => {
  test('与 config.js 的 QUADRANTS 同源：值、顺序都照抄', async () => {
    const { app } = freshWorld();
    const res = await bootstrap(app);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.quadrants, QUADRANTS, '象限白名单必须真的下发，前端才有分组顺序可言');
    assert.ok(res.body.quadrants.length > 0, '空的象限白名单会让表格视图退到「数据出现顺序」');
    app.close();
  });
});
