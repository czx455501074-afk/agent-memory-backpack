# 界面、安装与发布专项核对

日期：2026-10-11。受检提交：c4a0ef7844760034c0b2ec206d90ba7b75c470bc。

## 证据边界

界面/发布子任务完成隔离探针、JSON和当前安装投影后，在收尾报告前异常结束。本文件由主窗口接管，依据已真实读回的 `.local/full-audit-20261011/ui-release/probe.mjs`、`results.json`、`current-config-projection.json` 与对应源码整理；不虚构该子任务最终通过报告。

方法是完整 Web UI_JS / Electron renderer 的 VM 与 DOM/IPC 桩，以及随机端口真实内存 HTTP 核心。它验证脚本发出的请求、收到的响应和渲染字符串，不等于真实浏览器布局/截图或真实 Electron 窗口人工验收。安装/部署探针仅写独立审计 profile/home/data 目录；当前真实 profile 和配置只读核对，凭据值不进入投影。

## 交互结论

| 功能 | 本轮观察 | 判定/边界 |
|---|---|---|
| Web 首次加载 | t-project 初值为“—”，初始化 stats/rescan/material 三请求均 projectId=“—”，403 | 阻断，src/ui.ts:33,167,197 |
| 总览与八面板 | 探针明确将项目节点设为 p0 后，各面板能读取并渲染真实夹具数据 | 条件性可用，不能掩盖首次加载问题 |
| 字符转义 | img/onerror 夹具标题转为 &lt;…&gt;，八面板未输出原始标签；token未出现在渲染HTML | 指定样本通过，不外推全部浏览器路径 |
| 凭据 URL fragment | 脚本用 history.replaceState 清理地址栏，仅内存保存 | 行为通过；非法百分号fragment直接URIError，缺处理 |
| 新建/编辑/批准 | evidence='verified'，schema实际为'verifiable'，HTTP400 | 阻断，ui.ts:656,717，schema.ts:44 |
| norm 编辑 | 构造新payload清空deniedTools，hostProvided=false，来源/标签/platforms重设 | 当前被400挡住；只修evidence后该payload可通过schema，存在后续破坏门禁/元信息风险，不声称真实库已损害 |
| preference 编辑 | stated重置true，推断偏好变用户陈述，来源标签平台重置 | 同上条件风险 |
| skill 编辑 | leaves=[],needsStructure=true，来源标签平台重置 | 同上条件风险 |
| workflow/journal/material 编辑 | kind选择框没有对应值，探针模拟浏览器选默认memory，丢原类型字段 | 即使修evidence，Store的kind_changed还会挡住转换；这是编辑阻断，不是已发生类型损害 |
| 单项拒收/归档/补证 | 真HTTP200，状态按动作变化 | 后端交互可用，项目对象权限另见安全专项 |
| 批量拒收/归档/补证 | 能发对应请求；忽略res.failed，部分失败不显示 | 部分实现，ui.ts:768–795 |
| 批量批准 | 没有按钮/对应click分支，探针没有新请求 | 未实现界面入口；后端reviewBatch approve存在 |
| 候选批准到流程 | 一律按proposalId新建memory/base0，不支持保留目标workflow及类型/版本 | 字段纠正后指定workflow候选仍target_mismatch；生产闭环未完成 |
| 查看日记/MD/JSON | 获取任务export并显示可读预览 | API展示可用，不是自动永久日记或下载文件 |
| 跨端接续按钮 | 仅调用handoff，显示建议/files/caveat，没有session绑定或恢复动作 | 摘要查看，不是接续闭环；完整目标/规范/流程未全部渲染 |
| 资料续期/清理 | 可发HTTP，续期理由必填；清理弹窗只显示purged数量，不显示failed | 部分，且purge正文残留见演化专项 |
| 历史 | 只显示当前元信息与版本时间；不能读取旧版正文对照 | 部分历史可读，不是全文版本浏览 |
| 能力接口失败 | catch返回mode=Managed、adapters=[]，仍绿色显示 | 状态误报，ui.ts:530–534 |
| 永不响应请求 | loading持续，无AbortSignal/timeout | 缺超时恢复 |
| Electron | 旧面板可渲染，但候选没有审阅动作，资料/偏好/能力不完整；IPC返回error时顶部仍已连接 | 只完成指定VM/IPC桩核对，未实际新开Electron窗口 |

## 当前真实安装与共享配置

投影不含token或其哈希。默认两端均：endpoint=http://127.0.0.1:47631，projectId=p0-workflow，projectRoot=D:/huange-skill，role=adapter；sameEndpoint=true、sameProject=true。

DSH：desktop profile 的依赖/启用行真实存在，node_modules junction解析到 <HOST_PLUGIN_ROOT>/<HOST_PLUGINS_DIR>/agent-memory-backpack；版本0.1.0-p0.1。index.mjs/ensure-core.mjs/runtime server/ui/store的SHA256均匹配最新产物p0-20261011052424237，但该产物不等当前源码。运行时缺capabilities.js。

Codex：本插件自己的manifest存在，配置enabled=true，位于插件缓存agent-memory-backpack-local/agent-memory-backpack/0.1.0-p0.1。manifest匹配latest，但hook.mjs/runtime server不匹配，runtime/ui.js与capabilities.js不存在，属于更旧构建。缓存启用不是hook信任/加载的当前行为证据；本轮没有当前Codex.exe同时运行工具调用。

这里的“默认配置相同”不能证明正在运行的Codex继承相同环境，或两端实际同时发请求；环境变量可以覆写路径。真实DSH本会话自检/读库通过由主窗口另行记录。

## 产物与运维

latest自身81个artifact文件哈希全匹配，但与当前dist的doctor/server/store/ui四文件不一致；desktopVerified=false。三个runtime都没有新增capabilities/policy/semantic模块。旧包的旧代码没有对应新import，因此不是“旧包现在必然ModuleNotFound”；准确问题是发布包未含当前新增能力。

隔离安装/再次安装退出0，已有core.json时跳过初始化，新的project参数不迁移原绑定；独立目录保留isolated项目。--no-sync/--start干跑/卸载只读均如实输出条件，没有操作真实宿主或启动项。

隔离DSH deploy在目标profile没有bundles启用配置时，输出active=false linked=yes，却exit0并提示重启。这只能证明链接完成，不能称启用/加载成功。

诊断能力探测：空Codex cache目录也报告installed=true/unknown；空DSH插件目录也报告installed=true。manifest里的七能力是硬编码设计声明，没有本次会话心跳、信任、当前包哈希或实际调用证明。一个形状错误但有新at的快照，核心operatingModeFromDisk仍报告ReadOnlySnapshot、0禁止项，与适配器loadSnapshot的shape校验不同。

Windows Run测试直接使用真实HKCU，finally旧registered时以虚构路径恢复。完整回归必须先隔离/精确恢复测试，本轮主回归已经排除service.test。真实开机登录、卸载后空白两端新会话、当前两端停用和最新UI布局没有本轮新证据。

## 结论

界面和运维不是空文档，但当前Web入口与写入流程有阻断，能力状态与部署回执存在假阳性，现有两个宿主缓存包不是同一当前源码快照。修复时应同时保留全部原元信息，不要仅修verified枚举后放任清空门禁/引用。
