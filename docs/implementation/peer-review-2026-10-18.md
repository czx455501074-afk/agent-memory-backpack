# 同类项目多参考对照：功能与使用维度（2026-10-18）

回应的问题：**结合 GitHub 相似项目，我们的插件在功能与使用上是否已经完善、足够用户使用。**

**方法与自限先说清**：
- 对比对象共 **8 个**，其中 3 个（`unified-agent-memory`、`memforge`、`ironcurtain` 的对比文档）是本轮**联网读到的原文**；`agent-memory-mcp`、`memory-bridge`、`dsh-memory-evolve`、`dsh-mnemon` 沿用 2026-10-17 那轮的记录；通用记忆系统（Hindsight / doobidoo / Basic Memory / 官方 MCP Memory 等）的能力取自一份**第三方对比文档**，**未读其代码**。
- 我方每一格都是**本项目实测或契约钉住的事实**（测试 794 项 / 契约 33 条 / 真实库 912 条）。
- **未核实项一律标注**：星标数、活跃度、对方实现细节、收录目录的实时数字都没有核。
- "功能更多"不等于"更适合"：本文最后一节区分**刻意取舍**与**真实缺口**。

## 一、对比对象

| # | 项目 | 定位 | 出处 |
|---|---|---|---|
| 1 | [`Noelune/unified-agent-memory`](https://github.com/Noelune/unified-agent-memory) | **与本项目定位几乎重合**：dsh/Codex/Claude Code/Hermes 共享 Obsidian Vault + SQLite FTS5 | 本轮读其 README 原文 |
| 2 | [`zql0805/memforge`](https://github.com/zql0805/memforge) | 团队级工程记忆平台：PostgreSQL+pgvector+Redis+Gateway(OAuth/RBAC)+Web UI，77 个 MCP 工具 | 本轮读其 README 原文 |
| 3 | [`provos/ironcurtain`](https://github.com/provos/ironcurtain/blob/HEAD/docs/designs/memory-server-comparison.md) 的对比文档 | **第三方横向对比**：12 个系统 × 14 维度 | 本轮读原文 |
| 4 | [`ipiton/agent-memory-mcp`](https://github.com/ipiton/agent-memory-mcp) | Go，分层知识 + 取代链 + 审核收件箱 + 漂移检测 | 2026-10-17 记录（读 README） |
| 5 | [`yanglinfeng/memory-bridge`](https://github.com/yanglinfeng/memory-bridge) | 答案带逐句出处与可回放 traceId | 2026-10-17 记录（仅仓库页简介） |
| 6 | `dsh-memory-evolve` / `dsh-mnemon` | DSH 生态内的记忆插件 | 2026-10-17 记录（读 README） |
| 7 | `dsh-memory-bundle` | "中文感知搜索、去重、混合向量记忆和跨会话核心记忆减少 token 消耗" | 本轮搜索结果（**未读原文**） |
| 8 | Hindsight / doobidoo MCP Memory / Basic Memory / 官方 MCP Memory / Mem0 / Zep / Letta 等 | 通用记忆系统 | 第三方对比文档（**未读代码**） |

**生态位置**：`unified-agent-memory` 已被 [awesome-dsh-plugin](https://awesome-dsh-plugin.com/p/Noelune/unified-agent-memory/) 与 [dsh.deepseek404.com](https://dsh.deepseek404.com/detail.php?id=Noelune%2Funified-agent-memory) 等目录收录；[awesome-deepseek-harness-plugins](https://github.com/imsai-sh/awesome-deepseek-harness-plugins) 的规则是**只有发布到 npm 且声明 `dsh.bundle` 的插件才给安装命令**，其余只能"浏览模式"。**本项目未发布到 npm，因此在这些目录里只能被浏览。**

## 二、功能维度对照

✅ 具备　⚠️ 部分具备／有明确边界　❌ 不具备

| 维度 | 本项目（实测） | unified-agent-memory | memforge | agent-memory-mcp | 通用系统（第三方文档） |
|---|---|---|---|---|---|
| 存储形态 | SQLite（含 FTS5 派生索引） | Obsidian Vault（Markdown）+ SQLite FTS5 派生索引 | PostgreSQL + pgvector | SQLite | JSONL／Postgres／Redis／Neo4j 各异 |
| **版本化修订沿革** | ✅ 每次修订留档，`history` / `asof` 可查 | ⚠️ 有取代小节与历史留痕（笔记级） | ⚠️ 记忆可更新/归档（未声称逐版沿革） | ⚠️ 取代链 `superseded_by` | ❌ 多数只存"当前值" |
| **审核门禁（服务端强制）** | ✅ 候选→采纳分离；服务端强制人工确认；三入口一致 | ⚠️ Promoter 审核 + 默认 human-confirmed | ⚠️ 规则投票（admin/lead/dev 权重） | ⚠️ 审核收件箱 | ❌ 多为直接写入 |
| 检索 | ⚠️ 词法（中文 bigram）+ 可选模型选择；**无向量** | ✅ 五路混合（BM25+中文 bigram+向量+图谱+trigram，RRF）+ token 裁剪 | ✅ 向量 HNSW + BM25 + RRF | ⚠️ 可解释检索（分数构成） | Hindsight ✅ 四路+cross-encoder；官方 ❌ 仅子串 |
| 注入预算控制 | ✅ 字符预算、超预算只缩召回段、规范永不缩、指针化复用 | ✅ 按真实 token 预算裁剪 | ⚠️ 未见（有缓存） | ⚠️ 未见 | Hindsight ✅ / SimpleMem ✅ / 多数 ❌ |
| 自动提炼 / 会话捕获 | ⚠️ `evolve` 三阶段（重复信号→候选→提案）**默认预演、绝不自动采纳**；宿主 hook 部分自动 | ✅ `memory digest` 默认开启，从会话归档提炼 | ✅ Commit/Review/文档学习 + hooks | ✅ 会话结束自动提炼 | Mem0/Zep/Letta ✅；官方 ❌ |
| 遗忘 / 衰减 | ⚠️ 过期与归档（重要项豁免过期） | ✅ 显著性×衰减×强化评分 | ⚠️ 归档 | ⚠️ 漂移检测 | doobidoo ✅ / Hindsight ✅ / 官方 ❌ |
| 冲突与取代 | ✅ 取代/补充（`supersede`/`supplement`），关系可审计 | ✅ Adjudicator 冲突裁决 | ⚠️ 去重 + 规则冲突检测 | ✅ 取代链 | Zep ✅ 时间有效性 |
| 凭据脱敏 | ⚠️ 导出守卫（拒绝/`--redact-credentials`）；**入库不脱敏** | ✅ 摄取前掩码清洗 | ✅ 入库前拒绝 Key/Token/PII | 未见 | 第三方文档未列 |
| prompt-injection 隔离 | ⚠️ 注入块带来源与状态标记；**无 `<memory-data>` 式包装** | ✅ `<memory-data>` 隔离标记 | 未见 | 未见 | — |
| 人类可直接读/编辑的存储 | ❌ 库内为 JSON/SQLite（`export` 可导出 SKILL.md） | ✅ Markdown + Obsidian 直接编辑审计 | ⚠️ Web UI | 未见 | Basic Memory ✅ |
| 跨客户端共享 | ✅ DSH + Codex，**同一份规范同时注入两端 + 各自门禁** | ✅ dsh/Codex/Claude/Hermes | ✅ 多 IDE（MCP） | ❌ 单客户端配置 | 多为单客户端 |
| 迁移 / 备份 | ✅ `.ambpack` 导出/预览/导入；已修好守卫自锁 | ⚠️ 未见迁移机制 | ✅ 导出/导入工具 | 未见 | 多数 ❌ |
| 多用户 / 团队 / 权限 | ❌ 单机（凭据分 codex/dsh/admin 三种角色） | ❌ 单机 | ✅ OAuth2.1+RBAC+RLS+产品线隔离 | ❌ | Redis/Zep ✅ |
| 任务交接 / 检查点 | ✅ `checkpoint_task` + 任务日记 + 收敛 + 宿主侧归档 | ❌ 未见 | ⚠️ 工作上下文追踪 | ❌ | ❌ |
| 图谱 / 拓扑 | ❌ 有意不做 | ✅ 概念图谱（检索第五路） | ✅ 服务拓扑 + 变更影响分析 | ✅ 三元组多跳 | Zep/Mem0 ✅ |

**读法**：本项目的深度项（版本化、门禁、任务交接、迁移）**没有一个对手同时具备**；广度项（向量、图谱、自动提炼、脱敏、人类可读存储、多用户）**对手普遍具备而我们缺**。

## 三、使用维度对照（这一节比功能更决定"能不能用起来"）

| 维度 | 本项目 | unified-agent-memory | memforge | 通用系统 |
|---|---|---|---|---|
| **安装方式** | ❌ **未发布 npm**：`clone → npm ci → build → install:local → dsh plugin add → 重启`（6 步）；另有 Windows 桌面安装包（NSIS/MSI） | ✅ `dsh plugin --profile web add dsh-unified-agent-memory`（1 步，已发 npm） | ⚠️ Docker Compose + 手工建库 + 配 Embedding | 官方 ✅ `npx`；Hindsight ⚠️ 需 Postgres |
| **平台** | ❌ **仅 Windows x64** | ✅ 跨平台（Python ≥3.10 + Node ≥20） | ✅ 跨平台 | 多数跨平台 |
| **运行时依赖** | ✅ 仅 Node 24（内置 SQLite，零外部服务） | ✅ 纯 Python 标准库 + Node（无第三方依赖） | ❌ PostgreSQL+pgvector+Redis+Docker | 官方 ✅ 1 依赖；Hindsight ❌ Postgres |
| **首启** | ⚠️ 需手工 profile 命令 + 重启；`doctor` 可自检 | ✅ 挂载后由 agent 自动装配（读任务书自动写各 Agent 配置） | ⚠️ 手工配置较多 | 官方 ✅ 零配置 |
| 管理界面 | ✅ 核心自带网页控制台（`amb ui --open`）+ DSH 内嵌面板 + Tauri 桌面 | ⚠️ 靠 Obsidian 浏览 | ✅ Vue3 Web UI | 官方 ❌；doobidoo ✅ |
| **接手/维护文档入口** | ✅ 本轮新增 `AGENTS.md` + 机检（`project-map.mjs`） | ⚠️ 有 ARCHITECTURE/DEPLOY/SECURITY 三份 | ✅ 文档较全 | 差异大 |
| 升级 / 回滚 | ✅ 打包/部署脚本 + 备份轮转 + `verify-host-deployment` 判定"宿主在跑哪一版" | ⚠️ 未声称 | ⚠️ 迁移脚本 | — |
| 卸载 | ✅ `amb-uninstall.mjs`（含锁文件安全处置） | 未读 | 未读 | — |
| 排障 | ✅ `doctor`（11 项）+ `logs`（按事件/级别/来源过滤）+ 结构化错误码 | ✅ `memory doctor` / `memory gc` | ⚠️ Prometheus | 差异大 |
| 许可 | MIT | MIT | MIT | 多为 MIT/Apache |

## 四、结论：够不够用，取决于"谁用"

**① 对你自己（本机、单机、DSH+Codex 双宿主）：够用，而且有一项稀缺能力。**
真实库 912 条、四个 profile 已挂载、核心常驻、备份迁移已通、审核与门禁在服务端强制。本轮对照的 8 个项目里，**没有一个同时具备"逐版沿革 + 服务端强制审核门禁 + 任务交接 + 可解释检索回执 + 跨宿主同一份规范注入"**。这是本项目的核心价值，也是当初刻意收窄范围换来的。

**② 对陌生人从零装：不够——不是功能不够，是分发与平台不够。**
三条硬伤按影响排序：
1. **未发布到 npm**。生态目录（如 awesome-deepseek-harness-plugins，含"记忆"类数百个）只给已发 npm 的插件安装命令；我们只能被"浏览"。这是**唯一安装前提**，而包结构与自包含性早已就绪（此前实测 tarball 可装可跑）。
2. **仅 Windows x64**。对照项目里 `unified-agent-memory`、`memforge`、doobidoo、Basic Memory 都是跨平台。
3. **首启 6 步 + 手工 profile 命令 + 重启**。对手已做到"一条命令 + agent 自动装配"。

**③ 对"团队/多用户"场景：明确不覆盖**（无 RBAC、无多租户）。memforge 那类定位不适合用本项目替代，也不该硬追。

## 五、缺口清单（按"用户能感知的价值 / 成本"排序）

| 编号 | 缺口 | 性质 | 为什么这个顺序 |
|---|---|---|---|
| **T13** | 发布到 npm（两个包） | **分发阻塞**（需要账号凭据，非代码） | 不解此条，其余改进对陌生用户都不可达 |
| **T16** | 跨平台（至少 macOS 验证；`icon.icns` 缺失是已知项） | **分发阻塞** | 与 T13 并列，决定可服务人群 |
| **T17** | 首启"一条命令 + agent 自动装配" | 体验差距 | 对手已做到；我们把配置步骤交给用户 |
| **T18** | 入库前凭据脱敏 | **安全缺口**（我方唯一"我方弱于对手"的安全项） | `unified-agent-memory` 与 memforge 都在摄取前清洗；我们只在导出时拦 |
| **T19** | 注入块 `<memory-data>` 式隔离包装 | 安全增强 | 对手已做；成本低 |
| **T2** | 检索质量（当前盲测精确率 0.381 / 召回 0.727；`r5-acceptance` 回执诚实 FAIL 未解决） | 真实质量缺口 | 见发布清单第七节，需先测量再改 |
| **T1/T11** | 回合内自动提炼（更完整的 hook 化） | 有意滞后 | 会改变审核负载，需独立设计 |
| T5/T12 | 向量 / 图谱 / 多模态 / 神经重排 | **刻意取舍** | 当前规模词法够用、可解释、可离线；对手引入外部依赖 |

## 六、这份对照的自限

- **没有实测任何对手**：所有对手能力都来自其文档自述或第三方对比文档，**没有安装、没有跑基准**。我方每格都有实测或契约支撑。
- **第三方对比文档写于 2026-03-11**，且作者当时在做选型决策（有立场）；引用它只为"通用系统的能力面"，不作为质量排名。
- **未核实**：各项目星标与活跃度、收录目录的实时数字、`dsh-memory-bundle` 与 `dsh-memory-evolve` 的当前实现。
- **"够用"是相对判断**：相对"你自己使用"与"公开发布给陌生用户"两种场景给出，不是绝对结论。
- 本文不改代码，也不代表已排期：T13/T16 需要凭据与平台环境，T18/T19 需要设计周期。
