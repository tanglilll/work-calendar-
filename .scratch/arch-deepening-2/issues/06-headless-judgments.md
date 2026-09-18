# 06 — 补上可 headless 的判据

**What to build:** 给那些「本来就能用 `npm test` 覆盖、却一条断言都没有」的 module 补上判据，把小抽取做掉，让界面行为里可 headless 的那一半不再靠真实浏览器会话换。段二的排头票——先铺判据，后面两票改 `itemform.js` / `admin.js` 时才有人接着。

**Blocked by:** None — can start immediately.（段二第一张）

> **执行可以拆成两半并行**（见 spec 的并行波次表）：**06a = 前三条判据**（`calendar` / `sidebar` / `items-flow` 邀请分支）——已核实这三个 module 把需要的函数都导出了，所以这半边**只新增测试文件、零源码改动**，与任何线都不抢文件；**06b = 后两条**（`collect()` 映射与 admin 视图迁移）必须先抽取，会改 `itemform.js` / `admin.js`，因此与 08 同线。两半各自由一个 agent 推进时，本票的验收条款合起来看。

**Status:** resolved

## 五处判据

1. `calendar`：42 格、周一起始、跨月裁剪（上月末与下月初照常渲染事项）、同格排序（先起始日期，再标题）。
2. `sidebar`：分桶不变量——**逾期基线 = 已逾期 + 今天截止**，两组不重叠；今日任务与截止提醒各自的口径。
3. `items-flow` 的邀请两分支：`invitePeople` / `respondToInvite`（今天零覆盖）。
4. `itemform` 的**值对象 → payload 映射**（需小抽取：把映射变成不依赖 DOM 的纯函数，读 `FormData` 的那一步仍留在浏览器）。
5. `admin` 的**视图状态迁移**（页签 + 转移视图，需小抽取）：候选列表不含源账号、无候选时是空视图、取消不改数据。

## 验收标准

- [x] 五个 module 各有一个测试文件（沿用 `test/` 现有惯例与 `test-helpers/world.js`）→ `calendar` / `sidebar` / `itemform` / `admin-view` 四个新文件，`items-flow` 扩展既有文件。**这张票由两个 agent 分两半并行执行**（06a 纯判据、06b 两处抽取），各自一笔提交（`daa5124`、`70b85eb`）；下面的勾选由主 agent 在两半都完成后核对。
- [x] 断言只针对外部可观察行为：不逐字符串断言 HTML、不断言实现细节；`calendar` 的断言针对格子与染色结果，`sidebar` 的针对分桶 → 成立，但**有一处例外经主 agent 判断后保留**：`test/itemform.test.js` 的「表单控件与字段表同源」是一条**静态一致性检查**（读模块源码里的 `name="…"`，与字段表 ∪ 单独读取清单比对）。它断言的是两张表的同源关系、不是 HTML 字符串，且防的正是 `21b42ba` 的镜像风险（加了控件忘了接线）。**它的局限要写明**：正则 `[^"${}]+` 不匹配插值写法，若将来控件名改成 `name="${…}"`，这条会静默失去覆盖面——那时要么改成正则覆盖插值，要么把它降级为评审项。
- [x] README 里那条分桶不变量**第一次有断言**（工单里点名这条）→ `test/sidebar.test.js` 首条：「逾期基线 = 已逾期 + 今天截止，且两组不重叠」，并含边界（昨天 vs 当天）。
- [x] 两处小抽取之后，映射与视图迁移可以在 `node:test` 里直接调用；调用方（`app.js` / `admin.js`）的行为不变（全量套件与既有浏览器结论都还成立）→ 抽取后 `openItemDialog` / `openAdminDialog` 签名与 ctx 字段未变，**`app.js` 一行未动**（06b 明确报告没有非改不可之处）。
- [x] 每条断言读起来能说明它防的是什么；不确定能防什么的断言不写 → 两节的证据里逐条写了「防的是什么」，并各带一次**退化验证**（在临时副本上注入 6 个代表回归 / 删字段表项，确认预期判据会红）。
- [x] 全量套件全绿（预计从 97 项显著增加）→ **161 项通过、0 失败**（97 → 161，两半合计新增 64 项）。
- [x] 一笔提交进 `main`；提交信息里列出五处判据各自防的是什么 → 见两笔提交；五处判据的「防什么」以本票两节为准。

## 06a（纯判据）结论与证据

