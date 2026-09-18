# 02 — 复测窄屏顶栏，关闭工单 06

**What to build:** 窄屏顶栏的修复已经实施（整块折行：顶栏容器允许折行、每一块内部禁止断行与收缩、右侧按钮组可自行分行）。本票负责在真实浏览器里复测四个宽度，给出与修复前对照的数字，据此决定工单 06 关闭还是回到决策。

**Blocked by:** None — can start immediately.（建议与 03、04、05 共用一个浏览器会话与一个实例）

**Status:** resolved

- [x] 在 1280 / 700 / 520 / 420 四个视口宽度下实测：顶栏每一块内部的行数、顶栏是否横向溢出（比较 `scrollWidth` 与 `clientWidth`）。**沿用原工单的量法**——按文本节点占用的矩形数计行数、读滚动宽度判溢出，不使用目测、不依赖截图。
- [x] 四个宽度下顶栏每一块内部都是单行；420px 时顶栏无横向溢出；顶栏所有按钮都完整可见、可点。
- [x] 对照修复前的数字写成一张表写回工单 06（同一批宽度、同一量法），并说明恢复到大宽度后行为正常。
- [x] 若某宽度未达预期：把实测值写进工单并回到取舍（顶栏横向滚动 / 声明不适配窄屏），**不要静默放宽验收标准**，也不要把验收标准改成「比修复前好」。 → 未触发，四个宽度全部达预期。
- [x] 工单 06 转 `resolved`，或在带着实测数据的情况下转回 `needs-triage` 重新决策。 → 转 `resolved`
- [x] 记录里提到顶栏品牌时使用产品名「工作日历」。

## 结论

**通过，工单 06 关闭。** 四个宽度下顶栏每一块内部都是单行，420px 顶栏 `scrollWidth === clientWidth === 405`（修复前是 449 > 405），五个可见按钮全部完整落在视口内、中心点命中的就是按钮自己。回到 1280 后数字与首次逐项相同。

对照不靠引用旧数字：这次在**同一个页面**里用 CSSOM 注回修复前的样式、用同一量法复测，再撤掉——所以「修复前 / 修复后」是同实例、同量法的真对照。撤样式与「回到大宽度」两次复位都验证过，数字都回到基线。

沿用量法时的一处必要补充：原表把「品牌 / 按钮」逐项列出来，本次在同样的列之外多记了一列 `.month-nav`（月导航块），并在每个宽度下额外做**按钮矩形的视口内判定**与**中心点 `elementFromPoint` 命中判定**——因为「点不到」是本缺陷从「不好看」升级成真问题的原因，而这需要比行数更直接的证据。

## 证据

全部在 2026-09-18 本机完成。

### 环境

| 项 | 值 |
| --- | --- |
| 实例 | 独立进程（`Start-Process`，`local-environment.md` §1 那条命令），非宿主后台任务 |
| 端口 / 绑定 | `127.0.0.1:4500`，`netstat` 见 `LISTENING` |
| 库 | 空库 `data/verify-02.db`（启动时按环境变量创建初始 `admin`） |
| 账号 | `admin`（`whoami` 显示 `admin（admin）`，`capabilities` 三项全 `true`） |
| 浏览器 | ZCode 内置浏览器（IAB），视口高 720 |
| 隔离 | 端口 4100/4200/4300/4400 全程空闲；未触碰 `data/` 下任何既有实例的库 |

### 修复后（本次实测）

| 视口宽 | 工作日历 | 月导航 | + 新建事项 | 管理 | 登出 | 顶栏 `scrollWidth` / `clientWidth` | 溢出 | 顶栏高度 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1280 | 1 行 | 1 | 1 行 | 1 行 | 1 行 | 1265 / 1265 | 否 | 55px |
| 700 | 1 | 1 | 1 | 1 | 1 | 685 / 685 | 否 | 55px |
| 520 | 1 | 1 | 1 | 1 | 1 | 505 / 505 | 否 | 105px |
| 420 | 1 | 1 | 1 | 1 | 1 | 405 / 405 | 否 | 105px |
| 1280（回到） | 1 | 1 | 1 | 1 | 1 | 1265 / 1265 | 否 | 55px |

行数 = 该块内**任一文本节点的最大行盒数**（`Range.getClientRects().length`），所以「1」等于块内没有任何文字被拆行。整页同样无横向溢出：四个宽度下 `documentElement.scrollWidth === clientWidth`。

### 修复前（同环境 A/B，只改页面内联样式，不碰仓库文件）

| 视口宽 | 工作日历 | 月导航 | + 新建事项 | 管理 | 登出 | 顶栏 `scrollWidth` / `clientWidth` | 溢出 | 顶栏高度 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1280 | 1 | 1 | 1 | 1 | 1 | 1265 / 1265 | 否 | 55px |
| 700 | 1 | 1 | 1 | 1 | 1 | 685 / 685 | 否 | 55px |
| 520 | 2 | 1 | 5 | 2 | 2 | 505 / 505 | 否 | 139px |
| 420 | 4 | 1 | 5 | 2 | 2 | **449 / 405** | **是** | 139px |

