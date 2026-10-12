# R0–R3 修复与独立核验进展

日期：2026-10-11（Asia/Shanghai）。
基线源码：`c4a0ef7844760034c0b2ec206d90ba7b75c470bc`（`docs/implementation/2026-10-11-full-verification-report.md` 受检提交）。
核验性质：**主窗口独立核验**。所有结论来自本仓库内可复跑的脚本，不采信子代理自述。

## 1. 结论先行

| 问题 | 当前答案 |
|---|---|
| 报告列出的可复现缺陷修了吗？ | **R0 全部 26 条核验项通过**；另有预算/反向守卫 16 条、outbox 5 条、适配器 9 条、DSH 降级 4 条、Codex 上下文预算 5 条、R0 退出数据判定 5 条、R1 12 条、适配器 outbox 3 条、备份对新表的处理 5 条、无模型降级 10 条，**全部通过**。 |
| 全量回归是否干净？ | 设 `AMB_ARTIFACT_DIR` 后 **329 测试 / 329 通过 / 0 失败 / 0 跳过**（含打包冒烟）。`npm run check` 退出码 0。 |
| R0 的正式退出标准达到了吗？ | **达到**。退出标准为「跨项目反例全部变明确失败且本项目可用」：25 条本项目路由全部可用、50 次跨项目调用无他项目数据、外项目任务与提案状态不变、beta 自身读写正常。 |
| R4 的产物一致性达到了吗？ | **产物侧达到**。以当前源码重新打包：runtime 与两端适配器**逐文件哈希一致**（`check-artifact-consistency` = `match`），打包 CLI→init→seed→serve→MCP 端到端冒烟通过（含中文空格路径）。**未做**：安装到真实宿主、双端同时读写、卸载后新会话验证。 |
| 20 条正式验收整项通过了吗？ | **没有**。逐条证据为 **verified 16 / partial 2 / not-covered 2**（`audit-acceptance.mjs`）；未覆盖项均需模型服务，另未实机。详见第 9 节。 |
| 当前可以发布吗？ | **不宜宣布可发布**。技术上产物与源码一致、全量测试 0 失败、宿主安全无污染；但 20 条验收中仍有 2 条未覆盖、2 条部分覆盖，且**全部为脚本级/隔离证据，未在真实双端安装验收**。本环境遵从用户要求不执行安装类动作。 |

## 2. 方法与分工

判定依据始终是 `docs/plans/2026-10-09-joint-plan-final.md` 的 20 条正式验收、第 6–10 节设计要求、
`docs/plans/2026-10-09-workflow-integrity-requirement.md` 的流程完整性要求，以及
`docs/implementation/p2-requirements.md`。**未修改任何设计方向**。

子代理按**文件独占**分工作业以避免互相覆盖；主窗口负责指挥、核验与跨文件缺陷。

| 分工 | 范围 | 文件 |
|---|---|---|
| 核心数据层 | F01–F09、F15、F18、F19、F21、F23；R2 的 F16/F17/F18 | `src/store.ts`、`src/server.ts`、`src/material.ts`、`src/schema.ts`、`src/backup.ts` |
| 适配器/交付层 | F07、F10–F13、F16、F21、F22、上下文预算、R2-a/b/c | `adapters/**`、`src/mcp.ts`、`src/client.ts`、`src/config.ts`、`src/export-skills.ts` |
| 界面/能力层 | F14、F20、U02 及 F02–F05/F08 界面侧 | `src/ui.ts`、`src/capabilities.ts`、`src/doctor.ts` |
| 主窗口 | 跨文件缺陷、脚手架、判定、契约裁决、O05 | `src/service.ts`、`src/log.ts`、`scripts/sanitize-doc-paths.mjs`、`scripts/deploy-plugin.mjs`、`test/service.test.ts`、`test/task-journal.test.ts` |

## 3. 核验通道（可复跑）

审计脚本从脚本同级 `build/src/*.js` 导入被测代码；把**当前源码**编译进同一布局，即可用同一批
夹具复核。判据逐条写在脚本的 `check()` 里，**不发明新标准**。

