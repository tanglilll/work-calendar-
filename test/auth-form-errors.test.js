/**
 * 登录 / 申请表单的失败呈现：服务端的 message 与字段级 fields（`error.fields`）都不许丢。
 *
 * 症状是「提交后只有一行『输入有误』」：服务端 400 明明把字段级错误放进了响应体
 * （server/accounts.js:65 的 httpError(400, '输入有误', { fields })，api.js:33 也挂到了
 * Error 上），但 app.js 的 catch 只写 err.message，表单里连一个字段级落点都没有。
 *
 * 本文件钉住三件事：
 * - 纯函数 showFormFailure：message 进 [data-msg]，fields 进 [data-error-for]；没有落点的
 *   字段折回表单级提示里，不许静默丢；两个处理器共用这一条路径。
 * - index.html 的两个表单声明了服务端真正会用的落点（username / password / note），且密码
 *   规则与 server/config.js 的 LIMITS.PASSWORD_MIN 同源——写死了、漂了都在这里红。
 * - 真服务端（createRequestHandler + :memory: 库）的 400/409 响应体，经 api.js 一路走到
 *   index.html 声明的落点上，message 与 fields 都落了地。
 *
 * 覆盖不到的：真实浏览器的渲染（红字画在哪儿、minlength 在提交前拦住 6 位密码）只能在
 * 浏览器里验，见 docs/agents/local-environment.md 的口径。
 */
import { readFileSync } from 'node:fs';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import { setFieldErrors, showFormFailure } from '../public/util.js';
import { api } from '../public/api.js';
import { createRequestHandler } from '../server/index.js';
import { LIMITS } from '../server/config.js';
import { freshWorld } from '../test-helpers/world.js';

const realFetch = globalThis.fetch;

const sourceOf = (name) => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
const INDEX_HTML = sourceOf('index.html');
const APP_JS = sourceOf('app.js');

/** index.html 里某个表单的那一段标记（从 <form id="…"> 到 </form>）。 */
function formBlock(id) {
  const start = INDEX_HTML.indexOf(`<form id="${id}"`);
  assert.ok(start >= 0, `index.html 里找不到 #${id}`);
  return INDEX_HTML.slice(start, INDEX_HTML.indexOf('</form>', start));
}

/** 表单里声明的字段级落点（data-error-for 的值），排序后返回。 */
const landingNames = (block) => [...block.matchAll(/<[^>]*data-error-for="([^"]+)"[^>]*>/g)].map((m) => m[1]).sort();

