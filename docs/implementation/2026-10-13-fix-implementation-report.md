# 统一验收结论修复实施报告（2026-10-13 后续）

- 日期：2026-10-13，Asia/Shanghai。项目：Agent Memory Backpack（0.1.0-p0.1）。
- 依据：《两端实操测试统一验收结论（Codex 侧 + DSH 侧）》（`docs/implementation/2026-10-13-unified-acceptance-verdict.md`）与其中引用的两端报告。
- 口径：本报告只记录**实际改动、实际命令、实际结果**。凡「复核」为本次直接读取源码/运行得到；引用前报告的结论均标注来源。

---

## 1. 结论

验收结论列出的阻断点与主要缺陷已全部处理，并用测试 + 真实浏览器回归（Chrome 155 + 内置浏览器）核实：

| 缺陷 | 级别 | 状态 | 核实方式 |
|---|---|---|---|
| F01 流程经验管理 UI 审批闭环不可用 | P1 阻断 | **已修复** | 单元契约测试 + 真实 Chrome 端到端（见 §3.1） |
| §3.2 部署件漂移（Codex 侧 ui.js 未回同步） | P1 隐患 | **已修复** | 三处 runtime 逐文件哈希 0 漂移 + 从 Codex 副本起核验证 |
| F02 顶栏知识版本陈旧 | P2 | **已修复** | 契约测试（含调用点断言）+ Chrome：写入后顶栏 1→2 |
| F03 交接缺少有效内容且重复注入 | P2 | **已修复（三轮复核整改）** | 真实事件形状测试 + 9 步重复注入反例 + 跨任务泄漏反例回归 |
| F04 离线回执与正式接收难区分 | P2 | **已修复** | 回执新增 `receiptSource/deliveryState` + 测试 |
| F05 恢复后原会话不即时重放 | P2 | **已修复** | 改为「不可达→可达」受控重放 + 测试 |
| F06 适配器吞掉核心错误原因 | P2 | **已修复（两端均有测试）** | 两端透传 `code/message/retryable` + 双端测试 |
| F07 离线 UI 防护描述矛盾 | P2 | **已修复** | UI 文案按真实快照行为改写 |
| F08 `amb_prepare` 契约易误用 | P2 | **已修复** | 文档/契约/实现统一支持 `query` + 测试 |
| F09 管理界面闭环与导出不足 | P3 | **已修复** | approved 筛选/归档恢复/下载/时区/只读历史 + Chrome |

自动化：`npm test` → **tests 386 / pass 385 / fail 0 / skipped 1**（跳过项为需指定产物目录的 package smoke）。相比修复前（376 项）新增 10 项回归测试（其中 5 项在真实 DSH 运行时下执行）。

一句话：**F01 阻断点已闭环，两端部署件已一致，P2/P3 已按结论建议逐项落地并完成三轮独立复核整改。**

---

## 2. 改动清单（按文件）

源码基线：`025d184` + 之前未提交的 UI 换行转义修复。本次在其上继续。

### 2.1 核心（`src/`）

- **`src/store.ts`**
  - 新增 `getProposal(id, projectId)`：返回候选详情与**解析后的目标**（workflowId、候选基线 `baseRevision`、目标当前 `currentRevision`、可编辑的流程条目本体、`available/reason`）。F01 的根因是页面只有候选 UUID，而核心要求流程候选的 entry.id === workflowId；详情端点让页面能拿到正确目标。
  - 新增 `reopenProposal(id, ...)`：把 `archived/rejected/expired` 候选放回 `pending`（重新开启 30 天审阅期，保留记录与历史）。`approved` 不可重开——它已改变库，重开会撕裂决策历史。
  - `listProposals` 每行新增 `discovery` 与 `decision` 字段，审核页无需再解析原始 payload。
  - `getProposal.target.currentRevision` 用 `head.revision`（条目当前版本），而非内容里的 `baseRevision`（少 1），避免「当前 v0」这类误报。
  - 新增 `readRevision(id, revision, projectId)`：**只读**返回某历史修订正文，作用域规则同 `history`。它不削弱 `read/get` 对旧 `@revision` 的 409 校验。
  - `history()` 返回值新增 `revisionReadHint`。
  - `exportTask` 的 Markdown 增加「时区」行，明确文件时间为 UTC。
