# Agent Memory Backpack 全面审计：工作中经验与数据演化

日期：2026-10-11（Asia/Shanghai）。受检提交：`c4a0ef7844760034c0b2ec206d90ba7b75c470bc`。项目根：`D:/huange-skill`。

## 结论与边界

**当前能由 agent 主动提交候选、由管理端人工写入有效知识并反复检索；没有生产连通的“观测工作 → 自动提炼候选 → 分类/关联已有 → 审核 → 自动演化对应流程步骤”链。**

当前确有 SQLite 权威库、条目 CAS、事务、历史隔离、候选幂等/期限、人工审核接口、FTS、结构化流程及依赖检查、来源采纳/定时重扫、资料专用到期列表、备份和可读导出。不能把这些独立模块或单测当成设计要求全链路完成。

|用户关心的环节|生产状态|准确边界|
|---|---|---|
|事件自动捕获|部分实现|DSH session/event、Codex PostToolUse/Stop 向核心发送种类及泛化摘要；不带任务 ID、不含工具执行结果证据；未在本轮真实桌面执行。|
|候选自动生成|未实现|Store.event 只写事件表，不调用 submit/分类；提交依赖 agent 自行调用 amb_submit_experience。prepare 有提示不是自动抽取。|
|分类、关联已有、拆分|未实现生产链|semantic.ts 是正则与字符 bigram，只有定义与测试，无生产调用。候选仅固定 new-experience/agent/self-reported/review。|
|审批|部分实现|管理角色后端可人工供应完整结构后原子批准；网页供 verified（枚举实际为 verifiable）且固定新 memory，修订流程目标不连通。|
|自动生效|仅来源重扫路径存在|经验提交全部 pending；mayAutoApply 无生产调用。重扫新文件直接采纳、变更直接替换且均 global/user/observed，不等于证据审核后的经验自动晋升。|
|修改已有知识、旧结论退场|部分实现|管理员 import/approve/supersede 可执行；adapter 直写/替代/结构化为403。原提案 CAS、失效替代目标、补充传播有缺口。|
|按流程步骤维护|未实现自动维护|手工供应 workflow 全量结构可以修订；候选无 stageId/分支目标结构，无自动关联/差异方案/父流程版本更新。|
|反复复用|部分实现|当前有效 workflow 入口检索/阶段展开和 raw skill 按需读真实存在；补充账本不随检索展开，导出丢叶子且留旧文件，真实复用质量未验。|

本报告只审指定设计 §§4–8/12、工作流程完整性补充与 P2 对应链路，不声称审计其他分工完成。旧 landing-audit 仅作线索；下述结论均来自本轮读取或复现。

## 本轮证据与复现

正式依据：`docs/plans/2026-10-09-joint-plan-final.md:68–197,269–296`，`docs/plans/2026-10-09-workflow-integrity-requirement.md:7–50`，`docs/implementation/p2-requirements.md:7–272`。正式签审的20条验收及引导期白名单、重要冲突不因普通期限自动裁决、两次补证失败上限均按原文核对，不采用旧14条矩阵。

入口：`.local/full-audit-20261011/evolution/reproduce.mjs`；本轮结果：`.local/full-audit-20261011/evolution/reproduction.json`（受检源码 SHA256、Node v24.19.0、UTC 生成时间、18条具体观测）。编译：`node node_modules/typescript/bin/tsc -p tsconfig.json --outDir .local/full-audit-20261011/evolution/build`，成功，不改业务源码及原 dist。

安全选定测试：store、structure、policy、semantic、proposal-lifecycle、task-journal、tasks、material、rescan、backup、discovery 共11个编译测试文件，96测试，96通过、0失败、0跳过。终轮日志 `.local/full-audit-20261011/evolution/selected-tests-final.txt`。TEMP/TMP 仅在该 pwsh 子进程设为审计 scratch；未运行 npm test、service.test、真实部署或注册表测试。第一次隔离运行因 relocated fixture 未复制而有5个失败；tmp 路径名与 discovery 排除目录同名另有2个夹具失败，随后复制原 fixtures/p0-seed.json 并使用 scratch 得到96通过。第一次记录仍保留，不把环境失败隐去或称业务回归。

