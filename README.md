# Agent Memory Backpack

让 DSH 与 Codex 两个桌面共享同一份本地知识（规范、经验、完整流程）的插件。

## 这是什么 / 我能不能用

**给谁用**：同时使用 DSH 和/或 Codex 桌面、希望两个 agent 遵守同一套规范并复用同一批经验的人。

**解决什么**：规范与经验目前散落在各 agent 自己的文件里，两端各写一份、互相不知道对方改了什么。这个插件把知识放到一个本地库里，两个桌面都从它读。

**当前状态**：**1.0**。核心功能已实测通过——知识读写与检索、提案审核、规范门禁、导出/导入迁移闭环（隔离库完成 11 张表计数一致的往返）。DSH 侧与管理面板已在真机验证；Codex 侧的加载、注入、门禁、停用等机制层已逐项验证，界面观感需你亲手确认一次（见下文安装步骤）。

**与同类项目相比，它多了什么**：目前开源的 agent 记忆方案（官方 MCP Memory、Mem0、Zep/Graphiti、Basic Memory、doobidoo MCP Memory 等）大多把记忆当作**一段可检索的文本**。AMB 把它当作**有版本、要审核、可门禁的知识**——每次修改留下修订史（可回溯、可取代），写入先落候选再由人采纳，还能用一条规范直接禁止某个工具调用。**它少了什么**：没有向量语义检索（用全文索引 + 归一化替代）、没有实体关系图谱、不做多模态。这三样都是刻意的取舍，不是未完成。

## 快速开始

### 前置条件

- Node.js **24.13–24.x**（实测 24.19）。使用内置 SQLite，无需额外数据库。
- Windows 系统（安装脚本针对 PowerShell）。

### 一键安装

```powershell
# 1. 获取源码并构建
git clone https://github.com/czx455501074-afk/agent-memory-backpack.git
cd agent-memory-backpack
npm ci --ignore-scripts
npm run build

# 2. 本地安装（自动初始化数据目录、生成凭据、运行自检）
npm run install:local

# 可选：同时安装到 Codex 工作区
npm run install:local -- --codex-workspace <工作区名称>
```

### DSH 侧：用宿主自己的插件命令装（推荐）

DSH 自带插件安装命令，它会把这个插件**注册进指定 profile**，不需要手工改配置：

```powershell
# 本地目录用 link:，也可以给 git 地址或 registry 包名
dsh plugin --profile desktop add D:\huange-skill\adapters\dsh
# 然后重启 DSH 生效
```

装完看 `~/.dsh/profiles/<profile>/package.json`，会在**两处**看到它：

```json
"dependencies": { "dsh-agent-memory-backpack": "link:..." },
"dsh": { "profile": { "bundles": [ "...", "dsh-agent-memory-backpack" ] } }
```

> **不要手工往 `cordis.patch.yml` 里 insert 本插件。** 它自带 bundle 补丁（`adapters/dsh/package.json` 的 `dsh.bundle.patch`），安装命令会自动注册；重复 insert 同一个 id 会让加载器因 duplicate loader entry id 拒绝启动。
>
> 这条已在 2026-10-17 实测：在一个**独立的临时 profile** 上跑到退出码 0，`bundles` 自动多了这一项，而 `cordis.patch.yml` **保持为空**（说明确实不需要手工补丁）。

**两件事是分开的**：上面的命令只负责**把插件装进 DSH**；**数据目录与凭据**由 `amb init`（或 `npm run install:local`）创建。两者都要做，先后不限。

上面 
pm run install:local 这个脚本会：
- 检查 Node 版本（必须 >=24.13.0 <25）
- 创建数据目录 `~/.agent-memory-backpack`
- 生成三组独立凭据（codex、dsh、admin）
- 运行离线自检，报告通过/失败项
- （可选）安装到 Codex 工作区并备份原配置

**重要**：脚本只打印凭据文件路径，永不打印 token 值。凭据文件权限设为仅所有者可读（`0600`），但 Windows 实际权限继承自数据目录 ACL，请确保该目录本身受保护。

### 安装后能用的命令

安装完成后，命令行里多一个 `amb`：

