# 知识归档结构与作用域的系统性评估（2026-10-17）

本文回答四个问题：归档结构是否科学、分类是否科学、规范能否实时同步、以及全库检索与作用域该怎样分层。**结论先给，依据在后**，每一条都能对着代码或库里的数据核。

## 一、实测的现状

### 1.1 库里真正放了什么（326 条活跃条目）

| 类型 | 作用域 | 数量 | 是什么 |
|---|---|---|---|
| `skill` | global | **149** | 技能文档（外部采纳） |
| `journal` | project | **86** | 任务日记——**其他会话的产物** |
| `material` | project | **67** | 外部参考资料 |
| `memory` | global | 16 | 跨项目稳定事实 |
| `norm` | project | **4** | 硬规范（门禁执行） |
| `norm` | global | **3** | 跨项目硬规范 |
| `memory` | project | 1 | — |
| **`task`** | — | **0** | **定义了作用域，从未使用** |

三件事一眼可见：**规范只有 7 条**（稀缺资源，也是最该被检索到的）；**journal 占 86 条**，它们是别的会话留下来的记录；**`task` 档是空的**——"本会话"这一层在数据上根本不存在。

### 1.2 数据模型（`schema.ts`）

- 七种类型：`workflow`（结构化流程）/ `norm` / `skill` / `memory` / `journal` / `material` / `preference`。
- 三档作用域（`scopeSchema`，第 17-21 行）：`global` / `project(projectId)` / `task(projectId, taskId)`。
- 每条带 `provenance`（user / external / agent）、`evidence`（observed / verifiable / self-reported / unverifiable）、`labels`、`platforms`、`baseRevision`。
- `norm` 额外有 `deniedTools` 与 `hostProvided`（宿主已加载的规范不重复注入，但仍保持索引与可审计）。

### 1.3 同步方向：**单向，只读宿主，从不写回**

`discovery.ts` 会扫描 `~/.dsh/AGENTS.md`、`~/.codex/AGENTS.md`、`<cwd>/AGENTS.md`，并通过 `adopt` / `rescan` 把它们收进库。反方向**没有任何代码路径**——卸载脚本甚至明确承诺"不动 AGENTS.md"。也就是说：**用户在 AGENTS.md 里改了规范，AMB 不会自动跟；用户在 AMB 里改了规范，AGENTS.md 也不会变。**

## 二、逐项判定

| 维度 | 判定 | 依据 |
|---|---|---|
| **分类** | ✅ **基本科学** | 七类覆盖了"怎么做（skill/workflow）、必须怎样（norm）、事实（memory）、经历（journal）、参考（material）"。`provenance` 与 `evidence` 两维分离得很对：外部网页上的一句祈使句（external + unverifiable）永远不会被当成用户的规则（user + observed）。这比多数同类只存一段文本要严谨。 |
| **归档结构** | ⚠️ **缺一层** | `task` 档存在但 0 条，说明"本会话"没有被真正表达。会话级的临时结论要么被塞进 project（污染长期知识），要么进候选队列（变成待办负担）。 |
| **作用域语义** | ⚠️ **权威等级不显式** | `norm` 被门禁执行、其他类型只作参考——这是**真实存在**的区分，但它只体现在代码分支里，**不在数据、不在检索结果、不在注入文本里**。agent 拿到一条 journal 和一条 norm，看不出前者不能当规则用。 |
| **全库可检索** | ❌ **不成立** | `retrieval-service.ts:25` 与 `:132` 把 `norm` 整体排除出相关性索引；实测查询"打包脚本必须包含全量语法扫描"返回 0 条、19 个 token 全部计入 gaps，而库里那条规范几乎逐字包含这些词。 |
| **规范同步** | ❌ **不存在** | 见 1.3。 |
| **检索排序** | ⚠️ **长文档占优** | `retrieval-index.ts:131` 的 `coverage = idfSum(hits) / presentIdf`：分子命中数随文档长度增长，69 字的规范在排序上系统性输给 22KB 的日记。 |

## 三、同类项目怎么做的（本轮实读，非二手转述）

### 3.1 `ai-memory`（akitaonrails/ai-memory，Rust/MCP）

- **作用域隔离做成可选模式**：`single`（默认，进程级"当前项目"指针）/ `per_session`（按 session_id 分键）/ `per_actor`（按 user + session_id）。
- **显式参数 fail closed**：`project` / `workspace` 传错不会回落到默认，直接报错——"typo 不应创建空作用域"。
- 指针由生命周期 hook 喂入：**读工具在调用方不指定时，回答的是"agent 此刻真正所在的项目"**，而不是服务器启动时的静态默认值。

### 3.2 `Vault-Agent-Memory`（zycaskevin/Vault-Agent-Memory）