反例脚本使用内存 SQLite、固定模拟时钟、随机监听端口的隔离 HTTP 核心、审计目录下的备份/导出夹具。配置中的凭据均脚本造的 fixture 字符串，不读取真实凭据。脚本初次运行有非法 config.port=0、重跑时 unchanged 文件查找错误，已只修审计脚本并成功重跑。

|反例 ID|本轮实际观测|对应代码与现有测试缺口|
|---|---|---|
|EV-CE-01|原提案 baseRevision=1；并发写成v2。用审批条目base1时409且候选pending，但改用base2可直接批准到v3，原提案仍base1，未记录重新比较。|store.ts:644–649,742–775；store.test 覆盖条目CAS，不约束原提案版本再审核。|
|EV-CE-02|同discovery不同幂等key形成两候选，人工批准两个ID得两条相同memory；候选无classification。|store.ts:668–680,774；幂等只对principal+key而非语义内容。|
|EV-CE-03|真实adapter形状Stop事件已入events（count=1），自动任务日记却“0个事件”；无自动journal条目。|dsh/index.mjs:623–625,codex/hook.mjs:342–353,store.ts:1059–1061；task-journal单测人为供应taskId。|
|EV-CE-04|任务record写completed+verified='Agent said tests passed'，journal直接success且evidence='observed'。|server.ts:347允许adapter，store.ts:1065–1080把自述字段提升；缺证据来源真实性测试。|
|EV-CE-05|completed后仅同session prepare新任务，即旧任务改回in_progress、旧summary/verified/标题保留，completedAt=null。|store.ts:539–543,1033–1039；没有明确恢复动作。|
|EV-CE-06|资料超过91天但未cleanup，liveMaterial为空；searchUniversal仍含资料，getKnowledge返回AUDIT_BODY。|store.ts:456–497,503–508未检查expiresAt；material.test只测liveMaterial。|
|EV-CE-07|purge报告purged成功，revisions仍含正文摘要，备份及恢复仍含正文。|store.ts:1479仅retire；backup.ts:84无排除/198–200无恢复清理；现有测试只验当前列表。|
|EV-CE-08|replacement已retired，再supersede old→replacement仍成功；最终两者均retired。|store.ts:1603–1625未检查newEntry active。|
|EV-CE-09|supplement记账成功，两条active，但全库版本不变；readKnowledge(base)无extra关系。|store.ts:1627–1630,518–537；补充不是正文/步骤整合，也不触发版本传播。|
|EV-CE-10|导出raw skill仅列references/leaf.md，实际叶子文件不存在。|export-skills.ts:91–97,158–166只写SKILL.md，丢必需素材。|
|EV-CE-11|命令式网页判norm；混合内容拆分为“规范要求部分”等占位；日记判memory。|semantic.ts:122–132,180；模块不接生产，当前不是实际规范越权入口，但算法质量未满足需求。|
|EV-CE-12|项目AGENTS候选转换后scope=global、provenance=user、observed。|rescan.ts:28–32无范围/真实作者识别；文件可读证明字节存在，不证明用户作者身份。|
|EV-CE-13|child v1→v2使parent ready=false，expand为dependency_unavailable；导出仍含child@1父流程。|store.ts:305–318,352–379读时治理有效；export-skills.ts:141无ready校验。|
|EV-CE-14|隔离HTTP的adapter调用supersede/write/structure/journal均403。|server.ts:53–77,142–143,333；权限门禁真实，工具曝光不等于有权直接修改。|
|EV-CE-15|文字明确important global rule conflict的候选31天后expired且payload={}。|store.ts:898–900无待裁决/重要冲突状态分类。|
|EV-CE-16|requestEvidence后needs_evidence；供应新entry尝试approve仍not_found，无回pending/重新补证入口。|store.ts:747,805–821；仅挂起/归档，不实现新证据重审。|
|EV-CE-17|export后原skill退役，再export marker不含该skill，但旧SKILL.md仍exists。|export-skills.ts:156–175无旧清单删文件/失效声明。|
|EV-CE-18|导出尚新material，91天后importAll到新库，仍active、getKnowledge得IMPORT_BODY，liveMaterial空。|backup.ts:194–200不先清理；HTTP下一请求cleanup并不等于恢复事务已满足到期约束。|

