# 可独立验证结果与桌面操作流程

日期2026-10-11，Asia/Shanghai。本报告本轮实际写入；此前回答给过同名链接，但当时文件不存在，此次已补正，不把此前回答当作实测记录。

## 本轮已执行

1. 官方额度检查：5小时剩余97%，每周剩余67%。
2. npm run accept:desktop：16通过、0失败、0跳过、6人工项；52产物哈希匹配。脚本使用自己的隔离库，没有停止DSH。
3. 以readOnly方式打开当前测试数据库，SQLite VACUUM INTO生成独立快照，在快照运行夹具importArchive dryRun。15张表的完整行内容摘要全部不变，数据库与WAL字节摘要不变，total_changes差值0；结果imported=0、skipped=8、conflicts=[]、wrote=false。证明当前后端预览路径未写入该隔离库；不宣称真实GUI点击期间共享库字节没有变化。
4. 同一快照gate：amb_self_check=deny；mcp__amb__amb_self_check、exec、functions.exec=allow。真实桌面前轮记录显示外层exec调用及PreToolUse上下文，内层MCP成功。判定当前规范的短工具名不能覆盖这些调用名；尚未捕获桌面hook输入tool_name，不把名字差异推断为唯一根因。
5. 当前夹具console renderer已包含独立冲突数量显示，属于其他正在进行的工作已有修改。本轮未改它。提取真实migrate-import handler，在模拟IPC结果冲突0与1两例运行，均显示新增0、跳过8、冲突数量，非空时显示冲突ID。代码级复验通过；尚未取得更新后真实窗口截图。
6. 复核旧DSH/Codex报告：工作区、缓存与产物轮次不同，不能覆盖当前夹具版本。此前卸载已读回官方列表无agent-memory-backpack@amb-local、缓存不存在、测试数据目录保留。

证据：D:/huange-skill/.local/desktop-verify/packages/remaining-1791652990754/result.json；D:/huange-skill/.local/desktop-verify/packages/conflict-rendering-evidence.json。辅助脚本verify-remaining.mjs和verify-conflict-rendering.mjs位于同目录，仅在packages内新增；没有修改源码或共享知识库，没有启动子智能体。

## 用户操作A：卸载后真正新聊天（现在即可做）

1. 在Codex打开D:/huange-skill/.local/desktop-verify。
2. 点击新建聊天，确认正文为空，不使用继续、分叉或原测试聊天。
3. 输入：只检查当前聊天可用工具中是否有mcp__amb或amb_*，以及当前聊天是否收到agent-memory-backpack来源的自动注入。只报告观察到的结果，不安装、不修改，不把其他聊天历史当成本聊天证据。
4. 发回聊天标题或ID和回复。工具清单为空、原始宿主消息无来源注入，两者才算通过；我可读取该聊天宿主记录核对，不要求你证明原始消息。

旧聊天中的历史注入不会因卸载消失。此项是卸载后验证，不替代UI停用。

## 用户操作B：Codex UI停用（插件恢复安装以后再做）

当前已卸载，不需要为此立即重装。等门禁修复或下一轮安装完成：进入插件详情或设置中的插件/MCP管理，查找启用开关或停用菜单。若本构建只提供卸载，保存插件详情截图，记录无停用入口；不能改成卸载并宣布停用通过。若有停用，关闭后在同一测试工作区新建空白聊天，重复A。若仍提供工具或注入，完全退出再打开后另建聊天复验，记录是否需重启。

此操作需用户完成：computer-use SKILL.md引用../../docs/guidance.md明确“Do not automate the ChatGPT desktop app UI”。本轮没有通过其他UI机制绕开。

## 用户操作C：DSH正在进行的验收

沿用DSH测试任务，避免同时操作同一宿主或停核心。请让现有测试任务保存当前夹具、当前包的以下证据，然后把报告路径发来：

- 安装与启用：插件列表截图，实际本地包路径与版本/哈希。
- 自动注入：夹具新会话，原始source.kind=agent-memory-backpack记录在首个模型回复前。
- 门禁：先记录hook实际工具名；只禁止无副作用调用；保存拒绝及工具未执行证据。不能用模型自行拒绝代替hook拒绝。
- 失联恢复：仅由核心持有者在无人使用时停止测试核心；新知识读取明确失败，再恢复后成功。不要停未知进程。
- 停用：UI关闭插件后新会话无工具、无来源注入，记录是否需重启。

如果这几项DSH已完成，不必重复，提供原始记录或报告即可，我负责核对其范围与证据。

## 剩余可由我继续的事项

真实控制台窗口复验由我执行，需等DSH使用共享核心结束或另起完全隔离实例，不把它转交为必需用户操作。门禁新增正确测试规范与复验也由我在隔离夹具执行，但当前插件已卸载，完整桌面复验需下一轮安装后才能完成；本轮未擅自重装或改共享规范。源码修复不属于本轮验收动作，已有失败据实保留。

总体验收未完成。本轮补足后端预览不写入与冲突结果渲染的证据；仍缺当前桌面门禁、卸载后空白新聊天、UI停用、DSH当前轮完整证据、更新后控制台GUI复验。

