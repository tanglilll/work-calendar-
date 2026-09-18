# 05 — 事项的门：访问与生命周期一处

**What to build:** 把「能不能动这条事项」收成一个门，items 与 invites 都走它；门里同时管「已归档」这件事。今天 invites 复刻了一份访问判据（还漏了归档检查），于是**给一条已归档事项发邀请，领域层会接受**，且经 REST 可达。

**Blocked by:** 01、03、04（同一批文件 `items.js` / `invites.js` / `accounts.js` 的串行约束；段一最后一张）

**Status:** ready-for-agent

## 形状

- 一个门 `requireItemAccess(actor, itemId, purpose)`，`purpose ∈ { read, write, archive, invite, delete }`。
- 对已归档事项：**读、改、归档、邀请一律拒绝**。
- **删除是唯一例外，允许**——把今天事实上存在的能力（`deleteItem` 从不检查归档状态，只有 REST 可达）**写明**在门的接口里。理由：删除的语义是「这事本就不该存在」，与它是否完成过无关；且归档视图只读、不提供入口。
- `sessions` 表的写入归 auth：删掉 `accounts.js` 里那行直写（`db.js` 已有 `ON DELETE CASCADE` + `PRAGMA foreign_keys = ON`）。
- sole-owner 谓词（同一 `EXISTS ... count = 1` 子查询写了三遍、只有归档条件翻转）只留一处。

## 验收标准

- [x] **先复现**：一条判据证明「给已归档事项发邀请被接受」（红）→ 门生效后拒绝（绿）。
- [x] 回归：改已归档事项被拒、归档已归档事项被拒，两条既有行为仍绿。
- [x] **删除已归档事项仍被允许**，且有断言把它钉住（这是写下来的例外，不是疏漏）。
- [x] `invites.js` 不再有自己那份访问判据；重复的错误文案消失（会话里「无权处置他人的事项」只有一处来源）。
- [x] sole-owner 行为在三条调用路径（删账号前的检查、转移后的检查、以及第三条）上一致，且只有一份实现。
- [x] 删账号后旧会话立刻失效有直接断言（今天靠 FK 级联但无断言），且 `accounts.js` 里不再直写 `sessions`。
- [x] 全量套件全绿；一笔提交进 `main`。

## 结论与证据

### 一、门的形状

`items.requireItemAccess(actor, itemId, purpose)` —— 领域 module 的接口（`server/items.js:268`），
`invites.js` 通过注入的 `items` 调它，两个 module 都不再自己写访问判据。

判据分三层，顺序就是它们该被问的顺序：

| 层 | 条件 | 结果 |
| --- | --- | --- |
| 用途 | `purpose` 不在 `ITEM_ACCESS_PURPOSES` 里 | `TypeError`（门是闭集，不默认放行） |
| 访问 | 事项不存在 | `404 事项不存在` |
| 访问 | `canAccessItem` 为假（`visibility.js` 的判据） | `403 无权处置他人的事项` |
| 生命周期 | `item.archived_at` 且该用途的立场是拒绝 | `409` + 用途表里的那句理由 |

`ITEM_ACCESS_PURPOSES`（`items.js:130`）是 purpose 的闭集，**同时是「已归档还让不让动」的唯一声明处**：
值是拒绝理由，`null` 表示放行。五个用途与各自的立场：

| purpose | 已归档时 | 理由 |
| --- | --- | --- |
| `read` | 拒绝 | 已归档的事项只在归档视图里可见 |
| `write` | 拒绝 | 已归档的事项不可修改（原文案保留） |
| `archive` | 拒绝 | 该事项已经归档（原文案保留） |
| `invite` | 拒绝 | 已归档的事项不可再邀请他人（今天经 REST 可达的那个缺口） |
| `delete` | **放行** | —— 唯一的例外，写在这里就是决定 |

调用点四处（`read` 今天无调用点：列表在 SQL 侧按 `ownerScope` 过滤、单条读只在 module 内部，
它的立场仍然写进表里，因为「已归档读不到」这条规则本身就属于门）：

