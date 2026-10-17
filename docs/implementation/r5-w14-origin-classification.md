# B3 实施报告：捕获管线按来源分类（W14）

依据：`docs/implementation/r5-gate-and-backfill-design.md` 的 B3 节；问题证据来自 `docs/implementation/r5-usage-report.md` 第六、七节。设计形状未改，只把它落到代码与实测数字上。

## 1. 改了什么（文件:行）

| 位置 | 内容 |
|---|---|
| `src/refine.ts:120-268` | 来源分类（采样框架）：`FailureOrigin` 三值、`FAILURE_ORIGINS`、`FAILURE_ORIGIN_MARKER`、`ORIGIN_RULES`(186)、`classifyFailureOrigin`(225)、`failureOriginOf`(250) |
| `src/refine.ts:478-503` | `RefineRun` 新增 `sampledGroups`、`origins`、`excludedByOrigin` |
| `src/refine.ts:514-600` | `collect` 先按来源分帧再分组：只有 `task_failure` 成员进入 `bySignature`，非任务行单独汇总成 `excludedByOrigin` |
| `src/refine.ts:640-660` | 返回体与 `note`：来源分布与"多少个签名被移出统计"如实报出 |
| `src/refine.ts:52-62` | 路径脱敏**不在本模块**的位置与理由（写在模块头注释） |
| `src/refine.ts:66-79` | "是否可复现"的判据注释（`minOccurrences` 旁） |
| `adapters/dsh/failure-capture.mjs:4-57` | 同一张规则表 + `classifyFailureOrigin`（捕获侧判定） |
| `adapters/dsh/failure-capture.mjs:95-99` | 捕获时写 `失败来源类别：<origin>；判据：<rule>。`，位置在 `观察：` 行之前 |
| `adapters/codex/scripts/failure-capture.mjs` | 同一内容的副本，与 DSH 侧**逐字节相同**（hash `A16FA59B79BD0696336AA62612B5393BC14F84544B0FA8FC7A99BAEB179E15F8`） |
| `test/failure-origin.test.ts` | 新增 W14-R1…R5（提炼器侧） |
| `test/failure-capture.test.mjs:11` | 新增捕获侧 + 两侧一致性 parity 测试 |
| `test/refine-skeleton.test.ts` | W11 的 fixture 从并发冲突形状换成任务失败形状（见 §7） |
| `verification/r5/replay-failure-origin.mjs` | 只读普查：来源分布、阈值覆盖前后、指定签名是否仍在采样总体内 |

## 2. 分类规则（可复核的判据，不是"看起来像"）

三条值：`tool_collision` / `environment` / `task_failure`（默认）。判定**只读观察文本**，按顺序第一个命中的规则生效，`tool_collision` 在前。

| rule id | origin | 判据（正则级可复核） |
|---|---|---|
| `concurrent_edit_target_missing` | tool_collision | `/old_string was not found in/` |
| `concurrent_edit_file_changed` | tool_collision | `/file changed since it was read/` |
| `timeout` | environment | `/\btime(?:d\|s)?\s*out\b\|\btimeout\b\|ETIMEDOUT\|超时/i` |
| `io_error` | environment | `/\bEIO\b\|\bEXDEV\b\|Win32 (?:1175\|1176\|1177)\b/` |
| `cross_volume_eperm` | environment | `/\bEPERM\b\|cross-device link\|跨盘符/` |
| `port_in_use` | environment | `/\bEADDRINUSE\b\|address already in use\|端口.{0,4}占用/i` |
| `interrupted` | environment | `/tool call (?:was )?aborted\|aborted before dispatch\|\bEINTR\b\|\bSIG(INT\|TERM\|KILL)\b\|interrupt(?:ed\|ion)\|被中断/i` |

两点刻意的取舍，写进了代码注释：

- **"文件没读过"不算并发冲突**。`cannot modify "…": file has not been read — read the file, then retry`（本库 19 行）归 `task_failure`：它说的是"调用方自己没读过"，不是"别人改过"。若把它并进 `tool_collision`，会把一条有明确修法的真实失败也一起丢掉。
- **"文件冲突"是按文本形状判定的，不是并发证明**。拼错的 `old_string`、以及本会话自己先前改过的文件，读起来完全一样。可以接受的代价：判错的唯一后果是这一行不被用来标定阈值、不进入提炼采样，**永远不是"被记成知识"**。

## 3. 提炼器：只从 `task_failure` 取样（阈值统计剔除事故）

- `collect` 先按来源分帧，`tool_collision` 与 `environment` **不进入 `bySignature`**，因此不计入出现次数、跨度与置信度；它们以 `excludedByOrigin`（签名、次数、类别、判据来源）单独报出，不是静默减法。
- **老数据的归类方式**：库里的 155 条失败事实都写在这次改动之前，正文里没有标记行。`failureOriginOf` 先认标记，没有再**从正文推导**（`basis: 'derived'`），因此这 155 条不会因为"当时没有分类器"被一律读成 `task_failure`——那正是使用报告点名的错误读法。标记与推导不一致时以**标记为准**（写入方当时看到的是结构化结果），`rule` 一并记录，便于按规则回溯一批行。
- **与负向过滤保持独立**（设计第 5 条）：来源分类回答"这个样本是不是来自阈值描述的那个总体"，负向过滤回答"这条失败本身有没有可行动信息"。两者不合并：
  - `pwsh exit_code=1`（12 次）是任务失败但无可行动信息 → **留在采样总体内**，被 `no_actionable_detail` 挡下；
  - `old_string was not found in "…"`（12 次）有充分可行动信息、能过所有负向过滤 → 仍然**不进入统计也不产出**，因为它是事故。