## 01:25 卸载后空白新聊天复核：通过

用户提供截图“检查 AMB 工具与自动注入”。应用read_thread核对聊天01a126d9-29cd-7113-b5a9-e2ac98933773，cwd为D:/huange-skill/.local/desktop-verify，仅一个用户测试turn、无更早历史。回复明确工具清单没有mcp__amb/amb_*，未发现自动注入。独立读取该聊天完整宿主rollout，没有[agent-memory-backpack]或知识版本来源的developer注入。结合此前官方安装列表与缓存检查，卸载后新聊天无AMB工具、无AMB来源注入判为通过；不外推UI停用结果。

原始记录 `<USER_HOME>/.codex/sessions/2026/10/11/rollout-<TIMESTAMP>-<SESSION_ID>.jsonl`，摘要 `D:/huange-skill/.local/desktop-verify/packages/uninstalled-new-chat-evidence.json`。截图原件 `<USER_HOME>/AppData/…`。

## 01:28–01:31 更新后控制台真实窗口复验

按用户自动推进指令，新建独立packages/gui-retest-20261011数据目录及随机本地凭据，核心端口47639。导入旧测试归档初始化为entries2/revision1。未使用DSH共享核心47631，也没有操作另一控制台窗口。

通过sky操作本轮electron PID24328、窗口26482282；原生选择文件对话框输入D:/huange-skill/.local/verify-1.ambpack，先显示归档路径、导出时间、格式版本1、大小2.6KB、知识2/版本2/任务0/候选0，再点击确认。真实结果显示新增知识0、跳过条目8、独立冲突条目0。更新后冲突显示缺项复验通过。冲突数量0在界面出现两行，属于重复显示观察，未修改代码。真实非零冲突GUI尚未构造；非零渲染仅有前轮模拟IPC代码证据。

导入后官方status entries2/revision1/pending0。真实GUI预览未做前后完整数据库快照，严格不写入结论仍来自此前隔离importArchive验证，不将两个证据范围混淆。

证据目录D:/huange-skill/.local/desktop-verify/packages/gui-retest-20261011：preview.txt、import-result.txt、import-result.jpg。启动时出现Electron磁盘缓存访问错误，但窗口、核心连接、原生选择与导入流程实际成功。

本轮独立控制台exec81893及核心exec15899已Ctrl+C退出，数据保留。当前额度检查短期余93%、每周余66%。DSH保持原状态，未停止其进程或共享核心。当前总体验收仍缺桌面正确工具名门禁、UI停用和DSH当前轮完整证据；卸载后新聊天与更新后零冲突GUI显示已通过。

## 01:32 正确名称hook联调：通过（非桌面验收）

本轮继续使用独立gui-retest-20261011库新增isolated-exact-tool-gate，明确禁止exec与mcp__amb__amb_self_check，仅供测试；共享库与源码未改。真实hook子进程输入PreToolUse，连接真实HTTP核心47639：这两种名称均返回permissionDecision=deny，原因包含该测试规范ID；未禁止的amb_self_check短名返回上下文，没有deny。子进程均exit0、stderr空。确认精确名称规则能够贯通SQLite→核心→hook拒绝协议，不代表桌面宿主已执行拦截。

证据D:/huange-skill/.local/desktop-verify/packages/gui-retest-20261011/exact-gate-evidence.json；脚本verify-exact-gate.mjs。脚本finally关闭本轮核心，隔离数据与测试规范保留，没有启动或停止DSH任务。额度短期余87%、每周65%。

下一步实际桌面门禁需要重新安装测试插件及可信hooks，然后捕获真实hook输入tool_name，按其确切名称准备仅阻止无副作用探针的规则，在夹具聊天触发；不能以本轮人工构造hook输入当作桌面通过。Codex停用入口的可用性及DSH当前轮完整链路仍需用户桌面操作/DSH现有任务证据。没有自行重装、改信任或猜测宿主名宣布修复。

## 01:34–01:35 重装并检查宿主加载

用户继续授权后，执行官方codex plugin add agent-memory-backpack@amb-local --json成功；list回读installed=true、enabled=true、version0.1.0-p0.1。缓存scripts/hook.mjs、hooks/hooks.json、runtime/mcp.js分别与当前夹具SHA256一致。没有修改信任哈希、真实profile或其他插件。

在已授权测试聊天01a1266d-bb45-75b3-806d-19d9854baae8发送只读连接探针，turn01a126e1-39b2-7d03-bb8d-9b65e6bf4ceb返回工具清单[]，未执行amb_prepare、没有新的AMB注入；适配器日志该聊天没有新增hook事件。因此安装成功，但旧聊天尚未加载恢复工具，不能用该聊天继续宣称桌面门禁通过。

共享47631端口由PID45500监听，本轮未停止或替换，避免干扰DSH。下一步由用户在夹具新建聊天；若有hooks审阅提示先审阅信任，再做只读prepare。必要时用户重启桌面后再新建；不得用旧聊天加载状态判定重装失败。当前额度短期余85%、每周余65%。

