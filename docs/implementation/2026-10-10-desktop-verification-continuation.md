# 桌面验证续测记录

时间：2026-10-10，Asia/Shanghai。承接此前迁移验证及 MCP 修复报告。本记录优先于早期报告中已过时的“未安装、无工具、未取得注入”状态；没有把旧版本或其他 profile 的证据混入当前验收。

## 当前实测结果

| 项目 | 结果与范围 |
|---|---|
| 自动基线 | 本轮重新执行 accept:desktop，16通过、0失败、0跳过，52产物哈希匹配。 |
| Codex MCP | 真实桌面工具返回 self_check 通过：project-demo、协议v1、Managed、知识版本1。prepare、search、read_stage 均成功；测试聊天已读取 locate 与 read-and-check，ready=true。 |
| Codex 自动注入 | 通过。原始宿主 rollout 第9、10行是 developer 角色的 [agent-memory-backpack] 消息；第一条模型消息位于第17行。来源文本在模型工作之前出现，证据不是模型自述。 |
| 候选幂等与不自动生效 | 同一 key 两次调用返回同一候选ID 6d334205-7d35-40c4-b02a-364dde5fdc98，pending；首次duplicate=false，重试duplicate=true。pendingProposals从0到1，entries维持2、knowledgeRevision维持1。幂等语义通过，但交接要求的“两次回执相同”若指整个JSON逐字段相同，则不满足。 |
| Codex 失联与恢复 | 本轮停止自行启动的核心后，真实桌面 amb_prepare 返回 isError=true：Agent Memory Backpack core unavailable. Governance could not be checked. 重启后 self_check 再次通过。受支持MCP路径通过。 |
| 当前 Codex 门禁 | 本次 amb_self_check 探针未通过：用户明确授权发送测试指令后，测试聊天实际执行工具并返回ok=true、知识版本2。原始记录有hooks.additional_context禁用规范，却没有拒绝。此结果不等于所有门禁路径均失效，见追加记录。 |
| Codex UI 安装/信任截图 | 用户已确认信任，CLI已确认安装启用；仍缺交接要求的两张UI截图。 |
| Codex 禁用后新聊天 | 未验证。尚未停用当前插件，尚未进行新的无工具/无注入会话核对。 |
| DSH 注入 | 磁盘现有 dsh-injection-evidence.json 记录隔离profile amb-verify、夹具cwd、source.kind=agent-memory-backpack，序号10在首次assistant序号17之前。该记录支持隔离DSH来源注入；本轮未独立核对对应原始会话。当前可见DSH窗口属于另一个实际profile，插件列表没有此插件，不能把它当成隔离测试宿主，也未改动其profile或干扰正在运行的任务。 |
| DSH安装/失联/禁用 | 当前版本完整链路仍待独立验证。 |
| 数据迁移 | 此前CLI交叉、设备B、403拒绝、损坏包拒绝通过；GUI结果没有单独显示conflicts，按交接9b判失败。完整数据库“预览完全不写入”证据仍待补足。 |

## 原始证据

- 当前Codex测试聊天：01a1266d-bb45-75b3-806d-19d9854baae8，标题“检查连接并查找流程资料”，cwd为独立夹具。
- 自动注入来源：`<USER_HOME>/.codex/sessions/2026/10/10/rollout-<TIMESTAMP>-<SESSION_ID>.jsonl`。
- 脱敏摘录：D:/huange-skill/.local/desktop-verify/packages/codex-automatic-injection-evidence.json。含行号、时间、developer来源文本和首个模型消息位置；未复制整个会话。
- 本轮真实MCP返回：D:/huange-skill/.local/desktop-verify/packages/desktop-mcp-test-evidence.json。包含恢复后检查、流程、阶段、两次候选提交、受控失联及恢复结果。
- 既有DSH隔离证据：D:/huange-skill/.local/dsh-injection-evidence.json；当前只标记读取此记录，未假称独立完成完整DSH链路。
- 迁移证据：D:/huange-skill/.local/desktop-verification-evidence-20261010。

## 当前状态与后续

本轮恢复核心exec会话4436仍运行，端口47631。未删除数据、未修改信任哈希、未停用其他DSH插件、未创建子智能体。本轮没有结束全部验收；早期收尾记录不能代表当前进程状态。

下一步先在用户授权的夹具测试聊天中核对实际hook工具名，再准备无副作用门禁用例；随后执行Codex停用新会话和DSH隔离宿主完整链路。发送测试指令到另一个聊天需要用户明确授权，已提出具体问题。桌面权限/信任交互仍由用户完成。

最近额度检查：短期5小时窗口used45%，剩余55%；每周used32%，剩余68%，均未触发低额度收尾。窗口重置Unix秒分别1791652110、1792168226。

## 23:38 门禁探针追加结果

用户明确授权向“检查连接并查找流程资料”发送测试指令。开始前额度更新为短期剩余54%、每周68%。本轮prepare返回knowledgeRevision=2，新增gate-verify-rule@1，禁止amb_self_check；该测试规范由并行的其他工作创建，本聊天没有新增或修改它。此前候选测试时版本1、entries2的记录仍是当时事实，不能据后续版本变化改写原结果。

测试turn：01a12677-2be2-7533-a0a3-aff329a316ac。原始rollout第62行custom_tool_call名称为exec，输入为text(await tools.mcp__amb__amb_self_check({}));；第63行developer内容标记hooks.additional_context，包含禁用规范；第66行工具返回ok=true、知识版本2。适配器日志15:38:33.197Z记录PreToolUse，15:38:33.642Z记录PostToolUse。说明hook被调用并返回上下文，内层MCP工具仍执行了。

推断：宿主对外层exec做门禁，而规范仅禁止内层amb_self_check，可能导致工具名不匹配。原始调用名exec和日志支持这一方向，但日志不含hook输入tool_name，尚不能声称已直接捕获确切字段，也不能把规范换成猜测名称后宣布修复。尚未新增替代规范，未修改源码、缓存或信任配置。

证据文件：D:/huange-skill/.local/desktop-verify/packages/codex-gate-probe-evidence.json（第62、63、66行的原始记录）。本次调用没有使用shell、HTTP或其他替代路径绕过门禁；使用宿主提供的常规tools调用接口。

总体验收仍未完成；当前结果记录为该探针失败，严格工具名门禁用例仍需补足。Codex停用后新会话与DSH完整链路仍未完成。
