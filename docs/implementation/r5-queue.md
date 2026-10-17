# W3 待核队列可用性（R5）

本文件是 W3 线的实现与实测记录，对应总工程师计划 `docs/implementation/r5-chief-engineer-plan-2026-10-17.md` 的 1.3 缺陷 C 与第三节 W3 行。所有数字都来自只读实测，命令写在文内可复现。

## 一、问题（实测，不是转述）

待核队列不是"消息太多"，而是**没人能审完**：候选按行堆叠、人人平等、失败事实与人工经验混排。三个事实来自只读查询真实库（`<USER_HOME>/.agent-memory-backpack/knowledge.sqlite`）：

| 观察 | 实测 |
|---|---|
| 队列规模 | `pending` 295（计划时点）→ 301（14:12 采样）→ **312**（14:21 采样），单一项目 `p0-workflow` |
| 增长方式 | 9 分钟 +11 条。队列的产出速度远高于处理速度 |
| 成分 | 312 = 人工经验 204 + 自动捕获的失败事实 108 |
| 重复度 | 108 条失败事实只对应 **44 个签名**，即 64 条是纯重复（`edit::replacefilew eio` 16 次、`pwsh::exit_code=1` 16 次） |
| 处理速度 | approved 8 + archived 3，4 天共 11 条 |
| 过期兜底 | `pending` 中"已过期未处理" = **0 条**。不是过期机制坏了，是没人审 |

失败事实为什么会重复入库：`adapters/dsh/failure-capture.mjs:38` 的幂等键是 `sha256([adapter, projectId, sessionId, tool, signature])`，**sessionId 在键里**。同一类错误在新会话里出现，键就不同，于是必然新增一条。这是设计使然，不是 bug；缺的是"同一签名只算一个事实"的入口。

失败事实为什么连"自动过期"都兜不住：只有 14/98 条带 `important: true`，其余 84 条的 `expires_at` 是提交时间 +30 天，而队列时间跨度只有 3 天，所以没有一条到期。这 14 条也不是真裁决：`submit` 的 `serious` 正则（`src/store.ts`，含 `/replace/i`）把失败文本里的 `ReplaceFileW` 读成了"替换/取代"，机械地判成待裁决冲突并给了 `Number.MAX_SAFE_INTEGER` 的永不超期期限。实测 12 条 `replaceFileW` + 2 条 `needsSplit` = 14 条，数字吻合。

补充成因（解释分类失真如何放大队列噪音）：108 条失败事实**全部**被分类为 `kind: 'norm'`。`classification.relation` 是 `supplement` 87 / `new` 11，`confidence` 0.64–0.84。也就是说，机器噪声被贴上了"规范"标签、并带着不低的置信度，与 200 条真经验在同一列里竞争注意力。

## 二、现状数据结构（改前的读法）

`proposals` 表：`id, principal, idem, fingerprint, payload, state, created_at, expires_at, project_id`。

审查相关的读路径只有两条，能力都不足：

- `src/store.ts:1756` `listProposals(projectId, state)`：`ORDER BY created_at DESC`，逐行返回，附 `discovery` / `decision` / `attribution` 三个派生字段。**没有分组概念**：失败事实与人工经验在同一数组里按时间平铺，只能靠人工肉眼去重。
- `src/store.ts:2555` `expireProposals()`：有实现、有 `important` 豁免，但如上所述对"没人审"无解——它只处理已到期的行。
- `submit`（`src/store.ts:1410`）在入库时做过两件事：精确文本去重（`pendingTwin`，只对**文本完全相同**的行生效）与 `important` 判定（正则）。同签名不同会话的失败事实在两道关口之间穿过。

结论：缺的不是"更多规则"，而是**"同一事实"的身份**与**"值得先看"的排序**。

## 三、方案与取舍

### 3.1 只读派生，而不是写入聚合状态

聚合是**在返回列表时计算**的，`queueProposals` 不写任何一行。理由：

