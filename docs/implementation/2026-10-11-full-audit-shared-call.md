# 共享核心、安装配置与 Agent 主动调用只读审计

日期：2026-10-11，Asia/Shanghai。受检源码：`c4a0ef7844760034c0b2ec206d90ba7b75c470bc`。本报告是全面审计的共享调用专责结果，不替代其他专责或整体验收。

## 结论与证据层级

**同核心、同权威 SQLite 的架构通过；隔离双端的读取、候选提交、批准刷新与下一次受控门禁通过；隔离双端完整失败恢复与范围一致性未通过；当前桌面同时部署未验证。**

| 层级 | 本轮结论 | 判定范围 |
|---|---|---|
| 架构 | 通过，带配置条件 | DSH/Codex 都请求同一 HTTP 核心；服务持有一个 Store/SQLite。安装初始化生成独立适配器凭据、同 endpoint/projectId。不存在适配器各自存一份正式库的同步架构。 |
| 隔离双端 | 主链路通过，完整验收不通过 | 真实 MCP SDK stdio 子进程 + 提取的真实 DSH Cordis/ToolRuntime，同一个隔离核心/库；两端各 11 工具逐一调用。发现范围不一致、合法重试误报、离线暂存缺失及过期快照放行。 |
| 当前桌面部署 | 未验证 | 主窗口提供当前 DSH 自检 Managed/知识版本2，只支撑该会话读取；本专责未观察当前 Codex 桌面真实工具调用、hook信任、两端已加载包摘要及同核心同时读写。不把提取运行时、SDK 或历史截图称为当前桌面验证。 |

主窗口在本专责收尾提供当前部署只读观察：默认DSH/Codex均指向47631、projectId=p0-workflow、root=D:\\huange-skill；两端已安装/启用，但DSH运行包与latest旧runtime、Codex更旧hook不与当前源码一致。该观察由主窗口负责证据绑定，本专责未自行读取真实配置；仍无当前两端同时运行调用证据。

“同时安装”本身不保证共享成功。必须是同用户 home、配置解析落在预期位置、两个凭据的 endpoint/projectId一致、核心实际使用同数据目录。显式环境变量、定制数据目录、不同 OS 用户、不同 projectId 或安装旧包，都可导致不同核心/不同知识范围；这不是后台自动合库。

正式基线 [联合规划](../plans/2026-10-09-joint-plan-final.md) 已按1–180、181–326完整分段读取；[完整流程补充](../plans/2026-10-09-workflow-integrity-requirement.md) 已完整读取。重点对照 §3.1/3.4、§5.3、§6.4、§9、验收5/14/15/18。前轮 [落地审计](2026-10-11-landing-audit.md) 仅用于寻找待检项，本报告所有“本轮复现”均有新隔离证据。

## 实测方式与可复现产物

