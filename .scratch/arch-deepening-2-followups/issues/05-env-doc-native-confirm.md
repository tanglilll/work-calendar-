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

- [ ] 环境文档新增这一条，含现象、为什么重要、正确做法三段，且标明来源。
- [ ] 不与既有各节重复；不转载 `browser-verification/spec.md` 的点击路径内容，只交叉引用。
- [ ] 纯文档改动，无代码影响（跑一次全量套件确认仍绿即可）。
- [ ] 一笔提交进 `main`。
