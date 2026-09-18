# 08 — 约定变成可断言的数据

**What to build:** 把前端的四套隐式约定收成一处**可断言的数据**，让产出端与消费端引用同一个来源，而不是靠「记得对齐」。这轮审查核过一件事：单纯把属性词汇搬个位置**不收敛**——所以本票的价值在「可断言」，不在「搬家」。

**Blocked by:** 06（同碰 `itemform.js` / `admin.js`，且本票的断言建立在 06 抽出的纯映射上）

**Status:** resolved

## 四项

1. **`data-act` 词汇**：今天 `itemform` 用 `cancel`、`admin` / `invites` 用 `close`，同一件事两个名字。
2. **开框仪式**：`if (dialog.open) dialog.close()` → 重建内容 → `showModal()` 在三个文件各抄一遍。
3. **错误呈现**：`items-flow` 返回 result 对象由 caller 统一处理，`admin` 却在 `catch` 里特判 `err.status === 409 || 400` 再重画——两条路径。
4. **公开端点豁免**：`requiresSession: false` 是每个方法上的 flag，与判据（`session.js`）分居两处；新增公开端点忘了标，凭据错误就会触发会话收尾。

## 验收标准

- [x] 四项各只有一处定义：词汇做成导出常量、开框仪式一处实现、错误呈现一条路径、豁免清单与判据同居（`session.js` 或与之相邻的一处）。
- [x] **断言拦住回退**：产出端引用的是同一常量——有人写回字符串就会红。触发点是各对话框的 `data-act`（`calendar.js` / `sidebar.js` 的 `data-*`
      做不到，理由见文末「边界」第 1 条，执行前已与协调者确认）。
- [x] `admin` 的错误呈现并入统一路径（不再自己特判 409/400 重画）；行为不变（含一处刻意的收口，见「三、错误呈现」末段）。
- [ ] 回归：三个对话框的开合、取消、二次确认仍正常（真界面由段二结尾的浏览器冒烟勾这一条；无头可覆盖的前半段已补齐，见「二」与文末「边界」第 2 条）。
- [x] `npm test` 全绿 → **223 项通过 / 0 失败**。
- [x] 一笔提交进 `main`；提交信息里写明「为什么这不是搬家：断言的存在才让它收敛」。

## 结论与证据

**改动文件**：`public/contracts.js`（新增）、`public/itemform.js`、`public/admin.js`、`public/invites.js`、`public/session.js`、`public/api.js`；
新增 `test/contracts.test.js`（28 项），扩展 `test/session.test.js`（+3 项）。**`public/app.js` 一行未动**——三个入口签名
（`openItemDialog` / `openAdminDialog` / `openInvitesDialog` 的 `(dialog, ctx)`）与 ctx 字段都没变，07 的调用点无需跟着改。

共享定义落在**新增的 `public/contracts.js`**：三个对话框都 import 的模块只有 `api.js`（`dialog.js` 最自然，但不在本票文件清单里、且 spec 划了 Out of Scope）。
执行前把落点问题交协调者定，得到「新建 `public/contracts.js`」与「`data-*` 只覆盖对话框 `data-act`」两条答复，下面是按此执行的证据。

### 一、`data-act` 词汇

- **唯一来源**：`DIALOG_ACT`（六个词：`close` / `save` / `archive` / `delete` / `invite` / `cancel-transfer`）。`cancel` 与 `close` 的分歧收成一个词
  `close`——itemform 头部的 ✕、底部的「取消」，admin / invites 的 ✕，现在都是它（渲染实测：三个对话框的头部 ✕ 都是 `data-act="close"`）。
- **产出端** `actAttr(DIALOG_ACT.x)`（属性名 `data-act` 也只在 contracts.js 出现）；**消费端** `readAct(el)` + `runAct(handlers, act)`，处理器表以
  `[DIALOG_ACT.x]` 计算键。