**范围**：前三处判据（`calendar` / `sidebar` / `items-flow` 邀请两分支）。只新增/扩展测试文件，**零源码改动**——实测三个 module 的现有导出（`GRID_SIZE` / `buildGrid` / `assignItems` / `gridHtml`、`computeGroups` / `renderPanels`、`invitePeople` / `respondToInvite`）足够覆盖判据，不需要任何抽取。

**新增 31 项断言**：`test/calendar.test.js` 14 项、`test/sidebar.test.js` 9 项、`test/items-flow.test.js` 新增 8 项（该文件原有 13 项未动）。全量 `npm test`：**161 项通过 / 0 失败**（含并发各线新增；本半 44 项单跑亦全过）。

### calendar（`test/calendar.test.js`，14 项）

- 42 格：`GRID_SIZE === 42`，且 6 个锚定月（含一月/闰二月/年界）都恰好 42 格——防某次翻月改动让网格变长变短。
- 周一起始：首格与每第 7 格都是周一、日期逐格 +1、`day` 字段与日期一致——防「周日为首」这类 off-by-one 让整月错位。
- 锚定当月：4 个锚点（1 号周一 / 周二 / 周日 / 闰二月）的首末日期精确匹配，当月每一天都在且只有当月格标 `inMonth`——防起点算术在边界月算错。
- `isToday`：只标今天那一格；今天落在上月末补格时照样高亮；落在 42 格之外则一格不标——防高亮落到错误格子。
- 跨月裁剪：起点在网格前的跨月事项裁到首格、终点在下月初的跨月事项染到补格、完全在网格外的事项不出现——防有人加「非当月格跳过」把跨月染色切断（README 明确承诺不断裂）。
- 同格排序：起始日期早的在前（即使标题排序靠后），跨多日事项在它覆盖的每个格子位置一致——防色块在格子里跳位置。
- 同格排序（同起始日）：按 zh 标题序且与输入顺序无关——防列表刷新顺序变成渲染顺序。
- 渲染：42 格一个不少、每条事项在它覆盖的每格各渲染一块、未覆盖的格没有它——防渲染丢格或串格。
- 渲染（折叠）：同格超过 4 条时画 3 块且「+N 项」的 N 等于被折叠条数——防折叠数撒谎。

### sidebar（`test/sidebar.test.js`，9 项）

- **逾期基线 = 已逾期 + 今天截止**：两组合并后与独立算出的 `due_date <= 今天` 集合逐项相等、长度相加相等、交集为空——这是 README 白纸黑字的承诺，**此前一条断言都没有**，本票点名的就是它；防两组重叠或漏项让面板汇总计数悄悄漂掉。
- 基线边界：昨天截止进「已逾期」、当天截止进「今天截止」——防把 `<` 与 `===` 写反。
- 今日任务 = 覆盖今天（`event_date <= 今天 <= due_date`）——防跨天事项从「今天要做的」里漏掉。
- 多日任务 = `event_date < due_date`，单日不算、已结束的也算——防把单日事项塞进多日清单。
- 已知重叠：今天做且今天截止的单日事项同时出现在两个面板（README 写明不是 bug）——防有人把它当 bug 从某一组删掉。
- 空列表：四组皆空且不抛错——防空数据路径抛错。
- `renderPanels`：截止提醒的汇总计数同时等于「两组之和」与「逾期基线总数」，行集合等于两组——防界面上的数字与分桶脱节。
- `renderPanels`：今日任务与多日面板各自的计数与行等于本组——防两个面板串数据。

口径说明：`computeGroups` 只看日期，「未归档」由上游保证（`server/items.js` 列表只发未归档项，已有 `test/items.test.js`「已归档的不出现在列表里」覆盖），纯函数层不重复断言归档，测试文件头部已写明这条归属。

### items-flow 邀请两分支（`test/items-flow.test.js`，新增 8 项）