```powershell
node scripts/verify-r0.mjs build
node node_modules/typescript/bin/tsc -p tsconfig.json --outDir .local/verify-r0/security/build
node .local/verify-r0/security/verify-r0-findings.mjs         # 核心数据层 26 条
node .local/verify-r0/security/verify-budget-guard.mjs        # 预算与反向守卫 13 条
node .local/verify-r0/security/verify-adapter-findings.mjs    # 适配器层 9 条
node .local/verify-r0/security/verify-dsh-findings.mjs        # DSH 降级契约 4 条
node .local/verify-r0/security/verify-hook-budget.mjs         # 上下文预算 5 条
node .local/verify-r0/security/diagnose-r2.mjs                # R2 链路诊断
node --test test/r2-handoff.test.mjs                          # 适配器接续 3 条
```

## 4. 核验结果

### 4.1 缺陷核验（`verify-r0-findings.mjs`）：**26/26**

| ID | 修复前 | 现在（实测值） |
|---|---|---|
| F01a | beta 读到 alpha 资料正文 200 | **404** |
| F01b | provenance 可伪填 `user` | **`external`** |
| F02a | history/recent 泄露他项目原因 | 不含 `beta-PRIVATE` |
| F02b | history 泄露他项目替代证据 200 | **404** |
| F03a | alpha admin 改 beta 提案 | **403**，提案仍 pending |
| F03b | alpha admin 续期 beta 资料 | **403** |
| F04 | alpha 事件写入 beta 任务 200 | **403**，beta 导出不含该事件 |
| F05 | 任务规范完全不生效 | 无 taskId=`allow`；带 taskId=**`deny`** |
| F06 | completed 被 prepare 重开 | 状态与 `completedAt` **均不变** |
| F07 | 自述 `verified` → `success` | **`unverified` / `self-reported`** |
| F08a–d | 到期正文可读、清理留正文、备份复活 | 检索不召回、`get` 404、`revisions` 无正文、恢复后仍不可读 |
| F09 | 已退役条目可作替代目标 | **`not_active`**，old 仍 active |
| F10a–c | 叶子不导出、失效父仍导出、退役文件残留 | 叶子写入 `references/`、失效父不导出、旧文件被清理 |
| F15 | 换 base 即可批准旧提案 | **`revision_conflict`**，提案仍 pending |
| F19a | 重要冲突 31 天被判 expired 并清正文 | **`pending`** 且正文仍在 |
| F22a–e | 解析器分叉、静默回退 | 核心与两端解析一致，失效配置有可见告警 |

### 4.2 预算与反向守卫（`verify-budget-guard.mjs`）：**16/16**

修「泄露」最容易的做法是让所有读取一律 404，修「上下文膨胀」最容易的做法是返回空——两者都会
让朴素检查通过而毁掉功能。因此每条正向修复都配了必须仍然工作的反向用例。

| 检查 | 实测 |
|---|---|
| F23a 规范上下文受预算约束 | 40 条近上限规范下 context=**8886** 字符（审计基线 480687） |
| F23b 超预算可见而非静默截断 | `budget.omitted=39` 条，逐条带原因，context 内含省略说明 |
| F23c 预算不得裁掉硬约束 | 被禁止工具仍 `deny`，`deniedTools` 完整 |
| F23d 同版本重复注入抑制 | `contextUnchanged=true`、context 长度 0，**决策仍为 deny** |
| GUARD-a…e 本项目读取仍可用 | 自己的 memory/history/material/norm 全部正常，`scopedEntries` 非空 |
| GUARD-f 本项目提案审阅仍可用 | alpha 批准自己的提案成功（revision 2） |
| F19b–d 重要冲突保留、补证回重审、补证内容被记录 | 全部通过 |

### 4.3 适配器层：**18/18**

- `verify-adapter-findings.mjs` 9/9：快照绑定项目身份（beta 载入 alpha 快照得 `mismatched_identity`）；
  核心不可达不报 `Managed`；过期快照只报告不执行；两个 `gate-cache.mjs` **逐字节相同**（8896 bytes）；
  `isWithinProject` 判定正确；重复 `client.id`/`token` 被拒且合法配置不误伤。
