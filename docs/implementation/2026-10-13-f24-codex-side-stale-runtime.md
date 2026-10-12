# F24：Codex 侧插件的 runtime 是过期副本，整轮修复都没部署过去

- 日期：2026-10-13
- 发现场景：用 wincu 插件操控真实 Codex 会话，实测 Agent Memory Backpack 工具

## 1. 现象与根因

在真实 Codex 会话里让 Codex 调用 AMB 工具：

```
amb_prepare 返回当前项目知识版本号为 2。                       ← 成功
amb_search_universal 调用失败 … TypeError: tools.mcp__amb__amb_search_universal is not a function
```

`amb_prepare` 通、`amb_search_universal` 不存在——说明 **MCP 桥接本身正常，是插件代码旧**。

核对三处副本：

| 文件 | marketplace `runtime/` | Codex 缓存 `runtime/` | 仓库 `dist/src` |
|---|---|---|---|
| 文件数 | 14 | 14 | **20** |
| 与构建逐文件一致 | 1 / 14 | 1 / 14 | — |
| 含 `amb_search_universal` | ❌ | ❌ | ✅ |
| 缺失文件 | `capabilities/material/policy/semantic/service/ui.js`（6 个） | 同左 | — |
| 不一致文件 | 13 个 | 13 个 | — |

**结论：Codex 侧跑的是很旧的一份核心代码，之前整轮 R0–R4 的修复都没有部署到这一侧。**
`amb_search_universal`（BUG-M4 的修复）只是最先撞上的一个。

这解释了 F22 事件的完整因果：Codex 之所以被锁死，不只是"核心没跑"，还因为
**它那份钩子也是旧的 fail-closed 版本**——两件事同源：**Codex 侧的部署件整体过期**。

## 2. 修复

1. **重建** 仓库 `dist/src`（`npm run build`，退出 0）
2. **同步 marketplace `runtime/`** ← `dist/src/*`（先整目录备份）
3. **同步 Codex 缓存 `runtime/`** ← 同一来源
4. **重启核心**：停掉跑着旧代码内存的进程（PID 28344，命令行确认为 `marketplace/cli.js serve` 后才停），
   用新代码重启
5. **重启 Codex 的 MCP 服务**：停掉 PID 22388（父进程确认为 `codex.exe app-server`）

校验：三处 runtime **20/20 逐文件哈希一致**；`mcp.js` 含 `amb_search_universal`；
钩子含 `decideFromSnapshot`（修复版）；核心 `/v1/knowledge/search-universal` 返回 **200**。

## 3. 验证（真实 Codex 会话，非桩）

修复后让 Codex 重新调用：

```
amb_prepare 返回的知识版本号为 2。
amb_search_universal 搜索"测试"返回 34 条命中。
```

两个工具**均成功**。这同时验证了 F22 的修复——整个过程中 hook 日志是
`PreToolUse info` → `PostToolUse info` → `Stop`，**没有一次 deny**。

## 4. 一处我自己的事故（如实记录）

我用 `codex plugin remove` 想刷新缓存，但它**因文件被 ChatGPT.exe 占用而失败**，
且**已经删掉了缓存内容**，留下一个空目录——**我把 Codex 插件弄坏了**。

处置：
1. 立即从 marketplace 完整还原缓存（`Copy-Item -Recurse -Force`），
2. 校验 runtime 20/20 一致、scripts 7 个齐备且钩子是修复版、`.mcp.json`/`plugin.json`/`hooks.json`/`package.json` 均在；
3. 核对 `~/.codex/config.toml` **未被改动**（`plugins` 节、`marketplaces` 节、10 条 `hooks.state` 都在，
   `codex plugin list` 仍报 `installed, enabled`）——那次 remove 在改配置**之前**就退出了；
4. 重启 Codex 的 MCP 服务，并在真实会话里确认工具可用。

**教训**：对"正在被 GUI 占用的目录"做删除操作，先停掉占用方，或用复制覆盖而不是"删了再建"。
这次是我先删后建，中间出现了坏状态窗口；虽然已完全恢复，但正确的顺序本应是**先备份、再覆盖**。

## 5. 影响与后续

- **影响面**：任何"用旧 runtime 跑的 Codex 会话"都缺 R0–R4 的全部修复。评测、复现、以及真实使用都会受影响。
- **根治**：需要让 **marketplace 目录**的 `runtime/` 在每次构建后自动同步（现在靠手工）。
  建议加进 `scripts/package.mjs` 或本仓库的打包流程，否则下次构建后又会漂移。
- **风险**：本次同步改在 `node_modules`/`.local`/Codex 缓存内，重装插件会被覆盖；
  副本已另存于 `<USER_HOME>\.local\wincu-patches\` 与仓库 `.local/wincu/`。
