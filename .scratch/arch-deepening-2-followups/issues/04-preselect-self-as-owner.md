# 04 — 新建事项时预勾选自己

**What to build:** `manager` / `admin` 在新建事项对话框里看到 owner 名单，但**一个都没勾**——不勾就吃 400「owner 名单至少要有一个人」。段界冒烟就是这么撞上的。本票让它**预勾选当前账号**：常见情形正是「给自己建一条」，而勾选组对管理员是可见的，取消勾选的成本低于漏勾导致报错的成本。

**Blocked by:** None — can start immediately.

**Status:** resolved

## 形状

- 新建（`item` 为空）时，把当前账号预勾上；**编辑既有事项时保持原样**（勾选状态来自该事项的 owner 名单，不动）。
- 对话框需要知道「当前账号是谁」。`ctx` 现在没有它——由你定怎么传（例如给 `openItemDialog` 的 ctx 加一个 `me`），并**在票里写明为什么这样传**。注意 `app.js` 的调用点要跟着改（该文件现在没有别的 agent 在改）。
- 这是**产品取舍**，不是回归修复：改动前后都是「没有默认勾选」。本票的立场是预勾自己（见 spec 的「与既有决策的关系」）。若维护者否决，回退这一条断言即可，不影响其它。
- 不要新增「默认 owner」这类设置项——它只是一个预勾选。

## 验收标准

- [x] **先写会红的判据**：把「新建时的预勾选」做成纯函数的一部分（例如「给定 value 对象与当前账号，新建时应带上谁」），在 `node:test` 里断言「新建 → 自己预勾上」「编辑 → 不受影响」。先跑一次确认它红。 → 纯函数 `initialOwnerIds({ item, me, canAssign })`；先把实现写成返回 `[]` 的空壳（= 今天的行为），5 条新断言红、16 条旧断言绿，再落地实现转绿（见「先红后绿」）。
- [x] 新建对话框里，当前账号那一格确实是勾上的（浏览器层由主 agent 在下次段界冒烟时确认，票里写明这一点）。 → 断言落在 `openItemDialog` 写进 dialog 的**渲染标记**上（`value="9" checked` 且别人不勾）；**真实浏览器会话的确认留给主 agent 的下一次段界冒烟**——本票不启动服务、不用浏览器。
- [x] 编辑一条 owner 是别人的事项时，预勾选**不生效**（勾选状态仍来自该事项）——有断言。 → 纯函数 + 渲染标记两层各一条：编辑 `owners: [{id:1},{id:2}]` 的事项时当前账号 `9` 既不在返回值里、标记里也没勾上。
- [x] 普通成员（`canAssign` 为假）的表单没有勾选组，本票对这类账号无影响（有断言或明确说明）。 → 两条断言：`initialOwnerIds(… canAssign: false)` 恒 `[]`（预勾选在他们身上没有落点）；渲染出来的标记里**没有一个** `name="owner_ids"` 的控件。
- [x] 既有断言全绿；全量套件全绿；一笔提交进 `main`。 → `npm test` **289 项通过 / 0 失败**（基线 278 + 本票 9 条 + 工单 01 并行新增 2 条）；一笔提交（提交信息 `feat(itemform): 新建事项预勾选当前账号（工单 04）`，见下方「提交」）。

## 结论与证据

**改动三个文件**：`public/itemform.js`（纯函数 + 渲染处取用）、`public/app.js`（调用点传 `me`）、`test/itemform.test.js`（新增 9 条断言）。`server/` 一行未动——预勾选只改表单的初始勾选，服务端校验与 payload 协议都不变。

### 当前账号怎么传进对话框：`ctx.me`，形状照 `openAdminDialog` 的先例

`openItemDialog(dialog, ctx)` 的 ctx 增加一个可选的 `me`（整个 account 对象，`{ id, username, role }`），由 `app.js` 的调用点传 `me: state.account`。理由：

- **同一个概念在同一个 ctx 形状上**：`openAdminDialog` 的 ctx 早已有 `me`（`public/app.js` 里就写着 `me: state.account`），本票只是把 itemform 对齐到既有先例，不发明第二套「当前账号」的传法。
- **不引入新的取值路径**：`state.account` 由 bootstrap 装载器写、`REFRESH_PLAN.self` 全量重拉（`public/app.js` 的状态注释已经声明「别处一律不要直接写 state.x」），对话框自己去找它会绕开这份唯一写入权；也不可能顺手多打一次网络请求（没有 `/api/me` 这样的端点）。
- **可缺省**：`me` 默认 `null`，`initialOwnerIds` 因此返回 `[]`——登录态缺失、名单加载退化成「只有自己」、或测试替身不传 `me` 时，退到本票之前的行为而不是抛错（既有 `test/contracts.test.js` 的 itemform 替身 ctx 没有 `me`，无需改动就继续绿）。

### 纯函数长什么样

```js
export function initialOwnerIds({ item = null, me = null, canAssign = false } = {}) {
  if (!canAssign) return [];
  if (item) return (item.owners ?? []).map((o) => o.id);
  return me ? [me.id] : [];
}
```

它回答的是「勾选组开框时该勾谁」。`openItemDialog` 把它变成 `const checked = new Set(initialOwnerIds({ item, me, canAssign }))`，渲染处从 `isOwner(o.id) ? ' checked' : ''` 改成 `checked.has(o.id) ? ' checked' : ''`；勾选组的值仍由 `FormData.getAll('owner_ids')` 读取，**没有第二份勾选状态的副本**——DOM 勾了谁，payload 就带谁。

理由是这一处正是「产品取舍的落点」：它是唯一决定初始勾选的地方，也是维护者否决时唯一要回退的断言（回退后新建时不预勾，其余行为不变）。

