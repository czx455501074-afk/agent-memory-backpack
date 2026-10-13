# DSH 桌面真实使用与异常恢复详细测试报告

测试日期：2026-10-13，Asia/Shanghai。项目：Agent Memory Backpack。此报告承接同日《Codex DSH 桌面实操测试记录》，重点补足真实业务、多轮修改、跨会话、故障恢复与用户管理操作。结论：正常知识检索与资料交付可用，规则保护和候选幂等有效；审批、交接信息、离线同步可见性及错误诊断仍有明显缺口，不能认定为全功能验收通过。

## 1. 测试对象、方法与证据口径

- 插件版本：0.1.0-p0.1；源码基线：025d184，包含上一轮尚未提交的 UI 字符串修复及回归测试。本轮没有新增生产代码修复。
- DSH 桌面：0.2.0-rc.2；宿主 Node：24.18.1；构建 Node：24.19.0。使用实际已部署插件，不是直接 import 源码代替宿主。
- 部署目录：`%USERPROFILE%/.dsh/plugins/agent-memory-backpack-test-20261013`；最终产物：`D:/huange-skill/artifacts/p0-20261013011520735`。上一轮已核对 31 个代码/配置文件字节一致。
- 本轮隔离核心：127.0.0.1:47641；项目 ID：desktop-realistic-20261013；根目录：D:/huange-skill。仅在测试 DSH 子进程设置 AMB_DSH_CONFIG，原权威库及凭据未替换。原核心端口 47631。
- 桌面通过 Computer Use 操作真实 Windows 窗口；管理 UI 通过内置浏览器操作实际核心页面。使用 fixture CLI/API 建立规则、流程修订及缺失依赖，不将这些后台操作计入 UI 成功。
- 新增 3 个真实 DSH 会话、7 个模型轮次、42 次实际工具调用，其中 AMB 工具 32 次，文件/命令工具 10 次。7 个轮次均有 completed 结束记录；其中预期失败工具不计为成功调用。
- 三个会话共保存 319 条解码记录。证据以原始 tool/call、tool/result、插件日志、核心数据及磁盘交付文件为准，模型的自述只作辅助。
- 解码串联 zstd 帧后统一 UTF-8 解码，避免人为制造跨帧中文乱码。辅助扫描脚本的 injectionRecords 查询字段不正确，因此自动注入统计直接核对 user/message 的 source.kind。

本报告的“通过”只针对对应场景和观察范围。未执行项目范围外宿主、永久删除、并发多客户端、进程崩溃中断及长时间压力测试，不能由现有结果推断这些场景通过。

## 2. 真实业务与测试数据

模拟青禾项目资料交付：用户需要需求、接口与验收清单三类资料，最初没有确认日期与负责人。测试要求智能体读取完整流程、执行收集和交付步骤，读取背景与技能叶子，写 delivery.md 并读回核验，将经验提交为候选；不得把未确认信息写成已验收。

初始隔离库包含项目规范、两阶段完整流程、中文偏好、背景记忆、带叶子的技能，以及其他项目的保密标记，共 6 个条目，知识版本 1。之后通过 UI 新增确认日期 2026-10-20，再改为 2026-10-21；通过后台增加禁止 history 工具的规范、批准流程修订、构造失效依赖，知识版本最终到 7。

所有文件操作限定 `.local/dsh-realistic-20261013/workspace`。测试用户资料是构造数据，不使用私人业务知识。隔离数据中的 admin-client.json / dsh-client.json 含认证信息，保留本地，不复制到报告或提交仓库。

## 3. 完整场景矩阵

