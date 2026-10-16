# AMB 全功能需求与实际运行验收矩阵

审计时间：2026-10-14 19:56（Asia/Shanghai）。审计者：requirements_audit 子代理。

本报告区分原始设计、代码能力、部署文件与实际会话运行。读取源码、既有报告、真实库只读聚合及监听进程，不修改用户库、配置或重启宿主。并行实现仍在进行，以下是本轮开始时的基线；后续修复不能在没有证据时自动改为通过。

## 1. 权威要求与验收口径

- `docs/plans/2026-10-09-joint-plan-final.md`：完整功能、权限、审核、生命周期、跨端接续及质量验收。
- `docs/plans/2026-10-09-workflow-integrity-requirement.md`：完整流程为方法使用单位，步骤经验不漂浮，必要依赖闭合。
- 用户本轮明确要求：Codex / DSH 的任何项目会话共用一个库，主动搜索和读取、主动写回知识经验日记，skill 融入数据库。共享知识库不取消任务范围、来源身份和审核权限。
- 只有“实现路径 + 检查结果 + 对应真实宿主运行证据”齐全才可认定实际验收通过。文档声明、文件已部署、单元测试通过不能互相替代。

状态：**实现**=源码存在；**部分**=有组件但链路有缺口；**缺失**=未找到实现；**待实机**=当前真实宿主未证明。历史报告只能支持当时的场景，不能证明本轮更新已加载。

## 2. 本轮真实机器证据

只读 SQLite：`<USER_HOME>\.agent-memory-backpack\knowledge.sqlite`。

| 项目 | 实测事实 | 能证明及不能证明 |
| --- | --- | --- |
| 两端配置 | dsh-client / codex-client endpoint 同为 `http://127.0.0.1:47631`、projectId 同为 `p0-workflow`，projectRoot 均缺省 | 已配置全会话共享；不证明已加载最新适配器 |
| 权威库 | revision=3；active memory=16、norm=3、skill=147 | 数据库已有真实内容；无 journal / workflow / material 类型记录 |
| 任务 | 22 条，全部 in_progress | 自动登记曾运行；未形成完成/暂停/日记的真实闭环 |
| 候选 | pending=9 | 已有实际候选落库；不代表采纳或经验生效 |
| 事件 | 12956 条，最后 created_at=1791978913106 | 大量事件不等于有价值任务日记 |
| 重扫 | scanRoots 空字符串；interval=86400000；lastRescanAt=1791941782004 | 当前 serve timer 空 roots 只更新扫描时间，实际不扫描，属于运行缺陷 |
| 队列 | 核心 outbox=0 | 只证明该表当前无待处理，未检查所有适配器 spool |
| 核心 | 47631 监听 PID=21128；ExecutablePath 是 DeepSeek Harness.exe；创建时间本地17:28:56 | 由 DSH 可执行文件承载；不能据此证明独立核心活过 DSH 退出 |
| 核心日志 | 最后 run.start/core.listening 为 UTC09:28:57，只有启动事件共42条 | 当前服务存在，缺少重扫完成证据 |
| 插件日志尾部 | 抽样22条全部是本 Codex 会话 PreToolUse/PostToolUse，最近UTC11:56 | 当前 hook 在运行；尾部无 DSH 知识读取/候选回执，不能断言 DSH 没有运行 |

技能根实测：`<USER_HOME>\.agents\skills` 是实体目录，含常用 skills 和部分 DSH 升级技能 junction；`<USER_HOME>\.dsh\skills` junction 指向 `<HARNESS_HOME>\data\skills`；`.codex\skills` 是实体目录。`<HARNESS_HOME>\user\.agents\skills` 也是实体目录，不应仅凭路径不同假设默认全部漏扫。应记录实际扫描源及来源哈希，避免对镜像重复计数。

## 3. 需求—实现—证据—缺口矩阵

