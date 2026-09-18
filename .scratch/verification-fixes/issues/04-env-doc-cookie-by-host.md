# 04 — 环境文档补「cookie 不按端口」一节

**What to build:** 环境文档里补一节，讲清同一台机器上并行跑多个实例时登录态互相顶掉这件事——它是并行验证时「登录态莫名丢失」的根因，也是会话失效判据那张票的背景。

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] 三段齐备：
  - [x] **症状**：页面仍显示着登录态、动作却报「请先登录」，而服务端会话表里没有对应那一行。
  - [x] **成因**：会话 cookie 只按主机名区分、不按端口——任何一方在浏览器里登录，都会把别人在这个主机名上的 cookie 换掉；反过来自己也顶别人。
  - [x] **规避**：给每个身份一个不同的主机名（例如 `localhost` 与 `127.0.0.2`），或接受它并在每次动作前确认登录态。
- [x] 症状一段与本轮的会话失效票（02）保持一致：它完成前写「停在僵尸登录态」，完成后写「提示并回登录页」。**写之前先看 02 的状态行**，别把修前行为写成现状。
      → 按协调者指令改为**状态中立的写法**：「会话失效后界面怎么收尾（提示并回登录页）由本轮工单 02 处理」；写作时 02 的状态行是 `ready-for-agent`，故既没有把「僵尸登录态」写成产品现状，也没有断言已修好。
- [x] 交叉引用 02，指向那个修正。
- [x] 不回退既有四节的内容，也不与它们重复。
- [x] 工单里回指出处：本票来自 `.scratch/closeout/issues/04-version-conflict-ui.md` 附带发现的第 2 条——那票把「是否并进环境文档」留给维护者定，本次决定：并进去。

## 结论

在 `docs/agents/local-environment.md` 末尾新增 **§5「会话 cookie 只按主机名区分、不按端口：同机并行实例会互相顶掉登录态」**（行 156–183），三段齐备：

- **症状**：顶栏仍显示登录态（实测 `admin（admin）`）而动作统一返回 `401 请先登录`；服务端 `sessions` 表里只有本实例自己那条登录记录（`created_at 2026-09-18T01:43:34Z`），浏览器带上来的 token 没有对应行；给出旁证（同一主机名上另有 4410 / 4700 / 4800 在监听、`data/` 下多个 `verify-*.db`）与「`200` 后紧接着 `401`」的发作时机；末条指明界面侧收尾归工单 02。
- **成因**：`rili_session` 的 `Set-Cookie` 无 `Domain`，是 host-only cookie（`server/auth.js` 的 `sessionCookie`）；浏览器给 cookie 分桶的键是（主机名，路径），**端口不参与**，故同一主机名不同端口共用一个桶、双向互顶；并说明 §1 的隔离实例只隔离进程与 `RILI_DB`，cookie 是唯一落在浏览器侧的隔离维度；末尾更正上一轮「内嵌浏览器随机丢 cookie」的归因（token 从没丢，是被换掉）。
- **规避**：给每个身份一个不同主机名（`HOST=127.0.0.2` ↔ 地址栏 `127.0.0.2`；`HOST=0.0.0.0` ↔ 地址栏 `localhost`），含 `HOST` 与地址栏必须配套的提醒；或接受它、每次动作前确认登录态；或用 `curl` 各自带 cookie jar 发起「他人」的动作；附两条已知效果（工单 04 改绑后整轮未复现、工单 05 换 `localhost` 后只留被观察身份）。

**与既有四节如何区分**：不碰 §1 的进程管理（只在成因里回指它的隔离边界），不重复 §2 的 CDN、§3 的 `node:sqlite` 原型、§4 的 GitHub 代理；新节只讲浏览器侧 cookie 的归属这一个维度。

**界面侧行为的写法**：不断言已修/未修，只写「会话失效后界面怎么收尾（提示并回登录页）由本轮工单 02 处理」，并交叉引用 `.scratch/verification-fixes/issues/02-session-expiry-single-predicate.md`。这样 02 完成前后这句话都成立。

**来源标注**：新节末以「**来源**（2026-09-18，上一轮观察，本次未做对照复现）」收尾，与文档开头「实测复现过的给命令；只来自上一轮观察……会标明来源」的承诺同口径，并写明「是否并进由维护者定、本轮决定并入」。

**一处短语级追加**：文档开头范围枚举补入「浏览器侧的 cookie 归属」，让索引与新节一致；既有四节正文一字未动。

**未做的**：没有起服务、没有用浏览器、没有跑测试（纯文档改动，不碰代码）；按共享工作区约束，未运行任何改变 git 状态的命令。

## 证据

- `docs/agents/local-environment.md:156-183`——新增 §5 全文（症状 / 成因 / 规避 / 来源四段）。
- `docs/agents/local-environment.md:163`——交叉引用 02 的那句。
- `docs/agents/local-environment.md:3`——范围枚举追加「浏览器侧的 cookie 归属」。
- 事实核对（只读文件，未复现）：
  - `.scratch/closeout/issues/04-version-conflict-ui.md:84-90`：现象、`sessions` 表核对、邻座实例端口 4410/4700/4800 与多个 `verify-*.db`、改绑 `127.0.0.2` 后未复现、「是否并进由维护者定」。
  - `.scratch/closeout/issues/03-admin-panel-verification.md:180,207,209`：并列记录工单 04/05 的撞到与规避，并更正「IAB 随机丢 cookie」的归因。
  - `.scratch/closeout/issues/05-sse-visibility-and-invite.md:33-38,155-157,177`：浏览器侧改 `localhost`、他人动作走 `curl` + cookie jar。
  - `server/auth.js:66-78`：`rili_session` 的 `Set-Cookie` 只有 `Path=/; HttpOnly; SameSite=Lax; Max-Age=…`，无 `Domain`——host-only 的依据。
  - `server/index.js:20,92-93`：`HOST` 默认 `0.0.0.0`，服务绑到传入的地址。