| 编号 | 真实操作与预期 | 实际结果 | 判定 |
|---|---|---|---|
| D01 | 冷启动真实桌面并加载隔离项目 | 日志 adapter.load 版本正确，adapter.config 指向 47641 和测试项目 | 通过 |
| D02 | 插件详情显示版本与运行组件 | v0.1.0-p0.1，1 个组件运行中 | 通过 |
| D03 | 桌面停用、再启用 | 已关闭/已停用反馈出现；随后恢复启用 | 界面通过，未验证旧会话工具彻底移除 |
| A01 | 完整业务流程检索与两步展开 | 流程命中；collect、deliver 均 ready=true | 通过 |
| A02 | 背景与技能叶子读取 | 读取真实记忆；includeLeaves 返回叶子标记 | 通过 |
| A03 | 写交付文件并读回 | 实际 write/read；事实、风险、下一步及未确认项存在 | 通过 |
| A04 | 自动规范注入与同轮去重 | A1 13 个步骤仅一条 AMB 自动上下文记录；后续知识变更重新注入 | 通过对应轮次 |
| A05 | 经验提交待审而非自动生效 | 候选落库 pending，关联完整流程及 baseRevision=1 | 通过 |
| A06 | UI 增加日期后继续原聊天 | 读取新确认记忆，交付文件改为 10-20；负责人仍未确认 | 通过 |
| A07 | 检索其他项目标记 | universal 结果为空，未出现在该请求返回中 | 通过本次检索隔离 |
| A08 | 新规则即时禁止 history | isError=true，明确指出 realistic-deny-history | 通过 |
| A09 | 批准后读取流程新版 | 后台正确批准 workflow 修订；桌面读取 revision=2 的审核标记 | 后台及宿主通过，UI 批准失败见 F01 |
| A10 | 桌面检查真实 ambpack | inspect_archive 成功；实际备份存在并能识别条目 | 通过检查，未执行恢复覆盖 |
| B01 | 新聊天按 task ID 接续原任务 | 同一 task 绑定 A/B 两个 session；未新增重复主任务 | 绑定通过 |
| B02 | 接续内容足够支持继续交付 | summary、unfinished、files、fileStates 均空；新模型自行读磁盘才发现旧日期 | 不足，F03 |
| B03 | UI 编辑日期并查询历史 | v2 保存成功，历史列表有 v1/v2；新版为 10-21 | 通过编辑/列表 |
| B04 | 指定已非 current 的旧 revision | read_knowledge @1 返回 409；当前版本读取正常 | 正确拒绝，历史正文能力缺口 |
| B05 | 核心离线仍能本地工作 | prepare 报不可达；本地交付文件能读 | 通过降级路径 |
| B06 | 离线保持近期禁止规则 | history 被最近规则快照拒绝；未放行 | 通过保护，UI 文案矛盾见 F07 |
| B07 | 离线提交经验 | 返回 pending，磁盘 spool 有 1 候选+20 事件 | 持久化通过，回执不足 F04 |
| B08 | 恢复核心、同一会话继续 | prepare Managed，核心可达；原 21 条仍未重放 | 部分恢复，F05 |
| C01 | 新聊天触发补偿重放 | 日志 replayed=21、remaining=0，空 spool 文件移除 | 通过，存在延迟 |
| C02 | 同键同文重试 | 返回服务器同一候选 ID、duplicate=true；UI 只有一条 | 通过 |
| C03 | 同键异文重试 | 409，未新增候选、未重新排队 | 保护通过，错误信息不足 F06 |
| C04 | 必要流程依赖退役后继续 | prepare 有不就绪提示；read_stage 409；模型停止执行该流程 | 阻断通过，错误信息不足 F06 |
| U01 | 新增/编辑知识后顶栏刷新 | 表格与正文变化，顶栏一直知识版本 1；后台已到 5 | 失败，F02 |
| U02 | UI 批准候选 | 点击按钮报 prompt() 不支持；源码请求与流程批准契约不匹配 | 失败，F01 |
| U03 | 候选待审列表及关联信息 | pending、来源 DSH、所属流程、正文、日期可见 | 通过 |
| U04 | 候选归档 | 点击移出归档，pending 消失，archived 列表找到同一 ID | 通过 |
| U05 | 交接 JSON/Markdown 导出 | 页面显示完整预览；未产生下载事件 | 预览通过，易用性不足 F09 |
| U06 | 离线 UI 与重新连接 | Failed to fetch 提示；核心恢复后重连成功 | 连接通过，状态/启动说明不足 |