- **`src/server.ts`**
  - 新增管理端点：`/v1/proposals/get`（候选详情）、`/v1/proposals/reopen`（重开）、`/v1/knowledge/history/read`（历史只读）。
  - `ADMIN_ONLY` 集合加入 `/v1/proposals/get`、`/v1/proposals/reopen`。`/v1/knowledge/history/read` 沿用原有项目作用域校验（历史读取是受作用域约束的只读操作，不是管理写入）。
- **`src/ui.ts`**（改动最大）
  - **F01**：删除审批用的 `window.prompt()`；新增页面内审批表单 `showProposalEditor()` + `buildApprovalEntry()`：显示目标流程、候选基线版本与当前版本，允许编辑正文或整段流程 JSON，正确设置 `entry.scope`、`baseRevision` 与 `allowGlobalScope`。批量批准改为逐个解析目标后构造 entry（原来一律写成无关 `memory`，正是 `target_mismatch` 的形态）。其余 `prompt()`（补证理由、续期理由）同样改为页面内表单。
  - **F02**：新增 `refreshHeader()`；知识写入、删除、批准、批量批准成功后调用，顶栏版本随数据即时更新。`show()` 返回 Promise，支持「历史」按钮跳转后自动查询。
  - **F07**：离线/自检文案按真实快照行为改写——只读快照仍执行已记录禁止，未记录判断才是未知边界；不再笼统宣称「所有防护失效」。
  - **F09**：候选筛选新增 `approved`；归档/拒收/过期候选新增「重新开启审阅」；导出新增 `downloadText()` 下载按钮（并标注预览时间为 UTC）；历史页每个修订可「只读查看此版本」；所有时间改用 `localTime()`（带 `UTC±HH:MM` 偏移）；管理表格加「历史」按钮；离线引导命令说明运行时目录与数据目录。
  - 修复过程中自身踩坑并固化：新增注释里含反引号会截断模板字符串导致 `/ui/app.js` 解析失败——这正是验收结论 §3.2 的症状；现已用 `node --check` 对导出的 `UI_JS` 单独校验，并在 `test/web-ui.test.ts` 固化。

### 2.2 适配器（`adapters/`）

- **`adapters/dsh/core-client.mjs`（F06）**：非 2xx 时读取核心 JSON body，抛出带 `code` / `coreStatus` / `coreBody` / `retryable` 的错误，消息保留 `HTTP <status>` 前缀并附 `[code] message`。
- **`adapters/codex/scripts/hook.mjs`（F06）**：同样的结构化错误透传。
- **`adapters/dsh/index.mjs`**
  - **F04**：`amb_submit_experience` 回执区分来源——核心受理：`receiptSource:'core'`，`deliveryState:'delivered'`，`serverProposalId`；落 outbox：`'outbox'/'queued'`；仅写本地 spool：`'local'/'queued-local'`（或写入失败 `'local-unsynced'`），并带 `lastError` 与明确 note。
  - **F05**：以会话为单位记录 `{ firstEntryDone, degraded }`；首次进入尝试一次重放；此后仅在 prepare **由失败转成功**（不可达→可达）时做一次受控重放；重放失败会把 `degraded` 置位、由下一次成功 prepare 触发，避免每轮重试。
  - **F03**：交接块新增 `Progress:` 行与 `Candidates:` 行；`lastSessionProgress()` 按真实 DSH 事件形状（`tool/result` 的 `toolCallId` 与 `tool/call` 的 `callId` 配对）提取最近工具名与输出；`harvestSessionFiles()` 仅保留项目内路径（写入目标优先）。同一交接**按（会话, 任务）只注入一次**；**按步分段（cohort）**：每步只消费「自上次消费以来」的新事件并推进 `cursor`，任务切换后的首批事件自然归入新任务，旧任务的工具调用不可能进入新任务的 cohort（窗口收缩时游标同步回退）。任务写回带迟滞：只有本会话真正新增文件/候选/进度时才写 `files/notes/relatedProposals`，空闲步骤不再反复刷新任务。
  - **F08**：`amb_prepare` schema 声明 `query`/`taskId` 并真实转发；文档说明「按任务检索请传 query」。
  - 会话状态整体收敛到 `getSessionState(id)`（无插件级共享缓冲）：重放、事件窗、文件累加、进度、候选绑定全部按会话保存。
