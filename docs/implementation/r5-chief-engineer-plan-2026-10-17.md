# R5 总工程师作战计划（2026-10-17）

本文件是本轮的**唯一权威计划**：先给实测现状，再给判定与分工，最后给验收标准。每条结论都附可核对的证据（`文件:行号` 或只读查询）。**代码写完不算完成，只有真实宿主里的用户可见结果才算。**

## 一、实测基线（一手核过，非转述）

### 1.1 仓库与测试

| 项 | 值 | 证据 |
|---|---|---|
| 版本 | 1.0.0 | `package.json:3` |
| 测试 | 584 项：581 通过 / 1 失败 / 2 跳过 | `npm test`，日志 `.local/baseline-test-2026-10-17.log` |
| 唯一失败 | 交付物含机器路径（`post-restart-verify-2`，16 处） | `test/clean-install.test.ts:90` |
| 处理 | 已用 `scripts/sanitize-doc-paths.mjs --write` 净化，复跑 **3/3 通过** | 本轮已执行 |
| 未提交改动 | `src/store.ts`（norm 写 FTS + 回填）、`test/norm-searchable.test.ts`、本目录两份文档 | `git status` |

### 1.2 真实库现状（只读查询 `<USER_HOME>/.agent-memory-backpack/knowledge.sqlite`）

| 维度 | 实测 | 读法 |
|---|---|---|
| 活跃条目 | **343**：skill 149 / journal 88 / material 82 / memory 17 / **norm 7** | `knowledge` join `revisions`，json_extract kind/scope |
| `task` 作用域条目 | **0** | 同上，scope.kind 分组 |
| 候选队列 | **pending 295**、approved 8、archived 3 | `proposals` 按 state |
| pending 成分 | **95 是"自动捕获的失败事实"**，200 是 agent 提交的经验 | discovery 前缀分组 |
| pending 分类 | **norm/project 193**、memory/project 68、norm/global 16、其余零星 | payload.classification |
| 时间跨度 | 2026-10-13 → 2026-10-17；超 3 天未处理的只有 6 条 | created_at |
| 任务表 | in_progress **51** / paused **78** / completed **10** | `tasks` 按 status |
| 采纳账本 | 179 条 | `adoptions` |
| 周期扫描 | 24 小时；`lastRescanAt` 有值 | `meta` |

### 1.3 三个真实缺陷（都有代码级成因）

**缺陷 A：规范检索不到（"精准全面取数"不成立）**

- `src/retrieval-service.ts:25` 与 `:132` 用 `.filter(e => e.content.kind !== 'norm')` 把 `norm` 整体排除出内存检索候选集。
- 后果：`amb_search_universal` 走 FTS（`src/store.ts:814`，未提交改动让 norm 进了索引），但**注入路径的自动选择与模型选择看不到规范**；同一次任务里两条路径给出两种能力。
- 叠加：`src/retrieval-index.ts:131` 的 `coverage = idfSum(hits)/presentIdf`，命中词 IDF 之和作分子 → **长文档天然占优**；`:129` 的 `present<2 && queryTermCount>=3` 早退，正好拦住"只有规范才有的说法"。

**缺陷 B：经验被误升格为硬规范（分类失真）**

- `src/semantic.ts:65`：`isNormative` 只要求文本含 `禁止|严禁|不得|必须|务必|规范|硬性要求|绝不|强制要求` 之一。
- `src/semantic.ts:128`：`if (hasNorm) kind = 'norm'` —— norm 的优先级最高。
- `adapters/dsh/index.mjs:643`：`AUTO_PROMOTE_KINDS` 含 `norm`，`:666 entryFromClassification` 据此**一键采纳**。
- 叠加后果：agent 写的经验里几乎必然出现"必须/不要"，于是 **295 条 pending 中 193 条被判 norm/project**；用户点一下"采纳"，一条未经验证的经验就变成**参与 gate 拒绝判定的硬规范**。规范本该是稀缺资源（真实库只有 7 条），现在被噪音淹没。

**缺陷 C：待核目录不收敛（审核变成负债）**