| ID | 原始要求 | 现有实现与证据 | 缺口 / 实际启用结论 |
| --- | --- | --- | --- |
| G01 | 用户拥有、两端单权威库 | config.ts 默认共享目录；相同 endpoint / library identity 实测 | 实现；并发真实双端读写最新部署待实机 |
| G02 | 任何项目会话有效 | 两适配器 projectRoot 可缺省；本机已缺省 | 配置正确；需不同 cwd 真会话分别读写同条记录 |
| G03 | 明确项目/任务身份及更窄适用范围 | schema global/project/task；applicable；task ID | 同库身份不代表所有记录对所有任务适用；任务续接要显式关联，不能误接无关任务 |
| R01 | 开始工作自动获取有效规范 | DSH pre-step / Codex SessionStart及prompt prepare；norms不走相似度 | 历史实机通过；最新运行要取注入证据 |
| R02 | 按任务主动搜索 | prepare按query搜索；amb_search_universal；双向指引 | prepare摘要不等于agent主动调用；缺任务级尝试、命中及失败审计 |
| R03 | 相关正文及必需依赖按需读取 | readKnowledge(includeLeaves)、read_stage依赖闭合 | 工具实现；模型实际读正文与适用判断需可观察证据 |
| R04 | 任务技术栈/新故障变化补检索 | 每轮prepare；失败捕获指引 | 新工具/错误签名有界重检与缓存策略未完整执行化 |
| R05 | 同意图同版本复用、控制上下文 | knownRevision规范去重；字符预算 | 不应知识revision相同就丢掉不同任务召回；token预算和检索缓存未完整配置化 |
| R06 | 排序含分类、关键词、语义、版本、证据 | 搜索及semantic.ts字符bigram启发式 | 无模型/embedding provider；不能宣称模型语义排序已落地 |
| R07 | 记录版本、理由、缺口及实际使用 | prepare返回retrieval；注入/调用日志 | 响应存在不等于持久任务审计；实际“应用”不能由读取推定 |
| W01 | 工具失败事实自动落库 | failure-capture，脱敏/稳定键/候选/离线spool | 新版在磁盘与隔离runtime验证；当前DSH加载待证明 |
| W02 | 成功排障/新方案主动提交 | amb_submit_experience +行为指引 | 正常回合成功经验收集、闭环确认仍不足，不得编造经验补数量 |
| W03 | 写入必须有真实回执，可读回 | proposal receipt pending/queued_local；get/read接口 | 自动流程需关联task、submission、最终采纳版本并读回验证 |
| W04 | 检索已有知识，优先修订已有skill | 候选分类建议、workflow/stage归属、supersede | 无完整模型归属/去重合并方案；库无结构化workflow，已有候选可能未归属 |
| W05 | 未找到流程保留待归属，不丢发现 | Store.submit unresolved attribution | 实现；不可因为虚构工具恢复流程名就声称已归属 |
| W06 | 来源身份/证据等级真实 | schema provenance/evidence；adapter权限 | agent自述不能伪装observed；需逐入口验证，元字段非天然可信证据 |
| W07 | 分级审阅/表外不自动生效 | policy.ts、pending/review/admin_only | 新经验固定保留候选；P3白名单自动生效条件尚未评测冻结 |
| W08 | 语义分类、冲突、拆分由模型辅助 | semantic.ts正则分类、字符余弦、建议占位 | **缺失模型服务**；必须标heuristic_only；分拆文本并非真正语义提取 |
| W09 | 审批生效后下轮能复用 | Store.approve事务、UI审批接口 | 10-13曾发现F01 UI target mismatch/prompt阻断；当前修复源码不替代完整实机回归 |
| W10 | 补证最多两次、期限、重要冲突保留 | proposal lifecycle、expireProposals | API/测试存在；真实积压/自动补证行为与人工负担待验收 |
| V01 | 并发CAS、历史不回到默认检索 | revisions、head、事务、supersessions | 实现；对应并发和历史真实场景仍应分项保留证据 |
| V02 | 有效写入后索引/导出/通知可恢复 | FTS随权威写事务同步；exportSkills手动 | 导出/通知无统一持久作业；不能把outbox投递队列冒称全部后台任务 |
| V03 | 必要依赖失效父流程停止可执行 | workflow展开、ready、export检查 | 源码及既有测试有；库当前0 workflow，实际完整流程体验未落地 |
| T01 | 独立task可跨session，一session多task | startTaskForSession、task记录、handoff | 全部任务in_progress，任务切换及结束缺闭环 |
| T02 | 任务事实持续更新，含文件进度证据未完项 | DSH收集有限cohort文件/进度；record接口 | Codex主要generic事件；应保存事实而不是仅计数 |
| T03 | 简短准确日记自动生成并永久可检索 | generateJournal/writeJournal/API | **实际库0 journal**；适配器自动调用不足，Stop不可当completed |
| T04 | 成功/失败/未验证分离 | journal outcome，任务5态 | 实现；需真实失败/停止/暂停用例，不能任意信任“测试过” |
| T05 | 接续目标/约束/决策/进度/文件/验证/下一步 | handoff、task schema、checkout差异提示 | 原10-13交接字段曾全空；需新版真实读回与环境复核 |
| T06 | 原始事件30天，与日记独立保留 | events TTL cleanup，journal独立knowledge | 实现；实际日记缺失会导致30天后事实仅剩空任务 |
| S01 | skill主文与引用成组入库 | discovery collect leaves、rescan skill body/leaves | 147 active skill证明采纳，不证明每个引用链接完整/可执行 |
| S02 | 源更新有版本、定期同步、退场可追溯 | applyRescan/refreshAdoption/ledger | **线上scanRoots空导致timer空转**；需默认根/初次扫描/可查询状态 |
| S03 | 完整流程组织，不零散拼方法 | workflow schema/triggers/stages/preconditions/checks/recovery | 原始skill.needsStructure=true只是原文快照；0workflow，不能声称已自动结构化 |
| S04 | 脚本/资源可定位且不丢原技能能力 | 扫描排除可执行文件；原目录保留 | DB不提供独立脚本执行；导出须声明依赖及未打包资源，不宣称可脱离来源全功能 |
| S05 | 便携导出保留引用树/相对链接 | export-skills原先basename扁平化 | 本代理正在修：同名叶覆盖、来源目录相对映射、路径安全及frontmatter；见§6 |
| S06 | 既有日记迁移不丢正文 | candidateToKnowledge journal did.slice(0,2000) | **原文静默截断**；应短摘要+完整来源正文分层保留 |
| M01 | 临时资料主动提交及可观测采集 | material/save开放adapter、materialEntry | 两适配器无完整可用工具/采集闭环；库0material |
| M02 | 默认90天、读不续期、读时排除 | material.ts、isLive、renew强制原因 | 实现；实机生命周期可用隔离时钟验收，不能等待90天 |
| M03 | 物理清理正文摘要索引缓存，失败重试 | purgeExpiredMaterial、failure表、每分钟cleanup | 备份/导出和其他缓存覆盖需审查；正文仍可能进入长期归档 |
| M04 | 经验引用不延长资料寿命 | 独立material expiry | 实现；经验只保存最小独立证据不得锁整页 |
| P01 | 本机回环/认证/角色/Origin/CSRF | server.ts认证、ADMIN_ONLY、同源要求、strict JSON | 实现；同OS用户可读凭据的边界不能宣称强隔离 |
| P02 | 协议不兼容拒写 | protocol header/426 | 实现与既有回归；升级部署仍要核实实际版本 |
| P03 | 中途规范变更受控工具前核查 | gate、snapshot、knownRevision | 工具名及启发式shell覆盖有限；不承诺所有操作强约束 |
| P04 | 离线显示真状态，有限队列幂等重放 | adapters spool、core outbox、snapshot三态 | DSH恢复重放已补；Codex成功重放后状态永久true，后续同会话恢复可能延迟 |
| P05 | 常驻核心、单实例、登录启动、恢复 | service.ts lock/start/recover/Run key | 当前进程为DSH承载，独立常驻/关闭宿主/重登待实机；注释仍混淆计划任务与Run |
| O01 | 双端能力/版本/故障真实展示 | capabilities.ts +UI | codex.linkTask=no的理由已过时（hook有持久session文件、core自动登记）；静态能力不能冒充runtime验证 |
| O02 | 安装/加载/信任/挂载/使用分开验证 | pack/deploy/doctor、插件日志 | 文件16项对齐不证明宿主模块重载；需两端当前会话调用证据 |
| O03 | 管理界面8面板，候选批审/历史/导出 | ui.ts大量界面/API | 旧报告有真实UI缺陷；只浏览源码不能标整页功能通过 |
| O04 | 备份恢复/卸载不删原始知识文件 | archive/backup、export、uninstall | 备份表清单遗漏未来新表须迁移；只删adapter应保留权威库 |
| Q01 | 质量基线/留出集/固定判据、负担成本 | 既有单元与隔离runtime测试 | 未找到原设计全套冻结语义基线/留出集、漏召回/日记事实错误/重复错误/上下文成本实测 |

