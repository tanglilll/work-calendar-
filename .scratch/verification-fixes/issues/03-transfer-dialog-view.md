# 03 — 转移目标换成对话框内的列表视图

**What to build:** 删除账号时，从一份可点选的候选账号列表里选转移目标、也能取消，不再依赖 `prompt()`——它已经在部分内嵌 webview 里被禁用（本轮在内置浏览器实测：点击后只弹一条「prompt() is not supported.」的错误提示，流程走不下去），于是这条管理路径只在普通浏览器里可用。

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] 点「转移事项」后，admin 对话框内出现候选账号列表（显示账号名），不再调用 `prompt()`。（代码层：`renderTransfer()` 渲染候选账号表；`grep -rn "prompt(" public/` 只剩一条注释。界面呈现待浏览器确认。）
- [x] 点选一个目标 → 事项转移成功、提示转移条数、面板随之刷新。（代码层：`data-transfer-to` 分支调既有的 `api.transferItems`，toast「已转移 N 条事项给 <用户名>」，随后 `render()` + `onDone()`，与原 `doTransfer` 同口径。界面行为待浏览器确认。）
- [x] 取消路径存在：返回后不转移、面板状态不变。（代码层：`data-act="cancel-transfer"` 只清视图状态并 `render()` 回账号列表，不调任何写接口。界面行为待浏览器确认。）
- [x] 复用既有的「按次注册监听、下次打开整体解除」与既有的事件委托约定（对话框内已经有视图切换与带载荷点选这两样现成形态），**不新增对话框元素、不引入新的监听方式**——这里历史上出过监听器叠加导致确认框弹 N 次的问题。（`bindDialogForThisOpen(dialog, { click: onAction })` 仍是本文件唯一的注册点；`grep -n addEventListener public/admin.js` 为空；未新增 `<dialog>`，未动 `index.html` / `style.css`。）
- [x] 不改动删除账号的其余流程，尤其「它作为唯一 owner 的未归档事项必须先转移」这条约束。（`doDelete()` 与 `data-del` 分支一字未改；本票未碰 `server/`。）
- [x] 在**一次性实例的临时账号**上手验「点选一个目标」与「取消」两条路径；**不要在真实库上试删账号**。证据写进工单。→ **已由主 agent 在真实浏览器里执行（路径 0 / A / B + 两条边界 + 收尾删除），结果见文末「浏览器手验结果」。**
- [x] 工单里回指出处：本票来自 `.scratch/closeout/issues/03-admin-panel-verification.md` 的「环境限制与未做」。（见「结论」末条，含原文。）

## 结论

**实现已完成，只动 `public/admin.js` 一个文件（51 增 / 16 删）：新增转移视图 `renderTransfer()` 与一个视图状态变量 `transferFrom`，删掉 `doTransfer()` 里的 `prompt()` 序号解析。** 未新增对话框元素、未改 HTML/CSS、未引入新的监听方式。`npm test` 97 项全绿（工作区里另有并行 agent 的测试增量，非本票改动），`node --check public/admin.js` 通过。**浏览器层手验未做**，按 spec 留给主 agent，步骤与期望写在下面。

### 怎么复用既有形态的

1. **视图切换**：与 `tab` 完全同一套「状态变量 + `render()` 分发」。新增 `let transferFrom = null;`（`transferFrom` 非空时 body 渲染转移列表），`render()` 里成了 `if (transferFrom !== null) await renderTransfer(); else if (tab === 'requests') …`；账号表里的「转移事项」按钮不再调用转移函数，而是 `transferFrom = Number(el.dataset.transfer); await render();`——这正是 `if (el.dataset.tab) { tab = …; await render(); }` 的写法。切 tab 时顺带把 `transferFrom` 清空，所以「在转移视图里点任一 tab」也等价于取消。
2. **带载荷的点选按钮**：候选行尾是 `<button data-transfer-to="${a.id}" data-username="${esc(a.username)}">转移给 TA</button>`，与既有的 `data-role="${r}" data-id="${a.id}"`（同样带两个载荷）同形；取消按钮用 `data-act="cancel-transfer"`，与既有 `data-act="close"` 同形。三者都落进同一个 `onAction` 事件委托，没有新的监听通道。
3. **候选列表的容器**：`table.data` +「账号 / 未归档事项 / 操作」三列，与同对话框「账号」页同一形态；未归档数直接取自 `adminAccounts()` 已返回的 `active_items`，不额外请求。
4. **监听生命周期**：仍只有第 172 行那一处 `bindDialogForThisOpen(dialog, { click: onAction })`，每次打开整体解除再注册；本文件里 `addEventListener` 出现 0 次。

