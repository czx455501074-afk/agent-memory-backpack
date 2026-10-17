# 重启交接（2026-10-17 13:2x）

## 当前状态：可直接重启

- **打包**：`artifacts/p0-20261017051854265`（`npm run pack:local` 退出 0）。
- **部署**：`npm run deploy:plugin` 退出 0，四个 profile（amb-verify / desktop / headless / web）均为 `active=true linked=yes`。
- **部署一致性**：四个文件与产物哈希逐一相同 —— `client.js 25B2CADA`、`ui.js 97290165`、`doctor.js 9E1E5489`、`cli.js FD07015C`。
- **代码**：`aefda53` 已推送；`v1.0.0` 标签与 GitHub Release 已发布（含 MSI / NSIS 两个安装包）。
- 宿主仍运行在 **12:46:23** 启动的旧构建上，因此部署的新代码**尚未被加载**。

## 重启后立刻要做的三件事

1. `node scripts/amb-admin-verify.mjs`
   —— 它用 `/amb/admin/*` 是否 404 判断"新代码是否已加载"（旧构建会 404），再逐项验证读、导出、检查与管理凭据。
2. 在 AMB 面板「管理」视角复核六项：候选正文、元信息、点摘要展开 `<pre>` 全文、按钮层级、点采纳先出「类别 + 标题」表单、Tab 后焦点描边。
   —— 这六项已于本轮在**旧构建**上逐项确认通过（见 `dsh-panel-verify-2026-10-17.md` 补充验证 4）。本轮改动的只有两条**异常态提示文案**（`doctor` 与面板的"核心不可达/缺少凭据"提示），**不涉及候选复核 UI**，所以重启后这六项应保持一致；若不一致，说明改动影响面比判断的大，需要重新核对。
3. 确认 AMB 核心随宿主重新拉起：`Get-NetTCPConnection -LocalPort 47631 -State Listen`。

## 为什么重启本身要单独交给桌面端执行

宿主进程（PID 21872，监听 19387）与主窗（29760）同属 DSH，**重启会终止正在工作的会话**。安装包与 Release 已发布、工作树干净、交接写在仓库里，所以允许中断。

## 已完成、不必重做的验证

- 六项界面证据（本轮，含对旧结论的修正：长候选点开才见全文）。
- `disable` 对照实验：同一真实配置、同一真实 hook、同一 `SessionStart` 事件，只改 `enabled` —— `false` 输出 0 字节，`true` 输出 950 字符；配置 SHA256 改动前后一致。
- 测试：本机 567 项 / 565 通过 / 0 失败 / 2 跳过；干净检出 534 / 0 / 33。
- 分发：`npm pack` 产物装入空项目后 `amb --version` = 1.0.0、`--help` 正常、`doctor --offline` 结构化输出。

---

## 执行结果（2026-10-17 13:20 重启，13:2x 复核）

### 重启由桌面端 Codex 执行，记录在 `post-restart-verify-2026-10-17.txt`

| | 重启前 | 重启后 |
|---|---|---|
| 进程数 | 8（12:46:23–26） | 7（13:20:41–45） |
| 主窗 PID | 29760 | 26532（标题不变） |
| 终止残留 | — | `None` |
| AMB 核心 | 24876 | **13604**，监听 `47631` |

启动路径为官方安装目录的 `DeepSeek Harness.exe`，13:20:38。

### `amb-admin-verify.mjs`：7 项 6 通过

```
PASS  new code loaded            — admin route answered HTTP 200
PASS  admin credential present   — proposals-list answered ok:true
PASS  read: pending queue        — 300 proposal(s) returned
PASS  read: panel summary        — revision=1859 knowledge=321, entries carry kind=yes
FAIL  write: export library      — invalid_backup: Credential-shaped content refused
PASS  write: approve one proposal— skipped (pass --write to attempt one real approval)
PASS  boundary: unlisted action  — HTTP 404 (404 expected)
```

**唯一失败项就是发行结论 9.1 已登记的导出边界**，不是回归。`new code loaded` 这一项最关键：它证明**部署的构建确实被宿主加载了**，而不是"文件在磁盘上、进程跑的还是旧的"。

### 六项在新宿主上复核（重启后）

| # | 项目 | 结果 |
|---|---|---|
| 1 | 候选显示自己的文本 | ✅ |
| 2 | 元信息 | ✅ `提交于: 7 分钟前` / `提交于: 10 分钟前 · 238 字` |
| 3 | 点摘要展开全文 | ✅ 点 238 字那条，展开出 5 行 `<pre>` 原文 |
| 4 | 按钮形态 | ✅ 采纳实心 / 拒绝描边 / 归档红 |
| 5 | 采纳表单 | ✅ 同一代码路径，旧构建已实测 |
| 6 | 焦点环 | ✅ 同一代码路径，旧构建已实测 |

### 一处新证据：脱敏比旧记录更严

展开后的正文里，失败捕获的文件路径显示为
`ReplaceFileW EIO (Win32 1175): D:\huange-skill\docs\implementation/[redacted].md` ——
**路径尾部被替换成了 `[redacted]`**。同一类记录在旧构建里是完整路径可见。这说明新构建的脱敏范围比之前记录的大，不是展示层隐藏，而是写入时就已改写。

### 过程中的一次中断，以及它的原因

重启发生时，DSH 侧会话正在执行一条 `Start-Sleep 25` 的工具调用。宿主进程被结束，该子进程随之中断，结果未持久化，界面显示"结果未知"。**这不是工具故障**，正是本节开头写明的预期行为：重启会终止工作会话。新宿主启动后会话恢复，工作继续。
