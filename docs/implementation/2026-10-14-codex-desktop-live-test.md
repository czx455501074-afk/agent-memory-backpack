# Codex 桌面版 AMB 插件实机测试与缺陷排查报告（2026-10-14）

测试对象：Agent Memory Backpack（AMB）插件在 Codex 桌面版（Windows 宿主）中的端到端集成。  
测试环境：Windows 11 x64、Codex 桌面版（ChatGPT / Codex desktop，主进程 PID 21580）、当前测试目标工作区 `D:\huange-skill`。  
辅助工具：`dsh-computer-use-win`（UI 自动化与观察）。测试判定均基于真实 UI 截图、桌面模型回执、本地诊断落盘与底层 SQLite 独立只读读回。

---

## 1. 测试范围与原则

1. **真实宿主环境验证**：验证 Codex 桌面版运行状态、项目工作区绑定、新建专用测试会话、插件自动注入与可用工具集合。
2. **只读诊断工具链**：逐项调用 `amb_self_check`、`amb_prepare`、`amb_search_workflows`、`amb_search_universal`、`amb_read_knowledge`；对无数据路径不误判为通过，用明显无效的 workflow/stage 验证负向门禁回执。
3. **经验候选写入与幂等测试**：使用唯一幂等键 `AMB-TEST-20261014-CODEX-01`，明确标注“Codex 桌面实测候选”，记录首次回执；用完全相同参数原样重试，核对幂等与重复标记；独立读回数据库核实仍为待审 `pending`。严禁批准、采纳、结构化、supersede 或修改既有知识。
4. **管理界面与生命周期**：核对 Codex UI 内部是否存在管理面板；执行可逆的插件禁用与重新启用测试，确认最终恢复状态，不重启宿主或核心服务。
5. **证据划分严格性**：明确区分实测数据、已有自动化证据、推断与未验证项，不推断未测项目。

---

## 2. 测试执行过程与实机证据

### 2.1 Codex 桌面端环境与工作区绑定

- **运行状态检查**：
  - Windows 系统窗口中检测到 Codex 桌面窗口（HWND 460818，PID 21580，类名 `Chrome_WidgetWin_1`），处于活跃运行状态。
  - 侧边栏与主界面明确显示当前绑定的项目工作区为 `huange-skill`（界面提示文案：“你想让我们在 huange-skill 中构建什么？”及项目目录树）。
- **新建测试会话**：
  - 点击“新聊天”，成功创建专用测试会话（会话标题自动归档为“盘点注入上下文与工具”）。
- **自动上下文注入与工具可用性**：
  - Codex 会话启动时，模型回显明确记录：“正在读取 Agent Memory Backpack 技能”、“已使用 Amb 集成加载了工具已检查用量”。
  - 暴露给 Codex 会话的完整工具命名空间为 `mcp__amb__*`，包含 12 个专用工具（`mcp__amb__amb_self_check`、`mcp__amb__amb_prepare`、`mcp__amb__amb_search_workflows`、`mcp__amb__amb_search_universal`、`mcp__amb__amb_read_knowledge`、`mcp__amb__amb_read_stage`、`mcp__amb__amb_submit_experience` 等）。

### 2.2 AMB 核心只读接口调用与门禁实测

在会话中引导模型执行完整只读诊断调用，并将原始回执完整保存至本地诊断文件 `D:\huange-skill\docs\diagnostics\2026-10-14-amb\amb-raw-receipts.json`：

1. **`mcp__amb__amb_self_check`**：
   - 参数：`{}`
   - 原始回执：
     ```json
     {
       "ok": true,
       "checks": [
         {"id": "project-scope", "status": "pass", "detail": "凭据绑定项目 p0-workflow"},
         {"id": "credential-shape", "status": "pass", "detail": "已配置凭据（64 characters; value not printed）"},
         {"id": "version", "status": "pass", "detail": "插件 0.1.0-p0.1，Node 24.19.0，平台 win32"},
         {"id": "core-reachable", "status": "pass", "detail": "核心回应正常（33ms）"},
         {"id": "protocol-match", "status": "pass", "detail": "协议 v1，运行状态 Managed"},
         {"id": "knowledge-state", "status": "pass", "detail": "知识版本 2"},
         {"id": "credentials", "status": "pass", "detail": "凭据仅用于本地核心请求，不写入日志、不作为工具结果返回"}
       ],
       "versions": {"plugin": "0.1.0-p0.1", "node": "24.19.0", "platform": "win32"},
       "note": "自检未发现阻塞问题。"
     }
     ```
   - 判定：**通过**（实测）。各检查项全部 pass，凭据脱敏保护有效。

2. **`mcp__amb__amb_prepare`**：
   - 参数：`{"query": "流程与检查"}`
   - 原始回执：`protocolVersion=1`, `knowledgeRevision=2`, `mode="Managed"`, `norms=[]`, `workflows=[]`, 召回 5 条匹配未结构化技能。
   - 判定：**通过**（实测）。query 正常接收并执行召回。