- 说明：会话事件在真实宿主中**不带任务标签**（复核确认），因此任务归属由 `agent/pre-step` 的 header.taskId 提供、文件分段由步边界（cohort）保证，而非依赖事件标签。

### 2.3 测试（`test/`）

- `test/web-ui.test.ts`：断言服务出的 `/ui/app.js` 能被 `vm.Script` 解析（把 §3.2 症状固化为回归）。
- `test/ui-management-verification.test.ts`：新增 F01 审批契约（目标不匹配 409 / 按目标流程批准生成新 revision）、F02 顶栏刷新契约（断言 `refreshHeader` 确实挂到 write/delete/approve/batch 四条路径）、F09 归档重开 + 历史只读、F01/F09 界面特征（无 `prompt()`、含表单/approved/重开/下载）。
- `test/r2-adapter-outbox.test.mjs`：新增 F05 受控重放、F06 结构化错误、F08 prepare query、F03 交接内容与单次注入（真实事件形状 + 9 步活动反例）、F03-crosstask 跨任务泄漏反例（未打标事件、经 header.taskId 切任务）；并断言 F04 离线回执字段。
- `test/codex-hook.test.mjs`：新增 Codex 侧 F06（结构化 409 的 code/message 进入适配器日志，不再只剩 HTTP 状态）。

---

## 2.4 独立复核与整改记录

本次委派了独立子代理对修复做对抗性复核（不与实现共享结论，直接读源码/跑命令）。三轮复核发现并已整改：

1. **F03 重复注入未真正修复（反例：9 个活动步骤 → 9 次注入）**。根因：ack 键包含「最近工具输出」，活跃会话每步都变。整改：改为按（会话, 任务）一次性注入 + 任务写回迟滞；新增 9 步反例回归。
2. **F03 `Progress:` 行在实际 DSH 数据上是死代码**。根因：真实 `tool/result` 事件没有 `data.name`。整改：按 `callId/toolCallId` 配对提取；新增真实形状测试（断言注入文本含 `Progress: … <工具名>`）。
3. **Codex 侧 F06 无测试**。整改：新增 `codex-hook` F06 测试。
4. **F02 测试只查函数名存在**。整改：断言四条写入路径均调用 `refreshHeader()`。
5. **跨任务文件泄漏（第二轮复核）**：同一会话先 task-A 后 task-B 时，`a-only.md` 出现在 task-B 的记录与交接里。根因：文件累加器按会话而非按（会话, 任务）保存。
6. **打标方案在真实宿主流为死代码（第三轮复核）**：复核指出真实 DSH 会话事件不携带任务标签，基于事件标签的过滤无效，未打标时反例仍复现。最终改为**按步分段（cohort）**：缓冲仍存原始未打标事件，`agent/pre-step` 每次只消费「自上次消费以来」的新事件并推进 `cursor`；任务切换后的首批事件自然归入新任务 cohort，旧任务调用不可能进入新任务。第三轮复核：原反例与 A–E 五组逆向变体（切换前后事件、空闲步、切回原任务、>400 事件窗口滑动、双会话）均无泄漏；真实核心端到端一致。仅保留一项理论边界：分段依赖步边界，若宿主在 B 的任何 pre-step 之前就为 B 发工具事件且 A 未消费完，理论会归入 A；通过适配器自身的事件/步契约构造不出该顺序（未观察到）。