## 逐设计条目矩阵

稳定 ID 使用 `EV-J4-*…EV-J8-*` 表示正式设计段落，`EV-WF-*` 表示补充，`EV-P2-*` 表示细化，`EV-H01…20` 表示正式验收。状态：完整=指定范围的确定性行为有本轮代码及通过测试；部分=有实现但链路缺项/反例；未实现=无对应生产路径；缺验证=仅实现/声明，缺本轮相关真实运行或质量证据。不提供完成百分比。完整不外推真实双端或所有语义输入。

### 内容、读取与演化（正式 §§4–6）

|ID|设计条目|状态|代码+测试/反例|
|---|---|---|---|
|EV-J4-01|规范/偏好/记忆/经验/日记/资料独立类型|完整|schema.ts:68,83,117,131,143,161,185及对应测试；数据层类型真实。|
|EV-J4-02|类型/范围/状态/平台独立且实际使用|部分|schema.ts:13–17,45–54;store.ts:20–24,328,539,611；taskId/adapter未贯穿norms/gate，platforms仅存字段。|
|EV-J4-03|规范原话、例外、确认时间、适用条件、版本|部分|norm body+scope+immutable revisions真实；无规范例外/生效时间/条件结构；schema.ts:83–96。|
|EV-J4-04|偏好明确/归纳区别，归纳不扩大全局|部分|schema.ts:143–150可挡global inferred；默认stated=true且无自动来源鉴别，policy.ts:83–95；policy/semantic测试。|
|EV-J4-05|经验以完整流程为权威、原子归入步骤|部分|workflow结构真实但raw skill仍可prepare/read/export；proposal无stageId，EV-CE-02/10。|
|EV-J4-06|分类标签调整不改变稳定身份历史引用|部分|workflow categories/tags/common labels；import ID CAS/历史真实；非workflow没有层级category，语义移动未验。|
|EV-J4-07|最小元信息与替代关联|部分|schema common/revisions/supersessions；缺多数类型的来源定位/确认/生效时间、软件版本适用性；history metadata不返旧正文。|
|EV-J4-08|用户原话/外部网页/agent身份可信区别|部分|submit固定agent/self-reported；server.ts:295允许adapter自填provenance；scan全部user/observed(EV-CE-12)，日记(EV-CE-04)。|
|EV-J5-01|识别项目任务，恢复交接|部分|prepare创建session派生task；handoff只数据，EV-CE-05，tasks.test；明确多会话续接注入未连通。|
|EV-J5-02|规范按权威范围/例外有效性，非语义排序|部分|norms确定性过滤active/project，store.ts:328；任务/平台/例外过滤缺，规范冲突无决策模型。|
|EV-J5-03|领域环境操作分析选经验|部分|prepare只使用用户query，FTS token与摘要；无技术栈/操作领域分析，store.ts:561–564。|
|EV-J5-04|分类关键词语义版本证据混合排序|部分|FTS coverage/BM25真实；calculateHybridScore无生产调用，semantic.test单测不足。|
|EV-J5-05|摘要入口，执行时加载必需依赖|完整|结构化流程search/expand 341–379；structure/store测试，EV-CE-13。raw skill不在完整保障范围。|
|EV-J5-06|记录知识版本、检索理由与缺口|部分|prepare返回retrieval 579–609,knowledge why；无持久检索记录，reasons测试不证明日后查询。|
|EV-J5-07|可配置2000–4000 token经验资料预算且不裁规范|部分|固定limit/excerpt，不是可配置token预算，store.ts:395,539；skill-context测试；规范全部注入。|
|EV-J5-08|任务技术/目录/工具/故障变化補检索、意图+版本缓存|部分|DSH新user pre-step、Codex prompt准备；工具gate不做经验补检索，没有发现环境触发或检索缓存。|
|EV-J5-09|中途变更发布新版本，受控操作最终核验|部分|import增版本、gate/adapters取版本；不主动发布通知/擦除旧文本；适配器真实并发覆盖缺验证。|
|EV-J5-10|更窄范围不自行覆盖禁止，歧义留冲突|部分|deniedTools确定性禁止；task过滤缺、semantic未接、无重要冲突裁决状态，EV-CE-15。|
|EV-J5-11|保留原文，仅可判定规范绑已验检查器|部分|norm body+deniedTools gate真实；无通用条件检查器绑定/语义条款覆盖验收。|
|EV-J6-01|事件→候选→来源范围→已有→分类→方案→审核→原子生效→索引导出刷新→回执|部分|候选/人工写入/同事务FTS/回执真实；事件提炼、分类关联方案、持久导出任务/通知均断链。EV-CE-02/03/10。|
|EV-J6-02|内容拆分、范围、重复/补充/纠错/替代/失效/无价值识别|未实现生产|semantic仅声明+单测；EV-CE-11指出启发式拆分仍占位。|
|EV-J6-03|归属已有skill/步骤、复用条件、证据、冲突处理|未实现生产|submit接受optional workflowId但无stageId、自动相关检索/证据分析/变更方案。|
|EV-J6-04|程序身份权限字段状态事务CAS历史期限|部分|server角色/项目、schema、Store事务、CAS/候选期限真实；原提案CAS EV-CE-01、审批记录缺。|
|EV-J6-05|模型语义服务及中断排队，不冒充独立验证|未实现|无模型/embedding配置与调用队列；启发式不构成模型故障审核排队。日记证据EV-CE-04。|
|EV-J6-06|引导期仅来源补全、重复拒收、核验用户确定变更自动处理|部分|policy决定tier但mayAutoApply不被调用；资料fingerprint去重/采纳同hash跳过真实；任意候选非语义去重(EV-CE-02)。|
|EV-J6-07|新增限定经验P3白名单门槛、检索覆盖/缺口、高影响冻结|未实现生产|新经验一律pending不错误自动晋升，但未有结构化门槛/分类/评测/撤回白名单；不是已实现智能自动生效。|
|EV-J6-08|修正旧结论/语义合并初期保候选，推断偏好/扩大范围/规则自改用户决定|部分|管理门禁和allowGlobalScope存在(EV-CE-14)、策略单测；重扫自动global替换(EV-CE-12)，审批不消费policy tier。|
|EV-J6-09|待补证30d归档、重要冲突保留待裁决|部分|needs_evidence/archive有，重要冲突无状态按pending过期清payload(EV-CE-15)。|
|EV-J6-10|新证据重审、最多两次自动补证失败停止、不反复弹窗|未实现|无补证重审/自动次数/队列状态；EV-CE-16。|
|EV-J6-11|裁决身份时间理由、来源文本各自期限|部分|proposal principal仅提交者；approve无批准者/批准时间，reject无理由，archived需补证payload永久；store.ts:788–819,903。|
|EV-J6-12|两份原提案同基础版本不静默覆盖，重比较保内容|部分|条目CAS及失败事务完整，原提案CAS可改审批entry绕过(EV-CE-01)，没有recompare状态。|
|EV-J6-13|正式正文版本状态事务，持久索引/导出/通知恢复|部分|正文版本/FTS同步事务；无outbox/job表（store.ts:144–208），导出手动且失效文件不清(EV-CE-17)。|
|EV-J6-14|事件候选幂等与后台恢复|部分|principal+key持久去重、Store启动cleanup真实；adapter event用randomUUID每次重放非稳定幂等；无离线暂存队列。|
|EV-J6-15|显式依赖版本失效先停止，组合缓存/导出声明依赖|部分|workflow必需依赖读时validate有效(EV-CE-13)；普通material/raw leaf不在依赖类型；export照样输出失效父流程。|
|EV-J6-16|恢复历史审核新版本，不复活失效规范/过期资料|部分|refresh拒绝退役头；adopt可自动恢复retired、backup恢复过期active(EV-CE-18)，无统一审核恢复策略。|
|EV-J3-04-Q|§3.4离线提案持久暂存/未同步/容量期限/重连原ID与base重审|未实现|dsh/core-client.mjs:64–100只有fetch timeout/errors；Codex post同；无queue/outbox。不是已捕获事件能离线恢复。|

