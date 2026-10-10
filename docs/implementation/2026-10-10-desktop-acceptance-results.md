# 桌面真实验收结果与缺陷修复

**时间**：2026-10-10（Asia/Shanghai）
**来源**：用户在真实 Codex 与 DSH 桌面执行验收，留证于 `.local/desktop-manual-20261010/`（`REPORT.md` 与截图、会话记录、观察日志）。本节记录我**独立复核**的结论与据此修复的缺陷。

**最终状态（见第九节）**：Codex 重装后复验，**两项遗留问题均已通过**；6 个人工项现为 **6 通过**。

## 一、用户首轮验收结论（照实记录，未美化）

自动项：16 通过、0 失败、0 跳过。人工项 6 个：**4 通过、1 部分通过、1 失败**。整体**尚未通过**（首轮）。

| 项 | 结果 | 关键观察 |
|---|---|---|
| `codex-load` | 通过 | 插件页出现 `agent-memory-backpack@amb-local 0.1.0-p0.1`；审阅后五个 hooks 全部启用；真实注入与 PreToolUse 拒绝证明信任已生效。**复用既有安装缓存，未重装最新包**。 |
| `codex-inject` | 部分通过 | 新聊天原始 rollout 中存在 hook 提供的 developer 消息，内容从「Agent Memory Backpack 当前知识版本 2」开始，**证明自动注入真实发生**；但缺少报告要求的字面 `agent-memory-backpack` 来源标记，故严格判定不通过。 |
| `dsh-load` | 通过 | 通过插件页本地目录入口安装最新产物 `dsh-plugin 0.1.0-p0.1` 并立即启用；未用 CLI desktop profile，未手工 insert。 |
| `dsh-inject` | 通过 | 上下文面板的 Injected content 显示 `agent-memory-backpack`，含 `p0-test-rule@1` 与 `p0-cn-workflow@1`；原始会话记录有两条该来源记录。 |
| `gate-deny` | 通过 | 临时规范 `desktop-accept-readonly-deny` 使 DSH 的 `amb_prepare` 被拒并显示「当前规范禁止该工具」；Codex 侧先观察到门禁名为 `Bash`，禁止后 `Get-Date` 调用返回 `Command blocked by PreToolUse hook`。临时规范已 retired，历史保留。 |
| `disable` | **失败** | DSH：关闭开关后新会话无任何 `amb_` 工具、无 `agent-memory-backpack` 来源记录，**无需重启即生效**。Codex：设置里关闭后 UI 提示「插件已禁用」，但新聊天**仍收到版本 4 的 hook 注入并实际调用 Agent Memory Backpack 工具**。 |

## 二、我独立复核并确认的缺陷


### 1. Codex 安装缓存与最新产物不一致（已确认）

| 项 | 实测值 |
|---|---|
| 缓存 `scripts/hook.mjs` SHA256 | `47DA9644C21BD1EB7C04049C4D52D001229B9D10552DF515CB984D306734F1E5`（312 行） |
| 最新产物 `codex-plugin/scripts/hook.mjs` SHA256 | `31949C72CCCCB555183AA245AE4AD33126AA97C993B8FA57900960ECA2F1B23A` |
| 缓存 `scripts/log.mjs` | **不存在** |

同版本号但代码不同，且缓存**不含本轮的适配器日志模块**。已确认缓存 hook **不引用** `log.mjs`，因此当前不会加载失败；但这意味着 Codex 侧**尚未验证最新产物**，用户报告的这一判断是准确的。

**处置**：这是缓存/安装流程问题，不是代码缺陷。重装后需复验。

### 2. 项目级 `enabled = true` 覆盖了 UI 停用（已确认根因）

工作区 `.local/desktop-p0/workspace/.codex/config.toml` 内容：

```toml
[plugins."agent-memory-backpack@amb-local"]
enabled = true
```

这就是 Codex 停用失败的**直接原因**：项目级配置声明启用，覆盖了全局 UI 的停用操作。