- **拦住回退的断言**（`test/contracts.test.js`「产出端与消费端引用同一常量」）：
  - 静态：三个模块里出现 `data-act=` 字面量即红；每个产出的词必须经 `actAttr(DIALOG_ACT.x)`；
  - 静态：出现 `dataset.act` 即红（读动作词必须走 `readAct`）；`act === '…'` / `readAct(...) === '…'` 这类字面量比较即红；处理器表必须以 `[DIALOG_ACT.x]` 作键；
  - 集合：每个对话框「产出的词 == 处理器表的词」，三个文件合起来正好用满词表（少一个处理器、或产出词表外的词，都会红）；
  - 行为：用伪 dialog 接住三个对话框**真实渲染出来的标记**，从头部 ✕（`title="关闭"`）读出动作词，断言它等于词表里的 `close`，再按读出来的那个词派发点击、断言 `dialog.open` 变 false。
- **退化验证**（临时目录副本，不碰共享工作区）：itemform 的保存/取消按钮写回 `data-act="save"` / `data-act="cancel"` → **3 项红**（含上面那条集成断言）；
  invites 的处理器表键写回 `'close'` 字面量 → **2 项红**；词表里 `close` 的值改成 `dismiss` → **2 项红**。

### 二、开框仪式

- **唯一实现**：`openDialog(dialog, { html, listeners, onOpen })`——已开着先关 → 重建内容 → `bindDialogForThisOpen` 按「这一次打开」注册 → `showModal()` → `onOpen`。
  三个对话框各只剩一次 `openDialog(...)` 调用；控件改成按需查找（如 `const form = () => dialog.querySelector('#item-form')`），内容仍由各自构建。
- **拦住回退的断言**：
  - 行为（伪 dialog）：顺序恰为 `close → innerHTML → listen → showModal → onOpen`；没开着就不产生多余的 `close`；重开一次会把上一次的监听整组 `abort`（监听不累积）；`onOpen` 在 `showModal` 之后；
  - 静态：三个模块里出现 `showModal` 或 `dialog.open` 即红（仪式副本没有落点）；
  - 集成：上面「点 ✕ 关框」那条同时覆盖开框（点之前 `dialog.open === true`）。
- **退化验证**：在 admin.js 里再插一行 `dialog.showModal()` → **1 项红**。

### 三、错误呈现

- **唯一路径**：`presentResult(result, ui)`——`fields → 表单字段错误`、`message → 错误提示`、`toast → 信息提示`、`refresh → 重画`、
  `close → 关框并通知应用层`、`done → 通知应用层`；空结果（用户取消二次确认）什么都不做。`outcomeOf(action)` 把抛出的错误归一成同形结果，
  `failureResult(err)` 是失败结果的唯一构造处。
- **admin 的合并**：删掉 `onAction` 的 `try/catch { toast; if (err.status === 409 || err.status === 400) await render() }` 与 `doDelete` 自己的 catch；
  六个操作改为 `perform(el)` 返回 `{ok, toast, refresh, done}`，`onAction` 只剩 `presentResult(await outcomeOf(() => perform(el)), ui)`。
  **409/400 的重画没有消失，它换了归属**：成为 `failureResult` 里的一行数据（「屏幕上的副本可能已过期 → refresh」），呈现层不判状态码。
- **行为为何不变**：成功路径逐条对齐旧顺序（提示 → 重画 → `onDone`）；失败的用户可见行为不变（错误提示、对话框不关、面板可用），409/400 仍然重画。
  **一处刻意收口要写明**：旧 `doDelete` 的 catch 无条件重画，与同文件另一条 catch 的「只有 409/400 重画」互相矛盾；统一后删账号的 403/404/5xx 失败不再重画
  （错误文案与「对话框不关」都不变）。这是把两条不一致收成一条，不是行为漂移。
- **拦住回退的断言**：行为——`presentResult` 的六种结果各一条（含 `refresh` 先于 `done`、重画失败要 toast 出来而不是静默、空结果什么都不做）；
  `failureResult` 对 409/400 给 `refresh: true`、对 403/404/429/5xx/无状态给 false；`outcomeOf` 的通过与归一。静态——`admin.js` 里出现 `err.status` 或
  `409` / `400` 即红，且 `itemform.js` 与 `admin.js` 都必须调 `presentResult` / `outcomeOf`。
- **退化验证**：把那段特判塞回 admin 的 `onAction` → **1 项红**。

### 四、公开端点豁免

