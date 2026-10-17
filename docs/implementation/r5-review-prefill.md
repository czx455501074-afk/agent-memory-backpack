# W10：把"模型已经算完、却让人重填"的那一步接上（2026-10-17）

本文件记录一条最小改动：**分析结果已经在库里，采纳路径却让人重新填一遍**。改动把两者接上，并且不让建议越过"必须由人确认"这条线。每条结论都附可核对的 `文件:行号`。

## 一、缺口（一手核过）

| 事实 | 证据 |
|---|---|
| 模型判定存放在 `model_reviews` 表：`proposal_id`（主键）、`project_id`、`result`（JSON）、`updated_at` | `src/maintenance.ts:14`（建表） |
| 写入时机：`model_review` 任务处理时，键为候选 id；`result` = 分析结果 + 候选 payload 的 `inputHash` | `src/maintenance.ts:82`、`src/maintenance.ts:100` |
| 判定内容：`kind`/`scope`/`relation`/`confidence`/`needsSplit`/`suggestedSplit`/`reasoning`/`autoPromotable`，模型路径另加 `summary`；`mode` 区分 `model` 与 `heuristic_only` | `src/model-review.ts:4`（schema）、`src/semantic.ts:374`（启发式产出） |
| 关联键：`proposals.id` ↔ `model_reviews.proposal_id`（作用域列 `project_id`） | `src/maintenance.ts:100`、`src/server.ts:136` |
| 采纳路径要求审核人自带结构化 `entry` | `src/server.ts:462`（`entry: knowledgeSchema`） |
| 读取接口此前只回 `modelReview`，**表单不消费它**：类别硬编码 `kind: 'memory'`，作用域只读候选 payload | 改动前 `src/server.ts:375` 与 `src/ui.ts` 的审批表单（`pe-scope` 唯一下拉、类别无字段） |

结论：**分析算完了，值却停在表里**。审核人每一次采纳都要手填类别、作用域，再核对置信度——这是审核负担里纯粹机械的那一半，也是候选堆积的常见成因。

## 二、改动

**核心（预填的来源与解析）**

- `src/model-review.ts:95` `ReviewPrefill` 类型；`src/model-review.ts:133` `reviewPrefill()`：把 `model_reviews.result` 解析成建议，逐字段校验词汇表，**不合格就返回 `null`（无建议），不编造默认值**；`src/model-review.ts:198` `reviewPrefills()`：一次读多条（列表用精简形态，省掉 `summary`/`reasoning`/拆分计划）。
- `src/server.ts:120` `reviewSuggestions()`：一次查 `model_reviews` + 一次查候选 payload，复算 `inputHash`（与 `src/maintenance.ts:102` 同一算法），用于判断建议所基于的文本是否已变（`stale`）。
- `src/server.ts:136` `reviewSuggestion()`：单条读取同一份逻辑。
- `src/server.ts:396`：`/v1/proposals/list` 的 `flat` 分支，仅在候选项命中判定时追加 `prefill`。
- `src/server.ts:410`：同一端点的 `queue` 分支（面板默认视图），候选项追加**同一份**精简 `prefill`（复用 `reviewSuggestions()`，不另写判定），聚合项不带，并在 `note` 里说明原因。
- `src/server.ts:422`：`/v1/proposals/get` 追加 `prefill`（完整形态：含 `summary`/`reasoning`/`suggestedSplit`/`stale`/`note`）；解析失败的存储行回退为 `awaiting_model`，不再抛错。
- `src/server.ts:462`：`/v1/proposals/approve` 新增**可选**请求字段 `prefillSource`（`model`/`heuristic`）与**条件**响应字段 `prefillNote`；`entry` 仍为必填。

**界面（预填作为默认值）**

