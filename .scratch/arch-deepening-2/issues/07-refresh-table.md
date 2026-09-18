# 07 — 状态与重拉的归属

**What to build:** 把「哪个事件之后要重拉 state 的哪些字段」从散在八处的分支收成**一张声明表**，由一个执行器按表执行。今天的散落已经造成过实际损失：上一轮四处界面修复里有三处是同一根因——登录走 `enterApp()` 而不是 `boot()`，`capabilities` 停在初始值，「管理」入口要刷新才出现。

**Blocked by:** None（与 06 无文件重叠；计划上排在 06 之后）

**Status:** ready-for-agent

## 形状

- 一张表：`items` 事件 → 只重拉事项；`admin` 事件 → 事项 + owner 名单 + 能力；`self` 事件 → 全部（含 capabilities 与邀请角标）；**登录之后一律全量**。一个执行器按集合执行。
- 表是纯映射，可直接断言「登录后 capabilities 一定被重拉」。
- `state` 的形状与写入权在同一处写明（今天 `state` 的字面量里甚至没有 `inviteCount`，它在别处被赋值、又在另一处被读）。
- `today` 的归属一并定：日切（跨午夜）时的行为要有落点。
- **刻意不碰 SSE 连接逻辑**：`boot()` 目前同时取状态与建流，这轮不拆它，避免引入重连循环；声明表只决定「重拉哪些字段」。

## 验收标准

- [x] 声明表存在，且 `refresh` / `boot` 的调用点不再各自决定重拉范围（散落的八处分支消失）。
- [x] 断言：登录后 `capabilities` 与 `inviteCount` 一定被重拉（这正是 `f24d4e7` 的根因）；`admin` 事件重拉 owner 名单；`items` 事件只重拉事项。
- [x] `state` 的形状与写入权在同一处写明，且 `inviteCount` 出现在初始形状里。
- [x] `today` 的日切有落点（至少写明行为与触发点），并有断言或明确的「本轮不做」说明。
- [x] 回归：**不引入重连**——`boot()` 未拆（取状态与建流仍在同一处），但**没有任何事件路径调用它**；断言层三条（见下「四」），浏览器冒烟按分工由主 agent 在段界确认。
- [x] 全量套件全绿；一笔提交进 `main`。

## 结论与证据

**范围**：只改 `public/app.js`（唯一源码文件）+ 新增 `test/refresh.test.js`。`public/itemform.js` /
`admin.js` / `invites.js` / `api.js` / `session.js` 与 `server/` 一行未动（没有出现「非改不可」的地方）。

### 一、声明表长什么样（`public/app.js:143` 的 `REFRESH_PLAN`）

| 触发 | 什么时候 | 重拉字段 |
| --- | --- | --- |
| `items` | 事项有增删改（SSE `items` 事件；本机刚写完一条事项；打开事项时本地找不到它） | `items` |
| `admin` | 账号、注册申请有变（SSE `admin` 事件） | `items` `owners` `capabilities` |
| `self` | 自己的账号状态变了（SSE `self` 事件；接受 / 拒绝邀请之后） | 全部 |
| `login` | 登录之后 | 全部（一律全量） |
| `day` | 跨过午夜（日切定时器） | `today` |

「全部」= `RELOADABLE_FIELDS`（`public/app.js:125`），由装载器表派生：`account` `capabilities` `roles`
`tags` `palette` `today` `anchor` `inviteCount` `owners` `items`。所以「登录后 `capabilities` 一定被重拉」
不是靠人记得，而是 `login` 这一格等于全部可重拉字段。

原「八处」逐个数是十处，现在都只报「什么变了」：

| 以前（各自决定范围） | 现在 |
| --- | --- |
| 模块顶层 `boot()` → 全量 + 建流 | `boot()` = `reload('login')` + 建流 |
| `onLogin` → `boot()` | `boot()`（同上，一处） |
| `connectStream` 的 `items` → `scheduleRefresh()` | `reloadSoon('items')` |
| `connectStream` 的 `admin` → `scheduleRefresh()` + `loadOwners()` | `reloadSoon('admin')` |
| `connectStream` 的 `self` → `boot()`（**会重建流**） | `reloadSoon('self')`（不建流） |
| `enterApp()` → `loadOwners()` + `refresh()` | 折进 `boot()`，不再单独存在 |
| `openItemDialog` 的 `onDone` → `refresh()` | `reload('items')` |
| `openItem` 本地找不到 → `refresh()` | `reload('items')` |
| `openAdminDialog` 的 `onDone` → `refresh()` | `reload('items')` |
| `openInvitesDialog` 的 `onDone` → `boot()`（**会重建流**） | `reload('self')` |