### 编辑路径为什么不受影响

`item` 非空时函数**提前返回该事项的 owner 名单，`me` 完全不参与**——编辑别人的事项不会因为「我在编辑」就多出自己。另有一处容易踩的耦合被刻意保住：`invitable`（普通成员能邀请谁）仍用 `const isOwner = (id) => (item?.owners ?? []).some(...)` 判定，**没有**跟着换成 `checked` 集合——否则普通成员编辑一条事项时，`initialOwnerIds` 因 `canAssign` 为假返回 `[]`，会把已是 owner 的人重新列进邀请名单。

### 先红后绿

1. 先写判据（纯函数 5 条 + 渲染标记 4 条，含 app.js 调用点那条静态断言），把 `initialOwnerIds` 写成 `return []` 的空壳：`node --test test/itemform.test.js` → **21 项中 5 红 16 绿**，红的正是「新建：当前账号被预勾上」「编辑别人的事项：勾选仍来自该事项」（那时连编辑态都没返回名单）「新建：当前账号那一格渲染成已勾选」「app.js 的调用点把当前账号传给了 openItemDialog」。
2. 落地实现 + `app.js` 传 `me`：同一条命令 → **21 项全绿，0 失败**。

（空壳那一步只为取证：它等价于改动前的行为——不做预勾、渲染处按 `item.owners` 勾选。仓库里没有留下这一版。）

### 新增 9 条断言各防什么

| 断言 | 防的是 |
| --- | --- |
| 新建 → `[me.id]` | 段界冒烟撞过的 400「owner 名单至少要有一个人」再次从「没勾任何人」进来 |
| 编辑别人的事项 → 只返回该事项的 id，且不含 `me.id` | 预勾选越界到编辑态，把当前账号悄悄变成共同 owner |
| 编辑自己名下多条 owner → 原样给回全部 id | 预勾选顺手「去重成自己」或只留第一个 |
| `canAssign: false` → 恒 `[]` | 普通成员那条没有勾选组的分支被预勾选影响 |
| `me` 缺省 / 不传 → 不炸也不预勾 | 名单加载退化或测试替身缺 `me` 时抛错（退到改动前的行为） |
| 标记层：新建时有且只有当前账号勾上 | 纯函数对了但渲染没用它（照旧 `isOwner` 分支）——「算对了没接线」 |
| 标记层：编辑别人的事项 → 勾的是该事项的 owner | 渲染层把编辑态的勾选改错 |
| 标记层：普通成员 → 一个 `name="owner_ids"` 控件都没有 | 给这类账号凭空长出勾选组 |
| `app.js` 调用点含 `me: state.account` | 「改了 itemform 却忘了改调用点」——这条票要求的接线（与既有「表单控件与字段表同源」同类，是静态断言） |

浏览器层的最后一格（真实点击后 `checked` 可见）由主 agent 在下一次段界冒烟确认，本票不启动服务。

### 测试结果与提交

- 单跑本票：`node --test test/itemform.test.js` → 21 项通过 / 0 失败（本票新增 9 条）。
- 全量：`npm test` → **289 项通过 / 0 失败**（基线 278 + 本票 9 + 工单 01 并行新增 2）。
- 中途插曲（与本票无关，记录以免误读）：本票落地时工单 01 正在把 `CHANGE_KINDS` 从 `server/sse.js` 迁去 `server/changes.js`，`test/sse.test.js` / `test/viewer-authority.test.js` / `test/change-vocabulary.test.js` 一度 import 失败；排除这三张文件后跑 255 项全绿（0 失败），01 落地后全量 289 全绿。
- 提交：`feat(itemform): 新建事项预勾选当前账号（工单 04）`，只带 `public/itemform.js`、`public/app.js`、`test/itemform.test.js`、本文件。hash 不在同一条提交里自引，留给主 agent 收口时回填。

## 主 agent 核对（2026-09-18）

- **提交范围**：`f528447`，4 个文件全是本票的；工作区干净；全量套件 **289 项全绿**（本票 +9）。
- **纯函数**：`initialOwnerIds({ item, me, canAssign })` —— 新建 → `[me.id]`；编辑 → 该事项的 owner 名单；`canAssign` 为假 → `[]`；`me` 缺失则退到改动前的行为（不预勾，也不炸）。当前账号走 **`ctx.me`**，与 `openAdminDialog` 的既有先例一致，没有发明第二套传法。
- **先红后绿成立**：把实现写成返回空数组的空壳（= 改动前行为）后，`test/itemform.test.js` **5 红 16 绿**，红的正是新建预勾、编辑态、渲染标记与调用点四条判据。
- **一处刻意保住的行为**：`invitable` 仍按该事项的 owner 名单判定——若跟着换成「预勾选集合」，普通成员编辑时会把已在名单里的人重新列进邀请。
- **真界面确认留给下一次段界冒烟**（票面约定）：勾选框在真实点击后确实勾上，本票只做到纯函数 + 渲染标记层。

**浏览器层确认（主 agent，2026-09-18，一次性实例 `localhost:4980` 即刻验完即停）**：以 `admin` 登录后点「新建事项」，对话框里**当前账号那一格是勾上的**（`input[name="owner_ids"][value="1"]` 的 `checked === true`，对话框标题为「新建事项」）。票面那条被推迟的确认已完成，无遗留。
编辑路径「勾选来自该事项、不受 `me` 影响」在浏览器里未单独复验（那个实例只有一个账号，构造不出「别人的事项」），由 `test/itemform.test.js` 的渲染标记断言覆盖（新建 / 编辑 / 普通成员三种形态各一条）。