- `src/ui.ts:543`：列表项标出"模型建议已就绪 / 规则建议已就绪"。
- `src/ui.ts:616`、`:635`：读取 `detail.prefill`，显示来源、置信度、类别、作用域、关系、`stale` 提示、拆分建议、不可自动升格的理由；无建议时明写"暂无建议：模型与规则分析都没有给出这条候选的判定"。
- `src/ui.ts:662`：新增可编辑的类别下拉 `pe-kind`，默认选中建议类别。
- `src/ui.ts:743`：采纳条目类别取自表单（人是最终值），`provenance` 保持 `user` 并注明理由。
- `src/ui.ts:705`、`:810`：确认按钮带上 `data-prefill`，采纳请求回传 `prefillSource`；回执显示 `prefillNote`。

**没有改动的**：`adapters/**`、`src/store.ts`、`src/retrieval-*.ts`、`src/semantic.ts`。既有字段语义、既有审批门（无 `entry` 必拒）一律不动。

## 三、采纳流程的人工步骤对比

| 字段/动作 | 改前：谁填了什么 | 改后：谁填了什么 |
|---|---|---|
| 类别 `kind` | **人**：从无到有手填，界面固定提交 `memory` | **模型/规则**填默认值（可在下拉里改）→ **人**确认 |
| 作用域 `scope` | **人**：只看候选 payload，自己判断项目/全局 | **模型/规则**给默认选项（`global` 建议会预选并提示）→ **人**确认 |
| 标题 | 人：从 discovery 截 40 字 | 不变（人可改） |
| 正文 | 人：整段确认 | 不变（人可改） |
| 置信度 / 关系 / 拆分建议 | **不可见**：人只能靠读原文猜 | 界面直接显示（含"建议基于提交时的文本，其后有更新"提示） |
| 不可自动升格的理由 | 不可见 | 界面显示（`promotionBlockedReason`），并写明"类别与作用域必须由人确认" |
| 建议是否有权威 | — | 无：`authority: 'advisory'`、`requiresHumanConfirmation: true`；`entry` 缺失时采纳仍 400 |
| 采纳后的 `provenance` | `user`（人确认） | `user`（不变；建议不得改写来源字段，回执如实说明） |

净效果：一次典型采纳从"人重新判定 2 个字段 + 猜 4 项分析结论"变成"看一眼建议、点确认（或改一处）"。

## 四、queue 视图的建议（面板默认视图）

第一版只把建议加在了 `flat` 列表与 `get` 详情上，而**面板默认请求的是 `view: 'queue'`**（`adapters/dsh/index.mjs` 透传 view，`test/dsh-panel-wiring.test.mjs:32` 断言默认必须为 `queue`）。也就是说用户最常打开的那个列表里预填是空的——等于把功能装在最少人走的路上。第二版补齐：

| 项 | 行为 | 证据 |
|---|---|---|
| 候选项（无 `kind` 字段） | 追加精简 `prefill`，与 `flat` 视图**同一份对象**（同一 `reviewSuggestions()` 结果） | `src/server.ts:426`、`:431` |
| 聚合项（`kind: 'aggregate'`） | 不带 `prefill`：它代表同一签名的多次失败事实，不是一个可采纳的候选 | `src/server.ts:431` |
| 为什么缺席 | 追加在响应 `note` 里（保留 store 原有那句只读派生说明），并指出成员建议可在 `/v1/proposals/get` 或扁平列表逐条取到 | `src/server.ts:438` |
| 无判定时 | `prefill` 字段整体缺席（与 flat 一致），不编造 | 测试 ⑤ |
| `store.queueProposals()` | **未改动**，投影里不含 `prefill`（禁止改文件），服务端只在其上追加可选字段 | `test/review-prefill.test.ts` 第 4 条 deepEqual |

**面板默认视图下，一个有模型判定的候选能看到什么**：`items[]` 里该条（无 `kind`，即普通候选）带上 `prefill`——`source: 'model'`、`model` 名、`kind`、`scope`、`relation`、`confidence`、`autoPromotable`、`stale`、`authority: 'advisory'`、`requiresHumanConfirmation: true` 与 `note`；面板据此显示"模型建议已就绪"并能直接把它作为表单默认值。同一列表里的聚合组不带该字段，且列表级 `note` 已写明这是约定而非遗漏。若该候选没有判定，则该字段整体不存在。