其余复核结论（F01 契约、§3.2 零漂移、F04/F05/F06(DSH)/F08、F07、F09、安全扫描）均为通过；复核另提示 `/v1/knowledge/history/read` 目前对适配器凭据可见（只读、永不返回可用的当前句柄）。该项属有意保留：它与 `/v1/knowledge/history` 同级、受项目作用域约束，供启用历史追溯；若后续要收紧为仅管理凭据，评审判定应记录在案。

---

## 3. 实操回归证据

### 3.1 F01 审批闭环（真实 Chrome，关闭「未覆盖：外部 Chrome 审批」边界）

脚本：`.local/_chrome_ui_e2e.mjs`（Node 24 内置 `WebSocket` 直连 Chrome DevTools Protocol，无第三方依赖）。步骤：从 fixture 种子起一个隔离核心 → 提交一个指向 `realistic-document-flow@1` 的候选 → Chrome 打开 `http://127.0.0.1:<port>/ui#<token>` → 点「候选审阅」→ 点「批准生效」（弹页面表单）→ 点「批准并生效」。

观测结果：

```
header revision before (page): 1
candidate card rendered: true
approval form rendered: true
form target line: 目标流程：realistic-document-flow（候选基于 v1，当前 v1）
header revision after (page): 2
server revision: 2 | approved proposals: 1 | flow revision: 2
```

- 表单在**无 `prompt()` 依赖**下渲染，目标流程与版本正确。
- 批准成功：核心知识版本 1→2，流程条目 revision 1→2，`approved` 候选 1 条；**顶栏同步 1→2**（F01 + F02 同时成立）。
- 证据截图：`.local/ui-regression-20261013/chrome-approval-form.png`、`chrome-after-approve.png`。
- 同一 fixture 的 API 层复核（`.local/_ui_regression.mjs` / `_ui_regression2.mjs`）：旧 UI 形态（entry.id=候选 UUID、kind=memory）→ **409 `target_mismatch`**；新形态（entry=目标流程、baseRevision=候选基线）→ 200，流程 `realistic-document-flow@2 → @3`；用 **DSH 凭据** `prepare(query)` 下一轮返回 `realistic-document-flow@3`，`expand(deliver)` 的 instructions 含已批准经验文本——证明「提交→审核→生效→下一轮读到」整链闭环。

### 3.2 §3.2 部署件一致性

`.local/_deploy_diff.mjs` 逐文件 SHA256 比对结果（修复后）：

```
dsh-runtime (20 files) drift: 0
codex-cache-runtime (20 files) drift: 0
codex-market-runtime (20 files) drift: 0
market-scripts (7 files) drift: 0
cache-scripts (7 files) drift: 0
```

DSH 插件根目录 `index.mjs`/`core-client.mjs` 也已同步（复核双向比对：三处 runtime 20/20、两处 scripts 7/7、DSH 根 11/11，均无多余/缺失文件）。随后**从 Codex 缓存副本**启动核心（`.local/_verify_codex_ui.mjs`）：

```
core (from Codex cache copy) healthy: true
/ui status 200 text/html; charset=utf-8
served /ui/app.js parse verdict: PARSES OK
```

即验收结论担心的「一旦从 Codex 副本起核，`/ui/app.js` 整段解析失败」已不复现。同步前已把三处副本备份到 `.local/deploy-resync-backup-20261013175810/`（89 个文件）。

### 3.3 F09 管理界面（真实 Chrome）

脚本：`.local/_chrome_f09_e2e.mjs`。结果：

```
archived filter shows 重新开启 entry: true
approved filter option present: true
archived before: 1 | pending after reopen: 1
history view lists revision buttons: true
historical revision body rendered: true | has 非当前: true
```

证据截图：`.local/ui-regression-20261013/chrome-history-revision.png`（历史页 v1 只读正文 + 当前版本标注 + 带偏移时间）。

### 3.4 自动化

