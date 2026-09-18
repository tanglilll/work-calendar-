# 04 — viewer 的权威来源

**What to build:** 推送给谁不再读「连接那一刻的 role 快照」，改为推送时取权威值；三条投递路径（事项事件、admin 事件、账号定向）走同一处判据。今天的缺口是：把一个人从 `admin` 降为 `user`，他的旧连接**仍然收到 admin 事件**——「可见性在服务端过滤、前端不被信任」这条承诺在长连接上漏了。

**Blocked by:** 02（可注入的中枢才能断言「谁收到了什么」）、03（变更由词表构造）

**Status:** resolved

## 形状

- 判据仍在 `visibility.js`（不改它的规则），改的是**它的输入**：viewer 的 role 在推送时取权威值，而不是连接时存下的副本。
- `broadcastToAccount` 自己做的 `client.accountId === accountId` 比较并入判据——三条路径同源。
- **角色变更 → 重判**：连接保留，被降权者的旧连接立刻收不到 admin 事件。
- **账号删除 → 断开**：中枢提供按账号断开的能力（会话已不存在，留着只是占着句柄）。
- **不改变**「可见性在服务端过滤」这条不变量，也不改 SSE 的传输方式。

## 验收标准

- [x] **先复现**：一条判据证明「降权后，该账号的旧连接仍然收到 admin 事件」（红）——在 02 提供的接缝上构造，不靠代码推理。
- [x] 修后同一条判据转绿：降权后旧连接收不到 admin 事件；且该连接**仍然收得到**它按新角色应得的事项事件（不能把连接整个打死）。
- [x] 删账号 → 该账号的连接被断开（有断言：中枢按账号断开的调用发生、且之后不再写入）。
- [x] 三条投递路径（`broadcastItems` / `broadcastAdmin` / `broadcastToAccount`）都经过同一处判据；`sse.js` 里不再有自己做的账号比较。
- [x] 回归：`user` 收不到他人事项事件这条既有断言仍绿。
- [x] 全量套件全绿。
- [x] 一笔提交进 `main`；提交信息写明「这是上一轮 visibility 收口没画完的那一半：判据的输入本身会是过期副本」。

## 结论与证据

### 一、viewer 的权威从哪来、为什么是这个形状

**依赖**：`createSse({ roleOf })` —— `roleOf(accountId) => role | null` 由组合根注入
（`server/app.js`：`createSse({ roleOf: (accountId) => accounts.roleOf(accountId) })`），
实现落在 `server/accounts.js` 的 `roleOf`（`SELECT role FROM accounts WHERE id = ?`，
账号不存在返回 `null`）。中枢**不 import accounts.js**：依赖是接受的，不是自己创建的。

**为什么是 `roleOf` 而不是 `viewerOf` 或整个 `accounts`**：判据要的 viewer 是
`{ accountId, role }`，其中 `accountId` 本来就是连接的身份（不会过期），会过期的只有 `role`
这一半 —— 依赖面因此收到最小：一个按 id 取权威角色的函数。

**为什么是「每次推送现查」而不是「角色变更时更新连接表里的副本」**：后者要么让
accounts 反向持有中枢（循环依赖），要么引入一个「何时刷新」的时机问题 —— 都只是把
陈旧的窗口换个位置。现查之后，**连接里根本没有 role 可读**（静态断言 `client.role`
不出现），陈旧副本在结构上不可能存在。

**判据本身没有被改规则**：`visibility.js` 的 `canReceiveEvent` 规则一字未动
（admin → `managesAccounts`；items → `seesAllItems || ownerId === accountId`），
只多了两件事：viewer 为 `null`（账号已删）一律 false；`scope === 'self'` 由判据裁决
收件账号（这句比较原来住在 `sse.js` 的 `broadcastToAccount` 里，现在`event.accountId`
进事件、比较归判据）。

**时间点**：`hello` 仍回执连接那一刻的会话角色（握手回执，不参与任何投递判据）；
连接记录只留 `{ res, accountId }`。`createSse` 缺 `roleOf` 直接抛 `TypeError`，
不静默降级成「谁都不发」。

### 二、先红那次的输出（未改任何 src 时的原样）

`node --test test/viewer-authority.test.js`：