### 日记、资料、流程与 P2

|ID|设计条目|状态|代码+测试/反例|
|---|---|---|---|
|EV-J7-01|独立任务ID，多任务/多会话，进行/暂停/完成/取消/失败|部分|tasks表及schema五状态；session哈希自动任务仅一个，普通prepare重开terminal(EV-CE-05)。|
|EV-J7-02|阶段事实、做了什么、问题、经验落点、成功失败未验|部分|record/generate有字段，真实事件无taskId(EV-CE-03)，任意verified自述success/observed(EV-CE-04)。|
|EV-J7-03|事件30d、资料副本取更早到期、进行任务最小证据|部分|事件固定30d cleanup；无来源expire映射/必要进度提取；到期前无journal自动持久化。|
|EV-J7-04|接续目标约束决策进度文件验证知识与建议|部分|handoff 1110–1129输出task/norm/workflow/files/verified建议；无结构化决策/环境差异实际核验。|
|EV-J7-05|明确继续既有任务，接收会话绑定/注入|未实现端到端|server handoff只读，UI显示摘要；无恢复session绑定协议/adapter消费taskId；tasks.test仅后端。|
|EV-J7-06|checkout分支提交未提交/关键文件差异|缺验证且实现缺项|files仅调用者字符串清单并明确caveat；不执行仓库/环境检查。|
|EV-J8-01|agent URL/摘要、可观测阅读结果、用户三入口|部分|material/save后端可保存；无工具URL结果自动采集、MCP无save-material工具、UI以列表/续期为主。|
|EV-J8-02|URL摘要时间任务正文、保守URL及指纹去重|部分|material.ts:41–111,Store.saveMaterial；material测试通过；URL片段一概去掉可能影响SPA页面；scope固定global。|
|EV-J8-03|所有默认检索按权威expires过滤|部分|liveMaterial有效；getKnowledge/searchUniversal漏(EV-CE-06)，prepare不召回material不是完整过滤。|
|EV-J8-04|持久清理正文摘要片段索引缓存附件、查询失败重试开机补清|部分|启动/每请求/分钟cleanup及失败即时回执真实；只retire不删revision正文(EV-CE-07)，无持久失败队列/状态记录。|
|EV-J8-05|普通读不续期，明确理由续期|完整（专用保存读取路径）|material.ts:128–135,store.ts:1496–1521;material测试，通过读/重复不续期。其它入口过滤另列。|
|EV-J8-06|晋升最小证据独立理由/定位，不锁整个资料|未实现|无promotion结构/证据来源TTL链；workflow dependencies只能workflow，material taskId只是字段。|
|EV-J8-07|备份日志导出保留策略，恢复先期限检查|未实现关键保障|backup全revisions/events/proposals无TTL排除、恢复事务不cleanup；EV-CE-07/18；用户/宿主复制不在管理范围不误报能擦除。|
|EV-WF-01|稳定根流程：目标、适用/不适用、前提、IO、步骤分支、检查失败完成|部分|workflowSchema目标概览/前提/阶段/检查/恢复/完成真实；无显式不适用、IO、条件分支字段。|
|EV-WF-02|跨类索引同根不复制|完整（已结构化flow）|categories多路径+同ID FTS，store.test跨类用例本轮通过；原子片段自动回根未有。|
|EV-WF-03|新经验找所属步骤，修订步骤和父版本|未实现自动链|optional workflowId/free-text不是步骤定位；EV-J6-03、CE02。|
|EV-WF-04|无流程先待归属，仅独立方法才新建|未实现|未指定workflow的候选可直接memory批准；未有待归属专态/边界审查。|
|EV-WF-05|流程入口概览前提检查完成与按阶段必需展开|完整（已结构化flow）|search/prepare/expand，structure/store测试；必需child整个workflow展开而非只绑定输入输出。|
|EV-WF-06|必需缺失过期不兼容显示不完整，记录根版本依赖|部分|workflow active/revision/scope/cycle校验完整；无软件版本/资料到期依赖，EV-CE-13。|
|EV-WF-07|公共子流程调用位置必需性IO兼容、变更检查父|部分|stage.relationship/revision/读时检查有效；IO/软件兼容缺，parent不自动重建增版本。|
|EV-WF-08|流程不授额外发布权限|部分/缺真实执行验证|context明确经验不授权限；静态结构没branch授权守卫，不能宣称检查请求下发布分支执行已验。|
|EV-P2-01|A规范偏好有效浏览、过滤历史平台|部分|/norms/preferences和UI存在；枚举/元信息不足/任务平台过滤缺；真实UI另分工。|
|EV-P2-02|B流程入口isEntryPoint依赖图FTS版本修改时间|部分|workflow字段/FTS/search ready存在，search不返回isEntryPoint/修改时间，补充展开缺。|
|EV-P2-03|C候选清单来源base期限内容证据所属任务批量审阅|部分|list/batch后端真实，payload无classification、stage与自动任务关联；人工UI approve字段错；不因不用Express判缺。|
|EV-P2-04|D任务日记自动/手改关联经验提案规范/Markdown|部分|record/export/journal后端；自动关联/日记无，版本仅数字不留规范清单；task-journal/tasks通过但供应了缺失数据。|
|EV-P2-05|E资料保存到期任务续期删除提醒大小状态|部分|liveMaterial/stats/renew/purge；无手动单条delete、占用字节/持久清理失败，真实purge正文残留。|
|EV-P2-06|F平台状态版本同步故障重试重连|缺验证|能力源码/接口存在，未在本轮测真实端；失联候选离线队列未有，不能按静态manifest宣称Managed。|
|EV-P2-07|初检幂等来源范围字段version|部分|submit+server具身份范围，workflowId/base可选，无stage；EV-CE-01。|
|EV-P2-08|模型分类建议保存但不等自动生效|未实现|没有分类生产调用/建议保存；semantic单测不是模型审核。|
|EV-P2-09|用户批准/拒收理由/补证/合并目标版本|部分|批准原子，拒收不保存理由、缺审批人时间、补证不重审、无合并方案，CE01/16。|
|EV-P2-10|生效revisions/head CAS/FTS/通知/变更事件|部分|revisions/head/FTS事务；无通知持久队列、approve未写独立audit event，只proposal state。|
|EV-P2-11|待补证30d、重要冲突集中、拒收90d|部分|普通期限真实，important未分，needs_evidence归档正文未按来源期限清，CE15/16。|
|EV-P2-12|自动start/event/finish journal/switch paused|部分|prepare start真实；事件任务绑定/finish journal/switch paused缺，CE03/05。|
|EV-P2-13|另一端选任务、核环境并注入接续|未实现完整闭环|handoff数据非恢复动作，CE05及store.ts:1110。|
|EV-P2-14|Markdown可读/JSON完整，日记与资料不同TTL|部分|exportTask可读与task/events JSON真实；不含完整相关proposal/norm/workflow快照，自动事件丢关联，CE03/07。|
|EV-P2-15|可选编辑/冲突组织器/API文档/向量检索|部分/未实现|UI编辑存在但verified枚举错；冲突组织器/文档/embedding无生产实现；P2.4标可选，不据此阻断基础P2。|

