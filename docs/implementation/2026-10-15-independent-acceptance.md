# 独立验收、冻结留出与原设计清单

本轮验收时间：2026-10-15，Asia/Shanghai。此文件持续记录事实，不将实现、合成测量、隔离集成和真实宿主证据互相替代。原始要求以 `docs/plans/2026-10-09-joint-plan-final.md` §12 的20项为准。

## 冻结方案

新合成留出 `test/fixtures/retrieval-acceptance-v2.json`，14篇新文档、30条查询；不复用旧18例。SHA256：`a118cfca4a2d3cec0d3940db55984812b4f1342497b8a60b56636067f752734b`。标签在任何新测量前写定；失败不改标签或降低门槛。实现代理未收到标签。若结果用于后续调参，本集合之后必须降为诊断集。

本轮预登记门槛：precision≥0.90、recall≥0.85、负例有效拒召回≥0.95、超时率≤0.05、端到端p95≤4500ms。它们是本轮验收建议，不冒称用户已批准的原始产品数值标准。对原计划的权限、范围、历史隔离等确定性边界仍按零违规。

样本包括正例、同义改写、否定、多目标、版本不符、普通确认、精确ID及错误revision、错误签名、长日记与无关主题。全空会造成20个相关条目的漏召回，因此不能作弊过门槛。模型故障的空输出不计正确语义拒召回；无模型配置而HTTP实际执行确定性检索的负例可按真实结果计。

脚本 `test/retrieval-acceptance-v2.eval.mjs`，默认不联网；`--live`才用已有模型配置，默认模型未切换。`--route prepare`与`--route search`是隔离Windows核心HTTP入口；默认service仅组件测量。所有写入仅临时SQLite，真实知识库只读。精度报告分清组件与HTTP；没有provider的旧service全空不能推导旧产品全空，因为旧HTTP在not_configured会回落Store词法。

## 当前真实运行基线

- 原Codex MCP连接实际发现15项AMB工具，包含checkpoint/activity；self-check全部通过，读取知识版本14。prepare命中当前AMB任务日记，并已调用read取得正文，内容明确全设计验收尚未完成。
- 只读现行库：149草稿，71带digest，68 needs_evidence、2 awaiting_model、2 ready_for_review、77 pending；维护作业94 completed、78 pending、1 running。作业completed数不是成功归纳数。
- 当前core PID24696，2026-10-15T10:41:23Z启动；3条active journal、29个scanRoots。两端磁盘对昨末产物 `artifacts/p0-20261014153549972` dry-run差异为空。
- DSH最新adapter.load是2026-10-15T10:45:36.675Z，Node24.18.1。这证明用户后来重载过当时磁盘模块；不能声称本轮新源码已加载。
- DSH自然业务auto_recall有2026-10-14T14:51:19.601Z，readIds两项；自然journal.persisted有15:29:04.497Z、15:29:48.350Z，revision9/10，outcome=unverified。当前load之后尚未观察到新的自然检索/日记，不推断其不存在。
- Codex自然journal.persisted新增2026-10-15T10:42:21.818Z、revision14、outcome=unverified，另有昨15:39:40.368Z、revision13。因此自然Stop写日记已有实机证据，不代表任务完成或经验已采纳。
- 上述读取未重启DSH、未操作用户GUI、未部署或改真实数据库。

## 原20项覆盖与仍缺事项

“已有隔离机制证据”指源码和既有Windows测试覆盖，待本轮统一回归确认；不是本轮已经再跑通过。涉及权限/时钟/CAS/恢复的机制可用安装产物与隔离核心集成证明，无须污染生产库。两端真实自动触发、真正使用知识和自然写回仍须宿主证据。

