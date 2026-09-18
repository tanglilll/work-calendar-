# 01 — 环境事实落盘，修正过期表述

**What to build:** 把只存在于仓库外的实机环境事实落进仓库，让下一个接手的人不必从临时文件或对话记录里考古；并修正 tracker 文档里与现实不符的一句表述。本票是其余各票的前置——后面的验证工单都要按这里记录的启动方式起实例，才不会中途被宿主清理掉。

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] 新增一份环境文档，与既有的领域文档、issue tracker、triage 标签三份并列。四条事实各写清「症状 / 原因 / 正确做法」： → `docs/agents/local-environment.md`
  - [x] 用宿主后台任务跑服务，会在回合结束或任务被停时被清理；更糟的是停一个后台任务会**连带杀掉同工作区其它正在运行的 node 服务**。正确做法：以独立进程启动，并给出一条可直接复制的启动命令，附「停服务前先按端口查 PID、停完复查其它端口」的收尾步骤。
  - [x] 依赖 `cdn.jsdelivr.net` 的页面产物会**静默退化**——模块加载失败不进 `window.onerror`，页面只是把该渲染的东西显示成原始文本，看起来像作者写错了。需要 CDN 的交付物必须先渲染一遍再交付。
    - 本次实测 jsdelivr **可达**（交接文档写的是不可达，见「对交接文档的两处修正」），文档按「可达性会变，别当常量」改写。
  - [x] `node:sqlite` 返回的行对象是 null 原型：对普通字面量做深比较**必然失败**，而且失败信息里两侧打印一模一样，极易误判成「代码没改对」。断言前先归一化再比。
    - 修正了断言名：失败的是**严格**比较（`node:assert/strict`，`test/` 用的就是它）；宽松的 `deepEqual` 反而通过。
  - [x] 远端仓库（GitHub）需经本机代理转发才连得上；代理未运行时只能本地提交，并给出识别该症状的命令。
- [x] 文档里给出的实例启动方式**实测起得来一个实例**（证据见下），并写明用完如何确认它真的停了（含「别被 `TIME_WAIT` 骗到」「别用 `taskkill`」两条）。
- [x] 浏览器层的点击路径发现**不在本文档重复转载**，改为指向既有的验证方法论文档。
- [x] tracker 文档不再声称本仓库没有远端；若其中提到命令行工具缺失，表述与现状一致。
- [x] 本文档不新增领域术语、不改变任何领域规则，词表不需要跟着改。

## 结论

**通过。** 四条事实落进新建的 `docs/agents/local-environment.md`，每条都写成「症状 / 原因 / 正确做法」并附可复算的命令；启动方式实测起得来、也测得停。`docs/agents/issue-tracker.md` 首段那句「本仓库没有 git remote」已改；`AGENTS.md` 加了一行索引，否则新文档没人指得着。

落盘过程中发现交接文档有**两处不准确**（CDN 现状、`node:sqlite` 的断言名），文档按本次实测改写，并在文末留了修正说明——照抄会让下一个人的第一次尝试就失败。

## 证据

全部在 2026-09-18 本机执行。**本轮的实例隔离口径**：独立进程、空库、独立端口、只绑本机，验完整库删除；端口 4100/4200/4300 全程空闲（起前与停后各查一次），未触碰 `data/` 下任何既有实例的库。

### 1. 独立进程启动方式 —— 实测（本票起了一个隔离实例）

| 观察点 | 值 |
| --- | --- |
| 启动方式 | `Start-Process -WorkingDirectory "D:\rili" -WindowStyle Hidden`（`local-environment.md` §1 那条命令） |
| 端口 / 绑定 | `127.0.0.1:4400`，`netstat` 看到 `LISTENING 94760` |
| 库 | `data/verify-01.db`（空库 → 按环境变量创建初始 `admin`） |
| stdout | 「rili 已启动：http://127.0.0.1:4400」「数据库：./data/verify-01.db」「已创建初始 admin 账号：admin」 |
| stderr | 空 |
| `GET /` | `200` |
| `GET /api/session`（未登录） | `401` |
| 停止 | 按端口取 PID → `Stop-Process -Id 94760 -Force` |
| 停止后复查 | `grep ':4400 ' \| grep LISTENING` 为空；`Get-Process node` 计数 `0`；端口 4100/4200/4300 仍空闲（无连坐） |

### 2. CDN 可达性 —— 实测两次，结论相反

```
curl https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs  →  http=200 time=1.42
curl https://cdn.tailwindcss.com                                       →  http=302 time=1.16
```

两者都可达（直连，`env` 里无任何 `proxy` 变量）。交接文档记的是「jsdelivr 不可达、tailwind 可达」——所以**这不是一条常量而是当时的观测**，文档据此改成「可达性随环境与时点变，需要 CDN 的交付物必须先在浏览器里渲染一遍」。

### 3. `node:sqlite` 的行对象 —— 复现了，但断言名与交接文档不同

```
Object.getPrototypeOf(row)                      →  null
node:assert 的宽松 assert.deepEqual(row, {...})  →  通过
node:assert/strict 的 assert.deepEqual(row,{...})→  失败：Expected values to be strictly deep-equal
                                                    + [Object: null prototype] { … }  - { … }
{ ...row } 展开成普通对象后再严格比较             →  通过
rows.map(r => `${r.a}:${r.b}`) 字符串归一化后比较  →  通过
```

