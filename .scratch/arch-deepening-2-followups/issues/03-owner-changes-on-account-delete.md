# 03 — 删账号摘掉共享事项的成员资格时，产出 `itemOwners` 变更

**What to build:** 删掉一个账号时，它会从所有共享事项的 owner 名单里消失（级联），但 `changed` 里**没有 `itemOwners` 一路**、那些事项的 `version` 也没动。后果：别人的窗口里那些色块的归属文案停在旧名单，而且谁手里正好开着编辑框，保存时不会撞上版本冲突（因为版本没变），改完一存就把「被删账号已不在名单」这件事实又写了回去。这条是 arch-deepening-2 工单 05 报告的两处同类缺口的另一处。

**Blocked by:** 01（变更构造函数）、02（同碰 `items.js`，串行）

**Status:** resolved

## 形状

- 删账号时，对**每一条仍然有效的共享事项**产出 `ownerChanged(itemId, 剩余名单, 'updated')`，让别人的窗口重拉。
- **版本处理要明确**：那几条事项的名单真的变了，所以 `version` 应当随着一起推进（这样别人手里过期的编辑框会在保存时撞 409，而不是把旧名单写回去）。推进 `version` 需要一个属于 `items` 的操作（`items` 拥有 items 表）——**由你定具体形制**（例如 `items.touchOwners(itemId, remainingIds)`），把理由写进工单。
- 曾是它**唯一** owner 的未归档事项：`deleteAccount` 本来就要求先转移（拒绝删除），所以走不到这里；若走到了，如实报告而不是默默跳过。
- 不要把「删事项」那半边顺手改掉（那是 02 的范围）。

## 验收标准

- [x] **先复现**：一条断言证明「删账号后，共享事项的 owner 名单变了、但 `changed` 里没有 `itemOwners` 一路、`version` 未动」（红）→ 修后转绿。用可注入的中枢在 `node:test` 里断言**谁收到了什么**。
- [x] 每条受影响的共享事项各有自己的变更（**带 `itemId`**）、且收到的人和撤权后仍有资格看见它的人一致（有断言）。
- [x] `version` 推进：有断言证明「删账号前拿到的 `version` 在其后保存会撞 409」；且列表接口返回的名单不再包含被删账号。
- [x] 与别人无关的事项不产出变更；没有共享事项时不产出多余变更（各一条断言）。
- [x] 既有断言全绿；全量套件全绿；一笔提交进 `main`。

## 结论

做完了。删账号这条路径上，items 一侧现在有两个出口：`detachOwner`（共享事项摘名单 + 推进版本）与 `deleteSoleOwnedItems`（删掉「唯一 owner」的事项，并把随级联消失的邀请收件人一并报出来）。

**形制：`items.detachOwner(accountId)` → `[{ itemId, ownerIds }]`**，理由四条：

1. **为什么必须是 items 的操作、而且必须排在账号行删除之前**：名单（`item_owners`）与 `version`（`items`）都归这个 module；账号行一删，外键级联把成员行摘掉，那一刻起「它原来在哪些名单里、剩下谁」就再也查不到了——推进版本与算收件人都需要这份事实，所以它在 `deleteAccount` 的 tx 里、`DELETE FROM accounts` 之前调用（同 tx 内的顺序即票据里说的「版本推进要明确」）。
2. **为什么不用词表的 `ownerChanges`，而是逐条 `ownerChanged(itemId, 剩余名单, 'updated')`**：被删账号已经不存在，`transferred-away` 没有收件人；留下的人只需要「这条事项的名单变了」。这与票据的形状一致，也是测试里断言的那条。
3. **为什么真的删成员行，而不是继续等外键级联**：摘除与「谁留下」是同一件事的两面，行就在手里；顺手删掉之后，这个函数的承诺与「账号行何时删」无关（唯一例外是「唯一 owner」的事项，见下）。返回的 `ownerIds` 是摘掉它之后的剩余名单（按 id 升序，输出可复现）。
4. **事务与不变量**：函数里不开 tx（唯一调用点是 `deleteAccount` 的 tx，嵌套 `BEGIN` 会炸，与 `writeOwners` 同一取舍：事务归调用方）；但它是**先算清再写**——先把每条的剩余名单都算出来，遇到「唯一 owner 的未归档事项」在写任何一行之前抛错，所以即使被单独调用也不会留下半摘的名单（有断言：抛错后共享事项的名单与版本都原样）。这个抛错是「如实报告」：那种状态本该被 `deleteAccount` 的门槛拦住（`HAS_ACTIVE_ITEMS`），走到这里说明守卫被绕过，不能默默留下一条没有 owner、只剩 manager/admin 看得见的事项。

