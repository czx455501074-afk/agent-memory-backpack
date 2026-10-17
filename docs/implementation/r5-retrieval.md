# R5 · W1 检索链：规范召回、排序长度归一、回执真实化

范围：`src/retrieval-service.ts`、`src/retrieval-index.ts`、`src/store.ts`（仅 `prepare` 回执区最小局部）、
`src/server.ts`（仅两条检索入口的最小局部）、新增测试与语料。真实库全程只读（`<USER_HOME>\.agent-memory-backpack` 原文件从未被打开，验证一律在临时目录里的副本上进行）。

## 一、问题

库里存在的规范（`norm`）用其准原文查询检索不到，且两条入口对同一问题给出不同答案：

- `amb_search_universal` 走全文表 `workflow_search` 能返回规范；
- 注入路径（`/v1/prepare` → `createRetrievalService`）的自动选择与模型选择看不到规范；
- 检索回执把真实命中报成"未命中片段"，误导诊断与进化信号。

## 二、成因（已逐条核实）

1. **规范被排除出内存检索候选**：`src/retrieval-service.ts:25` 与 `:132`（改动前行号）的 `.filter(e => e.content.kind !== 'norm')`。现为 `:60`（唯一一处，已去掉）；原 `:132` 的 liveKey 复算同样过滤，现为 `:176`。
2. **`scopedEntries()` 的全部调用方均已核对，没有任何一方依赖"返回结果不含 norm"**：`src/maintenance.ts:42`（遍历全部条目）、`src/retrieval-service.ts`（本处）、`src/server.ts:190/378/379`（各自按 kind 过滤）、`src/workflow-organization.ts:21/139`（按 `skill`/`workflow` 过滤）。排除只发生在 retrieval-service 自己的一行里。
3. **"避免与全量注入重复"的原意不会被违反**：`prepare()` 只通过 `norms()` 读规范（`src/store.ts:1204`），检索条目由 `knowledge()` 产出，而 `knowledge()` 只接受 skill/memory/preference/journal，其余 kind 一律 `continue`（`src/store.ts:885`）。把规范 id 放进 `selectedIds` 既不进 `workflows` 也不进 `knowledge`；该结论已由既有测试 `test/norm-searchable.test.ts:104` 固定。**因此正确做法是在注入端保持去重语义，而不是在索引端遮蔽。**
4. **排序系统性偏向长文档**：`src/retrieval-index.ts:131` 的 `coverage = idfSum(hits)/presentIdf` 只做查询侧归一，命中的查询词越多分越高 → 引用规范原文的 20KB 日记胜过 69 字的规范本身（数据见第五节）。
5. **回执失真**：`src/store.ts` 的 `prepare` 在收到 `selectedIds` 时用 `{score,matched:[],coverage:0}` 覆盖本地解释，而 `matchedTokens` 只从 `workflows`/`knowledge` 的 `why.matched` 收集 → 服务端来的每次 prepare 都报 `matchedTokens: []`、`gaps` 等于全部 token。
6. **两条显式入口降级不一致**：`src/server.ts` 的 `/v1/knowledge/search-universal` 在模型弃权（`model_abstained:*`）时，`autoRecall: true` 返回空集、不带 `autoRecall` 却能命中。

## 三、改动

- `src/retrieval-service.ts:60`：去掉 norm 过滤，并写明"为什么加进来不会重复注入"（见二.3）；`src/retrieval-service.ts:22-27` 新增 `selectionSource()`，从 `mode`/`reason` 推导来源，新增字段只出现在回执，不改变返回形状。
- `src/retrieval-service.ts:112-140`：模型弃权（`mode==='model'` 且空选择）也回落本地索引排序（`selectedIds` 条件行 `:139`），原因串保留为 `local_index:model_abstained`；`unavailable`/`timeout`/`503` 等"可用性"结论**不回落**（保持既有语义）。
- `src/retrieval-index.ts:149-159`：新增 `lengthFactor(text) = 1/(1+ln(1+min(len,48000)/500))`；`src/retrieval-index.ts:219` 的评分改为 `(coverage+subject)*3*lengthFactor(body) + (strong?1:0)`——只归一证据项，`strong` 仍是不随长度缩水的判定。
- `src/store.ts:1195`：`prepare` 的 options 增加 `selectionSource`；`:1242` 起的 selectedIds 分支改为**保留本地命中词**，只从调用方取分数与顺序；`:1284` 起把 `selectedIds` 的命中词并入 `matchedTokens`（规范经 `norms()` 注入，不在 `workflows`/`knowledge` 里，必须单独并入，否则真实命中仍会被报成缺口）。
- `src/server.ts:234`：把 `selectionSource(selection)` 透传给 `prepare`；`:529-531`：用 `decided`（读**原始** selection 的 `mode`）统一两条入口的降级——`mode: 'index'` 的本地结论（含空结论、过期修订守卫、模型不可用）一律尊重，只有"未决"（模型弃权 / 显式全文 / 知识变更）才回落全文排序。
- 新增测试：`test/retrieval-norm-recall.test.ts`（5 例）、`test/retrieval-norm-holdout.test.ts`（4 例）；新增语料 `test/fixtures/retrieval-norm-holdout.json`。**未修改任何既有测试的期望值**；`test/retrieval-quality.test.ts`、`test/retrieval-blind.test.ts`、`test/retrieval-acceptance-v2*.eval.mjs` 一行未动。