- **唯一来源**：`session.js` 的 `PUBLIC_ENDPOINTS`（四条，逐条写明为什么）+ `isPublicEndpoint(path)`；判据升级为 `shouldEndSession(status, path)`，
  豁免长在判据里面，调用点没有「记得传 flag」的机会。`api.js` 四个 `requiresSession: false` 全部删除，`request` 只问一次判据。
- **拦住回退的断言**：
  - 静态：`api.js` 里出现 `requiresSession` 即红（豁免没有第二个落点）；
  - 行为（接线自洽）：逐个调 `api` 的 22 个方法（替身 fetch 记下各自路径），401 时「是否结束会话」必须与清单一致；公开端点还要保住服务端那句错误文案
    （不能被顶成「登录已失效」）；
  - 跨层（**这条才是拦住「新增公开端点忘了标」的**）：拿 `freshWorld()` 的真 `handleApi`，先用「未登录访问 `/api/items`」标定会话门的形状
    （不写死任何文案），再逐条探测 `api` 用到的路径——服务端不要会话的路径清单必须豁免、要会话的清单不能豁免。新增服务端公开路由 + 客户端方法而忘了进清单，这条就红。
- **退化验证**：从清单里删掉 `/api/login` → **2 项红**（含跨层那条，报错文案直接说清「服务端不要会话，清单必须豁免它」）。

### 测试结果

- `node --test test/contracts.test.js test/session.test.js` → 28 + 7 项通过 / 0 失败。
- `npm test`（全量，并发各线的新增也在内）→ **223 项通过 / 0 失败**。
- 六次退化注入（临时目录副本）逐一被预期判据逮住，见各节；`public/app.js` 未改动；三个入口签名与 ctx 字段未变。

### 边界（写明做不到的部分，不假装覆盖）

1. **`data-*` 只覆盖对话框的 `data-act`**：`calendar.js` / `sidebar.js` 产出的 `data-item-id` / `data-add-date` / `data-date`，消费端在 `app.js`
   （本票禁改，07 正在改）——做不到「产出端与消费端引用同一常量」，而且这两个文件不在本票文件清单里。执行前已与协调者确认按此执行。
2. **只能在浏览器里验的部分**（留给段二冒烟）：真实指针点击、原生 `confirm` 二次确认、`showModal()` 的原生行为与聚焦、面板/邀请列表的真实重画。
   本票覆盖的是它们的前半段：开框顺序与监听不累积（伪 dialog）、动作词到处理器的派发（真实渲染标记）、失败结果的呈现规则（伪 ui）、失败后是否重画（共享的 refresh 位）。
3. **两处仍是各自的落点**：`app.js` 的 `endSession()` 里 `if (dialog.open) dialog.close()`（会话失效时关掉所有对话框的收尾路径，不是开框仪式；收进契约要改 `app.js`）；
   以及三个对话框「初次渲染失败」时写在面板/列表里的那句错误文案（那是视图内容，不是操作结果的呈现——`presentResult` 是 toast / 字段错误 / 关框 / 重画那条路径）。

## 主 agent 核对（2026-09-18）

- **提交范围**：`71ab418`，9 个文件全是本票的；提交后工作区干净。`public/app.js` 一行未动（07 提交后的调用点已核对）。全量套件 **223 项全绿**（本票新增 31 条）。
- **补的一处**：新增的 `public/contracts.js` 没有登记进 README 的「代码结构」清单——这个仓库的惯例是保持它最新（前一轮加 `session.js` 时就同步过）。已由主 agent 补上一行，并顺带把 `app.js` 那行更新为「状态与重拉声明表（事件 → 要重拉的字段）、实时同步、事件委托」，与 07 的重构对齐。
- **两处行为变化已在票里记录**，段二冒烟覆盖：`cancel` / `close` 统一为 `close`；删账号的 403 / 404 / 5xx 失败不再重画（旧 `doDelete` 的 catch 无条件重画，与同文件另一条 catch 矛盾，统一后消除）。
- **边界第 1 条已确认合理**：`data-*` 契约只覆盖对话框的 `data-act`；`calendar` / `sidebar` 产出的 `data-item-id` / `data-add-date` 的消费端在 `app.js`（本票禁改），留待将来。
