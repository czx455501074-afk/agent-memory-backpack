# Agent Memory Backpack 全面检验报告

检验日期：2026-10-11（Asia/Shanghai）。
项目根：`D:/huange-skill`。
受检源码：`c4a0ef7844760034c0b2ec206d90ba7b75c470bc`。
报告性质：设计追溯、代码审计、隔离动态检验、当前安装只读核对；不是修复或上线验收报告。

## 1. 总结：关键问题的直接答案

| 用户问题 | 检验结论 | 证据与限制 |
|---|---|---|
| 设计要求各项功能是否实现？ | **部分实现，完整产品目标未通过。** 知识底座、在线共享、按需调用和部分管理能力是真实现；自动分类/进化、完整任务接续、资料全链路清理、故障队列和版本化双端交付缺闭环。 | 本报告第4节逐项追溯、第8节正式20条验收；不能用文件数量、模块名或原追溯表勾选代替行为。 |
| 代码层是否有问题？ | **有，存在可复现的高影响缺陷。** 包括跨项目资料正文泄露、任务事件污染、任务规范失效、终态任务重开、失效替代目标、网页写入阻断、到期正文残留。 | 42个接口×6种角色/范围模式、18项演化反例、真实SDK/ToolRuntime调用，主窗口独立复验关键案例。 |
| DSH/Codex同时安装是否共用数据？ | **架构和隔离在线主链路实现；当前默认配置满足共享条件；当前两个桌面同时完整工作尚未验证。** | 同核心/同SQLite双端读同版本，批准后双方立即读新知识、受控门禁刷新通过。当前两端默认endpoint/project/root相同，但安装包不是当前源码同快照，未取得本轮当前Codex桌面同步调用。 |
| 插件会在用户工作中主动进化数据、经验吗？ | **只到自动准备/泛化事件采集、Agent主动提交候选、人工批准。没有实现生产连通的自主经验进化链。** | event不生成候选；semantic无生产调用；新经验统一pending；缺步骤归属、变更方案、受控自动晋升、效果验证。文件定时重扫是来源同步，不是任务中学习。 |
| 插件数据可被Agent主动调用吗？ | **可以读和提交候选，但不是全部数据和动作都有工具。** 两端各11工具：各9项业务成功，结构化/替代两项默认403符合管理权限设计。 | 真MCP SDK stdio与DSH ToolRuntime逐一调用。本DSH会话实际prepare/read/self-check也成功。Agent没有任务恢复、资料保存、候选进度查询等专用工具，部分读接口scope不完整。 |
| 插件会对Agent工作有负面影响吗？ | **会，已观察到故障阻断、上下文膨胀、误检/漏检、额外审阅和重试负担，以及错误状态/他项目信息污染。总体收益尚未建立对照证明。** | 第7节性能与质量探针。未做完整无插件长任务A/B，不能声称效率提升百分比或净收益已证实。 |

**总体定位：可运行的共享知识原型与治理底座，不是已经完成验收的自动经验管理产品。**

建议继续受控试用和修复，不把现状宣布为完整正式交付。尤其不能仅重新打包就认为问题结束：源码自身仍有功能和数据隔离缺陷。

## 2. 基线、方法和证据层级

### 2.1 权威设计

主基线：[双方审定联合规划 v1.0](<D:/huange-skill/docs/plans/2026-10-09-joint-plan-final.md>)、[签审记录](<D:/huange-skill/docs/plans/2026-10-09-joint-plan-signoff.md>)。

本轮重新计算规划SHA256：`da958e53ae2cb5dc7b6b8c331471d62c65952c24efdddd279b616a84cac000fe`，与签审记录一致。正式规划包含20条核心验收，不能只用旧草案14条或最新追溯表自评。

补充基线：[完整流程组织要求](<D:/huange-skill/docs/plans/2026-10-09-workflow-integrity-requirement.md>)、[P2细化需求](<D:/huange-skill/docs/implementation/p2-requirements.md>)。P2.4标可选的功能单列，不因原生HTTP而非Express、网页端口与建议值不同等实现选型差异判功能失败。

### 2.2 判定规则

| 标记 | 含义 |
|---|---|
| 已实现/指定实测通过 | 当前代码有实际路径，指定隔离正反测试通过；不自动代表全部真实桌面验收。 |
| 部分 | 字段/API/子路径存在，但缺要求的行为、连接、约束、数据完整性或端到端验证。 |
| 未实现 | 生产链路没有该行为；孤立函数、占位说明、手动调用替代均不算自动实现。 |
| 待实机验收 | 代码/隔离证据存在，但没有当前绑定包版本的真实两桌面/登录/窗口结果。 |
| 实测失败 | 有明确输入、实际错误结果、可复现证据；须修复后重跑。 |

不计算虚假“总完成率”：主规划、P2、流程补充存在交叉，不同粒度相加会重复计数。下表按可判断的行为拆分，并保留证据边界。

### 2.3 实际执行

