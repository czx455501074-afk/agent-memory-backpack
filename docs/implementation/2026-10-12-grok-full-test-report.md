# agent-memory-backpack P0 全功能测试报告（Linux 桌面 GUI + API/CLI）

- 日期：2026-10-12（时间均为北京时间）
- 产物：`/workspace/huange-skill/artifacts/p0-20261012093442045`（插件 0.1.0-p0.1；工作区含未提交改动，HEAD c4a0ef7）
- 环境：core 127.0.0.1:47761，数据 `/workspace/gui/home/.agent-memory-backpack`；alpha=`/workspace/gui/alpha`，beta=`/workspace/gui/beta`
- 宿主：ChatGPT 桌面版 26.1007.21434（内置 codex-cli 0.162.0-alpha.17.2）；DSH Desktop 0.2.0-rc.2（官方源码 639ed01 自行构建，补丁见附录）
- 矩阵：`/workspace/gui/test-matrix.md`；API 脚本/证据：`/workspace/gui/api/run.mjs`、`results.json`、`q.mjs`
- 日志：插件 `/workspace/gui/home/.agent-memory-backpack/amb-plugin.log.jsonl`；core `amb.log.jsonl`、`/workspace/gui/logs/core.log`；ChatGPT `/workspace/gui/logs/chatgpt.log`；DSH `/workspace/gui/logs/dsh-desktop.log`；DSH 会话 `/workspace/gui/dsh/sessions/`

## 一、结论
**不宜发布。** 核心 API 与权限模型基本正确（67 项 API 用例 62 过，失败均为已知/新 bug 或用例问题），规范门禁在"工具名命中"层面两端均生效；但 deniedTools 可被 shell 绕过、条目读取多处 404、跨会话/跨端接续与去重不可用、卸载残留、Codex MCP 运行在不受支持的 Node 20 上。

## 二、覆盖矩阵（43 项 + 3 项 Windows 专项）
列：CLI/API=本机 API/CLI；Win=Windows 实机隔离环境（D:\amb-wintest，隔离 USERPROFILE/CODEX_HOME/DSH_HOME/端口 47751，测后已删除；证据 `/workspace/wintest-evidence/ev/`；“脚本/单测”=由 R0 核验脚本或 npm test 在 Windows 上通过，非实时会话；无 DeepSeek key、Codex 未登录，故无 Windows 实时模型会话）；C=Codex GUI；D=DSH GUI。✅通过 ❌失败 ⚠部分/有条件 —未测（Win 列写作“未测”）

