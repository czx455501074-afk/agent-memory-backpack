# AGENTS.md —— 接手这份仓库的最短路径

> 给**接手这个仓库的 agent/维护者**看。使用者文档在 [`README.md`](README.md)，文档索引在 [`docs/README.md`](docs/README.md)。
> 本文件里的每个数字都是实测值，改完结构请重跑 `node verification/project-map.mjs` 并更新这里。

## 这是什么

**Agent Memory Backpack（AMB）**：让 DSH 与 Codex 两个桌面共享同一份本地知识的插件。核心是本地 SQLite + HTTP 服务（默认 `127.0.0.1:47631`，协议 v1），两个宿主各有一个适配器，另有标准输入输出的 MCP server。当前版本 `1.0.0`。

## 先做三件事（别急着看代码）

```powershell
npm test                                        # 全量；含契约与结构对账，0 失败才能继续
node verification/contracts.mjs                 # 此前每一轮的交付是否还在（逐条契约，条数见运行输出）
node scripts/verify-host-deployment.mjs         # 宿主跑的是哪一版：必须报 RUNNING DEPLOYED BUILD
```

只有 30 秒时：`node verification/contracts.mjs` 加 `git log --oneline -8`。

## 不要扫这四类目录（这是探查成本的主要来源）

| 目录 | 实测规模 | 性质 |
|---|---|---|
| `desktop-tauri/` | 约 1 万文件 / 6.9 GB | Tauri 桌面端，含 `node_modules` 与 `src-tauri/target` |
| `.local/` | 约 6 万文件 / 2.4 GB | 部署信号、验收证据、市场缓存 |
| `artifacts/` | 每次 `pack:local` 一份完整产物快照；**已带轮转**（保留最近 3 份，`AMB_ARTIFACT_KEEP` 可调） | 2026-10-18 清理前曾堆积 **107 份 / 116 万文件 / 5.4 GB** |
| `*-backup-<pid>-<ts>-*` | 部署脚本的备份；**已带轮转**（每类保留最近 3 个，`BACKUP_KEEP`） | 2026-10-18 清理了 **93 个 / 17.7 万文件 / 830 MB** 历史遗留（旧脚本时代产生，轮转覆盖不到） |

**递归 `glob`/`grep` 会撞进这几万到百万个文件里**，结果是"匹配 14375 条、省略 14175 条"这类无用的输出。要搜代码，把范围钉在 `src/`、`adapters/`、`test/`、`verification/`、`scripts/`、`docs/`。

顶层共 **27 个条目**（2026-10-18 清理前是 120）。**规模只写数量级**，精确值跑 `node verification/project-map.mjs --sizes`，不要引用本文里的旧数字——这正是文档最容易失真的一类内容。

## 目录地图（在役的 16 个）

| 目录 | 职责 | 备注 |
|---|---|---|
| `src/` | 核心：CLI、HTTP 服务、存储、检索、MCP、网页控制台 | 40 个文件；`store.ts` 最大（约 6,500 行），改它前先读契约 |
| `adapters/dsh/` | DSH 适配器：工具注册、面板、hook、outbox、spool | 面板前端是 `client.js` |
| `adapters/codex/` | Codex 适配器：hook 脚本、失败捕获 | 与 DSH 侧共享若干逐字节相同的文件（有测试钉住） |
| `test/` | 154 个测试文件（`*.test.ts` 与 `*.test.mjs` 两种） | `dist/test/*.test.js` 与 `test/*.test.mjs` 都被 `npm test` 收集 |
| `verification/` | 契约检查、只读普查、可复现测量（`r5/`、`r6/`） | 这些是**证据**，不是测试：多为只读、退出码恒 0 |
| `scripts/` | 安装、打包、部署、桌面验收、宿主版本判定 | `package.mjs` 含 `node --check` 全量语法门 |
| `docs/` | 146 份 Markdown 文档：`implementation/` 为主，`handoffs/`、`plans/`、`internal/`、`diagnostics/` | 从 [`docs/README.md`](docs/README.md) 进 |
| `dist/` | `tsc` 输出（`dist/src`、`dist/test`） | **产物，不要手改** |
| `core/` | 打包产物的本地副本（`runtime/` + `node_modules/`） | **产物**；仓库根这份不参与部署 |
| `dist-console/`、`dist-console-out/`、`console.archived-electron/` | 早期 Electron 控制台，**已下线** | 不要再往里加代码 |
| `desktop-tauri/` | 桌面窗口（Tauri） | 见 [`docs/internal/tauri-core-api-contract.md`](docs/internal/tauri-core-api-contract.md) |
| `fixtures/`、`.zerotoken/`、`artifacts/`、`.local/`、`node_modules/` | 夹具 / 本地环境 / 产物 / 证据 / 依赖 | 前两个各 1 个文件 |