`refresh()` / `scheduleRefresh()` / `loadOwners()` / `enterApp()` 四个「自己带范围」的函数都不存在了。

### 二、执行器怎么用

- 调用点只报「什么变了」：`reload('items')` / `reload('self')` / `boot()`。
- `fieldsFor(triggers)`（`app.js:155`）：把若干触发并成一个字段集合——SSE 事件成串到达，120ms 窗口内
  取**并集**（先到的 `admin` 不会被后到的 `items` 顶掉）；触发名与字段名写错直接抛，不静默少拉。
- `runRefresh(triggers, { client, state })`（`app.js:175`）：按装载器表（`app.js:82`）执行。
  装载器表三格 = 最多三次请求（会话组 `/api/bootstrap`、`owners`、`items`），**只写声明表要到的字段**：
  `admin` 触发顺带从 bootstrap 拿回的 `tags` / `today` / `inviteCount` / `anchor` 一律不落地。
- 装载器次序固定「会话 → 名单 → 事项」（名单拿不到时会退到当前账号，会话得先落地）。
  `providesSession` 那格拿回「未登录」时 `clearSession()` 收尾并结束本轮：未登录不再去拉必然 401 的
  事项与名单，首次打开也不会在登录页上糊一条「登录已失效」。
- `state` 的形状与写入权在 `createState()`（`app.js:47`）的文档注释里写明，`inviteCount: 0` 进了初始形状
  （以前不在字面量里，漏赋值就停在 `undefined`）；`clearSession()` 用 `Object.assign(state, createState())`
  重置，未登录形状只有那一处定义。

### 三、三条断言（`test/refresh.test.js`）

| 断言 | 防的是 |
| --- | --- |
| 登录后 `capabilities` 与 `inviteCount` 一定被重拉：表里 `fieldsFor('login') == RELOADABLE_FIELDS`，执行器里两项的值确实来自 bootstrap | `f24d4e7` 的根因——登录只做局部重拉，能力与角标停在未登录时的值，「管理」入口要刷新才出现 |
| `admin` 事件重拉 owner 名单：`fieldsFor('admin')` 含 `owners`，执行器确实请求 `/api/owners` 并写回 | 批准新账号后事项对话框里的 owner 名单不更新 |
| `items` 事件只重拉事项：表只有 `items`；执行器只发一次 `listItems`，其余字段逐项比对为原样 | 范围又散回调用点：事件路径顺手多拉（或漏拉）别的字段 |

另有一条把「表 ↔ state 形状」钉住：表里出现的每个字段都必须是 `RELOADABLE_FIELDS` 的一员、且是
`createState()` 的字段（写错字段名会被它和 `fieldsFor` 一起逮住）。

### 四、为什么不重连

1. **重拉路径碰不到连接**：`stream` 不在任何装载器里，`runRefresh` 只写声明表要到的字段
   （判据：给 `state` 放一个哨兵 `stream`，跑一次 `self` 全量重拉后原样不动）。
2. **事件路径不再调用 `boot()`**：以前 `self` 事件与邀请对话框收尾都走 `boot()` → `connectStream()` →
   先关旧流再建新流（一次真重连）；现在它们走 `reloadSoon` / `reload`，只改字段。
3. **建流点唯一**：`new EventSource(` 在 `app.js` 里只出现一次（`connectStream()`，`app.js:261`），
   而 `connectStream()` 只被 `boot()` 调用；`boot()` 只被模块顶层与 `onLogin` 调用。
4. **端到端那一条**：查询串再导入一份「已登录」的 app.js，EventSource 替身记下建流；派发 `items` +
   `self` 两个事件后——连接数仍是 1、旧连接 `closed === false`、接口按 `self` 全量重拉了三条
   （bootstrap + owners + items）。
5. **不重连不会看到越权数据**：事项与角标都由 REST 重拉，服务端 `ownerScope` 按**当前**角色过滤；
   SSE 只用来触发重拉。所以「连接保留」的安全前提是服务端 C 票（推送时取权威 role），与本票一致。