| # | 功能 | CLI/API | Win | C | D | 备注 |
|---|---|---|---|---|---|---|
| 1 | 插件加载 | ✅ | ✅ | ✅ | ✅ | D adapter.load node 24.18.1；Win：真实 DSH 0.2.0-rc.2 运行时加载 adapter.load platform=win32 |
| 2 | 首轮上下文注入 | ✅ | 未测 | ✅ | ✅ | |
| 3 | 同会话注入去重 | ✅(gate knownRevision) | ✅(脚本) | — | — | GUI 未单独记录 |
| 4 | 注入预算 | ✅ | ✅(脚本) | — | — | |
| 5 | 版本递增后重注入 | ✅ | ✅(脚本) | — | — | 采纳后 rev 8→9→10，prepare 两端均带新条目 |
| 6 | 门禁-写文件工具 | ✅ | ✅(脚本) | ✅ | ✅ | apply_patch / write/edit 被拒 |
| 7 | 门禁-放行工具 | ✅ | ✅(脚本) | ✅ | ✅ | |
| 8 | shell 写文件绕过 | n/a | 未测 | ❌ | ⚠ | Codex 用 printf 写成功；DSH 默认自觉遵守，明确要求时可绕过（BUG-H1）|
| 9 | 范围外（beta） | ✅ | ✅(脚本) | ⚠ | ✅ | D 正确 out_of_scope；C MCP 不校验范围（BUG-H3）|
| 10 | amb_read_knowledge（memory/skill）| ✅ | 未测 | ✅ | ✅ | |
| 11 | 带 @版本 id 读取 | ❌ | 未测 | ❌ | ❌ | BUG-H2 |
| 12 | 通用文本检索 | ✅ | 未测 | ✅ | ❌ | DSH 无自由文本知识检索工具（BUG-M4）|
| 13 | 按类检索 skill/journal | ✅ | 未测 | ⚠ | ❌ | journal 可检索但 read 404（BUG-H2）|
| 14 | 资料召回 | ⚠ | 未测 | — | — | 种子资料即时消失（BUG-M6）|
| 15 | amb_prepare | ✅ | 未测 | ✅ | ✅ | |
| 16 | search_workflows/read_stage | ✅(空) | 未测 | — | — | 库中无 workflow |
| 17 | amb_unstructured_skills | ✅ | 未测 | — | ✅ | |
| 18 | amb_structure_skill（非管理员）| ✅(403) | 未测 | — | — | |
| 19 | amb_knowledge_history | ✅ | 未测 | — | — | |
| 20 | amb_supersede_experience | ✅(403) | 未测 | ✅ | — | C 改为提交候选 bd1c1737 |
| 21 | 候选提交 | ✅ | ✅(单测) | ✅ | ✅ | GUI-PROP-C/D 均为 pending |
| 22 | 跨端候选去重 | ✅(同文本) | ✅(单测,同文本) | ❌ | ❌ | GUI 两端 duplicate:false（BUG-M2）|
| 23 | 审核/批准/拒绝 | ✅ | ✅(脚本) | n/a | n/a | 采纳 5a762b12、90a7c22c；拒绝 f198bec7 |
| 24 | 自述不冒充证据 | ✅ | ✅(脚本) | — | — | evidence=self-reported 保留 |
| 25 | 同端"继续上次任务" | ❌ | 未测 | ❌ | ❌ | BUG-H4 |
| 26 | 跨端接续 C→D | ✅ | 未测 | ✅ | ✅ | Codex→DSH 的 T01 交接成功 |
| 27 | 文件状态比对 | ✅ | ✅(单测) | — | — | 宿主不自动记录 fileStates |
| 28 | 任务导出/日记 | ✅ | 未测 | — | — | |
| 29 | Stop 不记完成 | ✅ | 未测 | — | — | |
| 30 | 事件采集 | ✅ | 未测 | ⚠ | ⚠ | 24 次 event.delivery_failed |
| 31 | 降级/outbox | ✅(在线) | ✅(脚本) | ⚠ | ⚠ | 负载下进入 ReadOnlySnapshot；19 次 outbox.enqueue_failed（BUG-M3）|
| 32 | self_check / doctor | ✅ | ✅ | ⚠ | ✅ | C 报 Node 20（BUG-H5）；Win：控制台自检无阻塞（`console-doctor-*.png`） |
| 33 | capabilities | ✅ | ❌ | — | — | Win：dsh/codex 均报 installed=false（BUG-W4） |
| 34 | stats / history | ✅ | 未测 | — | — | |
| 35 | discover / rescan | ✅ | 未测 | — | — | |
| 36 | export-skills | ✅ | 未测 | — | — | |
| 37 | 备份/导入 | ✅ | 未测 | — | — | 无凭据泄漏 |
| 38 | amb_inspect_archive | ✅ | 未测 | — | — | |
| 39 | 管理控制台 UI | ⚠ | ✅ | — | — | 仅生成地址，未做浏览器验收；Win：Electron 8 页+暗色截图 `/workspace/wintest-evidence/ev/console-*.png`，输出无 token |
| 40 | 适配器越权（验收 18）| ✅ | ✅(脚本) | — | — | |
| 41 | 认证/协议（验收 15）| ✅ | ✅(脚本) | — | — | |
| 42 | 身份冒用 | ✅ | ✅(脚本) | — | — | |
| 43 | 禁用/卸载 | ❌ | ❌ | ⚠ | ❌ | 残留（BUG-H6）；Win：核心运行时卸载 EPERM 半删（BUG-W2）；CLI：amb-uninstall 不停核心、不清 profile 接线 |
| 44 | Windows 登录自启（service） | — | ❌ | n/a | n/a | 测试键 AMBTest\Run 内流程正常，但注册路径 `core\dist\src\cli.js` 不存在（BUG-W1）；真实 Run 键前后一致 `/workspace/wintest-evidence/ev/run-*.reg` |
| 45 | 凭据 ACL | — | ⚠ | n/a | n/a | 非用户目录下继承 Authenticated Users:M / Users:RX（BUG-W3）|
| 46 | 全量测试 329 | ⚠(Linux 322/1/6) | ✅ | n/a | n/a | Win 环境正确时 329 全过（`/workspace/wintest-evidence/ev/npm-test.log`，首跑 3 失败为测试环境 TEMP/AMB_CONFIG 所致）|

