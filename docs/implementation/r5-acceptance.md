# R5 验收（2026-10-17）

本文件只写**能复现的东西**，并把"还没证明的"单列。判据、对照值与原始数字见 [`r5-retrieval-baseline.md`](r5-retrieval-baseline.md)。

## 一、已完成并由总工程师亲自复核（可复现）

| 项 | 命令 / 证据 | 结果 |
|---|---|---|
| 类型检查 | `npm run build` | 干净通过（无输出即无错误） |
| 全量测试 | `npm test` | **632 项 / 630 通过 / 0 失败 / 2 跳过**（73.5 秒；跳过项带原因） |
| 一键验收 | `node scripts/r5-acceptance.mjs` | **检索可达规范 PASS / 回执诚实 PASS** |
| 文档合规 | `node --test dist/test/clean-install.test.js` | 3/3（含本轮全部新文档与 README 改动） |
| 队列回放 | `node verification/r5/replay-proposal-aggregation.mjs` | pending 316 → 默认视图 **205**；45 个失败签名折叠 66 条 |
| 分类回放 | `node scripts/classification-replay.mjs` | 旧判 `norm` 232 → 新判 **13**（降级 219，晋升 0） |
| 注入去重 | `.local/w6-1-injection-probe.mjs` | 同版本 834 → **53** 字符；10 轮 8340 → 530 |
| 排序对照 | `test/retrieval-norm-recall.test.ts` 的 diagnostic | 旧：日记(20735 字) 4.0000 > 规范(69 字) 2.0866；新：规范 1.9622 > 日记 1.6317 |
| 打包 | `npm run pack:local` | 产物目录记录在 `artifacts/latest.json` |
| 部署 | `npm run deploy:plugin` | 四个 profile 全部 `active=true linked=yes`，保留了回滚备份 |
| 版本控制 | `git log --oneline` | `353ac76`（代码与测试）、`184b9f2`（文档）；工作区干净 |

**改动面**：15 个文件、+1580 / -36（提交前统计）；`store.ts` 从 3492 行增至 4121 行，三条实现线的入口逐行确认共存、无互相覆盖。

## 二、重启后的实测（2026-10-17 16:1x，宿主已加载部署版本）

宿主重启由用户完成。关键处：**核心是独立常驻服务，不随宿主退出**，因此必须单独重启它，否则会出现"适配器已更新、核心仍是旧代码"的分叉。

| 项 | 命令 / 证据 | 结果 |
|---|---|---|
| 宿主加载判定 | `node scripts/verify-host-deployment.mjs` | 重启前 `RUNNING PREVIOUS BUILD`（产物 14:29:49 晚于核心启动 13:52:22）→ 重启后 **`RUNNING DEPLOYED BUILD`** |
| 核心重启 | `service stop` → `recover` → `start` | 旧 pid 32208 优雅退出、陈旧锁清理、新 pid 35816 以**部署目录的 `runtime/cli.js`** 启动 |
| 核心健康 | `node dist/src/cli.js service status` | 运行中（pid 35816，端口 47631），有响应 — 协议 v1，状态 ok |
| 一键验收 | `node scripts/r5-acceptance.mjs` | 检索可达规范 **PASS** / 回执诚实 **PASS** |
| **队列聚合已在运行中的核心上生效** | `POST /v1/proposals/list {view:'queue', include:'actionable'}` | `inState 341 → returned 218`（可审），`failureFacts 123 → failureSignatures 46`，**`collapsed 77`**；排序规则输出新的中文说明；重复最多的签名 `edit::replacefilew eio` 累计 **21 次** |
| 任务收敛（预演） | `POST /v1/tasks/converge {dryRun:true}` | 将把 **47 条** `in_progress` 收敛为 `paused`（每条附空闲时长与"这不是完成"的说明）、**20 条**归档为 `task` 作用域条目；终态任务明确不被时间规则改写 |
| **任务收敛（定时器实测）** | `amb.log.jsonl` 的 `tasks.converged` 事件；库侧 `tasks` 与 `task` 作用域计数 | **08:18:49.524Z（核心 16:13:46 启动后 5 分 03 秒）自动触发**：`converged 45 / archived 20`，阈值 `idleMs 12h / archiveAfterMs 48h`。库侧同步结果：`in_progress 49 → 4`、`paused 82 → 127`、**`completed` 保持 17（没有任何任务被判成完成）**、`task` 作用域条目 **0 → 20**（"本会话"这一层第一次有了数据） |
| **注入指针化（真实核心实测）** | 用适配器凭据向运行中的核心发两次 `POST /v1/prepare`，只差一个 `knowledgeRevision` | 不带版本：`chars 1119`、`unchanged false`；带当前版本 1957：**`chars 53`、`unchanged true`**，且 `norms 4` 完整返回（省的是重复正文，不是规则本身） |

