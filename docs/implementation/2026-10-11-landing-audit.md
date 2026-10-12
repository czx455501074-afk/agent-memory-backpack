# 项目真实落地审计

日期：2026-10-11，Asia/Shanghai。
项目：Agent Memory Backpack，D:/huange-skill。
受检提交：c4a0ef7844760034c0b2ec206d90ba7b75c470bc。

## 结论

**部分落地：共享知识核心与适配器已有可运行实现，但尚未形成设计承诺的完整自动闭环，当前存在可复现的用户操作阻断和状态/保留策略缺陷。**

不认可追溯矩阵的“本轮已全面闭环”“未实现归零”作为验收结论。模块存在、模块单测通过、生产链路调用、安装包一致、真实双端验收是五种不同证据。

## 本轮验证范围与结果

- 环境：Node 24.19.0、npm 11.17.0；审计前 git 工作区干净。
- 实际执行 npm test：280 测试，279 通过，0 失败，1 跳过；跳过的是未设置 AMB_ARTIFACT_DIR 的打包冒烟。
- 对最新包单独执行打包冒烟：1 通过，0 失败，0 跳过。此包并非当前源码快照，不将两次结果描述成同一份当前源码的完整验收。
- 当前会话 amb_self_check：通过，Managed、知识版本 2。只能证明本次连接和自检，不证明全部桌面场景。
- 用内存 SQLite、随机监听端口的隔离 HTTP 核心，以及执行完整 UI_JS 的 VM/DOM 桩复现主要缺陷；没有用 DOM 桩冒充真实浏览器截图。
- 未读取真实凭据内容、未修业务源码、未重部署、未停止共享核心。测试会重建 dist，并按测试自身逻辑运行临时夹具。
- 完整测试包含 Windows Run 注册表测试；发现其恢复逻辑有缺陷后，额外只读查询 AgentMemoryBackpackCore，最终 registered=false。审计没有预先保存该值，不能证明运行前是否存在或恢复旧值。

## 关键发现

### 1. 高：网页首次加载即项目认证失败，保存与批准另有字段合同错误

代码：src/ui.ts:33、167、197、656、717；src/schema.ts:44。

HTML 的 t-project 初始文本是“—”；getProject() 将非空的“—”作为 projectId。renderStatus() 在读取到真实项目之前向 stats/rescan/material 发请求，三条均返回 403。完整前端脚本 VM 隔离执行实际观察到 projectIds=[“—”,“—”,“—”]，页面连接状态失败。

网页保存与批准构造 evidence='verified'，后端仅接受 observed/verifiable/self-reported/unverifiable。隔离发送网页实际字段，返回 HTTP 400 invalid_request。现有 web-ui 测试主要验证 HTTP 接口，测试手动写入使用 verifiable，没有覆盖网页点击生成的 payload。

影响：当前网页不是“完整可操作管理界面”；修复启动项目身份后，保存/批准仍会失败。批准入口还将所有候选硬转为新 memory，未提供目标流程修订路径。

### 2. 高：任务/平台适用性只进入数据模型，未贯穿执行链

代码：src/store.ts:20、328、539、548、611；src/server.ts:146、149。

prepare 接收 taskId，却调用 norms(projectId)，其 applicable 没传 taskId；gate 同样不取 taskId。隔离导入任务范围 norm（deniedTools=['probe']）后，显式传 taskId 的 prepare 没有该规范，gate 返回 allow。

platforms=['codex'] 的规范也进入不区分适配端的 prepare。类型字段存在不等于任务/平台过滤已实现。追溯矩阵 H2 的完成标记不足。

### 3. 高：过期清理仅退役，不清正文/摘要，备份继续携带

代码：src/store.ts:456、503、1479、320；src/backup.ts:13、84、198。

到期但清理尚未执行时，专用 liveMaterial 返回空，searchUniversal/getKnowledge 仍读到正文。purgeExpiredMaterial 报 purged 成功后仅 retire：更新状态、删 FTS，不删除 revisions.content。

主窗口隔离读回 revisions，正文与摘要标记均仍存在。独立审计也验证清理前后导出备份均包含正文，importAll 提交时没有到期清理。

准确边界：history API 返回身份、版本时间与替代链，不直接返回正文；正文残留通过 revisions/备份确认，不把 history 元数据回执说成正文接口。

影响：90 天生命周期未完成。E4/H9 的完成标记高估；E7 的“恢复后即检查”不适用于该导入入口。

### 4. 高：普通 prepare 静默重开终态；自动事件未关联任务日记

代码：src/store.ts:539、1033、1037、950、959、683、1061；adapters/dsh/index.mjs:623；adapters/codex/scripts/hook.mjs:344。

同一项目/session 派生固定 task ID。任务甲 completed、verified='test passed' 后，仅 prepare 任务乙，就把原任务改回 in_progress，复用原 ID/标题/旧 verified，并清空 completedAt。主窗口已隔离复现。