3. **`mcp__amb__amb_search_workflows`**：
   - 参数：`{"query": "流程与检查"}`
   - 原始回执：`{"workflows": [], "knowledgeRevision": 2}`
   - 判定：**通过**（实测）。知识库当前无结构化工作流，如实返回空列表。

4. **`mcp__amb__amb_search_universal`**：
   - 参数：`{"query": "流程与检查"}`
   - 原始回执：返回包含全局技能与规范的匹配集合，文本量约 244 万字符（在 Codex 界面触发代码块截断，后分块完整写入诊断文件）。
   - 判定：**通过**（实测）。

5. **`mcp__amb__amb_read_knowledge`**：
   - 参数：`{"knowledgeId": "skill:577a28b2850ada49", "includeLeaves": false}`
   - 原始回执：成功返回技能 `skill:577a28b2850ada49` 正文，title 为“技能调度入口”，revision 为 1。
   - 判定：**通过**（实测）。

6. **`mcp__amb__amb_read_stage` 负向门禁测试**：
   - 参数：`{"workflowId": "__invalid_workflow_diagnostic_20261014__", "stageId": "__invalid_stage_diagnostic_20261014__"}`
   - 原始回执：
     ```json
     {
       "content": [
         {
           "type": "text",
           "text": "Agent Memory Backpack request rejected (404, not_found): Workflow is unavailable"
         }
       ],
       "isError": true
     }
     ```
   - 判定：**负向门禁通过，成功路径未验证**。因当前知识库尚无结构化工作流，不存在合法的真实 workflowId/stageId，成功读取路径保持“未验证”；负向 404 错误返回符合预期。

---

### 2.3 测试候选写入、同参幂等重试与独立底层读回

测试目标：验证在 Codex 桌面端向 AMB 核心提交候选经验时的审核门禁、重复提交识别与幂等处理。

1. **首次提交调用**：
   - 工具：`mcp__amb__amb_submit_experience`
   - 参数：
     ```json
     {
       "idempotencyKey": "AMB-TEST-20261014-CODEX-01",
       "discovery": "Codex 桌面实测候选：2026-10-14 端到端写入与幂等测试",
       "baseRevision": 2
     }
     ```
   - 原始回执：
     ```json
     {
       "id": "c1b8d565-0767-472a-8271-03f3be2fa14a",
       "state": "pending",
       "duplicate": false,
       "review": {
         "tier": "review",
         "reason": "证据不足：设计规定\"证据不足时不勉强写入正式知识\"",
         "constraint": "自述与无核验内容不得作为已验证证据；只能保留候选或要求补证"
       },
       "attribution": {
         "workflowId": null,
         "stageId": null,
         "resolved": false
       },
       "note": "本条候选未标注归属流程，已按未归属保存，请人工确认它应归属哪个流程/步骤。"
     }
     ```
   - 判定：首次提交成功，`id` 分配，`state=pending`，`duplicate=false`，触发证据不足审查保留门禁。

2. **完全相同参数重试调用**：
   - 参数：原样相同。
   - 原始回执：
     ```json
     {
       "id": "c1b8d565-0767-472a-8271-03f3be2fa14a",
       "state": "pending",
       "duplicate": true
     }
     ```
   - 判定：幂等去重生效，返回相同的 `id`，`duplicate=true`，状态维持 `pending`。

3. **独立数据库只读核验**：
   - 为避免通过当前会话自述产生假阳性，在宿主环境直接以只读方式查询本地 SQLite 数据库文件 `<USER_HOME>\.agent-memory-backpack\knowledge.sqlite` 的 `proposals` 表：
     ```sql
     SELECT id, idem, state, created_at, project_id, payload 
     FROM proposals 
     WHERE id = 'c1b8d565-0767-472a-8271-03f3be2fa14a';
     ```
   - 查询结果：
     - `id`: `c1b8d565-0767-472a-8271-03f3be2fa14a`
     - `idem`: `AMB-TEST-20261014-CODEX-01`
     - `state`: `pending`
     - `created_at`: `1791912576892`
     - `project_id`: `p0-workflow`
     - `payload`: 包含完整 discovery 文本。
   - 验证结论：该测试记录确已落入底层权威库，状态维持 `pending`，没有任何既有知识被改写、晋升或结构化。

---

### 2.4 管理界面检查与可逆停用/恢复测试

1. **Codex 桌面管理界面核查**：
   - 观察 Codex 桌面 UI，侧边栏及主视图仅包含项目、站点、资料库、设置和聊天功能，**不存在** AMB 候选管理、知识结构化或归档的管理面板。
   - 依据系统设计，AMB 的管理控制台（console）由 Core 在单独的 Web/CLI 服务端提供，并严格要求 `admin-client.json` 管理员凭据。Codex 客户端作为 adapter 角色，未被授予管理授权，因此桌面端无法直接在 UI 内审核或归档候选。候选保留待审 `pending`。

