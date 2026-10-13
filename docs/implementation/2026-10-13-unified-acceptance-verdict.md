# 两端实操测试统一验收结论（Codex 侧 + DSH 侧）

- 日期：2026-10-13，Asia/Shanghai。项目：Agent Memory Backpack（插件 0.1.0-p0.1，源码基线 025d184 + 未提交的 UI 修复）。
- 依据：Codex 侧实操报告、DSH 侧真实使用报告、wincu 最终报告，以及**本结论作者对代码/数据/部署件/测试套件的独立复核**。凡标注「复核」的条目，均由本次直接读取源码、SQLite、日志、部署副本或运行测试得出，不采信模型或报告自述。
- 口径：认定「通过」只针对对应场景与观察范围；未覆盖项一律不通过。报告中相互矛盾的表述，以本次复核到的原始证据为准。

---

## 1. 总体结论

**不能通过全功能验收，当前状态不宜按「已完成」发布。**

- 正常知识检索、跨端共享核心、规则门禁（含离线降级保护）、候选提交与幂等、权限拒绝等**核心能力真实可用**，两端均有真实桌面会话证据。
- 但存在 **1 个阻断级（P1）缺陷**：流程经验的**管理 UI 审批闭环不可用**——用户完成实际工作、提交候选后，无法通过当前页面把「关联完整流程」的候选真正批准生效（浏览器侧 `prompt()` 不可用 + UI 请求契约与核心 `target_mismatch` 校验不匹配，双重原因）。
- 另有若干 P2/P3 缺陷（交接内容缺失、离线回执含糊、同会话不即时重放、核心错误被吞、顶栏陈旧、工具契约易误用、Codex 侧部署副本漂移）。详见第 4 节。

一句话：**功能主体成立，验收闭环未过。阻断点是 F01。**

---

## 2. 两端覆盖对照

| 维度 | Codex 侧 | DSH 侧 | 复核判定 |
|---|---|---|---|
| 部署与冷启动 | 官方 CLI 安装、缓存对齐产物、重启 MCP 服务 | 插件装入 desktop profile、冷启动加载 | 复核：当前 Codex 缓存 scripts 7/7 与仓库一致；DSH 部署 runtime 20/20 与构建一致（见 §3.1） |
| 12 个 AMB 工具 | 全部枚举；wincu 实控真实会话实测 6 项 | 全部枚举；真实会话覆盖检索/读取/提交/历史/备份 | 通过（工具可见性两端均成立） |
| 正常业务闭环 | 读取文件、核对版本、检索、读知识/历史 | 完整交付流程：prepare→search→read_stage→写 delivery.md→读回→提交候选 | DSH 侧通过；Codex 侧为单点工具验证，非完整业务闭环 |
| 规则门禁 | PreToolUse 真实 deny/allow；离线降级放行 | 新规范即时禁止工具；离线被最近快照拦截 | 通过（含 fail-closed 修复后的降级行为） |
| 离线与恢复 | —— | spool 落队 21 条；新会话重放 21→0 | 通过（补偿重放），但同会话不即时重放（F05） |
| 候选幂等/冲突 | —— | 同键同文 duplicate、同键异文 409 | 通过 |
| 权限拒绝 | supersede/structure 返回 403 | 同左 | 通过（拒绝正向写入，未验证正向成功路径） |
| 管理页 | 八入口读取；发现并修复 UI 脚本解析崩溃 | 新增/编辑/归档/导出/离线重连 | 部分通过；F01 审批、F02 顶栏、F09 闭环不足 |
| 发布面一致性 | 缓存/marketplace scripts 与仓库一致（复核 7/7）；runtime 曾整体过期（F24） | 部署件与产物一致 | **复核发现未完全一致**（§3.2，Codex 侧 ui.js 漂移） |

---

## 3. 独立复核：一致性检查（本次亲测）

### 3.1 自动化与产物（与报告一致）

- **`npm test` 现场重跑**：`tests 376 / pass 375 / fail 0 / skipped 1`（跳过项为需要指定产物目录的 package smoke）。与两份报告的数字一致。
- 单独 `package-smoke`（指定 `AMB_ARTIFACT_DIR`）与 `clean-install` 3 项：报告称通过；本次仅核对日志文件存在且内容一致，未重跑（见 §6 未覆盖边界）。
- 最新产物 `artifacts/p0-20261013011520735` 的 `codex-plugin/runtime/ui.js`、`dsh-plugin/runtime/ui.js`、`dist/src/ui.js` 与 artifact-manifest **哈希一致**（`a0c664…`，复核）。

