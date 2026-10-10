# 开源化与安装期采纳实现记录

**时间**：2026-10-10（Asia/Shanghai）
**触发**：用户明确项目将开源发布；并要求安装后主动扫描已有 skill/规范/记忆并安全存储，不得破坏既有或进行中的工作。

## 一、开源化改动

### 1. 新增开源必备文件

- `LICENSE`：MIT。
- `package.json`：补充 `license`、`keywords`；移除已无任何引用的 `@types/express`（该依赖随被废弃的 HTTP 管理界面方案引入，源码中已无 `express` 引用）。
- `.gitignore`：扩展以覆盖开源场景下的真实风险——凭据（`core.json`、`client.json`、`*-client.json`、`.env`）、运行时状态（`*.sqlite*`、`*.db`）、打包与提取产物（`artifacts/`、`.local/`）、以及测试运行可能在仓库内创建的宿主侧插件安装（`.agents/plugins/marketplace.json`、`.codex/config.toml`、`.codex/backups/`）。

### 2. 文档脱敏（58 处 → 0 处）

文档中的机器特定绝对路径会随开源泄露个人环境信息，已按固定映射替换：

| 原始形态 | 占位符 |
|---|---|
| 本仓库克隆的绝对路径 | `<PROJECT_ROOT>` |
| 本机 harness 数据目录 | `<DSH_HOME>` |
| 本机用户主目录（含用户名） | `<USER_HOME>` |

处理细节见 `2026-10-10-doc-path-sanitization.md`。**刻意保留未改**：`docs/plans/2026-10-09-joint-plan-final.md`，其 SHA256 已被双方审定锁定，改动会使审定失去可核对性。

### 3. 全新克隆可用性修复（关键）

**缺陷**：`test/dsh-target.mjs` 在模块加载期直接 `throw`，导致任何未提取桌面运行库的环境（即所有开源用户的首次克隆）在**导入阶段**就崩溃，整套测试无法运行。

**修复**：改为 `inspectRuntime()` 探测 + `requireRuntime()`：

- 运行库**缺失** → 相关测试带明确原因跳过，不计为通过；
- 运行库**版本不符** → 仍然硬失败，不会静默降级。

验证：设 `DSH_PROFILE_NODE_MODULES` 指向不存在目录，`test/dsh-adapter.test.mjs` 与 `test/dsh-runtime.test.mjs` 以 exit 0 结束，3 项跳过并给出原因；未提取运行库时 `npm test` 不再崩溃。

### 4. README 修正

原先存在两处对开源用户误导的内容：

- 目标运行库版本写作 `@deepseek-ai/* 0.1.7-rc.1`，但实际当前契约是 `0.2.0-rc.2`；
- 示例路径使用本机绝对路径。

两者均已修正，并补充了"缺少运行库时测试跳过而非通过"的说明。

## 二、安装期既有知识采纳（P2.5）

需求文档：`p2.5-existing-knowledge-adoption.md`。本轮已实现**扫描与报告**部分。

### 实现：`src/discovery.ts`

设计要点：

- **只读**：全程 `lstatSync`/`readdirSync`/`readFileSync`，无任何写操作；报告中的 `wrote` 字段恒为字面量 `false`。
- **不跟随符号链接**：用 `lstat` 而非 `stat`，链接被识别后记入排除项，避免越出项目边界。
- **排除优先于采纳**：凭据、宿主清单、可执行逻辑、二进制、运行时目录一律排除，且每条都带机器可读理由。
- **技能按完整流程归组**：`SKILL.md` 的 `references/`、`leaves/` 等同目录 Markdown 作为 `leaves` 随入口归组，不作为孤立片段；技能目录之外的散落 Markdown 明确排除，理由是"不构成完整方法"。这直接落实了用户"skill 必须按完整工作流程保存"的要求。
- **不做自动决策**：`diff()` 只标记 `new`/`duplicate`/`conflict`，冲突永不自动解决。
- **默认扫描根只返回真实存在的路径**，不虚构主机位置。

### CLI 接入

```powershell
node dist/src/cli.js discover [--roots PATH,...] [--data-dir DIR]
```

输出 JSON：`summary`、`scannedRoots`、`candidates`（含 `change`、`leafCount`、`leaves`）、`excluded`、`wrote`。若已存在核心库，`change` 会与库内条目比对。

### 真实环境验证结果

在开发机上扫描 5 个真实位置（`~/.dsh/AGENTS.md`、`~/.codex/AGENTS.md`、`~/.agents/skills` 等）：

```
roots=5 inspected=220 adoptable=22 (norm=2 skill=20) leaves=138 excluded=210 wrote=false
```

- 22 个候选，其中 14 个技能带叶子，共 138 个叶子文档正确归组；
- 210 项排除，理由分布：宿主配置/可执行逻辑 37、符号链接 12、非知识文档 21、重复内容 138、非法 UTF-8 1、技能外孤立 Markdown 1；
- 候选路径**无一条**位于 `node_modules`、`.git`、`cache`、`backups`、`credentials` 或 `.env`；
- 候选全部为 `.md`，无二进制混入；
- 报告 JSON 不含 U+FFFD，编码完好。

### 测试覆盖（8 项，全部通过）

1. 扫描只读：前后文件哈希签名完全一致，`wrote=false`；
2. 知识文档被采纳，宿主配置/凭据/可执行逻辑被排除；
3. 技能叶子随入口归组，不作为孤立片段；
4. 技能目录外的散落 Markdown 不被当作完整方法；
5. 排除理由机器可读且分类正确；
6. `node_modules` 与符号链接不被跟随；
7. 重复内容只报一次，同标题不同内容报冲突；
8. 默认扫描根只返回存在的路径。

## 三、验证状态

- `npm run build`：通过。
- `npm test`：**60 项测试，59 通过，0 失败，1 条件跳过**（打包冒烟测试需 `AMB_ARTIFACT_DIR`，属设计内跳过）。
- README 中的 `init` / `seed` / `status` 流程已在独立临时目录实测通过。
- 冻结文件 `joint-plan-final.md` 的 SHA256 仍与审定记录一致。

## 四、尚未实现（诚实边界）

- **采纳的写入与撤销**：本轮只实现扫描与报告。条目入插件库、一键撤销、安装期进度报告尚未实现。
- **真实桌面安装流程**：DSH/Codex 桌面端加载、信任与自动触发仍未实测。
- **周期性重扫描**：目前仅为一次性命令，宿主 `AGENTS.md` 更新后的同步机制未实现。
- 需求文档第八节的 4 个待确认项仍需用户决定（默认行为、重扫描频率、冲突处理、是否纳入仓库级约定文件）。
