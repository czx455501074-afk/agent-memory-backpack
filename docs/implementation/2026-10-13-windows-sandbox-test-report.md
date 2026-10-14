# Windows 沙盒环境与插件测试报告

## 结论

Windows 沙盒已启动并获得 guest 运行证据。沙盒全量复测 385 通过、1 失败、0 跳过；剩余 Electron 路径配置问题修正后，控制台专项 7 项全部通过，因此 386 个不同自动化测试均已覆盖通过。自动桌面验收 16 通过、6 项手动场景；实际 Codex 桌面对话首轮未加载插件工具且工作区不匹配，随后发现 hooks 审查窗口但无法确认批准生效。Codex/DSH 桌面端到端验收仍未完成。

2026-10-13 22:56 更新：DSH 0.2.0-rc.2 桌面已安装，插件已部署到 guest desktop profile。Codex/ChatGPT 26.1007.2314.0 已通过官方 MSIX 安装。首次激活报 0x87E10BC6；用户安装官方离线许可后，从沙盒手动启动并登录。Windows Sandbox 完整性高于宿主控制工具，宿主端无法向 guest 注入点击/按键。为先验证插件运行时，后续使用沙盒内 Codex CLI agent 会话，桌面 UI 验收仍独立标记为未完成。

2026-10-13 23:29 更新：用户确认 Codex 已登录，并明确授权在沙盒内自主测试。Jev 对现状建议先让 Node 可用于 Codex 子进程，再启动真实 agent，会话选择置信度 0.99。已将便携 Node 加入 guest 用户 PATH 并重启 Codex。使用 guest 原生 codex.exe 在 C:\AMB-Test\project 启动真实 Codex CLI agent（不是桌面 UI 对话）：`codex-agent-smoke.jsonl` 显示 amb_self_check、amb_prepare、amb_search_workflows、amb_read_stage、amb_submit_experience 成功。自检报告插件 0.1.0-p0.1、Node 24.19.0、win32、协议 v1、核心可达。提案 ID `c13ada9d-d666-4302-8a37-2aad5963a2b3`、principal=`codex`、state=`pending`；Store 独立复读确认知识 revision 仍为 1。第二个 Codex agent session 使用原始完整参数重试，服务返回同一 ID 且 `duplicate=true`，proposal 总数仍为 1。尝试 `rg` 的沙盒 PowerShell 命令失败，因为 guest 没有 rg；agent 据实报告。Codex 桌面当前显示与本任务同步的同一会话，不能把当前会话当作隔离桌面新聊天；需在新聊天附加 guest 工作区，才能验收 UI hooks/注入。

### 实际桌面验收进度（按真实用户流程）

| 场景 | 当前状态 | 证据/说明 |
|---|---|---|
| Windows Sandbox 内安装 DSH 与 Codex 桌面版 | 通过安装阶段 | DSH 0.2.0-rc.2；Codex 26.1007.2314.0；用户均已确认登录 |
| DSH 插件部署 | 已部署，运行时/界面复核待做 | `dsh-plugin-deploy.stdout.log`；需通过 DSH 对话实际调用 |
| Codex marketplace 与插件安装 | CLI 安装完成，guest config 为 enabled；桌面出现三项 hooks 审查，是否持久批准/触发未核实 | `codex-marketplace.log`、`codex-plugin-install.log`、`codex-desktop-control-attempts.json` |
| Codex CLI agent 的插件自检、检索、阶段读取、候选提交与幂等重试 | 通过（CLI runtime） | `codex-agent-smoke.jsonl`、`codex-dedupe.jsonl`；明确不作为 UI 验收 |
| Codex 实际 MCP 调用、候选 pending 与同键幂等 | 通过（CLI runtime） | Store 复读确认 proposal=1、revision=1；桌面首轮失败：会话未加载插件工具且工作区路径不符，待正确绑定项目后重测 |
| 两桌面共享读取与候选可见性 | 部分 | Codex principal 候选已从 guest Store 查到；DSH 工具读回待做 |
| 门禁拒绝、停用后失效、离线 spool/恢复 | 待做 | 先确认实际宿主传入字段，再仅在测试库执行；失败和未测须分开报告 |
| 全部设计功能完成度 | 尚不能判定 | 自动测试不是实际宿主全覆盖；以逐项宿主证据矩阵给结论 |

