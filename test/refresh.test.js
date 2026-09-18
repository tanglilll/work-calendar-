/**
 * 前端状态刷新的判据：**什么变了 → 重拉哪些字段**。
 *
 * 这一层以前散在八处（SSE 三个事件各一段、登录一段、三个对话框的 onDone、日切没有），
 * 于是 `refresh` 与 `boot` 两级粒度混用：`f24d4e7` 的三处界面问题同一根因——登录只走了
 * `enterApp()`，`capabilities` 停在初始值，「管理」入口要刷新才出现。现在范围只由
 * `public/app.js` 的 `REFRESH_PLAN` 决定，调用点只报「什么变了」，这里就断言这张表与执行器。
 *
 * 判据分四层：
 *
 * 1. **声明表**（纯映射）：登录 / `self` 全量且包含 `capabilities` 与 `inviteCount`；
 *    `admin` 含 owner 名单；`items` 只有事项；触发名写错直接抛——「漏拉一项」必须出声。
 * 2. **执行器**：用替身客户端跑一遍，断言「请求了哪些接口、写进了哪些字段」。`items`
 *    触发连别的字段都不许碰；`admin` 触发从 bootstrap 顺带拿回的标签 / 今天 / 角标不落地。
 * 3. **state 形状**：`inviteCount` 在初始形状里，重置回未登录形状只有一处定义。
 * 4. **不重连**：执行器不碰 `stream`；`app.js` 里 `new EventSource(` 只有一处；未登录的启动
 *    一条流都不建；而「已登录的页面收到 `self` 事件」端到端跑一遍——连接数不变、旧连接不被关掉。
 *
 * app.js 是浏览器入口（模块顶层就取 DOM 并在加载时引导），所以先装 document / fetch /
 * EventSource 替身再动态导入——静态 import 会被提升，赶不上装替身。**首次导入**那次引导
 * 一律答「未登录」：既不建流，也不排日切定时器，导入不会在测试里留下活的东西；**已登录**
 * 的导入在最后一条用例里按需做（查询串换个模块实例），那条路径上到午夜的定时器会被 unref。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const realSetTimeout = globalThis.setTimeout;
const sleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));

/** 服务端 bootstrap 的已登录应答（字段与 server/routes.js 的 handleBootstrap 同源）。 */
const AUTHED = {
  authenticated: true,
  account: { id: 1, username: '我', role: 'admin' },
  roles: ['user', 'manager', 'admin'],
  capabilities: { seesAllItems: true, assignsOwner: true, managesAccounts: true },
  inviteCount: 3,
  tags: ['工作'],
  palette: ['#111111'],
  today: '2026-09-18',
};

const authed = (over = {}) => ({ ...AUTHED, ...over });

/** 最小 document 替身：元素能接监听、能存文本，不解析 HTML。 */
function installDomStub() {
  const el = () => ({
    hidden: false,
    open: false,
    textContent: '',
    innerHTML: '',
    dataset: {},
    addEventListener() {},
    close() {},
    querySelectorAll: () => [],
    querySelector: () => null,
    classList: { toggle() {} },
  });
  globalThis.document = {
    getElementById: () => el(),
    querySelector: () => el(),
    querySelectorAll: () => [],
  };
}

/** fetch 替身：引导期答「未登录」；最后一条用例把它换成已登录的应答。 */
const fetches = [];
let fetchHandler = () => ({ authenticated: false, inviteCount: 0, capabilities: {} });
function installFetchStub() {
  globalThis.fetch = async (url) => {
    fetches.push(String(url));
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(fetchHandler(String(url)));
      },
    };
  };
}

/** EventSource 替身：记下建了几条流、挂了哪些监听，并能手动派发。 */
const streams = [];
function installEventSourceStub() {
  globalThis.EventSource = class {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      this.closed = false;
      streams.push(this);
    }
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    }
    close() {
      this.closed = true;
    }
  };
}

installDomStub();
installFetchStub();
installEventSourceStub();

const app = await import('../public/app.js');
const { REFRESH_PLAN, RELOADABLE_FIELDS, createState, fieldsFor, msUntilNextDay, runRefresh } = app;

/** 首次引导（未登录）落地后建了几条流：用来钉「未登录不建流」。 */
await sleep(0);
const streamsAfterFirstBoot = streams.length;

/**
 * 再导入一份「已登录」的 app.js（查询串让它成为独立模块实例）。
 * 引导会建流、也会在末尾排一个到午夜的定时器：导入期间（含让引导跑完的那一拍）把它
 * unref 掉，免得测试进程被一个 24 小时的定时器挂着。
 */
let signedInApp = null;
async function importSignedInApp() {
  if (signedInApp) return signedInApp;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const timer = realSetTimeout(fn, ms, ...rest);
    timer.unref?.();
    return timer;
  };
  try {
    signedInApp = await import('../public/app.js?signed-in');
    await sleep(0); // 让引导跑完（它最后一步是排日切定时器）
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  return signedInApp;
}