## 4. 真实库数字（快照上按新规则重算，库本身未被改动）

**先说清口径**：库里的候选**都还没有**来源字段——改动尚未部署，真实数据还没流经新管线。下表"分类后"不是"库里的数据已经被分类"，而是**把真实库快照按新规则重算一遍**得到的结果；库内数据、状态与计数一个字节都没有变。这与"数字变了 ≠ 用户的数据被改了"是同一条纪律。

方法：`verification/r5/replay-failure-origin.mjs`。读法是把真实库复制一份再 `VACUUM INTO` 快照，全程不打开原库写；脚本打印原库 sha256 并断言前后一致。

- 库文件 `knowledge.sqlite`，sha256 `7f727cb72bd972a2…`，**未改动 = 是**
- 待审 398 条 = 自动捕获失败事实 **155** + 人工提交 243；47 个失败签名

**① 分类前后各类 origin 的条数与占比**

| | tool_collision | environment | task_failure |
|---|---|---|---|
| 分类前（旧口径：无分类，全部失败事实计入） | — | — | 155 条 / 100%（47 签名） |
| 分类后 | **23 条 / 14.8%**（2 签名） | **42 条 / 27.1%**（6 签名） | **90 条 / 58.1%**（39 签名） |

`environment` 的 42 条构成：`io_error` 36（`ReplaceFileW EIO (Win32 1175)`）、`interrupted` 3、`timeout` 3。`tool_collision` 的 23 条：`concurrent_edit_target_missing` 12 + `concurrent_edit_file_changed` 11。

**② `minOccurrences=2` 门槛覆盖的组数与行数（前后对比）**

| | 组数 | 行数 | 被门槛丢掉 |
|---|---|---|---|
| 分类前（所有失败事实计入） | 47 组中留下 **11 组** | **119 条** | 36 组 / 36 条 |
| 分类后（只计 `task_failure`） | 39 组中留下 **7 组** | **58 条** | 32 组 / 32 条 |

移出统计的共 **8 组 / 65 条**，其中 **4 组原本已达门槛**（36× EIO、12× `old_string was not found`、11× `file changed since it was read`、2× 超时 = 61 条）——即原先"达到门槛"的行里有 **51%（61/119）是事故**。

**真实提炼器在同快照上的自报**（不是本脚本另写的一套算术，而是直接调 `collect`）：`scanned 398；失败签名 47，其中进入统计 39；通过门槛 1；产出 1；移出统计 8 个签名 / 65 条`。两组数字一致。

**③ 报告点名的那 20 条是否不再进入采样**

现状库里同类是 **12 条（`old_string was not found in "…"`）+ 11 条（`file changed since it was read`）= 23 条**（使用报告写 11+9=20，是当时的计数；库此后从 140 长到 155 条失败事实，同一形状计数随之变化）。两者现在都是：

- 分类 `tool_collision`，判据 `concurrent_edit_target_missing` / `concurrent_edit_file_changed`，`basis = derived`；
- **落在采样总体内 0 行**，`wouldReachMinOccurrences = false`；
- 在 `collect` 里出现在 `excludedByOrigin`（不是 `belowThreshold`、不是 `suppressed`）——既没进统计，也不是被负向过滤挡下的。

## 5. 两侧一致性怎么验证

1. 两个适配器文件**逐字节相同**（既有断言 `test/failure-capture.test.mjs` 读两份文件比较 + 本次复核 hash 相同）。规则表因此不可能在两侧漂移。
2. 新增 parity 测试（`test/failure-capture.test.mjs:11`）：**同一张 11 行 fixture 表**同时喂给 DSH 适配器、Codex 适配器、以及编译后的核心 `classifyFailureOrigin`，三者必须同判；表里既有冲突/环境形状，也有必须留在采样里的形状（`file has not been read`、`exit_code=1`、`ENOENT`、`not found`）。
3. **血缘不变**：捕获侧写的是发现文本，`idempotencyKey` 仍只由 `(adapter, projectId, sessionId, tool, signature)` 决定。用 HEAD 版适配器与新版对同一输入实测对比：4 例 `UNCHANGED`（`388559f2…`、`9e7e38e0…`、`e7dfe8a4…`、`ac94e649…`），并把其中两条钉进测试。标记行放在 `观察：` 之前，`autoFailureSignature` 的观察提取与签名归一化都不经过它。

## 6. 路径脱敏：本任务不实施，位置记在这里

设计第 4 条要求"不在入库时改原文"。代码注释写在 `src/refine.ts:52-62`，含义如下：