- Node `24.19.0`、npm `11.17.0`；提取的DSH测试运行时 `0.2.0-rc.2`、MCP SDK `1.32.1`；当前真实DSH插件自报Node `24.18.1`。
- `npm run check`退出0。
- 本轮主回归：263测试、263通过、0失败、0跳过；排除会改真实Run的service测试、桌面窗口相关console和desktop-accept文件；指定latest包使打包冒烟实际执行。
- 演化专项独立编译到审计目录，11个选定测试文件96项全部通过。这是与263项有交集的独立验证，不相加成359项独立功能。
- 真实SDK/ToolRuntime：68次工具调用、17组检查，源码与18个源码/构建哈希、3个运行时入口哈希绑定；两端各11工具首轮22个预期结果一致，不等于22次业务成功。
- 接口矩阵：42个POST API×6种角色/范围模式=252请求，各用新隔离实例；另测Origin/Host/协议/重定向/请求体上限/并发/快照。
- 演化：18项新反例，模拟时间检验期限，读回SQLite/归档/导出文件，不只看列表。
- 性能：0/100/1000/5000合成知识；工具门禁40次、prepare20次、通用搜索15次；真实Codex hook10次；DSH Cordis故障/超时/取消验证。
- Web/Electron：完整脚本VM/DOM或IPC桩+真实隔离HTTP请求，覆盖面板及动作。该证据不是实际浏览器布局/截图或新Electron窗口验收。
- 当前真实安装：只读依赖、启用行、junction/插件manifest、包哈希及配置非敏感投影。配置内容未复制到报告，token和token哈希不进入证据。
- 本DSH会话实际调用self_check、prepare、search_workflows、read_knowledge成功。当前已采纳原始技能可读，但workflow目录返回空；raw skill的needsStructure标记真实，不能宣称完整流程库已迁移完。

本轮没有修改产品源码、真实知识库、宿主profile、凭据或登录启动项，没有重装/重部署、停止共享核心。仅新增报告、隔离脚本/夹具/证据。此前一轮全量测试含真实Run项恢复缺陷，本轮明确排除；前轮最终查询为registered=false，因缺运行前快照，不能断言其前态未受影响。

四个专项分工中，界面/发布分工在证据落盘后异常结束，主窗口已读回JSON、脚本与源码接管撰写；不把部分返回覆盖率当质量验收，也没有虚构最终专家通过结论。

## 3. 双端共享数据、安装和主动调用

### 3.1 共享机制是否真实

两个适配器不各维护一份正式库：请求同一HTTP核心，核心持有单Store/SQLite，凭据彼此独立。数据版本属于核心。隔离联调的实际结果：

1. 真Codex MCP SDK与DSH ToolRuntime同时读到知识版本1，权威数据来自同一个审计SQLite。
2. Codex提交规范修订候选，管理凭据批准到版本2；两端下一次prepare读到新规范。
3. DSH真实fixture副作用工具在新禁止项下被调用前拦住；Codex真实hook输出permissionDecision=deny。旧禁止项解除后的工具通过，不是所有工具永远被挡。
4. 新memory经候选批准后，两端主动read都立刻读到正文与条目revision1、库revision4。
5. 同条目同基线并发批准，一个200、另一409，失败提案保持pending，条目级事务/CAS有效。
6. 20次相同key并发，同一端各10次只有1个候选；跨DSH/Codex因principal不同总共2个候选。这证明按端幂等，不证明跨端语义去重。

**架构与在线主链路通过。** 同时安装只是前置条件，不保证任意配置都会自动合库。

### 3.2 当前机器事实

| 项目 | DSH | Codex |
|---|---|---|
| 本插件安装/启用 | desktop依赖与启用行存在，junction解析已核 | 本插件manifest和enabled=true已核，不是泛查cache目录 |
| 默认endpoint | http://127.0.0.1:47631 | http://127.0.0.1:47631 |
| 默认projectId | p0-workflow | p0-workflow |
| 默认projectRoot | D:/huange-skill | D:/huange-skill |
| role | adapter | adapter |
| 当前包 | DSH插件入口与runtime server/store/ui匹配latest旧包 | manifest版本同名，但hook/runtime server更旧，ui/capabilities缺 |
| 当前实际会话验证 | 本会话自检/读库通过，Managed，库版本2 | 本轮没有当前Codex桌面同时调用证据 |

DSH实际解析到`<HOST_PLUGIN_ROOT>/<HOST_PLUGINS_DIR>/agent-memory-backpack`；Codex真实缓存为`agent-memory-backpack-local/agent-memory-backpack/0.1.0-p0.1`。两者同版本字符串不代表同代码。

配置条件已满足共享；**仍未证明本轮当前两个桌面正在同库同时工作的完整场景。** 未重启Codex、改信任、补安装或写真实库来制造该证明。

latest产物81文件自身哈希匹配；但doctor/server/store/ui四个runtime源摘要不等当前构建，desktopVerified=false。三个包没有新capabilities/policy/semantic模块。旧代码尚不引用缺模块，因此不是旧包立即启动崩溃，而是当前新增能力尚未部署。

### 3.3 11个Agent工具实际结果

| 工具 | 默认DSH/Codex结果 | 具体作用/边界 |
|---|---|---|
| amb_self_check | 成功/成功 | 连通、协议、版本；不证明完整产品质量。 |
| amb_prepare | 成功/成功 | 当前规范、流程摘要、相关raw知识；本DSH手动调用还能自动登记任务，所以非纯无副作用读取。 |
| amb_search_workflows | 成功/成功 | 只搜结构化workflow；当前真实库没有结构化flow，空结果不等于无raw技能。 |
| amb_read_stage | 成功/成功 | 指定stage及必需依赖，失效依赖明确失败。 |
| amb_read_knowledge | 成功/成功 | skill/memory详细正文，includeLeaves控制必需文档正文；空leaf.body在includeLeaves=false时是预期。 |
| amb_knowledge_history | 成功/成功 | 元信息、版本时间、替代链，不返回旧版全文；项目隔离缺陷见F02。 |
| amb_unstructured_skills | 成功/成功 | raw技能待结构化目录；列表scope遗漏。 |
| amb_submit_experience | 成功/成功 | 只入候选，非正式生效；部分合法DSH重试误报。 |
| amb_inspect_archive | 成功/成功 | 只预览归档统计文件，不导入；归档正文需管理权限。 |
| amb_structure_skill | 403/403 | 普通adapter凭据不应直接退休skill并写flow；公开工具描述与默认可达能力不一致。 |
| amb_supersede_experience | 403/403 | 普通adapter不应直接管理有效经验；应走候选审核，不给Agent管理凭据解决。 |

