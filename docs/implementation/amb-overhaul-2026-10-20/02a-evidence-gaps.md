# AMB 证据可为空的写入入口（只读审计）

状态：完成（只读审计，未改动任何仓库文件，未触碰真实库）

结论一句话：evidence 在所有对外写入入口都是可选或可推导的；空证据会被静默归一成 `support.status='missing'` 存下来，既不报错，也不阻止后续采纳与注入（仅 `kind='memory'` 一处有拦截）。

## 一、支撑层：为什么"空"能写进去

| 事实 | 位置 | 说明 |
|---|---|---|
| 引用只校验形状，不校验存在 | `src/schema.ts:62-72` | `evidenceReferenceSchema` 只要求 `kind` + `locator`；`locator` 仅 `trim().min(1).max(2000)`，不查文件是否存在、命令是否可复算、事件是否可查 |
| 引用数组没有下限 | `src/schema.ts:78` | `references: z.array(evidenceReferenceSchema).max(110)` —— 没有 `.min(1)` |
| summary 可为空串 | `src/schema.ts:78` | `summary: z.string().max(4000)` —— 没有 `.min(1)` |
| support 整体可省略 | `src/schema.ts:104` | `common` 中 `support: supportSchema.optional()`，所有 kind 继承 |
| 证据等级有弱默认 | `src/schema.ts:109` | `evidence: evidenceLevelSchema.default('unverifiable')` |
| 空证据被静默降级 | `src/evidence.ts:17-18` | `captureSupport` 推导 status；三者皆空 → `'missing'`，函数正常返回，不抛 `DomainError` |
| 取证明确不做核对 | `src/evidence.ts:10` | 注释与实现一致："No network/file access and no promotion of claims" |

`captureSupport` 的三态由 `src/evidence.ts:17-18` 唯一决定：

- `captured`：任一 reference 的 `snapshot` 去空格后非空（`src/evidence.ts:17`）
- `referenced`：无 snapshot，但 `summary.trim()` 非空，或 `references.length>0`，或 `supplements.length>0`（`src/evidence.ts:18`）
- `missing`：上述三项皆空（`src/evidence.ts:18` 三元末尾分支）

`status` 是必填字段（`src/schema.ts:80`），但它由机器算出来，调用方无法通过"不填"来触发报错——这就是整条链路能静默通过的根因。

## 二、可空写入入口清单

### A. 对外 HTTP / 工具入口