- `verify-dsh-findings.mjs` 4/4：死核心下 `pre-step` **正常返回**（不再单点阻断）且 stderr 明确报
  `运行模式 Ungoverned`；`AbortError` 单独分支仍抛出（取消语义保留）；降级可见；
  `PROPOSAL_STATES` 含 `needs_evidence`/`archived`。
- `verify-hook-budget.mjs` 5/5：首次注入 12076 字符；同版本同会话后 9 次累计 **0 字符**；
  十次累计 12076 vs 基线 120760，**降幅 90.0%**；新会话重新注入；revision 变化重新注入。

### 4.4 界面与能力层

`ui-management-verification`、`web-ui`、`capabilities` 共 **19/19 通过**。
性质：脚本级 DOM/HTTP 桩，**非真实 GUI**。

### 4.5 R2 适配器接续

`test/r2-handoff.test.mjs` **3/3 通过**：DSH 在用户表达接续意图时查询任务列表、取交接、
**把当前 sessionId 追加进既有任务**并注入 `[Task Handoff]`（含 caveat），后续事件沿用该 taskId；
Codex 通过会话态缓存实现同一能力；范围外 cwd 严格拦截不发起任何请求。

链路诊断（`diagnose-r2.mjs`）显示 T04 已从 `handoff=false` 变为 **`handoff=true`（两端）**。

- `verify-backup-outbox.mjs` **5/5**：备份在新表存在时仍能完成、清单如实说明 outbox 去向、知识与任务完整往返；**待发项不随归档迁移**（未送达内容不迁移，属保守取舍，已记录）。
- `verify-adapter-outbox.mjs` **3/3**：重放失败**不阻断会话**（不成为新的单点故障）、同会话不反复重放、确定性 4xx **不落队**（否则队列永不排空）。
- `verify-semantic-unavailable.mjs` **10/10**（验收13/17 可验证的一半）：无模型时确定性检索/门禁/阅读/到期检查全部可用；候选不因语义判断自动生效（`tier=review`）；记录中无任何模型/LLM 声称；24 小时后不自动降级生效；队列跨进程重启可恢复。**仍缺**模型队列本身，如实报告不隐去。

## 5. 主窗口直接修复的缺陷

