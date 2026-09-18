# 实机环境事实

这里记的是**代码和测试照不出来、只在这台机器上成立**的事实：宿主的进程管理、本机网络、`node:sqlite` 的返回值细节。目的很直白——下一个人不用去 `%TEMP%` 或对话记录里考古，也不必把同一个坑再踩一遍。

每条按「症状 / 原因 / 正确做法」写。**实测复现过的给命令；只来自上一轮观察、本次无法安全复现的会标明来源。**

本文档不涉及：领域规则与词表（见 `CONTEXT.md`）、运行方式与业务规则（见 `README.md`）、浏览器怎么驱动才可靠（见 `.scratch/browser-verification/spec.md`，那里是点击路径与环境隔离方法的唯一出处，此处不转载）。

---

## 1. 起服务要用独立进程：宿主后台任务会被清理，而且会连坐

**症状**

- 用宿主的后台任务（`run_in_background`）起的服务，**回合结束或任务被停时就被清理**——服务悄无声息地没了。
- 更糟的是**连坐**：停一个后台任务会连带杀掉同工作区其它正在运行的 node 服务。上一轮停自己的验证实例时，把另一个实例（端口 4100）一起杀了。这一条是 2026-09-17 的实测观察；本次**没有复现**它（要复现就得故意再连坐杀一次，代价是别的实例陪葬），故按已知事实记录。

**原因**

这些进程挂在宿主会话的进程树上，停止/回收整棵树时并不区分「这个服务是我起的」。

**正确做法**

用 `Start-Process` 起独立进程，脱离宿主会话：

```bash
powershell.exe -NoProfile -Command '$env:RILI_DB="./data/verify-01.db"; $env:RILI_ADMIN_USER="admin"; $env:RILI_ADMIN_PASSWORD="<临时密码，至少 8 位>"; $env:PORT="4400"; $env:HOST="127.0.0.1"; Start-Process -FilePath "node" -ArgumentList "server/index.js" -WorkingDirectory "D:\rili" -WindowStyle Hidden -RedirectStandardOutput "D:\rili\data\verify-01.out.log" -RedirectStandardError "D:\rili\data\verify-01.err.log"'
```

要点，每条都踩过：

- 整段 PowerShell 用**单引号**包住。用双引号的话 Git Bash 会先把 `$env:RILI_DB` 吃掉，变成空字符串。
- `-WorkingDirectory` 给**绝对路径**；`RILI_DB` 给相对路径没问题（相对工作目录解析）。
- `HOST=127.0.0.1` 只绑本机，避免局域网暴露与防火墙弹窗；要让同事访问才用默认的 `0.0.0.0`。
- 日志重定向到 `data/`（已被 `.gitignore` 忽略），否则出问题时无迹可查。
- `RILI_ADMIN_USER` / `RILI_ADMIN_PASSWORD` **只在账号表为空时生效**，用来给空库造第一个 `admin`。密码**至少 8 位**（`server/accounts.js` 的 `validatePassword`）：短了不会建账号，而服务**照常起来**，只是启动日志里多一行 `⚠ 无法创建初始 admin：密码至少 8 位`——于是没人能登录，也没人能批准注册申请，看起来却像「起来了但登不上」。README 的「运行」一节同口径。

**收尾：怎么确认它真的停了**

```bash
netstat -ano | grep ':4400 ' | grep LISTENING     # 最后一列是 PID
powershell.exe -NoProfile -Command "Stop-Process -Id <pid> -Force"
netstat -ano | grep ':4400 ' | grep LISTENING     # 空 = 真停了
```

- **必须盯 `LISTENING` 那一行**。刚停完 `grep ':4400 '` 还会输出几行，那是你刚才探测用的**客户端套接字残留的 `TIME_WAIT`**（本地随机端口 → 4400），不是服务还活着。只看端口号会误判。本次实测：停掉 4400 上的实例后，`grep ':4400 '` 仍列出两条 `127.0.0.1:<随机端口> → 127.0.0.1:4400  TIME_WAIT`，而 `LISTENING` 那行已经消失。
- 别在 Git Bash 里用 `taskkill /F /PID <pid>`：MSYS 把斜杠参数当路径改写，报的是 `错误: 无效参数/选项 - 'F:/'`，进程纹丝不动（实测）。统一用 PowerShell 的 `Stop-Process`。
- 停完**复查还有哪些 node 活着**，防的就是上面那条连坐：

  ```bash
  powershell.exe -NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Select-Object Id, StartTime"
  ```

  实测停掉自己的实例后这条为空。若你起的实例已停、这里却还有别的 node——先别急着动手，那是别人的服务。