### 新增运行记录（guest Codex runtime）

| 时间（Asia/Shanghai） | 操作 | 结果 | 证据 |
|---|---|---|---|
| 23:18 | Jev 选择先修正 Node PATH 并重启 Codex | choice=`restart_with_runtime`，confidence=0.99 | `jev-route-runtime.json` |
| 23:20 | Codex guest 桌面重启，PATH 加入便携 Node | 进程启动成功；后续 MCP 自检报告 Node 24.19.0 | `codex-runtime-restart.json` |
| 23:27–23:29 | guest 原生 Codex agent 执行实际插件任务 | self-check、prepare、workflow search/read stage、submit 均有 MCP 完成事件；一条 shell 搜索失败：`rg` 未安装 | `codex-agent-smoke.jsonl`、`codex-agent-smoke-tools.json` |
| 23:29 | guest Store 独立读回 | candidate `c13ada9d-d666-4302-8a37-2aad5963a2b3` / principal `codex` / pending；revision=1，proposalCount=1 | `codex-proposal-verification.json` |
| 23:34–23:35 | 第二个 Codex agent 会话重试原始参数 | 同一候选 ID，`duplicate=true`，仍 pending | `codex-dedupe.jsonl`、`codex-dedupe-tools.json` |
| 23:42 | `codex app C:\AMB-Test\project` 请求桌面打开 guest 测试目录 | 命令 exit 0，桌面窗口当前仍显示本任务同步会话；是否完成桌面新会话绑定待用户在窗口中确认 | `codex-open-workspace-status.json`，屏幕截图观察 |
| 23:44 | 核验共享核心与 DSH 进程 | health=`ok`，protocolVersion=1；DSH 与 Codex 进程均仍在运行 | `core-live-check.json`、`desktop-processes.json` |

截至 23:45，Codex CLI agent runtime 已证明该 marketplace 安装包能够加载 MCP server、读取隔离知识和提交流程候选，并正确处理相同幂等键；这不是 Codex 桌面 UI 自动注入/hooks 的通过证据。DSH UI 的实际调用尚未发生。宿主 CUA 工具只能读取 guest 屏幕，无法向高完整性沙盒窗口发送输入；Codex 新会话测试任务已预置于 guest clipboard，需从 UI 手动创建新聊天并发送。Jev 对该状态下一步建议选择 `run_dsh_agent`，confidence=0.41（不确定），故作为路线提示记录，不作为事实或通过判据。

2026-10-13 23:50 更新：用户在沙盒 Codex 桌面对话中发送了测试请求。通过宿主截图直接观察到真实桌面回复：Codex 报告当前会话的工具目录没有 `amb_self_check`、`amb_prepare`、`amb_search_workflows`、`amb_read_stage`、`amb_submit_experience`，所以没有 MCP 调用回执、候选 ID/状态或知识版本变化；该桌面步骤判为**未通过（插件工具未加载）**，不是待定或 CLI 通过。回复还显示实际工作目录为 `<USER_HOME>\Documents\Codex\2026-10-13\windows-sandbox-c-amb-test-project`，与要求的 `C:\AMB-Test\project` 不同，因此无法据此验收目标项目 hooks/上下文。沙盒窗口返回“higher Windows integrity”限制，宿主工具仅能截图，不能代替用户切换工作区或发送下一条桌面消息。接下来须在 Codex 桌面打开 `C:\AMB-Test\project`，从该目录创建新聊天并复测；之后再运行已准备好的 DSH 对话测试。此次截图显示 Windows 时钟 23:50、日期 2026/10/13；报告时间按沙盒屏幕记录。

