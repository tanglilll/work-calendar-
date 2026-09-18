# 05 — 本轮收口核对

**What to build:** 本轮结束时仓库自洽：三张修正票的证据齐备且回指了出处、与 closeout 收口票的措辞冲突已消除、测试与工作区干净。

**Blocked by:** 01、02、03、04 全部完成。

**Status:** ready-for-agent

- [ ] 01–03 的工单都写了结论与证据，而不只是勾选框。
- [ ] 把 `.scratch/closeout/issues/07-closeout-consistency.md` 里「全仓没有 `claimed` / `needs-triage` 残留」**限定为「closeout 本轮自己的工单」**——不加限定的话，以后跑到它的人会看到本轮开着的票，要么错等、要么错关。**07 本身不因此被关闭。**
- [ ] 全量测试套件全绿；工作区没有未提交的改动，有则逐条说明为什么留着。
- [ ] 01–03 三张修正票都回指了各自的出处工单。
- [ ] 对照 `.scratch/verification-fixes/spec.md` 的「范围之外」逐条确认没有被顺手做掉（尤其是服务端会话机制与「保留草稿、登录后继续」）。
