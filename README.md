# Agent Memory Backpack

> 让 DSH 与 Codex 两个桌面共享同一份**有版本、要审核、可门禁**的本地知识。

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-24.13--24.x-brightgreen.svg)
![Platform](https://img.shields.io/badge/platform-Windows%20x64-lightgrey.svg)
![Protocol](https://img.shields.io/badge/protocol-v1-blue.svg)
![Contracts](https://img.shields.io/badge/contracts-39%2F39-brightgreen.svg)
![Tests](https://img.shields.io/badge/tests-816%20passing-brightgreen.svg)
![Storage](https://img.shields.io/badge/storage-SQLite%20(local)-informational.svg)

规范与经验今天散落在每个 agent 自己的文件里：你在 DSH 里立了一条规则，Codex 不知道；你在 Codex 里踩过一次坑，下次在 DSH 里照样踩。**Agent Memory Backpack（AMB）** 把这件事收到一个本地库里——两端都从它读、都往它写，而写入要经过审核，改动留下修订史，一条规则可以直接拦住某个工具调用。

核心是一个只监听 `127.0.0.1` 的本地服务加一个 SQLite 文件。没有云端、没有外部推理、没有账号。

---

## 为什么

**现在的做法各有短板。**

- **各写各的 `AGENTS.md`**：两端各存一份，互相不知道对方改了什么，也没人知道哪条还有效。
- **聊天历史当记忆**：能回看对话，但不是结构化知识，检索靠关键词碰运气，改不了、也撤不回。
- **RAG / 向量库**：能读，但通常不能写回；基础设施重，数据常在别人机器上。
- **知识图谱**：结构好，但要专门的工具链维护，日常使用成本高。

**AMB 的选择**：把记忆当作**知识**而不是**文本**。

- **有版本**：每次修改是一条修订，可回溯、可取代、可按时间点看当时的库。
- **要审核**：agent 提交的只能是**候选**，采纳是人（或明确授权的入口）的动作，门禁在服务端强制。
- **可门禁**：一条规范可以按工具名直接拒绝调用，拒绝理由写清是哪条规则拦的。
- **本地**：一个 SQLite 文件、一个本地服务，凭据分离，无对外网络出口。

**与同类项目相比**：目前开源的 agent 记忆方案（官方 MCP Memory、Mem0、Zep/Graphiti、Basic Memory、doobidoo MCP Memory 等）大多把记忆当作**一段可检索的文本**。AMB 多出来的是**版本 + 审核 + 门禁**这一层。**它少什么**：没有实体关系图谱、不做多模态。这些是刻意的取舍，不是没做完（向量检索是可选的，默认关闭，见下文）。

---

## 快速开始

**前置**：Windows x64、Node.js **24.13–24.x**（实测 24.19）。用 Node 内置 SQLite，不需要另装数据库。

```powershell
git clone https://github.com/czx455501074-afk/agent-memory-backpack.git
cd agent-memory-backpack
npm ci --ignore-scripts
npm run build

# 一条命令装齐：插件 + 核心 + 桌面控制台 + 开机自启
node scripts/amb-install.mjs --start
```

九步：环境检查 → 构建 → 数据目录与凭据 → 同步本机已有知识 → Codex 插件（可选）→ **桌面控制台（托盘）** → **开机自动启动** → 启动核心 → 自检。

**装完的状态**：核心作为常驻服务运行；DSH 与 Codex 的适配器就位；桌面控制台驻留托盘（启动即隐藏、不占任务栏；托盘菜单可显示/隐藏主窗口、检查核心连接、切换开机自启、彻底退出）；核心与桌面端各写一条 `HKCU` 的 Run 项，登录后自动就位。

常用开关：`--dry-run`（只打印将执行的命令，不写任何东西）、`--no-desktop`、`--no-startup`、`--no-sync`、`--codex-workspace PATH`、`--build`（强制重建）。

桌面控制台用的是 `desktop-tauri` 的构建产物（NSIS 安装包）。没构建过时会跳过并打印构建命令——它需要 Rust 工具链，属于一次性前提，脚本不替你装。

### 只想用桌面窗口

从 [Releases](https://github.com/czx455501074-afk/agent-memory-backpack/releases/tag/v1.0.0) 下载 `Agent Memory Backpack_1.0.0_x64-setup.exe`（NSIS）或 `.msi`，发行说明里附了 SHA256。主窗默认隐藏、驻留托盘，由托盘菜单唤出。

> 桌面版只支持 Windows x64；macOS 与 Linux 不在本次范围内。

---

## 它能做什么

- **SQLite 单一权威库**：当前版本与历史隔离，修订冲突会被检测出来而不是静默覆盖。
- **候选 → 审核 → 采纳**：agent 提交的只进待处理队列，不会因为提交就生效。
- **服务端强制的类别门禁**：类别由插件判定，"经验型文本"不能直接采纳为可执行门禁的规范；需要确认时，被拒绝的回执会说明**为什么**要确认、以及**怎么做**。
- **经验演进留痕**：推翻（旧版退场但永久保留）与补充（两者并存），必须附理由与证据。
- **权限分离**：适配器凭据只能读取与提交候选；审阅、推翻、导入必须用管理凭据。
- **规范可被检索到**：规范不再是唯一"搜不到"的类别，一条存在库里的规则用它的原话就能搜到；排序按长度归一，短规则不会被引用了同一句话的长日记压下去。
- **回执如实**：一次检索命中了哪些片段、哪些没命中，按真实结果报告；被选中的条目会标明选择来自哪条路径。
- **同版本不重复注入**：会话内知识版本未变时只回一句指针（实测 834 → 53 字符），版本变化或新会话才重新发送正文。
- **完整流程分类索引**：中文关键词召回、分阶段读取，逐阶段检查项按需读取而不是一次性灌进上下文。
- **安装期既有知识采纳**：只读扫描 → 差异报告 → 显式采纳 → 一键撤销。
- **周期性重扫描**：`new` / `unchanged` / `changed` / `vanished` 四类判定，消失只报告不自动退场。
- **单文件归档迁移**：`.ambpack` 零外部依赖，跨设备携带全部知识、经验与历史版本。
- **任务不会无限期挂着**：长时间无进展的任务收敛为暂停并写明原因；**完成永远不由时钟判定**。
- **可选向量检索**：默认关闭；配了嵌入服务才启用，覆盖率不足拒绝融合，失败回落词法（见[配置](#配置)）。

---

## 怎么工作

一次真实的使用循环：

```
你在会话里踩到一个坑 → agent 调用 amb_submit_experience 提交候选（不生效）
                     → 你（或管理界面）审核并采纳
                     → 下一次会话，amb_prepare 把这条经验注入上下文
                     → 两个桌面读到的是同一条
```

**架构**：

```
DSH 适配器 ─┐
            ├─→ 本地核心（HTTP，127.0.0.1:47631，协议 v1）→ knowledge.sqlite
Codex hooks ┘
MCP stdio  ─┘        ↑ 网页管理界面与桌面控制台都连它
```

适配器只通过 HTTP 与核心通信，不 import 核心代码。核心是共享服务而不是某个插件的子进程，插件加载时会自己把它拉起来（探测 → 启动 → 失败只记录不抛错）。

**数据在哪**：

```
~/.agent-memory-backpack/
├── core.json           核心配置（端口、项目）
├── knowledge.sqlite    ← 唯一的知识库，两端共用
├── dsh-client.json     DSH 读这份
├── codex-client.json   Codex 读这份
└── admin-client.json   控制台读这份（审阅/迁移需要）
```

三份凭据的 `endpoint` 与 `projectId` 相同，只有 token 与角色不同——所以是**一个核心、一个库**，而权限仍然分离。

---

## 接上你的客户端

| 客户端 | 接入方式 | 说明 |
|---|---|---|
| **DSH** | 原生适配器（Cordis 插件，自带 bundle 补丁） | 工具、面板、生命周期 hooks 全部内建 |
| **Codex** | lifecycle hooks + 工作区插件 | 或走下面的 MCP |
| **任意 MCP 客户端** | stdio MCP server | 16 个 `amb_*` 工具，见[命令速查](#命令速查) |
| **浏览器** | 核心自带的管理界面 | `amb ui --open`，不需要另装程序 |

---

## 安装

### 路径一：一条命令（推荐）

见[快速开始](#快速开始)。它把插件、核心、桌面控制台、开机自启一次装齐，装完跑自检。

### 路径二：从 GitHub 直接装适配器

**适配器可以单独从 GitHub 装**，不必先 clone——但要用 **pnpm 12 或以上**：`dsh` 内嵌的 pnpm 11 会**丢弃 `path:` 参数**，把仓库根当成插件装上，然后警告它没有 `dsh.bundle`。

```powershell
cd "$HOME/.dsh/profiles/<你的 profile>"
pnpm add "github:czx455501074-afk/agent-memory-backpack#<sha>&path:adapters/dsh"
```

装完把包名登记进 `dsh.profile.bundles`（用 `dsh plugin add` 会自动写；手工装要自己写）：

```json
{ "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-agent-memory-backpack"] } } }
```

**核心需要构建产物**，所以它不走 git 直装（仓库不含 `dist/`）：

```powershell
git clone https://github.com/czx455501074-afk/agent-memory-backpack.git
cd agent-memory-backpack && npm ci && npm run build
```

**让装来的适配器找到这个核心**：把 `AMB_CORE_ENTRY` 指向它的 `cli.js`。

```powershell
$env:AMB_CORE_ENTRY = "$PWD/dist/src/cli.js"
```

适配器找不到核心时会报 `core-entry-missing`——只报告、不崩。`AMB_CORE_ENTRY` 就是给"适配器与核心不在一起"的安装准备的出口；核心 CLI 自己的 `service` 子命令读的是同一个变量，所以只需命名一次。

### 路径三：装进 DSH 的某个 profile

```powershell
# 在仓库根目录执行：本地目录用 link:，也可以给 git 地址或 registry 包名
dsh plugin --profile <profile> add "$PWD\adapters\dsh"
# 然后重启 DSH 生效
```

`<profile>` 换成你的 profile 名（例如 `desktop`、`web`）。`$PWD` 是当前仓库所在目录，所以这条命令在任何人的机器上都成立——不要照抄某台机器的绝对路径。

> **不要手工往 `cordis.patch.yml` 里 insert 本插件。** 它自带 bundle 补丁（`adapters/dsh/package.json` 的 `dsh.bundle.patch`），安装命令会自动注册；重复 insert 同一个 id 会让加载器因 duplicate loader entry id 拒绝启动。

### 更新到最新版本

上面三条路径装的都是**某一刻的快照**——产物不会自己跟进仓库。仓库前进之后要更新，重跑同一套流程即可（每次都从最新提交构建）：

```powershell
git clone --depth 1 https://github.com/czx455501074-afk/agent-memory-backpack.git "$env:TEMP\amb-latest"
cd "$env:TEMP\amb-latest"
npm ci --ignore-scripts
npm run build
npm run pack:local

# DSH 侧：部署到稳定目录并重新接线（核心在跑时先停核心，否则目录被占用）
node scripts/deploy-plugin.mjs --artifact (Get-Content artifacts/latest.json | ConvertFrom-Json).directory

# Codex 侧：把产物的 .agents 与 codex-plugin 覆盖到 marketplace 根目录，再重启 Codex
```

**怎么确认装的是哪一版**：比对部署副本与新产物的文件哈希，或查一个只在某次提交之后才存在的标记字符串。举例：`AMB_CORE_ENTRY` 是 `80f1082` 引入的——若部署副本的 `hook.mjs` / `index.mjs` 里搜不到它，那就是旧版。

### 桌面里还要做两步

1. **加载插件**：桌面设置 → 插件管理 → 本地安装 → 选择数据目录或打包产物里的 `dsh-plugin`。
2. **信任 hooks**（若插件使用 lifecycle hooks）：首次加载时桌面会提示，需明确允许。

这两步的确切入口因桌面版本而异。**为什么不能全自动**：桌面的加载与信任机制需要用户在 UI 中确认，CLI 无法代劳。这是安全设计，不是缺陷。

### 部署到宿主 profile（从源码改完代码时）

打包只生成产物，产物放进 profile 才被宿主加载。这三件事必须一致，少一件就会出现"代码在磁盘上，宿主却加载旧版"：

```powershell
npm run pack:local       # 生成产物
npm run deploy:plugin    # 放到稳定目录，并在每个 profile 里更新依赖、启用状态和链接
```

部署脚本会**读穿链接复核**，失败即报失败。改完重启宿主生效。为什么不能只改配置：profile 的 `package.json` 记录的是意图，宿主运行时解析的是 `node_modules` 下的链接。

---

## 命令速查

### CLI

```powershell
amb --help                # 列出全部子命令
amb --version             # 打印版本
amb setup                 # 建数据目录与凭据，并打印装进宿主的精确命令
amb ui --open             # 打开管理界面
amb doctor                # 逐项自检，失败项附可执行建议
amb logs                  # 核心运行日志（--source plugin 看插件日志）
amb history --id <ID>     # 某个条目的修订沿革
amb asof --at <时间>      # 知识库在某刻的样子（只读）
amb backup --file <路径>  # 打包全部数据成一个可迁移文件
amb restore --file <路径> # 预览或导入归档
amb service status        # 常驻核心状态；enable-startup / disable-startup 管开机自启
amb embed                 # 为可选向量层生成向量（默认干跑）
```

> **尚未发布到 npm registry**，所以 `npx <包名>` 目前走不通。想只装命令：`npm install <本仓库路径>`，装完用 `node_modules/.bin/amb`。

### 工具（MCP / 适配器暴露给 agent 的 16 个）

| 工具 | 用途 |
|---|---|
| `amb_prepare` | 任务开始前准备知识上下文（检索 + 规范注入） |
| `amb_search_universal` | 跨全部条目检索（技能/规范/流程/记忆/日记） |
| `amb_search_workflows` | 检索完整流程，返回入口 |
| `amb_read_knowledge` | 读条目正文，可连同参考文档 |
| `amb_read_stage` | 读某个流程的单个阶段与其依赖完整性 |
| `amb_submit_experience` | 提交候选经验（进待审队列，不生效） |
| `amb_supersede_experience` | 取代或补充已有经验（需理由与证据） |
| `amb_retire_knowledge` | 停用某条目（可逆，历史保留） |
| `amb_knowledge_history` | 查看条目的版本沿革 |
| `amb_checkpoint_task` | 保存任务进展、未完成项与日记 |
| `amb_task_activity` | 读当前会话的任务与事件回执 |
| `amb_save_material` | 保存外部参考材料（带来源 URL） |
| `amb_inspect_archive` | 读 `.ambpack` 归档清单，不导入 |
| `amb_unstructured_skills` | 列出尚未结构化的技能 |
| `amb_structure_skill` | 把技能转成真正的流程 |
| `amb_self_check` | 插件自检：配置、核心可达性、协议匹配、版本 |

---

## 配置

### 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `AMB_DSH_CONFIG` / `AMB_CONFIG` | 数据目录下的 `dsh-client.json` | 覆盖适配器读的凭据路径 |
| `AMB_CONSOLE_CONFIG` | 数据目录下的 `admin-client.json` | 覆盖管理界面用的凭据 |
| `AMB_CORE_ENTRY` | 适配器旁的 `runtime/cli.js` | 适配器与核心不在一起时，指明核心入口 |
| `AMB_EMBEDDING_ENDPOINT` + `AMB_EMBEDDING_MODEL` | 未设置 = 关闭 | 启用可选向量层（OpenAI 兼容的 `/embeddings`） |
| `AMB_EMBEDDING_KEY` | 无 | 向量服务的鉴权（需要时） |
| `AMB_ARTIFACT_KEEP` | `3` | 打包副本保留份数 |

**覆盖只在指向的文件确实存在时生效**：写错的路径会打印一条警告并回落到共享默认目录，而不是让插件直接失效。本端专属凭据缺失时会回落到遗留的 `client.json`，这一回退**同样会打印警告**（该文件带着 endpoint、token、项目与角色，直接沿用可能让这一端以另一端的项目或角色行事）。

### 可选向量检索

默认**关闭**：未配置时行为与引入该层之前完全一致（连并发时序都不变）。配置后：

- 融合用 **RRF**（按 rank 而不是归一化分数）；
- **覆盖率不足拒绝融合**（可嵌入条目 ≥5 且已有向量 ≥50%）——少数向量决定数百条的排序比词法更差，而且看起来一样自信；
- **失败只降级**：服务不可用即回落词法，并在回执里写明 `vector.reason`；
- 生成入口 `amb embed [--limit N] [--yes]`（默认干跑）。

---

## 数据迁移

```powershell
$AMB = "$HOME/.agent-memory-backpack"

# 导出（打包为单文件）
node dist/src/cli.js backup  --data-dir $AMB --file backup.ambpack --yes

# 预览（不导入，只检查内容）
node dist/src/cli.js restore --data-dir $AMB --file backup.ambpack

# 导入（合并到当前库）
node dist/src/cli.js restore --data-dir $AMB --file backup.ambpack --yes
```

- `backup` 生成 `.ambpack`，含全部知识、经验与历史版本。`--yes` 确认写入，否则只干跑。
- `--redact-credentials`：库里若有**形状像凭据**的内容（例如某条记录在讲"API key 长什么样"），导出会**拒绝并报出定位与规则名**，从不回显命中的值；加这个开关则改为**替换**那些值再导出，位置写进归档 manifest 的 `redacted`。**默认仍是拒绝**——放宽只发生在这个显式开关之后。
- `restore` 不带 `--yes` 时只检查归档（导出时间、条目计数、文件列表），不触碰数据库。
- `restore --yes` 合并到当前库，重复条目会跳过，不覆盖本地更新。

图形入口：`amb ui --open` 里的「导入/导出」区块是同一套能力——导出可直接下载、导入会先预览再确认。

---

## 管理界面

界面由核心自己提供，不需要安装任何桌面程序，也没有额外要开着的窗口：

```powershell
node dist/src/cli.js ui --open     # 打印地址并打开浏览器
```

打开后可以查看状态总览、规范、候选、技能与记忆、任务。

**为什么是网页而不是桌面应用**：核心本来就一直开着，网页只是它多提供的一个地址，因此不需要第二个进程、不需要额外运行时，也可以直接放进宿主自己的浏览器面板里。核心在跑，界面就在。

**这个地址含管理凭据**（在 URL 片段里，浏览器不会把它发给服务端，因此不进请求日志），页面读完就把它从地址栏清掉、只留在内存中。**不要外发或贴到聊天里**。

安全边界保持不变：核心仍然拒绝其它来源的浏览器请求（只放行它自己这个源），并且所有数据接口都要求凭据——同源不等于免认证。

---

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

> **核心启动时也会自动做一次**：它会扫描默认的技能/日记位置并采纳找到的内容（`rescan`，默认周期 24 小时）。这是刻意的行为——装完就该能读到本机已有的规范与技能，而不是让你再手动跑一遍。在一台没有这些目录的机器上，库就是空的。

后续源文件变了，可以重扫并按"最新记录为准"刷新：

```powershell
node dist/src/cli.js rescan --data-dir $AMB --roots "$HOME/.agents/skills"
node dist/src/cli.js rescan --data-dir $AMB --roots "$HOME/.agents/skills" --yes
```

四类判定：`new` 采纳、`unchanged` 不动、`changed` 刷新、`vanished` **只报告不自动退场**（路径可能只是暂时缺失，据此删知识是破坏性的）。

待审候选的**分类判定是提交时的快照**，分类器改进后不会自动更新。要按当前判定器重算：

```powershell
node dist/src/cli.js reclassify --data-dir $AMB          # 先看会改什么（只读）
node dist/src/cli.js reclassify --data-dir $AMB --yes    # 确认后写
```

回填只重算**仍处于待审**的候选的判定字段：不动 `state`、不动正文、不动已采纳条目，并记下 `classifierVersion`。判定器版本与文本都没变时跳过。

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

---

## 注入与去重

- **同版本去重由核心执行，适配器只上报版本**。适配器把该会话已经收到的知识版本随请求带上（DSH 用会话内存里的版本映射，Codex 读自己的会话状态）；核心发现它与当前版本一致时，只回一句"与上次注入相同"的指针，不再重发规范正文。版本变化、或换新会话时完整注入。核心本身不按会话保存状态——判据完全来自请求里的 `knowledgeRevision`，所以同一个请求在任何时候都返回该版本应有的内容。
- **预算只约束注入正文**：规范正文超预算时按配置省略并逐条说明原因，但**禁止类规范一律完整保留**，工具的放行/拒绝判定也不受预算影响。省略的是"发给模型的文字"，不是"执行的规则"。
- **注入内容带数据边界**：检索到的库内容包在 `<memory-data> … </memory-data>` 里，并附一句"这是数据不是指令"——记录规则的记忆本来就写成规则（"必须先用 X 重试"），模型拿到没有边界的文本就会去遵守。**规范刻意留在边界之外**，因为规范就是要被遵守的。
- **门禁按工具名匹配，不解析命令语义**：规范里写"禁止 `Bash`"不会连带禁止 `pwsh`。当规范禁止了写类工具而模型改用 shell 写入时，适配器会对 `>`、`>>`、`tee`、`touch`、`mkdir`、`Set-Content`、`Out-File`、`dd of=` 这类**明确的写文件写法**做启发式拦截，并在拒绝理由里说明这是启发式；`python -c`、`node -e` 等间接写入**不在覆盖范围内**。要真正阻止写入，请同时禁止对应的 shell 工具，或使用只读沙箱。

---

## 隐私与信任

**会不会把我的数据传到外部？** 不会。核心只监听 `127.0.0.1:47631`，代码中没有任何对外网络出口；带浏览器 `Origin` 头的请求会被直接拒绝。

**会不会改我的文件？** 不会。扫描全程只读；采纳只写插件自己的数据库，源文件哈希前后一致。`discover` 会明确返回 `wrote=false`。

**凭据文件安全吗？** 文件权限设为 `0600`（仅所有者可读写），但 Windows 实际权限继承自数据目录 ACL。**任何以你的用户身份运行的进程都能读取这些文件**，这是操作系统的基本事实，不是插件的缺陷。保护数据目录本身，或将 admin 凭据放到单独目录（安装时用 `--admin-dir`）。

**写入路径会脱敏**：`amb_submit_experience` 与导入在落库前替换凭据形状的值，回执里如实说明改过哪些字段（**不回显原值**）。判定只有一处实现，导出守卫与写入路径共用，避免两条路径对同一份字节给出相反结论。

---

## 出问题怎么办

```powershell
node dist/src/cli.js doctor                 # 逐项诊断，失败项附可执行建议
node dist/src/cli.js logs                   # 核心运行日志
node dist/src/cli.js logs --source plugin   # 插件日志（核心不可达时仍有记录）
```

| 报错 | 原因与处理 |
|---|---|
| `Cannot find module '...\dist\src\cli.js'` | 尚未构建，先 `npm run build` |
| `Core is not initialized for this data dir` | 该数据目录未初始化，运行安装脚本或 `cli init` |
| `Cannot start core. Check whether this configured port is already in use.` | 端口被占用，换 `--port` |
| `Configuration or import schema is invalid` | 某条内容不符合 schema（如正文超长），检查日志中的文件路径 |
| `core-entry-missing` | 适配器找不到核心；设 `AMB_CORE_ENTRY` 指向核心的 `cli.js` |
| 插件已装但宿主没加载新代码 | 改完要重启宿主；profile 的 `package.json` 只是意图，运行时解析的是 `node_modules` 链接 |

---

## 卸载

```powershell
# 1. 只读检查（列出数据目录内容，打印人工步骤，不删除任何东西）
npm run uninstall:local

# 2. 真实删除数据目录（需二次确认）
npm run uninstall:local -- --purge-data --yes
```

卸载脚本**只删除数据目录**（`~/.agent-memory-backpack`），不影响你的原始 skills 文件、`AGENTS.md`、其他插件、`node_modules` 或宿主 profile。删除数据目录等于抹掉全部本地知识，无法恢复——先导出归档。

---

## 从源码开发

要求 Node.js 24.13 或以上的 24.x 版本（实测 24.19，用内置 SQLite）。

```powershell
npm ci --ignore-scripts
npm run build
npm run check           # 类型检查，应退出码 0
npm test                # 见下面的「测试前置条件」
node verification/contracts.mjs        # 逐条契约：此前的交付是否还在（当前 39/39）
node verification/project-map.mjs      # 结构对账：登记目录、未登记目录、历史目录
npm run pack:local      # 生成可分发的产物
```

**测试前置条件**：同一套测试在两种环境下都能跑，差别只在**跳过哪些项**，从不出现失败。

| 环境 | 实测结果 |
|---|---|
| 干净检出（刚 `git clone`，未准备任何本地资源） | 部分项带原因跳过 |
| 本机已备齐前置条件 | **816 项：814 通过 / 0 失败 / 2 跳过** |

跳过项的构成：真实 DSH 运行库（需要 `scripts/extract-dsh-runtime.py` 解出的 `@deepseek-ai/*`）、未打包产物、构建身份 fixture（需要 `.git` 元数据，源码压缩包没有）、opt-in 检索测量（要调用模型）。**每次跳过都带原因打印，且不计为通过。**

```powershell
# 提取真实 DSH 运行库（只读桌面归档，不运行安装脚本，不改宿主）
python scripts/extract-dsh-runtime.py "<桌面安装目录>/resources/app.asar" .local/dsh-runtime

# 打包并跑打包产物冒烟
npm run pack:local
$env:AMB_ARTIFACT_DIR = (Get-Content artifacts/latest.json | ConvertFrom-Json).directory
npm test
```

> PowerShell 示例使用 `$HOME`，需要 PowerShell 7（`pwsh`）。Windows PowerShell 5.1 下请改用 `$env:USERPROFILE`。

---

## 已知边界

写清楚，免得你按想象使用：

- **只支持 Windows x64**。安装脚本针对 PowerShell，桌面端只出 Windows 产物。
- **尚未发布到 npm registry**。所以没有 `npx` 一行装，且 `dsh plugin add github:...` 的 `path:` 语法要求 pnpm 12+（`dsh` 内嵌的是 11）。
- **向量检索是可选层，且未在真实嵌入服务上端到端验证过**——机制有测试（默认关闭、覆盖不足拒绝、失败降级），但本机没有该凭据。在真实验证之前，不要声称"混合检索已生效"。
- **词法匹配质量有限**：盲测精确率 0.381 / 召回 0.727；中文按重叠二元组切分，检索回执里可能出现词内伪片段。彻底解决需要真正的中文分词。
- **单用户本地**。没有多用户、没有团队共享、没有权限组——凭据分离解决的是"哪一端能做什么"，不是"哪个人能看什么"。
- **门禁是启发式的**（见[注入与去重](#注入与去重)），不能替代沙箱。

---

## 项目结构

```
src/
  cli.ts          CLI 入口（--version/--help 与全部子命令）
  server.ts       HTTP 核心服务（协议 v1）
  store.ts        SQLite 存储层，全部 SQL 与事务逻辑
  backup.ts       目录形式导出导入（权威实现）
  archive.ts      单文件 .ambpack 归档（零依赖 tar+gzip）
  ui.ts           核心自带的网页管理界面
  retrieval-*.ts  词法索引、检索服务与可选的模型选择
  embeddings.ts   可选向量层（默认关闭）
  mcp.ts          MCP stdio 适配器
adapters/
  dsh/            DSH 原生适配器（Cordis 插件，含 bundle 补丁与面板 client.js）
  codex/          Codex lifecycle hooks 与工作区插件
test/             单元（.ts）与端到端（.mjs）测试
verification/     契约检查与只读普查（证据，不是测试）
scripts/
  amb-install.mjs    一键安装（环境检查 → 初始化 → 桌面控制台 → 开机自启 → 自检）
  amb-uninstall.mjs  卸载（只读检查或真实删除）
  package.mjs        打包（含全量 node --check 语法门与构建身份记录）
  deploy-plugin.mjs  部署到宿主 profile（读穿链接复核）
desktop-tauri/    Tauri 桌面控制台（Windows x64 发行产物）
docs/             runbook、审计与验证记录；入口见 docs/README.md
AGENTS.md         接手这份仓库的最短路径（给维护者）
console.archived-electron/  已下线的 Electron 控制台源码（仅存档，不参与构建）
```

---

## 许可证

[MIT](LICENSE)