|原项|已有证据路径|当前验收边界与缺口|
|---|---|---|
|1 新规范替代旧规范、两端后续受控调用|protocol.test.ts、store.test.ts、历史gate报告|隔离机制已覆盖；最新产物回归待执行。真实两端新规范受控调用未新增证明|
|2 一次指令限任务范围|gate、schema及scope相关测试|可隔离证明范围；不可冒称真实任务已采用|
|3 网页命令只作资料|material.test.ts、material-capture.test.mjs、权限测试|隔离机制已有；DSH最新load后自然网页采集尚缺|
|4 无证据测试声明保持自述|workflow-draft.test.ts、model-review.test.ts|已有隔离覆盖；不把模型输出当核验结果|
|5 双端同版本提案冲突|store.test.ts same-base/CAS、protocol.test.ts|可隔离完成机制验收；不必造生产冲突|
|6 优先合并/修订已有经验|duplicate-candidate.test.ts、model-review.test.ts、organization本轮|重复候选幂等已覆盖；语义归属/可采纳完整流程仍待组织代理及验收|
|7 技术栈变化补检索及理由|adapter-recall.test.mjs、retrieval-service测试|自然DSH曾task/failure补检索；本轮检索质量留出待完成，不能以readIds证明相关性|
|8 默认排除历史、历史可查|store.test.ts retired、history、protocol工具测试|已有隔离覆盖；新index/缓存必须复核|
|9 过期即不可召回、清理恢复|material.test.ts、archive/backup相关测试|可时钟模拟隔离验收，无须删除真实资料|
|10 晋升证据生命周期独立|material/backup/review相关路径|需核对完整引用/晋升测试断言，暂不凭组件存在认定完成|
|11 Stop等非完成、跨会话同任务|core-memory-loop.test.ts、task测试、真实两端自然journal|自然两端写回已有证据，outcome unverified；取消暂停失败机制由隔离测试证明|
|12 两端目标约束进度文件恢复|task-checkout-difference.test.ts、task及handoff测试|隔离机制可复用；真实跨端带完整字段恢复仍缺演示|
|13 模型中断确定性可用、审核待处理|retrieval-index/service本轮、model-review.test.ts|旧线上自动入口故障全空不满足；新index已实现待独立质量/安装验收|
|14 崩溃恢复、重试幂等、失效不复活|jobs.test.ts、r2-data-layer.test.ts、store.test.ts|已有重开SQLite/租约/幂等隔离证据；新index非持久embedding，需缓存失效覆盖|
|15 协议不兼容拒写可见|protocol.test.ts、doctor、自检|已有HTTP隔离覆盖；当前安装产物统一集成待执行|
|16 checkout差异展示|task-checkout-difference.test.ts|已有隔离测试，未提供接收摘要时明确unknown；真实跨checkout宿主演示未新增|
|17 24h模型中断队列恢复|jobs.test.ts、maintenance.test.ts、r2-data-layer.test.ts|租约/失败退避已有；明确24h时钟跨期限及不自动生效联合用例仍待核实或补齐|
|18 伪称用户/未配对拒管理权审计|security-review.test.ts、protocol.test.ts|已有隔离覆盖；无需真实越权写库|
|19 旧经验依赖与缓存失效|store.test.ts依赖revision、workflow-source-integrity、retrieval-index/service|已有流程失效覆盖；本轮index新鲜性测试与产物回归待执行|
|20 表外不自动晋升、截止时间有界|store.test.ts fake clock、maintenance、review lifecycle|表外自动批准未开启；待审不冒称采纳，期限/重试机制由隔离验收|

P3自动白名单没有经过质量批准，维持禁用，不为完成度批准真实经验。当前无embedding向量索引；本地用途索引与模型归纳必须按真实能力描述。

## 测量结果

原始含逐例标签的结果保留在私有 `.local/retrieval-v2-*.json`；公共报告只发布汇总。当前首次组件基线（旧安装实际provider）TP20/FP3/FN0，precision0.870、recall1.000、负例有效拒召回8/11、timeout0、p50 1517ms、p95 2090ms；未达预登记门槛。此为service组件，HTTP主比较另记，不能作为完整端到端结论。

无provider旧HTTP prepare初测TP12/FP10/FN8，precision0.545、recall0.600；旧显式search TP20/FP73/FN0，precision0.215、recall1.000。初版脚本负例一律排除fallback，故这两个初测文件的negativeRejection无效，必须按修正脚本复测或从逐例结果按not_configured确定性回落重算。新源码组件无provider TP2/FP0/FN18，precision1.000、recall0.100，不能因无误召宣称质量通过。

### HTTP首查最终比较

同一合成v2、同一现有provider配置、每条首次查询，无mock替代实际模型。配置与源码指纹在私有证据中另存。

|入口/配置|TP/FP/FN|precision|recall|负例有效拒召回|超时|p50/p95 ms|
|---|---|---|---|---|---|---|
|旧安装prepare，实际模型|20/3/0|.870|1.000|8/11|0|1550/1980|
|新源码prepare，实际模型|18/2/2|.900|.900|9/11|0|1493/1865|
|旧安装prepare，无模型|12/10/8|.545|.600|7/11|0|15/17|
|新源码prepare，无模型|2/0/18|1.000|.100|11/11|0|15/23|
|旧安装显式search，无模型|20/73/0|.215|1.000|3/11|0|15/17|
|新源码显式search，无模型|2/0/18|1.000|.100|11/11|0|15/20|

