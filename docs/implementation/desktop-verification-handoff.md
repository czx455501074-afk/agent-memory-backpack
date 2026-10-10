# 交给 Codex 的验证流程：Agent-Memory-Backpack

本文件供 Codex（或任何能操作本机 GUI 的自动化代理）逐条执行。
**每条都给了可判定的通过标准与需保留的证据。做不到就记「未验证」，不要编。**

## 环境现状（已由我准备好，不要重复做）

| 项 | 值 |
|---|---|
| 仓库根 | `D:\huange-skill` |
| 最新产物 | `artifacts/latest.json` 指向 `artifacts/p0-20261010134533699` |
| 验证工作区 | `D:\huange-skill\.local\desktop-verify`（**独立 git 根，仅含测试知识**） |
| 私有数据目录 | `D:\huange-skill\.local\desktop-verify-data`（随机本地测试凭据） |
| 核心启动入口 | `D:\huange-skill\.local\desktop-verify\start-core.ps1` |
| Codex 本地 marketplace | `D:\huange-skill\.local\desktop-verify\.agents\plugins\marketplace.json` |
| 目前种子知识 | 2 条（`p0-cn-workflow`、`p0-test-rule`），`knowledgeRevision=1` |

**已确认**：产物与源码哈希一致；`archive.js`、`amb_inspect_archive`、控制台 migrate 面板都在这个夹具里。
**已确认**：`codex` CLI **不在 PATH**；默认数据目录 `~/.agent-memory-backpack` **不存在**；Codex 插件缓存已清空。所以这是干净的首次安装。

> 全局约束：**不要**编辑 Codex/DSH 的真实 profile；**不要**编辑信任哈希或绕过信任；**不要**删除或改写 `packages/` 以外的既有文件；**不要**把任何 `*-client.json` 或 `core.json` 的内容贴进报告。

## 第 0 步：自动化基线（先跑，1 分钟）

```powershell
cd D:\huange-skill
npm run accept:desktop
```

**通过标准**：`自动项 通过=16 失败=0 跳过=0；需人工 6 项`。
报告写到 `docs/implementation/desktop-acceptance-report.json`。若这里不为 0，**停止**，把失败项原文报回来——不要继续做桌面步骤。

我这边已跑过：16/0/0。产物清单有 52 个文件，逐项哈希全部匹配（此数字由 `artifact-manifest.json` 的 `artifactFiles` 键数实测得出；此前草稿写的 46 是未核实的记忆值，已更正）。

## 第 1 步：启动核心（保持终端开着）

```powershell
D:\huange-skill\.local\desktop-verify\start-core.ps1
```

**通过标准**：输出含 `core listening on http://127.0.0.1:47631`。
若提示端口占用，**不要杀未知进程**，报告端口占用并停止。

## 第 2 步：Codex 桌面加载插件 + 信任 hooks

1. 用 Codex 桌面**打开** `D:\huange-skill\.local\desktop-verify`（这一步很关键，不要用 `D:\huange-skill` 本身）。
2. 找到本地 marketplace 入口，加载 `Agent Memory Backpack P0 Local`，插件名 `agent-memory-backpack`。
3. 出现信任提示时，**审阅 hook 定义后再信任**。未信任状态不算通过。

**已知线索（来自产物 app.asar 只读检查，未经运行时确认）**：安装包里存在 hooks 审阅 UI，路由线索为 `/settings/hooks-settings`，该页面有 `Trust all` 动作与 `untrusted` / `modified` 的待审状态，并把 `plugin` 识别为 hook 来源。**这只是线索，不保证这个构建暴露该入口。** 找不到就记录为「未找到信任入口」并截图，**不要猜着点**。

**通过标准**：插件出现在插件列表中，且 hooks 状态为已信任。
**留证**：插件列表截图（含插件名与启用状态）+ hook 信任状态截图。

## 第 3 步：验证自动注入上下文（**最关键项**）

在该工作区**新建会话**，输入这句自然语言：

> 查找本地流程资料，并说明开始前的检查

**通过标准**：**适配器在模型动手之前**自动注入了上下文。判断方式：会话中出现来源标记为 `agent-memory-backpack` 的注入内容，**不是**模型自己复述出来的。
**留证**：显示注入来源标记的截图或原始消息文本。**仅模型自述不足为证**——必须能看到内容来自适配器而非模型生成。

## 第 4 步：验证规范门禁真的拦住调用

夹具里已有一条规范 `p0-test-rule`，禁止的工具名是 `amb_p0_blocked`。

1. 先确认桌面实际传给 hook 的工具名格式（例如 `mcp__amb__amb_prepare` 这类带命名空间的形式）。
2. 在该测试库中新增一条**只禁止某个无副作用测试调用**的规范（用真实的工具名，**不要**拿有副作用的工具试）。
3. 触发该工具调用。

**通过标准**：工具**没有执行**，且桌面显示了拒绝原因。
**留证**：拒绝提示截图 + 工具未执行的证据（例如目标无副作用）。

## 第 5 步：验证候选不会自动生效