- `invitePeople` 未保存（`item === null`）就邀请：不碰网络，把 `fields.invite_ids` 交回表单——防对没有 id 的事项发请求。
- `invitePeople` 没勾人：不碰网络并提示先勾选——防一次空点击发出零条请求却报成功。
- `invitePeople` 成功：逐个账号各发一条、顺序与勾选一致、`close: false`、toast 条数如实——防批量邀请漏发/多发，也防邀请把未保存的编辑对话框一起关掉。
- `invitePeople` 失败：某一条被拒后不再发后面的，如实报出该条错误——防部分成功后继续改动名单、防谎报成功。
- `respondToInvite` 接受：只调 `acceptInvite`（一条请求），提示事项已进自己看板——防一次点击同时触发接受与拒绝。
- `respondToInvite` 拒绝：只调 `rejectInvite`，提示对方可以再邀——防接受/拒绝互串。
- `respondToInvite` 接受失败（已失效 / 冲突）：`{ok: false, message}`，不弹成功提示——防在邀请已失效时谎报「已接受」。
- `respondToInvite` 拒绝失败：同样如实报错，不弹成功提示——防失败被静默吞掉。

### 会红的证据（不改仓库源码）

在系统临时目录复制三个 module 与三份测试，对副本注入 6 个代表回归，逐一跑三份测试，全部被预期的判据逮住：

| 注入的回归 | 红掉的判据 |
| --- | --- |
| `calendar` 周一起始改周日起始 | 周一起始、起点终点、逐格连续、跨月染色（4 项） |
| `calendar` 跳过非当月补格 | 「上月末与下月初的补格照常染色」 |
| `calendar` 取消同格排序 | 同格排序两项 |
| `sidebar` 今天截止放宽为 `due <= 今天`（两组重叠） | 逾期基线、基线边界、汇总计数（3 项） |
| `sidebar` 今日任务改为只认 `due === 今天` | 今日任务口径、面板行集合（2 项） |
| `items-flow` 删掉「先保存才能邀请」守卫 | 「未保存不碰网络」 |

**必须改源码才能断言的地方：无。** 三个 module 的现有导出已足够；唯一不在本层的是「今日任务……且未归档」的后半句——服务端列表已是过滤后的结果，纯函数层无法也不该假装断言归档，该半句由 `test/items.test.js` 在服务端层覆盖。

## 06b（两处抽取）结论与证据

本半只改四个文件：`public/itemform.js`、`public/admin.js`、新增 `test/itemform.test.js` 与
`test/admin-view.test.js`。**`public/app.js` 一行未动**——两处抽取都在模块内部，入口签名
`openItemDialog(dialog, ctx)` / `openAdminDialog(dialog, ctx)` 与 ctx 的字段都没变，`app.js`
的两处调用（`app.js:165` / `app.js:178`）无需跟着改，也就没有出现「非改 `app.js` 不可」的情况。
三个对话框的开合、`onDone` 刷新时机、错误呈现路径都照旧。

### 一、`itemform`：值对象 → payload 的映射

**抽取前。** `collect()` 长在 `openItemDialog` 内部，直接读 DOM：`new FormData(form)` 之后手写
五个键的取值与归一（`String(fd.get('title') || '')`、标签空即 `null`、`canAssign` 时再读一遍勾选组）。
字段清单、取值方式、归一规则挤在同一个函数体的五行里，要断言「表单填了进展，payload 就带进展」
只能开一轮浏览器。

**抽取后。** 模块顶部三个具名导出，`collect()` 缩成一行：

- `ITEM_FORM_FIELDS`——字段表，每项 `{ name, empty }`：`name` 同时是 form 控件名、值对象的键与
  payload 键；`empty` 是空值归一结果（文本空即 `''`，标签空即 `null`）。
- `itemValues(reader)`——按字段表从读取器（FormData，或任何有 `get(name)` 的对象）取出普通值对象。
- `itemPayload(values, { canAssign })`——值对象 → payload，由字段表派发；`owner_ids` 刻意不走表
  （多选勾选组 `FormData.get` 只给第一个），只在 `canAssign` 时出现，id 统一 `Number`。
- 调用方：`itemPayload(itemValues(new FormData(form)), { canAssign })`。**读 FormData 的那一步留在
  浏览器里**，纯函数只吃普通值对象。

读值（`itemValues`）与写 payload（`itemPayload`）由同一张表派发，所以「表单加了字段却忘了收集」
在映射这一侧没有落点。归一结果与旧代码逐字一致（`String(v ?? '') || empty` 对 FormData 的
string|null 输入与旧的 `String(v || '')` 等价），payload 的键集合不变，因此调用方与协议都不动。

**新增断言（`test/itemform.test.js`，9 条）各防什么。**

