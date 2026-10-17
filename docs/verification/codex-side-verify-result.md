# Codex 侧适配器验证记录（DSH 侧执行）

**执行者**：DSH 侧会话（本机操控）
**时间**：2026-10-17
**方式**：直接向 `adapters/codex/scripts/hook.mjs` 喂真实的 hook 事件 JSON，观察其 stdout 协议输出。
**数据来源**：真实库（`C:\Users\czx\.agent-memory-backpack`，知识版本 2066），非夹具。

## 为什么这样验证

Codex 的五个 hook 事件都由 `node "${PLUGIN_ROOT}/scripts/hook.mjs"` 处理，输入从 stdin 读 JSON、输出走 stdout。因此**不需要开一个真实 codex 会话也能验证装配是否正确**：喂一个与 codex 等价的 payload，就能检查它是否连上核心、拿到正确形状的响应。

## 结果

### 1. UserPromptSubmit（注入规范 + 召回）

```json
{"hook_event_name":"UserPromptSubmit","session_id":"verify-codex-probe","prompt":"召回预算与渐进披露","cwd":"D:\\huange-skill"}
```

**输出**（`hookSpecificOutput.additionalContext` 内容摘要）：

- 知识版本行：`Agent Memory Backpack 当前知识版本 2066`
- 宿主已加载规范登记：`norm:29adc4ead699d040@2`、`norm:7eefbdccc0ea236e@1`、`norm:9861dfd810c7505b@1`
- **四条规范全文**（endpoint-latency-attribution / log-window-comparability / package-syntax-gate / timeout-budget-mode-verdict）
- **一条召回命中**：`journal-task-11980519b966843f@2`（正文 197 字符 + 摘要），并带 `· 结果=未验证` 标记
- 尾部保留 `【AMB 双向记忆】` 指引与 `[AMB 自动检索并读取：task]` 段

**判定**：PASS。协议形状正确（`hookSpecificOutput.hookEventName` + `additionalContext`），规范与召回都到达，且召回条目带着结果标记与"需要时调用 amb_read_knowledge"的按需读取说明——与设计中的"元数据不能丢"一致。

### 2. PreToolUse（门禁检查路径）

```json
{"hook_event_name":"PreToolUse","session_id":"verify-codex-probe","tool_name":"Bash","tool_input":{"command":"rm -rf /tmp"},"cwd":"D:\\huange-skill"}
```

**输出**：`hookSpecificOutput.additionalContext` 为"**当前规范** …"四条规范全文，无拦截字段。

**判定**：PASS（就注入而言）。它在工具调用前把当前规范送到模型面前，**不做硬拦截**——这是设计选择（规范是给模型看的约束，不是 shell 级 ACL），本记录只确认它确实送达。

### 3. Stop（归档路径）

```json
{"hook_event_name":"Stop","session_id":"verify-codex-probe","cwd":"D:\\huange-skill"}
```

**输出**：`{"continue":true}`

**判定**：PASS。归档副作用不阻塞会话结束——符合"失败只记日志、不阻塞结束"的设计。

## 局限（必须说清楚）

- **这是模拟调用，不是真实 codex 会话**：验证了 hook 的装配、协议、核心连通与输出形状；**没有**验证"codex 真的会在这些时机调用它们"。
- 因此 `task.archived` 能否在**真实 codex 会话结束时**写出，仍未验证。
- `session_id` 用的是探针值（`verify-codex-probe`），所以本次不产生真实任务归档（幂等键不同）。

## 附带发现：备份被拒（真实缺陷，未修）

用户执行备份时：

```
node <cli> backup --file D:\amb-backup-20261017.ambpack --yes
→ Credential-shaped content refused
```

**这台机器当前无法备份**。原因方向：数据目录里的 `core.json` 含凭据，打包器的凭据形状扫描在**扫描阶段**拒绝了整包。已作为任务第 4 项交给 codex 做只读定位（要求不打印凭据、只报文件/字段级来源）。

## 状态

| 项 | 结果 |
|---|---|
| UserPromptSubmit 注入 | PASS（模拟） |
| PreToolUse 注入 | PASS（模拟） |
| Stop 归档不阻塞 | PASS（模拟） |
| 真实 codex 会话触发 | **未验证** |
| DSH 侧宿主层接线 | **已交 codex 执行**（任务已投递，见 `codex-handoff-dsh-verify.md`） |