1. **可逆性由构造保证**：不写就不会有"聚合组指向的行已变"的漂移。要证明材料化聚合的历史负担更重：需要迁移、需要在评审并发期间维护次级写入路径，而它的失败模式（组摘要与成员不一致）恰是底层记录存在的意义所在。
2. **与并发改动隔离**：本轮 `src/store.ts` 的 tasks / adopt / rescan / knowledge 区域由其它同事在改，新增写路径会与他们的改动交叠。
3. **代价可接受**：一次列表本来就要读出这些行，派生只多一次 payload 解析（312 条量级为毫秒级）。
4. **不变量可测**：底层行数、状态、逐条可查性都能被断言（见第五节测试③）。

### 3.2 签名规则（`src/store.ts:297` `autoFailureSignature`）

只对**自动捕获的文本**生效：`payload.discovery` 含 `【自动捕获的失败事实` 标记才进入聚合，人工提交永远不聚合。签名 = `工具名::归一化后的观察文本`，归一化把易变部分替换为占位符：会话 id → `«session»`、绝对路径 → `«path»`、UUID → `«id»`、长十六进制 → `«hash»`、三位以上数字 → `«n»`；其余折叠空白并小写化，截断 200 字符。

保留 <3 位的数字，是为了让 `exit_code=1` 保持自身，同时让偏移量/端口/长度落到同一占位符。签名取自文本而不是新增列，因此库里已有的行无需迁移即被覆盖；文本形态变化时退化为"不聚合"，而不是错误合并。

**为何不用可逆存储状态**：需要在写库路径上新增一张表或新列，且必须处理评审动作（approve/reject/archive）与成员集合的一致性；派生方案下这些动作天然正确——成员被批准后就不再是 `pending`，自然离开聚合视图，无需同步。

### 3.3 优先级（`src/store.ts:348` `proposalPriority`）

四个信号合成一个 band，并保留判定理由（没理由的名次没人会信任）：

| band | 触发 | 实测（312 条快照） |
|---|---|---|
| `critical` | 人工提交且 `payload.important === true`（等待期内不会自动过期） | 72 |
| `high` | `relation ∈ {conflict, supersede}` 或 `needsSplit` | 0 |
| `normal` | 人工提交（有证据或已归属流程时加分） | 132 |
| `low` | 自动捕获的失败事实（**即使带 `important: true`**） | 108 |

`low` 排在最后是刻意的：这些行的 `important` 来自文本里的 `ReplaceFileW` 之类词条，而不是任何人的决定，让它决定顺序等于把机器噪声顶到人工队列最前面。真实库里 `high` 为 0 不是规则失效，而是覆盖重叠——实测所有 `supersede`/`conflict` 行在提交时已被同一条正则标成 `important`，因此落进 `critical`；`high` 对"未被标 important 但需拆分"的行仍然生效（合成测试⑤覆盖）。

排序：band 分数降序 → 组内 `created_at` 降序 → `id` 作为稳定 tie-break（同毫秒写入的两行不能因存储顺序不同而给出不同的"最近样本"）。

### 3.4 低价值折叠，不静默丢弃

失败事实聚合为**每个签名一条**，带 `occurrences` / `firstSeenAt` / `lastSeenAt` / `memberIds` / `samples`。默认视图（`include: 'actionable'`）只回人工条目，但**折叠组始终在 `groups['failure-facts']` 里报出**，含 `count` / `occurrences` / `collapsedDuplicates` 与 5 条 `preview`，所以"被折叠"这件事本身可见，并且可以单独取回。

## 四、真实库回放（只读）

```bash
npm run build            # 需要 dist/src/store.js；若被其它线正在改的文件阻断，见第七节
node verification/r5/replay-proposal-aggregation.mjs            # 人读格式
node verification/r5/replay-proposal-aggregation.mjs --json     # 机读格式
```