| 断言 | 防的是 |
| --- | --- |
| 填了进展就一定带着进展提交 | 21b42ba「进展被静默丢掉」的镜像：表单里填了、payload 里没有 |
| 字段表里每个字段都原样进 payload | 构造 payload 时漏掉字段表里的某一项 |
| 文本字段空 / 缺 → `''`（不是 undefined） | 空表单提交出 `undefined`，服务端拿到非字符串 |
| 标签空 → `null` | 空标签发成 `''` 与白名单校验打架（服务端只接受白名单或 null） |
| `canAssign` 时 owner_ids 归一成数字，空勾选是 `[]` | 勾选组类型漂成字符串；空名单发成 undefined |
| 非 `canAssign` 时 payload 没有 owner_ids 键 | 普通成员保存时试图改 owner 名单 |
| `itemValues` 按字段表取值（用真的 FormData 跑） | 读值清单与字段表脱钩 |
| 表单读取 → payload 整条纯链路 | 两层接不上（浏览器里 `collect()` 走的正是这两步） |
| 表单控件与字段表静态一致 | 见下 |

最后一条是**静态一致性检查**：读取本模块源码里所有 `name="…"` 的控件名，断言它们与
`ITEM_FORM_FIELDS ∪ {owner_ids, invite_ids}` 一一对应（后两个是刻意豁免的多选勾选组）。node:test 里
没有 DOM 能看见表单，这条补的正是「在表单里加了控件却忘了接线」这个缺口；它断言的是两张表同源，
不是 HTML 字符串。边界如实写明：只覆盖写在本模块里、形如 `name="…"` 的控件，看不见脚本动态生成的
控件（当前没有这种控件）。

### 二、`admin`：视图状态迁移与候选计算

**抽取前。** 两个 `let`（`tab`、`transferFrom`）加 `render()` 里的 if/else 决定渲染哪个视图；
候选账号列表（剔除源账号、无候选、源账号已在别处被删）在 `renderTransfer()` 里现算；取消、切页签、
转移完成、渲染出错四处各自手写状态复位。这一段验收大半是视图状态，只能拿一轮真实浏览器会话换。

**抽取后。** 模块顶部四个具名导出，`render()`/`onAction()` 只按状态渲染与接网络：

- `initialAdminState()` → `{ tab: 'requests', transferFrom: null }`。
- `adminView(state)` → `'transfer' | 'requests' | 'accounts' | 'archive'`，转移视图优先于页签。
- `adminTransition(state, event)` → 下一个状态；事件三类：`select-tab`（切页签，同时离开转移视图）、
  `open-transfer`、`close-transfer`（取消 / 转移完成 / 渲染出错 / 源账号已不存在四种归同一类）。
- `transferCandidates(accounts, fromId)` → `{ from, targets }`：`targets` 不含源账号；没有可接收的
  账号就是 `targets: []`（渲染成空视图）；源账号已不存在返回 `null`（调用方退回账号列表）。

`render()` 仍在原位置、原调用点，只是分支改由 `adminView(view)` 决定；`onAction` 与 `renderTransfer`
里的四处赋值换成 `adminTransition(...)`。**调用方行为不变**：`openAdminDialog(dialog, ctx)` 的签名与
ctx 字段未变，`app.js` 不动；页签高亮、`onDone` 刷新、错误分支把转移视图收回去这几件事的时机都与
原来一致。

**新增断言（`test/admin-view.test.js`，11 条）各防什么。**

| 断言 | 防的是 |
| --- | --- |
| 打开面板先看到待批准申请 | 初始视图漂移 |
| 三个页签都能到对应视图 | 分发把某个页签落错（尤其 archive 是兜底位） |
| 转移视图优先于页签 | 进了转移视图却被页签视图盖掉 |
| 切页签顺便离开转移视图 | 残留 `transferFrom`，切页签后仍渲染转移视图 |
| 取消转移：只清源账号、页签不动、回到账号列表 | 「取消回到空视图 / 回到别的页签」这类回归 |
| 完成、出错、源账号已不存在都与取消同路 | 四条出口各自复位，漏一条就停在不该停的视图 |
| 迁移是纯的，不改传进来的状态 | 迁移里偷偷写状态（顺序耦合、重入问题） |
| 候选里不含源账号自己 | 把自己列成转移目标（服务端必然拒绝） |
| 没有别的账号可接收：`targets` 为空 | 无候选时不是空视图而是停住/渲染出不可用的选择 |
| 源账号已不存在：给 `null` | 停在指向不存在账号的视图上（面板开着时账号在别处被删） |
| 只读：不改动账号列表与其中的账号 | 候选计算顺手改数据——「取消不改数据」在纯层是结构性的 |