| 缺陷 | 实证 | 修复 |
|---|---|---|
| 审计报告把宿主机器路径写进仓库 | `clean-install` 门禁失败，列出 `<HOST_PLUGIN_ROOT>` 等 | 扩展 `sanitize-doc-paths.mjs` 规则；脚本内字面量改为运行时拼接，避免自身触发门禁 |
| **F24：测试污染真实注册表** | `test/service.test.ts` 直接写 `HKCU\...\Run`，`finally` 只恢复**虚构命令** `C:/path/cli.js` | 加入 `AMB_RUN_KEY` 覆盖，测试改对临时键操作；验证后真实 `Run` 键无写入、用户原有 7 项启动项完好 |
| O07：日志泄露 URL query 凭据 | 探针实测 `?api_key=SYNTHETIC-QUERY-VALUE` 明文落盘 | 增加 `SECRET_QUERY_PARAM` 规则，按参数名脱敏、保留其余 query |
| 健康探针假阳性 | 只验 `response.ok` 与版本号 | 拒绝重定向、要求 JSON 与 `status:'ok'` 核心标识 |
| F14 关联：`/v1/stats` 无法自举身份 | 空请求体实测 400，页面拿不到自己的 projectId | envelope 对该只读端点可选，从凭据回显 `projectId`+`role`；**跨项目仍 403**（实测确认） |
| **F07 与 `task-journal.test.ts` 契约冲突裁决** | 3 条断言要求「自由文本 `verified` ⇒ `success`」，与验收4/设计§6.2 直接冲突 | 按设计原文裁定：自由文本**不得**构成验证依据。`generateJournal` 与 `exportTask` 统一为「有可核验依据（`observed`/`verifiable`/verified 事件）才算 success」；据此更新那 3 条断言，并**新增**一条反向断言（只有自述的完成必须标为未验证），使契约双向钉死 |
| **O05：部署回执假阳性** | `deploy-plugin.mjs` 用 `activated \|\| Array.isArray(bundles)` 报告 active，未激活的 profile 也显示 `active=true` 并可 exit 0 | 收敛为只报告真实激活状态，未激活计入 `failures` 并以非零退出。核验 `check-deploy-signal.mjs` PASS（修复前确实复现了假阳性） |
| 产物一致性（R4 只读核对） | 现有打包件 `p0-20261011052424237` 与当前源码 **17 个文件不一致**，且缺 `capabilities.js`/`policy.js`/`semantic.js` | 已用当前源码**重新打包**（`npm run pack:local`，只写 `artifacts/`，不安装）。新产物 runtime 20 文件 + DSH 适配器 6 文件 + Codex 适配器 5 文件**逐文件哈希一致**；`check-artifact-consistency.mjs` 由 `drifted` 转为 **`match`** |
| **验收16 未实现：不同 checkout 无文件状态差异** | `handoff` 只带 `files`（路径清单），没有任何状态记录，因此无法「展示文件状态差异」；报告第 4 节把该项列为未实现 | 新增任务字段 `fileStates`（每文件 digest/size/observedAt，含加列迁移，旧库自动补齐）与 `POST /v1/tasks/compare`。**三态**设计：`same`（记录一致）/`different`（不一致）/`unknown`（任一端缺状态记录）——**绝不把 unknown 当作未变化**，因为把「没查」当成「没变」正是该验收禁止的假定。接收端多出的文件也会列出。已加永久测试 `test/task-checkout-difference.test.ts` |
| **EV-CE-02 重复内容未识别（审计演化反例，确定性可修）** | 同文本、不同幂等键各自建立候选，两条 `relation` 都是 `new`；分别批准后库中留下**内容完全相同的两条 memory**。幂等按 `(principal,key)` 判定，结构上看不到这个问题；而 `classifyCandidate` 只与**既有知识**比较，从不与队列中的其它候选比较，两者永远不会相遇 | 按设计§6.3 表格「明确重复资料或内容 → 合并重复来源/拒绝重复保存」属**自动层**（文本等同是程序可判定的，不需模型），故在 `submit()` 中按**精确文本**（trim 后摘要）比对同项目待审候选：命中即返回既有 id 并标 `duplicate=true` + `duplicateOf`，不重复入库。**边界同样被测试钉住**：同主题的细化内容、不同项目、已裁决后重新提交，都不被误并。已在 `duplicateOf` 与 `submit` 显式返回类型上顺带修掉一处类型推断不稳（与子代理此前诊断的同源）。已加永久测试 `test/duplicate-candidate.test.ts` |
| **MCP 因 cwd 检查误拒合法会话（F11 引入，被跳过项掩盖）** | 打包冒烟测试（**既有测试**，提交 `a755221`）失败：「Connection closed」。根因：`.mcp.json` 声明 `"cwd": "."`（插件目录），宿主**按其设计**在 `projectRoot` 之外启动 MCP，而 F11 加了 `cwd ⊆ projectRoot` 检查，于是拒绝每一次合法调用 | 先测量「去掉该检查后还剩什么保护」：凭据绑定项目下，直读他项目条目 404、信封改称他项目 403、规范清单/全库检索/提交均无泄漏——**服务端逐请求范围校验已足够**。据此移除 `CoreClient` 与 `mcp.ts` 的 cwd 检查（该检查只作用于 MCP：`CoreClient` 仅被 `mcp.ts` 使用），**保留 `isWithinProject` 及其在 DSH 适配器与 Codex hook 中的使用**（那里的 cwd 来自各自的 payload，是有意义的）。F11 的会话级测试改为断言「范围外不发起请求、范围内正常发起」 |