### 正式20条验收（§12）

|稳定ID|验收要点|状态|本轮依据、测试及缺口|
|---|---|---|---|
|EV-H01|同范围新规范替旧两端受控用新|部分/缺双端验证|Store CAS/retire/supersede/版本及gate实现；rescan.tests通过；真实两端流程本轮未跑。|
|EV-H02|这一次仅任务不扩全局|部分|task scope存在但prepare/gate不传taskId，scan global；EV-J4-02/CE12。|
|EV-H03|网页命令仅资料不升级规范|部分|material默认external；classifier norm(CE11)未接所以不是真实晋升；adapter可自填provenance，scan作者固定user。|
|EV-H04|agent测试自述不冒充验证|部分|candidate固定self-reported；journal任何verified变success/observed(CE04)反例。|
|EV-H05|同版两份修改不覆盖、保候选冲突|部分|条目CAS真实，原提案CAS CE01；候选无冲突状态。|
|EV-H06|已有经验可合并修订非重复追加|部分|人工全条目CAS改写；没有自动关联去重，CE02两个memory。|
|EV-H07|新技术栈補检索并解释相关|部分|新prompt重prepare、why真实；工具/目录/故障自动触发缺。|
|EV-H08|历史可查，普通不带旧结论|部分|current只active/revisions隔离，store测试；旧导出文件仍在(CE17)、补充关联缺。|
|EV-H09|过期资料过滤+恢复后正文摘要索引删|部分|liveMaterial有效；CE06/07/18直接反证全链。|
|EV-H10|资料引用独立晋升不自动永久|未实现|无证据晋升关联/独立保留结构，CE07正文永久历史反例。|
|EV-H11|Stop取消暂停失败非完成且跨会话关联|部分|Stop仅event不complete；completed后prepare重开(CE05)，事件没有task(CE03)。|
|EV-H12|跨端恢复目标约束进度文件不假进程权限|部分|handoff caveat真实；接收绑定/环境核验/注入未有。|
|EV-H13|模型中断规范确定检索可用、语义排队|部分|纯确定性规范/FTS可用；模型服务与排队未有，不以没有模型称中断恢复已验。|
|EV-H14|崩溃重启任务恢复幂等不复活失效|部分/缺崩溃测试|SQLite事务/idempotency/cleanup真实；本分工未跑durability，导出通知队列缺、backup CE18。|
|EV-H15|协议不兼容拒写状态|部分/缺真实适配验证|server.ts:134返回426；本轮角色测试不等协议端到端测试，主窗口负责。|
|EV-H16|同项目不同checkout展示差异|未实现|handoff files清单且caveat明确未核查，没有repo commit/branch/worktree采集。|
|EV-H17|模型中断24h队列期限不重复不降级晋升|未实现|无模型审核队列/24h恢复用例；candidate pending是人工队列不是模型队列。|
|EV-H18|agent伪称用户/未配对不获得管理权、记录|部分|adapter直写/替代/结构化403 CE14真实；自述日记标observed、读取作者自动user，权限审计记录缺。|
|EV-H19|显式旧依赖skill缓存不默认返、失败状态|部分|结构化workflow ready/expand反证有效(CE13)；导出无ready/旧文件失效管理，raw skill没有依赖治理。|
|EV-H20|表外候选不自动晋升、截止归档裁决、不无限重试|部分|全部agent提交pending，30d清理真实；重要冲突CE15、补证CE16，无两次重试政策。|