「取消不改数据」拆开看：取消路径（`close-transfer`）只改视图状态，不碰账号数据，这一半由纯函数
断言；不发出任何写请求那一半在 DOM 层（取消分支是 `render()`，没有 `api.*` 调用），仍属于段界
浏览器冒烟的范围。

### 红→绿的验证

在**临时目录的副本**上做退化（不触碰共享工作区，避免并发 agent 的 `npm test` 看到假红）：

- 字段表里删掉 `progress`（等价于「表单有 textarea、收集器没有它」）→ itemform **5 条红**，
  其中正是「填了进展就一定带着进展提交」与静态对齐那两条；
- `transferCandidates` 不剔除源账号 → **2 条红**（不含源账号 / 无候选为空）；
- `close-transfer` 不复位 → **3 条红**（取消、四条出口同路、迁移是纯的）。

### 证据

- `node --test test/itemform.test.js test/admin-view.test.js` → **20 项通过、0 失败**（itemform 9 +
  admin 11）。
- `npm test` → **161 项通过、0 失败**（并发波次中：基线 97 + 本半 20 + 同波次其它线的判据）。
- `public/app.js` 未改动；两处入口签名不变；两处映射的返回值与旧代码逐字一致。

## 段界冒烟抓到的回归（2026-09-18，主 agent）

**事实**：06b 的抽取丢掉了 `owner_ids` 的收集。改前 `collect()` 里有一行
`if (canAssign) payload.owner_ids = checkedIds('owner_ids')`；抽取后 `collect()` 变成
`itemPayload(itemValues(new FormData(form())), { canAssign })`，而 `itemValues` **只读字段表那五个字段**，
于是 `values.owner_ids` 恒为 `undefined`，`itemPayload` 恒产出 `owner_ids: []`——`checkedIds` 成了死代码，
注释里那句「由调用方数出已勾选的项」没有调用方去兑现。

**后果（比它看起来严重）**：`manager` / `admin` 在界面上**建不出事项、也存不了编辑**（服务端一律
400「owner 名单至少要有一个人」）。`user` 不受影响（不提交 `owner_ids`），所以只有管理员这一半坏了。

**为什么判据没拦住**：`test/itemform.test.js` 断的是「值对象 → payload」这一步（喂进去的 values 自带
`owner_ids` 时行为正确），而漏的是**值对象怎么来的**那一步；那条静态一致性检查只断言「控件名与字段表 ∪
单独读取清单同源」，`owner_ids` 恰好在那份清单里，于是它也绿。**两张判据都绿，而真实用户点不动保存。**

**本票结论里那句「调用方行为不变」在这一半上不成立**——它在冒烟里被推翻。这也正好印证了票面把
「界面行为留给主 agent 在段界冒烟时验」这条分工的必要性：纯函数抽取能保证映射本身对，保证不了调用方
把它接对了。

**修法（已提交）**：把勾选组的取值收进 `itemValues`（`reader.getAll('owner_ids')`——`FormData` 本来就
为勾选组提供 `getAll`；不认这个方法的纯对象会被跳过）。契约随之更新为「字段表 + 勾选组，两类值都从
表单读出来」，那条既有的键集断言同步改成新契约。

**新增判据（3 条，附红证据）**：已勾选的 `owner_ids` 进 payload、没勾选时是空数组且 payload 里不出现
该键、读取器没有 `getAll` 也不炸。**红证据**：把 `itemValues` 里那一行退化掉后跑
`node --test test/itemform.test.js` → 3 条失败（含这条回归断言）；恢复后 12 项全绿，全量 275 → **278 项全绿**。

**浏览器端确认（一次性实例 `localhost:4970`）**：修复前请求体是
`{"…","owner_ids":[]}` → 400；修复后是 `{"…","owner_ids":[1]}` → **201**，对话框关闭、日历出现
`admin: Smoke-A`、侧栏显示出填写的进展。

**顺带记一条 UX 观察（不在本轮范围）**：管理员新建事项时 owner 名单**没有默认勾选**，必须自己勾一个，
否则吃 400。这是既有行为（改动前后 `isOwner` 一字不差），不是本轮引入；要不要给个默认（例如预勾自己）
是一个产品取舍，另议。