**副产品**：打包冒烟测试从「因无产物而跳过」变为**实际执行并通过**，全量测试首次达成
**324 测试 / 324 通过 / 0 失败 / 0 跳过**（此前 1 项长期跳过）。
| **资料 `taskId` 未校验归属（F04 同类，R0 退出普查发现）** | `/v1/events` 传外来 `taskId` 返回 **403**（F04 已修），而 `/v1/material/save` 传同一外来 `taskId` 返回 **200** 并把 `taskId:"beta-task"` 落库 | 按 F04 同规则校验：`taskId` 必须属于记录它的项目。影响经实测界定为**错归属而非跨项目泄露**（scope 正确，资料仍留本库）。已加永久回归测试 |
| **能力报告安装判定不实（F20 同类，真实机器发现）** | 用户卸载后 `desktop` profile 残留 junction（声明已删）。`capabilities.ts` 候选路径**写死** `profiles/desktop`，于是①只扫 `desktop`，`headless`/`web` 的真实安装发现不了；②凭残留链接报 `installed=true` | 改为扫描**全部 profile**，并要求「链接 + 声明（dependency 或 bundle）」同时成立才算已安装；仅链接的情况作为**残留单独报出**并点名位置供用户清理。已加永久回归测试（含「残留排序在前也不得误报」的用例） |
| **F23 的另一半：`gate` 侧无预算（R3 基线测量暴露）** | 子代理的 R3 实测表显示 40 条规范时 `gate` 上下文 **480909 字符**。独立实测确认：`prepare` 受 12000 预算约束（12386 字符），`gate` **首次调用**却是 **476679 字符且 `budget` 为 `null`**；此前测得的「降幅 90%」**完全来自同版本缓存**而非任何上限——不带 `knownRevision`（新会话或版本变化）即全额发出 | 把预算逻辑抽成共享方法并**同时应用于两条路径**；预算只约束注入正文，**禁止裁掉任何声明禁止项的规范**，判定与 `deniedTools` 始终完整，超预算逐条给出原因。实测 `gate` 首次 476679→**12288** 字符，十次合计 4806290→**12288（降幅 99.7%）**，`danger-tool` 仍 `deny`。已加永久回归测试 `test/norm-budget.test.ts`——**专门测首次调用**，因为缓存会掩盖缺失的上限 |

### 5.1 关于子代理的一次有理反驳（记录在案）

我曾要求「`submit` 的幂等重试分支也返回 `review`」。子代理照做后发现**既有运行时断言失败**并附反证，
指出 `dist/test/store.test.js:148` 用 `deepEqual` 精确比对该回执形状：

```
assert.deepEqual(retry, { id: first.id, state: 'pending', duplicate: true });
```

我独立复核确认：首次提交返回 `{id,state,duplicate,review}`，重试返回 `{id,state,duplicate}`——
**多加 `review` 确实会破坏该断言，子代理是对的，我的指令错了**。已撤回指令，并在代码注释中写明
「该形状必须保持不变及其原因」。F16 的真实缺陷是**状态误报**（重试被判为不合法收据），
那部分已修好：重试现在返回记录的真实状态。

## 6. 过程问题与纠正（如实记录）

1. **核验脚手架自身缺陷（已修）**：`scripts/verify-r0.mjs` 早期版本未重定向复现脚本的输出根，
   一次运行覆盖了 `evolution/reproduction.json`。根因已修，并用提交 `c4a0ef7` 精确重算 12 个源码
   SHA256 重建基线（`baseline/evolution-baseline.reconstructed.json`，与原始记录一致）；
   另存 `baseline/evolution-prefix-equivalent-1802.json`，18 项观测与审计正文 EV-CE 表逐条吻合。
2. **子代理引入非法 UTF-8（已修）**：`src/store.ts` 曾被写成无效 UTF-8 并出现重复函数定义，
   整仓无法编译；已发纠正指令，子代理改回后通过。
3. **子代理引入构建阻塞（已修）**：新增测试对 `gate-cache.mjs` 的静态导入缺类型声明，
   `noEmitOnError` 下阻断全仓编译；改为动态 `import()` + 显式类型断言。
   后续又发生过两次同类阻塞（`submit` 返回值联合推断），均由核心层子代理定位并修复。
4. **签名不一致（已修）**：`server.ts` 与 `store.ts` 一度不同步（新增审阅元数据参数），
   由核心层子代理对齐。
5. **我自己的核验脚本出过三次错（已修后重测）**：envelope 漏传 `projectId` 造成大批**假通过**；
   `spawnSync` 阻塞事件循环使 hook 超时，误判为产品缺陷；DSH 夹具有状态缺少
   `session.header.cwd`，使 scope 判定提前跳过、没测到目标分支。前两次会把缺陷误报为通过——
   这正是必须逐条核对**观测值**而非只看 PASS/FAIL 的原因。