```powershell
amb --help                # 列出全部子命令
amb history --id <ID>     # 查看某个条目的修订沿革
amb backup --file <路径>  # 把全部数据打包成一个可迁移文件
amb ui --open             # 打开管理面板地址
```

也可以把它装进任意项目（只装命令，不跑上面的安装脚本）：

```powershell
npm install <本仓库路径>   # 装完即可用 node_modules/.bin/amb
```

> **尚未发布到 npm registry**，所以 `npx <包名>` 这条捷径目前走不通。上面两条路径都已实测：本地安装脚本、以及在同一台机器上把它当作依赖安装（命令可运行、版本一致）。

### 桌面加载插件

安装脚本完成后，还需在桌面 UI 中手动完成两步：

1. **加载插件**：桌面设置 → 插件管理 → 本地安装 → 选择 `~/.agent-memory-backpack`
2. **信任 hooks**（如果插件使用了 lifecycle hooks）：首次加载时桌面会提示，需明确允许

这两步的确切入口因桌面版本而异。如果找不到，请查阅对应桌面的插件文档或 `docs/implementation/p0-desktop-runbook.md`。

**为什么不能全自动**：桌面的插件加载与信任机制需要用户在 UI 中确认，CLI 脚本无法代劳。这是安全设计，不是缺陷。

### 启动核心服务

**不需要手动启动。** 插件在加载时会自己把核心拉起来：先探测，没有就启动一个，失败只记录不抛错。核心是共享服务而非某个插件的子进程，所以它会活到两端都不再需要为止。

这一点在协议层也有兜底——核心不可达时，受治理的工具调用会被明确拒绝，而不是假装成功。你会在工具回执里看到 `core is unavailable`，看到它就说明核心真的没起来，不是模型在含糊其辞。

需要手动排查时才用：

```powershell
node dist/src/cli.js serve --data-dir "$HOME/.agent-memory-backpack"
```

核心默认监听 `127.0.0.1:47631`。插件会自动启动它，手动启动一个用来观察日志即可；端口已被占用时不要再起第二个。

### 部署插件到宿主 profile

打包只会生成产物，产物放进 profile 才被宿主加载。这三件事必须一致，少一件就会出现"代码在磁盘上，宿主却加载旧版"：

```powershell
npm run pack:local       # 生成产物
npm run deploy:plugin    # 放到稳定目录，并在每个 profile 里更新依赖、启用状态和链接
```

部署脚本会**读穿链接复核**，失败即报失败。改完重启宿主生效。

> 为什么不能只改配置：profile 的 `package.json` 记录的是意图，宿主运行时解析的是 `node_modules` 下的链接。只改前者不会移动已有的链接——这正是"改完重启却毫无变化"的成因。

### 验证是否工作

```powershell
node dist/src/cli.js doctor
```

自检会逐项诊断：
- 配置文件格式
- 数据库完整性
- 核心服务可达性
- 协议版本匹配

失败项会附带可执行建议，从不打印凭据值。

## 数据迁移：跨设备携带你的知识

### CLI 方式

```powershell
# 数据目录（安装脚本的默认位置；用 --data-dir 指定其他位置）
$AMB = "$HOME/.agent-memory-backpack"

# 导出（打包为单文件）
node dist/src/cli.js backup  --data-dir $AMB --file backup.ambpack --yes

# 预览（不导入，只检查内容）
node dist/src/cli.js restore --data-dir $AMB --file backup.ambpack

# 导入（合并到当前库）
node dist/src/cli.js restore --data-dir $AMB --file backup.ambpack --yes
```

- `backup` 生成 `.ambpack` 文件，包含全部知识、经验、历史版本。`--yes` 确认写入，否则只干跑。
- `restore` 不带 `--yes` 时只检查归档（导出时间、条目计数、文件列表），不触碰数据库。
- `restore --yes` 合并归档到当前库，重复条目会跳过，不覆盖本地更新。

### 控制台方式（更直观）

控制台是 Electron 桌面应用，需要指向 admin 凭据（否则无权审阅和导入）：

```powershell
npm run console -- --config="$HOME/.agent-memory-backpack/admin-client.json"
```

提供「数据迁移」面板，支持：
- 导出全部数据（弹保存对话框，自动带时间戳文件名）
- 从文件导入（弹打开对话框，先预览再确认，显示导入统计）
- 导出后直接打开文件所在文件夹

