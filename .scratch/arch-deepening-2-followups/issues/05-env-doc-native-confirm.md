# 05 — 环境文档补「原生 `confirm` 可用」

**What to build:** 环境文档是实机环境事实的唯一出处，而「内置浏览器里原生 `confirm` **可用**、`prompt()` 被禁用」这条事实目前只写在 arch-deepening-2 的两张工单里。下一轮做浏览器验证的人若不知道，会重复上一轮的做法：为了越过二次确认而给页面装 `window.confirm` 替身——那等于**篡改页面行为**（上一轮为此付过代价：用户的点击被静默吞掉）。知道这条就不必装替身。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

## 形状

- 在 `docs/agents/local-environment.md` 里补一条，位置与详略跟既有几节一致（它承诺过「标明来源」）。
- 内容要点：**症状/现象**——`prompt()` 在 IAB 里被禁用（实测点击后只弹一条 `prompt() is not supported.` 的错误提示），而原生 `confirm` **可用**（可用浏览器自带的对话框接口读到 `type: confirm` 并接受，不必装页面级替身）；**为什么重要**——装 `window.confirm` 替身会改变页面行为，让「用户观察到什么」不可信；**正确做法**——用浏览器自带的对话框接口处理二次确认，需要探针的测试新开标签页、测完关掉。
- 交叉引用 `.scratch/browser-verification/spec.md`（那里是浏览器层方法学的出处），**不要重复转载它的点击路径对照表**。
- 来源标注：arch-deepening-2 的段界冒烟实测（工单 05 的删除路径用它走通；更早的 `prompt()` 禁用是 verification-fixes 工单 03 在内置浏览器里实测的）。

## 验收标准

- [x] 环境文档新增这一条，含现象、为什么重要、正确做法三段，且标明来源。
- [x] 不与既有各节重复；不转载 `browser-verification/spec.md` 的点击路径内容，只交叉引用。
- [x] 纯文档改动，无代码影响（跑一次全量套件确认仍绿即可）。
- [x] 一笔提交进 `main`。

## 结论

`docs/agents/local-environment.md` 新增 **§6「IAB 里原生 `confirm` 可用、`prompt()` 被禁用：二次确认不要装页面级替身」**，按文档既有的「症状 / 为什么重要 / 正确做法 + 来源」体例写，占 29 行；首段的环境事实枚举同步补了「内置浏览器支持哪些原生对话框」一处。除该文件与本工单外无任何改动。

各段写了什么：

- **症状（现象）**：`prompt()` 在 IAB 被禁用（点「转移事项」只弹红色提示 `prompt() is not supported.`，流程走不下去）；原生 `confirm` 可用（浏览器自带对话框接口读到 `type: confirm` 并 `accept()`，删除 / 归档 / 删账号路径已走通），并点明「不必装页面级替身」。
- **为什么重要**：装 `window.confirm` 替身即篡改页面行为——确认框不弹、返回值由替身定，上一轮的记录原话是「它确实改变了行为：替用户点了确认」，替身失效时点击被静默吞掉；且 `confirm` 是 `window` 自己的属性，`delete window.confirm` 恢复不了原生实现；换来的必要能力为零。
- **正确做法**：二次确认用 `getJsDialog()` → `accept()` / `dismiss()`，不碰 `window.confirm`；如实附上代价「接口读不到 message，确认框视觉与文案不在观测范围内」；需要页内探针时新开标签页、验完 `close()`；驱动细节只指向 `.scratch/browser-verification/spec.md`，**未转载**其点击路径对照表。
- **来源**：分三条列出——`prompt()` 禁用（verification-fixes 工单 03 的 IAB 实测）、原生 `confirm` 可用（verification-fixes 工单 02 的「本轮新确认的环境事实」与工单 03 的「路径 0」；arch-deepening-2 段界冒烟里工单 05 的删除路径亦然）、替身代价（closeout 工单 04 与 browser-verification 的 c4）。`delete window.confirm` 恢复不了原生实现标注为「上一轮现场教训，本轮未复现」。

与既有各节的区分：§1 是进程与实例生命周期、§5 是 cookie 按主机名分桶，本条只记 IAB **支持哪些原生对话框接口**；对 §5 只有一句指针（新标签页共享 cookie 桶），未展开其机制。与 `browser-verification/spec.md` 的分工在正文里写明——「怎么驱动才可靠」以那里为唯一出处，本条只记能力事实。

## 证据

- **改动**：`git diff --stat -- docs/agents/local-environment.md` → 29 增 / 0 删（含首段枚举的一处小改与新增 §6）。
- **测试**：`npm test` 第一次跑在并发波次中撞上别人未落地的重构（`test/sse.test.js`、`test/viewer-authority.test.js` 从 `server/sse.js` import 已迁走的 `adminsChanged`，`test/change-vocabulary.test.js` 同批在改）——255 pass / 3 file-level fail，与本文档无关；按硬规则隔 20 秒重跑 → **289 项通过、0 失败**（基线 278 + 同波次其它线的新增断言）。
- **零代码影响**：本工单只碰了上面列出的两个 markdown 文件；`git status` 里其余的 `server/*`、`public/*`、`test/*` 改动都是并行 agent 的，提交时用 pathspec 只带自己的两个文件。
- **提交**：一笔 `docs:` 提交进 `main`，paths 只含本工单两个文件（`docs/agents/local-environment.md` 与本票）。