**「仍然有效」= 未归档**，已归档的共享事项**只摘名单**（由这个函数显式删成员行），不推进版本、不产出变更。理由：已归档的事项没有写路径（门拒绝 `write`，版本冲突无从发生），也不出现在任何人的窗口里；唯一看得见它们的归档视图由 admin 按需打开，而删账号本来就会发 `adminsChanged('accounts')`，admin 客户端收到后重渲染当前 tab（`public/admin.js` 的 `render()` → `renderArchive()` 会重新拉 `/api/admin/archive`），名单自然是新的。这条边界有专门断言（名单摘干净、版本不动、`changed` 里没有它）。

**两条顺带改掉的既有断言**（都是本票行为改变的必然结果）：

- `test/accounts.test.js` 那条「它发出的待接受邀请……被邀请人收到定向通知」用的正好是一条 admin+zhao 共享的事项，`changed` 里现在多了那条 `itemOwners`（断言已按新形状更新，注释指回本票）；
- `test/item-gate.test.js` 断言过 `deleteSoleOwnedItems` 的返回值就是个数字——现在它是 `{ deleted, orphanedInvitees }`（见下），改成 `.deleted`。这是本票唯一越出「我的文件」清单的一行：改的是同一个契约的测试（返回形状由本票扩展），不改无法全绿。

**02 那条观察：已顺带覆盖（不是另开票）。** 复用 02 留下的注入读取器 `pendingInviteesOf`，做法是让 `deleteSoleOwnedItems` 把「这次删除连带的两件事」都报出来：

```js
/** 删掉某账号是唯一 owner 的全部事项……返回 { deleted, orphanedInvitees } */
```

`orphanedInvitees` 在删除**前**逐条问 `pendingInviteesOf(itemId)`（删掉后 `item_invites` 里就查不到了）——这正是「别人（如 admin）替它的事件事发出的邀请」那一类，`invites.pendingInviteesFrom(账号)`（只按 `invited_by`）覆盖不到。`accounts.deleteAccount` 把两批人被并入一条 `accountChanged([...], 'invites-changed')`（去重、升序，没有人受影响就不产出多余变更，沿用原取舍）。`items.js` 里**一行 `item_invites` 的 SQL 都没有多**，依赖方向不变（表与查询仍归 `invites.js`）。

`changed` 里的顺序：先每条受影响事项一条（按 itemId 升序），再 `connections/account-deleted`、`admins/accounts`，最后（有人受影响时）`accounts/invites-changed`。

## 证据

**先红**（同一份新测试，先对着未改的 server 跑；6 条里 5 条红，绿的 1 条是「没有共享事项不产出多余变更」的回归守卫）：

```
  ✖ 每位仍有资格的收件人各收到带 itemId 的 items/updated；无关的人与事项都不受牵连
    AssertionError: 名单里剩下的人要收到「这条事项的名单变了」——不是 deleted，也不带被删账号
      actual: []
      expected: [ { scope: 'items', ownerId: 1, kind: 'updated', itemId: 1 },
                  { scope: 'items', ownerId: 1, kind: 'updated', itemId: 2 } ]
  ✖ 每条受影响的共享事项各有自己的变更（带 itemId），收件人就是剩下的名单
      actual: [ { to: 'connections', ... }, { to: 'admins', kind: 'accounts' } ]   ← 没有 itemOwners 那两路
  ✖ 版本推进：删账号前拿到的 version 再保存会撞 409；列表里的名单不再含被删账号
    AssertionError: 名单真的变了，版本要一起推进
    1 !== 2
  ✖ 唯一 owner 的未归档事项走到这里就抛错，而不是默默留下一条没有 owner 的事项
      actual: TypeError: app.items.detachOwner is not a function
  ✖ 顺带覆盖 02 的观察：唯一拥有的已归档事项上、别人发出的邀请，收件人也收到定向通知
      actual:   [ { to: 'connections', ... }, { to: 'admins', kind: 'accounts' } ]
      expected: [... 同上, { to: 'accounts', accountIds: [3], kind: 'invites-changed' } ]
ℹ tests 6 / pass 1 / fail 5
```

**缺口前提的实测**（复现「修复前 deleteAccount 走到的那一步」：删账号行、让 `item_owners.account_id` 的外键级联接手——名单真的变了，版本一动不动）：