6. **PowerShell 显示假乱码**：`Get-Content` 读 UTF-8 中文呈乱码，但严格 UTF-8 校验通过、
   `read` 工具显示正常，文件未损坏。禁止据显示乱码盲目转码重写。

## 7. 宿主安全核对

用户在本会话开始时告知已卸载插件并要求不要安装。逐项核对结果：

| 检查 | 结果 |
|---|---|
| 本会话是否安装/部署/启用过插件 | **否**。未运行 `deploy:plugin`/`install:local`/`accept:desktop`，未打开 Electron 窗口 |
| 真实 `Run` 键 | **clean**（无条目，与进入时前态一致） |
| 测试用的临时注册表键 | 已清理，不存在 |
| DSH desktop profile | **不含本插件**（确已卸载，与用户陈述一致） |
| 测试套件是否写真实知识目录 | **否**。`check-real-dir-pollution.mjs` 在整轮 `npm test` 前后对 `~/.agent-memory-backpack` 全部 15 个文件取 size+mtime+sha256：**零变化** |

两点如实说明，不掩饰：

1. `~/.agent-memory-backpack` 与 desktop profile 的 mtime 落在 **17:01**，即**用户执行卸载的时刻**，
   不是本项目写入。该目录残留一个 23MB 的 `knowledge.sqlite`（插件已卸载后的孤儿数据）。
   它是用户的数据，我**没有**删除、移动或查询其内容。
2. 端口 **47631** 上有一个遗留核心进程仍在监听（PID 11732，DSH 宿主进程，14:01 启动，早于卸载）。
   本会话开头的上下文里确实带有「知识版本 2」的注入，与该核心一致——即插件在会话初期还活着。
   **我未停止、重启或改动它**，那是用户的宿主进程。

## 8. R3 性能与上下文基线（已测量）

`verification/r3/benchmark.mjs`（内存 SQLite、固定时钟、热进程）。**这不是端到端 SLA**，
也不构成 R3 要求的净收益证明。

| 规模 | gate 中位/p95 (ms) | prepare 中位/p95 (ms) | universal p95 (ms) | 进程 RSS |
|---|---|---|---|---|
| 0 条 | 0.016 / 0.033 | 0.101 / 0.162 | 0.054 | 64.8 MB |
| 100 条 | 0.916 / 1.230 | 3.193 / 6.178 | 1.309 | 80.1 MB |
| 1000 条 | 8.381 / 10.271 | 25.984 / 26.376 | 10.379 | 209.9 MB |
| 5000 条 | 44.512 / 45.918 | 137.299 / 151.650 | 55.942 | 366.1 MB |

与审计读数对照：5000 条下 gate p95 52.177→45.918 ms、universal p95 64.159→55.942 ms（改善）；
prepare p95 145.503→151.650 ms（基本持平，受 GC 波动）。**RSS 366MB 只是观测值**，未做独立进程隔离。

规范上下文（40 条近上限规范）：`prepare` 由 480687 → **12386** 字符；`gate` 首次由 476679 →
**12288** 字符（本报告第 5 节）。两者都逐条报出省略原因。

### 8.1 `current()` 全库解析优化（R3 要求的第二项修复）

R3 明确列出「current 全库解析优化」。先**测量**再改：库中 90% 是非规范条目时，`gate` 的时间
几乎全花在解析随后被丢弃的条目上。

| 规模 | gate 中位（修复前→后） | gate p95（前→后） | 仅取 norm 行的 SQL 中位 |
|---|---|---|---|
| 1000 条 | 10.14 → **1.19 ms** | 15.38 → **1.77 ms** | 0.11 ms |
| 5000 条 | 48.01 → **4.16 ms** | 72.73 → **11.46 ms** | 0.57 ms |

同一夹具、同一进程、内存库实测，提速约 **8.5×–11.5×**。做法是让 `norms()` 只读取 `kind='norm'`
的行（`kind` 列本就在同表，返回行集与原先完全一致，只是少解析其余类型），`gate` 与 `prepare`
都经它。语义等价已由全量回归证实（**326 通过 / 0 失败**），且新增用例专门
断言「其它类型仍可见、到期资料仍被过滤、判定不变」。

**注意**：这是延迟与内存改善，**不是净收益证明**。R3 要求的「冻结校准/留出集与无插件基线」仍未建立。