## 4. 多轮真实执行记录

### A：从收集到交付，再吸收用户确认与规则更新

会话：session-16c30793-e2c3-4718-93bd-df4a43084c11，共 3 轮、22 次工具调用。

第 1 轮以 AMB-REALISTIC-A 标记真实交付任务：prepare → search_workflows → read_stage collect/deliver → read_knowledge 背景 → universal 搜索技能 → read_knowledge 带叶子 → 检查目录 → read input.md → write delivery.md → read delivery.md → submit_experience。实际 12 次工具调用，约 53 秒。正文区分事实与未知日期、负责人，没有凭空宣布验收成功。

第 2 轮由管理页面新增确认记忆后继续原聊天。5 次调用，实际检索/读取新增条目后重写并读回文件；知识版本 2，交付日期 2026-10-20。另对其他项目专属标记查询返回空数组。此结果只说明本次检索正确，不代替所有工具、嵌套路径和全部项目范围攻击验证。

第 3 轮由后台加入禁止 history 的规范，并正确批准完整流程修订后继续。5 次调用；prepare 知识版本 4；deliver 返回流程 v2 审核标记；history 被规则拒绝；检查真实备份成功；背景 memory@1 当前版本读取成功。这一区别很关键：B 中拒绝的是已过时的旧 revision，并非所有 @revision 读取均坏。

首个候选 ID：0fd97908-618b-4278-8971-b623c619b166。绑定 realistic-document-flow，baseRevision=1。提交时未传 taskId，因此后续 task.relatedProposals 为空不能直接归因于数据库丢失，应改善适配器默认关联或提示。

### B：新聊天接手、日期更正、核心离线与恢复

会话：session-648be0f0-49c0-47f8-b67e-4ba426231a8c，共 3 轮、15 次工具调用。

第 1 轮明确继续 task-ab5e543ce734b7b3。10 次调用，约 75 秒。核心任务的 sessionIds 同时含 A/B，绑定正确。进入新聊天时 seq12 含 combined Task Handoff，seq25 再注入同一任务的独立 handoff，出现重复；交接仅能给出通用重查建议，未收录交付文件和待确认项。模型重新读记忆与磁盘文件，识别记忆已是 10-21，文件仍为 10-20，没有静默覆盖文件。

第 2 轮停止隔离核心后，要求不启动核心、不读凭据，真实执行离线路径。4 次调用，约 21.8 秒。prepare 返回不可达；history 被最近规则快照拦截；read 本地交付文件成功；submit_experience 返回：

```json
{"id":"realistic-offline-20261013","state":"pending","duplicate":false}
```

提交正文指出“完整流程：用户资料交付流程；步骤：交付与复核；核心离线必须区分本地排队与服务器正式接收”。当时服务器确实停止，此回执不是服务器正式收件证明。磁盘保留 1 个候选和 20 个事件，共 21 条。

第 3 轮重新启动隔离核心，在同一聊天 prepare 一次，约 10 秒。Managed、知识版本 5，说明实时访问已恢复；但 spool 仍为 21，未同步。管理页面重新连接成功也不能证明候选队列已经清空。

### C：恢复补偿、去重、冲突与失效依赖

会话：session-f7cf3db8-9c05-4200-ad78-72f44fd5c305，共 1 轮、5 次工具调用、约 33 秒。

进入新聊天时插件日志 2026-10-13T04:03:14.861Z 记录 spool.replay：replayed=21，remaining=0。服务器产生一条离线候选，ID 59954f4e-dc8d-42d6-8e52-d5c6cc132098。相同 key、相同正文重试返回同一 ID 且 duplicate=true；同 key 不同正文 409，未额外创建条目。

fixture 先创建有效 prerequisite 和依赖它的完整流程，再退役 prerequisite，合法产生后续依赖不可用状态。直接创建不存在 prerequisite 的流程被核心 409 拒绝，这是正确保护，不是插件缺陷。C 中读取 collect 阶段 409；后台同请求对照返回 dependency_unavailable 与具体缺失 ID，桌面回执却只剩 HTTP 409。模型依据 prepare 的提示停下，没有绕过失效流程执行交付。

