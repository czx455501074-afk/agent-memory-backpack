# Electron 控制台弃用记录

**日期**：2026-10-16
**决定者**：项目负责人（YG）
**决定内容**：最终产品只保留两个控制面板——(A) Tauri 桌面版、(B) DSH 内嵌原生面板。Electron 控制台（`console/`）弃用，不再发布、不再部署。

## 为什么弃用

参照对象的技术栈最初被判断错了：cc-switch / codex-router 使用 **Tauri（Rust）**，而不是 Electron。
用户明确要求「参考它们的做法」，因此桌面壳改由 Tauri 承担，托盘与开机自启也一并迁移到 Rust 侧
（`auto-launch` crate + `tauri-plugin-single-instance`），与参照实现同层。

两套桌面壳并存既增加维护面，也让「哪个是正式版」变得含糊，因此收敛为一套。

## 归档位置

| 内容 | 原位置 | 现位置 |
|---|---|---|
| 源码 | `D:\huange-skill\console\` | `D:\huange-skill\console.archived-electron\` |
| 生产部署副本 | `D:\harness\toolchains\DeepSeek-Harness-plugins\console\` | `D:\harness\toolchains\DeepSeek-Harness-plugins\console.archived-at-20261016-201308\` |

两者均为**重命名归档，不是删除**，内容完整保留。

## 当时执行的停用动作（已实测）

1. 停止全部 Electron 托盘进程：按命令行过滤 `console/main.cjs` 确认残留为 **0**。
2. 检查注册表自启项：`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 无 AMB/Electron 相关条目。
3. 从发布链路移除（三处）：
   - `package.json` 的 scripts：移除 `console` / `tray` / `icon:make` / `dist:console`。
   - `scripts/package.mjs`：console 不再作为 artifact 输入（源码注释已说明）。
   - `scripts/deploy-plugin.mjs`：不再有 console 部署目标。
4. 移除 `devDependencies` 中的 `electron` 与 `electron-builder`（移除前已确认 `src/`、`test/`、`scripts/`、`adapters/` 及 Tauri 侧均无 electron 代码引用；`src/server.ts` 仅有一句注释提及）。

## 恢复方式

如需临时恢复该控制台用于对比或排障：

```powershell
# 1. 把源码改回原名
Rename-Item 'D:\huange-skill\console.archived-electron' 'console'

# 2. 恢复依赖（electron 与 electron-builder 已从 devDependencies 移除）
npm install --save-dev electron@^44.7.0 electron-builder@^26.15.3

# 3. 恢复启动（需先清除宿主继承的环境变量，否则 Electron 会以纯 Node 模式运行并被拒绝）
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
& '.\node_modules\electron\dist\electron.exe' '.\console\main.cjs' --tray
```

对应的生产部署副本如需恢复：

```powershell
Rename-Item 'D:\harness\toolchains\DeepSeek-Harness-plugins\console.archived-at-20261016-201308' 'console'
```

## 已知遗留（未清理，非本记录遗漏）

仓库根仍有历史备份目录 `*.backup-*`（含 `console.backup-*`）与测试遗留目录 `.amb-deploy-test-target-*`。
它们已在 `.gitignore` 中被忽略（`.gitignore:24` 与 `:25`），且部署脚本已加入轮转（每类保留最新 3 个），
因此不再增长。历史存量本身未删除——删除未经授权，建议由用户确认后自行清理。

## 未验证项

- 弃用后 Electron 相关代码未再做运行验证（归档前的运行证据见当时会话记录）。
- 恢复步骤中的 `npm install` 与启动命令按当时环境实测过，但未在归档后重新执行一遍。