缺少Agent专用工具：任务列表/明确恢复/更新/日记、候选状态和补证、临时资料保存/检索/续期、通用规范/偏好搜索。底层HTTP存在部分接口，不等于模型工具目录天然具备。

### 3.4 配置与故障边界

默认同OS用户home、同endpoint/project，才能共享同范围；不同用户、显式变量或定制目录可连不同核心，没有跨库自动合并。

实测空白AMB_DSH_CONFIG时核心TypeScript解析器与适配器解析器对有效AMB_CONFIG选择不同；显式失效路径回落默认库，可能越过原本隔离的测试/自定义配置意图。范围外cwd下DSH工具明确挡住，Codex hook跳过，但Codex MCP仍读该凭据绑定项目并提交候选。离线候选没有持久outbox，网络恢复后需显式重试；不自动补回未送事件/候选。

## 4. 逐项功能追溯矩阵

下表覆盖主规划产品链、P2用户功能、完整流程补充与运维。依据源码和指定测试；“部分”常包含真实实现与失败反例，不能整体抹成无实现。

### 4.1 底座、内容与检索

| ID | 设计功能 | 状态 | 实现/缺口 |
|---|---|---|---|
| K01 | 单权威本地库，双端读写同核心 | 已实现，隔离通过 | Store/HTTP、双端版本与批准即时读取。 |
| K02 | SQLite事务、版本历史、状态、CAS | 已实现条目级 | 正文/head/FTS同事务；原提案基线重审与替代目标active另有失败。 |
| K03 | 核心单实例、健康、自启动 | 部分/待实机 | 锁与detached/start存在；health误认、并发启动/实际登录缺验。 |
| K04 | 配对、角色分离、协议回环 | 部分 | 核心鉴权/role/Origin/Host/426通过；项目对象遗漏、Windows凭据ACL/撤销完整流程未验。 |
| K05 | 全局/项目/任务、平台/软件版本独立范围 | 部分/实测失败 | scope/platform字段有；taskId和platform未贯穿prepare/gate；无完整软件版本匹配。 |
| K06 | 规范保留原文/例外/来源/版本，不语义筛选 | 部分 | body和active/project过滤真实；例外/冲突决策、任务条件缺。 |
| K07 | 偏好区分明确陈述与推断 | 部分 | stated字段及false-global校验有；默认true和编辑重置可误标。 |
| K08 | 事实记忆来源、确认时间、条件 | 部分 | 正文来源/修订时间有；无独立确认时间和条件复核。 |
| K09 | skill经验优先修订已有，不增碎片 | 部分 | skill/flow类型有；无自动找所属步骤/合并方案。 |
| K10 | 日记、资料与行为规范分开 | 部分 | 独立kind存在；实际日记证据/事件关联/资料scope失败。 |
| K11 | 多层分类、标签、稳定ID、关联 | 部分 | workflow.categories多路径、labels/tags有；普通知识分类目录与跨条目关联不全。 |
| K12 | 可信来源/证据等级独立 | 部分/实测失败 | submit固定agent/self-reported有效；scan全部user/observed、资料来源可填、日记自述被升级。 |
| K13 | 中文关键词检索 | 已实现，指定测试通过 | CJK bigram+FTS coverage/BM25；有自然表达误检/语义漏检。 |
| K14 | 分类/关键词/语义/版本/证据混合召回 | 部分 | 当前生产仅词法；semantic/hybrid只有定义和单测。 |
| K15 | 摘要先行、正文按需 | 已实现指定路径 | prepare摘要、read展开；所有知识类型尚不均等可达。 |
| K16 | 记录知识版本、为何检索、已知缺口 | 部分 | retrieval/why回执有；没有持久检索事件便于日后查。 |
| K17 | 可配置经验资料token预算 | 未实现 | 固定条数/字符不是可配置token预算；规范总量无上限。 |
| K18 | 技术栈/目录/工具/故障变化补检索 | 部分 | 新用户消息重新prepare；工具gate只取规范，不查新的相关经验。 |
| K19 | 相同意图/同版本复用检索 | 未实现 | 每次重新取current/FTS，无对应缓存判定。 |
| K20 | 中途变更新版本，下次受控检查用新 | 已实现隔离主路径 | 两端规范刷新/门禁通过；非所有工具别名/不可覆盖路径，待实机全矩阵。 |
| K21 | 活跃/历史隔离，显式历史入口 | 部分 | 库默认active有效；导出残留旧文件/历史入口scope缺。 |
| K22 | 基线/留出样本、误检/误晋升/负担质量评测 | 未实现产品验收 | 小单测与本轮探针不等于冻结无插件评测。 |

### 4.2 主动进化、完整流程

