# R5 W9：把任务收敛接到宿主侧

本文件记录 W9 的两件事：把"会话结束即归档"接到 DSH 与 Codex 两侧（幂等、失败隔离），
以及"有回合结束事件却仍是 `in_progress`"这 19 条的定位结论。所有真实库读数都是
`node:sqlite` 只读连接（`readOnly: true`）取得的；探查时间 2026-10-17T16:0x（+08:00）。

## 1. 端点与幂等语义（核实结果）

以代码为准，宿主要用的是 `POST /v1/tasks/archive`，不是 `/v1/tasks/converge`：

| 端点 | 位置 | 请求体 | 语义 |
| --- | --- | --- | --- |
| `/v1/tasks/archive` | `src/server.ts:749-755` | `{ projectId, taskId }` | 单个任务的日记落成 `task` 作用域条目。幂等，宿主可在每次 stop 调用 |
| `/v1/tasks/converge` | `src/server.ts:732-741` | `{ projectId, dryRun }` | 批量收敛 + 归档，带预演。宿主不用它，那是 core 自己的周期规则入口 |

`archiveTaskScope` 的签名是 `(projectId, taskId, { at? })`（`src/store.ts:3014-3050`），
幂等来自内容比较，不来自调用方：

1. 条目 id 由任务派生（`taskArchiveId`，`src/store.ts:3145-3148`），同一任务永远同一 id。
2. 写入前把日记与已存条目的内容做 `stableContent` 比较（去 `baseRevision`、键排序，
   `src/store.ts:3157-3163`），相同就返回 `unchanged: true` 且**不写**。
3. core 自己写进笔记的 `[自动收敛 ` / `[会话归档] ` 行在比较前被 `stripConvergenceNotes`
   剥掉（`src/store.ts:3131-3136`），否则归档会引用自己的标记、每轮都算"变了"。

因此"同一会话重复调用不产生重复写入"由 core 保证；两侧适配器再各加一层本机去重，把
"no-op 也当流量发"这件事也去掉。

## 2. 接线位置

DSH（`adapters/dsh/index.mjs`）：

- `:1251-1275` 新增 `archivedTasks` 与 `archiveSessionTask(agent, taskId)`。
- `:1277-1283` 在 `agent/turn-stopping` 监听器内、反思 steer 之前调用。

选这个位置的理由：DSH 适配器里没有 `/v1/sessions/reflect` 调用，`agent/turn-stopping`
就是适配器里唯一的"会话结束/反思"位置（它同时是发反思请求的点，见同函数内的
`reflection.requested`）。归档放在 `config.autoReflect` 与 `businessSinceCheckpoint`
判断**之前**，所以"这一轮没跑业务工具"不会让归档被跳过。

Codex（`adapters/codex/scripts/hook.mjs`）：

- `:744-775` 新增 `archiveStoppedTurn({ config, logger, sessionId, taskId, turnKey })`。
- `:826-836` 在 Stop 成功分支内、`emit({ continue: true })` 之前调用。

任务 id 取 `stopTaskId ?? result.taskId`：前者是本回合快照的绑定，后者是 core 刚在
事件回执里给出的任务。两者都空（例如从未绑定任务的 Stop）时**不发请求**——端点要求
`taskId` 至少 1 个字符，发一个空 id 只是制造一次必失败的调用。

## 3. 幂等与失败隔离的做法

幂等：

- DSH：`archivedTasks: Map<sessionId, Set<taskId>>`，**只在请求成功后**记入；失败不记，
  所以下一回合会重试。同一会话同一任务只发一次。
- Codex：把 `archivedStopTurnKey` 写进会话状态文件（`saveSessionState`），同样只在成功后写。
  同一 `turn_id` 的重复 Stop 因此不再请求；失败不写标记，下一次 Stop 重试。
- 两层都只是"少发一次"，真正的"不产生重复写入"仍由第 1 节的 core 内容幂等兜住：
  只有 `task.archived` 回执里的 `unchanged` / `revision` 能说明实际写了什么。