- Node `24.19.0`，MCP SDK `1.32.1`，适配器/插件 `0.1.0-p0.1`，提取的 DSH运行时 `0.2.0-rc.2`。当前运行时目录属于已有项目测试夹具，不是当前桌面profile。
- 主窗口说明已统一构建且 HEAD未变；本专责未重新build。证据保存18个源码/构建文件SHA-256及 Cordis/dsh-tools/dsh-system-prompt入口SHA-256，避免只有版本字符串。
- 最终完整运行：`2026-10-11T07:51:46.996Z`至`07:51:49.337Z`，随机端口`54599`，68次工具调用、17组行为检查、`completed=true`。68不包含全部原始HTTP/fixture工具/hook进程调用，因此不是全部请求总数。
- 主脚本 [audit-shared-call.mjs](../../.local/full-audit-20261011/shared-call/audit-shared-call.mjs)，路径脚本 [audit-config-path.mjs](../../.local/full-audit-20261011/shared-call/audit-config-path.mjs)。从仓库根执行 `node .local/full-audit-20261011/shared-call/audit-shared-call.mjs` 和 `node .local/full-audit-20261011/shared-call/audit-config-path.mjs`；每次创建新UUID目录/随机端口，不重复利用真实库。
- 最终完整 [evidence.json](../../.local/full-audit-20261011/shared-call/run-56573f16-b261-4214-9405-8aa5e022414b/evidence.json)，精简 [result-summary.json](../../.local/full-audit-20261011/shared-call/result-summary.json)，配置优先级 [config-path-evidence.json](../../.local/full-audit-20261011/shared-call/config-path-evidence.json)，最终运行定位 [latest.json](../../.local/full-audit-20261011/shared-call/latest.json)。
- 适配器日志 [amb-plugin.log.jsonl](../../.local/full-audit-20261011/shared-call/run-56573f16-b261-4214-9405-8aa5e022414b/logs/amb-plugin.log.jsonl)，MCP错误流 [mcp.stderr.log](../../.local/full-audit-20261011/shared-call/run-56573f16-b261-4214-9405-8aa5e022414b/mcp.stderr.log)，隔离数据库 [knowledge.sqlite](../../.local/full-audit-20261011/shared-call/run-56573f16-b261-4214-9405-8aa5e022414b/knowledge.sqlite)。JSON包含原始返回、每次输入/耗时、完整schema、核心批准和失败状态。
- 所有配置/数据库/快照/日志均限于新建审计目录。临时凭据由脚本随机生成，在内存使用；最终证据逐值检查无泄漏，适配器配置文件收尾删除。未读取真实凭据值；未修改真实profile、环境持久配置、Run注册表或共享库；未安装插件、未停止共享进程、未运行`npm test`全量。只停止脚本创建的HTTP server。
- 脚本在本进程及子进程内指定配置/日志/临时目录，不写系统环境配置。归档例程自身的临时解包目录也通过进程TEMP/TMP隔离。没有依赖外部模型或网络服务。

## 安装、配置路径与项目身份

### 配置实际优先级