/** 客户端替身：记下调用次序，应答可换。 */
function fakeClient({
  bootstrap = authed(),
  owners = [{ id: 1, username: '我' }],
  items = [{ id: 7, title: '一条事项' }],
  ownersFail = false,
} = {}) {
  const calls = [];
  return {
    calls,
    async bootstrap() {
      calls.push('bootstrap');
      return bootstrap;
    },
    async owners() {
      calls.push('owners');
      if (ownersFail) throw new Error('拿不到名单');
      return { owners };
    },
    async listItems() {
      calls.push('listItems');
      return { items };
    },
  };
}

/** 已登录的状态替身：形状取自 createState()，值按用例需要覆盖。 */
function signedIn(over = {}) {
  return Object.assign(
    createState(),
    {
      account: { id: 1, username: '我', role: 'user' },
      capabilities: { seesAllItems: false, assignsOwner: false, managesAccounts: false },
      today: '2026-09-01',
      inviteCount: 2,
      owners: [{ id: 1, username: '我' }],
      items: [{ id: 1, title: '旧事项' }],
      anchor: { year: 2026, month: 7 },
    },
    over,
  );
}

/** 除声明重拉的字段外，其余字段必须原样。 */
function assertOnlyChanged(before, after, changed) {
  for (const [key, value] of Object.entries(before)) {
    if (changed.includes(key)) continue;
    assert.deepEqual(after[key], value, `${key} 不该被这次重拉改动`);
  }
}

describe('声明表', () => {
  test('登录之后一律全量：capabilities 与 inviteCount 一定被重拉', () => {
    const fields = fieldsFor('login');
    // f24d4e7 的根因就是这两项停在未登录时的值
    assert.ok(fields.includes('capabilities'));
    assert.ok(fields.includes('inviteCount'));
    // 「全量」是执行器能拉的全部字段，不是随手挑几项
    assert.deepEqual([...fields].sort(), [...RELOADABLE_FIELDS].sort());
  });

  test('self 事件重拉全部（能力与邀请角标都在里面）', () => {
    const fields = fieldsFor('self');
    assert.deepEqual([...fields].sort(), [...RELOADABLE_FIELDS].sort());
  });

  test('admin 事件重拉 owner 名单（外加事项与能力）', () => {
    assert.deepEqual(fieldsFor('admin'), ['items', 'owners', 'capabilities']);
  });

  test('items 事件只重拉事项', () => {
    assert.deepEqual(REFRESH_PLAN.items, ['items']);
    assert.deepEqual(fieldsFor('items'), ['items']);
  });

  test('日切只重拉 today（月份是本地视图，不跟着换）', () => {
    assert.deepEqual(fieldsFor('day'), ['today']);
  });

  test('表里只出现执行器认识的字段，且都是 state 的字段', () => {
    const shape = createState();
    for (const [trigger, fields] of Object.entries(REFRESH_PLAN)) {
      assert.ok(Array.isArray(fields) && fields.length, `${trigger} 得声明至少一个字段`);
      for (const field of fields) {
        assert.ok(RELOADABLE_FIELDS.includes(field), `表里出现没人提供的字段：${trigger} → ${field}`);
        assert.ok(field in shape, `表里出现 state 没有的字段：${trigger} → ${field}`);
      }
    }
  });

  test('触发名写错直接抛，不静默少拉', () => {
    assert.throws(() => fieldsFor('itemz'), /未知的刷新触发/);
    assert.throws(() => fieldsFor(['items', 'boot']), /未知的刷新触发/);
  });
});

describe('执行器', () => {
  test('items 触发：只发一次事项请求，别的字段一个都不动', async () => {
    const client = fakeClient();
    const target = signedIn();
    const before = structuredClone(target);
    await runRefresh('items', { client, state: target });
    assert.deepEqual(client.calls, ['listItems']);
    assert.deepEqual(target.items, [{ id: 7, title: '一条事项' }]);
    assertOnlyChanged(before, target, ['items']);
  });

  test('admin 触发：事项 + 名单 + 能力一起落地，bootstrap 顺带带回来的不写', async () => {
    const client = fakeClient();
    const target = signedIn(); // 有意给一份旧能力：这次重拉必须把它换掉
    const before = structuredClone(target);
    await runRefresh('admin', { client, state: target });
    assert.deepEqual(client.calls, ['bootstrap', 'owners', 'listItems']);
    assert.deepEqual(target.items, [{ id: 7, title: '一条事项' }]);
    assert.deepEqual(target.owners, [{ id: 1, username: '我' }]);
    assert.deepEqual(target.capabilities, AUTHED.capabilities);
    // 同一次 bootstrap 还带回了账号、角色、标签、今天、角标、锚点——没声明就不落地
    assertOnlyChanged(before, target, ['items', 'owners', 'capabilities']);
  });

  test('登录后 capabilities 与 inviteCount 一定落地（「管理」入口与邀请角标靠它们）', async () => {
    const client = fakeClient();
    const target = createState(); // 未登录形状：能力全 false、角标 0
    await runRefresh('login', { client, state: target });
    assert.equal(target.account.username, '我');
    assert.deepEqual(target.capabilities, AUTHED.capabilities);
    assert.equal(target.capabilities.managesAccounts, true);
    assert.equal(target.inviteCount, 3);
    assert.deepEqual(target.tags, ['工作']);
    assert.equal(target.today, '2026-09-18');
    assert.deepEqual(target.anchor, { year: 2026, month: 9 });
    assert.deepEqual(client.calls, ['bootstrap', 'owners', 'listItems']);
  });

  test('合并多个触发取并集：先到的 admin 不会被后到的 items 顶掉', async () => {
    const client = fakeClient();
    const target = signedIn();
    assert.deepEqual(fieldsFor(['admin', 'items']), ['items', 'owners', 'capabilities']);
    await runRefresh(['admin', 'items'], { client, state: target });
    assert.ok(client.calls.includes('owners'), 'owner 名单不能因为 120ms 内又来了一条 items 就漏拉');
  });

  test('会话没了（bootstrap 说未登录）：清成未登录形状，且不再去拉必然 401 的接口', async () => {
    const client = fakeClient({ bootstrap: { authenticated: false } });
    const target = signedIn();
    await runRefresh('self', { client, state: target });
    assert.deepEqual(client.calls, ['bootstrap']);
    assert.equal(target.account, null);
  });

  test('owner 名单拉不到时退到自己，不把别人的名字弄丢', async () => {
    const client = fakeClient({ ownersFail: true });
    const target = signedIn();
    await runRefresh('admin', { client, state: target });
    assert.deepEqual(target.owners, [{ id: 1, username: '我' }]);
  });
});