```powershell
cd D:\huange-skill
$cli = ".local\desktop-verify\packages\core\runtime\cli.js"
node $cli status --data-dir .local/desktop-verify-data
```

在会话中提交一条明确标注的测试经验，用**同一个 idempotencyKey** 重试一次。

**通过标准**：两次回执相同；`pendingProposals` 只增加 1；**生效条目数（`entries`）不变**。

## 第 6 步：验证核心失联行为

按 `Ctrl+C` 停止核心，然后在会话中触发一次工具调用或知识读取。

**通过标准**：范围内的受支持路径**明确报错或拒绝**，**不得假装成功**。
**留证**：错误消息截图或文本。之后重启核心，确认可恢复。

## 第 7 步：验证禁用后不再生效

通过 Codex 桌面 UI 停用插件，**新建会话**（不要复用旧会话）。

**通过标准**：不再注入上下文、不再提供 `amb_*` 工具。
**额外记录**：是否需要重启宿主才生效（夹具刻意**没有**写项目级 `enabled = true`，所以 UI 停用应当真正生效；如果停用无效，那是真缺陷，如实记录）。

## 第 8 步：DSH 桌面（同样的 4 项）

DSH 与 Codex 步骤相同，但安装入口不同：

1. DSH 桌面 → **设置 → 插件** → 通过本地包入口加载 `D:\huange-skill\.local\desktop-verify\packages\dsh-plugin`。
2. **不要**运行 `dsh plugin --profile desktop`；**不要**手工重复 insert（包自带 bundle patch）。
3. 重复第 3 步（注入）、第 6 步（失联）、第 7 步（禁用）。

**通过标准**：注入内容显示 `agent-memory-backpack` 来源；禁用后新会话不再注入。
**注意**：DSH 的安装路径从未验证过，**不能**把 Codex 的安装结果外推到 DSH。

## 第 9 步：数据迁移（**本次新增，重点验证**）

### 9a. 控制台导出

核心保持运行，另开一个终端：

```powershell
cd D:\huange-skill
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm run console -- --config="D:\huange-skill\.local\desktop-verify-data\admin-client.json"
```

在控制台点「数据迁移」tab → 「导出全部数据」 → 选一个路径保存。

**通过标准**：
- 弹出原生保存对话框，默认文件名形如 `agent-memory-backpack-20261010-220000.ambpack`
- 导出后面板显示文件路径、文件大小（人类可读）、各表条目数
- 「打开所在文件夹」按钮能高亮该文件

**留证**：migrate 面板导出后的截图 + 生成的文件路径。

### 9b. 控制台导入（先预览再确认）

1. 把导出的 `.ambpack` 复制到另一个位置，模拟「另一台设备拿到的文件」。
2. 点「从文件导入」→ 选中该文件。
3. **确认先出现预览**（导出时间、格式版本、条目计数、文件大小），**此时尚未写入任何数据**。
4. 再点「确认导入」。

**通过标准**：预览先于写入；导入后显示 `imported` / `skipped` / `conflicts`；重复导入同一文件时 `imported=0`。
**留证**：预览态截图 + 导入结果截图。

### 9c. CLI 交叉验证（不依赖 GUI，检查控制台是否说谎）

```powershell
cd D:\huange-skill
$cli = ".local\desktop-verify\packages\core\runtime\cli.js"

# 导出到新文件
node $cli backup --data-dir .local/desktop-verify-data --file .local/verify-1.ambpack --yes

# 预览（必须不写入）
node $cli restore --data-dir .local/desktop-verify-data --file .local/verify-1.ambpack

# 确认生效条目数没有变化
node $cli status --data-dir .local/desktop-verify-data
```

**通过标准**：`backup` 输出 `bytes`/`entries`/各表计数；`restore` 干跑只报 `wouldImport`，`entries` 保持不变。
**留证**：两次 `status` 的 `entries` 数字相同。

> **注意**：这里对**同一个库**做干跑导入，`wouldImport` 会是 `0`、`wouldSkip` 非零——因为内容本来就在库里，全部按重复跳过。这是**正确行为**，不是失败。想看非零的 `wouldImport`，请用 9d 里那个空库去预览。

### 9d. 跨设备真实迁移（最关键）

```powershell
cd D:\huange-skill
$cli = ".local\desktop-verify\packages\core\runtime\cli.js"

# 模拟「另一台设备」：全新数据目录
node $cli init  --data-dir .local/verify-deviceB --project project-demo --project-root .local/desktop-verify
node $cli status --data-dir .local/verify-deviceB      # 应为 entries=0, revision=0

# 导入归档
node $cli restore --data-dir .local/verify-deviceB --file .local/verify-1.ambpack --yes
node $cli status  --data-dir .local/verify-deviceB     # 应为 entries=2, revision=1
```

**通过标准**：设备 B 从 `entries=0` 变为 `entries=2`，`knowledgeRevision=1`，且能读到中文标题的流程。
**留证**：导入前后两次 `status` 输出。

### 9e. 安全性反向验证（必须做，不通过说明有缺陷）