## 4. 必须纠正的先前“完成”口径

`2026-10-11-design-traceability-matrix.md` 的 C5 把正则/bigram实现写成模型语义分析并勾选完成；A5/D4只凭生成函数存在写成日记完成，D9又承认适配器未自动调用，内部不一致。H14只证明事务/幂等，不能证明缺失的导出任务崩溃恢复。所谓“未实现归零”“65项完全实现”不符合该文自己规定的代码+测试+实机三证口径。

`2026-10-13-unified-acceptance-verdict.md` 更谨慎，已明确不能全功能验收，但其“F01唯一阻断”只适用于当时已覆盖的测试范围，不能代替对原设计全部要求的验收。本轮发现空扫、无日记、无模型服务等应独立列缺口。

先前390测试通过是先前代码/环境的一次结果，本报告未重跑该390项，不将其当作本轮变化的回归证据。

## 5. C5 / C8 最小可落地方案与扩展点

### C5：模型语义任务

1. 可选provider配置明确服务商/endpoint/model、凭据引用、允许发送的数据范围；默认不外发。未配置时状态 `awaiting_model` / `heuristic_only`，确定性检索和规范继续可用。
2. Store.submit事务保存候选及分析作业；worker异步读有限相关条目，输出严格schema的分类、重复/补充/冲突关系、所属流程步骤、建议变更和来源证据。
3. 模型结果只辅助审核，不赋管理权；不得根据置信度自行晋升规范。超时/错误/非法JSON有持久状态和有限重试。
4. 接点：`src/semantic.ts` 的 classifyCandidate、Store.submit classification/review元数据、server admin配置/状态、serve worker、UI状态。字符相似度继续作为明确标注的后备。

