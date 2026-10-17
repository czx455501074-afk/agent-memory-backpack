# W11 未归属候选的正常流转（R5）

本文件记录 W11 线的实现、实测与取舍。对应总工程师计划的 §9.5（归属机制在空流程库上普遍失效）、§11.1–11.2（队列实测与三条成因链），以及 W3 的 `docs/implementation/r5-queue.md`。所有数字都来自只读实测，命令写在文内可复现；库路径一律写 `<USER_HOME>/.agent-memory-backpack/knowledge.sqlite`，不记录本机目录。

## 一、卡点定位（复核结论与任务书前提不同）

任务书的前提是"每条候选都因归属无法前进"。逐段核对 `src/store.ts` 与 `src/server.ts` 的候选/提案区域后，**这个前提在当前 HEAD 上已经不成立**，需要如实纠正：

| 环节 | 位置 | 实测行为 |
|---|---|---|
| 提交 | `src/store.ts:1563-1587` | 命名了但找不到的 workflow **不再中止提交**：`workflowResolved = false`，候选照常入库 |
| 收据 | `src/store.ts:1747-1750` | 未归属时回执带 `attribution{resolved:false}` 与 note；这是说明，不是拒绝 |
| 列表 | `src/store.ts:1819-1933` | 无按归属过滤；未归属候选与已归属同列一条 |
| 采纳 | `src/store.ts:2404-2447` | 只在 `payload.workflowId` 存在时才做 `revision_conflict` / `target_mismatch` 校验；未归属不受影响 |
| 归档 | `src/server.ts:522-526` | 与归属无关 |
| 门禁语义 | `test/r4-data-layer.test.ts:201-242` | 已有测试固定"未知 workflowId 的候选必须入队并可被人工看到" |

**所以"未归属候选卡在哪一步"的答案是：不再卡在提交或采纳**。真实库在一个多小时内从 349 涨到 378 条 pending，全部 `resolved:false`、全库 `workflow` 条目 0 条，它们都正常躺在待审队列里等人审——卡的是**队列里看不到"它为什么不归属"**，以及**归属判定被两个读取路径给出两种答案**。

复核中发现的三个真实缺陷（都可用只读数据证实）：

1. **缺判定被读成"已归属"**：`src/store.ts:1856-1859`（改前）`resolved: payload.attribution?.resolved ?? true`。行列缺 `attribution` 时默认 `true`。
2. **两个读取路径互相矛盾**：同一行，`listProposals` 给 `resolved: true`，`getProposal` 给 `resolved: false`（`:2084` 改前 `?? false`）。审核人在列表页和详情页看到两种结论。
3. **队列只把归属当计分项，不解释**：`src/store.ts:1929`（改前）`attributed = attribution?.resolved === true` 只喂给 `proposalPriority`；未归属候选的 `reason` 是"未附证据"，读不出"没归属"这件事，而回执里那句"采纳不依赖归属"在进入审核面之后就消失了。

## 二、修法（最小改动，只加不减）

1. **单一判定源**：新增 `resolveAttribution()`（`src/store.ts:323-370`），三种输入给三种诚实答案——记录里有判定就照实转述（`described: true`）、有 workflowId 无判定就保 claiming 但不认定位、什么都没写就报"没有判定"。`resolved` 只在真定位时才是 `true`，缺失一律 `false`。
2. **列表与详情改用同一个判定**：`attributionFields()`（`src/store.ts:372-386`）只取三字段，供 `listProposals`（`:1920`）与 `getProposal`（`:2138`）共用，两者不再分叉。列表的返回形状**逐字节不变**（仍是 `workflowId/stageId/resolved`），因为已有 `deepEqual` 断言钉住了它。
3. **队列里把归属说清楚**：队列成员与聚合组带上可选的 `attribution.described` 与 `attribution.reason`（`src/store.ts:1981-1997`），`reason` 直说"未归属，采纳不依赖它"；未归属的排序理由也在 `proposalPriority` 里写明（`:382`）。
4. **候选项显式命名自己的形状**：队列成员带 `kind: 'candidate'`，与折叠组的 `kind: 'aggregate'` 成对（`:1965-1975`）。此前候选项没有 `kind`，按该字段分支的消费方会把普通候选读成 `undefined`。

**没有做的事**（硬要求逐条对照）：不伪造 workflow/stage（`:1563-1587` 保持"找不到就如实标注"）；不削弱审核门禁（`reviewDecision` 与 `evidence: self-reported` 未动，采纳仍需审阅人显式确认）；不放宽 scope 与凭据边界（`applicable()`、`scope_denied`、`allowGlobalScope` 全部原样）；未归属候选可列出、可采纳、可归档，且这三件事都不要求先补归属。

## 三、前后可见性（真实库只读）

只读脚本：`verification/r5/replay-attribution-visibility.mjs`（`readOnly: true`，前后比对库文件大小与 sha256 证明未改动；不打印绝对路径）。

```
node verification/r5/replay-attribution-visibility.mjs        # 人读
node verification/r5/replay-attribution-visibility.mjs --json # 机读
```

同一快照（2026-10-17 19:07 采样；19:40 复采样时库已增长到 378 条，比例不变）的实测：

