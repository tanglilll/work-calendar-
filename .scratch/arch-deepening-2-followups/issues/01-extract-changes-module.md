# 01 — 变更词表与 owner 差分抽成 `server/changes.js`

**What to build:** 把「变更描述」这层从广播中枢里抽出来，成为它自己的 module：变更词表、构造函数、owner 差分住进 `server/changes.js`，生产者（items / invites / accounts / auth）与中枢（sse）都从它 import。今天它们都住在 `server/sse.js` 里，于是 `auth.js` 为了构造一条变更不得不 import 广播中枢——会话模块挂到了投递层上。

**Blocked by:** None — can start immediately.（**要先做**：02 与 03 都要往词表里加东西，先抽完它们才有最终落点）

**Status:** ready-for-agent

## 形状

- 新 module `server/changes.js` 拥有：`TARGET`（去向闭集）、`CHANGE_KINDS`、构造函数（`ownerChanged` / `adminsChanged` / `accountChanged` / `accountDeleted`）、构造标记、`isChange`、owner 差分（`ownerDiff` / `ownerChanges`）。
- `server/sse.js` 从它 import，只保留投递（连接表、`deliver`、按账号断开、心跳、`publish` 的分发）。`publish` 仍是唯一策略入口。
- 四个生产者改从 `changes.js` import；**`auth.js` 不再 import `sse.js`**。
- 这是 arch-deepening-2 工单 03 里被追认的那条依赖的**替代方案**——那票记下「抽独立 module 成本很低，本轮不做」，本票就是做掉它。做完后那条追认理由失效，票里要写明。

## 验收标准

- [ ] `server/changes.js` 存在，词表、构造函数、owner 差分都在它里面；`server/sse.js` 里不再有它们的定义（只有 import 与使用）。
- [ ] `auth.js` 不再 import `sse.js`；四个生产者（`items` / `invites` / `accounts` / `auth`）都从 `changes.js` 拿构造能力。
- [ ] **判据**：静态检查断言「`sse.js` 不导出词表与构造函数」「`auth.js` 的 import 里没有 `sse.js`」——这两条正是本票要钉住的依赖方向。
- [ ] 既有断言全绿且**不需要改语义**（`test/change-vocabulary.test.js` 只改 import 路径；`test/sse.test.js` 的投递断言不变）。若某处必须改语义，停下来报告。
- [ ] 全量套件全绿（基线 278 项 + 新增）。
- [ ] `README.md` 的「代码结构」补 `changes.js` 一行，并相应调整 `sse.js` 那行的描述（它不再拥有词表）。
- [ ] 一笔提交进 `main`，提交信息写明「为什么这不是搬家：`auth.js → sse.js` 这条依赖方向被消掉，且词表有了自己的 test surface」。