### C8：生效后的后台任务

1. 当前FTS在SQLite事务同步更新，可声明该边界无需另造异步索引；未来embedding则需版本化索引作业。
2. 导出/通知建持久作业表：kind、targetRevision、idempotencyKey、status、attempts、nextAttemptAt、lastError。
3. 权威生效事务入队；serve启动恢复及定时worker执行；目标版本变更时旧任务可标superseded，不能导出旧状态覆盖新结果。
4. 接点：Store.import/approve/supersede、`src/export-skills.ts`、`src/cli.ts`后台循环、server/UI作业状态与重试。不得把HTTP投递outbox误当知识导出作业。

## 6. 本代理新增修复与验证记录

- 已修改 `src/export-skills.ts`：参考文档保留相对目录；绝对来源通过adoption ledger映射；不明绝对来源、越界路径、Windows保留名称、大小写目的冲突明确跳过；输出路径拒绝符号链接；原skill frontmatter保持在第一行。
- 新测试 `test/export-reference-integrity.test.ts`；既有 `test/adapter-delivery-fixes.test.ts` 对裸相对doc路径预期改为保留root位置。
- 首次 `npm run build` 被并行core代理尚未完成的测试类型错误阻断；其完成后再次构建通过。随后运行 `node --test dist/test/export-reference-integrity.test.js dist/test/operations.test.js dist/test/adapter-delivery-fixes.test.js`：25通过、0失败、0跳过，其中新引用完整性3项确已运行。仍不代表当前用户宿主已加载此次修改。
- `src/capabilities.ts` 已把Codex持久会话任务关联标为代码设计能力，移除“短进程不可能关联任务”的过时描述；`src/doctor.ts` 静态安装/能力检查明确标warn并说明当前宿主会话尚未验证，不把代码齐备当实机通过。
- `src/backup.ts` 兼容旧v1归档，新增可选 `model_reviews` 安全审核结果迁移及 `checkpoint:*` 幂等回执迁移；导出明确排除本机可执行作业队列、修订通知和投递队列，不复活源机器的导出路径或待执行动作。无配置文件/凭据随归档迁移；dry-run不创建可选表。
- `test/backup-maintenance.test.ts` 新增审核记录/幂等回执往返及不复活本机作业验证；与backup/archive/capabilities/clean-install/UI-management针对回归共53项全部通过，0失败、0跳过。
- 含真实机器路径的原始审计副本仅保留在忽略目录 `.local/private-audits/`；公共报告用环境占位符，clean-install信息泄漏检查通过。