关于判据里「`boot()` 与建流仍然是分开的调用路径」：`boot()` 内部仍是「取状态 → 建流」一条路
（没有拆开、也没有新增可被事件路径单独调用的建流入口，`enterApp()` 折进 `boot()`）；要守的实质是
**事件路径不建流**，即上面 1–4 条。这里如实标出与字面的差异。

### 五、`today` 的处置（日切有落点了）

- `today` 的权威来源是服务端下发（`/api/bootstrap` 的 `todayLocal()`），属于会话组字段。
- 日切：`msUntilNextDay(now)`（`app.js:473`）算到下一个**本机**午夜（+1 秒余量），`scheduleDayRollover()`
  （`app.js:483`）到点触发 `reload('day')` —— 只重拉 `today`，再排下一次；`clearSession()` 会停掉它。
- **不动 `anchor`**：日切只换「今天是哪天」，用户翻到的月份保留（`day` 那一格只有 `today`，
  判据里用 `anchor` 仍是 2026-07 断言）。
- 断言两条：`msUntilNextDay` 的算术（23:59:30 → 31 秒；正午 → 12 小时 + 1 秒；任何时刻落在 (0, 24h+1s]），
  以及日切重拉只写 `today`。

### 六、如实记下的行为差异

1. **登录时机**：以前先 `showAuthOff()` 再把名单与事项填进去（先切界面后填内容），现在拉齐了才切
   （少一次空看板闪烁）。登录接口本身失败时仍走 `catch` 把消息写在登录表单上。
2. **`self` 事件不再重建流**（旧：`boot()` → 关旧流建新流）。这是本票要的收敛；若冒烟发现角色变更后
   界面没跟上，先看 `/api/bootstrap` 有没有拿到新 `capabilities`，不要去把 `boot()` 塞回事件路径。
3. **登出 / 会话失效时状态整份重置**（旧：只清 `account` / `items` / `capabilities` / `inviteCount`）：
   `tags` / `roles` / `palette` / `today` / `owners` 也回到未登录形状。未登录界面不读它们，下一次
   `boot()` 全量覆盖。
4. **日切定时器是新增的**（旧：完全没有）——页面长开跨午夜时「今日任务」与日历上的「今天」不再错位。
5. **已知边界（不在本票能修的范围）**：删账号会级联删掉指向某人的邀请（`server/db.js` 的
   `ON DELETE CASCADE`），但服务端此刻只发 `to: 'admins'` 的变更，非 admin 的角标要等下一次
   `self` / 全量才准。本票的表按 spec 的枚举（`admin` → 事项 + 名单 + 能力），要修这个得让服务端把
   受影响账号加进 `to: 'accounts'`，属服务端票；届时前端只改 `REFRESH_PLAN` 一格。

### 七、红→绿（不改仓库源码，在临时副本上注入 7 个回归）

| 注入的回归 | 红掉的判据 |
| --- | --- |
| `login` 不再全量（改成 `['items','owners']`） | 登录后 capabilities/inviteCount 两条 + 端到端那条（3 红） |
| `items` 顺手多拉 `owners` | 「items 只重拉事项」+「items 触发只发一次事项请求」（2 红） |
| `admin` 不再拉 `owners` | 「admin 重拉 owner 名单」+「admin 三项一起落地」+「并集」三条（3 红） |
| 执行器不过滤、写整份 patch | 「admin 顺带带回来的不写」+「日切只换 today」（2 红） |
| `self` 事件改回走 `boot()`（重连回归） | 端到端「不建第二条流、不关旧连接」（1 红） |
| `day` 那一格加上 `anchor` | 「日切只重拉 today」两条（2 红） |
| `createState()` 去掉 `inviteCount` | 「inviteCount 在初始形状里」+「表 ↔ state 字段对齐」（2 红） |

### 八、证据

- `node --test test/refresh.test.js` → **21 项通过、0 失败**（声明表 7 + 执行器 6 + state 形状 2 +
  日切 2 + 不重连 4；含上面那条端到端）。
- `npm test` → **222 项通过、0 失败**（并发波次中：161 基线 + 本票 21 + 同波次其它线）。
- 本票文件：`public/app.js`（声明表 `:143`、执行器 `:175`、装载器表 `:82`、state 形状 `:47`、
  日切 `:473`/`:483`）、`test/refresh.test.js`。