## 三、缺陷清单（按严重度）

### 高
**BUG-H1 deniedTools 可被 shell 绕过**
- 复现：alpha 规范 alpha-style 禁 apply_patch/write/edit…；对模型说 "Create notes.txt"，被拒后模型改用 `printf … > notes.txt`（Codex 自发；DSH 在用户明确要求用 shell 时）→ 文件写成。
- 原因：门禁只按工具名匹配（`src/store.ts` gate → `deniedTools` 精确名单），bash/shell 未纳入、也不解析命令写入意图。
- 证据：Codex 会话（`/workspace/gui/codex-home/sessions/`）、DSH 会话目录；core gate 对 bash 返回 allow（`api/results.json` G-*-bash）。
- 建议：规范层提供"禁止写文件"语义（映射到写类工具 + shell 写重定向检测/只读沙箱），或在文档明确仅为工具名门禁。

**BUG-H2 读取路由对 @版本 id、norm、journal 返回 404（get 200 / read 404）**
- 复现：`/v1/knowledge/read {knowledgeId:"alpha-mem@1"}` → 404；`read alpha-style` → 404；`read alpha-log-2026-10-12` → 404；同 id 走 `/v1/knowledge/get` → 200。两端 GUI 中 amb_read_knowledge 均失败。
- 原因：
  - `src/store.ts:657` `find(candidate => candidate.id === id)` 精确匹配，不剥离 `@revision`；而注入文本以 `id@revision` 呈现（`src/store.ts:803`、`src/store.ts:809`），模型照抄。
  - `src/store.ts:660` 仅允许 `skill`/`memory`，norm、journal、preference、material 一律 404 且报"unavailable"，误导。
  - MCP 原样透传：`src/mcp.ts:69-72`（amb_read_knowledge → /v1/knowledge/read）；DSH 同：`adapters/dsh/index.mjs:528`。
- 建议：解析 `id@rev`（rev 不符返回 409 并给当前 rev）；read 支持全部可读 kind 或返回 422 指明 kind 不支持。

**BUG-H3 Codex MCP 不校验项目范围**
- 复现：在 alpha 外目录开 Codex 会话，amb_read_knowledge 仍能读 alpha（之前 CLI 轮已复现）。
- 原因：`src/mcp.ts` 只凭 `codex-client.json` 的 projectId，cwd 校验已被移除；凭据全机唯一。DSH 有 `adapters/dsh/index.mjs:204` inProject 检查。

**BUG-H4 同端"继续上次任务"失败**
- 复现：会话 1 开任务、会话 2 "Continue the previous task." → 无交接注入；插件日志 4 次 `handoff.failed`（HTTP 400）。
- 原因：`adapters/dsh/index.mjs` ~304 将 `/v1/tasks/list` 返回对象原样提交 `/v1/tasks/record`，被 `taskSchema`（`src/schema.ts:283`，strict）拒绝；API 复现 T04（400）。每会话新建任务、"继续"取列表首个（core 现有 15 个任务）。Codex 端不登记任务。
- 反例：跨端 Codex→DSH 的 T01 交接成功（走 handoff 读取路径）。