| 指标 | 值 |
|---|---|
| pending 总数 | 349 |
| 已分类 | 349（100%） |
| 其中未归属（`resolved !== true`） | **349** |
| 已归属 | **0** |
| 全库 `workflow` 条目 | **0** |
| 构成 | 人工提交 223 / 自动捕获失败事实 126 |

修复带来的可见性变化，只发生在"记录里没有归属判定"的行上（本库为 0 行，全部行都带判定），所以**排序分数与 band 变化为 0 条**——这一点必须如实说明：本库的 349 条未归属候选在修复前就已经按"未归属"计分，**修复改变的是读数的诚实性与可解释性，不是它们的排名**。

可核对的可见性差异（新测试覆盖，`test/candidate-flow-unattributed.test.ts`）：

| 行为 | 修复前 | 修复后 |
|---|---|---|
| 队列项是否标明自己是候选 | `kind` 缺失（`undefined`） | `kind: 'candidate'`，与折叠组 `aggregate` 区分 |
| 队列项是否说明未归属原因 | 无字段 | `attribution.described` + `reason`（含"采纳不依赖它"） |
| 列表与详情对同一行的判定 | 可能相反（`true` vs `false`） | 同源，逐字段一致 |
| 行内缺判定时的读数 | 被当成已归属 | 如实为未归属，且标明"没有判定" |
| 未归属候选能否被采纳/归档 | 能 | 能（不变，作为回归断言钉住） |

**新测试在修复前确实失败**：用 HEAD 版 `store.ts` 编译出隔离副本（`.local/`，不进仓库）后跑同一份测试，①③④ 三条失败、②通过——②（可采纳）本来就通，正说明"采纳不是卡点"。

## 四、第二阶段：提炼器骨架

代码：`src/refine.ts`（新增）、`src/maintenance.ts` 的 `refineStatus`/`refineThresholdsInUse`、`src/cli.ts` 的 `refine` 命令。**只有干跑路径**：`collect()` 是纯读，没有任何代码从它通向 `submit` 或 `import`；`refineStatus` 明确写着不挂到 worker tick 上。

只读分布脚本：`verification/r5/replay-failure-distribution.mjs`（自报每条负向过滤挡住多少组、多少行、以及逐级削减后的剩余）。

```
node verification/r5/replay-failure-distribution.mjs --json
node dist/src/cli.js refine --data-dir <隔离副本>   # 干跑，不写库
```

### 4.1 参数用本库分布选，不用同行参数

| 参数 | 默认值 | 依据（本库实测） |
|---|---|---|
| `minOccurrences` | **2** | 47 个签名里 **36 个只出现一次**（36 行，占失败事实 25%）。阈值设 2 砍掉这 36 行；设 8 只多砍约 5 组、行数几乎不变（78 → 约 68/144），因为 `edit ReplaceFileW EIO` 29 次、`pwsh exit_code=1` 21 次、`edit file has not been read` 19 次这三条就占了失败事实的 48% |
| `minSpanMs` | 120000 | 前十签名的真实跨度 771s–246384s，120 秒只拦"卡在一分钟内的重试循环"，不裁正常样本 |
| `minConfidence` | 0.75 | 由下面 4.2 的公式标定；**这一条尚未经真实审核结果验证**，因为没有一条提炼候选被审过 |
| `maxProposalsPerRun` | **5** | 保守占位，**按"人能审多少"定，不按队列有多大**。本库实测的审核速度是 4 天 11 条（approved 8 + archived 3），单日到达 204 条；一批 5 条是"一次坐下来能读完并判断质量"的量。这个数字需要审阅人反馈才能定，代码注释里写明了这一点 |
| `negativeFilterCount` | 20 | 只是上限，当前清单 9 条规则，每条都对着本库真实文本形态写 |
| meta 前缀 | `refine.` | 与任务收敛阈值同用 `meta` 表（`Store.taskConvergenceThreshold` 的既有做法） |

### 4.2 置信度公式（改过一次，因为第一版抓错了证据维度）

第一版把"带根因"当证据维度，实测发现每次抓包都写同一句"根因与修复：尚未验证"，**144 行的该维度全是 0**——一个不会变化的维度不是信号，只会把全体分数压到阈值以下。改成三个真实可变维度（`src/refine.ts:246-274`）：重复 0.60、跨度 0.25（十分钟封顶）、样本一致性 0.15。标定点：8 次/10 分钟 = 0.85 过；12 次/1 分钟 = 0.775 过；8 次/2 分钟且样本各不相同 = 0.669 不过。

### 4.3 负向过滤挡掉了什么（如实说明它不够）

按规则逐条统计（19:40 快照：47 组 / 144 行）：

| 规则 | 挡住 | 例子 |
|---|---|---|
| `no_actionable_detail` | 19 组 / 45 行 | `pwsh exit_code=1` 21 次、`old_string and new_string must differ` 4 次 |
| `one_off_narrative` | 3 组 / 3 行 | `rg: <USER_HOME>\AppData\Local\...` 这类本机路径 |
| 其余 7 条 | 0 | 本库没有这些形态（保留为规则，不为凑数而声称命中） |