### 3.2 部署件一致性：发现一处**报告未记录的漂移**（新发现）

复核三处 runtime 副本（仓库构建 / DSH 部署 / Codex 缓存 + marketplace）的逐文件 SHA256：

- **19/20 文件三处一致**；**唯一不一致的是 `ui.js`**：
  - 仓库 `dist/src/ui.js`、DSH 部署 `runtime/ui.js`、最新产物：`a0c66430431c…`（**已修复版**，服务出的 `/ui/app.js` 用 `vm.Script` 解析**通过**）。
  - Codex 缓存 `runtime/ui.js` 与 marketplace `runtime/ui.js`：`96c60badcb68…`（**未修复版**，服务出的 `/ui/app.js` 解析**失败** `Invalid or unexpected token`）。
- 根因判定（复核）：`src/ui.ts` 的批量提示换行转义修复**仍在工作区、尚未提交**。该修复已被构建进 `dist` 并部署到 DSH 侧与最新产物，但 **Codex 侧的 marketplace/缓存副本仍停留在这版修复之前的构建**。
- 影响：只要由 **Codex 侧的那份 runtime 启动核心并服务管理页**，`/ui/app.js` 会整段解析失败、页面无法工作。当前**正在运行的核心来自 DSH 部署目录**（复核：47631 监听进程命令行指向 `…\.dsh\plugins\agent-memory-backpack-test-20261013\runtime\cli.js`），故线上 UI 正常——该漂移**目前是潜伏的**，但一旦从 Codex 副本起核即复现。
- 反证 F24 结论的边界：F24 报告称「三处 runtime 20/20 逐文件一致」。**在本次复核时点该结论不成立（19/20）**；F24 的 runtime 同步确已完成，但随后的 UI 修复没有回同步到 Codex 侧。

> 结论：这不是「谁把插件弄坏了」，而是**未提交的 UI 修复未回同步到 Codex 侧部署件**。要么提交并统一重同步，要么明确 Codex 侧不承担 UI 服务。

### 3.3 隔离测试库状态（与 DSH 报告一致）

复核 `.local/dsh-realistic-20261013/data/knowledge.sqlite`：

- `meta.revision = 7`；`knowledge` 含 `realistic-document-flow`、`realistic-project-rule`、`realistic-memory`、`realistic-skill`、`realistic-user-confirmation`、`realistic-deny-history`、`realistic-missing-dependency`（均 active），`realistic-prerequisite` 为 **retired**（与「退役 prerequisite 制造失效依赖」一致）。
- `proposals` 2 条，均为 `workflowId=realistic-document-flow`：`0fd97908…`（approved）、`59954f4e…`（archived）。与 A05/C01 一致。
- `tasks`：`task-ab5e543ce734b7b3` 状态 `in_progress`，`summary/notes` 空，`files/fileStates/related_experiences/related_proposals` 均 `[]`，`verified` 空、`evidence=self-reported`，`session_ids` 含 A、B 两会话。→ **复核确认 F03（交接内容缺失）与 B01（会话绑定正确）**。
- `outbox`：0 行；`events`：196 行。→ 与「重放后清空」一致。

### 3.4 离线与重放时间线（复核插件日志）

`.local/dsh-realistic-20261013/data/amb-plugin.log.jsonl`：

- 03:45、03:54：`outbox.replay`（队列空）。
- 03:57–03:58：核心离线期间大量 `event.delivery_failed → outbox.enqueue_failed → spool.enqueued`，并有 `prepare.degraded`。
- **04:03:14：`spool.delivered` × 21 + `spool.replay replayed=21 remaining=0`** —— 重放发生在**新会话 C** 时。

→ **复核确认 F05**：原 B 会话恢复后未即时重放，直到新会话进入才清空。

### 3.5 会话与工具调用计数（复核）

对三个 `.jsonl` 逐行解码统计：

| 会话 | 记录数 | tool/call | AMB 自动上下文记录 | Task Handoff 记录 |
|---|---|---|---|---|
| A `session-16c30793…` | 152 | 22 | 3（seq 11/87/122） | 0 |
| B `session-648be0f0…` | 120 | 15 | 6（seq 7/12/25/105/108/115） | 6（同序号，全部重复同一 handoff） |
| C `session-f7cf3db8…` | 47 | 5 | 1（seq 11） | 0 |