**BUG-H5 Codex MCP/hook 运行在 Node 20.19.2（要求 >=24.13 <25）**
- 原因：`adapters/codex/.mcp.json:5` `"command": "node"` 与 `adapters/codex/hooks/hooks.json:8` `node "${PLUGIN_ROOT}/scripts/hook.mjs"` 依赖 PATH 上的裸 `node`。ChatGPT 桌面从图形入口启动时重新加载登录 shell 环境，PATH 中首个 node 是系统 `/usr/bin/node` v20.19.2（box 的 ~/.bashrc 未加载 nvm），启动脚本前置的 nvm PATH 被覆盖。插件运行时只上报 `process.versions.node`（`src/mcp.ts:34`、`:52`），无 engines 校验/拒绝。
- 建议：启动时校验 Node 主版本并明确失败；或打包自带运行时/使用宿主提供的 node 路径。

**BUG-H6 卸载残留**
- 现象：DSH 卸载后 `/workspace/gui/dsh/plugins/agent-memory-backpack` 目录、`profiles/desktop/node_modules/dsh-agent-memory-backpack` 符号链接仍在（package.json 已无依赖）；core 47761（pid 232003）仍在监听。
- 原因：卸载只改 profile 清单，不清理 `scripts/deploy-plugin.mjs` 部署的目标目录与链接，也不停止 `ensure-core.mjs` 拉起的核心。

**BUG-H7 凭据回退共享（F22e，前轮）**：`src/config.ts:89-105` 缺专属凭据时回退 `client.json`。

### Windows 专项（隔离环境实测）
**BUG-W1（高）产物安装后登录自启指向不存在的入口**
- 复现：`node <artifact>\core\runtime\cli.js service enable-startup`（AMB_RUN_KEY=HKCU\Software\AMBTest\Run）→ 注册值 `"node.exe" "...\core\dist\src\cli.js" serve --data-dir ...`，该文件不存在（实际入口 `core\runtime\cli.js`）。
- 原因：`src/cli.ts:301` 写死 `join(root,'dist','src','cli.js')`；enable-startup 不校验存在性。登录后核心静默不启动。
- 证据：本次 Windows 运行输出（测试键已删除）；真实 Run 键未被写入 `/workspace/wintest-evidence/ev/run-before.reg`、`run-after.reg`（哈希一致）。

**BUG-W2（高）核心运行时卸载半删除（Windows 文件锁）**
- 复现：核心运行中执行 `amb-uninstall --purge-data --yes` → `EPERM ... .agent-memory-backpack`，退出 1；凭据与 core.json 已删、`knowledge.sqlite*` 残留，核心仍监听 47751 但已无配置；DSH profile junction/依赖仍在。
- 原因：卸载脚本不先停核心（core.lock 有 pid 可用）、非原子删除。与 BUG-H6 同源，Windows 上更糟。

**BUG-W3（中）init 不收紧凭据 ACL**
- 现象：`--data-dir`/HOME 位于非用户目录（如 D:）时，`dsh-client.json` 继承 `Authenticated Users:(M)`、`Users:(RX)`；真实 `%USERPROFILE%\.agent-memory-backpack` 仅 SYSTEM/Administrators/czx。CLI 仅提示“Windows 不强制文件模式”，未用 icacls 收紧。

**BUG-W4（中低）capabilities 不识别 DSH_HOME/CODEX_HOME**
- 现象：插件已按 `DSH_HOME` 部署并成功加载，`/v1/capabilities` 仍报 dsh、codex `installed=false`；控制台自检“dsh 能力清单：留意”（`/workspace/wintest-evidence/ev/console-doctor-*.png`）。
- 原因：`src/capabilities.ts:138` 只扫描 `~/.dsh|.codex|.agents`，而 `scripts/deploy-plugin.mjs` 认 `DSH_HOME`。平台无关，Windows 上发现。