### 按钮可点性

| 视口宽 | 顶栏可见按钮 | 矩形完全在视口内 | 中心点最顶层元素 = 该按钮 |
| --- | --- | --- | --- |
| 1280 | 5（`‹` `›` `+ 新建事项` `管理` `登出`） | 5 / 5 | 5 / 5 |
| 420 | 5 | 5 / 5 | 5 / 5 |
| 420（A/B 的修复前） | 5 | 4 / 5——**`登出` 越出视口右边界** | — |

「中心点命中自身」用 `document.elementFromPoint(中心点)` 判定：返回的就是该按钮，说明没有被遮挡、中心点确实落在可点击区域内。

**行为可点性**：420px 下派发点击「+ 新建事项」，新建对话框正常打开（含标题输入框），关闭后恢复。**标注**：本环境 `locator.click()` 会超时（本轮实测 `#login-form button[type=submit]` 3000ms 超时；上一轮记录过 `tab.cua.click()` 静默失效），故这次点击走 **DOM 派发**、**绕过浏览器指针管线**——它证明应用的委托监听在该宽度下工作正常，不等于「真实鼠标一定点得到」；真实指针可点性的证据是上表那两列。

### 折行结构

520 与 420 时顶栏分成两行：第一行是「工作日历」+ 月导航，第二行是右侧按钮组**整块**。`.topbar-right` 自身高度 35px、内部仍是一行——按钮组是被容器级 `flex-wrap` 整体挪下去的，不是按钮之间分行。这正是「整块折行」与「块内拆行」的区别。

### 回归

`npm test`：88 项全绿（`pass 88 / fail 0`）。本票未改任何产品代码，只动样式之外的东西为零——修复本身（`public/style.css`）+ README 口径 + 文档，符合「改动后跑既有套件、预期不受影响」的判断。

## 复现

```bash
# 起实例（见 docs/agents/local-environment.md §1 的完整命令）
powershell.exe -NoProfile -Command '$env:RILI_DB="./data/verify-02.db"; $env:RILI_ADMIN_USER="admin"; $env:RILI_ADMIN_PASSWORD="<临时密码，至少 8 位>"; $env:PORT="4500"; $env:HOST="127.0.0.1"; Start-Process -FilePath "node" -ArgumentList "server/index.js" -WorkingDirectory "D:\rili" -WindowStyle Hidden -RedirectStandardOutput "D:\rili\data\verify-02.out.log" -RedirectStandardError "D:\rili\data\verify-02.err.log"'
netstat -ano | grep ':4500 ' | grep LISTENING        # 拿 PID
```

浏览器：IAB 打开 `http://127.0.0.1:4500/` → 登录 `admin` → **刷新一次页面**（原因见下「顺带发现」）→ 对每个宽度 `tab.setViewportSize({ width: W, height: 720 })`，然后在页面里读：文本节点的 `Range.getClientRects().length`、顶栏的 `scrollWidth`/`clientWidth`、每个按钮的 `getBoundingClientRect()` 与 `document.elementFromPoint(中心点)`。

收尾：

```bash
powershell.exe -NoProfile -Command "Stop-Process -Id <pid> -Force"
netstat -ano | grep ':4500 ' | grep LISTENING        # 空 = 真停了
powershell.exe -NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Select-Object Id, StartTime"
```

## 顺带发现（不属本票，**没有修**）

**登录动作完成后不重跑权限，`管理` 按钮不出现。** 走正常的「填表单 → 点登录」路径后，`whoami` 已经显示 `admin（admin）`，但 `#btn-admin` 仍然是 `hidden`——因为 `onLogin`（`public/app.js:192`）只调 `enterApp()`，不再走 `boot()`，`state.capabilities` 停在初始的 `managesAccounts: false`，而 `render()`（`public/app.js:73`）正是按它决定 `管理` 按钮的显隐。**刷新一次页面就正常**（`boot()` 走已登录分支、`capabilities` 由服务端下发）。

本轮实测两次：先在 4500 实例上复现，再用「登出 → 重新登录」在干净流程里复现一次，两次都是 `whoami` 有、`管理` 无。

对本轮的影响与后续：

- **不影响本票结论**。测量是在刷新后的正确状态下做的（`capabilities` 三项全 `true`、`管理` 按钮可见），四个宽度的数字因此包含了「管理」这一块。
- **工单 03（管理面板验证）会正撞上这条**：不刷新就点不到「管理」。已在 03 顶部加了执行前提。修不修、在哪一票修，不在本票范围。
- 上一轮的 c2–c6 之所以没发现，推测是那些验证在页面已经带着登录态、`boot()` 正常跑过的状态下进行的（例如刷新后或新标签页）——登录动作本身的那一段没人盯着顶栏看过。