| ID | 设计功能 | 状态 | 实现/缺口 |
|---|---|---|---|
| E01 | 工作前自动prepare | 部分/隔离通过 | DSH pre-step、Codex SessionStart/UserPromptSubmit；DSH核心故障会阻断。 |
| E02 | 工作中自动真实事件采集 | 部分 | 自动送kind/泛化摘要，没有任务关联与可核对工具结果。 |
| E03 | 事件自动提炼经验候选 | 未实现 | event仅INSERT events，不调用submit。 |
| E04 | Agent主动提交候选 | 已实现在线 | 可回执/幂等；离线丢送、DSH新状态重试问题。 |
| E05 | 类型、范围、重复/冲突、拆分/复用价值判断 | 未实现生产 | 正则模块不被使用，拆分是占位；无模型。 |
| E06 | 模型服务、发送范围配置、embedding | 未实现 | 外部模型没有配置/调用；也没有未经配置自动发全库的证据。 |
| E07 | 来源/证据核验与已有相关条目检索 | 部分 | schema/固定self-reported有；无候选语义检索记录/独立结果验证。 |
| E08 | 形成差异与修改/补充/替代方案 | 未实现自动链 | 管理员手填完整entry，独立supersede命令非方案执行器。 |
| E09 | 分级审核白名单、引导期确定变更 | 部分 | policy单函数、admin门禁有；submit固定review，不执行auto/user分支。 |
| E10 | P3限定低影响经验自动生效 | 未实现 | 所有新候选pending；未有冻结门槛/质量收益。 |
| E11 | 重大冲突待裁决，不因普通期限删正文 | 实测失败 | 没有独立重要冲突态；31天普通pending过期清payload。 |
| E12 | 待补证30天、拒收90天 | 已实现期限子路径 | 归档/拒收清理存在；来源到期/归档正文策略未闭合。 |
| E13 | 新证据重审、最多两次自动补证失败 | 未实现 | needs_evidence没有回pending的完整协议/重审机制。 |
| E14 | 原提案基础版本并发重比较 | 部分/实测失败 | entry旧base挡住；审批者填current base可通过旧提案，无重比较记录。 |
| E15 | 审批人/时间/理由完整审计 | 部分 | principal是提交者；approve缺批准者时间，reject不记理由。 |
| E16 | 修改有效知识不授Agent管理权 | 已实现角色门禁 | adapter直接write/approve/structure/supersede403；部分admin对象越项目另列。 |
| E17 | 持久候选/事件离线暂存与重连重审 | 未实现 | 没outbox/容量/期限/自动重放；网络恢复需手动重试。 |
| E18 | 持久索引/导出/通知任务恢复 | 部分 | 同步FTS事务可恢复；无持久导出通知任务。 |
| W01 | 稳定完整流程根、前提阶段检查失败完成 | 部分 | workflow结构有；无完整输入输出/不适用/条件分支结构。 |
| W02 | 跨分类定位同一根流程 | 已实现结构化flow | categories多路径同ID；不复制成零散技能。 |
| W03 | 新经验归属流程/具体stage并修订父版本 | 未实现自动链 | workflowId可选，无stageId/方案/自动关联。 |
| W04 | 无归属先候选，只独立方法才新建 | 未实现判定 | 未指定flow可直接新memory，未有待归属审查。 |
| W05 | 入口前提检查完成、阶段必需依赖展开 | 已实现结构化flow | root/stage+required child，指定测试正反通过。 |
| W06 | 必需缺失/旧版本/跨范围/循环标不完整 | 已实现flow依赖主路径 | ready=false、expand错误真实；任务scope/软件兼容/资料依赖不全。 |
| W07 | 公共子流程更新影响父，缓存导出停用旧 | 部分 | read时版本校验；导出照写失效父、旧文件保留。 |
| W08 | 原技能结构化是人工署名，不凭Markdown猜 | 已实现管理路径 | structure事务保history；adapter公开工具403、迁移实库仍raw。 |
| W09 | skills可读导出保必需引用和失效状态 | 实测失败 | 只写SKILL.md，叶子正文未导出；退役后文件仍留；ready=false仍导出。 |

### 4.3 任务、资料、管理与交付

