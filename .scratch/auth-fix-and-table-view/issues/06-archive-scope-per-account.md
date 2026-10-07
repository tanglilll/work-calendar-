# 06 — 每个人都能看自己参与过的已完成事项（不再只有 admin）

**What to build:** 归档视图的可见范围从「admin 独占」改成「与事项本身的可见范围一致」：**自己参与过的，归档后自己照样看得到；别人的看不到**。`admin` 仍是唯一能看到全部账号归档事项的角色。

**Blocked by:** None — can start immediately.

**Status:** resolved

**出处：** 用户 2026-10-07：「现在需要每个 user 可以查看自己已完成的事项，但看不到其他人的，实现逻辑依照 admin 的方式」。

- [x] **判据只有一处。** `server/visibility.js` 新增 `memberScope(account)`——「我是这条事项的成员之一」的 SQL 片段，**不看角色**；既有的 `ownerScope` 改成复用它（`seesAllItems ? 全放 : memberScope`）。归档那边用的是 `memberScope`，所以「自己参与过的」这条判据全仓仍只有一份。
- [x] **`items.listArchived(account)` 不再抛 403**：admin 看全部（`managesAccounts` 那一档，不变），其余账号按 `memberScope` 过滤。只读这一点没变——它仍是归档事项的唯一读入口，单条读与写路径照旧走 `requireItemAccess` 那道门。
- [x] **manager 也只看自己参与过的**（写下来是因为这里最容易分歧）：未归档那边 manager 及于全部，归档这边刻意窄一档。依据是用户原话里的「看不到其他人的」——那句话对人不对角色，manager 也不例外。要改成「manager 看全部」是一行的取舍，改之前得先改这条记录。
- [x] **端点挪出 admin 命名空间**：`GET /api/admin/archive` → `GET /api/archive`（那个前缀留给 admin 独占的操作），返回体仍是 `{ items }`，`handleArchiveList` 不再 `requireAdmin`。旧路径已不存在（404），前端只有 `api.js` 一处引用，一并改了。
- [x] **前端不再自己判角色**：`toolbarHtml` 的「显示已完成」开关对所有人都在（原来按 `canArchive` 隐藏）；`tableModel` 只按 `showArchived` 决定渲不渲染归档行。可见性一律由服务端过滤——前端不被信任这条没破。
- [x] **归档组的标签分「全部 / 我的」**：`archivedGroupLabel(archivesAll)`，admin 看到「已归档（全部，只读）」，其余人看到「已归档（我的，只读）」。**分组键（`ARCHIVED_GROUP`）不随标签变**——折叠状态与筛选认的是键，键随文案变过一次的话同一个人的折叠状态会在两处对不上。
- [x] **默认省一次请求**：装载器改成只在开关打开时才拉那一页，并新增 `archive` 触发（`REFRESH_PLAN`）供开关的 change 走。关着时（默认）谁都不发这一枪，`items` 触发照旧只拉事项——原来 admin 是常驻拉的，现在也省了。
- [x] 文档：`CONTEXT.md` 的「归档」「角色」两个词条、`README.md` 的归档规则与表格视图一节、`docs/adr/0003` 里那三处「admin 独占归档」的说法，全部改成「可见范围与事项一致，admin 另能看到全部」。
- [x] 测试 +10：新文件 `test/archive-scope.test.js`（领域层四条 + 接口层两条，含「manager 也一样」「共享事项两边都看得到」「旧路径 404」「未登录 401」），`test/items.test.js` 里那条 `listArchived(zhao) → 403` 改成断言范围，`test/tableview.test.js` 与 `test/refresh.test.js` 按新口径改写（开关对所有人都在、标签分「全部/我的」、关着时不拉归档那一页）。

## 结论

**可见范围没有新造一条规则，而是让归档回到既有的那条上。** 之前归档的可见性是门（admin 才放行），现在它是过滤（`memberScope`），于是「你能看见的事项，归档后依然能看见」这句话对每个人都成立，admin 的额外范围只是它既有的 `managesAccounts` 那一档。

一处刻意的取舍：**manager 不在例外之列**。如果哪天要让 manager 也看全部归档，改 `listArchived` 里那一个三元判据即可（`managesAccounts` → `seesAllItems`），测试与词条跟着改。

### 证据

接口层（隔离实例，三个身份各带自己的 cookie 打 `GET /api/archive`）：

```
admin  的 /api/archive： 两个人一起做完的、yiyi 做完的、jiajia 做完的   ← 全部
jiajia 的 /api/archive： 两个人一起做完的、jiajia 做完的                 ← 自己 + 共享
yiyi   的 /api/archive： 两个人一起做完的、yiyi 做完的                   ← 自己 + 共享
```

浏览器层（隔离实例 `127.0.0.2:4414`，DOM 读值）：

```
jiajia（user）打开表格视图：
  开关在不在：在（「显示已完成」）
  开关关着时状态下拉：全部 / 待开始 / 进行中 / 已逾期      ← 没有「已完成」这一档
  打开开关后：▾已归档（我的，只读） 记录数 2
             行：jiajia 做完的、两个人一起做完的          ← 看不到 yiyi 那条
             状态下拉多了「已完成」，底部统计 记录数 2
admin 打开同一页：
  ▾已归档（全部，只读） 记录数 3
  行：jiajia 做完的、yiyi 做完的、两个人一起做完的
```

全量 `node --test` **403 项全绿**（改动前 393）。

**顺带钉住的两件事**：`GET /api/admin/archive` 现在 404（归档不属于 admin 命名空间），未登录打 `/api/archive` 是 401 —— 两条都有断言。
