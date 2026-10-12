# Agent Memory Backpack 全面审计：权限、隔离与故障语义

日期：2026-10-11，Asia/Shanghai。受检提交：`c4a0ef7844760034c0b2ec206d90ba7b75c470bc`。依据为正式 [joint-plan-final.md](../plans/2026-10-09-joint-plan-final.md) §§3.4、5.3、6.4、8、12；前轮 landing-audit 仅用于判断增量，不作为本轮行为证据。

## 结论

**鉴权、管理员门禁、外层项目检查和部分对象隔离真实有效，但项目隔离没有贯穿资料、历史、单项审批、事件和离线快照。存在 adapter 可触发的跨项目正文泄露、事件污染与治理误放行，以及项目管理员跨项目审阅变更。**

禁止把这些发现概括成“所有 API 都无隔离”：规范、偏好、通用知识 get/read、流程展开、任务直接读写、supersede/structure/delete 的异项目对象均被正确挡住。新增高影响反例见 S1–S5。S6 复验旧保留缺陷并补上清理失败 HTTP 链路；S7–S10 为边界和可用性问题。

## 方法与可重放证据

- 只在 `.local/full-audit-20261011/security/` 编译独立构建，使用内存 SQLite、随机回环 HTTP 端口、随机合成凭据。没有读真实凭据、改业务源码、改 profile/注册表、停止共享核心或请求外部站点。
- 42 个 POST API，各用新内存核心执行 6 种角色/范围模式，共 252 次矩阵请求，避免前一个变更污染后一个结论。
- 核心测试包含两项目的项目范围知识、资料、任务、提案、替代历史。检查真实响应内容与持久状态，而非仅凭 HTTP 状态判断漏洞。
- 真正启动 Codex hook 进程，仅使用审计目录合成 client.json；随机端口故障服务器返回 426。快照测试使用生产 gate-cache 模块和真实 hook，不用伪造快照读取逻辑。
- 编译：`node node_modules/typescript/bin/tsc -p tsconfig.json --outDir .local/full-audit-20261011/security/build`，退出 0。
- 复现：`node .local/full-audit-20261011/security/http-audit.mjs`、`node .local/full-audit-20261011/security/supplement-audit.mjs`、`node .local/full-audit-20261011/security/identity-audit.mjs`，均退出 0。
- JSON：`role-scope-matrix.json`（完整请求结果）、`role-scope-summary.json`（每路六模式状态/错误码）、`http-findings.json`、`supplement-findings.json`、`identity-findings.json`。这些文件均在上述 security 目录。
- 未运行 `npm test` 或 `service.test`。大套回归由主窗口另行运行，不在本专项重复。

## 发现

### S1 高：adapter 保存项目资料后产生全局正文泄露，来源身份也可伪填

代码：`src/server.ts:282`、`:295`；`src/store.ts:1496`；`src/material.ts:100`。

alpha adapter 请求 material/save，外层 projectId=alpha，summary/body 带专用私密标记，得到 200。保存构造忽略 projectId，scope 固定 global。beta adapter 随后使用自己的凭据及 projectId=beta 调用 knowledge/get 同 ID，得到 200，原样读到 `ALPHA PRIVATE BODY`；不是只泄露计数/标题。beta 保存同 URL/摘要又返回 duplicate=true 和 alpha 资料 ID；全局去重把两个项目生命周期合并。

alpha adapter 显式 provenance=user 被接受，beta 读回 content.provenance=user。这里仍是 kind=material，**没有证明资料变成 norm 或获得规范管理权**；准确缺陷是范围擅自扩大与来源身份伪填。用户问代码或保存临时页面时，可无意把含项目细节的原文公开给同库其他项目，随后检索还能混入他项目资料。

另外即使人工导入真正 project 范围的资料，material/list 也未过滤项目：alpha 看到 beta 的标题、URL、摘要、taskId。admin alpha 对 beta project 资料 material/renew 返回 200，确实推进 beta 到期时间。

证据：`http-findings.json` 的 materialSave/betaReadAlphaMaterial/betaSaveDuplicate；矩阵 material/list、material/renew。

### S2 高：历史与待结构化列表跨项目泄露完整证据、标题和叶子路径