适配器事件带 sessionId，不带 taskId；store.event 没补关联，而日记只按 taskId 查事件。独立复测 Stop 事件已入库，但日记仍为 0 事件。任务完成没有自动 writeJournal；网页跨端按钮仅展示交接信息，未把接收 session 绑定为继续该任务。

已实现自动开始登记，但不是开始→事件→终态→日记→跨端继续的闭环。矩阵 D9 的“尚未自动登记”也已滞后，应逐行为重判而非统一宣称完成。

### 5. 高：语义模块未接生产，分级审核仍为固定标签

代码：src/semantic.ts:37、65、92、196；src/store.ts:662、677、774。

classifyCandidate/calculateHybridScore 只有定义和单测，没有生产调用。所谓语义是正则与字符 bigram 余弦，没有模型网关、embedding 或模型失败审核队列。拆分建议是“规范要求部分”等占位，不是实际原文片段。

submit 固定 new-experience/agent/self-reported，候选都进入 review；approveProposal 不消费分类、关系或 review tier，直接导入审核条目。相同正文批准成两个新 ID，会两条并存，没有去重关系或流程步骤更新。

真正存在的是人工管理审批门禁、候选队列与独立策略函数，不是设计 §6 的智能分类→关联已有→变更方案→分级执行闭环。C1/C2/C5/C7、B2 的完成标记缺生产证据。

### 6. 高：已退役的替代目标仍可使用，回执成功但两条均失效

代码：src/store.ts:1603、1606、1621。

主窗口隔离复现：导入 old/new；retire(new,1)；supersede(old→new) 返回 success/historyPreserved，但 old/new 均 retired。新条目仅检查存在和同类型，未检查 active。事务原子性存在，业务生效条件仍错误。

### 7. 高：新增管理写入接口没有校验条目所属项目

代码：src/server.ts:261；src/store.ts:272。

身份校验仅检查请求 envelope.projectId。主窗口隔离创建仅绑定 p0 的 admin，请求 projectId=p0、entry.scope.projectId=p-other，knowledge/write 返回 200 并成功创建别项目条目。

这是项目范围合同缺口，不是 adapter 可自行批准；该接口仍要求 admin。其他接口的项目过滤有效，也不补足这个入口。

### 8. 中：测试绿灯、能力声明与当前部署证据未绑定

代码/数据：artifacts/latest.json、scripts/desktop-accept.mjs:153、src/capabilities.ts:60、95、test/service.test.ts:118。

最新包 p0-20261011052424237 的自身 artifactFiles 哈希全部匹配，打包冒烟通过，但 manifest.sourceFiles 与本轮构建后的 doctor.js/server.js/store.js/ui.js 四文件不一致；latest.desktopVerified=false。未重新打包/部署。

能力清单为源码设计能力常量，Codex 探测整个 .codex/plugins/cache 存在就报告已安装，没有确认本插件 manifest/启用/信任/实际加载。最新双端完整验收证据仍缺。

service.test.ts 直接改真实用户 Run 项，finally 在先前已注册时用虚构 C:/path/cli.js、C:/data“恢复”，并未保存旧命令。应先改成隔离或精确恢复后再跑完整测试。

## 已真实实现的能力

SQLite 单一权威库、版本历史、条目级 CAS、原子写入/回滚、候选幂等与状态生命周期、管理凭据门禁、批量审阅后端、采纳/重扫/撤销、中文 FTS、摘要与按需展开、结构化流程的依赖检查、备份迁移和可读导出、核心单实例/脱离终端启动代码。

这些不是空文档；流程依赖与历史隔离测试确有行为断言。常驻登录注册函数存在不代表真实登录全过程已验收；核心自检通过不代表产品自动整理闭环已完成。

## 修复与验收顺序

1. 修网页初始化项目身份、前后端 evidence 合同，补完整页面启动与点击写入回归。
2. 将 taskId/session 关联与 adapter/platform 贯穿 prepare/search/expand/gate；禁止普通检索重开终态，补任务切换/日记事件关联。
3. 修到期所有读取入口、历史正文清理与备份/恢复策略；验收直接检查数据库及归档正文，不只检查列表消失。
4. 修替代目标 active 校验与管理写入项目校验，补反例测试。
5. 将分类/关系/审核策略接入生产，缺模型时准确标降级；审批修改原提案基线时保留显式重新比较记录。
6. 修测试真实 Run 项恢复，再重新打包，绑定提交/源码哈希/部署包/运行版本，完成 DSH 与 Codex 当前包端到端验收。

## 收尾

本轮只新增此审计报告，不改业务实现，不修改追溯矩阵以制造验收通过。发现主要是当前项目未解决缺陷，不是已修复并复用验证的方法；不将其晋升为正式技能经验。