依据 [src/config.ts:57](../../src/config.ts#L57)、[DSH解析器:58](../../adapters/dsh/resolve-config.mjs#L58)、[Codex解析器:58](../../adapters/codex/scripts/resolve-config.mjs#L58)。两适配器解析器字节相同，核心TypeScript实现另存一份。

| 入口 | 优先级 / 行为 | 本轮证据 |
|---|---|---|
| DSH插件 | 非空`AMB_DSH_CONFIG` > 非空`AMB_CONFIG` > `<os.homedir()>/.agent-memory-backpack/dsh-client.json` > 同目录`client.json` | 隔离home实际解析到独立dsh-client；两个有效变量同时出现时专用变量胜出。 |
| Codex hook/MCP | `AMB_CONFIG` > 默认`codex-client.json` > 同目录`client.json` | 隔离home默认同数据目录、不同文件；显式文件胜出。MCP读取的是核心readClientConfig，hook读取适配器解析器。 |
| 显式路径失效 | 立即回落默认/legacy并告警；不会继续尝试下一低优先级变量 | 失效`AMB_DSH_CONFIG`且有效`AMB_CONFIG`仍回落默认dsh-client。可突然从测试/自定义配置转向真实默认库，告警不等于保留原隔离边界。 |
| 核心CLI | `--data-dir`或`defaultDataDir()`决定core.json/knowledge.sqlite | `--data-dir`不是适配器解析环境。自定义目录后仍需把两端配置明确指向该目录；安装脚本没有替宿主持久设置两变量。 |
| 自动拉起核心 | 适配器使用凭据文件所在目录作为dataDir；先探测endpoint，再`serve --data-dir` | 同endpoint健康则复用；只有health HTTP成功检查，不证明该服务确属预期数据目录/协议。 |

**新增中等缺陷：空白专用变量导致核心与适配器解析不一致。** 配置证据`emptySpecificDsh`：`AMB_DSH_CONFIG=''`、`AMB_CONFIG=<existing explicit.json>`时，DSH适配器选择explicit.json，核心`resolveConfigPath('dsh')`选择默认dsh-client。原因是核心使用`fromDsh ?? AMB_CONFIG`，空字符串不是null；适配器忽略trim后为空的专用变量。这是本轮新实测，不是现有“核心一致”单测已覆盖的情形。影响诊断/入口对同配置的认知；实际DSH插件自身使用适配器实现，Codex MCP使用核心实现但adapterId为codex。

**遗留凭据兼容风险：** DSH没有own文件时也接受legacy `client.json`；`init`将此文件写为Codex凭据。目录没有dsh-client而有legacy时，DSH会加载Codex身份的token并向prepare/gate声明adapter=dsh，核心身份检查可能403。即使部分知识路由不带adapter，正常ToolRuntime前置gate仍声明dsh身份，因此完整工具路径预计先受身份拦截；失联降级另有边界。这是静态路径/身份组合分析；本轮实测只验证回落路径，不声称复现全部遗留安装。

### 安装和项目映射边界

[cli init:534](../../src/cli.ts#L534) 产生core.json、codex-client、dsh-client、admin-client及Codex legacy副本；三个token独立，项目默认`p0-workflow`，projectRoot是显式`--project-root`或cwd。 [serve:577](../../src/cli.ts#L577) 打开唯一`<dataDir>/knowledge.sqlite`。`core.json`已存在时[安装脚本:227](../../scripts/amb-install.mjs#L227)跳过初始化，因此新传`--project`/`--project-root`不修改既有绑定。

[安装脚本:205](../../scripts/amb-install.mjs#L205)允许自定义data-dir；Codex工作区安装调用官方CLI，但仅CLI成功不等于桌面加载/信任。没有在本轮执行安装。DSH bundle patch只声明tools注入，Codex[MCP清单](../../adapters/codex/.mcp.json)调用打包runtime/mcp.js并继承AMB_CONFIG。核心源码目录、插件安装目录与数据目录是三种身份，不能混为一处。

projectId由凭据绑定、HTTP envelope强制校验，不按目录名自动识别。projectRoot用于适配器在实际路径上限制会话。DSH和Codex hook均realpath解析根/当前cwd；符号链接逃出或路径不存在时不视为匹配。配置是一份单projectId/root，未看到通用多根路径映射注册表；要跨checkout映射需明确配置，而不是同名目录自动共享。

**新增高影响范围不一致：Codex MCP遗漏cwd范围门禁。** 用SDK stdio transport将cwd设为配置root外的隔离outside目录，`amb_prepare`读到AUDIT_RULE_V2、`amb_submit_experience`创建pending候选；DSH同outside owner调用prepare得到scope错误，Codex hook同outside输入返回空stdout并跳过。依据 [src/mcp.ts:127](../../src/mcp.ts#L127)、[CoreClient:31](../../src/client.ts#L31)、[DSH wrapper:342](../../adapters/dsh/index.mjs#L342)、[Codex hook scope:396](../../adapters/codex/scripts/hook.mjs#L396)。这是项目会话范围不一致，不是凭据允许任意projectId；固定凭据的projectId HTTP校验仍有效。

## Agent 工具逐项调用

下面所有结果都来自最终新运行。常规adapter凭据：读取当前知识、提交候选；有效知识管理归admin。工具注册可见、Agent可主动选择调用，和工具有权限直接改正式库是两件事。所有工具均通过真实SDK/真实DSH ToolRuntime，不用假MCP桩/自写工具执行器冒充。

| 工具 / 核心路径 | 字段（必填用*） | 读写与权限 | SDK结果 / DSH结果 |
|---|---|---|---|
| `amb_self_check` / prepare | 无 | 读连接/版本；adapter | 两端ok=true；Managed、revision1；不输出token。DSH附log健康，MCP只报告凭据形态长度。 |
| `amb_prepare` / prepare | MCP query≤4000默认空、taskId可选；DSH无入参 | 标注只读知识；adapter。DSH session prepare可能登记/更新任务，不等于零数据库写入 | 两端norm AUDIT_RULE_V1、revision1。query为空未召回流程/skill是可见结果，不误称全库已注入。 |
| `amb_search_workflows` / search | query*；MCP允许空且≤4000，DSH最小1 | 读；adapter | 两端返回audit-workflow@1、ready=true、完整入口和前提/完成/恢复。 |
| `amb_read_stage` / expand | workflowId*、stageId* | 读；adapter | 两端audit-workflow verify阶段正文、依赖[]、ready=true。 |
| `amb_read_knowledge` / knowledge/read | knowledgeId*、includeLeaves可选默认false | 读；adapter | 两端真实skill@1正文AUDIT_SKILL_BODY及叶子AUDIT_LEAF_BODY，needsStructure=true。不是只测missing ID。 |
| `amb_knowledge_history` / knowledge/history | knowledgeId* | 读元信息；adapter | 两端active/current1、revisions1、chain[]。历史元信息不等于可直接取出全部历史正文。 |
| `amb_unstructured_skills` / knowledge/unstructured | 无 | 读；adapter | 两端audit-skill、leafCount1/bodyChars16。原文待结构化并未被当完整流程。 |
| `amb_submit_experience` / proposals | idempotencyKey*（1–120识别符）、discovery*（1–12000）、workflowId/baseRevision可选；MCP额外taskId可选，DSH没有 | 写pending候选；adapter；不直接改有效revision | 两端pending、duplicate=false、review tier=review。DSH回执对后续状态有缺陷，见下文。 |
| `amb_supersede_experience` / knowledge/supersede | oldId*、newId*、reason*≤500、evidence*≤2000、action默认supersede或supplement | 改有效库；admin-only | 常规适配器两端都isError；SDK显示403/forbidden及候选指引，DSH仅HTTP403。这是权限按设计有效，不称Agent直接替代成功。 |
| `amb_structure_skill` / knowledge/structure | skillId*、workflow*、evidence*≤2000、derivedBy默认agent或user | 结构化并退役原skill；admin-only | 传有效完整workflow后两端403。MCP schema引用workflowSchema详细约束；DSH仅宣告任意object，最终由核心校验。 |
| `amb_inspect_archive` / backup/inspect | file*（1–4096） | 读归档清单；adapter。内部解包临时写文件，不改权威库 | 两端成功读取fixture.ambpack，4knowledge/4revision、10清单文件；正文不作为该工具结果返回。export/import是admin-only且未向Agent暴露。 |

共同权限检查由 [server ADMIN_ONLY:53](../../src/server.ts#L53)、[身份/项目检查:131](../../src/server.ts#L131)实施。公开structure/supersede的描述容易让Agent尝试后才知道权限，DSH还丢失核心的candidate指引，导致额外工具调用/解释负担。Codex[引导skill:10](../../adapters/codex/skills/agent-memory-backpack/SKILL.md#L10)已明确只提交候选、不自行晋升；工具注册描述仍可更准确。

### 同版本、新批准知识与门禁

1. 两个独立凭据连接相同隔离endpoint，同一Store读取revision1。
2. SDK提交候选，人类角色fixture调用真实`/v1/proposals/approve`替换norm@1→norm@2；HTTP200，库版本1→2。
3. 两端下一次prepare均revision2，包含AUDIT_RULE_V2，SDK响应不再有V1。
4. DSH实际ToolRuntime执行audit_new_blocked返回错误且副作用计数不变；Codex真实hook子进程PreToolUse返回permissionDecision=deny。旧audit_blocked在新规范不再禁止，DSH实际执行成功。
5. DSH在版本变化时inject消息带source.kind=agent-memory-backpack与norm@2。没有把已有旧会话内容被删除称为通过。
6. 后续通过DSH提交新memory候选，admin批准新条目，库revision4；SDK和DSH立即按ID读到NEW_APPROVED_MEMORY_IMMEDIATE、条目revision1，不等待宿主重启。

通过的是“下一次受控调用检查权威状态”，不是所有hosted操作、当前桌面hook信任或检查后立即并发变更的竞态完全消除。

## 幂等、失败恢复与工作负担

### 新复现缺陷

**中：DSH合法幂等重试错误识别。** [DSH PROPOSAL_STATES:100](../../adapters/dsh/index.mjs#L100)只有pending/approved/rejected/expired。submit成功后admin request-evidence令核心needs_evidence、或archive令archived，再同key同payload重试：核心已找到原候选并返回duplicate=true、真实状态，但DSH `assertReceipt`报invalid pending receipt。两案例原候选仍存在、无重复写；MCP同状态重试正常返回。证据检查`review-state-retry-*`与`mcp-review-state-retry-*`。用户/Agent可能以为提交失败而换新ID再提交，增加重复审阅负担。

**中：workflow变更后已提交提案的完全相同重试先触发CAS。** [Store.submit:645](../../src/store.ts#L645)先查workflow/baseRevision，之后才[检查幂等:668](../../src/store.ts#L668)。base1提交成功，workflow更新为2，再同key同payload请求HTTP409；原候选仍pending。本案例不是新提案基线冲突，而是已有提案回执恢复被前置版本检查遮挡。重新比较是新变更所需，不应让传输层重复查询伪装为全新失败。

**高：离线候选暂存/重放未实现。** 核心断线后SDK/DSH submit立即isError，库中该key候选数0，无容量/期限/持久outbox回执。重连prepare双方恢复revision2，但候选只在显式重试后首次入库，再次相同重试duplicate=true。符合“在线重连可用”，不满足正式规划§3.4/§6.4的持久暂存、队满可见、重连原幂等ID重新审核。断线产生的事件同样只有post失败日志，不能推定后台自动重送。

**高：快照过期使已覆盖工具也失去旧禁止，且静默/有限可见。** 快照可用时断线：原禁止audit_new_blocked两端deny，未列禁止audit_unlisted两端允许，体现ReadOnlySnapshot实际并非文件只读模式。把审计快照时间改为31天前后，核心仍断线：DSH原禁止工具执行成功、副作用计数增加；Codex hook stdout空且exit0，退为Ungoverned。依据 [gate-cache:39](../../adapters/dsh/gate-cache.mjs#L39)、[DSH降级:283](../../adapters/dsh/index.mjs#L283)、[Codex catch:440](../../adapters/codex/scripts/hook.mjs#L440)。正式规划§3.4说明快照不是执行旧规则授权、需要最新规范且能拦截的操作暂停；当前实现以未列禁止项/过期全放行为策略，至少没有具体“需最新”可判定检查。Codex降级主要记日志，不向用户输出额外上下文；DSH每session只告警一次，从Snapshot再变Ungoverned本例不再告警。不能把所有失联操作称为仍受治理。

### 已通过的并发与失败保护

- 20个并发请求，SDK/DSH交替使用同key/同discovery：每端10请求只形成1候选；两端总共2候选。SQLite `UNIQUE(principal,idem)`决定幂等范围；跨端相同任务/发现不做全局去重。这不是同端幂等失败，但会增加跨端续接的重复候选负担。
- 同端same key/different content HTTP409 idempotency_conflict，不覆盖原提案。
- 两端针对同workflow@2各提交一份候选：首份批准200/库revision5，第二份批准409 revision_conflict，第二份内容保留pending。条目级CAS有效，不静默覆盖。
- 不认识的token401；协议2返回426；错误project403；Codex凭据伪称adapter=dsh返回403；外Origin403；adapter直接批准403。分别验证明确失败原因，不把任意4xx当业务成功。
- DSH工具outside owner被scope拒绝；相同范围内最终ToolRuntime guard生效。当前SDK outside反例说明scope保护没有一致覆盖。

### 调用成本和人工负担

两端工具首次调用记录含耗时。最终SDK首轮11项约11–30ms/项（本地热核心、短数据）；DSH包含每次`/v1/gate`加实际工具路由，不能外推大库/冷启动性能。Codex每个hook启动独立node进程并请求核心，PreToolUse返回完整norm context；DSH只有revision变化时注入，仍每次gate并写snapshot。快照是同目录文件非原子write，在并发或异常写入后存在解析失败退Ungoverned的静态风险，本轮未注入文件撕裂，不标实测。

离线需要人工/Agent保留原payload并重试，DSH新状态误报会诱导额外重试，跨端相同发现生成两个candidate，structure/supersede公开但默认403导致回头提交候选；这些都是额外工作负担。未建立无插件对照或大规模任务成本样本，本轮不报告总体效率提升百分比。

## 审计边界与建议验收

本报告未改源码、不部署修复、不读真实配置。新证据证明架构和在线共享主链路，暴露范围/恢复/状态合同缺口。当前桌面结果应继续标未验证，直到同源码/打包摘要下真实两端同时记录：安装/启用/信任、主动调用回执、同revision、批准后读新知识与目标门禁、禁用/失联/重连。

后续修复建议：统一cwd/项目路径边界及配置解析；DSH回执接受核心完整候选状态并保留核心错误指引；幂等命中先返回既有回执再讨论新变更CAS；实现具容量/期限的持久outbox；区分明确需最新策略的操作并可见展示每次降级状态；当前默认安装与定制目录分别验收，不通过减少约束来宣称完成。

本次是仍未修复的问题审计，无新的已验证修复方法或完整技能流程，未提交正式经验/改技能文档，避免污染共享权威库。