代码：`src/server.ts:217`、`:241`、`:252`；`src/store.ts:1374`、`:1639`、`:1660`。

alpha adapter 使用自己的 projectId，history/recent 返回 beta 替代记录中的 `beta-PRIVATE-REASON` 与 `beta-PRIVATE-EVIDENCE`。knowledge/history(knowledgeId=beta-flow) 返回 beta 标题、所有版本时间与同一证据链。knowledge/unstructured 返回 beta skill 标题和 `beta-PRIVATE-LEAF.md`。这些实际字段与泛化“元数据风险”不同，其中 reason/evidence 可以承载任务细节或来源摘录。

history 本轮没有返回 retired body，不能声称历史接口直接泄露旧正文。普通 get/read(beta-memory) 在相同测试中均为 404，说明泄露来自专用入口遗漏 scope，不是所有读接口都有问题。

证据：矩阵 history/recent、knowledge/history、knowledge/unstructured 的 adapterOwn/adminOwn 响应。

### S3 高：项目管理员可以单项批准、拒收、归档和续期他项目对象

代码：`src/server.ts:156`–`:183`；`src/store.ts:742`、`:788`、`:805`、`:876`、`:1515`。

alpha admin 的 envelope 项目通过后，单个 approve/reject/request-evidence/archive 只把对象 ID 传入 Store。对 beta 提案四项动作全部返回 200，并在 beta 队列中改变状态。普通 approve 使用 entry.scope.projectId=beta，也能成功，因为校验的是提案与条目相互匹配，而非调用方项目。batch 同场景 HTTP 200 但 failed 内明确 scope_denied、applied=[]，是真实有效隔离，**不是批量越权成功**。

更窄反例：beta 项目提案 + alpha admin + 已存在 global 条目，entry.baseRevision=1、未传 allowGlobalScope，approve 200；全局正文变为 `BETA APPROVED BY ALPHA`，beta 提案变 approved。wasGlobal 分支仅证明条目过去全局，不补调用方对 beta 提案的权限。

管理写入 knowledge/write 的 envelope alpha+entry beta 也为 200，这是前轮已发现问题，本轮复验；不重复计为新的 adapter 管理提权。备份 export/import 是代码明确声明的整库管理员迁移能力，本报告不把其全库语义等同越权。

证据：矩阵四项单审阅、batch、material/renew、knowledge/write；`supplement-findings.json` 的 foreignGlobalApprove/foreignGlobalHead/foreignProposalState。

### S4 高：事件外层项目正确也可污染他项目任务导出

代码：`src/schema.ts:223`；`src/server.ts:151`；`src/store.ts:683`、`:1059`、`:1143`。

alpha adapter 提交 events(projectId=alpha,taskId=beta-task,adapter=dsh,summary=ALPHA-POLLUTES-BETA) 得到 200。Store 不验证 taskId 归属，beta 的任务 export JSON events 真实出现该 alpha 标记。生成日记也按 taskId 而非 projectId 筛事件，容易把他项目伪事件计为本任务观测。

直接 tasks/record(beta-task) 403，export/handoff/journal(beta-task) 404，任务主体隔离有效，但相关事件是一条绕过路径。proposal 接口 taskId 同样可绑定他项目 ID，但本轮只证实接收，未证明该提案字段后续污染 beta 日记，因此不扩大结论。

证据：`supplement-findings.json` 的 crossTaskEvent/betaExportAfterCrossEvent；`http-findings.json` 的 crossProposal。

### S5 高：无项目身份的共享 gate 快照造成跨项目误阻断与放行，故障语义偏离正式规划

代码：两端 gate-cache.mjs:41、:49、:72、:98、:112；DSH index.mjs:283、:315；Codex hook.mjs:323、:435。

快照只有 deniedTools/revision/at，路径是 dataDir/gate-snapshot.json，既没有 projectId、核心身份，也没有依赖条目版本或平台身份。真实 Codex 测试：alpha 快照禁止 write；以 beta 项目配置调用 PreToolUse，在 426 故障时 beta 被 alpha 禁止表阻断。随后 beta 写入空禁止表覆盖同一快照；切回 alpha，426 时 write 输出为空、退出 0，实际不阻断。问题可在共享数据目录下两个项目轮换出现，不需要改真实快照。

