# R5 W4：会话层与任务收敛

本文件是 W4 的实现记录：现状状态机、新规则与默认参数、`task` 作用域的真实出口、只读回放、验证数字、未完成项。
行号是 **2026-10-17 14:32（Asia/Shanghai）** 实测，仓库里多名实现者同时在改，行号可能随后漂移；判断以函数名与代码文本为准。

## 一、结论摘要

1. 库里的任务长期挂在 `in_progress`，不是"没人点按钮"，而是**根本不存在时间维度上的规则**：唯一会写状态的路径全部来自调用方，没有一条读时间。
2. `task` 作用域条目是 0 条，也不是"这一层不存在"：宿主侧的分类采纳路径能产出 `scope.kind==='task'`（`adapters/dsh/index.mjs` 的 `entryFromClassification`，`test/proposal-auto-approve.test.mjs:45` 钉住了它），但 **core 内从来没有任何写入路径产出该作用域**，也没有任何读取路径列出它。
3. 本轮补上两件事：按时间收敛（`in_progress` → `paused`，写原因）与会话结束归档（日记落 `task` 作用域并可读），并给它一个 core 周期触发点。
4. 明确不做：**不自动标 `completed`**。完成是需要证据的断言，时钟不提供证据。

## 二、现状状态机（改动前）

状态集合由表约束固定：`in_progress | paused | completed | cancelled | failed`（`src/store.ts` 的 `tasks` 表定义与 `TaskStatus`）。

| 状态 | 谁能写 | 触发路径（改动前） | 有无自动转换 |
|---|---|---|---|
| `in_progress` | 调用方 | `/v1/tasks/record`；`startTaskForSession`（会话首次工作，由 `prepare` 与 `/v1/tasks/start` 间接调用） | 无 |
| `paused` | 调用方 | `/v1/tasks/checkpoint`（`status` 缺省即 `paused`）；`event()` 收到 `turn_ended`/`turn_stopped`/`turn/end` 时自动 `checkpointTask(status:'paused')` | 有一条：**回合结束事件**会置 `paused` |
| `completed` | 调用方 | `checkpointTask`，且强制要求 `verified` 文本 + `observed`/`verifiable` 证据（否则 422 `verification_required`） | 无 |
| `cancelled` / `failed` | 调用方 | `recordTask` / `checkpointTask` | 无 |

关键事实：

- **终态不可逆**：`recordTask` 对终态任务只接受"纯打开"调用并原样返回 `unchanged`，任何回写终态的读路径都被拒（改动前的既有保护，本轮沿用）。
- **唯一的自动转换是回合结束**（`src/store.ts` 的 `event()` 中 `turn_stopped|turn_ended|turn/end` 分支 → `checkpointTask(..., status:'paused')`）。它只写状态，不写原因，也不归档。
- 与"会话结束"相关的所有判断都止步于此：**没有过期、没有收敛、没有周期性整理**。`expireProposals()` 只管候选队列，不管任务。

因此真实库呈现的形态（见第六节回放）是：回合结束事件送达过的任务变 `paused`，从未送达的就永远停在 `in_progress`。

## 三、新规则与默认参数

规则集中在 `src/store.ts` 的任务区，两个阀值都可通过 `meta` 覆盖，缺省值写在代码里（`TASK_IDLE_CONVERGE_MS` / `TASK_ARCHIVE_AFTER_MS`）。

**R1 收敛**：`status='in_progress'` 且 `now - updated_at >= idleMs` → 置 `paused`，并把原因（差值小时数、阈值、"这不是完成、未核实任何结果"、如何找回）追加进该任务自己的 `notes`。

- 选 `idleMs = 12 小时`：它长过任何一次正常会话中断（过夜、长会、长构建），短于真实库里堆积的时间尺度。实测该库所有停滞任务都已超过 12 小时，所以规则能收掉被遗弃的，而 3 条一小时内的活跃任务一个都没被碰。判错方向的代价不对称：判太短会把在做的活标成停摆，判太长只是列表再乱一会儿，所以默认取保守侧。
- **不删除、不静默**：只改状态并把理由写进记录本身。`notes` 有 4000 字符上限，超长时从头截断（保留最新解释）。

**R2 归档**：`now - updated_at >= archiveAfterMs` 的任务，把它的日记落成 `scope.kind='task'` 的条目（见第四节），并在任务 `notes` 里写下归档条目 id。

