# 交给 Codex 的任务：验证 DSH 侧的宿主层接线

> 本文件由当前会话（DSH 侧总工程师）撰写，用于让 Codex 在**同一台机器**上完成 DSH 侧的宿主层验收。
> 背景与判据都写在这里，无需回读对话历史。**只做验证，不要改代码。**

## 背景（已由 DSH 侧完成的事实，可直接采信但欢迎复核）

- 项目：`agent-memory-backpack`（AMB），仓库根 `D:\huange-skill`，部署目录 `D:\harness\toolchains\DeepSeek-Harness-plugins\agent-memory-backpack`（同级的 `core` 是常驻核心）。
- 核心是**独立常驻服务，不随宿主退出**：监听 `127.0.0.1:47631`，协议 v1，请求需带 `x-amb-protocol: 1` 与 Bearer 凭据（凭据在数据目录的 `core.json`，**不要打印出来**）。
- 数据目录默认 `C:\Users\czx\.agent-memory-backpack`（`amb doctor` 会报，无需手填）。
- 本机**没有全局 `amb` 命令**，CLI 入口是：
  `D:\harness\toolchains\DeepSeek-Harness-plugins\core\runtime\cli.js`
- 本轮已完成并验证：
  - 存量候选分类回填已执行（430/430 待审带 `classifierVersion`，`r5-live-verify` 12/12）。
  - Codex 侧适配器五个 hook 已实测通过（SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop）。

## 请 Codex 验证的四件事

### 1. 重启宿主后确认接线被真实触发（这是本轮唯一没做过的步骤）

DSH 当前进程启动于本会话之前，**尚未加载最新插件构建**。需要：

1. 完整重启 DSH（以及 Codex 自身），然后**另外**重启常驻核心，否则会出现"适配器已更新、核心仍是旧代码"：
   ```powershell
   $cli = 'D:\harness\toolchains\DeepSeek-Harness-plugins\core\runtime\cli.js'
   node $cli service stop ; Start-Sleep 3 ; node $cli service start ; node $cli service status
   ```
   （核心重启会短暂中断 recall/prepare，属正常。）

2. 重启后**开一个新的 DSH 会话**，随便进行一次正常对话，然后查日志中是否出现**任务归档事件**：
   ```powershell
   node $cli logs --event task.archived --json
   ```
   **判据**：能看到 `task.archived` 事件（此前从未在真实宿主上出现过）。
   若查不到，请记录：DSH 重启时间、会话是否正常结束、以及 `node $cli logs --all-sources --level info | Select-Object -First 40` 的尾部输出。

3. 同时确认部署一致性：
   ```powershell
   cd D:\huange-skill ; node scripts/verify-host-deployment.mjs
   ```
   **判据**：报 `RUNNING DEPLOYED BUILD`。

### 2. 指针级注入（834 → 53 字符）

上一轮改动让"同一查询、版本未变"时只回指针而不是重发规范正文。**它在真实宿主上样本为 0**，因为没有重启过。

**怎么做**：在同一 DSH 会话里**连续发两条内容相同或高度相似的消息**，观察第二次注入的规范部分是否缩短为指针形态（53 字符级），而不是完整规范正文。

**判据**：第二次不再重复注入规范全文。
**注意**：这不是失败条件——若第二条仍注入全文，请记录两条消息的时间与注入文本长度，属**待排查**，不要下"功能坏了"的结论。

### 3. 面板三项目视确认（必须在界面上看，脚本替代不了）

在 DSH 界面中逐项确认并截图或记录原话文案：

1. **面板折叠区展开取回**：折叠的区块展开后能取回内容，而不是空白或报错。
2. **被拦候选不再一键采纳**：分类判定不通过的候选，界面上**不能**一次点击就采纳；应提示需要人工确认。
3. **审核预填端到端**：审核流程的预填信息正确带出（分类判定、理由、需要补的字段名 `classificationAcknowledged`）。

### 4. 复核一个已知缺陷：备份命令被拒

用户执行备份时被拒绝：

```
node <cli> backup --file D:\amb-backup-20261017.ambpack --yes
→ Credential-shaped content refused
```

**这是真实缺陷**：数据目录里的 `core.json` 含凭据，打包器的凭据形状扫描把整包拒了，于是**这台机器上无法备份**。

请只做**只读复现与定位**（不要改代码、不要绕过扫描）：
- 复现该命令，确认拒绝发生在扫描阶段而非写入阶段；
- 定位是哪一类内容触发了扫描（**不要打印任何凭据值**，只说字段名/文件名级别）；
- 结论请写成："拒绝原因 X，触发来源是 Y（文件/字段级），修复方向 Z，但未实施"。

## 硬约束

- **不要修改仓库代码、不要提交、不要部署**；本任务只做验证与记录。
- 真实库是用户的真实数据：只读操作优先；任何写操作（回填已做，不要重跑）先说明理由。
- 不要打印任何凭据、token 或 `core.json` 内容。
- 每条结论都要给出**命令 + 输出要点**，不接受"应该没问题"。
- 如果某项无法验证（例如界面打不开、重启会中断你自己的工作），**如实写"未完成 + 原因"**，不要用推测补齐。
