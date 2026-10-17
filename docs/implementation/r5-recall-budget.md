# R5 / W12：召回段落的字符预算与渐进披露

目标：把"每轮往上下文里灌多少"变成受控、可解释。规范全文的重复注入已由 W6-1 修好（同版本只回
53 字符指针）；本轮处理**召回段落没有预算**这条。改动只落在 `adapters/**` 与新增测试/文档，
`src/**` 未改。

## 一、现状拆解：一轮注入由哪几部分组成

用真实核心实测（只读）：

```
node verification/r5/recall-budget-measure.mjs
node scripts/r5-usage-report.mjs
```

| 组成 | 字符数（实测） | 来源与口径 |
| --- | --- | --- |
| 规范上下文·同版本 | **53** | `POST /v1/prepare` 带 `knowledgeRevision`，core rev 1971 |
| 规范上下文·变版首轮 | **1376** | 同端点不带 `knowledgeRevision`；其中 4 条规范原文约 594 字符，其余是版本行与"宿主已自行加载"登记行 |
| 召回段落 | **290 / 325 / 570 / 1025 / 1238** | 同一核心、同一 rev 1971 下对 5 条真实查询实测（本文件第六节的表） |
| 召回段落（大命中） | **936 / 1250 / 1275** | 预算生效后的实测，见第六节 |
| 任务交接 | 未分段记录 | 只在任务被接手的那一轮注入；本轮新增的分段日志见第四节 |

结论：同一版本下，"固定开销"= 53 字符指针 + 召回段落。**召回段落是唯一没有上限的那一半**：
W6-1 之后指针稳定在 53，而召回段落实测从 290 一直到 5923 字符。

含义要说清楚：W6-1 修的是"规范正文重复发送"，不是"召回段落"。`adapters/dsh/index.mjs:1605` 的召回键是
`taskId:最新用户消息:知识版本`，每条新用户消息都会重新召回一次并整段拼进上下文，这正是第二节要压的部分。

## 二、真实分布与窗口可比性

本项目规范（`norm:log-window-comparability@1`）要求先证明两窗口可比再比数字。做法：只统计同一事件
类型 `context.injected`，不跨事件类型比总数。

```
node scripts/r5-usage-report.mjs      # <USER_HOME>\.agent-memory-backpack\amb-plugin.log.jsonl
```

- 该脚本口径的窗口 `2026-10-16T19:54:16Z → 2026-10-17T11:20:39Z`：**n=116，中位 1460，p90 4429，
  最大 8312，合计 234786**。
- 本机同日窗口（`+08:00` 2026-10-17，仅 `adapter=dsh`）：**n=156，中位 1327，p90 4248，最大 8312，
  合计 317395**；其中本会话 `session-f0e04686` **n=37，中位 1640，最大 7669，合计 88719**。
- 日志**不记录**每轮走的是模型路径还是本地索引路径，因此路径判断不能用日志推断；本文件的路径字段
  一律来自直连核心的响应（`selection.mode` / `selection.reason`）。

### 最大值 8312 那一条是什么

`2026-10-17T04:48:31Z`、会话 `session-80308cbf…`、`rev 1835`、`chars 8312`。同一毫秒的
`knowledge.auto_recall` 是 **`matched:0, selectionMode:lexical_fallback, selectionReason:model_abstained:no_selection,
readIds: 空`** —— 也就是说**那一轮召回段落是 0 字符**。它由 `prepare` 一侧构成（该轮 `knowledgeIds`
列出 `memory:bf3a73b52978f737`，该条目正文实测 **50495 字符**），不属于本轮可改的 `adapters/**` 范围。

这条直接推翻了"最大注入由技能正文节选造成"的假设：**最大的一条注入里没有召回段落**。它落在
`prepare` 路径（`src/**`，本线禁改），见第七节未完成项。

## 三、改动文件与行号