合计挡住 **45/144 = 失败事实的 31%、全部待审的 12%**。逐级削减（`collect` 的实际顺序）：144 行 → 负向过滤后 99 行 → 同签名 ≥2 次后 78 行 → 跨度 ≥120 秒后 78 行（跨度这一级在本库一条都没再砍，说明它不是主要筛子，与"前十签名跨度 771s–246384s"一致）。

**必须说清的一条否定结论**：失败事实只占待审的 38%（144/378），另外 62% 是人工提交（234 条），任何针对失败事实的过滤都碰不到它们。最忙一天（2026-10-16）到达 204 条 = 失败 76 + 人工 128，按小时分布是全天持续（18 时 22、20 时 28、21 时 24、19 时 24），不是一次性爆发。**所以这套过滤不足以解决"一天 204 条"**，它只把机器噪声那一侧从 144 行压到 78 行；把这个数字当成达标是自欺。真正的产能问题在人工提交侧与"采纳速率 vs 到达速率"，不在本线范围内。

隔离副本上的干跑结果（只读，362 条待审快照）：产出 4 条建议（`old_string was not found` 11 次、`file changed since it was read` 9 次、`file has not been read` 19 次、`ReplaceFileW EIO` 25 次），另有 19 组被负向过滤挡住、23 组未达门槛，逐条给出原因。

## 五、测试与验证

```
npm run build                                  # 干净
node --test dist/test/candidate-flow-unattributed.test.js   # 4/4
node --test dist/test/refine-skeleton.test.js               # 8/8
node --test dist/test/review-prefill.test.js                # 11/11（W10 契约，见第六节）
node --test dist/test/*.test.js test/*.test.mjs             # 全量
```

- 第一阶段新增 `test/candidate-flow-unattributed.test.ts` 4 条（对应任务书的 ①–④）；基线对照：用 HEAD 版 `store.ts` 的隔离副本运行时 ①③④ 失败。
- 第二阶段新增 `test/refine-skeleton.test.ts` 8 条：负向过滤挡住无信息失败、单次签名不产出、达门槛才产出且正文自述未验证、产出上限与被截条数如实报出、meta 覆盖生效且非法值回落、干跑前后 proposals/revision/adoptions 逐项不变、走真实 store 只读、置信度公式标定。
- 未改任何既有断言以"求通过"，除一处：`test/review-prefill.test.ts` 曾断言"候选项不带 kind"，那是把当时的实现形状当契约；改为断言新契约（候选 `kind === 'candidate'`、折叠组 `kind === 'aggregate'`、两者可区分），理由记在第六节。

## 六、投影变更的影响面

`queueProposals` 的候选项新增两个字段（`kind`、`attribution.described/reason`），列表投影（`listProposals`）与 flat 视图形状不变。

| 消费方 | 是否按 `kind` 分支 | 影响 |
|---|---|---|
| `adapters/dsh/client.js:1846` | 是（`proposal.kind === "aggregate"`） | 显式值判断；候选项现在命中候选分支，行为与之前一致且不再依赖 `undefined` |
| `adapters/dsh/client.js:2326` | 是（过滤 `item.kind === "aggregate"`） | 同上，显式值 |
| `adapters/dsh/client.js:388/674/1341` | 否 | 读的是 `classification.kind`（知识类别），与队列项 `kind` 无关 |
| `adapters/dsh/index.mjs:606-610` | 否 | 只透传 `include`，不读 `kind` |
| `src/server.ts:396-439` | 否 | flat 分支按行附加 `prefill`；queue 分支只附加 `prefill`，不重建投影 |
| `test/review-prefill.test.ts:340-347` | 是（`item.kind === 'aggregate'`） | 已按新契约更新断言 |

`adapters/**` 本线未改动（任务书禁止）。唯一需要改的既有断言的完整理由见上。

## 七、未完成项与风险

1. **归属仍未真正建立**：本库 `workflow` 条目为 0，归属只能标"未归属"。§9.5 的第二个方向（从 journal/task 提炼流程骨架）没有做——第一阶段的结论是它不必做，因为未归属候选已能正常流转。
2. **`maxProposalsPerRun` 是占位**：按"人能审"取 5，没有真实审核反馈支持；需要一次人工审阅后回调。`minConfidence` 同理未经结果验证。
3. **提炼器只处理失败事实侧**：占待审 63% 的人工提交不在过滤范围；"一天 204 条"不因本次改动而缓解。
4. **`no_actionable_detail` 的判定启发式**：靠"有没有引号/文件名/错误名"识别"有无可操作细节"。本库实测合理（挡住 21 次 `exit_code=1`），但一条信息量足、却恰好不含这些 token 的失败会被误挡；`suppressed` 里带着规则 id 与原因，可从干跑输出复核。
5. **没有任何自动采纳**：`refine` 只打印建议；建议文本自带"尚未验证"，且 `evidence` 指向成员 id，由人决定是否提交。
6. **未接 HTTP 端点**：`refine` 只作为 CLI 与 `refineStatus()` 暴露。接面板需要改 `adapters/**`，本线禁止。