合计 42 次 `tool/call`，与报告「42 次实际工具调用」一致。A 的 3 条注入（每轮一次）亦与「A1 单条、知识变更后重新注入」相符。

---

## 4. 缺陷汇总（合并两端，按优先级）

### P1 · 阻断

**F01 流程经验的管理 UI 审批闭环不可用（DSH 侧）**
- 复核确认两点，二者独立且都成立：
  1. **运行环境**：内置浏览器 `prompt()` 不受支持，`action-approve` handler（`src/ui.ts:839`）在 `prompt()` 处中断（报告称 app.js 报 `prompt() is not supported`）。
  2. **契约不匹配（源码级确认）**：UI 固定 `entry.id = 候选UUID`、`kind='memory'`、`baseRevision=0`；而核心对带 `workflowId` 的候选要求 `entry.id === workflowId`，否则 `target_mismatch` 409（`src/store.ts` 的 approve 分支）。`fixture-api-actions.jsonl` 记录了同一候选「错误目标 ID → 409 target_mismatch；改为完整流程 ID + 正确 revision → 200」的对照。
- 影响：**用户真实提交的流程经验无法在页面完成审核闭环**，直接卡住「提交→审核→生效→下一轮读到」的主路径。
- 建议：改为页面表单（显示目标流程与现版本），审核完整流程变更；冲突时保留内容并可重载/合并；错误目标不得退化为把候选 UUID 批准成无关 memory。

### P2 · 结果易误解 / 接续不足 / 诊断困难

- **F02 顶栏知识版本长期陈旧**（DSH）。复核确认 **代码路径**：`renderStatus()` 才写 `t-revision`，而知识写入成功回调只调用 `renderManage()`（`src/ui.ts:809-813`），不刷新顶栏。桌面刷新/重连也不更新。
- **F03 任务接续缺少有效交接内容且重复注入**（DSH）。§3.3 复核确认 DB 中交接字段全空。事件只写通用 `tool/call`，无法据此恢复具体工具与结果。**本次复核发现重复比报告更严重**：B 会话同一 `task-ab5e543ce734b7b3` 的 `[Task Handoff]` 在 seq 7/12/25/105/108/115 **共 6 条**，正文均为 `Status: in_progress / Files: 未记录 / Important: 无`，无 summary、无进度、无证据。
- **F04 离线回执与正式接收难区分**（DSH）。复核代码：离线 `amb_submit_experience` 返回 `state:'pending', duplicate:false`（`adapters/dsh/index.mjs`），与在线待审同形，无 `queued/local/同步状态`。
- **F05 恢复后原会话不即时重放**（DSH）。§3.4 复核确认；根因 `index.mjs` 的 `replayedSessions` 每会话仅首次进入回放。
- **F06 适配器吞掉可执行的核心错误原因**（两端）。复核 `adapters/dsh/core-client.mjs:96`：非 2xx 一律 `core returned HTTP ${status}`；直接请求可拿到 `code=dependency_unavailable` 与缺失 ID。
- **F07 离线 UI 防护描述与真实 LocalGuarded 行为矛盾**（DSH）。UI 将离线笼统描述为 Ungoverned／防护失效，而实际 history 被最近快照拦截。
- **F08 DSH `amb_prepare` 契约易误用**（DSH）。复核 `index.mjs:546`：`parameters = EMPTY_OBJECT_INPUT`，`execute` 忽略入参、不按 query 检索；回执 `contextUnchanged` 语义含糊。
- **F22/F24（Codex 侧，已修复，复核部署态）**：核心离线时 fail-closed 锁死一切工具；根因是 Codex 侧 runtime/hook 副本整体过期。**复核**：缓存 scripts 7/7 与仓库字节一致，`hook.mjs` 现含「不可达→降级放行、快照禁令仍拦截」逻辑（`hook.mjs:734-759`）。→ 修复到位，**但见 §3.2 的 ui.js 回同步缺口**。

### P3 · 易用性 / 可观测性