失败机制成立（null 原型 + 严格比较比原型），但「`deepEqual` 必然失败」只在**严格那一层**成立，且报错信息其实带 `[Object: null prototype]` 标记、`console.log` 也会打出来——不是「两侧一模一样」。仓库里 `test/migration.test.js` 正是 `import assert from 'node:assert/strict'`，所以那条注释在**该文件内**是对的。

### 4. GitHub 需经本机代理 —— 症状与识别命令实测

```
netstat -ano | grep ':7897 '   →  空（本机代理没跑）
ssh -T git@github.com          →  FATAL: Unable to connect to relay host, errno=10061
git ls-remote origin           →  同上，后接 fatal: Could not read from remote repository.
github.com 的 DNS              →  解析到 199.59.149.235 / 2a03:2880:f107:83:face:b00c:0:25de（均非 GitHub 地址）
-o ProxyCommand=none 直连 22/443 →  Network is unreachable
```

即：代理没跑时连不上，而**去掉代理直连也不通**（DNS 污染 + 端口不可达），所以 `git push` 只能等代理起来。本次改动因此只做到本地提交。

### 5. `taskkill` 在 Git Bash 里不能用 —— 实测

```
taskkill /F /PID <pid>  →  错误: 无效参数/选项 - 'F:/'（进程未受影响）
```

MSYS 把 `/F` 当路径改写。故文档统一写 `Stop-Process`。

### 6. 文档形态

`docs/agents/local-environment.md` 与既有三份并列；未新增任何领域术语，`CONTEXT.md` 未改；浏览器点击路径只有一句指向 `.scratch/browser-verification/spec.md`，未转载其表格。

## 复现

```bash
# 起实例（见 local-environment.md §1 的完整命令）
powershell.exe -NoProfile -Command '… Start-Process -FilePath "node" …'
netstat -ano | grep ':4400 ' | grep LISTENING        # 拿 PID
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4400/          # 期望 200
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4400/api/session  # 期望 401
powershell.exe -NoProfile -Command "Stop-Process -Id <pid> -Force"
netstat -ano | grep ':4400 ' | grep LISTENING        # 期望为空
```

## 对交接文档的两处修正

| 交接文档的说法 | 实测 | 文档里的落法 |
| --- | --- | --- |
| `cdn.jsdelivr.net` 不可达 | 2026-09-18 可达（200／1.4s），tailwind 也通 | 写成「会变，别当常量」，并给测可达性的命令 |
| 对行对象做 `deepEqual` 必然失败、失败信息两侧一模一样 | 只有**严格**比较才失败，且报错与 `console.log` 都会打出 `[Object: null prototype]` | 写明两种 assert 的差别为「同一份代码换个 import 结论相反」，并给归一化写法 |

历史提交 `ee383b5` 的 message 含第二种不准确表述，**不改写历史**，在 `local-environment.md` §3 文末记了修正说明。

## 未做的事

- **没有复现「停后台任务会连坐杀掉其它服务」**：要复现就得先起两个服务再故意连坐一次，代价是别的实例陪葬。按已知事实记录并在文档里标注来源（2026-09-17 的观察）。
- **没有动 `CONTEXT.md`**：本票明确不改词表；产品名对齐（`CONTEXT.md` 首行 + README 首行）是 closeout 的另一张票。

## Comments

**2026-09-18 · `/code-review` 两轴复核后收紧三处。**

两轴的结论：Spec 轴判定验收清单逐条落地、对交接文档的两处修正经**独立复现**为真（宽松 `deepEqual` 通过、`node:assert/strict` 失败且报错带 `[Object: null prototype]` 标记）、`AGENTS.md` 加索引与 tracker 入库两件自行动作**不算越界**（另三份 docs/agents 文档在 `AGENTS.md` 都有条目；上一轮的 `.scratch/browser-verification/` 也已在库里）；Standards 轴核对引用路径（`test/migration.test.js:100` 的注释属实）、`npm test` 88 绿、`master` 是 `main` 严格祖先、前端无 CDN 引用等均属实。据此改了三处：

1. 启动命令里的密码标注**「至少 8 位」**，并写明短了的后果：不建账号、服务**照常起来**、日志里只多一行「⚠ 无法创建初始 admin：密码至少 8 位」（`server/accounts.js:240` 的 `bad-password` 分支）。这正是「起来了但登不上」那种最难查的形态，而这条命令的用途就是给空库造账号。
2. 收尾步骤补上**可复制的复查命令**（`Get-Process node`）——原文只有「顺手看一眼其它端口」这句话、没有命令；TIME_WAIT 那条同时补标「本次实测」，否则读者分不清它是本轮的新观察还是上一轮的旧记录（本文档承诺过标明来源）。
3. `issue-tracker.md` 的「with `main` pushed to it」改成「tracking `main`」：本轮两笔提交还没推（代理没跑），本地领先远端，原措辞此刻不精确。

**评审指出、但本票未改的两条**（都在 `.scratch/closeout/spec.md` 正文里，不属本票范围）：

- spec 自身有张力：第 57 行称「本轮不新增术语，`CONTEXT.md` 无需改动」，第 67 行又要求「`CONTEXT.md` 的首行」随产品名对齐——后者正是工单 06 要做的。两处并存会让执行 06 的人先愣一下，建议在 06 或 07 收口时把第 57 行的限定词收紧成「不新增术语」。
- 同一份 spec 的 User Stories 用「管理员」指代 admin 专属动作（批准申请、改角色、删账号、归档视图），而 `CONTEXT.md`「管理员」条要求特指最高权限时一律写 `admin`。属既有文本，未改。