以上新旧均未过全部门槛。实际模型中新增否定/意图误召及同义/多目标漏召已给实现代理聚合类别；从此v2改为诊断集，后续不能称全新盲测。无模型新索引召回退化严重，拒绝以P1掩盖R.1。新一轮门禁增加“无模型HTTP召回不得低于旧HTTP baseline”，不倒改v2原成绩。

### 首查、缓存与故障延迟

独立小样3条合成查询，每条prepare首查后3次显式search，共12请求；查询、结果与计数在私有 `.local/retrieval-v2-latency.json`。此样本小，不外推生产p95。

|provider条件|首查p50/p95 ms|后续search p95 ms|首查调用模型比例|后续额外provider调用|合计provider调用/请求|
|---|---|---|---|---|---|
|实际既有provider|1446/1565|1726|3/3|2|5/12|
|mock HTTP503|30/32|16|3/3|0|3/12|
|mock悬挂触发4秒超时|4024/4032|16|3/3|0|3/12|

每次search返回ID与对应prepare相同；但实际provider后续2次再次调用，不能统称缓存命中。prepare入队workflow草稿改变indexStamp可能导致失效，是待定位推断。超时模式仍阻塞约4秒，本地可用性改善不等于故障等待消失。mock只是失败与缓存机制验证，不提供模型质量证据。

### 下一批新留出

v3已冻结为13篇全新文档、14例，hash `70d237c75c94840364e3a302c6858dad9c59021a579e2d4cb0904de50bdca894`；冻结时尚未运行。实现代理不可读标签。小样主要覆盖正负意图、版本、同义、多目标、签名、长日记、ID与错误revision。脚本加 `--v3`，先比无模型旧HTTP基线再运行稳定新实现；模型不扩比较。

### 第二次冻结版本及v3首次结果：不批准部署

检索第二版冻结hash：retrieval-index `efdf1fa7e59e05223a5af485cd43726b0ec4edba6fc171c6354de2cdb9045805`；retrieval-service `7c24a38a15f61f517fe12b7418ded0e347c7ae323a7466aa5ef3bb841a3d4a6e`；semantic-retrieval `2d1c14b252c695887f97c5d236e187a5a98534eb0037f1946e23615a76ccf176`；server `daa4204e141a6550ef807bdaf60aa0399b7c5cf2ed7f789ea0bfeea6ae917ec4`。其他组织线及配置指纹见私有 `.local/retrieval-v3-code-config-receipt.json`。实际模型仍gemini-3.5-flash-lite，配置timeout45000ms，检索有效上限4000ms。

|v3 HTTP prepare|TP/FP/FN|precision|recall|负例有效拒召回|超时|p50/p95 ms|
|---|---|---|---|---|---|---|
|旧安装无provider|7/4/2|.636|.778|4/6|0|15/24|
|第二版新源码无provider|5/0/4|1.000|.556|6/6|0|13/23|
|第二版新源码实际provider|9/1/0|.900|1.000|5/6|0|1471/2978|

新实际provider负例未达.95，新无provider召回低于旧.778，**两个门禁均失败，不部署**。没有在v3标签上再调参，仍保留首次结果；若后续反馈标签/类别用于修复，应另建新留出。

v2此时仅离线诊断：第二版TP8/FP0/FN12，P1/R.4、负例11/11，p50 15/p95 18ms；相比首版R.1有提升，仍低于旧HTTP R.6。没有再次执行v2的30例实际provider。

第二版改为当前有效digest内容hash驱动缓存，pending入队/流程状态变化不应再清缓存，相关定向测试由实现者通过。上表缓存/故障测量属于第一版，不能冒称第二版已实测同样性能；本轮未追加重复provider测量。首查超时预算仍4秒。

组织线22项定向通过、兼容备份及两阶段迁移说明见 `2026-10-15-skill-organization-delivery.md`；其旧web-ui失败已由检索负责人修复norm专用search，后续build及web-ui/service 13项通过（实现者回执）。本验收未执行全量、未打包、未部署。组织线若独立上线需从旧安装基线重新构建只含组织变更的产物，逐文件明确server/UI/backup交叉依赖，不能直接打当前全树包绕过检索门禁；还需单独全量与备份迁移验证，存在新digest job旧worker回滚不识别的风险。