20条联合验收在本分工的状态统计：完整0，部分17，未实现3（H10、H16、H17），纯“缺验证”0；17项“部分”中H01/H14/H15另有真实双端或崩溃/协议场景未在本分工验证。统计仅归纳本报告20行，不是完成比例，也不覆盖主窗口其他分工的新证据。

补充关系的版本影响：EV-CE-09确实新增了supersessions记录但knowledgeRevision保持11，依赖版本/会话版本检查感知不到这次关系修改；由于readKnowledge/search/prepare也不展开这条关系，下一次使用原条目不会自动带上补充。无需推断某个缓存已实际错误，就足以判“补充后刷新与反复复用链”缺项。EV-CE-13的exportedBrokenParent=true证明同一库中已ready=false的parent仍导出含child@1的SKILL.md，与核心阶段读取的dependency_unavailable形成直接反证。

质量验收另缺：冻结无插件基线、校准/留出样本、模型/提示词/知识版本标注、分类/漏召回/误晋升/重复错误/日记事实错误/人工负担评测。六项 semantic 单元测试只有精心构造的小样本，不证明P3收益。`calculateHybridScore`的 evidence='verified' 与schema的'verifiable'命名也不一致，但模块未接生产，本轮未将其夸成当前生产解析故障。

## 主窗口应保留的判断

优先修原提案CAS与审批审计、候选补证/重要冲突状态；事件必须绑定task并保存可核对的实际结果，而非把任意task.verified自述当observed。资料必须先统一读取到期门，再完成历史正文/备份/恢复的期限链。导出必须携带必需叶子、依赖版本、失效状态并处置已退役生成文件。此后再接模型分类、已有流程/步骤归属和证据白名单，完成当前包真实双端闭环。

不能通过给agent管理凭据解决工作中演化：当前403正是设计要求。应该补候选到管理员审核和受控策略的生产通道，而非绕过门禁。也不能把“改一个全量workflow正文”描述为“自动维护所属步骤”、把扫描到新文档描述为“从任务中自主学习”。

本轮只新增审计文件及隔离证据，不改业务源码、真实库、凭据、部署或注册表。可复用判断是审计方法而非已修复的产品经验；未向真实知识库写候选或晋升技能，以免审计污染被审对象。脚本与JSON为本轮可重复证据，报告状态不因现有测试全绿而上调。