正式 §3.4 明确“快照不是执行旧规范的授权；需最新规范且能够拦截的操作暂停”，§5.3 不自动回退旧规范执行。实现却以旧快照未列出的工具为 allow，30 天内继承旧禁止表，超过 30 天则 Ungoverned 让所有工具继续；没有操作是否需要最新规范的区分。测试中保存 31 天的 write 禁止快照后，真实 Codex write 同样空 stdout 放行。426/认证失败/无效 gate 响应也进入与网络失联相同回退，协议不兼容时虽核心拒写，宿主工具治理仍被释放。

未来时间与负 revision 快照也被 loadSnapshot 认为 usable；时间可向未来推进一年且没有上界。这是辅助健壮性缺陷，不宣称攻击者越过了文件权限。

可观测性：Codex degraded allow 只写日志，stdout/stderr 均空，宿主用户没有即时模式说明；DSH 仅 console.warn/log 一次。不能将只写本地日志等同“运行状态已向用户明确显示”。

证据：`http-findings.json` 的 snapshotStored/betaLoadsAlpha/alphaLoadsBeta/expired/futureSnapshot；`supplement-findings.json` 的 codexBetaUsesAlphaSnapshot/codexAlphaUsesBetaSnapshot/codexExpiredAllowsFormerlyDenied。

### S6 高，旧问题复验：过期权威过滤依赖清理成功，清理后正文仍保留

代码：`src/store.ts:456`、`:503`、`:1479`；`src/server.ts:144`；`src/backup.ts`、`src/archive.ts`。

注入时钟与合法过期资料后，仅让 purgeExpiredMaterial 返回合成清理失败，HTTP knowledge/get=200，search-universal=200，结果 rawContent/excerpt 含 `EXPIRED PRIVATE BODY`；material/list 则为空。证明正式 §8 第一道“每次默认检索按权威到期排除”没有贯穿通用读接口，而不仅是绕过请求前 cleanup。

恢复实际 purge 后返回 purged=['expired']；直接读 revisions.content 仍含正文与摘要。exportArchive→importArchive 的隔离恢复后 revisions 继续保留这些标记。复验与前轮一致；没有声称 history HTTP 返回正文。

31 天后 raw events 删除成功、pending proposal 变 expired 且 payload 清空；这些保留行为有效，不应被资料清理缺陷掩盖。

证据：`supplement-findings.json` 的 expiredGenericGet/expiredGenericSearch/expiredMaterialList/expiredPurge/expiredRetainedRows/restoredExpiredRaw/proposalRetention/eventRetention。

### S7 中：提案基线与审批条目基线脱钩，没有显式重新比较轨迹

代码：`src/store.ts:742`–`:775`，尤其 payload 类型仅取 projectId/workflowId，不读 baseRevision。

两个提案都在 alpha-flow@1 提交。先批准 A 后条目@2；再把 B 的审批 entry.baseRevision 改为 2，不改变 B 的原提案 baseRevision=1，即可 approve=200。B 被标 approved，未出现冲突/重新比较记录。entry CAS 本身真实有效：两个 entry 都 baseRevision=3 同时 Promise.all 批准，结果恰为 [200,409]，失败内容仍在候选中。

因此结论是提案审核追溯缺口，不是 SQLite 丢更新，也不把有管理权用户主动重编辑新 entry 说成 adapter 无声覆盖。正式 §6.4 要求旧提案重新比较/审核并保留内容；需有可查询的重新比较/基线更新记录。

证据：`supplement-findings.json` 的 firstApprove/staleApproveCurrentEntryBaseline/staleProposalState/concurrentSameBase。

### S8 中：独立凭据但重名 client.id 造成跨项目幂等冲突

代码：`src/config.ts:29`；`src/server.ts:91`、`:133`、`:150`、`:151`；`src/store.ts:668`、`:685`。

核心只要求 token 唯一，不要求 id 唯一。两个 dsh 凭据分别绑定 alpha/beta 都可启动，且通过自身项目检查。alpha 提交 same-key 与 same-event 成功，beta 用相同幂等键提交自己的内容均 409，因为数据库唯一键是 (principal.id,idem/event_id)，不含 project 或可信凭据身份。