### 删掉的旧代码

- `doTransfer(fromId)` 整体删除：候选号码列表拼接、`prompt()` 调用、`Number(answer) - 1` 的序号解析、`序号无效` 的报错分支全部不复存在（票里说的「原先唯一的纯逻辑」随之一并消失）。
- 空候选的处理从 `toast('没有可转移的目标账号', 'error')` 改为视图内的一行 `panel-empty` + 「返回账号列表」按钮——它现在是视图的一种状态，不再是一条转瞬即逝的 toast。

### 保留不变的行为

- 转移仍走同一个接口 `api.transferItems(fromId, toAccountId)`（`POST /api/admin/accounts/:id/transfer`），成功文案仍是「已转移 N 条事项给 <用户名>」，之后仍 `onDone()` 让日历与侧栏跟着刷新。
- 删除账号的路径（`doDelete` / `data-del` / 服务端 409「该账号名下还有 N 条未归档事项，请先转移给他人」）一字未动：转移完成才可删的时序与约束不变。转移视图里也把这条约束写进了提示语。

## 证据

范围：`git diff --stat -- public/admin.js` → `1 file changed, 51 insertions(+), 16 deletions(-)`；`git status --porcelain -- public/` 里 `public/api.js`、`public/app.js`、`public/session.js` 的改动是并行 agent 的，本票没有碰。

### 1. 不再调用 `prompt()`

```
$ grep -rn "prompt(" public/
public/admin.js:175:   * 转移视图：候选账号列成一列可点条目，取代原先的 prompt()——它在部分内嵌 webview 里被禁用。
```

只剩这一条注释；`window.prompt` 在 `public/` 下已无调用点。

### 2. 点选链路（代码层）

`onAction` 的分支（`public/admin.js`）：

- `el.dataset.transfer` → `transferFrom = Number(...)` → `await render()` → `renderTransfer()` 渲染候选表；
- `el.dataset.transferTo` → `await api.transferItems(transferFrom, Number(el.dataset.transferTo))` → `toast(\`已转移 ${res.moved} 条事项给 ${el.dataset.username}\`)` → `transferFrom = null; await render(); onDone();`

### 3. 取消链路（代码层）

`el.dataset.act === 'cancel-transfer'` → `transferFrom = null; await render();`。没有写接口调用，没有对 `tab` 或列表数据的改动，因此返回后账号表与转移前一致。`data-tab` 分支同样清空 `transferFrom`。

### 4. 没开新口子

```
$ grep -n "addEventListener" public/admin.js     → （无输出）
$ grep -n "bindDialogForThisOpen" public/admin.js
4:import { bindDialogForThisOpen } from './dialog.js';
172:  bindDialogForThisOpen(dialog, { click: onAction });
```

没有新增 `<dialog>` / `index.html` / `style.css` 改动；转移视图只是 `#admin-body` 里的一次 `innerHTML` 重渲染。

### 5. 出处

`.scratch/closeout/issues/03-admin-panel-verification.md` →「环境限制与未做的事」第 1 条原文：

> **「转移事项」的界面路径在本环境走不通**：它用 `window.prompt()` 让 `admin` 输入序号，而 IAB 内嵌浏览器禁用 `prompt`——点「转移事项」后弹出的是一条红色错误 toast `prompt() is not supported.`（面板状态不变）。因此转移这一步改用 HTTP 层并在此标注。这不代表产品在普通浏览器里坏了，但说明这条 UI 依赖一个在部分内嵌 webview 里被禁用的 API。

