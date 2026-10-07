# 03 — 象限白名单随 bootstrap 下发（交付复核抓到的缺口）

**What to build:** 让前端真的拿到象限白名单：`handleBootstrap` 下发 `quadrants`，事项对话框的选项由调用点传入，前端不再抄第二份字面量。

**Blocked by:** None — can start immediately.

**Status:** resolved

**出处：** 本票来自工单 02 的**交付复核**（`.scratch/auth-fix-and-table-view/issues/02-percent-done-quadrant-and-table-view.md` 那批声明的第 8 条「文档与实现不矛盾」被核对为**不成立**）。

- [x] 缺口先被独立证实，而不是读文档推断：复核人在真实应用上跑了一次 `GET /api/bootstrap`，返回键是 `authenticated, account, roles, capabilities, inviteCount, tags, palette, today, limits`——**没有 `quadrants`**；`server/` 全目录 grep 不到下发象限白名单的代码。于是 `public/app.js` 里的 `b.quadrants ?? []` 恒为空数组，`public/tableview.js` 的分组退到「数据里首次出现的顺序」——默认排序是截止日期升序，所以组序由各象限最早截止的那条决定，而不是白名单顺序。筛选下拉里「白名单在前」的那半同样拿不到白名单（只列数据里出现过的象限）。而 `CONTEXT.md:76` 与 `server/config.js` 的注释都写着「顺序即分组顺序」——**文档承诺了一件运行时不成立的事**。
- [x] 服务端像 `tags` 一样下发：`server/routes.js` 的 `handleBootstrap` 加 `quadrants: QUADRANTS`（值和顺序都只有服务端一份）。
- [x] 事项对话框不再抄第二份：`public/itemform.js` 删掉本地那份四字面量常量，选项改由 `ctx.quadrants` 传入；调用点 `public/app.js` 传 `state.quadrants`（与 `tags: state.tags` 同形）。
- [x] 挡住复发：`test/bootstrap.test.js` 新增「与 config.js 的 QUADRANTS 同源：值、顺序都照抄」并断言非空（空白的白名单会让表格视图退回去）；`test/itemform.test.js` 的对话框用例改成断言**选项跟着传入的白名单走**（测试里故意用「象限甲/乙/丙/丁」这种假值，证明它不是前端自己抄的），并加一条源码级断言「调用点把 `quadrants: state.quadrants` 传了进来」——「改了 itemform 却忘了改调用点」在这类改动里是现成的坑。
- [x] 浏览器层确认（隔离实例）：筛选下拉里列出了数据中**根本没出现**的「不紧急不重要」，说明白名单真的随 bootstrap 到了前端；随后在对话框里新建一条标「不紧急不重要」的事项，它落在该组且组序在白名单位置（`紧急但不重要` 与 `未标注` 之间）。

## 结论

**这是一条「测试替身比真实接口宽」的样板。** `test/refresh.test.js` 的 bootstrap 替身自己多带了一个 `quadrants` 字段，于是「白名单落到 state」这条接线在测试里永远是绿的——替身不冒充真实接口的形状，接线就没有回归网。修完之后文档承诺与运行时行为才对上。

### 证据

```
$ node --input-type=module -e '…freshWorld()…GET /api/bootstrap…'   # 修之前
键：authenticated, account, roles, capabilities, inviteCount, tags, palette, today, limits
（没有 quadrants）

$ grep -rn "quadrants" server/        # 修之前：无任何下发点
$ grep -n "b.quadrants" public/app.js # 前端读它
public/app.js:136:  quadrants: b.quadrants ?? [],   ← 恒为 []
```

浏览器（修之后）：

```
象限筛选下拉：全部 / 重要且紧急 / 重要不紧急 / 紧急但不重要 / 不紧急不重要 / 未标注
  ↑ 数据里当时只有前三者 + 未标注，「不紧急不重要」一条都没有 → 白名单真的下发了
新建一条 quadrant=不紧急不重要 的事项后，分组头：
  ▾重要且紧急 记录数 1 / ▾重要不紧急 记录数 1 / ▾紧急但不重要 记录数 1 / ▾不紧急不重要 记录数 1 / ▾未标注 记录数 1
```

提交：`4311c5f` fix(items): 象限白名单随 bootstrap 下发，前端不再有第二份字面量
（`server/routes.js 5`、`public/itemform.js ±13`、`public/app.js 1`、`test/bootstrap.test.js 20`、`test/itemform.test.js 31`、`test/contracts.test.js 2`；全量 385 项仍全绿）