- **F09 管理界面闭环与导出不足**（DSH）：复核 `src/ui.ts` 状态筛选仅 `pending/needs_evidence/archived/rejected`，**无 `approved`**；有批量批准 handler 但 pending 页无对应按钮；归档无恢复入口；JSON/Markdown 仅预览不下载；UI 本地时间与 Markdown UTC 混用；非 current 的 `@1` 正文读取被拒（B04 正确拒绝，但缺独立只读历史查看）；离线引导命令未说明数据目录与运行时。
- **Codex 侧卸载**：`amb-uninstall.mjs` 只覆盖工作区级 `.codex/config.toml`，用户级 `$CODEX_HOME/config.toml` 安装无脚本支持。
- **H3（Codex MCP 不校验会话 cwd）/ M2（跨端去重按精确文本）**：均为**已裁定的「不做」**，理由与代价已记录（协议下无正确实现；宁可重复不可错合并），并写明重新评估条件。属**已知限制**，不计缺陷。

---

## 5. 被复核否定的「疑似缺陷」与保护性行为（非缺陷）

1. 项目外 marker 检索为空、旧 revision `@1` 409、失效依赖阻断、禁止工具、同键异文 409 —— 均为**正确保护**。
2. 离线候选最终只创建 1 条、重放清空 21 条 —— 无「离线经验丢失」证据，问题是**延迟与状态含糊**（F04/F05）。
3. 顶栏陈旧 ≠ 数据库陈旧：DSH 已真实读到新版。交付文件仍旧日期是 B 轮只诊断未改写，非 UI 写错。
4. fixture 首次因漏 `x-amb-protocol` 得 426、查询已清空 spool 得 ENOENT —— **探针错误**，非产品缺陷。
5. 「正文乱码/4.44MB 检索」等**模型自述**不被原始回执支持，不落为缺陷。
6. `prompt()` 不可用是**特定内置浏览器边界**，未据此断言所有外部浏览器均失败。

---

## 6. 未覆盖 / 不可外推边界

- 外部 Chrome/Edge 中的审批点击；原会话工具在停用后清理与冷启动停用验证；跨工作区范围退出；材料 TTL/续期/清除；永久删除与完整恢复覆盖；批量拒绝/补证；多客户端并发修订；长对话压缩、取消/崩溃中断；升级/降级回滚与长时间稳定性。
- 本次**未重跑** Codex 实时会话（wincu 结论沿用其自证），未重跑 `clean-install`/`acceptance`/`package-smoke`（仅核对日志）。
- **未打开** UI 截图逐张目视核验；浏览器 `prompt()` 失败为环境事实，非本次复现。
- 本结论**不证明**：真实两桌面同时同库读写、边界/压力、备份恢复演练、以及 §3.2 漂移在从 Codex 副本起核时的完整表现。

---

## 7. 建议的收尾顺序

1. **F01**（P1）审批闭环 —— 唯一阻断点，先修并做真实回归（UI 完成 pending→流程新 revision→DSH 下一轮读到）。
2. **§3.2** 提交并统一重同步两端部署件（至少回同步 Codex 侧 `runtime/ui.js`），或显式声明 Codex 侧不服务 UI。
3. **F03** 有效交接（可信文件路径/进度/证据/未完成项，并自动携带 taskId 关联候选）。
4. **F04/F05** 离线回执明确 `receiptSource/deliveryState`，支持同会话受控重放。
5. **F06** 透传结构化错误；**F02/F07** UI 状态与防护描述；**F08** 工具契约；**F09** 易用性。
6. 回归须用本报告同一 fixture 与真实 DSH 用户操作，**不能只更新单测断言**。

---

## 8. 证据索引

- DSH 真实使用报告：`docs/implementation/2026-10-13-dsh-realistic-full-operational-test.md`
- Codex 桌面实操记录：`docs/implementation/2026-10-13-codex-dsh-desktop-operational-test.md`
- wincu 最终报告及 F22/F24/H3M2：`docs/implementation/2026-10-13-wincu-final-report.md` 等
- 本次复核新增探针（只读，位于隔离证据目录）：`.local/dsh-realistic-20261013/probe-ui-evaluated.mjs`、`probe-db.mjs`、`probe-db2.mjs`
- 关键证据：`.local/dsh-realistic-20261013/data/amb-plugin.log.jsonl`（重放 21→0）、`…/data/knowledge.sqlite`（revision 7、proposal 状态、task 交接空）、`…/fixture-api-actions.jsonl`（target_mismatch→200 对照）
- 部署副本哈希：仓库 `dist/src/ui.js` = DSH 部署 = 最新产物 = `a0c664…`；Codex 缓存 = marketplace = `96c60bad…`（未修复版）