## 5. 缺陷与不足清单

优先级含义：P1 阻断核心用户路径；P2 结果容易误解、接续不足或诊断困难；P3 易用性/可观测性改善。并非所有 P2 都属于数据损坏。

### F01 · P1：流程经验的 UI 审批路径不可用

**复现**：DSH 提交流程经验形成 pending → 管理 UI 待审 → 点击批准生效。实际浏览器日志在 app.js 的审批 handler 报 `prompt() is not supported`，候选没有生效。内置浏览器不支持 prompt 是特定运行环境边界，尚未据此断言 Chrome 同样失败。

**另一项独立契约问题**：src/ui.ts:839 的 handler 固定 entry.id=候选 UUID、kind=memory、baseRevision=0；核心对已有 workflowId 的候选要求 entry.id 等于所属流程。后台错误目标 ID 的对照返回 409 target_mismatch；改为完整流程 ID 和正确 revision 后成功。此对照验证与源码证据支持“即使 prompt 可用，当前 UI 请求也不能正确批准这类流程经验”，但不冒充已在 Chrome 完成点击验证。

**影响**：用户完成实际工作并提交候选，却无法通过当前页面完成审核闭环。建议改为页面表单，显示目标流程和现版本，审核完整流程变更；冲突保留审核内容，提供重载/合并。

**修复验收**：仅用 UI 完成 pending → 目标流程新 revision → DSH 下一轮读到新内容；不得退化为把候选 UUID 独立批准成无关 memory。

### F02 · P2：顶栏知识版本长期陈旧

UI 新增知识后表格 v1 正确，后台 knowledgeRevision=2，顶栏仍 1。编辑为 v2、后台到 5 后，导航、页面刷新按钮及断线重连仍未更新顶栏版本。截图 knowledge-added-header-stale.png、history-v2.png。

这不是知识写入失败，DSH 已真实读到新版；是 UI 状态源没有同步，容易令用户误判未生效。验收应同时检查表格、顶栏、核心、下一轮 prepare 四处一致。

### F03 · P2：任务接续只绑定会话，缺少有效交接内容且重复注入

核心 task 虽关联两个会话，但 summary/notes/verified 为空，unfinished/files/fileStates/relatedExperiences/relatedProposals 均为空。文件已实际写入并读回，候选已提交，负责人仍未知；这些关键进度没有进入交接。事件只写通用 DSH tool/call，无法据此恢复已执行的具体工具与结果。新模型不得不重新读文件和知识。

B 初始 seq12、seq25 两次提供同一 task handoff，增加冗余。应在生命周期事件中提取可信文件路径、当前进度、验证证据与未完成项，并区分自述与已核验事实；自动携带 taskId 关联候选。不能因为一个轮次 completed 就把整个业务 task 标记完成，本轮 task 保持 in_progress 是合理的。

### F04 · P2：离线回执与正式接收难区分

离线 submit 返回普通 pending，与在线待审状态同形，只有 id 形态差异，未包含 queued/local、同步状态或最后错误。调用者必须额外理解 spool 才能判断服务器有没有接收。建议返回明确 receiptSource、deliveryState、clientSubmissionId/serverProposalId，并在页面展示未同步项；不要让智能体凭 pending 就声称“已入服务器待审”。

### F05 · P2：恢复核心后原会话不会及时重放本地队列

恢复后原 B 会话 prepare 已 Managed，但 21 条队列仍在；新 C 会话开始才成功重放。adapters/dsh/index.mjs:281 以 replayedSessions 限制每个会话首次进入时回放，解释了本次现象。没有数据丢失证据，也不能称同会话恢复同步通过。

建议在由不可达转为可达时触发受控重放，或提供显式“同步待发送”操作及队列计数；避免每轮无节制重试。验收必须在不换聊天、不重提经验的条件下恢复同步，并证明幂等。