## 9. 仍未达成（不宣布通过）

| 项 | 状态 | 说明 |
|---|---|---|
| F17 持久 outbox | **已完成并验证** | 核心侧 5/5；适配器侧落队（仅可重试故障，确定性 4xx 不落队）与会话内一次性 best-effort 重放均已接线，安全性 3/3 实测通过 |
| 自动经验提炼（E03/E05/E08/E10） | **未实现** | 需模型服务与受控自动晋升；F18 只做到字段/校验/可见性，**自动语义归属仍缺** |
| 模型排队等待恢复（验收13/17 的队列部分） | **未实现** | 无模型网关。可验证的另一半已实测通过（见 4.6）：确定性能力可用、不伪装成功、不自动降级 |
| 语义分类质量与漏检率 | **未评测** | 无冻结校准/留出集，启发式质量未测量 |
| R3 净收益对照 | **部分** | 已完成：上下文预算（两条路径）+ 同版去重 + `current()` 全库解析优化 + 性能与上下文基线测量。**仍缺**：冻结校准/留出集、无插件基线、A/B 净收益证明 |
| R4 双端实机部署 | **部分** | 已完成：同源码重新打包、产物与源码逐文件哈希一致、打包产物端到端冒烟（CLI→init→seed→serve→MCP）通过。**未做**：安装到真实宿主、双端同核心同时读写、停用后新会话无工具注入 |
| 同项目不同 checkout 差异（T08/验收16） | **已实现** | `fileStates` + `/v1/tasks/compare` 三态比较（same/different/unknown），unknown 绝不当作未变化。**未实测**：真实两个 checkout 之间的端到端验证（当前为隔离实例测试） |
| 24h 模型中断队列（验收13/17） | **部分** | 排队等待模型的部分未实现（无模型网关）；「不伪装成功、不自动降级生效、队列可恢复」已实测 10/10 |
| 真实 GUI / 真实双端同时读写 | **未实测** | 全部为脚本级或隔离实例证据 |

报告第 8 节 20 条正式验收的证据情况（`audit-acceptance.mjs` 逐条列出）：
**verified 16 / partial 2 / not-covered 2**。
部分覆盖为 #6（语义级合并）、#7（相关性解释质量）；未覆盖为 #13、#17 的**模型队列部分**。
其余 16 条均有本轮实测证据，**不宣布任何整项最终通过**（未实机）。

## 10. 覆盖审计（`audit-coverage.mjs`）

对报告第 5 节列出的 24 条缺陷（F01–F24）逐条核对**本轮是否有独立证据**：

```
报告第 5 节列出的缺陷：F01…F24，共 24 条
=== 本轮未单独取证的缺陷（0） ===
```

即 24 条全部有本轮产生的、可复跑的独立证据（脚本断言、隔离测试或打包冒烟），
无一条仅凭子代理自述。R0–R4 退出标准的证据文件与结论同样逐项列出，未达成项照实标注。

## 11. 未验证范围（明确保留）

- **未安装、未部署、未启用本插件到任何真实宿主**（用户已卸载并明确要求不要安装）。
  全部验证在隔离实例：内存 SQLite、临时目录、随机回环端口、合成凭据。
  唯一对宿主的写入是**重新打包到仓库内 `artifacts/`**（gitignored），未触碰任何宿主目录。
- 真实 Electron 窗口渲染与点击、真实 DSH/Codex 桌面双端同核心同时读写：未实测。
- Windows 凭据 ACL / 配对撤销：未验证。
- 净收益（检索质量、人工负担、费用、等待时间）对照：未建立。

**结论：R0 的确定性缺陷已全部修复，且正式退出标准（跨项目反例明确失败 + 本项目可用）已达成并有
可复核证据；R1 界面层脚本级 12/12 通过但未实机；R2 的任务接续与持久 outbox（含适配器接线）已落地
并验证；R3 已完成上下文预算（两条路径）、同版去重、`current()` 解析优化与基线测量，但**净收益对照
仍缺**；R4 已完成同源码重新打包与产物一致性核对、打包产物端到端冒烟通过，但**未安装到真实宿主**。
不以核验脚本转绿或单测全绿宣布项目验收通过。**
