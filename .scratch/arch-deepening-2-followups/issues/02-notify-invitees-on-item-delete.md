# 02 — 删事项级联删掉待接受邀请时，通知受影响的被邀请人

**What to build:** 一条事项被删除时，它的待接受邀请会随级联消失——**但被邀请人收不到任何通知**：他们的「邀请」角标还亮着，点进去那条已经在列表里消失或点了报错，直到下一次全量重拉才对上。这条是 arch-deepening-2 工单 05 带实测数据报告的两处同类缺口之一。

**Blocked by:** 01（新增的变更要基于 `server/changes.js` 的构造能力）

**Status:** ready-for-agent

## 现状（已实测）

删掉一条事项后，被邀请人（非 admin）只收到 `itemOwners: deleted` 一路，**没有 `accounts` 一路** → 他的角标停在旧值。对照：工单 05 已经修好了「删账号级联删邀请」那半边（那里会算出受影响的被邀请人并产出 `accountChanged([...], 'invites-changed')`），本票补的是**删事项**这半边。

## 形状

- 删除事项时算出它的待邀请人（`item_invites` 里 `item_id = ?` 的那批账号），在 `changed` 里为每人产出 `accountChanged([...], 'invites-changed')`。
- **怎么做（谁去读邀请表）由你定，但必须避免循环依赖**：`invites` 已经依赖 `items`（`createInvites(store, items)`），所以 `items` 不能再依赖 `invites`。可选：直接读同一库里的 `item_invites`（同 store，schema 共享）、或由组合根注入一个「取待邀请人」的小回调。**把你选的那条与理由写进工单**。
- 没有人被邀请时不产出多余变更（沿用 05 那条的做法）。

## 验收标准

- [x] **先复现**：一条断言证明「删掉事项后，被邀请人收不到 `accounts` 变更 / 角标停在旧值」（红）→ 修后转绿。用可注入的中枢（`app.sse`，见 arch-deepening-2 工单 02）在 `node:test` 里断言收到的事件，**不要靠代码推理**。
- [x] 只影响真正被邀请的人：无关账号收不到这条变更（有断言）。
- [x] 没有待接受邀请时，`changed` 里不出现多余的 `accounts` 一路（有断言）。
- [x] 无循环依赖：`items` 不 import `invites`（静态检查或评审确认，写进工单）。
- [x] 既有断言全绿；全量套件全绿；一笔提交进 `main`。

## 结论

做完了，只动删事项这半边（删账号那半边仍是 03 的范围）。

**选了路线 ①：由组合根注入一个「取这条事项的待邀请人」的读取器**，理由是知识归属与依赖方向：

- `item_invites` 的读写全部留在 `invites.js`（新的导出 `createPendingInviteesOf(store)` 是「某条事项的待邀请人」的唯一实现），`items.js` 里一行 SQL 都没多；
- `items` 不 import `invites`，注入面与 `createSse({ roleOf })` 同形；`createItems(store, colors, { pendingInviteesOf })` 缺依赖直接抛 `TypeError`（与 `createSse` 要 `roleOf` 同一取舍：宁可接线当场炸，也不要通知静默消失）；
- 读取器只依赖 `store`、不依赖 `items`，于是组合根里 **`createPendingInviteesOf(store)` → `createItems(...)` → `createInvites(store, items)` 是顺序直读的**，没有「items 的定义回指尚未赋值的 invites」这种前向引用地雷（若改成注入 `(id) => invites.pendingInviteesOf(id)` 就需要晚绑定闭包）；
- 路线 ②（`items` 直接读同一库的 `item_invites`）被否：那会把邀请表的知识复制到两个 module，且「谁拥有这张表」这条线被抹掉——正是本 effort 要避免的那种隐性耦合。

**改动**：