| ID | 设计功能 | 状态 | 实现/缺口 |
|---|---|---|---|
| T01 | 独立任务ID、一任务多会话、一会话多任务 | 部分/失败 | 后端sessionIds有；自动ID由session固定，terminal被普通prepare重开。 |
| T02 | 进行/暂停/完成/取消/失败状态真实 | 部分 | 五态schema/record有；自动Stop不完成，但自动暂停/切换缺。 |
| T03 | 自动start/event/end/switch与事实进度 | 部分 | start登记；事件只session无task；无end日记/switch paused。 |
| T04 | 短准确日记，不自述当实证 | 部分/失败 | generate字段和三态有；任意verified字符串生成success/observed，真实事件0关联。 |
| T05 | 任务关联提案/经验/规范快照 | 部分 | 字段可手填，没有自动更新及完整规范版本快照。 |
| T06 | 明确跨端继续与接收会话绑定注入 | 未实现完整链 | handoff只读、按钮只展示；adapter不消费恢复task。 |
| T07 | 目标约束决策进度文件验证知识建议 | 部分 | task/norm/flow/files/verified/caveat有；决策与环境核验缺。 |
| T08 | 不同checkout分支提交未提交差异核验 | 未实现 | 无repo状态采集/差异显示；清单不是文件同步。 |
| T09 | Markdown/JSON任务导出 | 已实现指定字段 | 当前task/events可读；没有全部相关知识/候选原文快照。 |
| T10 | 事件30天，日记永久，资料更早期限 | 部分 | events TTL有效，journal独立；无自动永久日记、来源期限联动。 |
| M01 | 主动URL摘要/阅读观测/用户保存三入口 | 部分 | material/save HTTP有，MCP无专用工具；无自动阅读结果采集。 |
| M02 | 来源URL时间摘要任务及保守去重 | 部分 | fields/fingerprint有效；scope固定global、provenance可填、片段URL处理边界。 |
| M03 | 默认90天、普通读/重复不续期 | 已实现专用路径 | material测试/续期理由有效，不能掩盖读入口TTL遗漏。 |
| M04 | 到期所有默认读即时过滤 | 实测失败 | 专用列表过滤；get/universal在未清理/失败时返正文。 |
| M05 | 持久清正文摘要索引缓存附件、失败重试 | 部分/失败 | 启动/请求/分钟cleanup有；只退役正文仍在，无持久failed状态。 |
| M06 | 明确原因续期、单条删除/大小可见 | 部分 | renew有，单条资料删除/占用大小不完整。 |
| M07 | 资料晋升最小证据独立生命周期 | 未实现 | 没promotion/来源TTL关联结构。 |
| M08 | 备份日志导出策略，恢复不复活到期内容 | 实测失败 | 全revisions等导出，import不先cleanup，正文永久保留。 |
| U01 | 本地Web管理而非依赖独立桌面壳 | 已实现静态服务，入口失败 | core自供html/js/css；首次错误项目403。 |
| U02 | 规范偏好/综合知识/流程浏览搜索编辑 | 部分/失败 | 读取在修正项目节点后有效；verified400、结构字段丢失风险。 |
| U03 | 候选列表、单审、批量四动作 | 部分 | 列表及3批量动作有；approve字段错、批量批准UI无、failed忽略。 |
| U04 | 任务日记接续导出界面 | 部分 | 展示/预览，非完整恢复或自动日记。 |
| U05 | 资料期限提醒状态、续期/删除/清理 | 部分 | 列表/续期/清理；失败状态不显示、正文未清。 |
| U06 | 真实端能力、心跳、版本、同步、故障重连 | 部分/误报 | 静态yes/目录探测，capabilities失败仍Managed，无真实信任/包哈希绑定。 |
| U07 | 旧版本全文历史浏览 | 部分 | 历史元信息可查，没有旧全文diff。 |
| O01 | 扫描采纳去重不改原文件、批次撤销 | 已实现指定测试 | source/hashledger/撤销保护真实；scope/作者判定另有缺口。 |
| O02 | 定时重扫来源变化、失败可见 | 部分 | persisted roots+timer有；全global/user/observed刷新，非经验判断。 |
| O03 | 备份预览导入幂等原子迁移 | 已实现主路径 | archive/backup完整回归通过；TTL保留不合设计。 |
| O04 | 用户级常驻登录、单实例健康恢复 | 部分/待实机 | 函数/锁有；未真实开机/脱宿主全链路验收，health误判。 |
| O05 | 安装升级包与启用真实校验 | 部分 | 包自身hash检查有；current源码/部署不一致，inactive deploy仍exit0。 |
| O06 | 停用卸载新会话无工具/注入与不删源 | 待当前包实机验收 | 历史证据存在不是当前复验；未自动操作真实桌面。 |
| O07 | 日志/诊断不泄密、版本可追溯 | 部分 | 字段脱敏/轮转通过；任意URLquery/坏输入、拒绝审计/保留期边界缺。 |
| O08 | 不影响Agent主工作，量化收益 | 未通过整体验收 | 负面反例实测；无冻结真实长任务A/B净收益证明。 |

## 5. 代码缺陷与影响优先级

严重级别依据实际影响，不以数量包装完成度。以下归并同源问题，完整42API和18反例在附件。