这是跨项目可用性/去重身份碰撞；不同项目 payload 指纹不同，未观察到 beta 直接得到 alpha 正文。正常生成 UUID 事件降低偶遇概率，但多项目固定重试键或独立客户端可稳定触发，配置没有阻止这种合法形状。

证据：`identity-findings.json`。

### S9 中：ensure-core 健康探测把任意 200 当核心，且跟随 GET 重定向

代码：两端 ensure-core.mjs:42–:45；`src/service.ts:173`。

随机回环伪服务 /health 返回普通文字 `not a core`，coreIsRunning=true；307 重定向到另一个随机回环 sink，同样 true、sinkHits=1。该结果让 ensureCoreRunning 返回 already-running，跳过启动，后续治理请求才失败。健康探测没有验证协议、核心身份或响应结构。

没有测试或攻击外部站点；结果只证明健康 GET 的重定向出站能力和假阳性，不证明带凭据 POST 的 SSRF/泄密。CoreClient 与 DSH createClient 带凭据 POST 307 都抛错误、sinkHits=0，正确阻断。Codex POST 源码同样 redirect=error；真实 hook 故障覆盖是 426，不冒充它的重定向动态证明。

证据：`http-findings.json` 的 coreRedirect/dshRedirect/healthRedirect；`supplement-findings.json` 的 healthAcceptsNonCore。

### S10 中：鉴权失败没有核心审计记录，日志脱敏不是任意敏感正文过滤

代码：`src/server.ts:393`；`src/log.ts:54`；两端 adapter log.mjs:29；Codex hook.mjs:369–:371。

server 接口鉴权、范围、角色、protocol 拒绝只回 HTTP JSON，没有 logger 调用；当前接口日志没有形成验收 §12.18 所要求的权限检查记录。不能以 adapter 会记录某些自身故障替代服务器对任意未配对调用的审计。

合成日志验证 token 字段和 Bearer 值有效脱敏，但自由字段中的裸秘密标记、URL 查询 api_key 值保留；这是脱敏覆盖边界，不声明真实密钥已泄露。真实 Codex malformed JSON 日志保存 V8 SyntaxError 的原始输入片段（SYNTHETIC- 前缀）；日志仅字节轮转，无年龄保留/来源期限。开发诊断或含 URL 的自由错误字符串仍可能长期保留来源内容。正式 §8 要求调试日志纳入清理设计。

证据：`http-findings.json` logs；`supplement-findings.json` codexMalformedLog。

## 全 API 角色与范围表

六模式：AO=alpha adapter/本项目；MO=alpha admin/本项目；AF=alpha adapter/外层 alpha + beta 对象；MF=alpha admin/外层 alpha + beta 对象；AE/ME=对应角色但外层 projectId=beta。无对象入口 AF/MF 仍是 alpha 项目请求，不代表实际可查询 beta。所有 AE/ME 都 403 scope_denied。

期望分组：R=两角色可读但仅本项目及明示全局；W=两角色采集但所有关联对象须本项目、来源由可信身份决定；M=adapter 403、管理员仅其项目；G=整库/运行全局管理语义明确，adapter 应受管理门禁。表内“批量200+failed”表示没有应用，不能按200认作成功。events 的 MO/MF 使用 adapter=dsh，与 admin 身份不一致所以403；这不是管理角色本身禁止事件。