### 6. 静态体检

```
$ node --check public/admin.js   → 通过（无输出）
$ npm test                       → tests 97 / pass 97 / fail 0
```

## 浏览器手验步骤（留给主 agent）

**风险提示：会真的转移事项、删账号。只在这个一次性实例的临时账号上做，不要在真实库上试。** 按 `docs/agents/local-environment.md` §1 起独立进程，按 `.scratch/browser-verification/spec.md` 的点击方式操作（本环境用 DOM 派发的 `el.click()`，参见 closeout 03 的做法）。

### 准备

```bash
# 换一个没被占用的端口（并行实例互不干扰）
netstat -ano | grep ':4900 ' | grep LISTENING
powershell.exe -NoProfile -Command '$env:RILI_DB="./data/verify-b03.db"; $env:RILI_ADMIN_USER="admin"; $env:RILI_ADMIN_PASSWORD="verify-b03-pw"; $env:PORT="4900"; $env:HOST="127.0.0.1"; Start-Process -FilePath "node" -ArgumentList "server/index.js" -WorkingDirectory "D:\rili" -WindowStyle Hidden -RedirectStandardOutput "D:\rili\data\verify-b03.out.log" -RedirectStandardError "D:\rili\data\verify-b03.err.log"'
```

- 浏览器用 **`http://localhost:4900`** 打开（不要用 `127.0.0.1`）：会话 cookie 只按主机名区分、不按端口，换主机名就不会被同机其他实例顶掉登录态（`local-environment.md` 那一条）。
- 用 `admin` / `verify-b03-pw` 登录。
- 造两个临时账号：访客页提交注册申请 `b03a`、`b03b`（密码 ≥ 8 位）→ 管理 → 待批准申请 → 分别批准。
- 造一条**只属于 `b03a`** 的未归档事项：管理对话框关掉 → 新建事项（标题如「B03 手验」）→ owner 名单里**只勾 `b03a`** → 保存。
- 管理 → 账号：记下此刻 `b03a` 与 `b03b` 的「未归档事项」数（应为 1 与 0），以及 `admin` 的数（记作 A）。

### 路径 0（顺带确认约束没变，可选）

1. 点 `b03a` 行的「删除」→ 确认框选确定。
2. 期望：红色 toast「该账号名下还有 1 条未归档事项，请先转移给他人」，账号仍在表里。**这一步证明转移前置约束没被本票改动。**

### 路径 A：点选一个目标

3. 点 `b03a` 行的「转移事项」。
4. 期望：**不再出现 `prompt() is not supported.` 这类错误**；面板主体从账号表变成候选账号表——表头为「账号 / 未归档事项 / 操作」，每行一个候选账号名（至少含 `admin`、`b03b`，不含 `b03a` 自己），行尾是「转移给 TA」按钮；表下方是提示语（含 `b03a` 的名字与「点『取消』返回账号列表」）与一个「取消」按钮。记下面板里出现的候选账号名清单。
5. 点 `b03b` 那一行的「转移给 TA」。
6. 期望：toast「已转移 1 条事项给 b03b」；面板自动回到「账号」表；`b03a` 未归档变 **0**、`b03b` 未归档变 **1**、`admin` 仍为 A。关掉对话框，日历/侧栏里那条「B03 手验」的 owner 显示为 `b03b`（无需刷新页面）。

### 路径 B：取消

7. 重新造一条只属于 `b03a` 的事项（同准备步骤；或改用 `b03b` 也行，只要它有未归档事项），或者直接对 `b03b` 走这条路径——目的只是「进入转移视图再取消」。
8. 点该账号行的「转移事项」→ 列表出现 → 点表下方的「取消」。
9. 期望：面板回到「账号」表；**该账号的未归档数不变**（没有 toast、没有转移发生）；那条事项的 owner 仍是原账号。
10. 追加一条边界（同一形态）：再点一次「转移事项」→ 点任一 tab（如「归档」）→ 期望同样离开转移视图，回到该 tab 的内容。
11. 收尾验证删除仍可走通：对已无未归档事项的账号点「删除」→ 确认 → toast「账号已删除…」，行消失。

