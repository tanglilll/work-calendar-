# 03 — 变更词表与 owner 差分

**What to build:** 让「变更描述」有落点：谁可以发哪种变更由一份词表定义、由构造函数产生，非法变更**无从构造**；owner 名单变化的差分只算一次，item、邀请、账号三处共用。

**Blocked by:** 02（判据需要可注入的中枢才能断言「谁收到了什么」）

**Status:** ready-for-agent

## 形状

- 词表常量 + 构造函数（如 `ownerChanged(item, kind)`、账号定向的那一支），返回 `{ to, kind, ownerIds | accountIds, itemId }`。
- `publish` 只接受构造出来的变更；未知 `to` 在今天会被 if/else **静默丢弃**，改后要在测试里炸。
- owner 差分（removed / added / stayed，以及「谁需要被通知」）收成一处实现。今天它被抄了三份：`items.updateItem`、`invites.accept`、`accounts.transferItems`（第三份还不带 `itemId`）。
- 投递方式不变，只改变「谁定义、谁构造」。**保住 ADR-0002 的语义**：owner 并列、无主次。

## 验收标准

- [x] 词表与构造函数存在；三处调用共用同一份差分实现（`grep` 能证明只剩一份）。
- [x] 非法变更（未知 `to`、词表外的 `kind`）**先红后绿**：先写一条断言证明今天会被静默丢弃，改后抛错/断言失败。
- [x] 账号定向那一支（`broadcastToAccount` 的调用方）也走词表；`accounts.transferItems` 的变更带上 `itemId`。
- [x] 20 处 `kind` 字面量全部来自词表（`grep` 证明没有游离的字面量）。
- [x] 现有关于变更数组的断言（领域测试里的 `changed` 字段）仍全绿，或按新形状更新并说明。
- [x] 全量套件全绿。
- [x] 一笔提交进 `main`。

## 结论

「变更描述」有了落点：**词表常量 + 构造函数**都在 `server/sse.js`（publish 的归属，也是唯一接受变更的关口），
领域 module 只 import 纯构造函数；中枢实例仍由组合根注入，连接表没有外泄。

- 非法变更无从构造：kind 不在词表、itemId 缺失、ownerIds/accountIds 为空，构造函数直接抛 `TypeError`；
  publish 还要认构造标记（不可枚举 `Symbol`，`assert.deepEqual` 与 JSON 都看不见它），手写或拼错的变更在关口炸。
- owner 差分只剩一处：`ownerDiff` + `ownerChanges`（谁出 away / 谁进 in / 谁留 updated；名单没变 → 当前名单 updated），
  `items.updateItem`、`invites.accept`、`accounts.transferItems` 三处共用；转移那份补上了 `itemId`，且多事项时每条一组。
- 投递方式一字未改：`publish` 仍按三个 `to` 走 `broadcastItems` / `broadcastAdmin` / `broadcastToAccount`，
  wire 上的事件与 kind 与改前逐字一致（既有 `changed` 断言与 sse 的 wire 断言仍全绿）。
- ADR-0002 保住：差分只比较「成员在不在」（换顺序不算换人），无主次；转移时目标本来就在名单里算「留」不算「进」。

## 证据

### 词表与构造函数（`server/sse.js`）

```js
const TARGET = Object.freeze({ ITEM_OWNERS: 'itemOwners', ADMINS: 'admins', ACCOUNTS: 'accounts' });

export const CHANGE_KINDS = Object.freeze({          // 闭集：构造函数与 publish 都问它
  itemOwners: ['created', 'updated', 'transferred-away', 'transferred-in', 'archived', 'deleted'],
  admins:     ['accounts', 'requests'],
  accounts:   ['invites-changed', 'approved', 'role-changed', 'signed-in'],
});

export function ownerChanged(itemId, ownerIds, kind)      // → { to:'itemOwners', kind, ownerIds, itemId }
export function adminsChanged(kind)                       // → { to:'admins', kind }
export function accountChanged(accountIds, kind)          // → { to:'accounts', kind, accountIds }
export function isChange(value)                           // 构造标记（Symbol，不可枚举）
export function ownerDiff(beforeIds, afterIds)            // → { removed, added, stayed }
export function ownerChanges({ itemId, before, after })   // → 变更数组（差分 → 谁需要被通知）
```

`publish` 三道关：构造标记 → `to` 在词表里 → `kind` 属于这个去向；任何一道不过就抛错，
if/else 里「认不出就丢掉」的那条路径已经不存在。

### 先红后绿

改前（HEAD 版本 + 当时的测试文件）同一对断言：