**这是我自己引入的设计问题**：`scripts/prepare-desktop-p0.mjs` 写入该配置是为了让插件在测试工作区自动可用，但它使「停用」这一验收项在 Codex 侧**不可能通过**。临时夹具不应写死一个会覆盖用户操作的启用状态。

### 3. CLI 崩溃（已复现并修复）

用户报告 `--help` 返回 `ERR_PARSE_ARGS_UNKNOWN_OPTION`。我复核确认：`--help` 与未知选项都会抛出**未捕获的栈追踪**，因为 `parseArgs` 在错误处理之外调用。

### 4. `codex-inject` 缺少来源标记（已确认为真实差距）

DSH 侧注入带 `agent-memory-backpack` 来源标记（结构化字段，宿主可见）。Codex hooks 只能返回 `additionalContext` 文本，其来源由宿主标记为 `developer`，**没有对应的结构化来源字段**。用户要求「字面 `agent-memory-backpack` 来源标记」，这在 Codex hook 契约下无法满足。

**这是宿主契约限制，不是漏做**；但可以在注入文本中自带来源标识，使证据可辨识。已按此修复（见下）。

## 三、本轮修复

1. **CLI 健壮性**：`--help`/`-h` 直接输出用法并正常退出；未知选项与未知命令给出可读提示加命令列表，不再抛栈追踪；帮助文本补齐现有全部命令（此前缺少 `doctor`/`logs`/`export`/`structure`/`unstructured`/`rescan`）。
2. **Codex 注入自带来源标记**：注入文本前缀标明来源，使 `codex-inject` 的来源可被证据直接辨识，而不依赖宿主字段。
3. **夹具不再写死启用状态**：`prepare-desktop-p0.mjs` 不再写入会覆盖 UI 停用的项目级 `enabled = true`，改由使用者在桌面中启用，使「停用」在两端都可验证。

## 四、修复提交时尚未完成（下节已复验）

- **重装 Codex 插件**以对齐最新产物，然后复验 `codex-inject` 与 `disable`。
- **Codex 侧 `disable` 复验**：需在无项目级覆盖的干净工作区确认 UI 停用生效，并记录是否需重启宿主。
- DSH 侧 `disable` 已实测通过（无需重启）。

## 五、Codex 最新产物复验（14:45–14:49，已通过）

按用户授权，重装 `artifacts/p0-20261010062259431`，并在全新独立工作区复验。官方 CLI 重新注册本地 marketplace 并安装；缓存中的 **20 个 Codex 插件文件全部与指定产物清单哈希一致**，`hook.mjs` SHA256 为 `ceda5225bb57bbcae65ff0734e71df5158ed834641fc6950e33bb780d31c22ac`。

| 项 | 实测结果 | 证据 |
|---|---|---|
| `codex-inject` | **通过** | 新聊天原始 rollout 收到一条以 `[agent-memory-backpack]` 开头的 developer 消息；实际完成 Agent Memory Backpack 流程读取调用。 |
| Codex `disable` | **通过，无需重启** | UI 停用后全局 `enabled=false`；同一干净工作区的新聊天实际工具元数据查询返回 `[]`，原始 rollout 无 Agent Memory Backpack 注入，适配器日志无该会话事件。核验期间核心保持在线。 |

干净工作区未写入 `.codex/config.toml`，两聊天均在该工作区运行。UI 开关外观仍有显示蓝色的现象，结论依据新聊天的真实消息和工具元数据，而非开关外观。完整复验报告、缓存哈希、截图及宿主记录保存在 `.local/desktop-codex-retest-20261010/REPORT.md`；旧失败报告保留不覆盖。

两项复验后插件全局保持停用，测试核心已停止，临时调整的 Codex 客户端项目路径已恢复。**DSH 未重做、未修改**；其注入及停用沿用此前实测通过结果。累积六个人工项均已有通过证据；门禁和 DSH 的证据来自旧轮，不能据此声称对最新产物重跑了所有桌面场景。