失败隔离：

- 两侧的归档调用都不向调用方抛错。DSH 用 `void client.post(...).catch(...)`
  （不阻塞宿主自己的停止流程），Codex 用 `try/catch` 包住，只写日志。
- 日志字段：成功 `task.archived`（`taskId`/`knowledgeId`/`revision`/`unchanged`），
  失败 `task.archive_failed`（`failureKind`/`code`/`status`/`message`）。
- 归档失败**不进 outbox / spool**：那两条队列的语义是"这个事件还没送达"，而归档是记账；
  把记账塞进事件队列会让一次不可用的归档污染事件重放路径。
- DSH 侧归档请求故意不带 `signal`：这个边界上回合自己的 signal 可能已经 abort，
  一个因此被取消的归档不会有任何东西来重试它。

## 4. 任务：为什么"有回合结束事件"却仍是 `in_progress`

### 4.1 数据（只读回放）

真实库停在 `<USER_HOME>\.agent-memory-backpack\knowledge.sqlite`。
当时：`tasks` 148 条、`in_progress` 49 条、`events` 49527 条。

事件种类分布：`tool/result` 11315、`tool/call` 11132、`step/start` 10769、`step/end` 10748、
`tool_completed` 2396、`turn/start` 1574、`turn/end` 1530、`turn_stopped` 63。

按"这个任务能不能等到回合结束信号"给 49 条 `in_progress` 分类（事件归属 = 事件带同 taskId，
或事件不带 taskId 但 sessionId 在该任务的 `session_ids` 里）：

| 类 | 定义 | 条数 |
| --- | --- | --- |
| A | 创建后没有任何事件 | 20 |
| B | 有事件，但没有任何 `kind ∈ {turn_stopped, turn_ended, turn/end}` 的回合结束事件 | 10 |
| C | **有**回合结束事件，却仍是 `in_progress` | 19 |

任务书里的口径是"28 条 = 20 条无事件 + 8 条有事件却无回合结束事件"，那是 W4 时点
（45 条 `in_progress`）的数。重算后是 `20 + 10 + 19`；W4 漏掉的正是 C 这一类，
而 C 恰好是"有信号却没生效"，与"等不到信号"是两件不同的事。

C 类逐条状态（`created` / `updated` 均为 UTC；`末次`为该任务最后一次回合结束事件）：

| task | created | updated | 回合结束事件 | 末次 kind | 末次带 taskId | updated 晚于末次停止 |
| --- | --- | --- | --- | --- | --- | --- |
| `task-18e6be61ae43a70b` | 2026-10-12T17:02:45Z | 2026-10-12T17:02:45Z | 3 | `turn_stopped` 17:03:08Z | 否 | 否 |
| `task-d296fda221c57f45` | 2026-10-12T17:06:47Z | 2026-10-12T17:06:47Z | 3 | `turn_stopped` 17:15:34Z | 否 | 否 |
| `task-1055ef7386766784` | 2026-10-13T00:57:19Z | 2026-10-13T00:57:19Z | 2 | `turn/end` 01:00:59Z | **是** | 否 |
| `task-79a26c5b297f63f0` | 2026-10-13T10:43:55Z | 2026-10-13T12:30:46Z | 9 | `turn/end` 12:35:20Z | **是** | 否 |
| `task-8a53d24bbee793e6` | 2026-10-15T19:09:02Z | 2026-10-15T19:09:02Z | 1 | `turn/end` 2026-10-16T02:53:27Z | 否 | 否 |
| `task-c21c598b47c8ad0c` | 2026-10-14T09:57:06Z | 2026-10-14T09:57:06Z | 1 | `turn_stopped` 09:57:39Z | 否 | 否 |
| `task-8c0011d05cb849fe` | 2026-10-13T16:30:40Z | 2026-10-13T17:49:53Z | 60 | `turn/end` 23:15:39Z | **是** | 否 |