- 295 条 pending、4 天里只处理了 11 条（approved 8 + archived 3）。
- 95 条"自动捕获的失败事实"与 200 条真实经验**混在同一个列表**，无去重、无聚合、无优先级区分：同一类工具失败（例如 `old_string was not found`）反复入库，每次一条。
- `store.expireProposals()`（`src/store.ts:2237` 起）有实现与 `important` 豁免，但真实库里没有体现在 pending 上（超期仅 6 条），**过期并不解决"没人审"**。
- 任务表 51 个 in_progress + 78 个 paused 却只有 10 个 completed：**会话结束没有收敛规则**，"本会话"层（`task` scope）因此永远 0 条。

## 二、本轮判定与目标

**判定**：脚本层（安装、协议、迁移、门禁、备份）已经过硬；**本轮的分全部在"知识质量"这条线上**——取数看不到规则、经验冒充规则、待核目录没人能审完。这三条不修，插件越用越吵，用户会关掉它。

**目标（本阶段结束时必须成立）**

1. **取数准**：一条存在库里的规范，用它的准原文查询能命中；且"库里有、查不到"不再是默认结局。
2. **分类诚**：经验型文本不再被自动判成 `norm`；被一键采纳的条目，其权威等级与文本性质相符。
3. **队列可用**：待核列表能在 30 秒内让人看清"哪几条值得采纳"，重复失败事实自动聚合而不是逐条堆。
4. **会话有层**：`task` 作用域真正有数据；会话结束后任务不再无限期挂在 in_progress。
5. 上面的每一条都**在真实宿主里验证过**，且留下可复现证据。

## 三、分工（四条实现线 + 一条验收线）

| 线 | 内容 | 交付物 | 验收证据 |
|---|---|---|---|
| **W1 检索链** | ① `norm` 进内存检索候选（保留"避免与全量注入重复"的原意，去重放到注入端）；② 排序长度归一，短规范不再系统性输给长日记；③ 补"规范可检索"对照基线 | 代码 + 测试 + `docs/implementation/r5-retrieval.md` | 新测试先在旧基线上失败、修复后通过；真实库准原文查询命中规范 |
| **W2 分类器** | ① `isNormative` 收紧（要求祈使约束结构，而非命中一个词）；② 经验叙述优先归 `skill`/`memory`；③ 采纳时校验"权威等级与证据等级一致"，不一致就降级或要求显式确认 | 代码 + 测试 + `docs/implementation/r5-classification.md` | 用真实库 193 条误判样本回放：误判率下降且样本可查 |
| **W3 审核队列** | ① 同签名失败事实聚合为一条（带出现次数与最近时间）；② 低价值候选自动折叠/归档并说明去向；③ 列表按优先级排序，面板与 CLI 一致 | 代码 + 测试 + `docs/implementation/r5-queue.md` | 真实库 pending 从 295 降到"可审规模"，且不丢内容（归档可查） |
| **W4 会话层** | ① 会话结束时未完成任务的处理规则（收敛为 completed/paused + 归档原因）；② `task` scope 采纳落库并可见；③ `checkpoint` 与会话生命周期挂钩 | 代码 + 测试 + `docs/implementation/r5-session.md` | 真实库出现 scope=task 条目；in_progress 不再无限增长 |
| **V1 验收** | 真实宿主端到端：重启 core 与宿主后，量化对比"注入字符数 / 命中率 / 待审条数"，并留原始回执 | `docs/implementation/r5-acceptance.md` + 原始证据文件 | 每条结论都有时间戳与命令可复现 |

**排序**：W1 与 W2 并行先行（它们互不阻塞、且是其它线的前提）；W3 依赖 W2 的分类结果；W4 独立可并行；V1 在四条线落地后统一跑。

## 四、硬性约束（子智能体必须遵守）

1. **不改已有测试的期望值来"通过"**：新行为要么新增测试，要么明确说明旧期望为何过时（并在文档里给出证据）。
2. **真实库只读**：任何验证用隔离副本（`--data-dir` 指向临时目录或库文件副本），禁止在 `<USER_HOME>/.agent-memory-backpack` 上做写操作。
3. **不降级已有保证**：修订沿革、审核门禁、迁移幂等、只绑回环、凭据分离这五条不得为任何改动让路。
4. **每条改动可回滚**：保留前后差异；改完必须"读回确认"。
5. **文档不留机器路径**：交付文本里不得出现用户目录绝对路径（`test/clean-install.test.ts:90` 会拒绝）。
6. **失败要说清**：做不到的部分写明"未完成 + 原因"，不得写成"已完成"。