| ID/级别 | 问题与实际影响 | 核心代码定位 | 本轮实测证据 |
|---|---|---|---|
| F01 高 | 项目资料自动global，其他项目可读完整正文，来源可填user | material.ts:100；server.ts:282；store.ts:1496 | alpha保存→beta get 200/原正文；主窗口独立重复成功。不是规范提权。 |
| F02 高 | history/recent、history、unstructured漏scope，泄露标题/路径及原因证据 | server.ts:217,241,252；store.ts:1374,1639,1660 | alpha读到beta PRIVATE-REASON/EVIDENCE；普通get/read异项目404有效。 |
| F03 高 | 单项审阅、续期、write只校外层项目，不校对象归属 | server.ts:156–183,261；store.ts:742,788,805,876,1515 | alpha admin改变beta提案/资料；batch内scope检查反而有效；wasGlobal可改全局条目。 |
| F04 高 | 事件taskId可指他项目，污染日记/导出事实 | store.ts:683,1059,1143 | alpha event入beta task.export.events；主窗口独立读回成功。 |
| F05 高 | 任务规范/平台范围执行遗漏 | store.ts:328,548,611；server.ts:149 | 显式taskId仍norms无、工具allow；codex-only规则被未过滤prepare返回。 |
| F06 高 | 普通prepare重开终态，继承旧验证说明 | store.ts:539,1033,1037,950,959 | completed→prepare新任务→同ID in_progress、旧verified、completedAt=null。 |
| F07 高 | 事件不绑定任务、无自动日记、自述任意verified被标实证 | dsh/index.mjs:623；codex/hook.mjs:344；store.ts:1061,1065–1080 | 真实形状Stop事件1行，日记0事件；任意自述生成success/observed。 |
| F08 高 | TTL读取旁路/清理只退役/备份恢复留正文 | store.ts:456,503,1479,320；backup.ts:84,198 | 到期专用列表空但get/universal有body；purge后SQLite和归档仍有body/summary。HTTP清理失败注入证明读时门缺。 |
| F09 高 | 失效替代目标允许，成功后无有效结论 | store.ts:1603,1606,1621 | old→retired replacement返回成功，两者retired。 |
| F10 高 | 流程/技能导出缺引用、留旧文件、失效父仍导出 | export-skills.ts:91–97,158–166 | raw leaf未写；retired SKILL.md仍在；ready=false parent仍输出。主窗口独立前两项复验。 |
| F11 高 | Codex MCP无cwd/projectRoot约束，与hook/DSH不一致 | mcp.ts:127–132；client.ts:38 | SDK outside cwd读/提交成功，DSH明确scope error，hook无输出。 |
| F12 高 | 快照无项目/核心身份，错误策略互覆盖；协议错也回退放行 | gate-cache.mjs:41,49,98；codex/hook.mjs故障catch | beta使用alpha禁止表误deny；beta空表覆盖后alpha在426放行；31天原禁止工具放行。 |
| F13 高 | DSH自动prepare失败直接抛错阻断，与门禁降级不一致 | dsh/index.mjs:250–256；core-client.mjs:7,67 | 503 pre-step rejection；timeout约5010ms；同期gate503 allow。 |
| F14 高 | Web首次项目身份错误、所有保存批准枚举错 | ui.ts:33,167,656,717；schema.ts:44 | 三初始化403；save/approve400。修字段后元信息清空风险须一起修。 |
| F15 中 | 原提案CAS未约束审批基线重审 | store.ts:648,749,774 | entry base1时409；改entry base2即旧base1提案批准v3，无重比较。不是完全没有CAS。 |
| F16 中 | DSH新候选state合法重试误报、重试被前置workflow CAS遮挡 | dsh/index.mjs:100,107；store.ts:645–648,668 | needs_evidence/archived retry invalid receipt；同key旧payload在workflow变更后409但候选仍pending。 |
| F17 中 | 无离线outbox/自动重放，断线需保留原payload重试 | adapters请求函数；store无queue表 | offlineCandidates=0；恢复explicit retry成功，无自动replay。 |
| F18 中 | 语义/审核策略没接生产、补充不传播 | semantic.ts:92,196；store.ts:662,774,1630 | 相同正文两ID并存；supplement版本不增、read无关系；“全面闭环”标记不成立。 |
| F19 中 | 重要冲突普通过期；补证无重审；批准者/拒收理由缺 | store.ts:898–905,742–819 | important text候选31天expired/清payload；needs_evidence新增证据仍不能approve。 |
| F20 中 | 静态能力/安装诊断与UI/部署回执假阳性 | capabilities.ts:60,95；ui.ts:533；deploy-plugin脚本 | 空cache视installed；capability错误仍Managed；active=false仍exit0；新包待部署。 |
| F21 中 | coreSchema允许重复client.id，幂等跨项目碰撞 | config.ts:29；store.ts:668,685 | 两项目同平台ID被接受，后项目same key/event 409。 |
| F22 中 | 解析器分叉/失效配置fallback可能进入另一库 | config.ts:63；resolve-config模块 | 空专用变量解析差异；失效专用覆盖有效通用后回落默认。 |
| F23 中 | 规范总上下文及Codex重复注入无预算 | store.ts:548–568,611；codex/hook.mjs:330 | 40条规范每次约48万字符；10工具约480万重复字符，非token估算。 |
| F24 中 | 测试会改真实Run且恢复虚构命令 | service.test.ts:118–138 | 静态确认；本轮排除不再执行。前轮最终未注册但无前态快照。 |

补充边界：健康GET可把任意200文本或307目标认作核心，POST带凭据重定向却有效禁止；这不是已证泄密。原始Host无效返回403，Node fetch忽略自填Host造成的200不是漏洞。Archive整库管理权限是明示设计，不误报为跨项目adapter提权。

## 6. 主动进化链路判定

当前流程：用户消息→自动prepare→泛化事件入库；Agent若自行遵循提示→amb_submit_experience→pending；管理员用完整entry→批准入库→双方后续查询可读。

缺失流程：实际工具结果/用户纠正→独立证据识别→自动提炼候选→检索已有→类型/作用域/价值/冲突分析→定位根workflow/stage→形成差异方案→按白名单审阅→原子有效变更→通知/导出/完整复用评测。

定时扫描确能跟随已有文件变化更新库。但candidateToKnowledge固定global/user/observed，来源同步没有先证明作者/适用范围，也没有判断任务经验的复用性；被扫描的是Agent或网页落盘内容时，直接标用户身份有风险。读到文件只能证明字节存在，不能证明内容为用户说过或结论已验证。

适配器写入门禁不是要去掉的阻碍：给Agent admin凭据会破坏设计的管理隔离。正确补的是候选方案、证据、审批/自动白名单执行链，而不是让Agent自行批准。

## 7. 对Agent工作的负面影响与性能

### 7.1 隔离性能读数

合成memory，每条约10遍固定说明，5%标题命中Database recovery。内存SQLite、热进程，本机测量，不代表实际真实库/端到端SLA。

| 知识条数 | gate中位/p95（ms） | prepare中位/p95（ms） | universal p95（ms） |
|---|---|---|---|
| 0 | 0.018 / 0.026 | 0.091 / 0.143 | 0.084 |
| 100 | 0.959 / 1.818 | 2.872 / 3.595 | 1.638 |
| 1000 | 8.796 / 10.747 | 26.324 / 27.564 | 10.603 |
| 5000 | 45.876 / 52.177 | 137.508 / 145.503 | 64.159 |

current()每次读取并parse全活跃库，gate即使只用norm也走全库；HTTP每次先cleanup又扫描，随着库增长CPU成本增加。上述读数没有包括所有HTTP/文件快照/hook进程，也没有持续高并发慢连接/大附件压测，不能说已经全面验证资源耗尽。

Codex真实PreToolUse hook10次（小库、单规范）：中位112.836ms、p95 116.619ms；每次额外context51字符。每工具还会PostToolUse单独起Node送事件，其额外耗时本轮未独立量化，不能只用PreToolUse代表全部hook开销。