| 文件 | 位置 | 改动 |
| --- | --- | --- |
| `adapters/dsh/recall.mjs` | 8–24 | 新增 `RECALL_BUDGET_DEFAULTS`（1600/240/800/2800/auto）与依据注释 |
| | 32–55 | 新增 `resolveRecallBudget`：config > 环境变量 > 默认值 |
| | 61–96 | 新增 `documentForms`：每条文档三种形态（full / summary / index），summary 与 index 只取首段 |
| | 98–104 | 新增 `formOrder`：披露级别的形态顺序 |
| | 118–121 | 预算对象、header 与 `used` 记账 |
| | 139–181 | 逐条按相关度选择形态；`norm:` 条目不受预算约束；最相关一条至少给索引 |
| | 183–200 | 省略说明行：条数、字符数、id、取回方式 |
| | 202–210 | 日志新增 `chars / budgetChars / disclosure / omittedIds / omittedChars`；失败日志带 `reason`（只写错误名） |
| `adapters/codex/scripts/recall.mjs` | 全文 | 与 dsh 副本**字节一致**（既有测试断言两份相同） |
| `adapters/codex/scripts/hook.mjs` | 611–620 | 新增 `context.injected.parts` 日志：`handoffChars / preparedChars / recallChars / chars` |
| `test/recall-budget.test.mjs` | 新增 | 6 条测试（逐字节一致、省略说明、规范不省略、索引级、预算可配置、两副本一致） |
| `verification/r5/recall-budget-measure.mjs` | 新增 | 只读测量与前后对比脚本 |
| `docs/implementation/r5-recall-budget.md` | 新增 | 本文件 |

未触碰：`adapters/dsh/index.mjs:1232-1283`（另一条线的 `turn-stopping` 归档接线）与 `src/**`。

## 四、预算与省略规则

**默认值 1600 字符**（`AMB_RECALL_BUDGET_CHARS` 或 `config.recallBudgetChars` 可覆盖），另外每形态
上限：索引 240、摘要 800、原文节选 2800（`AMB_RECALL_EXCERPT_CHARS`）。

它在分布中的位置：中位 1460 的 **1.10 倍**，中位与 p90 之间（约 p55–p60）。也就是说，1600 大致覆盖
"多数轮次的整轮注入量"，而它只约束召回段落——扣除 53 字符指针后，大多数轮次的召回段落本来就在
1600 以内。上限效果：同版本轮 ≤ 53+1600 = **1653**，变版轮 ≤ 1376+1600 = **2976**，两者都低于旧的
p90 4429。

超出预算时的处理（不静默）：

1. 逐条按相关度（搜索结果顺序）选择形态：full → summary → index；放不下的条目完全省略。
2. 注入文本末尾追加一行省略说明，写明：预算值、省略的篇数、省略的总字符数、每条被省略的知识 id
   与字符数、以及取回方式（`amb_read_knowledge(knowledgeId)` / `amb_read_knowledge(knowledgeId,
   includeLeaves:true)`）。
3. 最相关的一条**至少给索引形态**（即使预算放不下），否则模型连"有东西被召回"都不知道。
4. `context.injected` 之外的 `knowledge.auto_recall` 日志同时记录 `budgetChars / disclosure /
   omittedIds / omittedChars`，回执可核。

**绝不省略**（预算只作用于召回段落）：`prepare` 送出的规范上下文（4 条规范原文、禁止类条目）、任务交接
块、召回结果中 `id` 以 `norm:` 开头的条目（代码强制 full，即使超出预算）、工具放行/拒绝判定（在 gate
侧，与预算无关）。README 第 311 行"预算只约束注入正文、禁止类规范一律完整保留"由测试
`the budget never shortens a normative entry` 固定。

## 五、渐进披露与升级规则

形态只有三种，信息量递减但都保留 id 与取回指令：

| 形态 | 内容 | 上限 |
| --- | --- | --- |
| full | 标题 + id@rev + 该条正文节选（多段拼接后截断） | 2800 |
| summary | 标题 + id@rev + **首段**正文 + "另有 N 段未注入" | 正文 800 |
| index | 标题 + id@rev + 一句话摘要 + "正文 N 字符未注入；用 amb_read_knowledge 读取全文" | 240 |

默认级别 `auto`（`AMB_RECALL_LEVEL` / `config.recallLevel` 可取 `auto|index|summary|full`）：

- `auto`：整段放得下 → 全部 full（与改动前逐字节一致）；放不下 → 逐条降级，超预算的省略并说明。
- `index`：一律只给索引行（最省，约 3 行/轮）。
- `summary` / `full`：显式要求该级别。

升级与降级是同一件事的两个方向：命中条目**没有**被"升级"到全文的自动路径，除了两点——`norm:` 条目强制
full；`auto` 下预算有余量时按 full→summary→index 顺序尽量给更高形态。也就是说，"默认只给索引"目前不是
未超预算时的行为：那会与"未超预算逐字节一致"直接冲突，见第七节第 1 条。

同行结论只用作选值参考，**本项目未复测**：三层披露把每轮召回从约 500–1000 tokens 压到 50–100；"每个
文档只贡献一个片段"曾把命中率从 0.5104 提到 0.8676。本实现对后半条做了等价处理（summary/index 只取首段
并说明"另有 N 段未注入"），但命中率是否变化没有测。