## 五、本轮已完成的收尾项

- 机器路径泄漏 16 处已净化，`clean-install` 测试 3/3 通过（发布阻塞项解除）。
- 已确认"安装后自动同步"的真实链路：`src/cli.ts:1007` 起 core 内 60 秒 tick + `rescanDue()`，`src/store.ts:373` 默认 `lastRescanAt=0` → **首次 core 启动即扫描并采纳**，默认间隔 24 小时。缺的不是功能，是**装机文档没有把这条链路说清楚**（列入 W4 文档项）。

## 六、本文件的边界

- 库分布数据取自本机一个真实库（343 条活跃），**不代表典型用户规模**；但它对"分类失真"和"队列堆积"是**实证样本**，不是推测。
- 检索缺陷的三处成因均以行号核过；**尚未做的**是"改排序后的召回对比测量"——这正是 W1 必须先立基线的原因。

## 七、侦察追加：比"规范查不到"更严重的三条（2026-10-17 晚，代码级核实）

一名审计员用 dist 产物在隔离环境复核实测，结论如下（全部只读，未改代码）：

**7.1 注入回执本身在失真**

`src/store.ts:1120-1122`：调用方传入 `selectedIds` 时，`automaticMatches` 被清空并以 `{score, matched: [], coverage: 0}` 覆盖；而 `:1147-1148` 的 `matchedTokens` **只**从 `workflows`/`knowledge` 的 `why.matched` 收集。结果：**任何经 server 的 `prepare` 都返回 `matched: []`、`gaps` = 全部查询 token**。

这条意味着：早先记录的"19 个 token 全部计为 gaps"**与 norm 无关**，它是回执生成路径的缺陷。危害在于 agent 与用户看到的"未命中片段"是假的——诊断据此走错方向，"漏检"这一最重要的进化信号因此不可用。

**7.2 两个入口对"模型未选择"处置不一致（实测，非推断）**

| 入口 | 行为 | 位置 |
|---|---|---|
| 注入 | 传空 `selectedIds` → 清空本地选择 | `src/server.ts:219` → `src/store.ts:1120-1122` |
| 显式检索 `autoRecall=true` | `model_abstained:*` 判真 → 取空集，`results=[]` | `src/server.ts:462-463` |
| 显式检索 `autoRecall=false` | 回落到本地索引，**能命中** | `src/server.ts:464` |

同一查询从不同入口得到不同答案，这与项目内既有记录（"已统一为都回落"）冲突——**以实测为准**，列入 W1 追加 B。

**7.3 索引层本就偏向短规范，"长文档占优"发生在别处**

实测：短规范命中 `score 4.692 / strong=true`；2700 字长日记在索引层已被 `src/retrieval-index.ts:194` 的"journal 非 strong 即剔除"拦掉。真正拦住规范的是**候选集排除**（`src/retrieval-service.ts:25/:132`）与 `src/retrieval-index.ts:129` 的早退条件。结论：**排序公式不是本轮首要问题**，W1 的排序改动必须建立在新增规范语料之后，而不是先动排序。

**7.4 五条取知识路径（完整清单，供后续统一）**

| 路径 | 入口 | 能否看到 `norm` |
|---|---|---|
| 常驻注入 | `src/server.ts:214` → `src/store.ts:1085` | 是（走 `norms()` 全量注入，与检索无关） |
| 工具门禁注入 | `src/server.ts:235` → `src/store.ts:1200` | 是（同一路径） |
| 显式检索 | `src/server.ts:451-465` → `src/retrieval-service.ts:15` | **否**（`:25`/`:132` 排除） |
| 主机侧自动召回 | `adapters/dsh/recall.mjs:13`；Codex 同构 `adapters/codex/scripts/hook.mjs:513,600` | 是（经 `autoRecall`） |
| 工具入口 | `adapters/dsh/index.mjs:1740`/`:1701` | 是（经 `searchUniversal`） |

## 八、同类项目可借鉴（有出处的实测检索）

本节只写**查到原文**的部分（来源见括号），供设计与参数选择参考，不作为"已采纳结论"。