| API（均 /v1/） | 期望 | AO | MO | AF | MF | AE | ME | 真实 scope 结果 |
|---|---|---:|---:|---:|---:|---:|---:|---|
| prepare | R | 200 | 200 | 200 | 200 | 403 | 403 | 本项目规范；任务/平台缺口由主报告覆盖 |
| search | R | 200 | 200 | 200 | 200 | 403 | 403 | 本项目流程 |
| expand | R | 200 | 200 | 404 | 404 | 403 | 403 | 有效隔离 |
| gate | R | 200 | 200 | 200 | 200 | 403 | 403 | 本项目门禁；任务缺口另审 |
| proposals | W | 200 | 200 | 404 | 404 | 403 | 403 | workflow目标隔离；taskId关联未校验 |
| events | W | 200 | 403 | 200 | 403 | 403 | 403 | taskId跨项目污染，S4 |
| proposals/list | M | 403 | 200 | 403 | 200 | 403 | 403 | 列表隔离有效，无对象参数 |
| proposals/approve | M | 403 | 200 | 403 | 200 | 403 | 403 | 单项跨项目，S3 |
| proposals/reject | M | 403 | 200 | 403 | 200 | 403 | 403 | 单项跨项目，S3 |
| proposals/request-evidence | M | 403 | 200 | 403 | 200 | 403 | 403 | 单项跨项目，S3 |
| proposals/archive | M | 403 | 200 | 403 | 200 | 403 | 403 | 单项跨项目，S3 |
| proposals/batch | M | 403 | 200 | 403 | 200 | 403 | 403 | MF applied空、failed范围错误，隔离有效 |
| norms | R | 200 | 200 | 200 | 200 | 403 | 403 | 列表隔离有效，无对象参数 |
| preferences | R | 200 | 200 | 200 | 200 | 403 | 403 | 列表隔离有效，无对象参数 |
| capabilities | R/G | 200 | 200 | 200 | 200 | 403 | 403 | 全局安装路径/能力信息，不是项目正文 |
| history/recent | R | 200 | 200 | 200 | 200 | 403 | 403 | 全库reason/evidence泄露，S2 |
| knowledge/read | R | 200 | 200 | 404 | 404 | 403 | 403 | 项目知识有效隔离 |
| stats | R/G | 200 | 200 | 200 | 200 | 403 | 403 | 全库数量/全局版本；无正文，本轮非高影响漏洞 |
| rescan/state | G | 200 | 200 | 200 | 200 | 403 | 403 | 全局扫描状态 |
| rescan/interval | G | 403 | 200 | 403 | 200 | 403 | 403 | 管理门禁有效、全局动作 |
| rescan/mark | G | 403 | 200 | 403 | 200 | 403 | 403 | 管理门禁有效、全局动作 |
| knowledge/supersede | M | 403 | 200 | 403 | 404 | 403 | 403 | 有效隔离；inactive新目标旧问题另审 |
| knowledge/history | R | 200 | 200 | 200 | 200 | 403 | 403 | 他项目标题/证据链，S2 |
| knowledge/structure | M | 403 | 200 | 403 | 404 | 403 | 403 | 有效隔离 |
| knowledge/unstructured | R | 200 | 200 | 200 | 200 | 403 | 403 | 他项目标题/叶子路径，S2 |
| knowledge/search-universal | R | 200 | 200 | 200 | 200 | 403 | 403 | 项目过滤有效；global资料与到期过滤缺陷S1/S6 |
| knowledge/get | R | 200 | 200 | 404 | 404 | 403 | 403 | 项目过滤有效；global资料与到期缺陷S1/S6 |
| knowledge/write | M | 403 | 200 | 403 | 200 | 403 | 403 | entry.scope跨项目，旧问题复验 |
| knowledge/delete | M | 403 | 200 | 403 | 404 | 403 | 403 | 有效隔离 |
| material/save | W | 200 | 200 | 200 | 200 | 403 | 403 | 固定global、来源可填、task关联可填，S1 |
| material/list | R | 200 | 200 | 200 | 200 | 403 | 403 | project资料也泄露，S1 |
| material/renew | M | 403 | 200 | 403 | 200 | 403 | 403 | 可续期他项目，S3 |
| material/purge | G | 403 | 200 | 403 | 200 | 403 | 403 | 全库到期清理、S6正文未清 |
| tasks/start | W | 200 | 200 | 200 | 200 | 403 | 403 | 新会话名字beta不等于beta任务；外层项目生效 |
| tasks/journal | M | 403 | 200 | 403 | 404 | 403 | 403 | 任务主体隔离有效；事件污染S4 |
| tasks/export | R | 200 | 200 | 404 | 404 | 403 | 403 | 任务主体隔离有效；事件污染S4 |
| tasks/record | W | 200 | 200 | 403 | 403 | 403 | 403 | 有效隔离 |
| tasks/list | R | 200 | 200 | 200 | 200 | 403 | 403 | 列表隔离有效，无对象参数 |
| tasks/handoff | R | 200 | 200 | 404 | 404 | 403 | 403 | 有效隔离 |
| backup/export | G | 403 | 200 | 403 | 200 | 403 | 403 | 明示整库管理员能力；dryRun仍组包 |
| backup/inspect | R/G | 200 | 200 | 200 | 200 | 403 | 403 | 任意文件路径的归档元数据，不返回正文；有解压上限 |
| backup/import | G | 403 | 200 | 403 | 200 | 403 | 403 | 明示整库管理员能力；恢复保留S6 |