- `server/invites.js`：新增 `createPendingInviteesOf(store)`（按 `account_id` 升序，同一库状态给出同一份名单），文件头注明 `item_invites` 的查询都归这里；
- `server/items.js`：`createItems` 接受并校验 `pendingInviteesOf` 依赖；`deleteItem` 在 **删除前** 问出待邀请人（删掉后表里就没了），`changed` 里在 `itemOwners:deleted` 之后按需追加 `accountChanged(orphanedInvitees, 'invites-changed')`——**沿用删账号那半边的「无人受影响不产出多余变更」做法**；
- `server/app.js`：组合根接线一处；
- 新测试 `test/item-delete-invitees.test.js`（4 条，走真实路由 + 桩 res 按 SSE wire format 解析）。

**范围外记一笔（不在本票，也不在 03 的既定范围）**：删账号路径里的 `items.deleteSoleOwnedItems` 会删掉该账号唯一拥有的事项（那些已归档的），同样级联删掉这些事项的待接受邀请；`invites.pendingInviteesFrom(账号)` 只覆盖「它发出的」邀请，覆盖不到「别人（如 admin）替它的事项发出的」邀请。这属于删账号那半边，留给 03 或另开票。

## 证据

**先红**（同一份测试文件，把 `deleteItem` 里新增的那一路临时关掉再跑）：

```
✖ 经 REST 删事项：被邀请人收到 self/invites-changed，他的角标立刻归零
  AssertionError: 被邀请人必须收到定向通知：他的角标要立刻准，而不是停在旧值等下一次全量重拉
    actual: []
    expected: [ { scope: 'self', accountId: 3, kind: 'invites-changed' } ]
✖ 多个被邀请人各收一条；已是 owner 的人不重复出现在定向名单里
  AssertionError: 两个被邀请人合成一条定向变更（owner 不在里面——他收的是上面那路）
    actual: [ { to: 'itemOwners', kind: 'deleted', ownerIds: [Array], itemId: 1 } ]
    expected: [ { to: 'itemOwners', ownerIds: [Array], itemId: 1, kind: 'deleted' },
                { to: 'accounts', accountIds: [Array], kind: 'invites-changed' } ]
ℹ tests 4 / pass 2 / fail 2
```

（修复前的第一次跑，红点相同：被邀请人连接上 `self` 事件为空。）修复后同一文件 `pass 4 / fail 0`。

**谁收到什么**（走真实路由，桩 res 解出的 `{event, data}`）：

- 被邀请人 lin：只收到 `self` / `{ scope: 'self', accountId: lin.id, kind: 'invites-changed' }`——他不是 owner，收不到 `items` 那一路；同时 `invites.countFor(lin)` 从 1 变 0，角标当场归零。
- 发起人 zhao（owner）：只收到 `items` / `{ scope: 'items', ownerId: zhao.id, kind: 'deleted', itemId }`。
- 与事项无关的 wang：`events()` 为空（连接后的历史事件已清空）——变更不外溢。
- 多个被邀请人：合成**一条** `accountChanged([lin.id, wang.id], 'invites-changed')`，owner 不在收件名单里。
- 没有待接受邀请：`changed` 恰为 `[{ to: 'itemOwners', ownerIds: [admin.id], itemId, kind: 'deleted' }]`，线上也没有多出来的 `self` 事件。

**无循环依赖**（`items.js` 的 import 只有四行，没有 `invites.js`）：

```
$ grep -n "from './" server/items.js
15:import { LIMITS, isValidDateString, isTagAllowed, TAGS } from './config.js';
16:import { canAccessItem, capabilitiesOf, ownerScope } from './visibility.js';
17:import { accountChanged, ownerChanged, ownerChanges } from './changes.js';
18:import { httpError } from './http.js';
```

静态判据（测试里那条）断言 `items.js` 源码不含 `from './invites.js'`，并断言组合根确实接上了 `createPendingInviteesOf(`；`grep` 复核：`server/` 里出现 `invites` 的 import 只有组合根与 `invites.js` 自己。

**全量套件**：`npm test` → `tests 293 / suites 80 / pass 293 / fail 0`（基线 289 + 本票 4 条）。