/** 落点所在的元素标记，用来核对它带没带 .field-error（setFieldErrors 靠这个类名清空）。 */
const landingTags = (block) => [...block.matchAll(/<[^>]*data-error-for="[^"]+"[^>]*>/g)].map((m) => m[0]);

/**
 * 表单替身：只实现 util.js 用得到的 querySelector / querySelectorAll。
 * `landings` 是表单里有落点的字段名；写入结果留在 `errors` / `msg` 上供断言。
 */
function fakeForm(landings = []) {
  const errors = new Map(landings.map((name) => [name, { textContent: '' }]));
  const msg = { textContent: '', dataset: {} };
  return {
    errors,
    msg,
    querySelector(sel) {
      if (sel === '[data-msg]') return msg;
      const name = sel.match(/^\[data-error-for="(.+)"\]$/)?.[1];
      return name ? errors.get(name) ?? null : null;
    },
    querySelectorAll(sel) {
      return sel === '.field-error' ? [...errors.values()] : [];
    },
  };
}

/** 带字段错误的 HTTP 错误，形状与 api.js 抛出的那种一致。 */
const httpErr = (status, message, fields) => Object.assign(new Error(message), { status, fields });

describe('setFieldErrors：写不进去的字段要交出来，不许静默', () => {
  test('fields 为 null：只清空上一次的红字，返回空', () => {
    const form = fakeForm(['password']);
    form.errors.get('password').textContent = '上一次的文案';
    assert.deepEqual(setFieldErrors(form, null), []);
    assert.equal(form.errors.get('password').textContent, '');
  });

  test('能落地的写进元素；没有落点的原样返回给调用方（静默跳过就是丢错误）', () => {
    const form = fakeForm(['username', 'password']);
    const orphaned = setFieldErrors(form, {
      username: '该用户名已被占用',
      password: '密码至少 8 位',
      note: '备注最多 500 个字符',
    });
    assert.equal(form.errors.get('username').textContent, '该用户名已被占用');
    assert.equal(form.errors.get('password').textContent, '密码至少 8 位');
    assert.deepEqual(orphaned, [['note', '备注最多 500 个字符']]);
  });
});

describe('showFormFailure：message 与 fields 两路都不丢', () => {
  test('没有 fields 的失败（登录 401 那种）照旧只有一行提示', () => {
    const form = fakeForm(['username', 'password']);
    showFormFailure(form, httpErr(401, '用户名或密码不正确'));

    assert.equal(form.msg.textContent, '用户名或密码不正确');
    assert.equal(form.msg.dataset.kind, 'error');
    assert.deepEqual([...form.errors.values()].map((el) => el.textContent), ['', '']);
  });

  test('带 fields 的 400：message 进表单级提示，字段错误进各自的落点', () => {
    const form = fakeForm(['username', 'password', 'note']);
    showFormFailure(form, httpErr(400, '输入有误', { password: '密码至少 8 位' }));

    assert.equal(form.msg.textContent, '输入有误');
    assert.equal(form.errors.get('password').textContent, '密码至少 8 位');
  });

  test('一次报多个字段：每条都落到自己的落点', () => {
    const form = fakeForm(['username', 'password', 'note']);
    showFormFailure(
      form,
      httpErr(400, '输入有误', { username: '用户名长度须在 3–32 之间', password: '密码至少 8 位' }),
    );

    assert.equal(form.errors.get('username').textContent, '用户名长度须在 3–32 之间');
    assert.equal(form.errors.get('password').textContent, '密码至少 8 位');
    assert.equal(form.errors.get('note').textContent, '');
  });

  test('没有落点的字段折回表单级提示：不许只剩一句「输入有误」', () => {
    // note 故意没有落点：服务端给了 fields.note，界面也必须看得见这条
    const form = fakeForm(['username', 'password']);
    showFormFailure(
      form,
      httpErr(400, '输入有误', { note: '备注最多 500 个字符', username: '该用户名已被占用' }),
    );

    assert.match(form.msg.textContent, /输入有误/);
    assert.match(form.msg.textContent, /备注最多 500 个字符/, '字段有消息却无落点时，要折回表单级提示');
    assert.equal(
      form.errors.get('username').textContent,
      '该用户名已被占用',
      '没有落点的键不该把有落点的键顶掉',
    );
  });

  test('重新提交：上一次的字段红字先清掉，新失败没提到的字段不留旧文案', () => {
    const form = fakeForm(['username', 'password']);
    showFormFailure(form, httpErr(400, '输入有误', { username: '用户名长度须在 3–32 之间' }));
    showFormFailure(form, httpErr(400, '输入有误', { password: '密码至少 8 位' }));

    assert.equal(form.errors.get('username').textContent, '');
    assert.equal(form.errors.get('password').textContent, '密码至少 8 位');
  });
});

describe('index.html：两个表单的落点与密码规则', () => {
  test('服务端会用的三个字段键，两个表单各自都有落点', () => {
    assert.deepEqual(landingNames(formBlock('login-form')), ['password', 'username']);
    assert.deepEqual(landingNames(formBlock('apply-form')), ['note', 'password', 'username']);
  });

  test('每个落点都带 class="field-error"——setFieldErrors 靠它清空，缺了就会越挂越多', () => {
    for (const tag of [...landingTags(formBlock('login-form')), ...landingTags(formBlock('apply-form'))]) {
      assert.match(tag, /class="field-error"/, `落点必须带 .field-error：${tag}`);
    }
  });

  test('申请表单提交前就说清密码规则，且与 LIMITS.PASSWORD_MIN 同源（写死的数字会在这里红）', () => {
    const apply = formBlock('apply-form');
    const passwordTag = apply.match(/<input[^>]*name="password"[^>]*>/)?.[0];
    assert.ok(passwordTag, '申请表单里应当有密码输入框');
    assert.equal(
      Number(passwordTag.match(/minlength="(\d+)"/)?.[1]),
      LIMITS.PASSWORD_MIN,
      'minlength 必须等于服务端的 LIMITS.PASSWORD_MIN',
    );

    const hints = [...apply.matchAll(/<p class="hint">([^<]*)<\/p>/g)].map((m) => m[1]);
    assert.ok(
      hints.some((text) => text.includes(`密码至少 ${LIMITS.PASSWORD_MIN} 位`)),
      '提交前就要看得见密码规则（与 server/accounts.js 的报错同一句话）',
    );
  });
});

describe('app.js：登录与申请两个处理器都消费 err.fields（只修一个会在这里红）', () => {
  /** 一个处理器的函数体：从它的定义到下一个定义。 */
  const handlerBody = (from, to) => {
    const start = APP_JS.indexOf(from);
    assert.ok(start >= 0, `app.js 里找不到 ${from}`);
    return APP_JS.slice(start, APP_JS.indexOf(to, start));
  };

  test('失败呈现从 util.js 引入，两个 catch 都走 showFormFailure', () => {
    assert.match(
      APP_JS,
      /import \{[^}]*showFormFailure[^}]*\} from '\.\/util\.js'/,
      '失败呈现只有一处定义（util.js），app.js 只消费',
    );

    const handlers = [
      ['onLogin', handlerBody('async function onLogin', 'async function onApply')],
      ['onApply', handlerBody('async function onApply', 'async function onLogout')],
    ];
    for (const [name, body] of handlers) {
      assert.match(
        body,
        /catch \(err\) \{[\s\S]*?showFormFailure\(form, err\)/,
        `${name} 的 catch 必须把 err 交给 showFormFailure，不能只写 err.message`,
      );
    }
  });

  test('两个处理器都在提交前清掉上一次的字段红字', () => {
    for (const from of ['async function onLogin', 'async function onApply']) {
      const body = handlerBody(from, 'async function onLogout');
      assert.match(body, /setFieldErrors\(form, null\)/, `${from} 提交前应当先清字段错误`);
    }
  });
});

