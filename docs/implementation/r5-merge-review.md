# R5 合并审查清单（总工程师执行）

本文件是**收口时的检查表**，不是计划。每条都有明确的通过判据与"不通过怎么办"。执行顺序从上到下，**不允许跳步**：先让构建干净，再谈行为。

## 一、在途状态（2026-10-17 晚，第二轮）

第一轮的 W1–W8 已全部交付并冻结在 `353ac76`（代码+测试）、`184b9f2`（文档）、`278a8eb`、`c66d2ed`、`67b37ee`、`552a9f9`。当前在途的是第二轮：

| 线 | 范围 | 状态 |
|---|---|---|
| W9 宿主侧归档接线 | `adapters/**` + 其测试 | **已交付**（报告与 diff 均已复核；真实宿主触发未发生） |
| W10 审核预填 | `src/model-review.ts`、`src/server.ts`、`src/ui.ts` + 测试 | **已交付**（含我追加的 queue 视图补丁；`prefill` 全程可选） |
| W11 未归属候选流转 + 提炼骨架 | `src/store.ts`、`src/server.ts`、`src/maintenance.ts` | 进行中 |
| W12 召回预算 + 渐进披露 | `adapters/**` | 进行中 |

**我自己引入的一处风险，必须查**：`src/server.ts` 的**提案区域被 W10 与 W11 同时改**。我给两条线的许可都写了"仅候选/提案区域"，这正是它们交汇的地方。**测试全绿不能证明两边都还在**——某一个函数被覆盖时，覆盖方可能自带测试。所以收口时必须逐条确认两边的入口共存（见 2.4）。

同样地，`adapters/dsh/index.mjs` 上有 W9（`turn-stopping` 区域）与 W12（召回区域）两份未提交改动叠在同一个文件里；W9 已完成、W12 在跑，收口时一并核对。

## 二、检查项（逐条打勾，不通过就停下修）

**2.1 干净构建**

```powershell
npm run build      # 必须是 0 错误；不许用 --noEmitOnError false 绕过
```

不通过时：错误逐个定位到**持有该文件的线**，不在别人的在途文件里打补丁。

**2.2 全量测试**

```powershell
npm test           # 期望 0 失败；跳过项必须带原因打印
```

已知会遇到的"旧期望过时"：`test/retrieval-service.test.js` 的断言缺 W1 新增字段 `source`。处置规则：**只有当新字段是行为的一部分、且旧断言确实描述的是旧行为时**才改断言，并在提交说明里写清"旧期望为何过时"；任何改动都要能指向代码证据。

**2.3 一键验收（真实库副本）**

```powershell
node scripts/r5-acceptance.mjs
```

判据：`检索可达规范: PASS` **且** `回执诚实: PASS`。当前回执一项为 FAIL（W1 在途），这是本轮的**核心验收门**。

**2.4 三线共改 `store.ts` 的语义核对**

同一个文件被 W1（prepare 选择来源）、W3（队列聚合）、W4（任务收敛）三条线改过，必须逐段核对**互不覆盖**：

| 区域 | 归属 | 核对点 |
|---|---|---|
| `prepare()` 的 `selectedIds`/`selectionSource` 分支 | W1 | 传入选择时 `why.matched` 是否真实；未被清空成空数组 |
| `workflow_search` 写入与回填 | 早前未提交改动 + W1 | norm 在索引里，且注入端不重复 |
| `queueProposals` 与优先级/签名模块级函数 | W3 | 只读派生；`flat` 视图逐字节不变 |
| 任务收敛与 `task` 作用域归档 | W4 | 不自动标 completed；收敛幂等 |
| `serious` 判定（`important`） | 未修 | **仍会把 `ReplaceFileW` 读成 `replace`** → 待处置 |

**2.5 未修但已定性的两处（要么修，要么写清为什么不修）**

1. `important` 误判：使 `expireProposals` 形同虚设（真实库"已过期未处理"= 0）。只做聚合等于闸门未修。
2. 失败事实去重键含 `sessionId`：同一错误在新会话必然新增一行。修法与聚合互补，但先确认不会破坏"出现次数"语义。

**2.6 接线（用户可见性的最后一公里）**

- 面板：`adapters/dsh/index.mjs` 的 proposals-list 透传 `view`/`include`；`adapters/dsh/client.js` 渲染 `groups['failure-facts']` 折叠区。**不接线，用户只看到"条目变少"**。
- 采纳侧：`entryFromClassification` 读 W2 新增的 `autoPromotable`/`promotionBlockedReason`，`norm` 不再无条件一键采纳。
- 注入：`prepare` 请求带已知版本（W6-1）。

**2.7 文档合规**

```powershell
node --test dist/test/clean-install.test.js    # 3/3
```

新文档不得含用户目录绝对路径（用 `<USER_HOME>`）。

## 三、全绿之后（才允许）

1. `npm run pack:local` → `npm run deploy:plugin`；
2. **由人重启 DSH 与 Codex**（agent 不自我重启）；
3. 按 [`r5-deploy-and-restart.md`](r5-deploy-and-restart.md) 跑 60 秒验收清单并留原始输出；
4. 把结果写入 `r5-acceptance.md`，其中**必须包含未做到的部分**。

## 四、这一轮容易被糊过去的四点

1. **用 `--noEmitOnError false` 产出的 dist 不算通过**：那是"能跑测试"，不是"能发布"。
2. **数字一致 ≠ 结论一致**：W2/W3 的数字我已独立复核（316→205、232→13），但**接线前用户看不到任何变化**。
3. **测试通过 ≠ 体验改善**：队列聚合、分类修正都只在 API 层验证过，没有一次真实宿主点击。
4. **不要把"未接线"写成"已完成"**：本轮至少有两个交付物停在"代码在、用户看不到"的状态，收口文档里必须点名。