describe('state 的形状', () => {
  test('inviteCount 在初始形状里（以前靠别处赋值，漏了就停在 undefined）', () => {
    const shape = createState();
    assert.equal(shape.inviteCount, 0);
    assert.equal(shape.stream, null);
    assert.equal(shape.account, null);
  });

  test('createState() 每次都是新的一份，重置不会串到上一份', () => {
    const a = createState();
    const b = createState();
    assert.notEqual(a, b);
    a.items.push({ id: 1 });
    assert.deepEqual(b.items, []);
  });
});

describe('日切', () => {
  test('msUntilNextDay：到下一个本机午夜，多 1 秒余量', () => {
    assert.equal(msUntilNextDay(new Date(2026, 8, 18, 23, 59, 30)), 31_000);
    assert.equal(msUntilNextDay(new Date(2026, 8, 18, 12, 0, 0)), 12 * 3600 * 1000 + 1000);
    for (const hour of [0, 6, 12, 23]) {
      const ms = msUntilNextDay(new Date(2026, 11, 31, hour, 30, 0));
      assert.ok(ms > 0 && ms <= 24 * 3600 * 1000 + 1000, `${hour} 点的等待时长越界：${ms}`);
    }
  });

  test('日切重拉只换 today，不把用户翻到的月份抢回本月', async () => {
    const client = fakeClient({ bootstrap: authed({ today: '2026-09-19' }) });
    const target = signedIn({ today: '2026-09-18', anchor: { year: 2026, month: 7 } });
    await runRefresh('day', { client, state: target });
    assert.deepEqual(client.calls, ['bootstrap']);
    assert.equal(target.today, '2026-09-19');
    assert.deepEqual(target.anchor, { year: 2026, month: 7 });
  });
});

describe('重拉不引入重连', () => {
  test('执行器不碰 stream', async () => {
    const sentinel = { close() {} };
    const target = signedIn({ stream: sentinel });
    await runRefresh('self', { client: fakeClient(), state: target });
    assert.equal(target.stream, sentinel, '重拉不该动连接');
  });

  test('建流点只有一个：app.js 里 new EventSource 只出现一次', async () => {
    // 静态契约断言：`new EventSource(` 只在 connectStream() 里。局限是看不见动态构造
    // （当前没有这种写法）；行为那一半由下面两条用例守。
    const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
    const sites = source.match(/new EventSource\(/g) ?? [];
    assert.equal(sites.length, 1, 'EventSource 只该在 connectStream() 里建一次');
  });

  test('未登录的启动不建流', () => {
    assert.equal(streamsAfterFirstBoot, 0);
  });

  test('已登录的页面收到 self 事件：只按表重拉，不建第二条流、也不关掉现有连接', async () => {
    fetchHandler = (url) =>
      url.endsWith('/api/bootstrap') ? AUTHED : url.endsWith('/api/owners') ? { owners: [] } : { items: [] };
    await importSignedInApp();
    await sleep(0);

    assert.equal(streams.length, 1, '登录后的启动建一条流');
    const stream = streams[0];
    assert.equal(stream.url, '/api/events');
    const fetchesBefore = fetches.length;

    // 一束事件：items 与 self 落在同一个 120ms 窗口里（并集按 self 走 = 全量）
    stream.listeners.items();
    stream.listeners.self();
    await sleep(250);

    assert.equal(streams.length, 1, 'self 事件不该建第二条流（以前它会走 boot() → connectStream）');
    assert.equal(stream.closed, false, 'self 事件不该关掉现有连接');
    assert.equal(fetches.length, fetchesBefore + 3, 'self 该全量重拉：bootstrap + 名单 + 事项');
  });
});
