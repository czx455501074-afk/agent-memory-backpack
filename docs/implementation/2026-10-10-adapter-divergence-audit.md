# 三端适配器分歧审计与修复记录

**时间**：2026-10-10（Asia/Shanghai）
**起因**：目标要求"每个环节要仔细，功能要运行测试，有问题要及时修复"。委派子智能体对 `src/mcp.ts`、`adapters/dsh/index.mjs`、`adapters/codex/scripts/hook.mjs` 做只读行为审计，核对联合规划 §3.2「适配器只处理宿主差异，避免分类/审核逻辑分叉」。

## 一、最严重问题：我引入的路径白名单回归

**缺陷**：`src/client.ts` 的路径白名单是 `/^\/v1\/[a-z]+$/`，只允许**单段**路径。而我后续新增的 `/v1/knowledge/*`、`/v1/proposals/*`、`/v1/rescan/*`、`/v1/tasks/*` 都是两段路径。

**独立复现**（用真实 `CoreClient` 类逐个端点调用）：

```
paths checked: 22
BLOCKED by local path whitelist: 14
  /v1/proposals/list   /v1/proposals/approve   /v1/proposals/reject
  /v1/knowledge/read   /v1/knowledge/supersede  /v1/knowledge/history
  /v1/knowledge/structure   /v1/knowledge/unstructured
  /v1/rescan/state   /v1/rescan/interval   /v1/rescan/mark
  /v1/tasks/record   /v1/tasks/list   /v1/tasks/handoff
```

比子智能体报告的 5 个工具更严重：**22 个端点里 14 个被拦死**。

**为什么测试没抓到**：`protocol.test.ts` 只用 `callTool` 真实调用了 `amb_prepare` 与 `amb_submit_experience`（都是扁平路径），其余只断言**名字存在**。全仓 `Unsupported core path` 零测试覆盖。

**修复**：正则改为 `/^\/v1\/[a-z]+(?:\/[a-z]+)*$/`——允许嵌套段，但仍限小写单词，因此路径不可能引入穿越、查询串或绝对 URL。

**新增回归测试**：改为**遍历全部 9 个工具做真实调用**，并显式断言任何工具都不得出现本地拒绝。

## 二、其余修复

### MCP 不做任何响应校验（"假装成功"）

MCP 的 `call()` 只做 `JSON.stringify(await client.post(...))`，不检查任何字段。实测假核心回 `200 {}` 时，MCP 报 `isError=false` 把空对象当成功；而 DSH 与 Codex 都会拒绝。

**修复**：在 `src/client.ts` 抽出共享的 `assertPrepareResponse` / `assertGateResponse`，规则与 DSH 完全一致（`protocolVersion === 1`、`mode === 'Managed'`、版本为非负安全整数、集合为数组、`knowledge` 存在时须为数组）。MCP 的 `prepare` 接入校验。

**新增回归测试**：一个只回 `200 {}` 的假核心，断言 MCP 必须报错且信息含 `invalid prepare response`。

### 负数版本号被放过（三端共有的真实漏洞）

`Number.isSafeInteger(-3)` 返回 `true`，所以 `-3` 这样的版本号能通过校验，而核心永远不会产生该值。

**修复**：三端统一引入 `isRevision = Number.isSafeInteger(v) && v >= 0`。Codex 的 `prepare`/`gate`、DSH 的 `assertPrepareResponse`/`assertGateResponse`、MCP 的共享校验都已使用。

**这个缺陷是新增测试抓出来的**，不是审计提出的——写负版本测试用例后才发现三端都漏。

### Codex 与 DSH 的校验规则不一致（4 处）

| 项 | 原 DSH | 原 Codex | 处理 |
|---|---|---|---|
| `mode` | `=== 'Managed'` | 仅 `typeof string` | 统一为 `'Managed'` |
| `knowledgeRevision` | 非负安全整数 | 仅 `isFinite` | 统一为非负安全整数 |
| `context` 非空 | 不要求 | 要求 `.trim()` | 统一为不要求非空 |
| `knowledge` 字段 | 存在时须为数组 | 不检查 | 统一为存在时须为数组 |