**8.1 自动提炼的工程参数（[ai-memory](https://github.com/akitaonrails/ai-memory) 文档）**

- 调度与审批**解耦**：后台提炼只产出结构化 JSON 提案（含 `confidence`/`rationale`/`evidence`/`body_markdown`），默认自动采纳，`require_approval=true` 转人工。
- 门槛：`min_observations=8`、`min_session_duration_secs=120`、`min_confidence=0.75`；上限：`max_proposals_per_run=5`、`max_input_tokens=24000`。
- **20 条负面过滤器**：一次命令的 smoke 测试、发布标记、短暂缺依赖、宽泛"工具坏了"、一次性叙事、已解决的瞬时失败等**一律不成提案**。
- 被拒绝的候选进 rejection buffer（50 条 / 180 天）并回灌，避免重复提议同一件被否决的事。

**8.2 分层沉淀（[agent-memory-mcp](https://github.com/ipiton/agent-memory-mcp) 的 SEDIMENTATION 文档）**

`surface → episodic` 自动，`episodic → semantic`/`semantic → character` **必须进 review queue**。这正是本项目"失败事实自动入库、结论必须人工采纳"的同构做法——**方向对，缺的是过滤器与门槛**。

**8.3 窄门禁（[Vault-Agent-Memory](https://github.com/zycaskevin/Vault-Agent-Memory) 的 automation 文档）**

`auto_promote_low_risk_candidates=false`、`allowed_sources` 白名单、`min_trust=0.65`、`requires_source_ref=true`、`max_per_run=3`；学习只**排序**、不**授权**。→ 对应 W2 的"窄门禁"追加项。

**8.4 少喂上下文的成熟手法（[claude-mem](https://github.com/thedotmack/claude-mem) 与 ai-memory）**

- 三层渐进披露：`search`（约 50-100 token/结果）→ `timeline` → `get_observations`（约 500-1000），量级约 10× 差距。
- 只送部分页正文（`patchable_page_prefixes`），其余仅一行；
- `explain:true` 返回每条的 rank/RRF/authority 与耗时（**可解释检索**，本项目已有 `selection.mode`/`reason`，可对照加强）。

**8.5 由此新增的下一阶段项（本轮不做，避免摊薄）**

| 编号 | 内容 | 为什么现在不做 |
|---|---|---|
| **W5** | 自动提炼调度器：负面过滤器 + 门槛 + 每轮上限 + 拒绝回灌 | 依赖 W2/W3 的分类与队列形态定型，否则过滤器没有稳定输入 |
| **W6** | 渐进披露式工具（search → read_range → full），把"摘要先行"做进工具签名 | 需要先有 W1 的检索可信度，否则分层只会放大错误 |
| **W7** | `authority`/`origin` 进入检索与注入输出（区分"本节规范/本项目经验/别的会话的日记"） | 依赖 W1 输出结构定型 |

## 九、第二轮同类调研后的取舍（2026-10-17 晚）

完整报告在 `docs/implementation/peer-research-round2-2026-10-17.md`（九节，已落盘）。这里只记**决策**。

**9.1 采纳（下一阶段，按此顺序）**

| 编号 | 内容 | 为什么排在这里 |
|---|---|---|
| **R1** | 把已有的模型分析接成**审核预填**：`src/model-review.ts` 已产出 `kind`/`scope`/`relation`/`confidence`，`src/maintenance.ts` 已写入 `model_reviews`，但 `src/server.ts` 的采纳路径仍要求审核人自备结构化条目——**模型算完、人重填**，这是审核负担的机械来源 | 零新增机制、纯衔接；与 W2/W3 同向 |
| **R2 + R6** | 候选的**内容层负面过滤器**（现在只按 `digest(discovery)` 去重，挡得住复制粘贴、挡不住换说法的同一件事）+ **同一目标唯一待审** | 两者必须成对；是"自动提炼"任何形态的前置 |
| **R4** | 注入改为**索引先行、按 id 展开**（保留现有预算与去重，做成可切换） | 零件都已就位，替换默认与否留到有测量之后 |
| **R9** | 源文件变更显式化 | 注意：`src/rescan.ts` 已等价实现文档级轮替，这一项是**显式化**，不是新能力 |
| **R10** | 安装后首扫：只**打印可粘贴命令**，不把首次采纳改成默认自动 | 首次采纳是唯一有效的闸门，不该被"体验顺滑"牺牲 |

**9.2 不采纳（留档，避免下轮重复讨论）**

- **R7 自动提炼经验**：会显著增加审核负载，且必须排在 R2/R6 之后；本轮**明确不做**（与第一轮 T1/T11 的界线一致）。要做就是一次独立立项，带门槛开关与实验数据。
- 默认自动采纳 / 自动 canonical 化：`norm` 具备工具门禁效力，未审核文本不得获得否决权。
- 年龄衰减与访问计数降权：同类项目实测 Hit@5 0.7217 → 0.1942。
- 多机同步、图/向量检索、Markdown 当唯一真相源：与既定取舍冲突，且阻塞在产品形态选择上。

**9.3 一处纠正**

第二轮报告说"`scope` 只有 global/project/task，**无本会话档**"——描述不准确：**本项目 `task` 就是"仅本会话"**（`src/schema.ts` 的 `scopeSchema` 三档，`src/store.ts:99` 的 `applicable()` 按 taskId 过滤）。缺的不是档位，而是**数据与退出规则**（真实库 0 条 task 条目、51 个 in_progress 长期不收口），这正是 W4。

**9.4 一条应当照抄的设计原则**

同类项目（Vault）的反馈方向是：**越常被拒的模式，越应当要求人工确认**（`downgrade_or_require_review`），而不是越容易自动通过。这条要进 W5 的设计前提。

**9.5 一条机制性观察：归属流程因库中无流程而普遍失效**

实测（本轮两次独立提交）：调研员与总工程师各提交一条经验候选，回执都是 `workflowId: null`、`attribution.resolved: false`，并附"本条候选未标注归属流程，请人工确认它应归属哪个流程/步骤"；`amb_search_workflows` 在本库查询返回空，真实库 343 条活跃条目里 `workflow` 与 `task` 都是 **0 条**。

含义：设计上"经验应归属于流程的某一步骤"，在**没有任何流程被建立**时，会把每一条正常经验都变成"未归属"的例外；叠加"自述内容不算已验证证据"（核心无法核验文本引用）这条约束后，**正常提交基本只能停在待审**。这不是提交者不守规矩，而是机制在空流程库上必然的结果。

处置：并入 W5。两个方向——① 让"未归属但已分类"的候选正常流转，归属改为可选增强；② 从已有 journal/task 里提炼流程骨架再要求归属。**倾向 ①**，因为 ② 依赖一个尚未建立的流程库。

## 十一、实现线回执与新增发现（2026-10-17 晚）

**11.1 W3（待核队列）实测**

同一 pending 快照上：**312 条 → 默认视图 204 条**（44 个失败聚合组把 64 条重复折叠）；分组分布 critical 72 / normal 132 / low 108；重复最多的签名 `edit::replacefilew eio` 16 次、`pwsh::exit_code=1` 16 次、`edit::cannot modify file has not been read` 14 次、`edit::old_string was not found` 8 次。跨采样趋势：295（计划时）→ 301（14:12）→ 312（14:21），**9 分钟 +11**。

**11.2 W3 顺带查出的三条成因链（比聚合本身更重要）**

| 现象 | 成因 | 证据 |
|---|---|---|
| 同一错误在新会话里必然产生新候选，永远去不掉重 | 自动捕获的幂等键**包含 sessionId** | `adapters/dsh/failure-capture.mjs:38` |
| 14 条自动失败事实被标成 `important`，绕过过期归档 | `submit` 的 serious 判定正则把 `ReplaceFileW` 读成 `replace` | `src/store.ts` 的 serious 判定段（W3 报告定位） |
| 真实库里"已过期未处理"= **0**，过期机制等于没生效 | 上面两条叠加：该被过期清掉的那批恰好被标成 important，而 important 有过期豁免（`src/store.ts:2237` 起） | pending 快照 |

**结论**：`expireProposals` 不是没实现，是被**误判的 important** 架空了。修的时候要同时处理"去重键"与"important 判定"，只做聚合等于把水拦在门口、闸门却没修。

**11.3 W2（分类器）实测**

真实库 pending 快照 313 条回放：旧判定记为 `norm` 的 **229** 条 → 新判定 **13** 条（降级 216 条，94%），**反向新增 `norm` 0 条**（没有把真规范改废）。残留 13 条里约 8 条是"祈使语气的方法论"，仍待再收。

**11.4 待接线（用户可见性的最后一公里）**

W3 的聚合视图**默认不改变旧回复**（`flat` 视图逐字节同形），面板因此仍会显示"条目变少"而不是"64 条重复已折叠"。需要接线两处：`adapters/dsh/index.mjs` 的 proposals-list 透传 `view`/`include`；`adapters/dsh/client.js` 渲染 `groups['failure-facts']` 折叠区。**这条不接线，用户感受不到本轮的队列改进**——列为合并后第一优先。

**11.5 W4（会话收敛）实测：任务不收口的根因是"结束信号根本没到"**

真实库 145 个任务 = in_progress 50 / paused 81 / completed 14；`task` 作用域条目仍为 0。逐条核对事件后：

| 情形 | 条数 | 含义 |
|---|---|---|
| `paused` 且有回合结束事件 | 81/81 | 有信号，收敛正常 |
| `completed` 且有回合结束事件 | 14/14 | 同上 |
| `in_progress` 但**没有任何事件** | 20 | 任务被创建后宿主再没上报过 |
| `in_progress` 且有事件、**但没有结束事件** | 8 | 信号链断在中间 |
| 合计拿不到结束信号 | **28** | 依赖"等信号"的收敛永远等不到 |

新规则（`in_progress` 空闲 ≥ 12h → `paused` 并写明原因与阈值；≥ 48h → 日记归档为 `task` 作用域条目；**任何情况都不自动标 completed**——完成需要证据，时钟不是证据）在同一份真实库上回放：45 条转 paused、20 条归档、**0 条被误标完成**。阈值是用回放选出来的：6/24 小时会把 14 条已 paused 的任务也归档（过激），24/72 小时只收敛 23 条（不足），12/48 落在有效区间。

**与前文的呼应**：11.1 里"归档 20 条全来自 in_progress、paused 超 48h 的为 0"说明——**问题不在等待时长，而在信号来源**。所以 W4 的接线（DSH 在 `/v1/sessions/reflect` 后、Codex 在 `Stop` 钩子里追加一次幂等的 `/v1/tasks/archive`）比继续调阈值更重要。

## 十、追加实测：每轮注入在重复发送规范全文（2026-10-17 晚）

这条直接对应"不要把大量上下文喂给 agent"，且是**代码级可判定**的：

| 事实 | 证据 |
|---|---|
| 门禁调用**带了**已知版本 | `adapters/dsh/index.mjs:1540-1546`，`knowledgeRevision: revisions.get(exec.agent)` |
| 准备调用**没带**已知版本 | `adapters/dsh/index.mjs:1480-1486`：body 只有 `adapter`/`projectId`/`sessionId`/`taskId`/`query` |
| 于是"同版本只回指针"永不触发 | `src/store.ts:1184` 的 `unchanged` 判定要求 `options.knownRevision !== undefined` |
| 后果 | **每一轮用户消息都把规范正文重新注入一次**（本机当前 4 条规范 = 594 字符；规范变多会线性增长） |
| 与文档不符 | `README.md` 第 302-306 行称"适配器把已注入的知识版本记在会话状态里，版本未变时只回一个内容未变的指针"——至少这条路径上没有做到 |
| **两侧同病** | Codex 侧同样：`adapters/codex/scripts/hook.mjs:507-513` 的 prepare 体里没有版本字段；其门禁调用（`:622-627`）也没有，但 `:656-668` 用本地会话状态做了"版本未变不再注入"的本地去重 |

**两侧的差别值得记下来**：门禁路径两宿主都做了本地去重（DSH `adapters/dsh/index.mjs:1600`、Codex `hook.mjs:656-668`），而**准备路径两侧都没有**，于是"每轮重复发送规范全文"在两个宿主上同时存在。修的时候要一起修，否则两端行为继续分叉。

另有一条同向证据：`adapters/dsh/index.mjs:1513-1520` 的召回键为 `taskId:最新用户消息:知识版本`，**每条新用户消息都会重新召回一次**并整段拼进上下文（实测注入里出现过 6400 字符级的技能正文节选）。这不是错误，但它与"规范全文"叠加后，构成了本会话每轮数 KB 的固定开销。

**处置**：列为 **W6 的第一项**（把 `prepare` 带上已知版本，与 `gate` 对齐；召回部分加预算与"内容未变不重复"）。改动落在 `adapters/**`，因此**等 W1–W4 合并后再动**，避免与正在跑的四条线抢文件。