```
npm run build   # 通过
npm test        # tests 386 / pass 385 / fail 0 / skipped 1
```

新增回归测试实跑（非跳过）：`node --test --test-name-pattern="F0" dist/test/*.test.js`、`node --test test/r2-adapter-outbox.test.mjs`（9/9）、`node --test test/codex-hook.test.mjs`（17/17）→ 相关 F01/F02/F03/F05/F06/F08/F09 项全部 `✔`。

---

## 4. 与验收结论「建议收尾顺序」的对照

1. **F01（P1）** —— 已修并做真实回归（Chrome 完成 pending→流程新 revision→DSH 下一轮读到）。✔
2. **§3.2 提交并统一重同步两端部署件** —— 已重同步三处 runtime/scripts 并验证 0 漂移。✔
3. **F03 有效交接** —— 已提取可信文件路径/进度并自动携带 taskId 关联候选；单次注入与跨任务隔离经三轮复核。✔
4. **F04/F05 离线回执与受控重放** —— 已加 `receiptSource/deliveryState`，重放按可达性转换触发。✔
5. **F06 结构化错误；F02/F07 UI 状态；F08 工具契约；F09 易用性** —— 逐项落地。✔

---

## 5. 未做的取舍与已知边界

- **未提交 Git / 未发布插件**：与既有「本地验证、不发布」一致；本次同样只在工作区与本地部署件生效。验收结论要求的「回归须用同一 fixture 与真实 DSH 用户操作，不能只更新单测断言」已用真实 Chrome + API 双路径满足。
- **`/v1/knowledge/history/read` 未设为 admin-only**：它是受项目作用域约束的只读查询，与 `/v1/knowledge/history` 同级；管理写入类端点（get/reopen/approve 等）才是 admin-only。复核已提示该取舍，保留在案。
- **F05 重放为「事件驱动」而非定时**：依赖 prepare 的可达性转换，足够覆盖「恢复后不换聊天」的验收场景；若核心恢复后用户完全不发新消息，仍不会主动重放（符合「避免每轮无节制重试」的取向）。
- **F03 文件提取基于工具调用的 `arguments`**：只取路径形 token 且限定项目根内；无法覆盖模型用非常规参数名传路径的情形（此时退回「未记录」，不臆造）。
- **F03 理论边界**：任务分段依赖「任务切换后先有 pre-step 再有后续事件」的顺序；通过适配器自身的契约构造不出违例顺序（未观察到），记录在案。
- **未覆盖项（沿用验收结论边界）**：永久删除与完整恢复演练、多客户端并发修订、长对话压缩/崩溃中断、升级回滚与长时间稳定性、材料 TTL 完整流程。
- 本报告不证明：真实两桌面同时同库读写、边界/压力。

## 6. 证据索引

- Chrome 端到端脚本与截图：`.local/_chrome_ui_e2e.mjs`、`.local/_chrome_f09_e2e.mjs`、`.local/ui-regression-20261013/*.png`。
- API 层闭环：`.local/_ui_regression.mjs`、`.local/_ui_regression2.mjs`。
- 部署一致性：`.local/_deploy_diff.mjs`、`.local/_deploy_sync.mjs`、`.local/_verify_codex_ui.mjs`；同步前备份 `.local/deploy-resync-backup-20261013175810/`。
- 独立复核探针（复核方留存）：`.local/_probe_*.mjs`、`.local/_verify_*.mjs`。
- 冻结修订哈希（SHA256 前 12 位，三轮复核整改后）：`dist/src/ui.js=45e10508258a`、`dist/src/store.js=109531711ebc`、`dist/src/server.js=0e09abc461e6`、`adapters/dsh/index.mjs=2708d0700d0b`、`adapters/dsh/core-client.mjs=f7b30235fd83`、`adapters/codex/scripts/hook.mjs=fa82d431338c`。
- 独立复核（对抗性，独立子代理）：本会话委派，三轮逐条复核本报告声明；发现并促成本报告 §2.4 的 6 项整改。