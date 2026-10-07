# 01 — 注册/登录失败时显示字段级错误，而不是只说「输入有误」

**What to build:** 登录与申请账号两个表单，在服务端返回字段级错误时把原因显示到对应字段下面；申请表单在提交前就写明密码规则。用户看到的不能再只有一行「输入有误」。

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] 根因先被独立证实（不是读代码猜的）：在 `:memory:` 实例上走 HTTP 接缝真跑一次 `POST /api/register-request`（用户名 `12313`、6 位密码、备注「测试」）→ `400 {"error":{"message":"输入有误","fields":{"password":"密码至少 8 位"}}}`；同一脚本用 8 位密码再跑 → `201 {"ok":true}`；同用户名重复提交 → `409` 且同样带 `fields.username`。→ 服务端一直是对的，字段级原因一直在响应体里。
- [x] 丢弃点被指到行：`public/app.js` 的 `onApply` 只写 `err.message`（`grep -c setFieldErrors public/app.js` = 0，`app.js` 顶部 import 里也没有它）；`public/index.html` 里 `grep -c "data-error-for\|field-error"` = 0，两个表单只有唯一的表单级提示 `<p class="form-msg" data-msg>`——所以即便调用 `setFieldErrors` 也是空转（`util.js` 查不到落点会静默跳过，这正是要防的静默失效）。
- [x] `public/index.html`：登录与申请两个表单各加字段级错误落点，沿用既有约定 `<p class="field-error" data-error-for="<字段名>"></p>`（与 `itemform` 同形）；字段名与服务端真正会用的三个键严格一致：`username` / `password` / `note`。
- [x] 失败时把 `err.fields` 交给 `public/util.js` 里已有的 `setFieldErrors`（不另写一份渲染）；写不进的字段错误折回表单级消息，没有静默丢弃的分支。
- [x] 登录表单与申请表单**都**修（同一路径），不是只修一个。
- [x] 申请表单在提交前就显示密码规则：密码框加 `minlength="8"` + 一行「密码至少 8 位。」，规则取自 `LIMITS.PASSWORD_MIN`，不写死数字（测试把它与常量钉在同一处）。
- [x] 回归测试：`test/auth-form-errors.test.js`（333 行，14 项）断言「带 fields 的失败 message 与 fields 都不丢」，并用真请求处理器断言 `fields = {password: '密码至少 8 位'}` 会落进 `[data-error-for="password"]`。
- [x] 浏览器层手验（隔离实例 `127.0.0.2:4411`，空库 + 初始 admin，用完即删实例与库）：复刻截图那次填写（`12313` / 6 位 / 测试）后提交，密码框下出现「密码至少 8 位」、表单底部「输入有误」；改成 8 位以上再提交 → 「申请已提交。管理员批准后才能登录。」、表单重置、字段错误清空。
- [x] 换人复核：**没参与修复的人**只读核对「用户现在还会不会只看到『输入有误』」→ `confirmed`，并给出从 `fetch` 失败到 DOM 的每一步 `file:line`（含点名：落点是运行时才写内容的空元素，因此必须核名字是否对得上——名字对不上时错误会静默不显示）。

## 结论

**根因在前端最后一步，不在服务端。** 修法是接线而不是重写：`public/app.js`（12 增删）把 err 交给新抽的失败呈现函数、`public/index.html`（24 增删）加落点与密码规则提示、`public/util.js`（33 增）把字段级错误的写入与「写不进就折回表单级」的规则收在一处。未改 `server/` 下任何文件——服务端行为本来就是对的。

### 证据

```
$ node --input-type=module -e '…createApp({dbPath:":memory:"}) + createRequestHandler…'
A) username=12313 password=123456(6) -> {"status":400,"body":{"error":{"message":"输入有误",
     "fields":{"password":"密码至少 8 位"}}}}
B) username=12313 password=12345678(8) -> {"status":201,"body":{"ok":true}}
C) 同用户名再提交一次(8位) -> {"status":409,"body":{"error":{"message":"该用户名已有一条待批准的申请",
     "fields":{"username":"该用户名已有一条待批准的申请"}}}}
```

浏览器（隔离实例，DOM 读值）：

```
6 位密码提交后：
  fieldErrorSlots: password=密码至少 8 位，username=，note=
  formMessage: 输入有误
8 位密码提交后：
  formMessage: 申请已提交。管理员批准后才能登录。
  fieldErrorSlots: 三项都空（上一次的错误已清）
```

提交：`26f93a7` fix(auth): 注册/登录失败时显示字段级错误，而不是只说「输入有误」
（`public/app.js 12`、`public/index.html 24`、`public/util.js 33`、`test/auth-form-errors.test.js 333`）