**Windows 上复核的已知缺陷**
- BUG-H7/F22e：全新隔离 home 下 `verify-r0-findings` 25/26，F22e FAIL（`/workspace/wintest-evidence/ev/verify-r0-findings.log`、`r0-verification.json`）。
- BUG-M5：首次 `deploy-plugin` 报 active=false 退出 1，二次 0；一致性脚本 deploy-signal=unclear（`/workspace/wintest-evidence/ev/check-artifact-consistency.log`）。
- BUG-M7：Windows 同样触发——TEMP 含 `tmp` 段（`D:\amb-wintest\tmp`）时 discovery 2 个测试失败，换目录后 27/27 通过（`/workspace/wintest-evidence/ev/npm-test.log`）。
- 其余脚本：budget 16/16、adapter 9/9、dsh 4/4、hook-budget 5/5、产物哈希 match（`/workspace/wintest-evidence/ev/verify-*.log`）。
- Codex CLI（隔离 CODEX_HOME，未登录）：`plugin add` 成功但不写 `hooks.state` 信任，CLI 无信任子命令（`plugin_hooks=removed`）；信任只能在桌面/TUI 交互完成。

### 中
- **BUG-M1 模型自动调用 amb_submit_experience 带虚构 workflowId → 404**：库中无 workflow，模型仍填 workflowId，core `Store.submit` 校验存在性返回 404，候选丢失（插件 21 次 `tool.failed`）。建议在工具描述写明"无 workflow 时省略"，或 404 时降级为不带 workflowId 提交。
- **BUG-M2 跨端去重失败**：GUI 中两端提交 DUP-X 得到两条 pending（f198bec7 DSH、90a7c22c Codex），`duplicate:false`。原因：两端把同一句包装成不同 discovery 文本（`proposalSchema.discovery` 自由文本，`src/schema.ts:231-236`），去重按全文。API 同文本时去重正常（P03）。
- **BUG-M3 负载下降级 ReadOnlySnapshot 且事件丢失**：插件日志 3 次 `adapter.degraded`、24 次 `event.delivery_failed`、19 次 `outbox.enqueue_failed`；outbox 位于 core 内，core 不可达时无法入队（前轮已报）。core outbox 现 failed=11。
- **BUG-M4 DSH 无自由文本知识检索工具**：DSH 工具集（`adapters/dsh/index.mjs:482-756`）只有 search_workflows，无 search-universal 对应工具，GUI 中无法检索 memory/journal。
- **BUG-M5 首次部署误报失败 / 一致性脚本正则过时**（前轮）。
- **BUG-M6 seed 资料即时消失**：`cli seed` 中 material 未给 `expiresAt` 默认 0（`src/schema.ts` materialSchema），写入后下一请求的 cleanup 即清除，seed 仍报成功；`alpha-runbook-material` get 404。
- **BUG-M7 discovery 路径段误排除**（Linux/macOS，`src/discovery.ts:116`，前轮）。

### 低
- `/v1/material/list` stats 为全库计数（前轮）。
- `test/adapter-core.test.ts:133` 遗留 core 进程；`test/codex-hook.test.mjs:399` 只设 USERPROFILE。
- 默认 knownRevision 去重仅在适配器侧，core prepare 无会话去重（设计如此，文档应写明）。

## 四、本轮管理员操作记录（19:5x）
- pending 8 条（含 GUI-PROP-C 6ad48b9d、GUI-PROP-D 5a762b12、DUP-X ×2、supersede 请求 bd1c1737、交接流程候选 98ef5622、无 workflow 说明 79eb3aec、API-OB-1 981bff36）。
- 采纳 5a762b12 → `alpha-cache-warmup`，rev 8→9；拒绝 f198bec7（DUP-X 重复）；采纳 90a7c22c → `alpha-log-rotation`，rev 9→10。
- 采纳后 dsh、codex 两端 prepare 均包含 GUI-PROP-D、DUP-X；`read` 两条均 200。

## 附录 A：DSH Desktop Linux 构建补丁
`apps/desktop/scripts/desktop-build-paths.mjs`：SUPPORTED_TARGETS 增加 `linux-x64`，`desktopTargetPlatform` 映射 linux（2 行）。开发模式启动（`pnpm run start:desktop`），非签名包。

## 附录 B：未覆盖
Windows 实时模型会话（无 DeepSeek key、Codex 未登录）、Windows 桌面 GUI hook 信任界面（未获批准触碰真实 ~/.codex）、管理控制台浏览器验收、验收 17（24h 队列）、19、20。