脚本用 `new DatabaseSync(path, { readOnly: true })` 打开真实库，**不写任何一行**；规则不是重写一遍，而是从 `dist/src/store.js` 导入 `autoFailureSignature` 与 `proposalPriority`，所以数字就是上线代码算出来的数字。库路径默认取当前用户的 `<USER_HOME>/.agent-memory-backpack/knowledge.sqlite`，可用 `--db` 覆盖；脚本不打印路径。

**同一次采样（2026-10-17 14:21，`state=pending`）的聚合前后对比**：

| 指标 | 值 |
|---|---|
| 聚合前条目数 | **312** |
| 聚合后（默认视图 `actionable`） | **204** |
| 聚合后（`include: 'all'`） | **248** = 204 人工 + 44 个失败聚合组 |
| 失败事实成员 / 签名组 | 108 / **44** |
| 纯重复被折叠 | **64** |
| 分组分布 | `critical` 72 / `high` 0 / `normal` 132 / `low` 108 |
| 只出现一次的签名 | 34（这 34 组各自仍是一条待审项，没有被隐藏） |

Top 签名（同一快照）：

| 次数 | 签名 |
|---|---|
| 16 | `edit::replacefilew eio (win32 «n»): «path»` |
| 16 | `pwsh::exit_code=1` |
| 14 | `edit::cannot modify "«path»": file has not been read — read the file, then retry` |
| 8 | `edit::old_string was not found in "«path»"` |
| 6 | `edit::cannot edit "«path»": file changed since it was read — re-read the file, then retry` |
| 5 | `read::cannot read "«path»": not found` |
| 3 | `read::limit must be less than or equal to «n»` |
| 2 | `edit::old_string and new_string must differ` |

**跨采样只讲趋势，不跨窗口比绝对数**：295（计划时点）→ 301（14:12）→ 312（14:21）说明队列在 9 分钟内增长 11 条；上表的聚合前后对比全部取自 14:21 的同一快照，未与其它时点的数字混算。（两次采样的窗口不可比：库在持续写入，且 14:12 的探针是我为定位成因写的临时脚本，与交付脚本的字段口径不同；交付数字只取交付脚本。）

## 五、返回结构（字段级）与测试

`store.queueProposals(projectId, { state, include, sampleLimit, limit })`：

- `ordering`：排序规则的文字说明，供面板直接展示。
- `items[]`：条目数组，两种形态由 `kind` 区分。
  - `kind: 'candidate'`：`id` / `state` / `createdAt` / `expiresAt` / `discovery` / `important` / `relation` / `confidence` / `attribution{workflowId,stageId,resolved}` / `priority{band,score,reasons[]}`。
  - `kind: 'aggregate'`：上述字段（取最近一条为代表）之外，加 `signature` / `tool` / `occurrences` / `firstSeenAt` / `lastSeenAt` / `memberIds[]` / `sampleIds[]` / `samples[{id,createdAt,discovery}]` / `aggregation{rule,signature,occurrences,sampleLimit,membersQueryable}`；`priority.reasons` 追加"同一签名出现 N 次"。
- `totals{inState,returned,actionable,failureFacts,failureSignatures,collapsed}`：`inState` 是该状态的全部行数，`returned` 是本次实际返回数，`collapsed = failureFacts - failureSignatures`。
- `groups.actionable{count}`、`groups['failure-facts']{count,occurrences,collapsedDuplicates,preview[{signature,tool,occurrences,lastSeenAt,sampleId}]}`。
- `membersQueryable: true` 与 `note`：明确"这是视图、成员仍可逐条查"。

端点：`POST /v1/proposals/list`（`src/server.ts:323`）新增可选字段 `view`（`flat` | `queue`，默认 **`flat`**）、`include`、`sampleLimit`、`limit`。`view=flat` 的回复与改动前逐字节同形（`{ proposals: [...] }`），因此控制台与 CLI 无需同步修改。

测试：`test/proposal-aggregation.test.ts`（新增，7 项）

