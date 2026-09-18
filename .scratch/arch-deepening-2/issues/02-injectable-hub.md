# 02 — 广播中枢可注入

**What to build:** 把 SSE 广播中枢从模块级状态变成组合根建好、注入进 `routes` 的一个 module，让「某次变更之后谁收到了什么」第一次可以被断言。这是段一后三张票（B、C、D 里改推送行为的那些）的验收基础——尤其 C 是那个「未构造复现」的候选，没有这个接缝就只能靠代码审阅结案。

**Blocked by:** None — can start immediately.（计划上排在 01 之后、B/C 之前）

**Status:** resolved

## 形状

- `createSse()` 返回 `{ addClient, publish, broadcastToAccount, startHeartbeat, closeAll }`。
- 组合根（`server/app.js`）建好中枢并注入 `routes`；`server/routes.js` 不再 `import { addClient, publish } from './sse.js'`（对照：items / accounts / sessions / invites 早已是注入的）。
- 心跳由入口层用中枢起（现在 `server/index.js` 直接调 `startHeartbeat`）。
- 中心的判据仍是 `visibility.js`，这轮不改它的规则。

## 验收标准

- [x] 两个 `createApp`（各自 `:memory:`）各持一套中枢：向 A 的客户端 `publish`，B 的客户端**收不到**（今天的代码会串台，这条要先红）。
- [x] 能断言「一次 publish 之后，哪些客户端收到了什么事件」——中枢暴露必要的观察面（例如返回客户端快照，或在测试里以桩 res 记录写入），断言不依赖真实网络。
- [x] `routes.js` 里不再有对 `sse.js` 的直接 import（判据由静态检查断言：`test/sse.test.js` 里读源码确认，见结论）。
- [x] 入口层的错误映射有可测接缝：`>= 500` 不外泄内部错误码、只有业务错误带 `code` / `fields`——两条各有断言（今天测试绕过 `index.js`，这条规则无回归网）。
- [x] 全量套件全绿。
- [x] 一笔提交进 `main`。

## 结论

- **形状**：`server/sse.js` 只导出 `createSse({ heartbeatMs? })`，返回
  `{ addClient, publish, broadcastToAccount, startHeartbeat, closeAll }`。
  连接表 `clients` 从模块级 `Set` 变成 `createSse()` 闭包里的 `Set`——
  这是本票的全部要害：模块级 Set 被同一进程里所有组合根共享，A 实例的广播会写到
  B 实例的客户端上。`broadcastItems` / `broadcastAdmin` 收成闭包内的私有函数
  （不再导出：对外只有 `publish` 一条投递策略入口 + `broadcastToAccount` 这条定向路径）。
  `heartbeatMs` 是唯一的额外参数，**理由是可测**：真实间隔 25 秒，测试等不起；
  除此之外接口就是工单写死的五个方法。
- **组合根**：`server/app.js` 里 `const sse = createSse()`，随其余 module 一起
  `createApi({ items, accounts, sessions, invites, sse })`；返回的 app 上挂 `sse`（测试与入口都要用）。
  `app.close()` 先 `sse.closeAll()` 再 `store.close()`。
  `server/routes.js` 删掉 `import { addClient, publish } from './sse.js'`，14 处
  `publish(changed)` → `sse.publish(changed)`、`addClient` → `sse.addClient`，
  与 items / accounts / sessions / invites 一样只认注入的依赖。
- **入口**：`server/index.js` 的 `startHeartbeat` import 删掉，改为 `app.sse.startHeartbeat()`。
  同时给入口层抽出两个可测接缝：`errorResponse(err)`（纯函数，错误 → `{ status, message, extra }`）
  与 `createRequestHandler({ app, publicDir })`（那条 `/api/*` + 静态文件的处理函数）。
  为了让测试能 import 它们而**不开端口、不碰数据库**，所有启动副作用（createApp / listen /
  bootstrap / 心跳 / 信号处理）都收进 `main()`，由 `if (import.meta.main) main()` 守着——
  Node 24 起可用（`engines` 已要求 `>=24`），`node server/index.js` 与 `npm start` 行为不变。
- **一处刻意的收紧**：原先 `isAppError = Number.isInteger(err.status)` 与 `status >= 500`
  是两个独立判据，于是「带整数 status 500 + code」的错误仍会把 code 外泄。现在业务错误的
  定义是「整数 status **且** < 500」，>= 500 一律 `服务器内部错误` 且不带 code / fields。
  真实路由里没有 5xx 的业务错误（全部 4xx），所以这是纯收紧。
- 新增断言 10 条：`test/sse.test.js` 5 条（串台、逐条投递、closeAll、心跳归属、源码静态检查）、
  `test/http-entry.test.js` 5 条（5xx 不外泄 / 无 status 也按 5xx / 业务错误带 code+fields /
  真实组合根下的业务错误 / `errorResponse` 纯函数）。

## 证据

**先红**。第一条判据写的是「在 A 里建一条事项，A 的客户端收到 items 事件，B 的客户端只该有 hello」，
跑 `node --test test/sse.test.js`：

