# 06 — 补上可 headless 的判据

**What to build:** 给那些「本来就能用 `npm test` 覆盖、却一条断言都没有」的 module 补上判据，把小抽取做掉，让界面行为里可 headless 的那一半不再靠真实浏览器会话换。段二的排头票——先铺判据，后面两票改 `itemform.js` / `admin.js` 时才有人接着。

**Blocked by:** None — can start immediately.（段二第一张）

> **执行可以拆成两半并行**（见 spec 的并行波次表）：**06a = 前三条判据**（`calendar` / `sidebar` / `items-flow` 邀请分支）——已核实这三个 module 把需要的函数都导出了，所以这半边**只新增测试文件、零源码改动**，与任何线都不抢文件；**06b = 后两条**（`collect()` 映射与 admin 视图迁移）必须先抽取，会改 `itemform.js` / `admin.js`，因此与 08 同线。两半各自由一个 agent 推进时，本票的验收条款合起来看。

**Status:** ready-for-agent

## 五处判据

1. `calendar`：42 格、周一起始、跨月裁剪（上月末与下月初照常渲染事项）、同格排序（先起始日期，再标题）。
2. `sidebar`：分桶不变量——**逾期基线 = 已逾期 + 今天截止**，两组不重叠；今日任务与截止提醒各自的口径。
3. `items-flow` 的邀请两分支：`invitePeople` / `respondToInvite`（今天零覆盖）。
4. `itemform` 的**值对象 → payload 映射**（需小抽取：把映射变成不依赖 DOM 的纯函数，读 `FormData` 的那一步仍留在浏览器）。
5. `admin` 的**视图状态迁移**（页签 + 转移视图，需小抽取）：候选列表不含源账号、无候选时是空视图、取消不改数据。

## 验收标准

- [ ] 五个 module 各有一个测试文件（沿用 `test/` 现有惯例与 `test-helpers/world.js`）。
- [ ] 断言只针对外部可观察行为：不逐字符串断言 HTML、不断言实现细节；`calendar` 的断言针对格子与染色结果，`sidebar` 的针对分桶。
- [ ] README 里那条分桶不变量**第一次有断言**（工单里点名这条）。
- [ ] 两处小抽取之后，映射与视图迁移可以在 `node:test` 里直接调用；调用方（`app.js` / `admin.js`）的行为不变（全量套件与既有浏览器结论都还成立）。
- [ ] 每条断言读起来能说明它防的是什么；不确定能防什么的断言不写。
- [ ] 全量套件全绿（预计从 97 项显著增加）。
- [ ] 一笔提交进 `main`；提交信息里列出五处判据各自防的是什么。

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
