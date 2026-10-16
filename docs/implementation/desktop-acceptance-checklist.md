# 桌面端真实验收清单与证据模板

**目的**：这是项目**唯一未经真实环境验证**的环节。本文把"未验证"变成"可执行、可留证"的清单，区分**已自动验证**与**需人工点击**的部分。

**当前状态**：未通过。任何一项未取得真实桌面证据，都不得标记为通过。

## 零、一键运行

先跑自动化部分，它会把可自动化的检查全部执行并写出一份可直接分享的报告：

```powershell
npm run accept:desktop
# 报告：docs/implementation/desktop-acceptance-report.json
# 只跑不改动：加 --keep 保留临时工作区与数据目录
```

脚本**不会**安装或信任任何插件、不改动 Codex/DSH 的真实 profile、不重启宿主。需要点击的步骤在报告中标为 `manual`，附操作说明与所需证据。

通过标准：报告里 `summary.fail === 0` 且 6 个 `manual` 项全部取得证据。退出码只反映自动项，便于接入 CI。

**实测结果（2026-10-10）**：自动项 通过 16 / 失败 0 / 跳过 0；需人工 6 项。重复运行结果一致。

**实测结果（2026-10-16）**：自动项 通过 20 / 失败 0 / 跳过 0；需人工 6 项。本次运行写入 `desktop-acceptance-report.json`（`ranAt` 2026-10-16T11:56:51.360Z，`buildIdentity.matched = true`），退出码 0。**两次运行的条目集合不同，计数不可直接相比**：本轮脚本新增 `same-build`、`latest-build`、`client-half-valid`、`origin-loopback-admitted`、`host-refused`，并把 `origin-refused` 的语义收紧为「非回环 Origin 被拒绝」。旧报告里的 `no-client-half` 失败项随该断言被推翻而消失，**不代表同一断言由失败转为通过**。证据来源与口径见 `desktop-acceptance-report-provenance.md`。

## 零点五、真实桌面验收结果（2026-10-10）

用户已在真实 Codex 与 DSH 桌面执行，证据在 `.local/desktop-manual-20261010/` 与 `.local/desktop-codex-retest-20261010/`。详见 `2026-10-10-desktop-acceptance-results.md`。

**首轮**：6 项人工中 4 通过、1 部分通过（`codex-inject` 缺来源标记）、1 失败（Codex `disable`）。

**Codex 重装后复验**：两项均通过。缓存 20 个文件与指定产物 `artifacts/p0-20261010062259431` 哈希全部一致；新聊天收到以 `[agent-memory-backpack]` 开头的真实 developer 注入；停用后新聊天工具元数据返回 `[]` 且无注入，**无需重启**。

| 项 | 最终结果 | 说明 |
|---|---|---|
| `codex-load` | 通过 | 插件页出现并可信任 hooks |
| `codex-inject` | **通过** | 复验后注入带 `[agent-memory-backpack]` 前缀，来源可辨识 |
| `dsh-load` | 通过 | 从最新产物本地安装并启用 |
| `dsh-inject` | 通过 | Injected content 显示 `agent-memory-backpack` 来源 |
| `gate-deny` | 通过 | 两端都实测被拒绝，工具未执行 |
| `disable` | **通过** | DSH 无需重启；Codex 复验无需重启 |

**仍需注意的边界**：`gate-deny` 与 DSH 的证据来自首轮；`codex-load`/`codex-inject`/`disable` 的证据来自复验轮。**未对最新产物重跑全部场景**，不应以此声称"所有场景都在同一构建上通过"。

**首轮暴露并已修复的三个缺陷**：

1. **Codex 停用失败**：测试工作区 `.codex/config.toml` 写死了 `enabled = true`，项目级配置覆盖了全局 UI 停用。此为**夹具自身缺陷**，已停止写该标志。
2. **Codex 缓存与最新产物不一致**：复验已通过重装对齐（哈希逐项核对一致）。
3. **CLI `--help` 崩溃**：已修复；未知选项与未知命令现在给出可读提示与命令列表。