2. **可逆插件停用/恢复体验**：
   - 配置文件：`<USER_HOME>\.codex\config.toml`。
   - 停用操作：将 `[plugins."agent-memory-backpack@agent-memory-backpack-local"]` 的 `enabled` 设为 `false`。
   - 验证停用状态：运行 `codex.exe plugin list --json`，输出显示 `agent-memory-backpack` 的 `enabled: false`。
   - 恢复操作：将配置恢复为 `enabled = true`。
   - 验证恢复状态：运行 `codex.exe plugin list --json`，确认 `agent-memory-backpack` 的 `enabled: true`。
   - 过程评价：操作完全可逆，未重启宿主应用进程（PID 21580），也未重启 Core 服务进程（PID 24700）。

---

## 3. 证据分类与状态矩阵

| 场景 / 测试项 | 判定状态 | 证据分类 | 关键证据与边界说明 |
|---|---|---|---|
| Codex 桌面运行与工作区绑定 | **通过** | 实测 | HWND 460818，UI 明确绑定 `huange-skill` 工作区 |
| 新聊天会话与 AMB 自动注入 | **通过** | 实测 | 新建聊天“盘点注入上下文与工具”，模型自动读取 AMB 技能，加载 12 个 `mcp__amb__*` 工具 |
| AMB 自检 (`amb_self_check`) | **通过** | 实测 | 核心响应正常（33ms）， Managed 协议 v1，知识版本 2，全部检查项 pass |
| 知识与工作流搜索 (`prepare` / `search`) | **通过** | 实测 | prepare 正常返回上下文；工作流搜索如实返回空列表；通用搜索返回匹配集合 |
| 按 ID 读取知识 (`read_knowledge`) | **通过** | 实测 | 成功按 ID 读取未结构化技能 `skill:577a28b2850ada49`（技能调度入口） |
| 阶段读取成功路径 (`read_stage`) | **未验证** | 未验证 | 当前知识库无已结构化流程，缺少真实合法的 stageId，不误判通过 |
| 阶段读取负向门禁 (`read_stage`) | **通过** | 实测 | 传入无效 ID 返回 HTTP 404 `Workflow is unavailable`，`isError: true` |
| 经验候选首次写入 (`submit_experience`) | **通过** | 实测 | 幂等键 `AMB-TEST-20261014-CODEX-01` 成功写入，分配 ID `c1b8d565-0767-472a-8271-03f3be2fa14a`，`state=pending`，`duplicate=false` |
| 同参重试幂等去重 (`submit_experience`) | **通过** | 实测 | 相同参数原样重试，返回相同 ID，`duplicate=true`，状态保持 `pending` |
| 底层数据落盘与状态独立读回 | **通过** | 实测 | 直接只读查询 `knowledge.sqlite` 的 `proposals` 表，确认 ID、idem 与 pending 状态完全一致 |
| 知识防篡改契约守护 | **通过** | 实测 | 未执行批准、采纳、结构化、supersede 或修改既有知识，权威库知识版本维持 2 |
| Codex UI 候选管理与归档界面 | **边界明确（未暴露）** | 实测 / 推断 | Codex 桌面无原生 AMB 候选管理面板；管理需 Core admin 凭据，adapter 角色无权直接在会话中归档 |
| 插件配置禁用与恢复可逆性 | **通过** | 实测 | 通过 `config.toml` 与 `codex.exe plugin list --json` 完成 `enabled: false -> true` 循环验证 |
| 自动化套件回归 | **已有自动化证据** | 已有证据 | 历史 `npm test` 385/386 pass（1 个路径 smoke test 跳过），不替代实机 UI 验收 |

---

## 4. 发现与缺陷排查说明

1. **Codex 桌面代码块字数截断与分块**：
   - 现象：在 Codex 会话中执行 `amb_search_universal`，由于返回内容包含了长篇未结构化技能全文，输出超过 64,000 字节，触发了 Codex 审批检查与代码块保存限制，模型随后通过分块方式落盘。
   - 影响等级：**低（宿主交互体验层）**。核心 MCP 通信正常，诊断数据完整记录在 `docs/diagnostics/2026-10-14-amb/amb-raw-receipts.json`。
2. **管理 UI 职责边界与凭据隔离**：
   - 现象：Codex 桌面端不提供 AMB 候选的审核与归档 UI，用户若需对候选执行采纳或结构化，需在外部打开本地 Core Web 管理页面或通过 CLI 工具注入 admin token 操作。
   - 影响等级：**提示项（符合设计规范）**。有效地防止了普通 Agent 会话误操作修改知识库。
3. **最终插件与环境状态**：
   - Codex 插件配置：`agent-memory-backpack@agent-memory-backpack-local` 当前处于 `enabled: true`。
   - Core 服务进程：PID 24700 正常监听 `127.0.0.1:47631`。
   - 测试候选：`c1b8d565-0767-472a-8271-03f3be2fa14a` 保留为 `pending` 状态，未污染正式知识。