```
$ node --test test/change-vocabulary.test.js
✖ 未知 to：今天被静默丢弃，改后必须抛错
  AssertionError [ERR_ASSERTION]: Missing expected exception: 拼错的 to 必须炸：静默丢弃让「拼错」在测试与生产里同样无声
✖ 词表外的 kind：今天会被原样投递，改后必须抛错
  AssertionError [ERR_ASSERTION]: Missing expected exception: 词表外的 kind 必须炸：它今天会被原样推给客户端，词表也就形同虚设
ℹ tests 2  ℹ pass 0  ℹ fail 2
```

`Missing expected exception` = publish 既不抛错也不报警。直接看它今天做了什么（真中枢 + 桩 res）：

```
未知 to    → 抛错: 无（静默），客户端收到: ["hello"]                  ← 被静默丢弃
词表外 kind → 抛错: 无（静默），客户端收到: ["hello","items"]          ← 原样推给了客户端
```

改后同一断言（`assert.throws` + 「非法变更不被投递」）转绿：`test/change-vocabulary.test.js`
的「publish 只接受构造出来的变更」四条全过；实现后把标题从「今天…改后…」改成描述规则本身，
断言本身没动。

### 三份差分合并成一份

改前的三处手抄：`items.js` 的 `updateItem`（`new Set` 差集 + 私有 `ownerChanged`）、
`invites.js` 的 `accept`（`transferred-in` 给新人 + `updated` 给 others）、
`accounts.js` 的 `transferItems`（聚合 `[from.id]` / `[to.id]`，**不带 itemId**）。

```
$ grep -rn "transferred-away\|transferred-in\|\bstayed\b" server/
server/sse.js:36,37,85,94,101,105,109,110,111     ← 只剩词表这一处（词的声明 + 差分 + 通知映射）

$ grep -rn "ownerChanges(\|ownerDiff(" server/
server/sse.js:88,104,105          ← 定义与内部调用
server/items.js:330               ← items.updateItem
server/invites.js:94              ← invites.accept
server/accounts.js:222            ← accounts.transferItems
```

`items.transferAllItems` 现在返回每条受影响事项的 `{ itemId, before, after }`（只提供事实），
`accounts.transferItems` 用 `ownerChanges` 产出带 `itemId` 的变更：多事项时每条一组，
目标本来就在名单里时算「留」而不是「进」——两条都有断言（`test/change-vocabulary.test.js`
「accounts.transferItems：变更带上 itemId」）。

「谁需要被通知」留在词表层（下一步 viewer 权威会用到）：`ownerChanges` 是唯一知道
「away/in/updated 该发给谁」的地方，`test/change-vocabulary.test.js` 还静态钉住
items / invites / accounts / auth 四个文件里不许再出现 `transferred-*` 与 `stayed`。

### 20 处 kind 字面量

```
$ git grep -h "kind: '" HEAD -- server/*.js | wc -l     → 20
  （HEAD:server/accounts.js:11  HEAD:server/auth.js:1  HEAD:server/invites.js:5  HEAD:server/items.js:3）
$ grep -rn "kind: '\|to: '" server/                     → 无匹配（退出码 1）
```

`test/change-vocabulary.test.js`「领域 module 不再写回 to/kind 字面量，也不自己算差分」
把这条 grep 变成回归网：四个领域文件必须有 `from './sse.js'`，不许出现 `to:'…'` / `kind:'…'`。

### 既有断言与形状

- 领域测试里 `changed` 的形状断言全绿，只有一处按票面要求更新：`test/accounts.test.js`
  的 transferItems 两条变更补上 `itemId`（这正是本票要收的第三份差分的缺陷）。
- `test/sse.test.js` 的 publish 输入改成词表构造函数（投递的 wire 断言仍写字面量——那是契约）；
  `broadcastToAccount` 也对 kind 做词表校验，直调的那条用例照旧。
- 全量：`npm test` → `tests 239  suites 64  pass 239  fail 0`（基线 223 + 本票新增 16，无 fail）。
- 为什么只能这样验：这一票的判据全在领域层与中枢层（真领域调用 + 真中枢 + 桩连接），
  「谁收到了什么」可断言，不需要浏览器；wire 上的送达方式没有改动，段界冒烟不新增检查项。

### 遗留与说明

- **动了 `server/auth.js` 两行**（import + `accountChanged([accountId], 'signed-in')`）：判据里的
  20 处含 `auth.js:98`，已获主 agent 批准；服务端线串行，无并发冲突。
- `README.md:86` 对 sse.js 的描述是「SSE 广播中枢 + 把变更描述翻译成推送」，现在还多担了
  「变更词表」半句职责；不在本票文件清单内，留给收口时补一句。
- 现在所有 `to: itemOwners` 变更都带 `itemId`，所以 publish 里 `itemId ?? null` 那条兜底删了
  （由构造函数保证），wire 上不再出现 `itemId: null`。