```bash
npx tsc -p tsconfig.json --noEmitOnError false   # 见第七节：全局 build 被其它线阻断时的替代
node --test dist/test/proposal-aggregation.test.js
```

结果 **7/7 通过**（同签名 5 条聚合为 1 且计数 5、不同签名不聚合、派生视图不改底层行数且成员逐条可查、低价值分组可单独取回、排序 critical>normal>low、签名只认自动捕获文本、端点 `view=flat` 与 `view=queue` 各自正确）。回归：`proposal-lifecycle` / `duplicate-candidate` / `api` / `operations` / `service` / `store` 六个既有测试文件 **55/55 通过**，未改任何既有期望值。

## 六、面板接线（本轮未动手，只说明需要改哪里）

硬约束规定本轮不改 `adapters/dsh/index.mjs` 与 `adapters/dsh/client.js`，故此项留给总工程师统一处理：

1. `adapters/dsh/index.mjs` 的 `ROUTES` 映射（`'proposals-list': '/v1/proposals/list'`）**无需改路径**，但若要面板吃聚合视图，需要让该动作允许透传 `view: 'queue'` / `include` / `limit`（现在只透传 `projectId` 与 `state`）。不改也不影响功能：默认仍是扁平列表。
2. `adapters/dsh/client.js` 的提案面板需要新增渲染分支：把 `groups['failure-facts']` 显示为一个可展开的折叠区（含 `preview` 的 `signature` + `occurrences`），并把 `items` 里的 `kind: 'aggregate'` 显示为一行"签名 × 次数"，点击展开 `memberIds`。**为什么必须显式渲染**：不渲染折叠区，用户看到的就是"条目变少了"，而不是"64 条重复已折叠"，这与"不静默丢弃"的要求冲突。

## 七、未完成项与风险

1. **`npm run build` 当前整体失败，原因不在本线**。实测报错：`src/semantic.ts:266`、`src/semantic.ts:348`、`src/model-review.ts:66`（`autoPromotable` 字段已在 `SemanticAnalysis` 上声明但四处 return 未补全，属 W2 正在进行的改动，`git show HEAD:src/semantic.ts` 中不存在该字段）、`src/server.ts:222`（`.source`，属 W1 对 `retrieval-service` 返回类型的改动）、`test/retrieval-norm-recall.test.ts:79`（W1 新增测试）。本线为验证自身改动使用 `npx tsc -p tsconfig.json --noEmitOnError false` 产出 `dist/` 后跑测试；`dist/` 在 `.gitignore` 内。**待这些线收敛后需要重跑一次干净的 `npm run build` + `npm test`**，这是本线唯一的验收缺口。
2. **面板未接线**（第六节），用户可见效果尚未在宿主里成立——这是 W3 交付真正缺的一环。
3. **`pwsh::exit_code=1` 这类签名信息量低**（16 条）。`failure-capture.mjs` 自己标了"信息不足：宿主未提供结构化错误正文或 stderr"，`autoFailureSignature` 已经解析并返回 `insufficient` 标志，但本轮没有据此再分一层降级（信息不足的条目是否应比"有错误正文的失败"更靠后）。属于可做而未做。
4. **工具名被净化成 `[redacted]` 的少数条目**会各自成组（工具名不同 → 签名不同），既不误合并也不合并不该分开的，但会让分组数偏多。未做特殊处理。
5. **无缓存**：`queueProposals` 每次调用解析该项目的全部 `payload`。312 条为毫秒级，未测几千条规模的延迟；若队列继续按当前速度增长，需要把签名落成索引列或加短期缓存。这属于性能风险，不是正确性风险。
6. **签名规则是文本启发式**，不是根因聚类。`old_string was not found ... at offset 4096` 与不带偏移量的同句会分成两组（测试⑥把这个行为固定下来：多出的定位信息是不同文本）。真要做根因聚类需要模型判定，本轮刻意不做——队列要的是可信的确定性折叠。