## 五、测试证据

```
node --test dist/test/review-prefill.test.js   # 7 项，7 通过
node --test dist/test/retrieval-service.test.js # 10 项，10 通过（deepEqual 契约未破）
```

`test/review-prefill.test.ts` 覆盖：

1. 有模型判定 → `get` 与列表均带回建议，来源标为 `model`，`authority` 仍 `advisory`、`requiresHumanConfirmation` 为真；
2. 无判定 → 响应中**不存在** `prefill` 字段，且列表项与 `store.listProposals()` 的投影 `deepEqual` 逐字段一致；
3. 人只点确认（字段全取自建议）→ 采纳 200，条目 `kind` 与建议一致、`provenance` 为 `user`，回执含 `prefillNote`；
4. 只有建议、没有 `entry` → 采纳仍 400，且不写入任何条目；
5. 规则分析建议标为 `heuristic`（`analysisComplete: false`），候选文本改动后 `stale: true`；
6. 词汇表不符/残缺的存储行不产生建议；界面脚本按建议预填并显示来源与置信度；
7. queue 视图的候选项带回建议，且与 flat 视图 `deepEqual` 同一份；
8. queue 的聚合项按约定不带建议，`note` 说明原因（store 原有那句只读派生说明保留）；
9. 无判定时 queue 候选项同样缺席 `prefill`；
10. queue 视图的改动未触碰 store 层投影：候选项去掉 `prefill` 后与 `store.queueProposals()` 逐字段一致，聚合项完全一致，且 store 投影里不含 `prefill`。

全量基线（本轮交付后实测）：**645 项 / 643 通过 / 0 失败 / 2 跳过**（命令 `npm test`，含 `npm run build`；日志 `.local/w10-full-test-2.log`）。`test/review-prefill.test.ts` 自身 11 项全通过。

## 六、未完成项与风险（不粉饰）

1. **面板侧端到端未验收**：本条线只做了核心与 `ui.ts` 的静态/接口级验证。真实浏览器里的"表单打开即预填、点击确认后回执文案"需要宿主重启后再由人核对（`ui.ts` 服务的是核心自带页面 `/ui`，其脚本以字符串形式随核心发布）。
2. **聚合组本身不带建议**（已按约定处理）：`view: 'queue'` 的折叠组代表同一签名的多次失败事实，不是一个可采纳的候选，因此不附 `prefill`；响应 `note` 已写明这是约定，成员建议可在 `/v1/proposals/get` 或扁平列表逐条取到。候选项在 queue 视图下已能看到建议，面板默认路径不再是空的。
3. **库内没有"本次采纳用了建议"的独立痕迹**：写入 `decision` 的唯一通道在 `store.ts`（禁止改），`schema.ts` 的 `provenance` 只有 `user/external/agent` 三值，且建议不改变来源语义。当前如实性靠三处保证：条目的 `provenance` 仍由确认方决定、采纳响应回执写明建议来源、建议自身 `authority: 'advisory'`。若要留审计痕迹，需由 store 侧在 `decision` 上增加 `prefillSource` 字段（本条线未做）。
4. **`stale` 的判定有已知过报**：候选 payload 因 `request-evidence` 等决定写入而变化时，`inputHash` 随之改变，建议会被标为 `stale`（文本其实没变）。方向是保守的（宁可提示核对），文案已避免断言"文本被改过"。
5. **批量采纳刻意不使用建议**：`programmaticApproval`（批量路径）仍按 `memory` + 项目作用域构建条目。若让批量自动采用建议，就等于没有人工确认的自动升格，与"建议不构成判定"冲突。

## 七、可复现的核对命令

```
git diff --stat src/model-review.ts src/server.ts src/ui.ts
node --test dist/test/review-prefill.test.js
node --test dist/test/retrieval-service.test.js
npm test
```

（本文档不含用户目录绝对路径；真实库路径在其它文档中以 `<USER_HOME>` 记法出现。）
