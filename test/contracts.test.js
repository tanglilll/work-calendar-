/**
 * 前端交互契约：动作词、开框仪式、结果呈现、公开端点豁免，各只有一处定义。
 *
 * 这四种约定以前在每个对话框、每个请求方法上各抄一份，只能靠「记得对齐」——✕ 按钮一处叫
 * cancel 一处叫 close；「先关、再重建、再 showModal」三份副本；失败一处由 items-flow 的
 * result 对象呈现、一处由 admin 在 catch 里按状态码决定要不要重画；公开端点是每个方法上的
 * 一个 flag。抄本之间没有共同判据，改一处、忘一处只有浏览器能发现。
 *
 * 本文件把「产出端与消费端引用同一份定义」钉住：
 * - 模板里写回字符串字面量（`data-act="save"`）、或比较时写回字面量，变红；
 * - 对话框模块里再抄一份开框仪式（自己 showModal / 自己判 dialog.open），变红；
 * - admin 又按状态码决定呈现，变红；
 * - 公开端点清单与服务端真路由不一致（新增公开端点忘了标），变红。
 *
 * 写法的取舍：能跑真代码的就跑真代码（伪 dialog、伪 ui、替身 fetch、真 handleApi 路由），
 * 只有「模板里写的是哪个标识符」这类没有运行时表征的事才做静态检查，并逐条写明防的是什么。
 */
import { readFileSync } from 'node:fs';
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  DIALOG_ACT,
  actAttr,
  failureResult,
  openDialog,
  outcomeOf,
  presentResult,
  readAct,
  runAct,
} from '../public/contracts.js';
import {
  PUBLIC_ENDPOINTS,
  SESSION_EXPIRED_MESSAGE,
  isPublicEndpoint,
  setSessionExpiredHandler,
} from '../public/session.js';
import { api } from '../public/api.js';
import { openAdminDialog } from '../public/admin.js';
import { openInvitesDialog } from '../public/invites.js';
import { openItemDialog } from '../public/itemform.js';
import { freshWorld } from '../test-helpers/world.js';

const realFetch = globalThis.fetch;

/**
 * 只实现仪式与事件委托用得到的部分：open、innerHTML、close、showModal、addEventListener、
 * querySelector。真实 DOM 的排版、原生 confirm 与指针行为只能在浏览器里验（见工单 08 的边界）。
 */