- 选 `archiveAfterMs = 48 小时`：比"只是过夜暂停"长得多，避免与仍在继续的会话抢内容；又短到"这个会话留下了什么"当天就能查。实测该库 48 小时以上的停摆任务正好是 20 条。
- 归档**不改变状态、不删内容**，因此判错也只是多一条可在任务里查到的记录。
- 归档判定用的是**收敛前**的 `updated_at`：收敛本身会刷新时间，但改写状态是记账，不是进展。

**幂等**：归档条目的 id 由任务 id 决定（`taskArchiveId`），写入前与已存条目做内容比较（忽略键顺序与 `baseRevision`）。内容没变就什么也不写并回报 `unchanged: true`；内容变了（后续 checkpoint 增加了事实）才作为**同一条目的新修订**写入。收敛写入笔记本记账行时也不进入归档内容，否则归档条目会因为引用自己的归档标记而每次重写（见 `stripConvergenceNotes` 的注释与对应测试）。

**配置**：`store.taskConvergence()` / `store.setTaskConvergence({ idleMs, archiveAfterMs })`，后者要求 `idleMs >= 60_000` 且 `archiveAfterMs >= idleMs`（先声明停摆再归档，顺序不能反过来）。阈值不暴露 HTTP 设置端点，理由见第九节。

## 四、为什么没有"自动完成"

`completed` 在本项目里是一个**带证据的断言**，不是"没人再动了"的同义词：

- `checkpointTask` 拒绝没有 `verified` 文本或证据等级不足的完成（`verification_required`）。
- 日记与导出把"完成但无依据"记成 `unverified`，成功必须落在 `observed`/`verifiable` 证据上（`generateJournal` 的 `checkable` 判定）。
- 设计上 Stop、取消、暂停、失败都不得被折算成完成。

时间规则能提供的只有"多久没人记录"，这既不是结果也不是证据。因此收敛只产出 `paused`，把"是不是真的做完了"留给下一次有人带着证据的 checkpoint。同理，规则也不把 `paused` 推向 `cancelled`/`failed`：那是另一个断言。

## 五、`task` 作用域的真实出口

已核实的三条事实：

- 宿主侧能够产出该作用域：`entryFromClassification` 需要候选分类 `scope: 'task'` **且**带 `taskId`，否则返回 `null`（拒绝降级为项目作用域），真实库里 0 条说明这条路径从未被走到。
- core 侧此前**没有任何**写 `task` 作用域的路径：`generateJournal` 明确写 `scope: { kind:'project' }`，`writeJournal` 沿用同一份内容。
- **读取侧同样没有出口**：`applicable(scope, projectId, taskId?)` 在没有 `taskId` 时对 `task` 作用域一律返回 false，而 `getKnowledge`/`readKnowledge`/`history`/`searchUniversal`/`knowledge` 都不带 `taskId`。也就是说，即使写进去也读不到——这正是缺陷 C 末段说的"从来没有数据落进去、也没有退出规则"的完整形态。

本轮补上的出口：

- **写**：`archiveTaskScope(projectId, taskId)` —— 把该任务的日记落成 `task` 作用域条目（先收敛到 `paused`，再归档），由 `/v1/tasks/archive` 与 `/v1/tasks/converge` 暴露。默认归档而不是丢弃；内容是日记（任务自己的事实），不是模型叙事。
- **读**：`taskScopedEntries(projectId, taskId)`，随 `/v1/tasks/activity` 返回 `taskScoped`，带正文摘要与备注。这是唯一能读到归档内容的通道，所以它返回文本而不只是标题——只给标题等于仍然不可读。
- **提升**：`promoteTaskScope(projectId, knowledgeId)` 把条目改为项目作用域。这是**扩大适用范围**，按 `policy.ts` 的既有判定属 `user` 层级，因此 `/v1/tasks/promote` 被加入 `ADMIN_ONLY`，agent 调用得到 403；旧的任务作用域修订留在历史里，扩大动作可追溯。
- **不泄漏**：归档条目在没有 `taskId` 的检索里依然不可见（有测试钉住），"这一次"不会变成"以后每一次"。

## 六、真实库回放（只读）

