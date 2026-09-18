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

- [ ] **先复现**：一条断言证明「删掉事项后，被邀请人收不到 `accounts` 变更 / 角标停在旧值」（红）→ 修后转绿。用可注入的中枢（`app.sse`，见 arch-deepening-2 工单 02）在 `node:test` 里断言收到的事件，**不要靠代码推理**。
- [ ] 只影响真正被邀请的人：无关账号收不到这条变更（有断言）。
- [ ] 没有待接受邀请时，`changed` 里不出现多余的 `accounts` 一路（有断言）。
- [ ] 无循环依赖：`items` 不 import `invites`（静态检查或评审确认，写进工单）。
- [ ] 既有断言全绿；全量套件全绿；一笔提交进 `main`。
