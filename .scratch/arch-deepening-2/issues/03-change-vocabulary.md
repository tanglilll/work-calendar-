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

- [ ] 词表与构造函数存在；三处调用共用同一份差分实现（`grep` 能证明只剩一份）。
- [ ] 非法变更（未知 `to`、词表外的 `kind`）**先红后绿**：先写一条断言证明今天会被静默丢弃，改后抛错/断言失败。
- [ ] 账号定向那一支（`broadcastToAccount` 的调用方）也走词表；`accounts.transferItems` 的变更带上 `itemId`。
- [ ] 20 处 `kind` 字面量全部来自词表（`grep` 证明没有游离的字面量）。
- [ ] 现有关于变更数组的断言（领域测试里的 `changed` 字段）仍全绿，或按新形状更新并说明。
- [ ] 全量套件全绿。
- [ ] 一笔提交进 `main`。