2026-10-14 00:05 更新：遵照用户要求继续由助手操作。截图显示 Codex 的 hooks 审查窗口列出 `agent-memory-backpack` 的 PreToolUse、PostToolUse、SessionStart；助手点击“全部允许”，窗口消失，但后续没有日志/设置读回证明批准已持久保存或钩子已执行。再次尝试点击 Codex 文件菜单、新聊天、工具栏加号及 Ctrl+N，屏幕均无可见变化；`sky.list_windows` 只返回外层 Windows Sandbox 窗口，没有 guest 内 Codex/DSH 独立窗口。宿主 Computer Use 能截图但输入不能改变 guest UI；当前宿主 PowerShell 进程的管理员令牌检查为 false（这只描述进程令牌，不代表用户账户权限）。因此不使用另一套输入注入绕过完整性边界。Jev 通过 TypeSafe API 对下一步给出 `use_codex_workspace_entry`，confidence=0.28、该选项概率0.38；此前官方 `codex.exe app C:\AMB-Test\project` 命令虽 exit 0，仍未让可见桌面会话绑定该目录，故这条低置信建议不足以当作已验证路径。真实 Codex 桌面验收、DSH 桌面对话和桌面候选写入仍未完成。该次 JEV 请求与界面尝试记录见 `jev-route-20261014.json`、`codex-desktop-control-attempts.json`。

隔离知识库位于 guest `<USER_HOME>\.agent-memory-backpack`，项目 sandbox-desktop-20261013，有两个初始测试条目；当前知识 revision=1、proposal=1。Jev 已真实调用，最近一次推荐“修复 Node 运行环境后再做真实 Codex 会话”，置信度 0.99。核心 guest PID 3784 监听 127.0.0.1:47639。证据文件在 `.local/windows-sandbox-20261013/results`，重点包括 `codex-agent-smoke.jsonl`、`codex-agent-smoke-tools.json`、`codex-dedupe.jsonl`、`codex-dedupe-tools.json`、`codex-proposal-verification.json` 与 `codex-runtime-restart.json`。

## 对象与环境

- 日期：2026-10-13，Asia/Shanghai，记录时间 20:58。
- 项目：agent-memory-backpack 0.1.0-p0.1。
- 源码提交：bc36520d917c55ae9eb39f5e56f3fb8f9e66cf65；开始时工作树干净。
- 宿主：Windows 11 企业版，10.0.26200；Node 24.19.0。
- DSH 集成夹具：提取的 0.2.0-rc.2 真实运行时。
- 测试副本：`D:\huange-skill\.local\windows-sandbox-20261013\input\project`。
- 本轮未修改插件实现、真实知识库或已安装的宿主插件配置。

## 初期沙盒启动阻碍（已恢复）

已发现 `C:\Windows\System32\WindowsSandbox.exe`，vmcompute 与 hvhost 服务均处于 Running。本次使用专用 .wsb 文件启动，进程 PID 7456 存在，但结果目录始终没有沙盒启动脚本的 `status.json` 或 `environment.json`。通过 computer-use 枚举未发现沙盒窗口，再次调用预装沙盒程序也返回 `launched app did not expose a targetable window: Microsoft.Windows.Containers.Sandbox`。

启动前已存在多个沙盒进程，均未终止。`wsb` CLI 不在 PATH；读取所有用户 Appx 信息被拒绝。以上仅证明当前无法获得启动证据，不能推断确切根因，更不能推断插件导致沙盒失败。没有改动 Windows 功能、虚拟化设置或安全策略。

配置按 Microsoft 官方 .wsb 的只读输入映射、可写结果映射及 LogonCommand 方式建立：[配置文档](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file)。

## 已执行检查（全部在宿主独立副本）