DSH pre-step核心503约8ms直接reject；核心无响应约5010ms后reject；取消约63ms响应abort。说明取消能结束请求，不等于故障下主工作能继续。

5000规模进程RSS观测374MB，但同一进程顺序建不同规模库，未强制GC/单独进程隔离；这个数只能提示内存压力，不能归因为5000条库稳定常驻内存。

### 7.2 上下文压力

40条合法norm，每条接近12000字符的压力夹具：prepare 480687字符，gate 480629字符。Codex每次allowed工具返回整段gate context，10次请求累计4806290字符；是测得单次×10，未宣称真实宿主最终保存或模型全部读取了这些字符。

这不是实际库普遍48万字符，而是“合法输入缺总预算/激活划分”反例。不要解决成静默裁掉硬规范；应增加条件激活、冲突提示/超预算可见处理，并对同版本已送规范做有效缓存。DSH仅revision变化时再注入规范，重复负担较轻，但仍每次gate并写共享快照。

### 7.3 检索质量

8个作者构造知识条目、12个有目标查询+2个噪声查询。目标命中11/12；英语SQL transaction rollback没召回中文数据库回滚条目。长“全面检查插件代码是否实现共用数据和主动经验进化”查询还选出视频连续性条目；相关tests命中不等于其他返回都相关。

这是人工小探针，非随机留出集，不报告91.7%产品准确率。真实本会话多次准备上下文出现Runpod、短剧/生图等与项目审计不直接相关技能，属于观察到的上下文噪声，但模型因此答错多少或花费多多少没有A/B测量。

### 7.4 人工与行为负担

- Agent必须自行发现并调用候选提交，插件未自动提炼；经验生效仍依赖人工填写结构。
- 默认公开structure/supersede却返回403，会造成额外失败调用；应标清候选替代路径，而不是扩大权限。
- 两端相同发现可产两个候选，缺语义去重；候选补证/新状态回执误报增加重试。
- 没outbox时用户/Agent必须保存原payload，断线会丢未送信息。
- UI错误、能力绿态假阳性和部署版本漂移让用户难判断“功能没做”还是“旧包没更新”。
- 跨项目资料/事件/历史污染可能把他项目信息带进决策；日记自述被observed会使后续Agent过度相信未验证结论。
- 过期导出文件和资料备份继续留存，使旧结论在宿主原生技能读取路径回流。

正向收益：有效规范集中、版本历史、在线跨端立即读、原子写入、scope覆盖的读取和flow依赖检查可减少部分重复工作。但未建立无插件基线、真实多任务留出集、人工负担/重复错误/费用/等待成本对照，**净收益仍待验证**。

## 8. 正式20条验收结论

“隔离通过”仅某主路径；完整试用需当前同包双端及所有要求一并通过。本轮没有将任何有已知反例的整项标最终通过。

| # | 正式验收 | 本轮状态与原因 |
|---|---|---|
| 1 | 同范围新规范替旧，两端受控用新 | 隔离主链通过；当前两桌面同包实机待验，失效替代目标存在反例。 |
| 2 | 这一次只任务范围 | 失败：taskId未贯穿norm/gate，scope字段不是行为。 |
| 3 | 网页命令只资料非规范 | 部分：material kind/external默认有效；来源可伪填/扫描globaluser，可信源边界不足；未出现classifier生产自动晋升。 |
| 4 | 测试自述不冒充验证 | 失败子路径：candidate自述保留，journal任意verified转success/observed。 |
| 5 | 同版不同修改不静默覆盖 | entry CAS隔离通过；原提案基线可换审批base绕过重新比较，整项未通过。 |
| 6 | 已有经验合并修订不重复追加 | 部分：手动CAS修订可用；自动关联/语义合并缺，重复新ID成功。 |
| 7 | 技术栈变更补检索并解释 | 部分：新prompt和why有；工具/目录/故障触发和缓存缺。 |
| 8 | 历史可查，普通不带旧结论 | 库active主路径通过；旧导出残留、全文历史与专用入口scope未闭合。 |
| 9 | 资料到期过滤，恢复清正文摘要索引 | 失败：通用读取/历史正文/备份恢复反例。 |
| 10 | 引用资料独立证据晋升/生命周期 | 未实现：无promotion/来源TTL链。 |
| 11 | Stop/取消/暂停/失败非完成且跨会话关联 | 部分：Stop不complete；无自动归属/切换，同session终态重开。 |
| 12 | 跨端恢复目标约束进度文件 | 部分：handoff可读；恢复绑定/注入/核环境缺。 |
| 13 | 模型中断确定性继续，语义排队 | 未完成：无模型队列；不能以没有模型服务称中断恢复通过。 |
| 14 | 崩溃重启幂等不复活失效 | 事务/持久幂等/既有durability回归通过；无导出通知outbox、workflow重试反例、到期资料restore失败。 |
| 15 | 旧协议拒写并显示状态 | 核心426拒写通过；hook把426当失联回退可能放行，整体治理状态不符合要求。 |
| 16 | 同项目不同checkout展示差异 | 未实现：无branch/commit/worktree/关键文件核对。 |
| 17 | 模型中断24h队列恢复期限不重复 | 未实现：无对应队列与24h测试。 |
| 18 | Agent伪称用户/未配对不获管理权且留记录 | admin门禁/401通过；source伪填/自述证据升级、对象scope和审计日志不足。 |
| 19 | 旧依赖失效skill/cache停默认返回 | 结构化flow ready/expand通过；失效父可导出、旧SKILL.md不删、raw依赖未管。 |
| 20 | 表外不晋升，归档裁决正确，不无限重试 | 候选不自生效通过；重要冲突期限/补证重审/重试上限缺。 |