只读脚本用 `node:sqlite` 以 `readOnly: true` 打开 `<USER_HOME>/.agent-memory-backpack/knowledge.sqlite`，不做任何写入；原库、原 WAL 均未被改动。

采样 `2026-10-17T06:32:42Z`（本地 14:32）：

| 项 | 实测 |
|---|---|
| 任务总数 | 145（in_progress 50 / paused 81 / completed 14 / cancelled 0 / failed 0） |
| `in_progress` 停滞时长 | <1h 3；1-12h 2；12-48h 25；48-168h 20 |
| `paused` 停滞时长 | <1h 8；1-12h 2；12-48h 71 |
| 现有 `task` 作用域条目 | **0** |

套用默认规则（12h / 48h）的结果：

- **45 条 `in_progress` → `paused`**（带原因）；剩 5 条不动（3 条 <1h、2 条 1-12h，都是活跃的）。
- **20 条进入归档**（全部来自 `in_progress` 的超期那批），即新增 20 条 `task` 作用域日记；`paused` 中**没有一条**超过 48 小时，所以从 `paused` 归档的是 0 条。
- 没有一条被标成 `completed`。

阈值敏感性（同一库、同一时刻，只改参数）：

| idle / archive | 收敛为 paused | 归档 | 剩余 in_progress | 归档中来自 paused |
|---|---|---|---|---|
| 6h / 24h | 45 | 37 | 5 | 14 |
| **12h / 48h（默认）** | **45** | **20** | **5** | **0** |
| 24h / 72h | 23 | 17 | 28 | 0 |
| 24h / 168h | 23 | 0 | 28 | 0 |

`24h` 只收掉 23 条、留下 28 条仍挂在 `in_progress`，收敛不足；`6h/24h` 会把 14 条刚暂停不久的任务也归档，过于激进。默认值取 12h/48h 正是这条实测曲线的中间。

"为什么这些任务会停在 in_progress"的只读核对（同一只读脚本）：

- `paused` 81/81、`completed` 14/14 都有回合结束事件（`turn/end` 1522 条、`turn_stopped` 63 条）——既有的结束事件路径确实在工作。
- `in_progress` 50 条里：20 条**没有任何事件**、8 条有事件但没有回合结束事件（合计 28 条从未拿到结束信号）；另 22 条有回合结束事件，且其 `updated_at` 不晚于该事件（没有被"写回"）。
- 所以：新规则覆盖的正是这 28 条 + 22 条里超期的部分；时间规则不需要结束信号，这也是它必须存在的原因。那 22 条的成因（有结束事件却未落地为 `paused`）本轮未定位，见第九节。

## 七、改动清单

| 文件 | 位置（2026-10-17 14:32） | 内容 |
|---|---|---|
| `src/store.ts` | 2591-2629 | `taskIdleConvergeMs` / `taskArchiveAfterMs` / `taskConvergenceThreshold` / `taskConvergence` / `setTaskConvergence` |
| `src/store.ts` | 2871-2883 | `taskActivity`：日记只取项目作用域日记；新增 `taskScoped` 与 `convergence` 字段 |
| `src/store.ts` | 2905-2969 | `convergeTasks(projectId?, { now, dryRun })` |
| `src/store.ts` | 2971-3007 | `archiveTaskScope` |
| `src/store.ts` | 3018-3043 | `taskScopedEntries`（带正文摘要，唯一可读通道） |
| `src/store.ts` | 3046-3066 | `promoteTaskScope`（task → project，走 `policy.ts` 的 `user` 层级） |
| `src/store.ts` | 4062-4121 | 模块级常量与工具：`TASK_IDLE_CONVERGE_MS`、`TASK_ARCHIVE_AFTER_MS`、`appendTaskNote`、`CONVERGENCE_NOTE_MARKERS` / `stripConvergenceNotes`、`taskArchiveId`、`stableContent` |
| `src/server.ts` | 96 | `ADMIN_ONLY` 增加 `/v1/tasks/promote` |
| `src/server.ts` | 711 / 728 / 741 | 新增 `/v1/tasks/converge`（含 `dryRun`）、`/v1/tasks/archive`、`/v1/tasks/promote` |
| `src/cli.ts` | 1040-1056 | core 周期触发收敛（5 分钟一次，幂等，失败只记日志） |
| `src/cli.ts` | 1057 / 1075 | 退出与启动失败路径一并清理 `convergeTimer` |
| `test/session-convergence.test.ts` | 新增 | 10 个用例，见下节 |