- 库是用户本地的私有库，绝对路径对**排查**是最有用的信息；写入时占位化会让每个本地读者都付出代价，去防一件还没发生的事（分享）。
- 边界因此是**导出与采纳**：`export-skills.ts` 与采纳路径（`server.ts`）。行在那里才从"私有"变"会流动"，也只有那时才需要改写。
- 与签名归一化不是一回事：`store.ts` 里的 `«path»` 是为了判定"两行是不是同一个失败"，脱敏的目的是"读者不该学到目录结构"。两件事在同一个字符串上做，但结论不同，不能合并。
- 本任务**未实施脱敏**，也未在本文档写出任何本地真实目录（一律 `<USER_HOME>` / 仓库相对路径）。

## 7. 测试与验收

| 测试 | 内容 |
|---|---|
| `W14-R1`（`test/failure-origin.test.ts:86`） | 两个进程并发编辑同一文件的失败（两种形状各 12 次）不得进入提炼采样；且它们既不在 `belowThreshold` 也不在 `suppressed` |
| `W14-R2`（:116） | 超时 / EIO / EPERM / 端口占用 / 中断各 8 次同样不进入；对照组同样是 8 次的真实任务失败**仍然产出** |
| `W14-R3`（:154） | 普通任务失败（旧行、无标记）仍正常进入采样，单次仍报"低于门槛" |
| `W14-R4`（:169） | 来源分类与负向过滤互不替代：(a) `exit_code=1` 留在总体内、被过滤挡；(b) 冲突形状过得了所有过滤、仍被移出统计 |
| `W14-R5`（:197） | 标记优先于推导、`basis` 如实、未命中即 `task_failure`（默认不是"未知"） |
| `W14`（`test/failure-capture.test.mjs:11`） | 捕获侧归类 + 两侧适配器与核心同判 + 血缘不变 |
| `W11-R1…R8` | 原骨架测试全部保留（fixture 由冲突形状改为任务失败形状，理由写进注释：冲突形状已不再进入这一层，用它测不出负向过滤） |

验证命令与结果：

- `npm run build`：**干净**（共享工作树）。
- `node --test dist/test/*.test.js test/*.test.mjs`（共享工作树）：**679 tests / 673 pass / 4 fail / 2 skipped**（同一批次早先一次运行为 671 pass / 6 fail，差值是并行线正在修自己的用例）。4 条失败全部不在本任务改动的文件里：`candidate-flow-unattributed.test.ts`（W11-④ 归属/workflow）、`review-prefill.test.ts`（provenance 确认）、`ui-management-verification.test.ts`（F02 refreshHeader，`ui.ts` 在途）、以及一条"旧判定快照候选的一键采纳"。本任务的 W14 六条与 W11 八条在共享树全绿。
- 隔离对照（把其它并行线的在途改动排除掉）：`git archive HEAD` 到临时目录 + 只覆盖本任务改动的 6 个文件，`npm run build` 干净、`646 tests / 613 pass / 0 fail / 33 skipped`。即共享树上的那几条失败是并行线在途状态，不是本任务的回归（判据不是"我认为不是我的问题"，而是"在只有本任务改动的树上跑过"）。
- 普查脚本只读验证：两次运行后原库 sha256 与大小均未变（`untouched: true`）。库里在此期间新增了 1 条人工提交（397→398），失败事实数稳定在 155，比较的两个窗口同源同口径。
- 复现命令：`node verification/r5/replay-failure-origin.mjs`（加 `--json` 取结构化结果，`--db <path>` 指定其它库）。它需要 `dist/`——与 W11 的 `replay-failure-distribution.mjs` 同一约定，先 `npm run build`。

## 8. 未完成项与风险

- **未部署**：本任务不提交、不部署、不重启，因此真实库里还没有任何一条带来源标记的行；§4 的数字全部是快照重算。
- **未实施路径脱敏**（本任务明确不实施），位置与理由见 §6。
- **未回填**：老行靠正文推导分类，`basis` 因此是 `derived`。若要落成库内显式字段，需要动 `store.ts` / `schema.ts`（本次不允许），且会把"来源"变成第二套判定存储；在 `payload` 之外加字段还会被 `.strict()` 的 `proposalSchema` 直接 400（捕获丢失）。这是选择在正文里写标记行的原因，写进了适配器注释。
- **规则表的双重存在**：适配器作为独立插件部署，拿不到编译输出，规则表必然有两份。已用 parity 测试钉住；**没有**共享模块，因为那会要求插件依赖核心构建产物。
- **已知判定边界**：`io_error` 含 `Win32 1175/1176/1177`（ReplaceFileW 失败专用码），若将来某条真失败正文里出现这些数字，会被记为环境事故。`timeout` 规则会命中任何含"超时/timed out"的正文，包括"检索超时后降级"这类**任务内**逻辑失败——它们同样不进采样，代价是少一条可提炼素材，不是记录错误结论。
- 本次未触碰 `src/server.ts`、`src/store.ts`、`src/ui.ts`、`src/cli.ts`、`adapters/dsh/index.mjs`，也未削弱 revision 血缘、审核门禁、迁移幂等、仅回环监听与凭据职责分离。
