# AMB 重构设计 v1（采纳对抗评审后）

时间：2026-10-20 20:00。取代 `10-design-v0.md`。两份独立评审见 `11-review-gpt6luna.md`、`11-review-gemini.md`；本稿逐条回应，凡被推翻的表述一律作废，不以措辞保留面子。

## 零、先修正 v0 的事实错误

| v0 说法 | 事实 | 处置 |
|---|---|---|
| `kind` 由调用方声明且可缺省 | 已落库条目的 kind 由各 schema 的 literal 固定（`src/schema.ts:206-209`、`288-290`）；可缺省的是**候选分类上下文** `memoryContextSchema.kind`（`:49-55`） | 作废。改为分别统计"候选中分类字段缺失率"与"已落库条目分类误判率" |
| `memory` 是无差别桶 | `memorySchema` 定义是 durable background facts，且 `memory-policy.ts:62-66` 已对缺失证据的 memory 拦自动召回；journal 另有独立字段 | 作废。问题改成"语义粒度不足 + 自动归档噪声"，不是"没有类别" |
| `evidenceRefs` 缺失即落 `unverifiable` | 引用结构在 `:62-72`，support 封装在 `:73-82`，`evidence.ts:10-20` 只脱敏/冻结/算哈希，**不访问文件与网络** | 作废。把"结构有效 / 引用可解析 / 命题被支持"拆成三个判据 |
| 全库扁平、无关系 | 已有 `events`、`proposals`、`tasks`、`outbox`、`supersessions`、`entry_bridges`（`store.ts:804-806`、`862-872`、`892-900`、`3612`） | 作废。只保留"集合成员内嵌 JSON"这一条 |
| members 不可反向查询 | `store.ts:1767-1773` 搜索回执已投影 `members`（前 5）与 `memberCount` | 作废。改为"无成员索引表，反向查需扫 JSON，实测代价未测" |
| 自检"规范 0 条"是错误计数 | 宿主已加载规范本来就不重复注入（`store.ts:2067-2072`），是设计选择 | 作废。改为可解释性缺陷：输出拆 `registered / hostProvided / injected` |
| 一次探测证明自动收尾写噪声 | 只能证明同窗发生两次知识写入 | 降级为线索；需按 `taskId`/origin 逐条归因 |

同时修正两处 v0 漏掉的关键事实：

1. **空证据能变成生效规则**：`store.ts:4283-4288` 采纳候选时只调用 `captureSupport`，**不检查 `support.status`**，`missing` 候选同样被提升。这是"证据缺失"链路的最后一公里，比入口必填更重要。
2. **规范注入不看证据**：`store.ts:2071` 的 norms 过滤不经过 `mayAutomaticallyRecall`，无证据的 norm 每轮都会进上下文。

## 一、200K 问题的答案（已实测，不是推断）

`01b-session-payload.md` 对本会话 2.4 MB 日志逐帧解压后的实测：

| 组成 | 字符数 | 估算 token | 占固定开销 |
|---|---|---|---|
| 工具定义 372 个 | 333,854 | ≈83,700 | 55%（其中 `mcp__rea__` 207 个 = 192,872 字符，占 57.8%） |
| 技能目录注入 | 144,996 | ≈41,500 | 27% |
| 系统提示（operator prompt） | 105,425 | ≈28,900 | 19% |
| **AMB 注入（去重后）** | **21,769** | **≈12,200** | **3.6%** |
| AMB 工具定义 16 个 | 9,453 | ≈2,400 | — |

估算与首条 `usage.totalTokens=159,004` 误差约 1%。

**结论**：新会话 200K 不是 AMB 造成的。即使把 AMB 全部删掉，固定开销也只降 4% 左右。真正的单点是 `mcp__rea__` 的 207 个工具（19.3 万字符）与宿主技能目录（14.5 万字符）。

**因此本轮的定位必须诚实**：AMB 侧只做"占得更少、用得更准"，并把宿主侧的两个大头列为待用户决策项（见第五节）。把 200K 说成"优化 AMB 就能解决"是欺骗。

## 二、采纳的取舍（做什么）

评审两份都指向同一组动作，按杠杆排序：

### A1 止住写入噪声，让提交状态可见（两份评审的共同第一条）

- 候选提交回执改为三态，且**回执必须让 agent 看见**：
  - `accepted-verified`：有可解析引用且校验通过
  - `needs-evidence`：已保存为未核实候选，默认不自动注入，附"补什么才算数"
  - `rejected-invalid`：结构非法（空正文、纯确认语、伪造的证据格式）
- **不做硬拒收**：无证据候选仍可保存（评审警告：硬门槛会诱发伪证与沉默失败），只是不能进自动注入与规范层。
- `approveProposal` 拒 `missing`（`store.ts:4283`），并给人工显式放行开关（控制台批准时填理由）。
- 自动收尾门槛：一次会话若**无工具调用、无文件变更、无结论产出**，不写长期 journal，只留事件。判据用事件表可复算，不靠文本启发式。
- `material.ts:114` 的硬编码 `verifiable` 改为按"是否实际抓取过正文"决定。
- `missing` 一律不自动注入（去掉 `memory-policy.ts:64` 的 `kind==='memory'` 限制），norms 注入补同一判据。

