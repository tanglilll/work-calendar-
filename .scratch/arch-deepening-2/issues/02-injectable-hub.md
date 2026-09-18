# 02 — 广播中枢可注入

**What to build:** 把 SSE 广播中枢从模块级状态变成组合根建好、注入进 `routes` 的一个 module，让「某次变更之后谁收到了什么」第一次可以被断言。这是段一后三张票（B、C、D 里改推送行为的那些）的验收基础——尤其 C 是那个「未构造复现」的候选，没有这个接缝就只能靠代码审阅结案。

**Blocked by:** None — can start immediately.（计划上排在 01 之后、B/C 之前）

**Status:** ready-for-agent

## 形状

- `createSse()` 返回 `{ addClient, publish, broadcastToAccount, startHeartbeat, closeAll }`。
- 组合根（`server/app.js`）建好中枢并注入 `routes`；`server/routes.js` 不再 `import { addClient, publish } from './sse.js'`（对照：items / accounts / sessions / invites 早已是注入的）。
- 心跳由入口层用中枢起（现在 `server/index.js` 直接调 `startHeartbeat`）。
- 中心的判据仍是 `visibility.js`，这轮不改它的规则。

## 验收标准

- [ ] 两个 `createApp`（各自 `:memory:`）各持一套中枢：向 A 的客户端 `publish`，B 的客户端**收不到**（今天的代码会串台，这条要先红）。
- [ ] 能断言「一次 publish 之后，哪些客户端收到了什么事件」——中枢暴露必要的观察面（例如返回客户端快照，或在测试里以桩 res 记录写入），断言不依赖真实网络。
- [ ] `routes.js` 里不再有对 `sse.js` 的直接 import（判据可由静态检查或评审确认，写进工单）。
- [ ] 入口层的错误映射有可测接缝：`>= 500` 不外泄内部错误码、只有业务错误带 `code` / `fields`——两条各有断言（今天测试绕过 `index.js`，这条规则无回归网）。
- [ ] 全量套件全绿。
- [ ] 一笔提交进 `main`。