| # | 入口 | 文件:行 | evidence 字段名 | 必填 | 缺失时行为 | 是否校验引用真实存在 |
|---|---|---|---|---|---|---|
| 1 | `POST /v1/proposals` | `src/server.ts:345`；schema `src/schema.ts:328-329`；落库 `src/store.ts:2768-2770` | `evidence`、`evidenceRefs` | 否（两者都 `.optional()`） | `captureSupport` 得 `missing`，回执只带 `evidenceStatus`（`src/store.ts:2911`），HTTP 200 | 否 |
| 2 | 工具 `amb_submit_experience`（MCP） | `src/mcp.ts:185-200`（`evidence` optional 见 `:196`） | `evidence`、`evidenceRefs` | 否 | 透传空值到 `/v1/proposals` | 否 |
| 3 | 工具 `amb_submit_experience`（DSH 原生） | `adapters/dsh/index.mjs:2233-2251`；required 仅 `['idempotencyKey','discovery']` | `evidence`、`evidenceRefs` | 否 | `:2262-2263` 仅在非空时才带字段，空则整个字段消失 | 否 |
| 4 | `POST /v1/tasks/checkpoint` | `src/server.ts:1185-1200`；落库 `src/store.ts:5027,5031-5034` | `verified`（作 summary）、`evidenceRefs` | 否 | 非 `completed` 状态不校验；`captureSupport` 可 `missing`；`writeJournal` 照写 | 否（`files` 里的 locator 由 `src/store.ts:5033` 直接拼成 artifact 引用） |
| 5 | 工具 `amb_checkpoint_task`（MCP） | `src/mcp.ts:161-173` | 同上 | 否 | 同上 | 否 |
| 6 | 工具 `amb_checkpoint_task`（DSH 原生） | `adapters/dsh/index.mjs:1893-1906`（无 `required`） | 同上 | 否 | 全部字段可省 | 否 |
| 7 | `POST /v1/tasks/record` | `src/server.ts:1227-1244`；schema `src/schema.ts:428,438` | `verified`（default `''`）、`evidence`（default `self-reported`） | 否 | 只在 `status==='completed'` 时校验（`src/server.ts:1241-1243`） | 否 |
| 8 | `POST /v1/knowledge/write` | `src/server.ts:1066-1079`；support 可选 `src/schema.ts:104` | `support`（含 `references`/`summary`） | 否 | `knowledgeSchema` 直接放行，`import` 不补也不校验 | 否 |
| 9 | `POST /v1/knowledge/supersede` | `src/server.ts:908-914`；落库 `src/store.ts:6122-6124,6157` | `evidence`（`min(1)` 自由文本） | 是（仅非空） | 空串抛 `missing_evidence`（`src/store.ts:6124`）；非空任意文本即通过 | 否 |
| 10 | `POST /v1/knowledge/retire` | `src/server.ts:931-938` | 无 evidence 字段，仅 `reason`（`min(1)`） | 不适用 | 只有理由，无需任何依据 | 不适用 |
| 11 | `POST /v1/knowledge/structure` | `src/server.ts:955-961`；schema `src/schema.ts:138-142` | `evidence`（`min(1)` 自由文本） | 是（仅非空） | 空串被 zod 拒；任意文本通过 | 否 |
| 12 | `POST /v1/events` | `src/server.ts:346`；schema `src/schema.ts:333-337` | 无 evidence 概念；`summary` 无 `.min()` | 不适用 | 空摘要事件照写 | 不适用 |
| 13 | `POST /v1/sessions/reflect` | `src/server.ts:1173-1183` | `summary` 可选（`?: z.string().max(2000)`） | 否 | `:1182` `p.summary ?? ''`，写空摘要事件 | 不适用 |
| 14 | `POST /v1/outbox/enqueue` | `src/server.ts:360-371`；schema `src/schema.ts:349-357` | 无（`payload: z.record(z.string(), z.unknown())`，`:353`） | 不适用 | 载荷完全不解析，evidence 校验被推迟到重放，而重放走同一条可空路径 | 否 |
| 15 | `POST /v1/material/save` | `src/server.ts:1097-1141`；构造 `src/material.ts:102-124` | 无 evidence 输入 | 不适用 | `src/material.ts:114` 硬编码 `evidence: 'verifiable'`——没有任何证据却声明"可核实" | 否（`url` 只做 normalize，不请求） |

### B. 内部与自动写入

| # | 入口 | 文件:行 | 说明 |
|---|---|---|---|
| 16 | `store.writeJournal` / `generateJournal` | `src/store.ts:5381-5401`、`5356` | 日记的 support 由 `task.verified` 直接当 summary；`verified` 空则 `missing`，日记照常入库 |
| 17 | `store.approveProposal` | `src/store.ts:4171`、`4283-4293` | 采纳时用 `payload.evidence`/`evidenceRefs` 重新取证，**但不检查 `support.status`**——`missing` 候选同样被提升为生效知识（`src/server.ts:635-686` 也没有这道闸） |
| 18 | 演化/提炼自动候选 | `src/store.ts:3883`、`src/refine.ts:633` | `evidence` 是程序拼出的叙述字符串，不是可核算引用 |
| 19 | 归类/重扫/界面批量写入 | `src/curation.ts:77,102`、`src/rescan.ts:33`、`src/ui.ts:842,907,1335` | `evidence` 等级被硬编码（`verifiable`/`self-reported`），无任何引用伴随 |

按独立写入路径计数，口径分三档，不要混为一谈：

- **evidence 字段可为空/可缺失的写入路径：9 条**——`/v1/proposals`、`/v1/tasks/checkpoint`、`/v1/tasks/record`、`/v1/knowledge/write`、`/v1/events`、`/v1/sessions/reflect`、`/v1/outbox/enqueue`（上述 7 条对外），加内部 `store.writeJournal`、`store.approveProposal` 共 2 条。
- **evidence 必填但只校验非空、不核引用：3 条**——`/v1/knowledge/supersede`、`/v1/knowledge/structure`、`/v1/knowledge/retire`（最后一条连 evidence 字段都没有，只有 reason）。
- **证据等级被硬编码、无引用伴随：1 条**——`/v1/material/save`（`src/material.ts:114` 直接写 `verifiable`）。

表 A 的 2/3 与 5/6 是同一写入路径的两个工具面（MCP 与 DSH 原生），计入上面的 9 条而不另计。

## 三、`support.status` 三态与"missing 仍会被注入"

三态的触发条件见上（`src/evidence.ts:17-18`），全部由数据推导，没有一处由调用方声明。

missing 条目是否仍可能被注入：**会，且只在一种 kind 上被拦。**