共同点：停止事件都在任务创建**之后**到达（不是"先停后建"），末次停止之后任务再没有任何写入
（`updated` 全部早于末次停止），其中三条末次事件还**明确带了**该任务的 id。

### 4.2 代码级假设与数据支持

代码路径：`event()` 在事件落库后按 kind 决定要不要收敛（`src/store.ts:1785-1788`）：

```
projectId && typeof payload.sessionId === 'string'
  && ['turn_stopped', 'turn_ended', 'turn/end'].includes(String(payload.kind))
  ? this.checkpointTask(principal, { projectId, sessionId, taskId,
      idempotencyKey: payload.eventId, status: 'paused' }) : {}
```

`checkpointTask` 解析任务时按 `taskId` → `taskForSession` → `sessionIds` 包含该会话的任务，
取不到就新建（`src/store.ts:2874-2882`），并把状态写成 `paused`。所以只要这条分支被走到，
任务就不可能停在 `in_progress`。

**假设 H1（被数据支持）**：这些停止事件写入时，运行中的 core 构建里还没有这条分支，
所以事件落了库、任务却没被收敛。证据：

- 带该分支的提交是 `c852d10`（2026-10-17 02:56:24 +0800）；部署构建
  `core\runtime\store.js` 的 mtime 是 2026-10-17 之前（本地 2026-10-16 19:21:30）。
- 以该构建落进程的时间为界分窗对照停止事件（`kind ∈ {turn_stopped, turn_ended, turn/end}`）：
  上线前 1484 条里 89 条对应的任务"停止后未被写入且仍 `in_progress`"；上线后 109 条**全部**
  落回了任务（其中既有 `paused` 也有 `completed`）。两窗事件类型集合一致，差别只在时间窗口。
- C 类 19 条的末次停止事件**全部早于**该界（最晚一条 2026-10-16T02:53:27Z）。

**H2（已排除）**：不是"事件被去重/指纹相同被跳过"造成。`event()` 的重复分支只在同一
`principal + event_id` 已存在且指纹相同时短路（`src/store.ts:1778-1782`），而 C 类里
如 `task-18e6be61ae43a70b` 的三条 `turn_stopped` 各自是不同的 `event_id`、不同指纹。

**H3（已排除）**：不是"结束后被写回"。C 类 19 条的 `updated_at` 都不晚于自己末次停止
（与 W4 的结论一致），其中 15 条 `updated_at == created_at`，即从建任务起再没被写过。

**H4（已排除）**：不是 DSH 与 Codex 的用词差异现在还在漏。DSH 发 `turn/end`（aborted 时发
`turn_stopped`），Codex 的 Stop 发 `turn_stopped`；名单同时含 `turn/end`、`turn_ended`、
`turn_stopped`，两类都在内（`src/server.ts:666-676`、`adapters/codex/scripts/hook.mjs:773`）。
用词差异只对"名单尚未包含 `turn/end` 的旧构建"成立，属于 H1 的一部分。

### 4.3 为什么慢路径也没兜住（第二个成因，独立于 H1）

`convergeTasks`（in_progress 闲置 ≥ 阈值 → `paused`；更久 → 归档）与它的 5 分钟定时器
由 `353ac76`（2026-10-17 15:02:20 +0800）引入，定时器在 `src/cli.ts:1040-1053`
（`setInterval(..., 300000)`）。它在**真实部署里从未运行过**：