### A2 证据三层，不伪称真实

| 层 | 判据 | 谁能给 |
|---|---|---|
| 结构有效 | 引用字段齐全、locator 非空、kind 合法 | 代码（已有） |
| 可解析 | artifact 路径存在；event id 可查；knowledge id@rev 可读；command 含 exitCode | 代码（新增只读校验器） |
| 命题被支持 | 引用内容确实支持结论 | 模型（只能降级，不能升级） |

- 新增只读校验器，结果存 `support.verification`（新可选字段），**不重跑命令**（评审指出重跑有副作用）；命令类只校验结构与退出码是否存在。
- `snapshot` 非空不再等同于 `captured`：按 kind 要求最小结构（artifact 需路径 + 摘要，command 需命令 + 退出码，event 需可查 id）。
- 自述型证据（写"已验证"但零引用）不拒收，但强制 `self-reported` + 不自动注入。

### A3 检索回执可复算（两份评审的第三条）

- 修中文伪词项：`matchedTerms`/`missingTerms` 只输出真实词项，不再回传 `"索噪"`、`"具定"` 这类跨词 2-gram。
- 修"字面复核整批丢弃"：`prepare` 现在对 3 条候选全部 withheld（实测 `usedChars=0`）。改为分级——字面命中优先，语义候选标 `weak` 后仍可注入但限条数，并在回执写明"这是弱命中"。
- `coverage` 按操作分别定义，不做一个万能对象：
  - `search`：matched / returned / cursor / degraded
  - `read`：totalChunks / currentChunk / hasMore / outline
  - `prepare`：considered / shown / withheld(reason) / gaps
- 明确 `unknown` 语义词覆盖不可折叠为 `done`。

### A4 自检口径可解释

`amb_self_check` 的 knowledge-state 拆成 `registered / hostProvided / injected` 三项。

### A5 AMB 工具面瘦身（有限度）

只压缩描述与冗余 schema，**不合并工具名**（评审：合并会带来兼容与误调用风险）。目标：16 工具 9,453 字符 → ≤6,000 字符；两处注册点同步（DSH 与 MCP，仓库有逐字节一致性测试）。

## 三、需要数据才做（阶段 B）

### B1 分类：不新增九类，先加"可选子类 + 受控域"

- 保留现有 literal kind（不迁移 900 条数据）。
- 新增可选 `category`：`experience` / `pitfall` / `fact`，仅对 `memory` 生效，**不影响 kind 路由**，用于检索与展示。
- 新增可选 `domain`（受控小词表，首版 10-12 个顶层域，人工确认）。agent 只能提议，不能自造；新增域需定义 + 反例 + 别名 + 负责人。
- 先盲测：从真实库抽 100 条，两名标注者独立标 kind/category/domain，一致率 ≥90% 才启用自动建议；否则只做"建议字段"，不自动改写。

### B2 盲测与指标（用户问"是否越用越聪明"）

固定夹具 + 同一预算，测：噪声率、Recall@K、精确命中保留率、p95、空命中可解释率。基线与改后同口径对照。

## 四、本轮明确不做（及理由）

| 不做 | 理由 |
|---|---|
| 九类 kind 迁移 | 900 条重分类 + 全链路分支扩张，收益未证 |
| `domains`/`collections`/`collection_members` 三表 | 双写一致性、回滚、导入导出复杂度；先用 domain 列 + 现有 members，实测慢再物化 |
| 每次工具调用保存参数正文 | 事件量线性增长、敏感数据入库、污染检索；只留 allowlist 元数据 + hash |
| `amb_recall_audit` 新工具 | 先扩展现有 prepare 回执；模型自评覆盖会制造虚假完备 |
| 通用命令重放验证 | 有副作用，不可作为证据验证器 |

## 五、宿主侧两个大头（需用户决定，不在插件内擅改）

1. `mcp__rea__` 207 个工具 = 19.3 万字符：按项目/会话启停该 MCP server，或换 compact schema（当前已是 compact profile，仍有 19.3 万）。
2. 技能目录 145K 字符一次注入：改为宿主侧按需索引（`skills` 目录不进系统提示，由 agent 主动查）。
3. operator prompt 105K 字符：精简重复的注入对抗段。

这三项若不动，AMB 再优化也只能影响 4% 的固定开销。

## 六、验收（每项都要能跑）

| 项 | 命令 | 通过标准 |
|---|---|---|
| A1 采纳闸 | `node --test dist/test/evidence-gate.test.js` | missing 候选无法被采纳；人工放行留痕 |
| A2 解析器 | `node verification/evidence-resolve.mjs` | 四类引用各自给出 parseable/missing，不重跑命令 |
| A3 检索回执 | `node verification/retrieval-receipt.mjs` | 无跨词伪词项；weak 命中可注入且标注；数字与实测一致 |
| A4 自检 | `amb_self_check` | 输出 registered/hostProvided/injected |
| A5 工具面 | `node verification/amb-tool-surface.mjs` | 总字符 ≤6,000；两处定义一致 |
| 全量 | `npm test` | 0 失败（当前基线 901/904，唯一失败已修） |
| 契约 | `node verification/contracts.mjs` | 53/53 且新增项入册 |