## 7. 完成定义

每行缺口必须由实现责任人给出文件、检查、产物、当前宿主启用与读写回执；未覆盖或配置前提未满足明确保留。完整设计验收不能缩减成四个demo，亦不能以事件数、skill数或测试数量替代用户任务效果。

## 8. 本轮集成结果（20:12，Asia/Shanghai）

本节更新前述基线，不抹去此前的缺口与过度声明。

### 已实现并通过集成检查

- R02/R03/R04：两端新增共用 `recall.mjs`，宿主真实调用 search-universal/read，任务开始及结构化失败后有界检索、至多读取两条正文；记录知识ID、读取ID、版本及失败。自动读取尝试不代表模型已经正确应用知识。
- W01/W02/T03：DSH业务工具后至多一次收尾steer；用户abort不会复活。新增checkpoint/activity，Codex Stop、DSH turn/end事件原子暂停任务并写日记；Stop不等于完成。成功经验依然由agent给出真实验证结论，自动失败事实始终待审。
- W03/T01/T04：checkpoint有持久回执和幂等；显式completed要求验证说明及verifiable证据声明，声明本身不等于外部核验。跨任务/跨项目身份校验保留。
- W08/V02：新增 `model-review.ts`、`jobs.ts`、`maintenance.ts`。真实模型JSON分析、超时、脱敏、拒绝重定向、严格结构、建议权限；无服务明确awaiting_model。任务事务入队、租约恢复、12次后needs_action、管理页可查和重试。FTS仍随权威事务更新。导出仅在明确配置目标目录后执行；通知是持久版本记录及轮询，不冒称两端已确认消费。
- S02/S06：默认扫描根空转、导入日记和任务notes截断已修；来源同步保留版本和ledger。自动扫描默认仍24小时，不是实时文件watcher。
- M01：两端暴露资料保存工具；是否值得保存及摘要由agent判断，未实现所有浏览工具输出自动采集。
- S05/O04：引用目录保真、冲突拒绝、备份扩展及静态能力口径见§6。

### 当前构建与安装

- `npm test`：415通过、0失败、0跳过，约33秒，原始输出 `.local/full-memory-loop-tests-final2.txt`。
- 新工具真实stdio协议、模型、worker、jobs针对回归：18通过、0失败、0跳过，`.local/live-loop-targeted.txt`。
- `npm run pack:local` 成功；产物 `artifacts/p0-20261014120852471`，包含文件hash清单。
- `scripts/update-installed.mjs` 对两端安装目录完成38文件备份替换，随后dry-run changes为空。备份 `.local/installed-backups/1791979751626`；真实库预迁移备份 `.local/live-db-before-memory-loop.sqlite`。
- 所有修改尚未提交，没有push/npm发布。

### 实际本机运行证据

- 旧核心确认是独立serve子进程后，仅停止该核心；首次start误用不支持的`--core-entry`被CLI拒绝，随后从已安装runtime入口正常启动。没有杀死用户DSH主进程。
- 新核心PID29552，进程为Node；跨多条终端调用仍健康，47631协议v1。当前用户登录Run项已注册，尚未通过真正注销/重登验证。
- 真实模型通过既有本机网关，使用`gemini-3.5-flash-lite`；配置位于私有data目录，未进入仓库/产物。后台已保存多条mode=model/status=analyzed建议，仍有等待/重试项目；没有自动批准候选。状态摘要 `.local/live-memory-loop-status.json`。
- 实际库来源重扫：new=7、changed=2、unchanged=158、vanished=10、errors=[]；消失来源仅报告不退役，原始结果 `.local/live-memory-loop-rescan.txt`。
- 从已安装Codex runtime入口启动stdio MCP，真实列出15工具；用当前Codex会话身份记录本次实际开发进展。回执：task=`task-34edf65114d55167`、journal=`journal-task-34edf65114d55167`、revision=7、outcome=unverified；activity独立读回同journal，任务保持in_progress。原始回执 `.local/live-installed-mcp-receipt.json`。这是安装入口的真实调用，不等于当前原有MCP长进程已重连。

### 仍未完成的验收与能力边界

