# 01 — 字段定义收成一份

**What to build:** 让「一条事项有哪些可写字段」只有一处定义——校验、新建的 INSERT、更新的动态 `SET`、以及 bootstrap 下发的限制，全部从它派生。今天这四处各自为政，后果已经发生过一次：`21b42ba` 的「新建事项时填的进展被静默丢掉」就是新建路径与校验层脱了钩。

**Blocked by:** None — can start immediately.（段一第一张）

**Status:** ready-for-agent

## 字段表的形状

- 描述 `items` 的**可写列**：名字（即 SQL 列名）、解析/校验、在新建路径是否必填、默认值。
- `owner_ids` **不进表**：它写的是 `item_owners`，语义是「名单」而非行上的列；继续走自己的校验，并在接口注释里写明这条区分。
- `progress_updated_at` 是**派生肖**：规则「有进展才记它的更新时间」写进表旁的说明，不当成可写字段。
- bootstrap 不再手挑 5 个 limit（当前漏了 `PROGRESS_MAX`），直接下发完整的 `LIMITS`。
- **不做**由表生成 DB schema：schema 继续手写，迁移成本不划算。

## 验收标准

- [x] 字段表存在，且校验、新建 INSERT、更新动态 SET 三处都从它派生（不再有手写的列清单）。
- [x] **表驱动断言**：对表里每个可写字段，「新建带上它 → 落库后原样返回」与「更新带上它 → 落库后原样返回」各一条；用循环遍历字段表，新增字段自动被覆盖。
- [x] 这条断言**证明过自己会红**：临时把新建路径退回手写列清单（去掉 progress），确认断言失败且失败信息指向那个字段，再恢复。把这段红→绿写进工单。
- [x] `owner_ids` 仍走自己的校验；`progress_updated_at` 的派生规则与更新路径一致（有进展才有时间戳）。
- [x] bootstrap 下发的 `limits` 与 `config.js` 的 `LIMITS` 同源（有断言），且不再漏 `PROGRESS_MAX`。
- [x] 全量套件全绿（97 项 + 新增）。
- [x] 一笔提交进 `main`，提交信息写清根因、形状与被否掉的方案（由表生成 schema）。

## 结论

- 形状落在 `server/items.js` 模块顶层的新导出 `ITEM_FIELDS`：每条字段声明四件事——
  `name`（同时就是 SQL 列名）、`parse(raw)`（返回 `{ value }` / `{ error }`）、
  `requiredOnCreate`、`default`。当前五条可写字段：`title` / `event_date` / `due_date`
  （必填、无默认值）、`tag` / `progress`（可选、默认 `null`）。三个消费点全部从它派生：
  - **校验**：`normalizeItemInput` 只做「按表走一遍」——部分更新没带就不动这列；
    新建时可选用 `default` 补齐，其余交给 `field.parse`。日期不变量的合并判定留在表外
    （它跨字段，不是单字段的解析）。
  - **新建 INSERT**：`INSERT_COLUMNS = [...FIELD_NAMES, 'color', 'created_at', 'updated_at', 'progress_updated_at']`，
    `INSERT_SQL` 的列名与占位符都由它拼；取值按同一份清单
    （`...FIELD_NAMES.map((name) => values[name])`），写入层不再有人工同步的列清单。
  - **更新动态 SET**：遍历 `ITEM_FIELDS`，`field.name in values` 才写这列。
- `owner_ids` 不进表：它写的是 `item_owners`（另一张表），语义是「名单」而不是行上的列；
  校验仍在 `normalizeItemInput` 的收尾处、写入仍在 `writeOwners`。这条区分写在表的 doc 注释里。
- `progress_updated_at` 是派生肖：唯一实现在 `progressUpdatedAtFor(progress)`——有进展才给
  ISO 时间戳，没有就 `null`；新建与更新两条路径都调它，规则写在同一处的注释里。
  **一处刻意行为变化**：更新时清空进展（`progress: ''` / `null`）过去会把时间戳刷成 `now`，
  现在一并清成 `null`——「有进展才有时间戳」这条规则在两条路径上一致（新增断言钉住它）。
- bootstrap：`server/routes.js` 的 `limits` 由手挑 5 个 key 改成直接下发完整的 `LIMITS`
  （含此前漏掉的 `PROGRESS_MAX`）。前端目前不消费 `limits`，因此没有调用方要跟着改。
- **被否掉的方案照旧被否**：DB schema 仍手写（`server/db.js` 未动），不由字段表生成。
  表与 schema 的对齐交给往返断言守：表里加了可写字段而 schema 漏加列，新建直接报 SQL 错；
  加了列而 `ITEM_COLUMNS`（读侧投影，含 id/version/时间戳等不可写列，继续手写）漏加，
  返回对象里就没有该字段——两种漏法都会在往返断言上变红。
- 测试落点：`test/items.test.js` 加表驱动用例；另新增 `test/bootstrap.test.js`，**理由**是
  bootstrap 的 limits 是 routes 层的接口契约、不属于事项领域，塞进 `items.test.js` 会让它
  藏在领域测试里；这个新文件只含一条「与 `LIMITS` 同源」的断言，用桩 req/res 直接喂
  `handleApi`（与 `invites-http.test.js` 同形状，不开端口）。
- 新增断言共 13 条：表驱动 5 字段 × 新建/更新 = 10 条、样本完备性 1 条、清空进展的派生规则
  1 条、bootstrap 同源 1 条。`test/items.test.js` 由 27 条增至 39 条。

## 证据

**红→绿（判据确实会红）**：临时把 `createItem` 退回手写列清单，故意去掉 `progress`
（`INSERT INTO items (title, event_date, due_date, tag, color, created_at, updated_at)`），
`node --test test/items.test.js` 的输出：

```
✖ failing tests:
✖ 新建时就带上进展 → 落库，且记下它的更新时间 (94.8431ms)
✖ 更新时清空进展 → 时间戳一并清空（「有进展才有时间戳」） (98.5499ms)
✖ 新建带上 progress → 落库后原样返回 (103.3607ms)

✖ 新建带上 progress → 落库后原样返回
  AssertionError [ERR_ASSERTION]: 新建时带上 progress，落库后应当原样返回

  null !== '已立项'

      at TestContext.<anonymous> (file:///D:/rili/test/items.test.js:439:14)
  actual: null   expected: '已立项'   operator: 'strictEqual'

ℹ tests 39  ℹ pass 36  ℹ fail 3
```

红的正是表驱动里的那条，且失败信息点名 `progress`（`null !== '已立项'`，即字段被静默丢掉）。
恢复成 `INSERT_SQL` / `FIELD_NAMES` 派生后，同一命令：

```
✔ 新建带上 progress → 落库后原样返回
ℹ tests 40  ℹ pass 40  ℹ fail 0
```

（`40` = `items.test.js` 39 条 + `bootstrap.test.js` 1 条。）

**全量**：`npm test` → `tests 161  suites 43  pass 161  fail 0`。基线 97 之外的增长来自
并行 agent 同时入库的判据；本票新增的 13 条全过，无任何 fail。

**改动面**：`server/items.js`（+120/-66）、`server/routes.js`（+3/-7）、
`test/items.test.js`（+79）、新增 `test/bootstrap.test.js`。未动 `server/db.js` 与任何前端文件。