/** 桩 req/res 照 test/http-entry.test.js:22-46：让真实的请求处理器跑一遍，拿到状态码与响应体。 */
async function call(handler, { method = 'GET', path, body } = {}) {
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
  return captured;
}

/**
 * 把 api.js 的 fetch 接到真实的请求处理器上：测试走的是「真服务端 → 真请求层」，
 * 不是手抄一份响应体。
 */
async function applyToRealServer(payloads) {
  const { app } = freshWorld();
  const handler = createRequestHandler({ app, publicDir: 'public' });
  globalThis.fetch = async (path, init = {}) => {
    const { status, raw } = await call(handler, {
      method: init.method ?? 'GET',
      path,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    });
    return { ok: status >= 200 && status < 300, status, text: async () => raw };
  };
  try {
    const results = [];
    for (const payload of payloads) {
      results.push(
        await api.apply(payload).then(
          (data) => ({ ok: true, data }),
          (err) => ({ ok: false, err }),
        ),
      );
    }
    return results;
  } finally {
    globalThis.fetch = realFetch;
    app.close();
  }
}

describe('真服务端 → api.js → 表单：fields 落到 index.html 声明的落点上', () => {
  const APPLY_LANDINGS = landingNames(formBlock('apply-form'));

  /** 按 index.html 里真正声明的落点搭出表单——少一个落点，下面的断言就红。 */
  const formFromMarkup = () => fakeForm(APPLY_LANDINGS);

  after(() => {
    globalThis.fetch = realFetch;
  });

  test('密码太短 / 用户名太短 / 备注太长：message 与 fields 都进表单，字段键都有落点', async () => {
    const tooLongNote = 'x'.repeat(LIMITS.NOTE_MAX + 1);
    const outcomes = await applyToRealServer([
      { username: '12313', password: '123456', note: '测试' },
      { username: 'ab', password: '123456', note: '' },
      { username: 'somename', password: 'password-1', note: tooLongNote },
    ]);
    assert.deepEqual(outcomes.map((r) => r.ok), [false, false, false], '三条都应当是失败');
    const [shortPassword, shortUsername, longNote] = outcomes.map((r) => r.err);

    assert.equal(shortPassword.status, 400);
    assert.equal(shortPassword.message, '输入有误', '表单级提示仍然是服务端那句');
    assert.deepEqual(shortPassword.fields, { password: '密码至少 8 位' });

    assert.equal(shortUsername.status, 400);
    assert.deepEqual(Object.keys(shortUsername.fields).sort(), ['password', 'username']);

    assert.equal(longNote.status, 400);
    assert.deepEqual(longNote.fields, { note: `备注最多 ${LIMITS.NOTE_MAX} 个字符` });

    for (const err of [shortPassword, shortUsername, longNote]) {
      const form = formFromMarkup();
      showFormFailure(form, err);

      assert.equal(form.msg.textContent, err.message, '失败的 message 不许丢');
      for (const [name, message] of Object.entries(err.fields)) {
        assert.ok(APPLY_LANDINGS.includes(name), `服务端的字段键 ${name} 在申请表里必须有落点`);
        assert.equal(form.errors.get(name).textContent, message, `fields.${name} 必须落到落点上`);
      }
    }
  });

  test('用户名重复提交的 409 也一样：message 与 fields.username 都看得见', async () => {
    const payload = { username: '12313', password: '12345678', note: '' };
    const [first, second] = await applyToRealServer([payload, payload]);

    assert.deepEqual(first.data, { ok: true }, '第一次应当成功（201）');
    assert.equal(second.ok, false);
    const err = second.err;
    assert.equal(err.status, 409);
    assert.equal(err.message, '该用户名已有一条待批准的申请');
    assert.deepEqual(err.fields, { username: '该用户名已有一条待批准的申请' });

    const form = formFromMarkup();
    showFormFailure(form, err);
    assert.equal(form.msg.textContent, '该用户名已有一条待批准的申请');
    assert.equal(form.errors.get('username').textContent, '该用户名已有一条待批准的申请');
  });
});