function fakeDialog({ open = false } = {}) {
  const calls = [];
  const listeners = [];
  let html = '';
  const form = {
    querySelector: () => ({ focus: () => calls.push('focus') }),
    querySelectorAll: () => [],
  };
  const body = { innerHTML: '', querySelectorAll: () => [] };
  return {
    calls,
    listeners,
    open,
    get innerHTML() {
      return html;
    },
    set innerHTML(value) {
      html = value;
      calls.push('innerHTML');
    },
    close() {
      calls.push('close');
      this.open = false;
    },
    showModal() {
      calls.push('showModal');
      this.open = true;
    },
    addEventListener(type, handler, opts) {
      calls.push(`listen:${type}`);
      listeners.push({ type, handler, signal: opts?.signal });
    },
    removeEventListener() {},
    querySelector(sel) {
      if (sel === '#item-form') return form;
      if (sel === '#admin-body' || sel === '#invites-body') return body;
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
}

const sourceOf = (file) => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
const DIALOG_MODULES = ['itemform.js', 'admin.js', 'invites.js'];
const SOURCES = new Map(DIALOG_MODULES.map((file) => [file, sourceOf(file)]));

/** 语义化的提取：模板里产出的动作词键、处理器表上的动作词键。 */
const emittedActKeys = (src) => [...src.matchAll(/actAttr\(DIALOG_ACT\.(\w+)\)/g)].map((m) => m[1]);
const handledActKeys = (src) => [...src.matchAll(/\[DIALOG_ACT\.(\w+)\]:/g)].map((m) => m[1]);

describe('DIALOG_ACT：动作词只有这一份', () => {
  test('词表就是这六个词，值互不相同（同一件事不会有两个名字）', () => {
    assert.deepEqual(Object.keys(DIALOG_ACT).sort(), [
      'archive',
      'cancelTransfer',
      'close',
      'invite',
      'remove',
      'save',
    ]);
    assert.deepEqual(Object.values(DIALOG_ACT).sort(), [
      'archive',
      'cancel-transfer',
      'close',
      'delete',
      'invite',
      'save',
    ]);
    assert.equal(new Set(Object.values(DIALOG_ACT)).size, 6, '同一个词不能对应两个动作');
  });

  test('「关掉对话框」在三个对话框里是同一个词：cancel 与 close 的分歧已经收掉', () => {
    assert.equal(DIALOG_ACT.close, 'close');
    assert.equal(
      Object.values(DIALOG_ACT).includes('cancel'),
      false,
      'cancel 不再是词表里的词（它的那件事由 close 管）',
    );
  });
});

describe('产出端与消费端引用同一常量', () => {
  test('产出的动作词都经 actAttr(DIALOG_ACT.x)：模板里写回字符串字面量就会红', () => {
    for (const [file, src] of SOURCES) {
      assert.deepEqual(
        [...src.matchAll(/data-act\s*=/g)],
        [],
        `${file}: data-act 属性只能由 actAttr() 产出（属性名与词表都在 contracts.js）`,
      );
      const emitted = emittedActKeys(src);
      assert.ok(emitted.length > 0, `${file}: 应当产出一组动作按钮`);
      for (const key of emitted) {
        assert.ok(key in DIALOG_ACT, `${file}: DIALOG_ACT.${key} 不在词表里（产出了一个不存在的词）`);
      }
    }
  });

  test('消费端只经 readAct + 用词表键查表：比较动作词时写字符串字面量就会红', () => {
    for (const [file, src] of SOURCES) {
      assert.doesNotMatch(
        src,
        /dataset\.act/,
        `${file}: 读动作词必须走 readAct（属性名只在 contracts.js 出现）`,
      );
      assert.match(src, /\breadAct\(/, `${file}: 消费端应当用 readAct 读动作词`);
      assert.doesNotMatch(src, /\bact\s*===\s*['"`]/, `${file}: 动作词比较不能写字符串字面量`);
      assert.doesNotMatch(
        src,
        /readAct\([^)]*\)\s*[!=]==\s*['"`]/,
        `${file}: 动作词比较不能写字符串字面量`,
      );
      assert.ok(handledActKeys(src).length > 0, `${file}: 处理器表要用 [DIALOG_ACT.x] 作键`);
    }
  });

  test('每个对话框：产出的词与处理器一一对应（加了按钮忘了处理会红）', () => {
    for (const [file, src] of SOURCES) {
      assert.deepEqual(
        [...new Set(emittedActKeys(src))].sort(),
        [...new Set(handledActKeys(src))].sort(),
        `${file}: 产出的动作词与处理器表必须一一对应`,
      );
    }
  });

  test('三个对话框合起来正好用满词表：没有没人用的词，也没有词表外的词', () => {
    const used = new Set(DIALOG_MODULES.flatMap((file) => handledActKeys(SOURCES.get(file))));
    assert.deepEqual([...used].sort(), Object.keys(DIALOG_ACT).sort());
  });

  test('actAttr / readAct 是同一对接口：写进去读得回来（属性名不会两边各写一份）', () => {
    const markup = `<button ${actAttr(DIALOG_ACT.save)}>保存</button>`;
    const fakeButton = { closest: () => ({ getAttribute: () => 'save' }) };
    assert.match(markup, /data-act="save"/);
    assert.equal(readAct(fakeButton), 'save');
    assert.equal(readAct({ closest: () => null }), null, '不是动作按钮就给 null');
  });

  test('runAct：查不到的词安静跳过，不会把「constructor」这类原型键当处理器', () => {
    let called = 0;
    const handlers = { [DIALOG_ACT.close]: () => { called += 1; } };

    runAct(handlers, DIALOG_ACT.close);
    runAct(handlers, 'constructor');
    runAct(handlers, null);

    assert.equal(called, 1);
  });
});

describe('openDialog：开框仪式只有这一处', () => {
  test('顺序：已开着先关 → 重建内容 → 注册监听 → showModal → onOpen', () => {
    const dialog = fakeDialog({ open: true });
    openDialog(dialog, {
      html: '<p>内容</p>',
      listeners: { click: () => {} },
      onOpen: () => dialog.calls.push('onOpen'),
    });

    assert.deepEqual(dialog.calls, ['close', 'innerHTML', 'listen:click', 'showModal', 'onOpen']);
  });

  test('没开着就不关（不会产生多余的 close）', () => {
    const dialog = fakeDialog();
    openDialog(dialog, { html: '内容' });
    assert.deepEqual(dialog.calls, ['innerHTML', 'showModal']);
  });

  test('重开一次：上一次打开的监听整组解除，这一次是新的（监听不累积）', () => {
    const dialog = fakeDialog();
    openDialog(dialog, { html: 'a', listeners: { click: () => {} } });
    const first = dialog.listeners.at(-1).signal;
    assert.equal(first.aborted, false);

    openDialog(dialog, { html: 'b', listeners: { click: () => {} } });
    assert.equal(first.aborted, true, '上一次打开的监听必须被解除');
    assert.equal(dialog.listeners.at(-1).signal.aborted, false);
  });

  test('对话框模块里没有仪式副本：不许自己 showModal，也不许自己判 dialog.open', () => {
    for (const [file, src] of SOURCES) {
      assert.doesNotMatch(src, /\bshowModal\b/, `${file}: 打开对话框只能走 openDialog`);
      assert.doesNotMatch(src, /dialog\.open\b/, `${file}: 「已经开着就先关」由 openDialog 负责`);
      assert.match(src, /\bopenDialog\(/, `${file}: 应当用 openDialog 打开`);
    }
  });
});

describe('三个对话框的开与关：头部 ✕ 是同一个词，点下去都关框', () => {
  /** 从真实渲染出来的标记里读出头部 ✕ 的动作词（三个对话框的 ✕ 都是 title="关闭"）。 */
  const headCloseAct = (html) => html.match(/<button[^>]*data-act="([^"]+)" title="关闭"/)?.[1] ?? null;

  /** 一次点击：`target.closest('button')` 给按钮，`button.closest('[data-act]')` 给动作词。 */
  function clickWith(act) {
    const carrier = { getAttribute: () => act };
    const button = {
      dataset: {},
      closest: (sel) => (sel === '[data-act]' ? carrier : null),
      getAttribute: () => act,
    };
    return { target: { closest: (sel) => (sel === 'button' ? button : sel === '[data-act]' ? carrier : null) } };
  }

  const DIALOGS = [
    {
      name: 'itemform',
      open: (dialog, ctx) => openItemDialog(dialog, ctx),
      ctx: { item: null, today: '2026-09-18', tags: [], owners: [], canAssign: false, onDone() {} },
    },
    {
      name: 'admin',
      open: (dialog, ctx) => openAdminDialog(dialog, ctx),
      ctx: { me: { id: 1, role: 'admin' }, palette: [], roles: ['user'], onDone() {} },
    },
    { name: 'invites', open: (dialog, ctx) => openInvitesDialog(dialog, ctx), ctx: { onDone() {} } },
  ];

  test('取消 / ✕ 在三个对话框里是同一个词，且按渲染出来的词派发点击真的关框', async () => {
    // admin 与 invites 开框会先拉一次列表：用替身 fetch 让它们画个空视图
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ requests: [], items: [] });
      },
    });
    try {
      for (const { name, open, ctx } of DIALOGS) {
        const dialog = fakeDialog();
        open(dialog, ctx);

        const act = headCloseAct(dialog.innerHTML);
        assert.ok(act, `${name}: 头部 ✕ 没找到（标记形如 <button data-act="…" title="关闭">）`);
        assert.equal(act, DIALOG_ACT.close, `${name}: 头部 ✕ 的动作词应当是词表里的 close`);
        assert.equal(dialog.open, true, `${name}: 开框之后 dialog.open 应当为真`);

        const click = dialog.listeners.find((l) => l.type === 'click').handler;
        click(clickWith(act));
        assert.equal(dialog.open, false, `${name}: 点 ✕ 应当关框`);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

/** 记录呈现动作的替身界面层。 */
function captureUi() {
  const seen = [];
  return {
    seen,
    toast: (message, kind) => seen.push(kind ? `${kind}:${message}` : message),
    setFieldErrors: (fields) => seen.push(`fields:${Object.keys(fields).join(',')}`),
    refresh: async () => seen.push('refresh'),
    close: () => seen.push('close'),
    done: async () => seen.push('done'),
  };
}

describe('presentResult：成功与失败只有一条呈现路径', () => {
  test('字段错误进表单；错误提示与成功提示各归各的', async () => {
    const ui = captureUi();
    await presentResult({ ok: false, fields: { title: '标题不能为空' } }, ui);
    await presentResult({ ok: false, message: '无权处置他人的事项' }, ui);
    await presentResult({ ok: true, toast: '已删除' }, ui);

    assert.deepEqual(ui.seen, ['fields:title', 'error:无权处置他人的事项', '已删除']);
  });

  test('close：先关框、再通知应用层（itemform 的保存与 409 走这条）', async () => {
    const ui = captureUi();
    await presentResult({ ok: true, close: true, toast: '已删除' }, ui);
    assert.deepEqual(ui.seen, ['已删除', 'close', 'done']);
  });

  test('refresh 先于 done（admin 的 success 是「提示 → 重画 → 通知应用层」）', async () => {
    const ui = captureUi();
    await presentResult({ ok: true, toast: '已批准，账号已生成', refresh: true, done: true }, ui);
    assert.deepEqual(ui.seen, ['已批准，账号已生成', 'refresh', 'done']);
  });

  test('重画失败也要说出来：不许静默停在不一致的界面上', async () => {
    const ui = captureUi();
    ui.refresh = async () => {
      throw new Error('网络断了');
    };
    await presentResult({ refresh: true, done: true }, ui);

    assert.deepEqual(ui.seen, ['error:网络断了', 'done']);
  });

  test('空结果（用户取消了二次确认）什么都不做', async () => {
    const ui = captureUi();
    await presentResult({}, ui);
    assert.deepEqual(ui.seen, []);
  });
});

describe('failureResult / outcomeOf：失败与成功同形', () => {
  /** 一个带状态的 HTTP 错误，形状与 api.js 抛出的那种一致。 */
  const httpErr = (status, message, fields) =>
    Object.assign(new Error(message), { status, fields });

  test('版本冲突（409）与状态已变（400）：屏幕上的副本可能过期，标记重画', () => {
    assert.equal(failureResult(httpErr(409, '此事项已被他人修改，请刷新后重试')).refresh, true);
    assert.equal(failureResult(httpErr(400, '输入有误')).refresh, true);
  });

  test('别的失败只提示、不重画（403 是人还登着、404 是没了、5xx 是服务端的事，重画也白搭）', () => {
    for (const status of [403, 404, 429, 500, 503, undefined]) {
      assert.equal(failureResult(httpErr(status, '失败')).refresh, false, `${status} 不该触发重画`);
    }
  });

  test('失败原样带着文案与字段错误（呈现层不需要知道状态码）', () => {
    const result = failureResult(httpErr(400, '输入有误', { title: '标题不能为空' }));
    assert.equal(result.ok, false);
    assert.equal(result.message, '输入有误');
    assert.deepEqual(result.fields, { title: '标题不能为空' });
  });

  test('outcomeOf：正常返回的结果原样通过；抛出的错误归一成失败结果', async () => {
    const ok = { ok: true, toast: '已拒绝' };
    assert.equal(await outcomeOf(async () => ok), ok);

    const failed = await outcomeOf(async () => {
      throw httpErr(409, '系统里必须至少保留一个 admin');
    });
    assert.deepEqual(failed, {
      ok: false,
      message: '系统里必须至少保留一个 admin',
      fields: undefined,
      refresh: true,
    });
  });
});

describe('admin 的失败呈现并入统一路径', () => {
  test('admin 里不再有状态码：重画由失败结果的 refresh 位决定，不在 catch 里特判', () => {
    const src = SOURCES.get('admin.js');
    assert.doesNotMatch(src, /err\.status/, 'admin 不该再按状态码决定呈现');
    assert.doesNotMatch(src, /\b(409|400)\b/, '重画规则是失败结果上的数据，不该写回状态码');
    assert.match(src, /outcomeOf\(/, '抛出的错误要归一成结果对象（与 items-flow 的结果同形）');
    assert.match(src, /presentResult\(/, '呈现要走唯一那条路径');
  });

  test('admin 的失败与 itemform 的失败走同一个函数：两条路径已合成一条', () => {
    const itemform = SOURCES.get('itemform.js');
    assert.match(itemform, /presentResult\(/, 'itemform 的呈现也应走同一条路径');
    assert.match(itemform, /outcomeOf\(/, 'itemform 也一样：结果对象由 outcomeOf 归一');
  });
});

/** 用真 handleApi 做一次未登录探测，返回状态码与抛出的错误。 */
async function call(app, { method = 'GET', path } = {}) {
  const req = {
    method,
    headers: { host: 'local' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {},
  };
  const captured = { status: 0 };
  const res = {
    headersSent: false,
    writeHead(status) {
      captured.status = status;
    },
    write() {},
    end() {},
    on() {},
  };
  try {
    await app.handleApi(req, res, new URL(path, 'http://local'));
  } catch (err) {
    // 错误映射是入口层的事，这里只取状态码与判据要用的那句话
    return { status: Number(err?.status) || 500, error: err };
  }
  return { status: captured.status, error: null };
}

/**
 * 逐个调用 api 的方法，用替身 fetch 记下它们各自的路径与 HTTP 方法。
 * 方法签名一律喂 (1, 1)：这层只关心「哪个方法打哪条路径」，不关心参数的语义。
 */
async function recordRoutes() {
  const routes = [];
  globalThis.fetch = async (path, init = {}) => {
    routes.push({ path, method: init.method ?? 'GET' });
    return {
      ok: false,
      status: 401,
      async text() {
        return JSON.stringify({ error: { message: '占位' } });
      },
    };
  };
  try {
    for (const [name, method] of Object.entries(api)) {
      const before = routes.length;
      await method(1, 1).catch(() => {});
      assert.equal(routes.length, before + 1, `api.${name} 应当恰好发出一条请求`);
      routes.at(-1).name = name;
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  return routes;
}

describe('公开端点的豁免：清单与判据同住一处', () => {
  beforeEach(() => setSessionExpiredHandler(null));
  after(() => {
    globalThis.fetch = realFetch;
  });

  test('豁免没有第二个落点：api.js 里不再有 per-method 的 requiresSession', () => {
    assert.doesNotMatch(
      sourceOf('api.js'),
      /requiresSession/,
      '公开端点只由 session.js 的清单认定，方法上不该再有 flag',
    );
  });

  test('清单就是这四条（每条的理由写在 session.js 里）', () => {
    assert.deepEqual(
      [...PUBLIC_ENDPOINTS],
      ['/api/bootstrap', '/api/login', '/api/logout', '/api/register-request'],
    );
  });

  test('逐个方法验 401：是否结束会话与清单完全一致', async () => {
    // 服务端的「凭据错误」文案：公开端点要把它留给用户，不能被顶成「登录已失效」
    const CREDENTIALS_ERROR = '用户名或密码不正确';
    const routes = await recordRoutes();
    assert.equal(routes.length, Object.keys(api).length);

    for (const { name, path, method } of routes) {
      const ended = [];
      setSessionExpiredHandler(() => ended.push(path));
      globalThis.fetch = async () => ({
        ok: false,
        status: 401,
        async text() {
          return JSON.stringify({ error: { message: CREDENTIALS_ERROR } });
        },
      });

      const err = await api[name](1, 1).then(
        () => null,
        (e) => e,
      );
      assert.ok(err, `api.${name} 应当把 401 抛给调用点`);
      if (isPublicEndpoint(path)) {
        assert.deepEqual(ended, [], `api.${name}（${method} ${path}）在清单里：它的 401 是凭据错误`);
        assert.equal(err.message, CREDENTIALS_ERROR, `api.${name}: 公开端点的错误文案要留给服务端那句`);
      } else {
        assert.deepEqual(ended, [path], `api.${name}（${method} ${path}）不在清单里：401 应当结束会话`);
        assert.equal(err.message, SESSION_EXPIRED_MESSAGE);
      }
    }
  });

  test('清单与服务端真路由一致：服务端不要会话的必须豁免，要会话的不能豁免', async () => {
    const { app } = freshWorld();
    // 会话门的形状 = 未登录访问一条必然要登录的路径。用它作基准，不写死任何文案。
    const gate = await call(app, { path: '/api/items' });
    assert.equal(gate.status, 401, '未登录访问需登录路径应当被会话门挡住（这条是下面分类的基准）');

    for (const { name, path, method } of await recordRoutes()) {
      const res = await call(app, { method, path });
      const gated = res.status === 401 && res.error?.message === gate.error?.message;
      assert.equal(
        isPublicEndpoint(path),
        !gated,
        `api.${name}（${method} ${path}）：${
          gated ? '服务端要会话，清单不能豁免它' : '服务端不要求会话，清单必须豁免它'
        }`,
      );
    }
    app.close();
  });
});