### 收尾

```bash
netstat -ano | grep ':4900 ' | grep LISTENING            # 拿 PID
powershell.exe -NoProfile -Command "Stop-Process -Id <pid> -Force"
netstat -ano | grep ':4900 ' | grep LISTENING            # 空 = 真停了
powershell.exe -NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Select-Object Id, StartTime"
# 删除 data/verify-b03.db 与 data/verify-b03.*.log
```

## 浏览器手验结果（主 agent 执行，2026-09-18）

- **环境**：一个独立进程 `127.0.0.1:4900`、库 `data/verify-b03.db`，浏览器地址栏用 `http://localhost:4900/`（换主机名避开同机其它实例的 cookie，见 `local-environment.md` §5）。账号：`admin`（启动时创建）+ 走真实「申请 → 批准」路径造出的临时账号 `b03a`(id 2)、`b03b`(id 3)；一条只属于 `b03a` 的未归档事项 `B03-check-item`。基准计数：admin 2（另有两条验证用事项）、`b03a` 1、`b03b` 0。
- **路径 0（转移前删除被拒）观察**：点 `b03a` 行「删除」→ 原生 `confirm` 弹出（浏览器自带的对话框接口读到 `type: confirm`，接受）→ **红色 toast「该账号名下还有 1 条未归档事项，请先转移给他人」**，账号仍在表里（3 行）。转移前置约束未被本票改动。
- **路径 A（点选一个目标）观察**：点「转移事项」→ 面板主体换成候选表：表头 **账号 / 未归档事项 / 操作**，候选是 `admin`(2) 与 `b03b`(0)，**不含 `b03a` 自己**；每行一个带 `data-transfer-to` 的「转移给 TA」；表下提示语含 `b03a` 的名字与「点『取消』返回账号列表」，并有「取消」按钮；**全程没有出现 `prompt() is not supported.`**（读 `#admin-body` 的文本确认）。点 `b03b` 那行 → toast **「已转移 1 条事项给 b03b」**（info 样式），面板自动回到账号表，计数变为 `b03a` **0**、`b03b` **1**、`admin` 仍 2。关掉对话框后**无需刷新**：日历色块从 `b03a: B03-check-item` 变成 **`b03b: B03-check-item`**，侧栏今日任务里也显示 `b03b · 2026-09-18 → 2026-09-18`。
- **路径 B（取消）观察**：进转移视图后点「取消」→ 回到账号表，**计数一字未变**（admin 2 / `b03a` 1 / `b03b` 0），无 toast（`#toast` 处于 hidden，文本是上一轮遗留），没有发生转移。追加边界：再进转移视图后点「归档」tab → 同样离开该视图（取消按钮消失、显示「还没有已归档的事项。」、活动页签为「归档」）。
- **收尾：转移之后删除可走通** → 对已无未归档事项的 `b03a` 点「删除」→ 接受 confirm → toast **「账号已删除」**，表里只剩 `admin` 与 `b03b`。
- **结论**：**两条路径与两条边界全部通过**，验收项逐条落地。`prompt()` 已彻底离开这条路径；转移后日历与侧栏的 owner 随之更新（依赖既有的 `onDone()` 刷新），删除仍受「先转走未归档事项」约束。
- **方法学说明与代价**：点击一律用 DOM 派发的 `el.click()`（本环境唯一可靠方式，见 `.scratch/browser-verification/spec.md`）——它证明应用自身交互逻辑正确，**不**证明「该按钮在真实鼠标下可点」。删除路径要越过二次确认，本轮用浏览器自带的对话框接口（`getJsDialog()` → `confirm.accept()`）放行，**没有**装 `window.confirm` 替身，因此也没有篡改页面行为；代价是那个原生确认框的**视觉呈现**未被观察（与 closeout 的 c4/工单 04 同口径）。填值与读值都用页面内 `evaluate`（应用提交时读 FormData，与手输等效）。
- **本轮新确认的环境事实**：原生 `confirm` 在 IAB 里**可用**（`prompt()` 被禁用）。