```powershell
cd D:\huange-skill
$dsh = ".local/desktop-verify-data/dsh-client.json" | Get-Content | ConvertFrom-Json

# 用适配器（非 admin）凭据调用导出，必须被拒绝
$body = @{ projectId = $dsh.projectId; file = "D:\huange-skill\.local\should-not-exist.ambpack" } | ConvertTo-Json
try {
  Invoke-WebRequest -Uri "$($dsh.endpoint)/v1/backup/export" -Method POST -UseBasicParsing `
    -Headers @{ Authorization = "Bearer $($dsh.token)"; 'x-amb-protocol' = '1'; 'Content-Type' = 'application/json' } `
    -Body $body | Out-Null
  echo "缺陷：适配器凭据被允许导出"
} catch { echo "正确拒绝：HTTP $([int]$_.Exception.Response.StatusCode)" }
```

**通过标准**：HTTP **403**，且消息提示改走候选流程。
**留证**：状态码与消息文本。

### 9f. 损坏归档必须被拒绝

```powershell
cd D:\huange-skill
Copy-Item .local\verify-1.ambpack .local\verify-bad.ambpack -Force
$b = [System.IO.File]::ReadAllBytes((Resolve-Path .local\verify-bad.ambpack))
$b[[int]($b.Length/2)] = $b[[int]($b.Length/2)] -bxor 0xFF
[System.IO.File]::WriteAllBytes((Resolve-Path .local\verify-bad.ambpack), $b)
node .local/desktop-verify/packages/core/runtime/cli.js restore --data-dir .local/desktop-verify-data --file .local/verify-bad.ambpack --yes
```

**通过标准**：报 `Archive is not a readable backpack file`，且原库 `entries` 不变。

## 第 10 步：收尾

```powershell
cd D:\huange-skill
# 停掉核心终端（Ctrl+C），然后：
node scripts/amb-uninstall.mjs --data-dir .local/desktop-verify-data   # 只读检查，必须什么都不删
```

**通过标准**：只读模式下列出文件、打印人工步骤，**目录仍在**。

## 首轮执行结果（2026-10-10 22:24–22:38）

完整记录见 `2026-10-10-desktop-verification-run.md`。要点：

- **自动化与 CLI 全通过**：步骤 0、1、9c、9d、9e、9f、10 —— 通过。
- **GUI 部分通过**：9a 通过；9b 判为**失败**（结果面板缺 `conflicts` 显示）。
- **桌面宿主项全部未验证**（步骤 2–8）：未安装插件、未代点 hook 信任。原因是 computer-use 技能明确禁止代操作应用内的安全/隐私设置与权限请求，执行方没有绕过这条限制——这是**正确**的处置，不是执行失败。
- **执行方发现的缺陷（已修复）**：
  1. 迁移面板在 `conflicts` 为空时不显示该字段，导致"无冲突"与"此版本不检查冲突"无法区分。已改为始终显示条数，并新增回归测试。
  2. 控制台在核心停止后仍显示「已连接」——只有状态面板更新该指示，迁移面板的失败分支没更新。已让三个迁移调用的成功/失败分支都同步连接状态，并新增回归测试。
- **执行方对我的文档的更正**：产物清单是 **52** 个文件，我先前写的 46 是未核实的记忆值。已更正（见第 0 步）。
- **执行方指出的边界**：9b 的"预览不写入"只证明了业务计数未变，未以完整数据库快照证明；该更严格的子条件仍为未验证。这个区分是准确的。

**因此当前状态**：数据迁移链路已通过 GUI + CLI 双向验证；**桌面自动注入仍未验证**，这是接入与否的唯一决定性证据。

## 报告格式

每条按此填写，**填不满的项就是「未验证」**：

| 字段 | 值 |
|---|---|
| 步骤号 | |
| 宿主 | Codex / DSH |
| 宿主版本 | |
| 适配器版本 | |
| 时间 | |
| 项目 ID / 会话 ID | |
| 可观察结果 | 日志行 / 回执 / 截图路径 |
| 结论 | 通过 / 失败 / 未验证 |

## 判定规则（违反即报告作废）

1. **不得**把 shell 脚本输出当成桌面证据。
2. **不得**把「手动命令行能读」当作「桌面自动注入已实现」。
3. **不得**编辑信任哈希或绕过信任提示。
4. 做不到就记**未验证**；**不得**因为无法绑定项目或触发，就降级后宣称通过。
5. **不得**把 Codex 的结果外推到 DSH（两者安装路径不同）。
6. 任何 `*-client.json` / `core.json` 的内容**不得**进入报告。

## 已知会卡住的地方（如实写在这里，不要试图绕过）

1. **Codex 桌面信任入口未在运行时确认**。产物里存在 hooks 审阅 UI（`/settings/hooks-settings`），但不保证当前构建暴露它。找不到就记「未找到」，不要猜。
2. **Codex 桌面交互无法由脚本代操作**，必须真的点。
3. **DSH 安装路径从未验证过**，不得外推。
4. 第 3 步（注入）与第 8 步是**唯一能证明「自动」**的两项；只跑第 9 步的迁移测试**不能**证明桌面已接入。