1. 用户正在使用的DSH桌面进程是否重新加载新版、真实业务轮的自动读写证据；已询问是否可重启，未收到答复前不重启。
2. 当前原有Codex MCP连接重连、自然Stop的宿主原生触发证据；单独stdio及hook子进程回归不代替它。
3. Q01完整原设计质量留出集、漏召回/误召回及实际重复错误率没有完成；宽泛query仍可能命中不相关知识，自动入口增加用途过滤不能宣称语义检索质量已全面解决。
4. 真实库仍无已审核结构化workflow，不能把原文skill快照当完整可执行流程；自动语义合并、结构化与分级自动生效仍不能标完整通过。
5. 资料工具入口已补，主动资料收集策略、真实UI全部面板与持久任务重启故障注入仍需逐项验收。

因此本轮已完成一批实际实现及线上接入，**不作全部设计已落地的结论**。

### 20:18 收尾补充

最终源码回归416通过、0失败、0跳过，含新增Loader验收；最后短“继续/确认”误召回修复已通过针对回归并打包为 `artifacts/p0-20261014121821522`。因Codex短期余量10%触发用户收尾规则，最后该包未部署；当前安装仍为上一包。用户明确DSH忙，禁止本轮重启。完整续作见 `docs/handoffs/2026-10-14-2016-amb-full-function.md`，全设计验收仍未完成。

## 9. 恢复推进：skill模型归纳与检索质量（23:30，Asia/Shanghai）

### 本轮新增实现

- `workflow-draft.ts` / `workflow-organization.ts`：入库保留skill和参考正文，后台持久作业调用既有模型，生成摘要、触发场景、排除条件、别名和版本；同时抽取有原文引证的流程草稿。归纳是检索辅助，流程必须审核，缺步骤或依据则needs_evidence；模型未配置或不可用则awaiting_model并有限重试。来源revision/hash变化后旧草稿不能采纳。
- 管理页新增Skill整理：生成、对照原文、修订重新校验、人工采纳。显式重新生成可重排已结束的未采纳作业，自动扫描不反复生成相同来源。采纳保留源skill和引用，源变化后流程展开拒绝旧版本。
- `retrieval-service.ts` / `semantic-retrieval.ts`：使用当前来源版本的模型归纳，模型判相关性、严格ID/revision校验、4秒超时、并发限制和缓存；自动入口失败明确拒召回。确认状态无新任务不检索，明确版本不匹配排除。显式literal搜索仍可使用全文检索。定位正文命中段后读取原文偏移，减少长日记开头挤占上下文。
- `material-capture.mjs`：两端只自动保存已识别阅读工具的明确URL和正文，支持DSH web_fetch嵌套body；有界脱敏和离线重放保留原始采集时间，不刷新90天寿命。模拟真实hook→HTTP→独立SQLite读回，不等于当前DSH桌面已加载。
- 两端`failure-capture.mjs`修复只按exit_code合并不同失败的问题：先确认结构化失败，再用明确stderr和error形成脱敏有界签名；缺详情明确标信息不足。当前库旧候选仅有exit_code，不能凭空补出错误根因。
- 备份新增可选workflow_drafts，验证来源绑定，兼容旧归档；不迁移可执行任务、凭据或导出路径。

### 已观察的实际运行

- 用户已自行重启DSH。14:47:41Z出现adapter.load；其后真实视频业务会话14:51:19Z有auto_recall，readIds两项；14:54:11Z保存自动失败候选，pending且无实际stderr。以上能证明部分读写链路工作，不能证明使用正确或错误已解决。
- 核心已独立更新至PID27964，47631健康，protocol-match/core-reachable/project-scope通过；未重启正在工作的DSH。23:25的维护摘要显示101 pending、65 completed（包含不同作业类型，不是65个已采纳skill）。
- 23:19真实prepare：“已重启dsh”无额外知识；用户当前skill归纳需求仅命中“技能沉淀”。Codex/DSH凭据对同一知识读回HTTP200、同revision、同正文。149条skill整理作业已建立，首批完成的6份中4份带模型digest，其余缺项没有伪装成完整流程。
- 本节时已安装包为`artifacts/p0-20261014151740347`，36文件备份后更新；备份位于`.local/installed-backups/1791991105998`。之后的重新生成、digest保留与失败签名细修仍需最终集成部署，以后续小节记录为准。
- 完整源码回归截至上述包：458总数、456通过、0失败、2项显式联网测量跳过。新增重新生成及失败签名针对回归11通过。最终集成结果另记，不把测试数量作为检索质量证据。