用户要求的「字面 `agent-memory-backpack` 来源标记」在 Codex 侧无法由宿主字段满足（hook 只能返回文本，宿主按自己的规则标记为 `developer`）。已在注入文本前加 `[agent-memory-backpack]` 前缀，复验确认生效。

## 一、已自动验证的部分（无需人工）

以下是实测通过的，不是自述：

| 能力 | 证据 |
|---|---|
| 产物与清单一致 | `npm run accept:desktop`（2026-10-16 实测）：133 个文件哈希全部匹配 |
| 产物与当前工作树同一构建 | 同上：产物清单记录 commit `fe8ceba8…`（工作树 dirty）与当前工作树一致，`buildIdentity.matched = true` |
| 插件包自足 | 同上：DSH 插件包含全部被导入模块（4 个必需文件） |
| 浏览器半存在且可用（`client-half-valid`） | 同上：包声明 `dsh.client` 与 `exports["./client"]`；`client.js` 存在、通过语法编译、导出 `apply`，并在 `conversation.view` 注册视图 `amb-knowledge-view` |
| 宿主接受 bundle patch | `test/dsh-bundle-patch.test.mjs`：用宿主**自己的** `cordis-plugin-include` 与 YAML 方言解析并应用 |
| 核心身份/协议/项目隔离 | `test/protocol.test.ts`：401、426、403（跨项目与跨适配器） |
| 全新安装从空开始 | `test/clean-install.test.ts`：`entries=0 revision=0 adoptions=0` |
| 打包产物独立启动 | `test/package-smoke.test.mjs`：中文+空格路径下启动核心，官方 MCP 客户端连接并读取流程 |
| MCP 全工具真实可用 | `test/protocol.test.ts`：10 个工具逐个真实调用 |
| 拒绝畸形核心响应 | `test/protocol.test.ts`：`200 {}` 必须报错，不得当成功 |
| DSH 真实 Cordis 运行时 | `test/dsh-runtime.test.mjs`：真实 ToolRuntime 加载/执行/注销，守卫不可被覆盖 |
| 适配器自持日志 | `test/dsh-runtime.test.mjs`：真实运行时中写出日志且不含凭据 |
| Codex hooks 全部事件 | `test/codex-hook.test.mjs`：15 项，含五种畸形响应拒绝 |
| 采纳对宿主只读 | `test/adoption.test.ts` + 真实环境 301 文件零改动 |
| 开源交付物无个人数据 | `test/clean-install.test.ts`：仓库与产物均无机器路径、用户名或作者技能内容 |
| 非回环 Origin 被拒绝 | `npm run accept:desktop`（2026-10-16 实测）：`HTTP 403 origin_denied` |
| 回环 Origin 有意放行 | 同上：`HTTP 200`（**设计如此，非回归**；同源 POST 也带 Origin，全拒会让界面空白） |
| 非回环 Host 头被拒绝 | 同上：`HTTP 403 host_denied` |

### 关于浏览器半的现状（2026-10-16 核实）

本文档早前版本把「**未声明会导致加载失败的浏览器半**」当作通过条件，**这是一个已被推翻的旧假设**。事实相反：插件**故意**提供原生浏览器半 `adapters/dsh/client.js`。

- 面板形态：**DSH 原生 React 面板**，挂载在宿主自己的 `conversation.view` 槽位；**已不再使用 iframe 内嵌 web 页面**。面板自行取数渲染，不嵌入第二个文档。
- 对应验收项：已更名为 `client-half-valid`，断言「声明 `dsh.client` / `exports["./client"]` + `client.js` 存在 + 语法编译通过 + 导出 `apply` + 在 `conversation.view` 注册视图 id」。缺少浏览器半、或半不可加载，才会让桌面失去面板——这才是该项要抓的失败。

### 关于面板数据端点与凭据（2026-10-16 核实）

`/amb/ui-url` 与 `/amb/config` 两个端点**已下线删除**，不再由适配器提供：