- **四层**：L0 身份 / L1 核心事实（每会话必载）→ L2 近期决策与情境（相关时载入）→ L3 深度知识（按需检索）。
- **Task Ledger 独立于 L0–L3**：只存当前任务的进行态、阻塞、下一步与交接；**只有评审后的结论才提升进 L2/L3**。
- Markdown 是人类可编辑的源，SQLite 是编译后的真相源；`access_count` / `citation_count` / `expires_at` / `supersedes_id` 都记在行上。
- 明确原则：**远程存储不得静默覆盖本地**；双向同步若要做，冲突规则必须先写清。

### 3.3 这两份对本项目的直接含义

1. **分层是对的，AMB 已有等价的隐含分层**（norm 常驻注入 = L0/L1；skill/material/journal 按需检索 = L3），**只是没写出来**——于是"该不该常驻"只能靠人记。
2. **会话层必须真实存在**，且会话结束要有去向（降级或归档），否则 task 档会一直是 0。
3. **权威等级要进数据与输出**，不能只活在分支里。
4. **同步要有方向声明**。AMB 是"DB 为真相源"，那就该明确 AGENTS.md 是**投影**，并把"用户手改文件"当成漂移检测来处理，而不是当成写回失败。

## 四、目标模型

### 4.1 三档作用域 + 一条生命周期

| 作用域 | 含义 | 默认去向 |
|---|---|---|
| `global` | 跨项目稳定事实与规范 | 常驻注入 |
| `project` | 本项目长期有效 | 注入 + 可检索 |
| `task` | **仅本会话**（会话结束失效） | 可检索；会话结束时按规则降级或归档 |

`task` 不再是装饰：采纳 `scope=task` 的候选即落入当前会话，会话结束时**默认归档**、需要长期价值时由人显式提升为 project。这一条同时解决了"临时结论污染长期库"和"候选队列堆积"。

### 4.2 权威等级（绑定 vs 参考）

不改 schema 也能表达——它是 `kind` × `scope` 的派生：

```
binding   : norm（global / project / 本会话 task）
reference : skill / memory / material / journal，以及 **任何来自其它会话的条目**
```

检索与注入的输出要**显式带上** `authority` 与 `origin`（`current-session` / `other-session` / `project` / `global`）。这样"其他会话的内容只能作参考"就不是一句口头约定，而是调用方拿得到的事实。

### 4.3 同步：AMB 为真相源，文件是投影

- `amb sync --to <file>`：把 global + project 的 `norm` 写进一个**托管块**（`<!-- amb:begin -->` … `<!-- amb:end -->`），块外内容一字不动。
- `amb sync --check`：比对托管块与库，报告漂移（谁改了什么）。
- 用户在托管块里手改 → 下次 `sync --check` 报漂移，可选择 `adopt` 反向收编或 `sync --to` 覆盖。**永不静默覆盖用户手写内容**。
- 与 `hostProvided` 的关系：写回后该条目标记 `hostProvided=true`，避免"文件里有、再注入一遍"的重复。

### 4.4 全库可检索

`norm` 进入检索索引；去重放在**注入端**（已注入集合）而不是索引端——用过滤遮住问题，正是这次"规范查不到"的成因。

## 五、实施顺序与风险

| 阶段 | 内容 | 风险 | 可验证性 |
|---|---|---|---|
| P1 | `norm` 入索引 + 注入端去重 | 中：可能重复注入 | 现有盲测 + 新增"规范可检索"用例 |
| P2 | 检索/注入输出加 `authority` 与 `origin` | 低：纯输出字段 | 契约测试 |
| P3 | `amb sync --to/--check` 托管块写回 | 中：改用户文件 | 临时目录往返 + 漂移检测用例 |
| P4 | 激活 `task` 作用域 + 会话结束归档 | 中：需定降级规则 | 生命周期用例 |
| P5 | `coverage` 归一化 | 高：动排序会改盲测基线 | **必须先建对照基线**，否则刻度不可比 |

**P5 放在最后且单独做**，理由写在上一轮：没有"规范可检索"的对照基线就去调排序，等于用一把没有刻度的尺子量另一把。

## 六、这份评估的边界

- 只读了 `ai-memory` 的 `auto_scope` 文档与 `Vault-Agent-Memory` 的 SCHEMA；**两者代码都没读**，"它们怎么做"只到文档声称的程度。
- 分布数据取自本机一个库（326 条）；`skill` 149 条来自外部采纳，不代表典型用户规模。
- 同类项目里 Basic Memory 的"Markdown 为源"路线**没有深入读**，本轮只确认了它与本项目方向相反（它是文件优先，AMB 是库优先）。