### F06 · P2：适配器吞掉可执行的核心错误原因

同键异文与阶段依赖失效在桌面均显示 `Agent Memory Backpack core returned HTTP 409.`；两种错误需要不同处理。直接 expand 对照返回 code=dependency_unavailable、message 指定 realistic-prerequisite@1；adapters/dsh/core-client.mjs:96 构造通用 HTTP 错误。

正确拒绝本身通过，但缺少 code/message/target revision 会诱导错误重试。建议透传安全结构化错误，保留 status 与关键 ID，并区别可重试暂态、幂等冲突、流程不可用。

### F07 · P2：离线 UI 的防护描述与真实 LocalGuarded 行为矛盾

UI 将核心离线描述为 Ungoverned、工具防护降级为未受规则约束；实际桌面 history 被近期快照明确阻断。正常 Managed 和离线 LocalGuarded 应分开显示，交代规则快照时间与未知边界。不能只因核心不可达就宣称所有保护都失效。

### F08 · P2：DSH prepare 查询与去重回执契约容易误用

上一轮真实宿主已经确认 amb_prepare 使用 EMPTY_OBJECT_INPUT，模型传 query 时实际 retrieval.query 仍空；显式工具回执反复 contextUnchanged=false。自动上下文注入与工具结果是两条路径，本轮 A1 自动注入一次说明自动路径有去重，不能因此认为显式 prepare 也能按 query 检索或共享去重状态。

建议让工具文档明确“用于准备，按任务检索请用其他工具”，或完整实现 query；统一/说明 contextUnchanged 的意义。不得用模型总结替代原始回执判断。

### F09 · P3：管理界面闭环和导出便利性不足

- 候选筛选有 pending、needs_evidence、archived、rejected，但未看到 approved 筛选；批准后的去向难追踪。存在批量批准 handler，当前 pending 页面未观察到对应按钮。
- archived 可查看软归档候选，未观察到恢复入口。不能据此说核心永久删除了候选。
- JSON/Markdown 导出显示预览，等待下载事件未发生。预览内容确实存在，不能说导出完全失败；建议增加保存/复制按钮并明确“预览”。
- UI 本地时间与 Markdown 中 UTC 时间混用，Markdown 未明确时区，核对时间线困难。
- history 有旧版本列表，但已非 current 的 @1 正文读取被拒绝；需要独立只读历史查看能力，不能要求绕过当前版本保护。
- 离线引导给出 `node dist/src/cli.js serve`，未说明数据目录和已安装运行时；普通桌面用户不一定在源码根目录，容易启动错误实例。

## 6. 正确行为与非缺陷辨别

1. 项目外 marker 本次检索为空、旧 revision 冲突、依赖缺失阻断、禁止工具、同键异文拒绝均是保护行为；它们不是“功能调用失败所以产品坏了”。
2. 离线候选最终只创建一条，重放清空 21 条；没有证据支持“离线经验丢失”。问题是延迟与状态含糊。
3. UI 新日期写入成功，桌面知识版本更新；顶栏陈旧不是数据库陈旧。交付文件仍旧日期是 B 本轮只诊断未改写，不是 UI 写错数据。
4. fixture 首次 API 请求漏 x-amb-protocol 产生 426，已补正确协议；这是测试探针错误，不计产品缺陷。查询已清空 spool 得到 ENOENT 是探针误判，文件清除符合预期。
5. 原始会话不支持上一轮模型所称“正文乱码/4.44MB 检索”；不把该自述落为缺陷。
6. 备份检查成功不等于已经做恢复演练。UI prompt 不支持不等于所有外部浏览器都会失败。

## 7. 自动化结果及与真实桌面的关系

上一轮同一修复构建：npm test 共 376 项，375 通过、0 失败、1 跳过；跳过的 pack smoke 单独运行通过；clean-install 3 项通过；UI 14 项通过；desktop acceptance 16 个自动项通过，仍有 6 个手工项。详见前报告。本轮不重复运行完整套件来制造额外“全面”的数字。