**实测证据（2026-09-18，工单 01）**：上面这条命令起了端口 4400 的隔离实例（空库 `data/verify-01.db`），`GET /` 返回 200、未登录的 `GET /api/session` 返回 401，stdout 打出「rili 已启动：http://127.0.0.1:4400 / 数据库：./data/verify-01.db / 已创建初始 admin 账号：admin」，stderr 为空；`netstat` 查到 PID 94760，`Stop-Process` 后 `LISTENING` 行消失、node 进程数归零。用完的库与日志已删除。

---

## 2. CDN 可达性会变，依赖 CDN 的交付物必须先渲染一遍

**症状**

依赖 `cdn.jsdelivr.net` 的页面产物**静默退化**：模块加载失败不进 `window.onerror`，页面不报错，只是把本该渲染成图的内容显示成原始文本/代码——看起来像作者写错了。

**原因**

当时那台机器上 `cdn.jsdelivr.net` 不可达（`cdn.tailwindcss.com` 可达）。**但这会随网络环境与时点变化**：2026-09-18 复测，两个都可达（jsdelivr `200`／1.4s，tailwind `302`／1.2s，直连、无代理环境变量）。所以别把任何一次结论当常量。

**正确做法**

- 要交付带 CDN 的 HTML，**先在浏览器里渲染一遍再交付**，不要靠「curl 通了」下结论——curl 通不代表浏览器里的模块解析、CORS、初版渲染都对。
- 测可达性：
  ```bash
  curl -s -o /dev/null -w "%{http_code} %{time_total}\n" --max-time 12 https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs
  ```
- 本项目自身不受影响：前端零第三方依赖、不引任何 CDN（`docs/adr/0001`）。这条只对「顺手做出来的 HTML 交付物」适用。

---

## 3. `node:sqlite` 的行是 null 原型对象，严格断言会失败

**症状**

在 `node:assert/strict` 这一层（`test/` 里用的就是它）对查询结果行做 `assert.deepEqual`，报

```
Expected values to be strictly deep-equal:
+ actual - expected

+ [Object: null prototype] {
- {
    a: 1,
    b: 'x'
  }
```

两边内容逐字看过去**一样**，差别只在 `[Object: null prototype]` 这个不显眼的标记上，极易误判成「代码没改对」。

反过来更坑：用普通 `node:assert` 的**宽松** `deepEqual` 会**通过**——同一份代码换个 import，结论就相反，于是「本机过、CI 挂」或者「加了 strict 就全红」。

**原因**

`node:sqlite` 返回的行不是普通对象：`Object.getPrototypeOf(row) === null`（实测）。严格比较会比原型，宽松比较不比。

**正确做法**

断言前先归一化，实测两种都行：

```js
assert.deepEqual({ ...row }, { a: 1, b: 'x' });          // 展开成普通对象
const members = rows.map(r => `${r.item_id}:${r.account_id}`);
assert.deepEqual(members, ['1:2', '2:3'], '归属要原样回填进名单表');
```

现成先例见 `test/migration.test.js:100`（注释里也写了这件事）。

**一处修正**：提交 `ee383b5` 的 message 把它记成「对普通字面量做 deepEqual 必然失败、失败信息打印出来完全相同」。准确的说法是**严格比较**才失败（`node:assert/strict` 下 `deepEqual` 即 `deepStrictEqual`），且 `console.log` 与报错信息其实都会打出 `[Object: null prototype]` 标记，只是不显眼。历史提交不改写，以本文件为准。

---

## 4. GitHub 要经本机代理转发

**症状**

`git push` / `git ls-remote origin` 报

```
FATAL: Unable to connect to relay host, errno=10061
Connection closed by UNKNOWN port 65535
fatal: Could not read from remote repository.
```

**原因**

本机 `~/.ssh/config` 把 `github.com` 指向 `ssh.github.com:443`，并经 `connect.exe` 转发到本机代理 `127.0.0.1:7897`。代理没跑时，`connect.exe` 连不上转发目标，就是上面那句 `errno=10061`。

直连也不通，所以不能靠去掉代理绕开：本次实测 `github.com` 的 DNS 被污染（解析到 `199.59.149.235`、`2a03:2880:f107:83:face:b00c:0:25de`，都不是 GitHub 的地址），用 `-o ProxyCommand=none` 直连 22 与 443 都是 `Network is unreachable`。

**正确做法**

识别（三条都试过，第一条最直接）：

```bash
netstat -ano | grep ':7897 '    # 空 = 代理没跑
ssh -T git@github.com           # 出现 errno=10061 = 代理没跑；通的话会打印 GitHub 的欢迎语
git ls-remote origin            # 同一症状在 git 侧的样子
```

先把本机代理起来（7897 端口），再推。**代理没跑时只能本地提交**——`git commit` 不碰网络，远端同步留到代理可用之后。

另：本机**没有安装 `gh` CLI**（`which gh` 为空）。所以即使远端可用，GitHub 的 issue / PR 工作流仍然走不了，本地 markdown 依旧是 tracker of record（见 `issue-tracker.md`）。
