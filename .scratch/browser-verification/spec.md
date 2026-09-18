# 浏览器验证（c2–c6）

针对交接文档 §3 遗留的 5 项浏览器交互验证。验证对象是**已完成但未经浏览器验证**的实现，本过程不修改任何产品代码。

## 环境

一次性实例，与开发/在用实例完全隔离：

- 端口 `4200`，`HOST=127.0.0.1`（只绑本机，避免局域网暴露与防火墙弹窗）
- 数据库 `data/verify.db`（空库；启动时按环境变量创建初始 admin；**验完整库删除**）
- 与端口 4100 上正在运行的实例、`data/browser.db` 无关，全程未触碰

```bash
RILI_DB=./data/verify.db RILI_ADMIN_USER=admin \
RILI_ADMIN_PASSWORD='<临时密码>' PORT=4200 HOST=127.0.0.1 node server/index.js
```

空库对 c2–c5 反而更理想：没有任何遗留事项干扰渲染断言。

## 方法

浏览器用 ZCode 内置浏览器（IAB）驱动，**全程不触碰真实桌面鼠标**。这一点重要——交接文档 §4.1 记录的「鼠标操作触发横幅、自动化静默失效」是上一任 harness 的限制，在 IAB 下不成立；但 IAB 有它自己的一套坑（见下）。

### 关键发现：本环境下只有一种点击方式可靠

| 方式 | 结果 |
| --- | --- |
| `locator.click()` 及 `click({ force: true })` | ❌ 超时。页面 `visibilityState=hidden` 时 `requestAnimationFrame` 不触发，Playwright 的元素「stable」检查永不满足；`force` 也在 `pointer probe returned no click point` 处失败 |
| `tab.cua.click({ x, y })` 坐标点击 | ⚠️ 早期可用（登录、新建、翻月都是这样点成功的），但到某个时点后**返回 `ok` 却不再投递事件**——静默失效，极具误导性 |
| `locator.evaluate(el => el.click())` | ✅ **可靠**。走 DOM 派发，应用的委托监听（`#app` 上的 click 委托、`dialog` 上的 `data-act` 委托）照常触发 |

c4–c6 的点击一律用第三种。代价是绕过了浏览器指针管线，因此它**不能**证明「该按钮在真实鼠标下可点」，但足以证明应用自身的交互逻辑正确。凡是用到它的断言，工单里都已标注。

### 其他环境事实

- `locator.inputValue()` **不存在**于 IAB 的 Playwright 子集（调它会抛 `is not a function`）；读输入框的值要用 `getAttribute("value")`。
- IAB 各标签页共享 cookie，所以第二个标签页打开即处于登录态——这正是 c6 双窗口测试的前提。
- 断言一律读 DOM（`domSnapshot` / `evaluate`），不依赖截图，因此后台标签页也能验。
- 本机系统画像 2560×1440 @144DPI；IAB 视口默认 1280×720，可用 `setViewportSize` 调整。

## 工单状态词汇

- `Status: resolved` —— 验证已完成并给出结论（对应本仓库 local-markdown tracker 的 claimed/resolved 生命周期）
- `Status: needs-triage` —— 尚未决策的缺陷，等 triage 判定

## 本次未覆盖 → 已在收尾轮逐条覆盖

本节原列三条「只在服务端验过、浏览器层没复验」的项。它们已在收尾轮（`.scratch/closeout/`）的浏览器验证里逐条走通，记录如下：

| 原「未覆盖」 | 现在的记录 |
| --- | --- |
| 服务端可见性过滤（`user` 收不到他人的事件）在浏览器层没有复验 | `.scratch/closeout/issues/05-sse-visibility-and-invite.md`——在 user 的窗口上包装 `window.EventSource` 记账，**否定面与肯定面都取对照**（与我无关的他人动作 → 零事件；与我有关的他人动作 → 收到推送且窗口自己重画），并附「接受邀请后不刷新即出现」 |
| 事项编辑（改标题/日期/owner）与 `409 VERSION_CONFLICT` 的浏览器表现未验 | `.scratch/closeout/issues/04-version-conflict-ui.md`——两窗口先后保存，后保存者看到冲突提示、先保存者的改动仍在；归档路径同样验过 |
| 管理员面板（批准申请、改角色、删账号、归档查看）未验 | `.scratch/closeout/issues/03-admin-panel-verification.md`——注册申请 → 批准 → 登录、改角色、删账号与转移、归档视图只读，逐条走通（顺带修掉四处界面缺陷）；删账号的转移步骤后来又从 `prompt()` 换成了对话框内列表，见 `.scratch/verification-fixes/issues/03-transfer-dialog-view.md` |

本节的方法学内容（可靠点击方式、共用标签页的风险、实例隔离）保持原样，未随本次更新改动。