| 检查 | 真实结果 | 证据文件 |
|---|---|---|
| npm run check | 退出 0 | host-check.log |
| npm run test | 386 项：380 通过，0 失败，6 跳过 | host-full-suite.log、host-status.json |
| npm run pack:local | 退出 0，生成 core/Codex/DSH 产物 | host-package.log、host-package-status.json |
| 打包后 CLI/MCP 实际消费 | 1 通过，0 失败/跳过；中文空格路径 fixture | host-packaged-smoke.log |
| 打包后部署测试 | 5 通过，0 失败/跳过 | host-deploy.log |
| 桌面自动验收 | 16 通过，0 失败，6 manual | host-desktop-acceptance.json、host-desktop.log |
| npm ci --ignore-scripts --no-audit --no-fund | 退出 0，107 个包安装成功 | host-clean-install.log |
| 干净安装后类型检查 | 退出 0 | host-clean-check.log、host-extra-status.json |

最初 6 个跳过项为：首次部署、重复部署、真实目录冲突拒绝、无 bundles profile、链接读回，以及打包产物 CLI/MCP 消费。它们全部在生成产物后单独执行通过。没有重复计算这些测试为新增覆盖。

现有全量测试覆盖知识存储、结构与策略、API 鉴权及跨项目隔离、检索、候选与采纳生命周期、任务交接、备份归档、持久性、故障 outbox、配置与版本边界、Codex hooks、DSH bundle patch 与真实 ToolRuntime、控制台/Web 契约、安装与卸载保护等。通过说明这些场景的断言成立，不代表没有未覆盖缺陷。

## 尚未验证

1. Codex 桌面新聊天绑定 `C:\AMB-Test\project` 后的插件启用、hooks 信任/实际触发、自动上下文注入；目前仅 Codex CLI agent runtime 真实通过。
2. DSH 桌面对话中的真实工具调用、候选写入、幂等重试，以及 DSH 读回 Codex 候选。
3. 两个桌面的真实门禁拒绝、停用效果与离线 spool/恢复；不能用后端直写冒充宿主结果。
4. 真实模型端到端会话、真实浏览器交互、账号登录及跨宿主连续操作。
5. 沙盒启动故障的确切原因。

## 21:10 重启沙盒复核

用户确认双击配置未打开窗口，并明确授权关闭全部 WindowsSandbox.exe 进程后重试。已成功关闭 5804、7456、8684、21428、32536、33716 六个进程，结果保存于 `sandbox-restart.json`。关闭旧进程后依次尝试专用配置的隐藏启动、可见启动和不带任何配置的原生可见启动，均只有进程，没有可操作窗口；专用配置也没有产生 status.json。每次重试前关闭本次上一个进程，最后关闭了原生重试进程 31680，不留本轮启动进程。

这将问题缩小到沙盒自身启动链路：不用项目配置也能复现。旧进程占用及 .wsb 配置不是唯一解释，确切根因仍未证实。HypervisorPresent 为 True，hvhost/vmcompute 正常运行；容器过滤器日志未出现这次重试的新事件。查询 Windows 沙盒可选功能状态需要提升权限，当前工具返回“请求的操作需要提升”，因此未取得该状态。没有执行系统修复、服务重启或电脑重启。后续需要管理员诊断沙盒启动故障；插件的沙盒内测试继续保持未完成。

## 文件与继续执行

- 可重用配置：`D:\huange-skill\verification\windows-sandbox\test.wsb`。
- 执行脚本：`D:\huange-skill\verification\windows-sandbox\run.ps1`；已用 PowerShell Parser 验证无语法错误。
- 当前启动配置：`D:\huange-skill\.local\windows-sandbox-20261013\test.wsb`。
- 当前全部证据：`D:\huange-skill\.local\windows-sandbox-20261013\results`。
- 打包产物：`D:\huange-skill\.local\windows-sandbox-20261013\input\project\artifacts\p0-20261013125550439`。

下一步先从用户桌面双击当前启动配置，取得实际启动错误或沙盒窗口。若打开，检查结果目录新生成的 status/environment 文件确认来自沙盒，再等待各步骤结束、逐项核对退出码和跳过原因。然后在隔离环境安装完整桌面宿主并完成 6 个 manual 验收项。宿主测试日志必须继续与沙盒日志分开。