```
✖ 降权后旧连接不再收到 admin 事件，且仍收到定向的 self 事件
  AssertionError: 降权后旧连接仍然收到 admin 事件（连接里存的是连接那一刻的 role 快照）
  + [ { data: { kind: 'accounts', scope: 'admin' }, event: 'admin' } ]
  - []
✖ 删账号之后该账号的连接被结束，且不再向它写入
  AssertionError: 账号已删除，它的连接应当被断开而不是留着占位
  false !== true
ℹ tests 3   pass 1   fail 2
```

第三条「降权后旧连接仍收得到按新角色应得的事项事件」当时就是绿的 —— 它守的是
「别把连接打死」，不是缺口本身。三条都用真实路由（登录 → `/api/events` 建流 →
`PATCH` 改角色 / `DELETE` 删账号）+ 桩 res 按 wire format 解析，断言面对的是
「这个连接实际收到了什么」。修后本文件 **11 项全绿**。

### 三、三条投递路径如何同源

`deliver(event, eventName)` 是唯一的投递出口；三个函数只负责把事件拼出来：

| 路径 | 事件 | 出口 |
| --- | --- | --- |
| `broadcastItems` | `{ scope:'items', ownerId, kind, itemId }` | `deliver(..., 'items')` |
| `broadcastAdmin` | `{ scope:'admin', kind }` | `deliver(..., 'admin')` |
| `broadcastToAccount` | `{ scope:'self', accountId, kind }` | `deliver(..., 'self')` |

静态断言两条（`test/viewer-authority.test.js`）：`canReceiveEvent(` 在 `sse.js` 里
只出现 **1 次**；`sse.js` 全文没有账号比较（`accountId ===` / `!==` 等一律不出现）。
断开寻址走一张 `accountId -> Set<client>` 索引，因此也不需要比较。

**顺带的行为变化（如实记）**：`self` 事件的 data 多了 `accountId`（收件账号）。
客户端不读事件 data（`app.js` 按事件名重拉），wire format / headers / 心跳 / retry 均未变。

### 四、断开能力怎么表达（词表）

- 新增去向 `TARGET.CONNECTIONS = 'connections'`，kind `'account-deleted'`，
  构造函数 `accountDeleted(accountId)`；`publish` 新增一条分支 → 中枢内部的
  `disconnectAccount(accountId)`（先摘连接表再 `res.end()`）。
- **为什么不是给 `accounts` 加一个 kind**：那会让同一个去向的送达方式变成 kind 的函数
  （其余四个 kind 是「通知客户端后重拉」，这个 kind 是「结束句柄」），`publish` 里又得
  按 kind 分叉 —— 正是工单 03 收掉的那种「用 if/else 认词」。新去向的语义就是
  **送达方式不同**：前三个是「通知谁」，这个是「断开谁」。
- 断开**不经过**可见性判据（也不能）：账号已删除 → viewer 为 `null` → 一切 false，
  留着的连接永远收不到东西，只能显式断开。它是句柄管理，不是可见性。
- **对三条投递路径的影响：无**。新增的是第四条「断开」路径，三个通知路径只是换了
  出口（`deliver`），逻辑一行未改。
- `accounts.deleteAccount` 的 `changed` 变成
  `[accountDeleted(target.id), adminsChanged('accounts')]`（前者断连接，后者仍给
  admin 面板刷名单）。

### 五、票面外的改动（1 个文件 + 1 处票面允许的接线）

1. `server/app.js`（票面允许，理由见一）：组合根接 `roleOf` —— 中枢不 import accounts.js，
   这是唯一能接的地方。
2. `test/change-vocabulary.test.js`（**票面外**，工单 03 的文件）—— 两处必改，
   都是「给闭集加词」的直接后果：
   - `createHub = () => createSse()` → `createSse({ roleOf: () => 'user' })`：中枢现在
     要求注入权威来源，而该文件 5 处关口服测试都要建中枢。
   - 词表 key 列表 `['accounts','admins','itemOwners']` → 加 `'connections'`，并补一条
     connections 的 kind 断言。
   不改这两处，工单 03 的既有断言会把「给词表加词」变成不可能；那张测试本身就是
   「新增一种变更必须写进词表」的关口，这次正好按它走了一遍。