- `client.js` 只请求 `/amb/summary`、`/amb/search`、`/amb/task`；原生面板从不索要页面地址，两个端点因此失去存在理由。
- `/amb/ui-url` 是此前唯一会返回 token 的响应。下线它同时是一次**安全收紧**；现存的三个数据路由只报告计数、条目与单条任务记录，**不含凭据**。
- 依据：`adapters/dsh/index.mjs` 中 `/amb` 前缀处理段内的注释与 `PANEL_DATA_PATHS`；`adapters/dsh/client.js` 的 `ENDPOINTS` 表。

## 二、需人工执行的部分

人工步骤**必须由用户操作**，我不能代点。每一步都给出可留证的观察点；报告文件里同样逐项列出。

### 步骤 0：准备隔离测试环境

```powershell
# 用独立数据目录，不碰真实 profile
node dist/src/cli.js init --data-dir .local/desktop-verify --project verify --project-root <测试工作区绝对路径>
node dist/src/cli.js seed --data-dir .local/desktop-verify --input fixtures/p0-seed.json
node dist/src/cli.js serve  --data-dir .local/desktop-verify
```

留证：核心启动输出那一行（含监听地址）。

### 步骤 1：Codex 桌面加载插件

- 打开上述测试工作区（**不要**用正在工作的仓库）
- 通过 Codex 的本地 marketplace 界面加载插件
- **审阅并信任 hooks**（未信任状态不算通过）

留证：插件出现在列表中的截图；信任确认后的状态截图。

### 步骤 2：DSH 桌面加载插件

- 在"设置 → 插件"通过本地包入口加载 `packages/dsh-plugin`
- 不运行 `dsh plugin --profile desktop`，不手工重复 insert（包自带 bundle patch）

留证：插件页显示已安装/已启用的截图。

### 步骤 3：验证自动上下文注入（关键项）

在**两个**桌面各新建会话，输入自然语言：

> 查找本地流程资料，并说明开始前的检查

留证：
- 适配器是否在模型工作**之前**自动注入了上下文（不是模型自己说的）
- 观察方式：会话中应出现来源标记为 `agent-memory-backpack` 的注入内容
- **仅模型自述不足为证**

### 步骤 4：验证规范门禁

先取到桌面实际传递的工具名，再在测试库添加只禁止该**无副作用**测试调用的规范，然后尝试调用。

留证：工具未执行 + 桌面显示拒绝原因。

### 步骤 5：验证候选与不自动生效

提交一条明确标注的测试经验，用同一 `idempotencyKey` 重试。

留证：两次回执相同、只有一条 pending、有效库不变化。

### 步骤 6：验证失联行为

Ctrl+C 停止核心，再触发工具调用。

留证：受支持路径明确拒绝或报错，**不得假装成功**；重启核心后可恢复。

### 步骤 7：验证禁用与卸载

通过各自 UI 停用插件，在新会话核查。

留证：不再注入上下文、不再提供工具；记录是否需要重启宿主。

## 三、证据记录模板

每项按下表填写。无法填满的项，就是"未验证"。

| 字段 | 值 |
|---|---|
| 场景 | （对应上表步骤号） |
| 宿主 | DSH / Codex |
| 宿主版本 | |
| 适配器版本 | |
| 时间 | |
| 项目 ID / 会话 ID | |
| 可观察结果 | 日志行 / 回执 / 截图路径 |
| 结论 | 通过 / 失败 / 未验证 |

## 四、判定规则

- **不得**把 shell 脚本输出当成桌面证据。
- **不得**把"手动能读"当作自动化目标已实现。
- **不得**编辑信任哈希或绕过信任。
- **不得**因为无法可靠绑定项目或触发，就降级后宣称通过——应记录为未通过。
- DSH 还需真实 Agent 消息落盘/回放测试；现有 ToolRuntime 测试中的 agent 是 fixture。

## 五、已知会卡住的地方（诚实记录）

1. **Codex 桌面信任入口未确认**。官方文档给出的 `/hooks` 属于 CLI；桌面信任入口此前未能确认，且用户曾反馈找不到入口。若仍无入口，应由工程侧调查宿主支持情况，不得凭猜测指路。
2. **Codex 桌面交互无法由自动化代操作**，必须用户手动完成。
3. **DSH 安装路径未验证**，不得把 Codex 的 CLI 安装结果外推到 DSH。