- 部署目录 `core\runtime\` 的 27 个 `.js` 里 `convergeTasks` 出现 **0** 次
  （`store.js`、`cli.js`、`server.js` 全为 0）；该目录 mtime 是本地 2026-10-16 19:54:31，
  早于 `353ac76`。
- 三个日志窗口（`amb-plugin.log.jsonl` 及 `.1`/`.2`、`amb.log.jsonl`）里
  `tasks.converged` 与 `tasks.converge_failed` 各出现 **0** 次。
- `core.lock` 记录的当前 core 进程 `startedAt` 是 2026-10-17T13:52:22+08:00，
  早于 `353ac76`（15:02:20）→ 进程装载的仍是旧构建。

所以 C 类至今停在 `in_progress` 不是逻辑错，而是**运行中的构建落后于仓库**：一条快路径
（回合结束）当时还不存在，另一条慢路径（空闲超时）当时也还不存在。

### 4.4 结论与最小修复

- 已定位：C 类 19 条 = 历史存量。事件到达时运行中的 core 既没有"回合结束 → 收敛"
  （`c852d10` 之前），也没有"空闲超时 → 收敛"（`353ac76` 之前）。
- 已验证这两条路径现在都有效：上线后的 109 条停止事件全部落回任务（第 4.2 节分窗对照）。
- 最小修复（改部署，不改逻辑）：
  1. 把含 `353ac76` 的构建部署到 `core\runtime\` 并重启 core。下一次 5 分钟 tick 会把
     idle ≥ 阈值的 `in_progress` 收敛为 `paused`（保留式，不会标 `completed`）。
  2. 本次接线让"会话结束即归档"，不再依赖上面那条慢路径。
  3. 想立刻处理存量，可用 `POST /v1/tasks/converge`（先带 `dryRun: true` 预演）。

## 5. 测试

| 侧 | 文件:行 | 断言 |
| --- | --- | --- |
| DSH | `test/dsh-adapter.test.mjs:396-432` | 会话结束确实发起一次 `/v1/tasks/archive`，body 为 `{projectId, taskId}`、带 `x-amb-protocol: 1`；同会话同任务不重复归档；归档 503 时 `agent/turn-stopping` 不拒绝、且失败未被记为已完成（下一次仍会请求） |
| Codex | `test/codex-hook.test.mjs:477-512` | Stop 后发出一次归档并带协议头；同 `turn_id` 的重复 Stop 不再请求；新回合可再次归档 |
| Codex | `test/codex-hook.test.mjs:514-544` | 归档端点 503 时 Stop 仍 `exit 0` 且输出 `{continue:true}`；失败未被记为已完成，下一次 Stop 重试 |
| Codex（既有用例的必要调整） | `test/adapter-delivery-fixes.test.ts:344-356` | `F07` 原先断言"整个 hook 只发了一个请求"，现在会话结束还会归档，故改为只数 `/v1/events`，并额外断言归档请求的 `projectId`/`taskId`。对 Stop 事件本身的断言没有放松 |

命令与结果：

```
npm run build                                  # 干净
node --test test/codex-hook.test.mjs           # 23 通过 / 0 失败
node --test test/dsh-adapter.test.mjs          # 3 通过 / 0 失败
node --test test/dsh-runtime.test.mjs test/codex-hook-disabled.test.mjs   # 7 通过 / 0 失败
npm test                                       # 见下
```

## 6. 未完成项

- **存量仍需重启才能收掉**：不部署 `353ac76` 并重启 core，C 类 19 条会继续停在
  `in_progress`，直到它们的会话再次结束（DSH 侧 turn-stopping / Codex 侧 Stop）触发归档。
  注意归档只写 `task` 作用域条目、不改变状态，把它们变成 `paused` 仍需 `convergeTasks`。
- **A/B 类只能靠会话结束兜**：A 类 20 条没有任何事件，若其会话不再结束，两侧都不会发起归档
  （DSH 的 taskId 来自 `sessionTasks`/`currentTaskId`，Codex 的来自事件回执，都没有就跳过）。
- **未在真实宿主进程内验证**：两侧都只在适配器层验证过。真实生效要看宿主日志里的
  `task.archived`（成功）或 `task.archive_failed`（失败），需要在部署新构建并重启宿主后确认。
- **DSH 的归档上限是每会话每任务一次**（进程内 `Map`）。同一会话切换到另一任务会为新任务
  再归档一次，这是预期；但进程重启后同一任务会被再归档一次——由 core 的内容幂等接住。