### 质量结论与尚未验收

独立18例诊断中，纯规则精确率33.3%、召回率72.7%；既有默认模型在4秒预算下精确率76.9%、召回率90.9%，仍有误召和超时。模型比较没有找到已证明可靠的直接替代者，没有改默认模型。版本过滤、状态过滤及后台digest是在该次测量后补入，不能沿用旧指标声称新版本通过。详见`2026-10-14-retrieval-quality.md`。

未完成：新的独立质量留出集、完整设计质量指标、真实DSH本轮turn-end日记、最新适配器安全重载后的业务回合、当前Codex原有MCP新增schema重连、真实登录启动、持久作业实机故障注入及全管理页验收。当前没有embedding向量索引；后台模型归纳已实现，不等于语义索引和分级自动采纳全部完成。仍不作全部设计已落地的结论。

### 23:32 集成与新实机证据（更新上文状态）

- 最终完整回归465项：463通过、0失败、2项显式联网测量跳过，`.local/full-memory-loop-tests-final3.txt`；打包`artifacts/p0-20261014153029075`。两端12文件备份更新并hash核对，dry-run changes=[]，备份`.local/installed-backups/1791991873318`。
- 独立核心PID30344，DSH未重启；原连接amb_self_check全部通过。实际23:31重新prepare当前用户需求，只命中“技能沉淀”，2842ms；两端同正文同revision。149草稿中81 needs_evidence、1 ready_for_review、67 pending，待审不等于已采纳。
- **DSH真实turn-end日记已观察到**：同一业务会话15:29:04.497Z和15:29:48.350Z出现journal.persisted，revision9、10，outcome=unverified。此前“无真实DSH日记”的验收缺项现已补证；最新适配器细修仍待后续安全reload。
- Chrome隔离实际管理页闭环通过，详见`2026-10-14-browser-organization-acceptance.md`。不冒称生产管理员表单登录、所有面板或真实模型质量通过。
- digest目录改紧凑五维tuple，预算由16k/24k明确调整为24k目录/32k请求。149条真实形状、长digest合成回归证明不会因全部生成digest而恒定超预算；超大目录仍明确降级。延迟影响未有新独立留出集结论。
- 23:32读库149条中36有digest，86 needs_evidence、1 ready_for_review、62 pending；15份标invalid_response。并非所有已完成工作都已生成有效归纳，正在修复模型省略digest却结束作业的问题。
- 当前Codex安装入口实际列出15工具，checkpoint写入并独立activity读回同journal、revision11，task仍in_progress；不能等同于原有MCP连接已更新schema。

### 23:37 最后归纳完整性修复

- 模型system合同明确digest五字段必有，workflow:null也必须归纳；省略或非法digest/JSON不再记成已完成整理，而标awaiting_model并有限重试。已有可显示草稿保留，手工旧格式验证继续兼容。
- 完整回归466项：464通过、0失败、2联网测量跳过，`.local/full-memory-loop-tests-final4.txt`。新包`artifacts/p0-20261014153549972`更新两端2个runtime文件，备份`.local/installed-backups/1791992173917`，随后dry-run无差异。
- 独立核心当前PID21280，原amb_self_check通过，knowledge11；没有重启DSH。
- 首次重排请求4秒超时，中止且未得到完整回执，不计成功；随后有界重试逐项记录，69个旧未采纳且无digest的草稿全部获得HTTP成功重排回执，`.local/missing-digest-requeue-receipt.json`。未自动采纳。
- 23:37只读统计：149草稿、46个带digest；43 needs_evidence、1 awaiting_model、103 pending、2 ready_for_review。状态不是最终归纳成功率；pending含旧结果且reason可能保留，须待后台新一轮结果核对。
- 待办仍是独立新留出质量评估、语义索引、真实新适配器reload与全设计验收。不得把上述回归或单条命中当全部检索精度达标。

23:38:35再次真实prepare当前需求超时4317ms，明确返回空结果并记录timeout；此前同需求2842ms成功不等于稳定。当前51条带digest、98pending。此结果进一步证明同步全目录模型判断仍有延迟瓶颈，应作为后续阻断处理。最后checkpoint revision12，任务仍in_progress。