```
▶ SSE 广播中枢
  ✖ 向 A 的客户端 publish，B 的客户端收不到 (248.7885ms)
✖ failing tests:
✖ 向 A 的客户端 publish，B 的客户端收不到 (248.7885ms)
  AssertionError [ERR_ASSERTION]: B 的客户端不该收到 A 的事件：两个组合根各持一套中枢
  + actual - expected

    [
      'hello',
  +   'items'
    ]

      at TestContext.<anonymous> (file:///D:/rili/test/sse.test.js:150:12)
  actual: [ 'hello', 'items' ]   expected: [ 'hello' ]   operator: 'deepStrictEqual'
ℹ tests 1  ℹ pass 0  ℹ fail 1
```

红的正是串台本身：B 的桩 res 上收到了 A 实例发的事件（两个 app 共享模块级 `clients`）。
改成 `createSse()` 后同一命令：

```
▶ SSE 广播中枢
  ✔ 向 A 的客户端 publish，B 的客户端收不到 (253.8563ms)
ℹ tests 1  ℹ pass 1  ℹ fail 0
```

**注入后怎么断言投递**。不开网络：桩 res 记录写出的字节，`events()` 按 SSE 的 wire format
（`event:` / `data:` 行）解析成 `{ event, data }` 列表，断言面对的就是「客户端实际收到的事件」。
两条判据各走不同的投递入口：
1. 经真实路由：zhao 登录 → `GET /api/events` 建连接 → `POST /api/items` 建事项，
   断言 A 的客户端 `['hello','items']`、B 的客户端 `['hello']`；并断言 `a.app.sse !== b.app.sse`。
2. 经中枢直接投递：同一实例上挂 zhao（user）/ lin（user）/ admin 三条连接，逐条 publish 后断言
   ——`itemOwners` 事件到 zhao 与 admin、不到 lin；`admins` 事件只到 admin；`broadcastToAccount(lin)`
   只到 lin 且不外溢到 zhao；`emit('close')` 之后该客户端被移出连接表、其余照常收到。
   顺带覆盖 `closeAll()`（连接被 end、之后 publish 不再写入）与心跳只写自己这套中枢的客户端
   （`createSse({ heartbeatMs: 5 })` + 另一套中枢的空闲桩 res 收不到 `: ping`）。

**入口层两条断言**（`test/http-entry.test.js`，import `server/index.js` 的接缝，不启服务）：
- 存储层形状的错误（`status: 500` + `code: 'SQLITE_CONSTRAINT_UNIQUE'` + `fields`）→
  `500` / `服务器内部错误` / `error.code === undefined` / `error.fields === undefined`；
  没有 `status` 的 `TypeError` → `{ error: { message: '服务器内部错误' } }`（连字段都不多一个）。
- `httpError(409, …, { code: 'version_conflict', fields: { version: 3 } })` → 409 且 message / code / fields 原样；
  真实组合根 + 真实路由下，未登录 `GET /api/items` → 401 `请先登录`、错密码登录 → 401
  `用户名或密码不正确` 且**不带**凭空造的 `code`。

**源码静态检查**（同文件）：`routes.js` 与 `index.js` 都不含 `from './sse.js'`，
只有 `app.js` 里出现 `createSse()` 与 `createApi({ …, sse })`——把「中枢归组合根」钉成回归网。

**全量**：`npm test` → `tests 171  suites 45  pass 171  fail 0`（基线 161 + 本票新增 10 条，无 fail）。
换行符与其它文件保持 LF，`git status` 只列出本票的四个源文件 + 两个新测试文件。

## 主 agent 核对（2026-09-18）

- **提交范围**：`b716edc`，7 个文件全是本票的（`server/sse.js` / `app.js` / `routes.js` / `index.js` + `test/sse.test.js` / `test/http-entry.test.js` + 本票）；提交后工作区干净。全量套件 **223 项全绿**（含同波次其它线）。
- **真实实例复核**（主 agent 起了一次性实例 `127.0.0.1:4960`，验完即停、库与日志已删）：`GET /` → 200、`GET /api/bootstrap` → 200，载荷里 `limits` 已是完整九项（含 `PROGRESS_MAX: 500`）——同时确认入口守卫没把 `npm start` 弄坏，以及工单 01 的 bootstrap 修复在真实接口上生效。
- **补的一处：`import.meta.main` 的版本下限。** 查 Node v24 文档：**Added in v24.2.0，Stability 1.0（Early development）**。而 `engines` 原先写 `>=24`——在 24.0 / 24.1 上它是 `undefined`，`main()` 永不执行、`npm start` 会**一声不响地不服务**。已把 `engines` 抬到 `>=24.2.0`，README 的「需要 Node 24+」改成 24.2+ 并注明依据。这是本票引入的新依赖，属本票收口范围。
- **一处行为收紧已确认无回归面**：业务错误现在是「整数 status 且 < 500」，于是「整数 500 + code」也不再外泄 code；真实路由里全是 4xx。

