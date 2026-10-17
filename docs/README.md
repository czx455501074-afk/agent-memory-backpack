# 文档索引

这个目录里有一百多个文件，按时间堆叠。这份索引不是清单，而是**入口**：想知道某件事，从这里进去。

## 先读哪三份

1. `release-notes-1.0.0.md` —— 这一版做了什么、已知限制是什么。**给使用者看的第一份。**
2. `release-checklist.md` —— 发布前必须跑过什么，每条命令对应哪个理由。
3. `implementation/r5-chief-engineer-plan-2026-10-17.md` —— R5 这一轮的全部判断、取舍与遗留项。**给维护者看的第一份。**

## 目录在讲什么

`implementation/` 是主目录，几乎全部工作文档在这里。`plans/` 是最早的联合规划与签署。`handoffs/` 与 `internal/handoffs/` 是会话之间的交接。`internal/` 是过程材料（评审、立场文件、合同讨论），不是结论。`diagnostics/` 是某次现场诊断的原始产物（含大体积 JSON），只在复现问题时需要。

## 按主题找

**R5 各条线的交付**（每份含问题、改法、证据、未完成项）：`r5-retrieval.md`（检索链路）、`r5-classification.md`（分类器诚实性）、`r5-queue.md`（审核队列可用性）、`r5-session.md`（会话层收敛）、`r5-wiring.md`（面板接线）、`r5-host-archiving.md`（宿主侧归档）、`r5-review-prefill.md`（审核预填）、`r5-candidate-flow.md`（候选流转与自动提炼）。

**召回与预算**：`r5-injection-budget.md`、`r5-recall-budget.md`（字符预算与渐进披露，含真实测量）。

**审计**（都是"读代码 + 只读测量"得出，未改代码）：`r5-injection-trust-audit.md`（注入通道即信任边界）、`r5-archive-audit.md`（归档合并的保守性）、`r5-tool-surface-audit.md`（两个对 agent 可见却必然 403 的工具）、`security-audit-2026-10-17.md`、`structural-audit-2026-10-17.md`。

**效果与证据**：`r5-efficacy-evidence.md`（注入的知识是否真的改变了行为——用真实会话自证）、`r5-usage-report.md`（用量普查）、`r5-stored-classification-staleness.md`（存量判定与当前判定器的分歧）。

**发布阻塞项的设计**：`r5-gate-and-backfill-design.md`（审核门禁与存量回填的形状）。

**合并与验收**：`r5-merge-review.md`（只查删除行的整树合并审查）、`r5-acceptance.md`（验收记录与两次自我更正）、`r5-next-phase-plan.md`（下一阶段优先级）。

**宿主与部署**：`r5-deploy-and-restart.md`、`post-restart-handoff-2026-10-17.md`、`dsh-panel-verify-2026-10-17.md`、`codex-side-verify-2026-10-17.md`、`cold-start-verify-2026-10-17.md`。

**比对同行**：`peer-research-round2-2026-10-17.md`（调研）、`r5-peer-benchmark.md`（哪些采纳、哪些拒绝及理由）。

## 文件命名约定

- `2026-10-DD-…` 前缀的是按日期的现场记录，保留当时结论，**不随之后续修正**；要修正会在新文件里写明"某文件某节已被更正"。
- `r5-…` 是 R5 这一轮的工作文档，规模与结论都在其中。
- `.txt` / `.json` 是命令的原始输出，用于复现，不是给人读的结论。
- 交付类文档里出现的用户目录路径一律写作 `<USER_HOME>`；`node scripts/sanitize-doc-paths.mjs --check` 可以验证，发布清单里会跑。

## 一条读法建议

这些文档里有相当一部分是**自我更正**：某条结论先写错了、后面改对，并写明为什么错。读的时候别只看结论——**那几次更正（`r5-acceptance.md` 第三之二与第三之四节、`r5-injection-trust-audit.md` 第六节的方法教训）比结论更能说明这套系统哪里脆弱**。