**边界说明**：折叠区的**界面呈现**仍需目视确认；上面的证据只到接口层，我不把"接口返回正确"说成"界面看到了"。

## 二之二、一次自我更正（重要）

我先前根据预演结果写下过两条"发现"，**其中第一条是错的**，在此更正：

- ❌ **错误结论**："已经 `paused` 的任务超 48 小时后不会归档"。**撤回**。代码里归档条件是 `idleMs >= archiveAfterMs`，**不区分状态**（`src/store.ts:2969`），所以 `paused` 超 48 小时同样会归档。观测到"归档的 20 条全部来自 `in_progress`"，只是因为当时还没有 `paused` 任务超过 48 小时——这是**当时数据的样子，不是规则的样子**。我把它当成了规则。
- ⚠️ **降级为文案问题（仍成立但更轻）**：`kept` 里那些约 42 小时未活动的 `paused` 任务，理由写作"距上次记录 2513 分钟，**仍在活跃阈值内**"。它没有事实性错误（42h < 48h 的归档阈值），但"活跃阈值"没有指明是哪一个阈值，容易被读成"12 小时以内"。建议文案明确成"未到 48 小时归档阈值，且不是 `in_progress`"。

**为什么记下来**：一次 dry-run 的回执里同时含有"规则"与"当时的数据"，把后者误读成前者，就会给下一轮创造一个不存在的任务。判据是**读代码里的条件**，不是数回执里的分布。

## 三、仍待证明或仍未做到

**仍需你目视确认的两项**（接口层已通，界面层我没看过就不说通）：

1. 管理界面里是否出现「已折叠的重复失败事实」区块，并能展开取回成员；
2. 被门禁拦下的候选是否确实没有"一键采纳"按钮、改为显示拦截原因并进人工表单。

**仍未做到的部分**：

- **宿主侧任务归档未接线**：DSH 需在 `/v1/sessions/reflect` 之后、Codex 需在 `Stop` 钩子内各追加一次幂等的 `POST /v1/tasks/archive`。不接线，任务收敛仍只能靠"空闲超时"这条慢路径。
- **22 条"有回合结束事件却仍是 in_progress"的成因未定位**（已排除"结束后被写回"：其 `updated_at` 不晚于最后一次回合结束事件）。
- **失败事实去重键仍含 sessionId**：刻意未改。改了会让"同一错误出现次数"无法增长，反而损害聚合视图的表达力；倾向保留并在文档中说明。
- **模型路径未在真实库实测**：真实库验证走的是无 provider 的本地索引路径；模型选中规范只由合成 fixture 覆盖。
- **排序长度因子常数来自单一样本**，未做分布级调参；`strong` 项不参与长度归一，长文档中的强证据仍可能压过短文档的弱证据。
- **R1（审核预填）、W5（自动提炼，含空流程库导致归属失效的处置）、W6 其余项（召回段落预算、渐进披露）**：未开工。
- **未发布到 npm**：需要账号凭据，本轮未执行。

## 四、回滚

- 部署脚本保留了三组备份（插件目录、core 目录、四个 profile 的 `package.json` 与链接），路径打印在部署输出里。
- 代码回滚点：`git revert 353ac76 184b9f2` 或回到 `b81d674`。
- 数据侧不做回滚实验：真实库是用户的权威副本，所有验证都在 `VACUUM INTO` 副本或临时数据目录上进行。
