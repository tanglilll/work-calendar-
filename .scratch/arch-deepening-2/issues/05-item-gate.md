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

- [ ] **先复现**：一条判据证明「给已归档事项发邀请被接受」（红）→ 门生效后拒绝（绿）。
- [ ] 回归：改已归档事项被拒、归档已归档事项被拒，两条既有行为仍绿。
- [ ] **删除已归档事项仍被允许**，且有断言把它钉住（这是写下来的例外，不是疏漏）。
- [ ] `invites.js` 不再有自己那份访问判据；重复的错误文案消失（会话里「无权处置他人的事项」只有一处来源）。
- [ ] sole-owner 行为在三条调用路径（删账号前的检查、转移后的检查、以及第三条）上一致，且只有一份实现。
- [ ] 删账号后旧会话立刻失效有直接断言（今天靠 FK 级联但无断言），且 `accounts.js` 里不再直写 `sessions`。
- [ ] 全量套件全绿；一笔提交进 `main`。