## 网络、输入上限与并发验收边界

| 检验 | 预期 | 观察 | 判定 |
|---|---|---|---|
| 无配对/错误凭据 | 401 | 401 | 有效 |
| project envelope不匹配 | 403 | 所有42路，两角色均403 | 有效 |
| adapter identity不匹配 | 403 | 403 | 有效 |
| 外站Origin、Origin null | 403 | 均403 | 有效 |
| 原始Host=example.invalid | 403 | node:http得到403 host_denied | 有效 |
| 协议2 | 426且不写 | 426 | 核心有效；hook回退问题S5 |
| 请求体超过65536字节 | 413 | 70000字节请求413 | 有效 |
| query超过4000字符 | 400 | 400 invalid_request | 有效 |
| CoreClient 非回环/HTTPS/URL凭据/额外path | 拒配置 | 全部schema失败 | 有效 |
| 带凭据POST 307 | 不跟随 | CoreClient/DSH sinkHits=0 | 有效 |
| 健康GET 307/非核心200 | 不误认核心 | 跟随且true | S9 |
| 同基线同时审批 | 一个成功，另一保留冲突 | [200,409] | entry CAS有效 |
| 重名client独立项目幂等键 | 不跨项目干扰 | 后项目409 | S8 |
| raw events超过30天 | 清理 | 0行 | 有效 |
| pending超过30天 | 退出候选、正文清理 | expired、payload空 | 有效 |

Host 初次使用 fetch 自填 host 得到200，是 Node fetch 忽略自定义 Host 的客户端行为；已用原始请求复核403，不记录虚假绕过。HTTP server 有 requestTimeout=10秒/headerTimeout=5秒；没有高压慢连接或大规模压缩包测试，不宣称资源耗尽全面验证。归档解压 maxOutputLength=256MiB、文件路径安全检查与链接禁止存在；压缩输入 readFileSync 缺独立压缩文件上限、同步全库操作潜在阻塞只作为剩余资源边界，本轮不伪造高影响复现。

凭据文件初始化使用mode=0600；Windows文件ACL、撤销配对全流程和并发启动锁窗口未动态验证，本轮不声称系统保护机制完全验收。ensure-core spawn使用detached/ignore/windowsHide，未启动真实服务，未重试或停止共享进程。核心错误回复不回异常正文，已验证协议/鉴权输入不泄露随机凭据。

## 对用户代码答疑和 agent 工作的具体影响

项目甲的临时页面/代码片段被静默保存为全局，可被项目乙知识查询读出；历史检索与待结构化技能目录还会引入不属于当前项目的标题、叶子路径和实践证据。事件关联跨项目会让续接和导出包含错误任务事实。共享快照会在核心故障时误阻断本来允许的工具，或放行仍受当前项目禁止的操作；协议错误也退回同一路径。幂等身份碰撞使另项目提交稳定失败。它们会产生答非所问、错误归因、工具执行失控或锁住工作，而不是只有后台数据卫生问题。

修复优先级：以可信principal/project对每一对象与关联对象校验；资料保存默认项目范围、来源由身份赋予；单项审批复用batch对象权限检查；快照键绑定核心/项目/平台且不作为新操作许可；到期过滤放到所有读取入口并实际清正文；提交身份/幂等使用可信唯一客户端而非可重名平台枚举；区分网络失联、协议/鉴权/响应合同错误；补权限拒绝审计及日志内容期限。

收尾：本轮产物是缺陷证据与未验证边界，不是已经修复并反复实践的可复用技能，因此不向共享正式知识库写入经验；不改业务源码以制造审计通过。