## 四、新旧对照数据

排序对照（合成对照，`test/retrieval-norm-recall.test.ts` 用例 2，诊断输出原样）：

| 公式 | 69 字规范 | 20,735 字日记（引用了规范的整句） | 顺序 |
|---|---|---|---|
| 旧（纯 coverage） | 2.0866 | **4.0000** | 日记 > 规范（错） |
| 新（长度归一） | **1.9622** | 1.6317 | 规范 > 日记（对） |

真实库副本对照（7 条活跃规范，取前 6 条；`oldRank` = 旧候选集即排除 norm，`newRank` = 新候选集，均为同一查询的前三名）：

| 规范 id | 准原文查询 | oldRank 前三 | newRank 前三 |
|---|---|---|---|
| norm:29adc4ead699d040 | `# Agent 工作入口 默认中文，直接` | 三条 skill，无规范 | **规范**、skill、skill |
| norm:7eefbdccc0ea236e | `# Project memory ## ` | 三条 memory，无规范 | memory、**规范**、memory |
| norm:9861dfd810c7505b | `# Codex 全局工作规范 ## 账号` | 两条 skill + memory，无规范 | **规范**、skill、skill |
| norm:endpoint-latency-attribution | `排查接口超时必须带 x-amb-prot` | node 事件循环材料 + 两条 skill，无规范 | **规范**、规范、规范 |
| norm:log-window-comparability | `比对日志计数验证修复效果前必须先证明两窗` | skill + 两条 memory，无规范 | **规范**、规范、skill |
| norm:package-syntax-gate | `打包发布脚本 scripts/packa` | 三条无关条目，无规范 | **规范**、journal、material |

结论：6/6 的准原文查询在旧候选集下**前三名完全没有规范**；新候选集下 5 条排在第一位、1 条排在第二位。自动检索（`createRetrievalService`，无 provider → `local_index:not_configured`）6/6 `containsNorm: true`。原始输出：`docs/implementation/r5-retrieval-live-verify.txt`。

## 五、测试与验收

- 基线刻度：`test/retrieval-norm-recall.test.ts` 先失败、后通过。旧基线 5 例全红，原始输出留档 `docs/implementation/r5-retrieval-baseline.txt`（其中含排序对照的旧公式数据与 `journal 4 > norm 2.0866`）；修复后 5/5 通过。
- 新增语料：`test/retrieval-norm-holdout.test.ts` 4/4 通过（准原文规范查询 3 例、超预算省略后仍可检索 2 例、规范命中不计缺口 1 例）。
- 全量：`npm run build` 通过；`node --test dist/test/*.test.js test/*.test.mjs` → 619 例，pass 603，fail 14，skipped 2（原始输出 `docs/implementation/r5-retrieval-full-test.txt`）。
- 14 个失败的归属判断：**全部**来自 `test/dsh-client-surface.test.mjs`，断言为面板 UI 文案与结构（"可达性状态必须可见""必须提供搜索输入框""重试成功后必须回到正常状态"），该文件读取 `adapters/dsh/client.js` —— 该文件在同一工作区里被并行的界面线修改中（`git status` 显示 `M adapters/dsh/client.js`）。检索相关的测试文件无一失败。
- 验收 eval（期望值未改动）：`retrieval-acceptance-v2` → precision 1 / recall 0.9 / negativeRejection 1 / p95 1ms / `accepted: true`；`--v3` → precision 1 / recall 0.889 / negativeRejection 1 / p95 5ms / `accepted: true`。

## 六、未解决项与风险

1. **既有快照过时（只报事实，未改）**：`test/store.test.ts:402-405` 的注释写着"规范不进 `selected`"。本次实现**保留了**这一形状（规范仍只经 `norms()` 注入，不进 `workflows`/`knowledge`），因此该注释与代码仍一致；但规范的命中现在会出现在 `retrieval.matchedTokens` 中，读者若只看 `selected` 会漏掉它。
2. **`strong` 项未参与长度归一**：这是有意的（`strong` 是证据判定而非数量），代价是"长文档里成立的一句强证据"仍可能压过短文档的弱证据，未做进一步测量。
3. **长度因子的常数（500 字符尺度、对数）来自一个对照样本**，未在真实库上做分布级调参；真实库上规范排名第 2 的那条（`norm:7eefbdccc0ea236e`，标题为"Project memory"）说明标题信号在部分规范上很弱。
4. **`/v1/knowledge/search-universal` 的 `autoRecall` 现在只影响结果宽度，不再影响"是否有结论"**：这一行为变化会影响任何依赖旧"空集"语义的调用方；本次通过既有测试确认了可用性失败（`unavailable`）仍然返回空集，但未做宿主端到端回放。
5. **模型路径未实测**：真实库验证走的是无 provider 的确定性路径（`local_index:not_configured`）；配置了 provider 时"模型能否选中规范"只由合成 fixture 覆盖（`test/retrieval-norm-recall.test.ts` 用例 5）。
6. **`docs/implementation/r5-retrieval-full-test.txt` 与 `r5-retrieval-baseline.txt` 是原始输出留档**，含测试运行时的相对/工作区路径（无用户目录绝对路径，`test/clean-install.test.ts` 通过可证）。