## 01:35 新聊天认证失败定位

新聊天“调用 amb_prepare 核对规范”01a126e2-1967-7d20-8ad0-65224ccf95db原始记录明确策略hook阻止调用，显示policy service is unavailable。适配器日志PreToolUse在UTC17:35:26.451及17:35:32.112记录service returned HTTP 401；不是网络不可达。47631健康端点protocol1/statusok，但PID45500启动参数为dist/src/cli.js serve --data-dir `<USER_HOME>/.agent-memory-backpack`，不是本夹具desktop-verify-data核心。测试凭据对另一份库的核心认证失败。没有读取或披露该默认目录凭据，没有停止PID45500。

判定：重装后hook实际加载，认证失败会拒绝调用（受支持路径保守阻断证据）；当前连接恢复与规则门禁复验仍未完成。先前仅发现端口监听不能证明监听者属于测试库，这一判断在本次进程归属核对后纠正。需要为两轮测试分配不同端口，不能把另一轮核心健康正常等同测试连接可用。

## 独立端口恢复准备

用户同意后，新建packages/codex-isolated-20261011，随机凭据、端口47640、project-demo、projectRoot指向原独立夹具。导入旧归档得到entries2/revision1。安装缓存真实MCP通过SDK连接验证：11工具；self_check全部pass；prepare、search、locate阶段ready=true。原始结果同目录mcp-verification.jsonl。此为MCP独立进程验证，桌面恢复尚待重启。

用户级AMB_CONFIG改为该新目录codex-client.json，读回一致；没有改Codex/DSH profile、信任哈希、原共享测试库或DSH配置。当前桌面旧进程的环境不会自动更新。

启动入口packages/launch-isolated-codex.cmd（对应.ps1语法校验通过）：检查桌面未运行；启动47640独立核心；使用新配置凭据验证prepare认证后再启动Codex；不会停止未知进程。若端口监听者认证失败，明确终止启动。需要用户完全退出桌面再执行，不能再次使用旧launch-test-codex.cmd（它仍指向47631旧环境，保留旧文件没有改写）。

本轮临时核心exec84241已关闭，启动器将自行重启；DSH核心45500保持运行。最近额度短期余81%、每周64%。

## 01:40 独立端口桌面恢复：通过

用户新聊天“调用 amb_prepare 报告知识版本”01a126e6-7774-75c0-8932-d8674e2a8ca2位于独立夹具，实际调用amb_prepare成功返回知识版本1、Managed、p0-test-rule@1与p0-cn-workflow@1。主聊天真实amb_self_check亦全pass、project-demo、协议v1、版本1。独立端口切换后桌面读取恢复，此结果不只是此前SDK测试。

截图 `<USER_HOME>/AppData/…`。

## 01:42 桌面实际门禁：通过

在独立47640库新增临时desktop-exact-gate-20261011，列入amb_self_check、mcp__amb__amb_self_check、exec、functions.exec；触发已授权夹具聊天01a1266d-bb45-75b3-806d-19d9854baae8只读自检一次。turn01a126e8-7562-7062-b9d5-e65a2116bd53原始工具返回：Tool call blocked by PreToolUse hook: 当前规范禁止该工具: desktop-exact-gate-20261011. Tool: mcp__amb__amb_self_check。宿主拒绝发生在调用前，没有成功MCP调用结果；不是模型自述未执行。日志同会话PreToolUse存在。结论仅覆盖此次真实直接MCP调用及该明确规则集，不宣称仅短名可覆盖所有路径或exec内层已获得独立治理。

随后官方CLI retire --id desktop-exact-gate-20261011 --revision 1成功，历史保留；真实prepare读回版本3，仅p0-test-rule生效，临时规则已经退场。未修改源码、信任哈希或DSH共享库。

原始门禁记录摘录packages/codex-isolated-20261011/desktop-gate-evidence.json；seed同目录desktop-gate-seed.json。当前余量短期77%、每周63%。剩余主要是Codex UI停用入口与新聊天，以及DSH当前轮独立证据。

## 用户截图：插件级停用入口未提供

用户提供插件列表与详情页菜单两张截图。列表菜单含立即试用、管理、卸载；详情页菜单只有卸载。详情显示agent-memory-backpack 0.1.0-p0.1、MCP服务器Amb、技能Agent Memory Backpack及钩子。技能区域蓝色开关是技能级控制，不能作为整体插件、MCP与hooks都停用的证据。两张截图未展开MCP或hooks齿轮设置，故不声称所有设置路径都已排查。

当前已检查页面没有插件级停用入口，步骤7记录为UI入口受限/未执行，不判停用通过，也不据此判插件缺陷。此前卸载后空白新聊天无工具、无注入通过独立保留。截图同时补足本轮插件列表及详情加载证据；未显示hooks信任状态，不能当作信任截图。原始门禁实际执行拒绝仍支持hooks在运行。

留存证据packages/codex-isolated-20261011/plugin-menu-no-disable.png及plugin-details-no-disable.png；来自用户截图，无自动UI操作。剩余主要为DSH当前轮报告与原始证据核对。