原矩阵“65完成/13部分/0未实现”没有按代码+测试+真实环境证据逐项闭合；其中语义/审核/资料/管理界面完成标记直接受到本轮反例否定。本报告不覆盖修改原表，不用换定义制造通过。

## 9. 修复顺序与下一轮验收门槛

| 阶段 | 必须完成的修复 | 可验证的退出标准 |
|---|---|---|
| R0 数据与范围正确性 | F01–F12的对象scope、task/platform、事件来源、终态、替代active、TTL、旧导出/必需引用、MCP cwd、快照身份 | 42API跨项目反例全部变明确失败且本项目可用；用户输入不越范围；库/归档无应清正文；终态不被检索改变。 |
| R1 可用性和契约 | 网页身份/evidence/元数据保留/failed回执、DSH失联prepare、状态重试、配置解析、真实Run测试隔离 | 完整页面启动和所有动作正反测；offline/protocol/auth三种分别处理；不阻断普通已允许工作也不以过期策略作最新许可。 |
| R2 真正经验与任务小闭环 | 候选类型/已有flow/stage/方案/证据、补证重审/冲突保留、任务事件日记/接续绑定、持久outbox | 一个真实项目两端演示“开始→实际结果→候选→审批→对应步骤更新→下次完整复用”；模型故障时诚实pending与恢复。 |
| R3 性能和收益 | 上下文预算/规范激活与同版去重、current全库解析优化、冻住校准/留出与无插件基线 | 记录输入规模、p95、字符/token独立计量；噪声/漏检、日记事实错误、人工负担不靠少量单测推断。 |
| R4 发布与当前双端验收 | 同源码重新打包/部署两端、版本/哈希标记、信任/停用/失联/恢复/卸载新会话 | 代码提交=产物manifest=实际包摘要=运行证据；当前两桌面同核心同时读写、真实受控门禁、停用后新会话无工具注入。 |

先修确定性错误，再谈模型能力和自动晋升。未取得冻结质量收益前继续人工审核，不能用更多自动写入掩盖问题。

未验证剩余范围：当前双端完整UI/信任/禁用/登录重启，真实长任务A/B，持续高并发/慢连接/大库归档资源界限，Windows ACL/配对撤销，隐性依赖和全部宿主工具路径。没有浏览器布局截图的部分报告已明确为脚本级测试，不称“真实GUI通过”。

## 10. 报告与复现入口

专项报告：

- [共享数据与主动调用](<D:/huange-skill/docs/implementation/2026-10-11-full-audit-shared-call.md>)。
- [经验、数据演化与完整流程](<D:/huange-skill/docs/implementation/2026-10-11-full-audit-evolution.md>)。
- [权限、隔离与故障](<D:/huange-skill/docs/implementation/2026-10-11-full-audit-security.md>)。
- [界面、安装与发布](<D:/huange-skill/docs/implementation/2026-10-11-full-audit-ui-release.md>)。

原始/精简证据：

- [主回归日志](<D:/huange-skill/.local/full-audit-20261011/regression.log>)。
- [双端工具与17组检查摘要](<D:/huange-skill/.local/full-audit-20261011/shared-call/result-summary.json>)、[最终完整调用证据](<D:/huange-skill/.local/full-audit-20261011/shared-call/run-56573f16-b261-4214-9405-8aa5e022414b/evidence.json>)。
- [42API角色范围简表](<D:/huange-skill/.local/full-audit-20261011/security/role-scope-summary.json>)、[完整矩阵](<D:/huange-skill/.local/full-audit-20261011/security/role-scope-matrix.json>)、[补充故障/审批/事件反例](<D:/huange-skill/.local/full-audit-20261011/security/supplement-findings.json>)。
- [18演化反例](<D:/huange-skill/.local/full-audit-20261011/evolution/reproduction.json>)。
- [性能/上下文/故障数据](<D:/huange-skill/.local/full-audit-20261011/performance/results.json>)。
- [界面发布全证据](<D:/huange-skill/.local/full-audit-20261011/ui-release/results.json>)、[当前配置非敏感投影](<D:/huange-skill/.local/full-audit-20261011/ui-release/current-config-projection.json>)。
- [主窗口独立跨项目复验](<D:/huange-skill/.local/full-audit-20261011/main-verification.json>)。

隔离复现命令（源码当前构建dist已在本轮核对；不要用全量service测试代替）：

```powershell
npm run check
node .local/full-audit-20261011/shared-call/audit-shared-call.mjs
node .local/full-audit-20261011/shared-call/audit-config-path.mjs
node .local/full-audit-20261011/evolution/reproduce.mjs
node .local/full-audit-20261011/security/http-audit.mjs
node .local/full-audit-20261011/security/supplement-audit.mjs
node .local/full-audit-20261011/security/identity-audit.mjs
node .local/full-audit-20261011/performance/performance.mjs
```

审计脚本保留自己的夹具/随机端口，不改真实宿主；重复运行应遵守脚本既有覆盖/临时目录说明。本报告未将缺陷候选写进受检真实库，也未晋升技能：当前是未修复问题和指定一次实验，不应污染审计对象或冒充已验证修复经验。

**最终结论：同核心共用数据和Agent读取确实成立；设计的完整主动进化、可靠任务接续、生命周期治理及无负面净收益尚未成立。应以反例修复和当前包双端完整验收结束项目，而不是以单测全绿或追溯表勾完结束。**