未触碰：`store.ts` 的 `proposals`/`adopt`/`rescan`/`knowledge`/`retrieval` 区域；`adapters/**` 全部未改。

## 八、测试与验证

命令与结果（本机 Node 24.19.0）：

- `npm run build` → 通过（`tsc -p tsconfig.json`，无错误）。
- `node --test dist/test/session-convergence.test.js` → **10/10 通过**。
- 相关既有套件 `dist/test/{tasks,task-journal,task-checkout-difference}.test.js` → **25/25 通过**（含新文件）。
- `npm test`（全量）→ **615 项：613 通过 / 0 失败 / 2 跳过**（基线为 584 项，本轮新增 10 项，其余增量来自并行的其他实现线）。

`test/session-convergence.test.ts` 覆盖：

1. 无进展任务被收敛为 `paused`，原因、阈值、"这不是完成"都写进记录，`completedAt` 保持 null。
2. 有进展的任务与仍在活跃窗口内的任务都不被误收敛，且出现在 `kept` 里（不是被静默跳过）。
3. 终态任务（`completed`/`cancelled`）不被时间规则改写。
4. 会话结束后归档出 `task` 作用域条目：可查（`taskActivity.taskScoped`）、正文可读、不泄漏（`searchUniversal`/`knowledge` 都不返回）。
5. 幂等：同一时刻重跑不新增条目、不新增修订、不重复追加说明；很久以后再跑，内容未变时回报 `unchanged: true` 且修订号不变。
6. 归档内容不含收敛/归档记账行（否则会自我重写）。
7. `dryRun` 只报告不写入。
8. 阈值可配置、有下界、非法组合被拒。
9. `task → project` 提升后全项目可见，且历史保留两个修订。
10. 端点级：`converge`/`archive`/`activity` 对 adapter 可用且幂等；`promote` 对 adapter 返回 403，admin 可用。

## 九、未完成项与风险

1. **宿主侧未接线**（按本轮约束不改 `adapters/**`）。要生效需要总工程师接线，改动点与理由：
   - `adapters/dsh/index.mjs`：回合结束/会话停止的收尾处（当前发 `/v1/sessions/reflect` 的位置）之后调用一次 `POST /v1/tasks/archive`（body `{ projectId, taskId }`）。理由：core 的周期规则最慢 5 分钟才收敛，而宿主此刻已经知道"这个会话结束了"，可以立刻归档，且该调用幂等，失败一次不影响下一轮。
   - `adapters/codex/scripts/hook.mjs`：`Stop` 钩子里同上调用一次（Codex 侧目前同样只有 checkpoint，没有归档动作）。
   - 二者都只需"多一次 POST"，不需要新的凭据、协议头或权限。
2. **core 周期触发已接线但未端到端验证**：`src/cli.ts` 的 5 分钟定时器只在真实 core 进程里跑，本轮没有做"重启宿主 → 观察 `in_progress` 下降"的实测（属于 V1 端到端验收范围）。现有证据是单元级与端点级。
3. **阈值没有 HTTP 设置入口**：只能通过 `store.setTaskConvergence()` 设置。理由：改阈值是管理动作，应当与 `/v1/rescan/interval` 同模式并配 admin 权限与审计；本轮没有扩大端点面，留给需要时由总工程师决定。
4. **22 条"有回合结束事件却仍是 `in_progress`"的成因未定位**：已排除"结束之后被写回"（其 `updated_at` 不晚于最后回合结束事件）。新规则按时间判定，不受此影响，但它可能指向 `event()` 的 reflect 分支里有未被覆盖的失败模式，值得单独排查。
5. **真实库回放是模拟**：只读统计套用规则，没有在副本上真跑一遍写入。库是活的（采样期间任务总数从 143 变 145，另有会话在写），所以数字有漂移；结论以同一时刻的横截面为准。
6. **动作会即时刷新 `updated_at`**：收敛与归档都通过 `recordTask` 写状态或备注，因此会把 `updated_at` 推到当前时刻，归档窗口从"上次动作"重新计时。这是有意的（否则每次 tick 都会重复归档判定），但也意味着"任务实际最后有进展的时间"要以 `notes` 里的收敛时间戳为准，而不是 `updated_at`。