## 六、前后对比（同一查询、同一知识版本 rev 1971）

```
node verification/r5/recall-budget-measure.mjs
node verification/r5/recall-budget-measure.mjs --ids skill:a59e6650436ef8e0,skill:219bfd9c73fff7fd
```

同一查询下，旧渲染（`legacyPassage`，预算前的 2800/块、总 6000）与新渲染（预算 1600）：

| 查询/条目组 | 候选正文合计 | 旧 | 新 | 变化 |
| --- | --- | --- | --- | --- |
| W12 召回预算… | 166 | 290 | 290 | 0（未超预算，逐字节一致） |
| missing binary look up… | 1670 | 1238 | 1238 | 0（同上） |
| codex-router install.ps1… | 188 | 325 | 325 | 0（同上） |
| AMB 面板候选折叠… | 423 | 570 | 570 | 0（同上） |
| 调试渲染 run-to-node… | 6540 | 2596 | **1025** | −60.5% |
| `skill:a59e6650436ef8e0` + `skill:219bfd9c73fff7fd` | 11379 | 5923 | **1275** | −78.5% |
| `skill:972cc02b6aa4097e` + `material-auto-ec2264…` | 18037 | 5123 | **1250** | −75.6% |
| `memory:bf3a73b52978f737`（8312 那条的条目） | 50495 | 2926 | **936** | −68.0% |

长会话累计（口径：本会话 `session-f0e04686` 37 轮，旧合计 88719 字符）：

- 新规则上限口径：37 × (53+1600) = 61161 字符上限，比旧合计低 31%。这是**上界**，不是重放值——
  历史轮的 query 没有记录，无法逐轮重放，只有"上限"与"同一查询实测"两种口径可用。
- 单轮上限对照：中位 1460 → 同版本轮 ≤1653；p90 4429 → 变版轮 ≤2976。

## 七、未完成项与风险

1. **"默认只给索引级"没有设为默认。** 任务书第 7 条要求默认索引级，第 6③ 条要求未超预算时逐字节
   一致，两者互斥（索引级必然改写未超预算的注入）。当前默认 `auto` 保证逐字节一致，严格索引需要显式
   `AMB_RECALL_LEVEL=index`。要改成"索引优先做默认"，必须同时改旧期望与 README 措辞，属于需要另行
   决策的口径变更。
2. **`prepare` 侧的上下文注入仍无预算**：最大的一条注入（8312）不含召回段落，走的是 `prepare` 路径
   （带 `memory` 正文，实测该条目 50495 字符）。这一部分在 `src/**`，本线禁改，未处理。
3. **Codex 侧没有"同消息不重复召回"的键**：dsh 有 `recallKey`，codex 每次 prompt 都重新召回。本轮只给它
   加了分段日志（`context.injected.parts`），没有加去重。
4. **任务交接的字符数没有历史实测**：分段日志从下一次 Codex 运行起才有数据；本文件表一的交接一行留空。
5. **命中率未复测**：每文档只给一块的收益来自同行结论，本项目没有检索评测可以验证。
6. **构建与全量测试状态**：`npm run build` 干净（无 TS 错误）。全量 `npm test` 为
   **663 项 / 651 通过 / 10 失败 / 2 跳过**，其中 9 条来自其他线正在改的
   `src/refine.ts`、`src/maintenance.ts`、`src/store.ts` 与 CLI usage（`refine-skeleton`、`review-prefill`、
   `usage`），1 条是 `test/deploy-signal.test.mjs` 的跨盘符用例在 `rmSync` 上拿到 `EPERM`
   （<USER_HOME> 下的临时目录被占用）。**与本轮改动的对照**：把 `adapters/dsh/recall.mjs` 与
   `adapters/codex/scripts/recall.mjs` 临时还原到 HEAD 后重跑 `dist/test/refine-skeleton.test.js`，
   结果同为 8 项 / 5 通过 / 3 失败——失败集不随本轮改动变化。本轮自己新增的测试：
   `node --test test/recall-budget.test.mjs` 6 项全过；`node --test test/*.test.mjs` 为
   147 项 / 146 通过 / 1 失败（即上面那条 EPERM）。
7. **降级后模型可能不去读全文**：索引与摘要都保留 id 与 `amb_read_knowledge` 指引，但"器具可达"不等于
   "模型会用"。这是本次取舍的主要风险，靠回执可观察（`disclosure` 字段）。