| 调用点 | purpose |
| --- | --- |
| `items.updateItem` | `write`（原来自写 `archived_at` 检查，已删） |
| `items.archiveItem` | `archive`（同上） |
| `items.deleteItem` | `delete`（原来就在事实上放行，现在写明） |
| `invites.invite` | `invite`（原来自写 `canAccessItem` + 自己那句 403，已删） |

### 二、先红那次的输出

第一次跑（未动任何源码）时，测试文件**连加载都过不去**——它 import 的 `ITEM_ACCESS_PURPOSES`
还不存在（`SyntaxError: does not provide an export named 'ITEM_ACCESS_PURPOSES'`）。
于是先把用途表落进 `items.js`（它是门的接口、也是本票最终代码的一部分）再跑，
让断言自己去说缺口的形状：

```
✖ 领域层拒绝，且不落库
  AssertionError [ERR_ASSERTION]: Missing expected exception.      ← 邀请一条已归档事项被接受了
✖ 经 REST 同样进不去：POST /api/items/:id/invites 拿 409
  AssertionError: 已归档的事项邀请不到人
  201 !== 409                                                     ← 经 REST 可达，实测 201
✖ 门对 delete 放行已归档事项 / purpose=read|write|archive|invite 被拒   （requireItemAccess 还不存在）
✖ invites.js 里既没有访问判据，也没有那句错误文案                    （当时它两样都有）
✖ 「无权处置他人的事项」在整个 server/ 里只有一处来源                 （当时 items 与 invites 各一份）
✖ 谓词只有一处实现：EXISTS 子查询与 count = 1 在 items.js 各只出现一次  （当时各三处）
ℹ tests 19   pass 8   fail 11
```

改完后 `test/item-gate.test.js` **20 项全绿**。

### 三、sessions 的归属与级联断言

`accounts.deleteAccount` 里那行 `DELETE FROM sessions WHERE account_id = ?` 删掉了
（`server/accounts.js` 现在没有一句 SQL 碰 `sessions`，静态断言：
`/(FROM|INTO|UPDATE|DELETE\s+FROM)\s+sessions/i` 不匹配）。会话表的写入归 `auth.js` 的
`createSessions`；账号行删除后由 `sessions.account_id` 的 `ON DELETE CASCADE` 接手
（`server/db.js:53`，打开库时 `PRAGMA foreign_keys = ON`，`db.js:141`）。

**直接断言**（`test/accounts.test.js`，今天库里靠级联但没人测过它）：
给 zhao 签一个会话 → `getSessionAccount(token)` 可用 → 删账号 → 同一 token 立刻返回 `null`，
且 `sessions` 表里没有留下孤儿行（`COUNT(*) = 0`）。

### 四、sole-owner 谓词只剩一处

合并成 `soleOwnedWhere(archived)`（`items.js:427`）——一条 WHERE 片段，只含一个占位符（账号 id），
`archived` 为 `false` / `true` / `undefined` 分别加「未归档」「已归档」「两类都要」这一个条件。
三条路径变成三行：

| 路径 | 条件 | 用途 |
| --- | --- | --- |
| `countSoleOwnedActiveItems` | `soleOwnedWhere(false)` | 删账号前的门槛（必须为零，否则先转移） |
| `countSoleOwnedArchivedItems` | `soleOwnedWhere(true)` | 随账号删除的归档项计数 |
| `deleteSoleOwnedItems` | `soleOwnedWhere()` | 真正删除（未归档 + 已归档的并集） |

断言两条：行为上「三条路径对同一批事项给出一致的答案」（唯一/共享 × 未归档/已归档四类各一条，
期望值从 `listItems` / `listArchived` 公开读法算出，不抄 SQL；删完之后两个计数归零、共享的两条还在）；
结构上 `EXISTS (SELECT 1 FROM item_owners m WHERE …)` 与 `(SELECT COUNT(*) … ) = 1`
在 `items.js` 里**各只出现一次**（这条断言在合并前是红的，见上）。

### 五、顺带核对：工单 07 记的那条缺口

**覆盖了**（它落在本票文件范围内的那一半）：删账号会级联删掉**它发出的**待接受邀请
（`item_invites.invited_by` 的 `ON DELETE CASCADE`），受影响的是**被邀请人**——不是 admin，
原来只发 `to: 'admins'`，他们的角标要等下一次全量。