## 采纳你已有的知识

插件可以扫描你机器上**已经存在**的规范、偏好与技能，把它们收进共享库，让两个桌面都读到同一份。

```powershell
$AMB = "$HOME/.agent-memory-backpack"

# 1. 只读扫描，报告发现了什么（不写任何东西）
node dist/src/cli.js discover --data-dir $AMB

# 2. 干跑：说明会采纳哪些（仍然不写）
node dist/src/cli.js adopt --data-dir $AMB

# 3. 确认采纳
node dist/src/cli.js adopt --data-dir $AMB --yes

# 4. 撤销这一批（只撤回该批次，已被你编辑过的条目会保留）
node dist/src/cli.js adopt --data-dir $AMB --revoke <时间戳>
```

扫描**全程只读**：不写入、不重命名、不改动任何宿主文件。采纳只写插件自己的数据库，源文件的哈希前后一致。输出里的 `wrote` 字段恒为 `false`。

后续源文件变了，可以重扫并按"最新记录为准"刷新：

```powershell
node dist/src/cli.js rescan --data-dir $AMB --roots "$HOME/.agents/skills"
node dist/src/cli.js rescan --data-dir $AMB --roots "$HOME/.agents/skills" --yes
```

四类判定：`new` 采纳、`unchanged` 不动、`changed` 刷新、`vanished` **只报告不自动退场**（路径可能只是暂时缺失，据此删知识是破坏性的）。

失效的经验不要静默改，而是留下理由和证据：

```powershell
node dist/src/cli.js supersede --data-dir $AMB --old OLD_ID --new NEW_ID `
  --action supersede --reason "为什么旧的不对" --evidence "什么任务里验证的"
```

旧版本退场但**永久保留在历史里**，`--action supplement` 则让两者并存。查血缘用 `history --id ID`。

把知识导出成普通 `SKILL.md`，脱离本插件也能用：

```powershell
node dist/src/cli.js export --data-dir $AMB --dir .agents/skills/amb --yes
```

导出的是标准 Markdown，没有插件专有字段，宿主可原生读取。

## 管理界面

界面由核心自己提供，不需要安装任何桌面程序，也没有要额外开着的窗口：

```powershell
node dist/src/cli.js ui --open     # 打印地址并打开浏览器
```

打开后可以查看状态总览、规范、候选、技能与记忆、任务。

**为什么是网页而不是桌面应用**：核心本来就一直开着，网页只是它多提供的一个地址，因此不需要第二个进程、不需要额外运行时，也可以直接放进宿主自己的浏览器面板里。核心在跑，界面就在。

**这个地址含管理凭据**（在 URL 片段里，浏览器不会把它发给服务端，因此不进请求日志），页面读完就把它从地址栏清掉、只留在内存中。**不要外发或贴到聊天里**。

安全边界保持不变：核心仍然拒绝其它来源的浏览器请求（只放行它自己这个源），并且所有数据接口都要求凭据——同源不等于免认证。

### 已归档：Electron 桌面控制台

早期版本提供过一个 Electron 控制台。**它已下线，不再随发行产物提供**——产品线只保留两条：**Tauri 桌面版**与 **DSH 内嵌面板**（见上文）。源码保留在 `console.archived-electron/`，原因与迁移说明见 [`docs/implementation/electron-deprecation.md`](docs/implementation/electron-deprecation.md)。下面这段保留是为了让旧安装的人知道该往哪走：

```powershell
# 旧命令（已不再受支持）
# npm run console -- --config="$HOME/.agent-memory-backpack/admin-client.json"
```

## 卸载

```powershell
# 1. 只读检查（列出数据目录内容，打印人工步骤，不删除任何东西）
npm run uninstall:local