`mode` 那一项尤其重要：规划 §3.4 定义三种状态 `Managed / ReadOnlySnapshot / Ungoverned`，原 Codex 会把 `Ungoverned` 当正常状态继续注入上下文，与"失去治理能力必须可见"直接冲突。

**新增回归测试**：枚举 `Ungoverned`、`ReadOnlySnapshot`、小数版本、负版本、`knowledge` 非数组五种畸形响应，断言全部失败且不注入上下文；另加一条空 context 必须被接受。

### DSH 参数边界与核心不一致

- `idempotencyKey`：DSH 原为 `maxLength: 256` 任意字符，核心只收 ≤120 且限 `/^[\p{L}\p{N}_.:-]+$/u`。实测确认 DSH 会转发核心必然拒绝的输入。已改为与核心一致（含 `pattern`）。
- `discovery`：DSH 原为 `4000`，核心与 MCP 均为 `12000`。已对齐为 `12000`。
- `workflowId`：补上 `maxLength: 120`。

### DSH 回执校验误判合法重试

核心在幂等重试时**故意**回传当前状态（如 `state=approved, duplicate=true`），而 DSH 的 `assertReceipt` 要求必须等于 `pending`，于是把合法重试报成协议错误。

**修复**：`duplicate === true` 时接受任一合法状态（`pending|approved|rejected|expired`）；首次提交仍必须 `pending`。

### DSH 缺 `structure`/`unstructured` 两个工具

核心端点已存在，仅适配器未注册，造成与 MCP 的能力不对称。已补齐，DSH 工具数从 7 增至 9。

### history 对未知 ID 返回空壳

`readKnowledge` 对未知 ID 报 404，而 `history` 返回 `200` + 空数组。后者会被读成"该条目存在但无历史"，是误导。

**修复**：未知 ID 一律 404。

## 三、判定为「一致」的项（未编造问题）

子智能体明确核实为一致，我保留其结论：
- **项目范围隔离**：核心强制 `projectId` 与 `adapter` 匹配，三端都无法跨项目读取。
- **失败语义**：核心不可用时三端全部 fail-closed，无任何一端静默放行。
- **`supersede` 响应校验**：子智能体曾怀疑 DSH 要求的 `action` 字段核心不返回，实测证伪——核心确实返回。
- **`query` / `reason` / `evidence` / `baseRevision` 边界**：一致。
- **Codex 不检查 `knowledge` 字段**：属向后兼容设计，非缺陷（现改为"存在时须为数组"）。

## 四、宿主能力所限（可接受，应文档化）

- MCP 无执行前 `gate`：MCP 协议本身没有执行前拦截点。
- Codex 无 `expand` / 候选 / 历史：Codex hooks 没有对应钩子。
- 凭据脱敏：Codex 有 `redact()`（三处输出都调用），DSH 与 MCP 无等价处理。当前不可复现泄露，属防御深度差异；子智能体建议下沉到共享核心，尚未实施。

## 五、验证

- 全套 **89 项测试，88 通过，0 失败，1 条件跳过**（打包冒烟测试需 `AMB_ARTIFACT_DIR`）。
- 新增/改写测试：MCP 全工具真实调用、MCP 畸形响应拒绝、Codex 五种畸形响应拒绝 + 空 context 接受、DSH 工具清单。
- 独立复现脚本确认 14 个被拦端点现已全部可达。

## 六、仍未验证（重要界限）

以上全部是对**代码路径**的判断。**真实桌面端从未验收**——DSH/Codex 桌面是否按预期传 `cwd`、`hook_event_name`、`tool_name`、`session_id` 等字段名，目前只有 fixture 级测试支撑。README 一直标注为未通过。