处置：`invites` 新增 `pendingInviteesFrom(inviterId)`（表的所有者算「谁受了影响」，`invites.js:77`），
`accounts.deleteAccount` 在删除**之前**问一次（删完就查不到了），把这些人并进
`changed`：`accountChanged(orphanedInvitees, 'invites-changed')`（沿用词表构造函数；没有人受影响时
不产出多余变更，有回归断言）。为此 `createAccounts(store, items, invites)` 多接一个依赖，
组合根 `server/app.js:24` 改一行（理由见七）。

证据（`test/accounts.test.js`）：zhao 与 admin 共享一条事项并邀请 lin → 删 zhao 的账号 →
`countFor(lin)` 由 1 变 0，且 `changed` 第三条正是
`{ to: 'accounts', accountIds: [lin.id], kind: 'invites-changed' }`。注入回归（临时把这一条改掉）后
该断言红在「缺这一条变更」，改回即绿。

**同一类还有两处，本票未覆盖（如实报告，避免硬塞）**，它们的触发点不同、都在领域层要再算一次受影响的人：

1. **删事项**会级联删掉这条事项下的待接受邀请。实测：zhao 邀请 lin 后 `deleteItem`，
   lin 的角标 1 → 0，但 `changed` 只有 `itemOwners:deleted`（发给 owner 的），lin 收不到任何事件。
2. **删账号**级联摘掉它在**共享事项**里的成员资格。实测：`admin, zhao, lin` 共享一条事项，
   删 zhao 后名单变成 `admin, lin`、`version` 未变，而 `changed` 里没有 `itemOwners` 这一路——
   共同 owner 的界面上的名单标注要等下一次重拉。

未做的理由：第 1 处需要 `items.js` 去读 `item_invites`（表归 invites）或把 invites 反向注入 items
（`createInvites(store, items)` 已经是「invites 依赖 items」的方向，反向注入会成环），
第 2 处需要 `deleteAccount` 为每条共享事项算 owner 差分并顺带决定要不要动 `version`——
都超出「顺带覆盖」的范围。**建议另开票**，两处都属于「级联删除后谁需要被通知」这同一个缺口。

### 六、如实记下的行为差异

1. **归档的拒绝文案**：`write` / `archive` 两句原样保留（既有回归断言用的是状态码，但文案未变）；
   `invite` 与 `read` 是新写的两句，只出现在用途表里（静态断言：每个非 null 理由在 `items.js` 里恰好出现一次）。
2. **`accept`（回应邀请）不走门**：已经被发出的邀请，其事项后来被归档，接受它仍然成功——
   今天的行为未变，本票不动它（「回应邀请」不是「发邀请」；要不要一起拒绝需要单独定，票面没写）。
3. `read` 无调用点（见一）。
4. `pendingInviteesFrom` 排除了发起人自己（`account_id != ?`）：manager/admin 可以邀请自己，
   那种邀请在删号时无需通知一个已经被删的账号。

### 七、票面外的文件（3 个，理由如下）

| 文件 | 改动 | 理由 |
| --- | --- | --- |
| `server/app.js` | 1 行：`createAccounts(store, items, invites)` | 五里那半缺口要 accounts 问 invites；中枢/依赖只能由组合根接线（与 04 接 `roleOf` 同一处、同一理由） |
| `README.md` | 3 行（两条规则 + 一个模块表行） | 「归档」那条规则补上「不能再改/再归档/再邀请」，模块表 `items.js` 一行改成「访问门（访问 + 已归档，items 与 invites 同走）」——本票改的正是这条职责 |
| `test/item-gate.test.js` | 新增（20 项） | 票面允许新建测试文件 |

### 八、测试结果

- `node --test test/item-gate.test.js` → **20 项通过、0 失败**（门 2 + 先红 2 + 已归档拒绝 4+2 +
  删除例外 3 + 唯一入口 5 + sole-owner 2）。
- `node --test test/accounts.test.js` → 全绿（新增 4：级联失效会话、不直写 sessions 静态检查、
  被邀请人定向通知、无连累时不产生多余通知）。
- `npm test` → **275 项通过、0 失败**（基线 251 + 本票 24）。