这些通过与本轮 UI 审批、交接、离线恢复问题并存，说明自动化未覆盖足够完整的桌面业务闭环。建议新增真实构建产物测试：流程候选 UI 审批契约、知识写入后顶栏更新、同会话 offline→online 重放、具体错误回执、真实文件交付后任务交接内容。

## 8. 证据索引

根目录：`D:/huange-skill/.local/dsh-realistic-20261013/`。该目录为本机测试证据，不将认证配置提交到 Git。

| 文件 | 内容 |
|---|---|
| seed.json / dependency-seed.json | 构造业务、规范、技能叶子与依赖 fixture |
| session-16c30793-e2c3-4718-93bd-df4a43084c11.jsonl | A 三轮完整工具、回执、自动上下文 |
| session-648be0f0-49c0-47f8-b67e-4ba426231a8c.jsonl | B 交接、离线、恢复三轮 |
| session-f7cf3db8-9c05-4200-ad78-72f44fd5c305.jsonl | C 补偿、幂等、失效依赖 |
| 各 session 对应 -summary.json | 原始工具调用与结果摘取；注入辅助统计字段不可用 |
| data/amb-plugin.log.jsonl | 宿主加载、配置、保护、21 项重放及失败日志 |
| fixture-api-actions.jsonl | 受控后台操作及真实 HTTP 状态/错误正文 |
| spool-offline-evidence.json | 停核心后实际保留的 21 项队列证据 |
| workspace/input.md / delivery.md | 真实本地输入及交付；历史写入正文见 A 原始 write 调用 |
| library.ambpack | 实际备份及桌面检查对象 |
| ui/knowledge-added-header-stale.png | 知识新增后陈旧顶栏 |
| ui/history-v2.png | 历史列表及新修订 |
| ui/handoff-empty-progress.png | 缺少有效进度的交接页面 |
| ui/core-offline.png | 核心离线管理页面 |
| ui/proposal-archived.png | 候选成功软归档 |
| ui/dsh-missing-dependency.jpg | 原生 DSH 失效依赖真实回执 |
| ui/task-export-json.txt / task-export-md.txt | 交接导出预览内容 |

## 9. 尚未覆盖与下一轮具体顺序

本轮已经覆盖真实业务闭环的主要正常和异常路径，但以下事项仍未完成，不标记通过：外部 Chrome/Edge 中审批交互；原会话工具在停用后清理及冷启动停用验证；在另一个工作区验证范围退出；材料 TTL/续期/清除；永久删除与完整恢复覆盖；批量拒绝/补证据；多客户端并发修订；长对话压缩、取消/崩溃中断；升级/降级回滚及长时间稳定性。

优先处理顺序：F01 审批闭环 → F03 有效交接 → F04/F05 离线回执和即时重放 → F06 结构化错误 → F02/F07 UI 状态 → F08 工具契约 → F09 易用性。修复后按本报告同一 fixture 和真实 DSH 用户操作回归，不能只更新单元测试断言。

## 10. 收尾与恢复实测

- 通过原生应用菜单退出隔离 DSH，重新普通启动。2026-10-13T04:15:31.060Z adapter.load、04:15:31.604Z adapter.config 确认版本仍为 0.1.0-p0.1，恢复原核心 47631、原项目 p0-workflow 和根 D:/huange-skill。
- 新桌面窗口可显示 C 会话及其真实历史回执；插件此前已恢复为启用、组件运行中。未更改其他插件开关。
- CLI 停止隔离核心 PID 20092；健康检查确认为不可达，未注册登录启动。service status 保留 stale 锁，应在下次启动时按正常 stale 恢复处理；不删除证据或假称锁已释放。
- 本轮新增文档后复跑 clean-install：3 项通过、0 失败；git diff --check 通过。报告和产物扫描未发现该测试导致的个人机器路径污染。
- 恢复证据：`.local/dsh-realistic-20261013/recovery-verification.json`。未提交 Git、未发布插件；上一轮生产代码修复仍未提交。