## 想改 X → 该看哪里 → 怎么验

| 想做的事 | 主要文件 | 验证命令 |
|---|---|---|
| 改**写入前规范化**要求 | `src/store.ts`（`【AMB 双向记忆】`）、`adapters/dsh/index.mjs` 与 `src/mcp.ts` 的工具描述 | `verification/contracts.mjs` 的 `normalize-before-write`（四处断言） |
| 改**备份/迁移** | `src/backup.ts`、`src/archive.ts`、`src/cli.ts`（`backup`/`restore`） | `node --test dist/test/backup-redact.test.js` + 一次真实往返（见发布清单） |
| 改**检索/排序** | `src/retrieval-index.ts`、`src/retrieval-service.ts`、`src/store.ts` 的 `prepare` | `verification/r5/selection-noise-rate.mjs`、`test/retrieval-*.test.ts`、`test/fixtures/retrieval-blind-v1.json` |
| 改**数据层/表结构** | `src/store.ts`、`src/schema.ts` | `test/store.test.ts`、`test/r2-data-layer.test.ts`、`test/derived-tables-retention.test.ts` |
| 改 **DSH 工具/面板** | `adapters/dsh/index.mjs`、`adapters/dsh/client.js` | `test/dsh-adapter.test.mjs`、`test/dsh-client-surface.test.mjs`、`test/dsh-runtime.test.mjs` |
| 改 **Codex hook** | `adapters/codex/scripts/hook.mjs` | `test/codex-hook.test.mjs` |
| **打包与部署** | `scripts/package.mjs`、`scripts/deploy-plugin.mjs` | `npm run pack:local` → `npm run deploy:plugin` → `verify-host-deployment.mjs` |
| **首启与装配** | `src/cli.ts` 的 `setup` 分支、`docs/AGENT-SETUP.md` | `node dist/src/cli.js setup`（幂等，重跑不重签凭据） |
| **回合结束提炼** | `src/server.ts` 的 `/v1/tasks/archive`（`distill` 信号）、两个适配器的回合边界 | `node --test dist/test/archive-distill.test.ts` |
| **可选向量层** | `src/embeddings.ts`、`src/retrieval-service.ts` 的 `fuseWithVectors`、`src/cli.ts` 的 `embed` | 无配置即关闭；`node --test dist/test/embedding-fusion.test.js` |
| **排障** | `src/doctor.ts`、`src/cli.ts`、`*.log.jsonl`（数据目录） | `node dist/src/cli.js doctor`、`node dist/src/cli.js logs` |

## 五条踩过的坑（都不要重踩）

1. **两份适配器有逐字节一致性测试**：改 `adapters/dsh/*` 里被共享的文件时，Codex 侧同步改，否则测试红。
2. **工具定义有两处**：进程内原生注册（`adapters/dsh/index.mjs`）与 stdio MCP（`src/mcp.ts`）。只改一处，问题换条链路复发。
3. **工具 schema 里不要用 `\p{L}`/`\p{N}`**：严格的上游采样器会 400 拒掉整轮请求，本地 `node --check` 与本地调用都不会暴露。
4. **`deploy-plugin.mjs` 在核心运行时必然 EBUSY**：正确顺序是「停核心 → 部署 → 起核心」，命令见脚本自己的报错信息。
5. **发布清单里的数字会过期**：测试数、pack 文件数、验收通过项都会变；引用前重跑，不要抄（历史上抄错过 564 / 641 / 685，现为 794）。

## 落盘纪律（本仓库自己的规则）

写入知识库前**先写规范、全面的描述**，不要把流水原文、工具输出或整段源文件写进正文——原文会在检索里与真正的条目竞争并吃掉注入预算。判据与处置见 [`docs/implementation/knowledge-normalization-before-write.md`](docs/implementation/knowledge-normalization-before-write.md)，普查用 `node verification/knowledge-normalization.mjs`（基线：912 条中原文型 66 条、约 104 万字符）。

## 本文件自身也需要维护

`node verification/project-map.mjs` 会核对：登记的在役目录是否都还在、顶层有没有**未登记**的新目录、历史目录的数量与体积。**新增顶层目录后必须同时更新本文件与 `project-map.mjs` 的登记表**，否则那个目录就会变成下一个"接手者要花时间探查"的地方。