# 2. 真实删除数据目录（需二次确认）
npm run uninstall:local -- --purge-data --yes
```

卸载脚本**只删除数据目录**（`~/.agent-memory-backpack`），不影响：
- 你的原始 skills 文件
- AGENTS.md 或其他项目配置
- 其他插件
- node_modules 或宿主 profile

删除数据目录等于抹掉全部本地知识，无法恢复。导出归档可用于备份。

## 已实现的核心能力

- ✅ SQLite 单一权威库、当前版本和历史隔离、修订冲突检测
- ✅ 完整流程分类索引、中文关键词召回、分阶段读取
- ✅ 两端独立凭据，限定项目的规范读取、明确工具名拒绝
- ✅ MCP stdio 工具；Codex lifecycle hooks 与 DSH 原生适配器
- ✅ 候选只进待处理队列，不会因 agent 提交就自动生效
- ✅ 安装期既有知识采纳：只读扫描 → 差异报告 → 显式采纳 → 一键撤销
- ✅ 周期性重扫描：`new` / `unchanged` / `changed` / `vanished` 四类判定
- ✅ 经验演进：推翻（旧版退场但永久留存）与补充（两者并存），必须附理由与证据
- ✅ 权限分离：适配器凭据只能读取与提交候选；审阅、推翻、导入必须用管理凭据
- ✅ 单文件归档导出导入（`.ambpack`），零外部依赖，跨设备迁移

## 两个桌面怎么共用同一份数据

不需要你配任何东西。两端都默认读取同一个数据目录，各取自己那份凭据：

```
~/.agent-memory-backpack/
├── core.json           核心配置（端口、项目）
├── knowledge.sqlite    ← 唯一的知识库，两端共用
├── dsh-client.json     DSH 读这份
├── codex-client.json   Codex 读这份
└── admin-client.json   控制台读这份（审阅/迁移需要）
```

三份凭据的 `endpoint` 和 `projectId` 相同，只有 token 与角色不同——所以是**一个核心、一个库**，而权限仍然分离。DSH 用 `dsh-client.json`、Codex 用 `codex-client.json`，名字不同、目录相同，解析结果必然落在同一个库上。

想放到别处（或做隔离测试）用环境变量覆盖：`AMB_DSH_CONFIG`、`AMB_CONFIG`、`AMB_CONSOLE_CONFIG`。**覆盖只在指向的文件确实存在时生效**：写错的路径会打印一条警告并回落到共享默认目录，而不是让插件直接失效。

本端专属凭据缺失时会回落到遗留的 `client.json`（旧版把它写给 Codex），这一回退**同样会打印警告**：该文件带着 endpoint、token、项目与角色，直接沿用可能让这一端以另一端的项目或角色行事。看到这条警告就运行一次 `init` 重新生成专属凭据。

## 注入与去重

- **同版本去重由适配器负责**，不是核心。适配器把已注入的知识版本记在自己的会话状态里，版本未变时只回一个"内容未变"的指针，不重复发送规范正文；版本变化或换新会话则重新注入。核心不按会话去重——它没有会话概念，同一个 `prepare`/`gate` 请求在任何时候都返回该版本应有的内容。
- **预算只约束注入正文**：规范正文超预算时按配置省略并逐条说明原因，但**禁止类规范一律完整保留**，工具的放行/拒绝判定也不受预算影响。省略的是"发给模型的文字"，不是"执行的规则"。
- **门禁按工具名匹配，不解析命令语义**：规范里写"禁止 `Bash`"不会连带禁止 `pwsh`（名字不同就是不同工具，不做别名归并）。当规范禁止了写类工具而模型改用 shell 写入时，适配器会对 `>`、`>>`、`tee`、`touch`、`mkdir`、`Set-Content`、`Out-File`、`dd of=` 这类**明确的写文件写法**做启发式拦截，并在拒绝理由里说明这是启发式；`python -c`、`node -e` 等间接写入**不在覆盖范围内**。要真正阻止写入，请同时禁止对应的 shell 工具，或使用只读沙箱。

## 隐私与信任：三个常见问题

**Q: 会不会把我的数据传到外部？**  
A: 不会。核心只监听 `127.0.0.1:47631`，代码中没有任何对外网络出口；带浏览器 `Origin` 头的请求会被直接拒绝。

**Q: 会不会改我的文件？**  
A: 不会。扫描全程只读；采纳只写插件自己的数据库，源文件哈希前后一致。`discover` 会明确返回 `wrote=false`。

**Q: 凭据文件安全吗？**  
A: 文件权限设为 `0600`（仅所有者可读写），但 Windows 实际权限继承自数据目录 ACL。**任何以你的用户身份运行的进程都能读取这些文件**，这是操作系统的基本事实，不是插件的缺陷。保护数据目录本身，或将 admin 凭据放到单独目录（安装时用 `--admin-dir`）。

## 出问题怎么办

```powershell
node dist/src/cli.js doctor          # 逐项诊断，失败项附可执行建议
node dist/src/cli.js logs            # 核心运行日志
node dist/src/cli.js logs --source plugin   # 插件日志（核心不可达时仍有记录）
```

常见报错对照：

| 报错 | 原因与处理 |
|---|---|
| `Cannot find module '...\dist\src\cli.js'` | 尚未构建，先 `npm run build` |
| `Core is not initialized for this data dir` | 该数据目录未初始化，运行安装脚本或 `cli init` |
| `Cannot start core. Check whether this configured port is already in use.` | 端口被占用，换 `--port` |
| `Configuration or import schema is invalid` | 某条内容不符合 schema（如正文超长），检查日志中的文件路径 |
| `Console cannot start: ELECTRON_RUN_AS_NODE is set` | 见上文「控制台管理面板」 |

## 本机开发

要求 Node.js 24.13 或以上的 24.x 版本。当前验证 Node 24.19，使用内置 SQLite。

```powershell
npm ci --ignore-scripts
npm run build
npm run check           # 类型检查，应退出码 0
npm test                # 见下面的「测试前置条件」
npm run pack:local      # 生成可分发的产物
```

### 测试前置条件

干净检出的 `npm test` 是 **315 通过 / 14 跳过**。全部失败数为 0；跳过的 14 项都缺少本机前置条件，
**带原因跳过，不计为通过**。补齐后为 **329 通过 / 0 跳过**：

| 跳过项 | 数量 | 需要什么 |
|---|---|---|
| Electron 桌面控制台 | 5 | `node_modules/electron` 的 Electron 二进制（`npm ci` 未下载时缺失） |
| 真实 DSH 运行库 | 8 | `.local/dsh-runtime-0.2.0-rc.2/node_modules`，或设 `DSH_PROFILE_NODE_MODULES` 指向别处 |
| 打包产物冒烟 | 1 | `npm run pack:local` 后设 `AMB_ARTIFACT_DIR` 为产物根目录 |

```powershell
# 提取真实 DSH 运行库（只读桌面归档，不运行安装脚本，不改宿主）
python scripts/extract-dsh-runtime.py "<桌面安装目录>/resources/app.asar" .local/dsh-runtime-0.2.0-rc.2