```
$ node --input-type=module -e "…createItem(owner_ids:[admin,zhao]) → db: DELETE FROM accounts WHERE id=zhao…"
名单 before= [ 1, 2 ] after= [ 1 ]
version before= 1 after= 1
```

**后绿**：`node --test test/account-delete-owners.test.js` → `tests 7 / pass 7 / fail 0`；`npm test` → **`tests 300 / suites 81 / pass 300 / fail 0`**（基线 293 + 本票 7 条）。

**谁收到什么**（走真实路由：登录、建流、`DELETE /api/admin/accounts/:id`；桩 res 按 SSE wire format 解析）：

| 连接 | 收到 |
| --- | --- |
| admin（共享 A、B 的剩余 owner，同时是 admin） | `items`×3：`{ownerId: admin, itemId: A}`、`{ownerId: admin, itemId: B}`、`{ownerId: lin, itemId: B}`（每次广播都过他的可见性，B 的两条都收）+ `admin/accounts` |
| lin（只在共享 B 的名单里） | `items`×1：`{ownerId: lin, kind: 'updated', itemId: B}`；没有 `admin` 那一路 |
| mgr（manager，不是任何事项的成员） | 与 admin 相同的三条 `items`——「收件人 = 撤权后仍有资格看见它的人」 |
| wang（与这些事项无关） | 空 |
| zhao（被删账号） | 空（`items` 事件一条都没有），且 res 被 `end()`（connections/account-deleted） |

其余断言：每条被删事项各一条带 `itemId` 的 `itemOwners/updated`（`changed` 深比较，收件人里不含被删账号）；`version` 由 1 → 2、`GET /api/items` 里该事项的 `owners` 只剩 admin；用旧 `version` 走 `PATCH /api/items/:id` 撞 `409 VERSION_CONFLICT` 且名单没被写回；admin 自己那条与 zhao 无关的事项没有变更、版本不动；已归档共享事项名单摘干净但不产出变更；被删账号唯一拥有的已归档事项上由 admin 发出的邀请，lin 收到 `self/invites-changed`（角标 1 → 0）且 `pendingInviteesFrom(zhao)` 事前为空（证明旧读取器覆盖不到）。

**改动**：`server/items.js`（新 API `detachOwner`、`deleteSoleOwnedItems` 改为报告两件事、两处 import 与注释）、`server/accounts.js`（`deleteAccount` 组合两批事实、产出逐条 items 变更、并集定向通知）、`test/account-delete-owners.test.js`（新，7 条）、`test/accounts.test.js` 与 `test/item-gate.test.js`（各一条既有断言随契约更新）。


## 主 agent 核对（2026-09-18）

- **提交范围**：`0cdf366`，6 个文件。一处**已声明的偏差**：`test/item-gate.test.js` 改了一行（`.deleted` 的返回形状被本票扩展，不改无法全绿）——我认可，属于契约随实现更新的正常连带。工作区干净，全量套件 **300 项全绿**（293 + 本票 7）。
- **新 API 我读过实现**：`items.detachOwner(accountId)` → `[{ itemId, ownerIds }]`，在账号行删除**之前**摘成员行并推进 `version` / `updated_at`（行一删，「原来在哪些名单里、剩下谁」就查不到）——这个顺序是对的。SQL 按 `m.account_id` 查并 JOIN items 取 `archived_at IS NULL AS active`，正是「已归档的共享事项只摘名单、不推版本、不产出变更」所依据的那一位。那条设计选择我认可：已归档事项无写路径、无人可见，而 `adminsChanged('accounts')` 已让 admin 重拉归档视图。
- **先红后绿成立**：未改 server 时新测试 6 条里 5 红（收件人为空、缺 `itemOwners` 两路、`version` **1 !== 2**、`detachOwner is not a function`、邀请收件人那一路缺失）。
- **02 留给它的那条观察已顺带覆盖**（不是另开票）：`deleteSoleOwnedItems` 现在返回 `{ deleted, orphanedInvitees }`，在删除**前**问出挂在被删事项上的待邀请人（**可能是别人发出的邀请**，`pendingInviteesFrom(账号)` 按 `invited_by` 覆盖不到），与账号自己发出的那批并成一条 `accountChanged(..., 'invites-changed')`。断言：`lin` 的角标 1 → 0 且收到 `self/invites-changed`，而事前 `pendingInviteesFrom(zhao)` 为空——证明覆盖的确实是「别人替它的事项发出的邀请」那一路。`items.js` 里 `item_invites` 的 SQL 仍一行没多，依赖方向不变。