### 六、回归与全量

- `node --test test/viewer-authority.test.js` → **11 项全绿**（降权 2 + 删号 4 + viewer 现取 2 +
  静态同源 3）。
- `npm test` → **251 项通过、0 失败**（基线 239 + 本票 12）。
- 既有那条「`user` 收不到他人事项事件」：`test/visibility.test.js`（判据）与
  `test/sse.test.js`（端到端）两条都在，全绿。
- 改动过的既有断言：`visibility.test.js` 的 self 一条（旧规则「不由这里裁决」已被本票取代，
  改成三条新的）；`sse.test.js` 的 self 事件 data（多了 `accountId`）；`accounts.test.js`
  的 deleteAccount `changed`；`change-vocabulary.test.js` 见五。

### 七、注入回归：证明这些判据真的会红（在临时副本上注入，未动仓库）

| 注入的回归 | 红掉的判据 |
| --- | --- |
| 连接记录重新存 role 并拿它当 viewer（`{ res, accountId, role }` + `client.role`） | 降权 e2e、三条路径现取 role、静态 `client.role`（3 红） |
| `broadcastToAccount` 改回自己比 `client.accountId === accountId` | 三条路径现取 role、静态账号比较（2 红） |
| `deleteAccount` 不再产出 `accountDeleted` | 删账号断开 e2e、`accounts.test.js` 的 `changed` 断言（2 红） |
| `detach` 关掉一条连接时把整个账号的索引项删掉 | 同账号多连接仍能被按账号断开（1 红） |

### 八、如实记下的边界

1. `self` 事件 data 多了 `accountId`（见三）。传输方式未变。
2. 本票的断开只针对**被删账号自己**的连接。工单 07 记的那条（删账号级联删掉指向某人的
   邀请后，别人的角标要等下一次全量）**不在本票范围**：那需要领域层算出「谁受了影响」并
   产出一条 `accountChanged`，落点在 items / invites；留给 05 或另开票核对。
3. 降权者的连接保留（票面要求），他的界面靠 `self` / `role-changed` 重拉；REST 侧
   `ownerScope` 也按当前角色过滤，所以「连接保留」不构成越权数据路径。

## 主 agent 核对（2026-09-18）

- **提交范围**：`5375656`，10 个文件。其中两处**票面外**，均已在提交里说明并接受复核：① `server/app.js` 的组合根接线（票面明确允许——中枢不 import accounts，权威来源只能在组合根接）；② `test/change-vocabulary.test.js` 两处必改（`createHub` 要传 `roleOf`、词表 key 断言要加 `connections`）。**后者我核过 diff**：是最小必要改动，且注释写明「本文件测的是词表与关口，不是角色判据」——不改这两处，03 那条「新增一种变更必须写进词表」的断言会把「给词表加词」变成不可能。
- **全量套件 251 项全绿**（基线 239 + 本票新增 12）。
- **三条结构声明已独立复核**：`sse.js` 里 `canReceiveEvent(` **只出现 1 次**（三条投递路径同源）；`client.role` **已不存在**（陈旧副本在结构上不可能出现）；`sse.js` **只 import `visibility.js`**（中枢不依赖 accounts，权威来源由组合根注入 `roleOf`）。
- **先红后绿成立**：未改 src 时，降权那条红在「旧连接收到 `{scope:'admin',kind:'accounts'}`」，删号那条红在 `ended: false !== true`；第三条「仍收到按新角色应得的事项事件」当时即绿（守的是别把连接打死）。另有四次退化注入验证判据非装饰。
- **一处协议变化记在案**：`self` 事件的 data 现在多带 `accountId`（判据的输入），客户端不读 data、传输方式未变。
- **07 留下的暴露窗口已关闭**：本票落地后，被降权者的旧连接在**推送时**按权威角色重判，不再依赖客户端重建流这个副作用。
- **未纳入本票、留给 05 或另开票**：07 记的「删账号级联删掉指向某人的邀请后，非 admin 的角标要等下一次全量」——需要领域层算出受影响账号并产出 `accountChanged`，落点在 items / invites。已写进 05 的派工说明里，由 05 判断能否顺带覆盖。