- 拦截函数：`src/memory-policy.ts:63-66`。第 64 行是唯一判据：`if (content.kind === 'memory' && content.support?.status === 'missing') return false;`
- 调用点：`src/store.ts:2153`（`prepare` 自动匹配过滤）、`src/server.ts:1047`（`search-universal` 的 `autoRecall`）、`src/retrieval-service.ts:141`（检索候选集）、`src/store.ts:447`（打分入口）。
- 后果：`skill`、`preference`、`journal`、`norm`、`workflow`、`material` 即使 `support.status='missing'`，`mayAutomaticallyRecall` 仍返回 `true`。
- 更直接的一条：`src/store.ts:2071-2082` 的规范注入路径（`prepare` 的 `norms`）**根本不经过** `mayAutomaticallyRecall`，只要条目是 `norm` 且非 `hostProvided`，就在 `splitByBudget` 后无条件注入。因此"无证据的规范"可以每一轮都进上下文。

这构成两处不对称：写入侧不要求证据，注入侧只在 `memory` 上要求，规范侧完全不要求。

## 四、最小改动即可"没证据写不进"的清单

按"改一行就能堵住"排序：

1. `src/schema.ts:328-329`：`evidence` 改为 `.min(1)`，或加 `superRefine` 要求 `evidence` 与 `evidenceRefs` 至少一项非空；`evidenceRefs` 加 `.min(1)`。同步 `src/mcp.ts:196` 与 `adapters/dsh/index.mjs:2238` 的 `minLength: 1` 与 `required`——三处不同步会按仓内既有教训换链路复发。
2. `src/memory-policy.ts:64`：去掉 `content.kind === 'memory' &&` 前置条件，改为所有 kind 的 `missing` 一律不自动注入。
3. `src/store.ts:2071`：`norms` 过滤补上 `mayAutomaticallyRecall`（或至少 `support?.status !== 'missing'`）。
4. `src/store.ts:4283-4287`：`approveProposal` 在 `captureSupport` 之后加 `if (support.status === 'missing') throw new DomainError('evidence_required', ...)`。这是"空证据最终变成生效规则"的最后一公里。
5. `src/schema.ts:336`：`eventSchema.summary` 加 `.min(1)`；`src/schema.ts:78` 的 `summary` 同理（若要保留空摘要语义，则改为 `superRefine`：`summary` 空时 `references` 必须有内容）。
6. `src/store.ts:5027`：把"completed 才要 verified"放宽为"`verified` 非空时 `evidenceRefs` 至少一条"，堵住"写了 verified 文字但无任何引用"的中间态。
7. `src/material.ts:114`：`evidence: 'verifiable'` 改为 `'self-reported'`，或按"是否实际抓取过正文"决定。

必须**新增自动取证**、加 required 解决不了的（这三处是结构性缺口，不是校验缺失）：

1. `locator` 存在性核对：`src/evidence.ts:10` 明确不访问文件与网络，所以 `artifact` 路径、`command` 命令、`event` 事件 id 全部是不可核的字符串。需要新增一个只读核对器（文件存在 + 摘要比对、命令可重放并与 `result` 比对、event id 可查），并在 `approveProposal` 与 `prepare` 注入前调用。判据：核对失败的引用应把 `status` 从 `referenced`/`captured` 降为 `missing`，而不是继续算"有证据"。
2. `support.status` 的可信化：`captured` 的判据只有 `!!reference.snapshot?.trim()`（`src/evidence.ts:17`），即任意非空文本（哪怕只写"见上"）都能拿到最高档。`snapshotHash` 由插件自己算（`src/evidence.ts:15` 覆盖调用方传的值，方向正确），但 `snapshot` 内容本身没有任何结构校验，需要在取证时按 `kind` 分别要求最小结构（artifact 需路径+摘要，command 需命令+退出码，event 需可查 id）。
3. `outbox` 载荷的延迟校验：`src/schema.ts:353` 的 `z.record(z.unknown())` 让 evidence 规则在入队时完全失效。要么入队时也跑一次 `proposalSchema`/`eventSchema`，要么在 `replay` 失败时把条目显式标记为"不可重放"，而不是无限重试。

## 五、审计边界

- 只读：未修改 `src/`、`adapters/`、`test/` 任何文件，未连接真实库；本文档是唯一新增文件。
- 未执行 `npm test`；结论全部来自源码阅读，每条均带 `文件:行`。
- 未覆盖：`src/ui.ts`、`src/console*` 的前端提交路径是否另行补字段（它们最终仍走上述 HTTP 路由，故不改变结论）；`desktop-tauri/` 未纳入本次范围。