# 打包并跑打包产物冒烟
npm run pack:local
$env:AMB_ARTIFACT_DIR = (Get-Content artifacts/latest.json | ConvertFrom-Json).directory
npm test
```

运行库目标契约为 `@deepseek-ai/* 0.2.0-rc.2`、Cordis 4.0.4；版本不符时这些测试**直接失败**（不是跳过）。
前置条件与产物均为本地生成、已在 `.gitignore` 中，不随仓库分发。

> PowerShell 示例使用 `$HOME`，需要 PowerShell 7（`pwsh`）。在 Windows PowerShell 5.1 下请改用 `$env:USERPROFILE`。

## 项目结构速查

```
src/
  cli.ts          CLI 入口（init, serve, backup, doctor, logs 等）
  server.ts       HTTP 核心服务（协议 v1）
  store.ts        SQLite 存储层，全部 SQL 与事务逻辑
  backup.ts       目录形式导出导入（权威实现）
  archive.ts      单文件 .ambpack 归档（零依赖 tar+gzip）
  mcp.ts          MCP stdio 适配器
  console.ts      Electron 控制台入口
adapters/
  dsh/            DSH 原生适配器（Cordis 插件）
  codex/          Codex lifecycle hooks
test/             189 项测试，覆盖协议、存储、归档、适配器
scripts/
  amb-install.mjs    一键安装脚本（环境检查、初始化、自检）
  amb-uninstall.mjs  卸载脚本（只读检查或真实删除）
docs/
  architecture/   设计文档（协议、存储、权限模型）
  implementation/ 实现细节（桌面集成 runbook、测试策略）
```

## 许可证

MIT
