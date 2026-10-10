# 插件运行日志与控制台自检

**时间**：2026-10-10（Asia/Shanghai）
**来源**：用户要求「这个插件要有自我检测机制。还要有运行日志，方便查找问题，适用版本」。

## 一、发现并修复的缺口

上一轮把运行日志做在了**核心**里（`serve` 期间写）。但插件运行在宿主进程内，核心不可达时恰恰是最需要日志的时刻——那时核心日志根本不会产生。所以本轮补上**适配器自持日志**：

- `adapters/dsh/log.mjs` —— DSH 插件使用
- `adapters/codex/scripts/log.mjs` —— Codex hook 使用

两份是逐字相同的副本，**由测试断言其哈希一致**，而非靠约定。这样任一端装了插件都能独立排查，也保证修复不会只落到一边。

## 二、适配器日志的关键性质

与核心日志一致，但**强制在日志器内部**而非依赖调用点：

- **凭据绝不落盘**：任何名字形似密钥的字段（`token`/`authorization`/`secret`/`apikey`…，含嵌套）在写入前替换为 `[redacted]`。
- **写失败只降级为静默**：数据目录只读时插件照常工作，`isDegraded()` 暴露该事实，供自检报告，而不是让日志"以沉默撒谎"。
- **版本戳**：加载时写一条 `adapter.load`，含插件版本、Node 版本、平台与日志路径。这是日后解读旧日志的前提。
- 轮转：500 KB × 保留 2 份。

记录的事件（每条都可定位到具体工具或阶段）：

| 事件 | 时机 |
|---|---|
| `adapter.load` | 插件加载，含版本与平台 |
| `adapter.config` | 配置解析成功，含 endpoint 与 projectRoot |
| `adapter.config_failed` | 配置不可用，随后抛出 |
| `adapter.out_of_scope` | 项目范围外的代理，自动注入与门禁被跳过 |
| `tool.ok` / `tool.failed` | 每次工具调用，`tool.failed` 含工具名与耗时 |
| `tool.out_of_scope` | 工具因项目范围被拒绝 |
| `event.delivery_failed` | 事件投递失败（否则日记缺页却无人知道） |
| `hook.*`（Codex） | 输入非法、事件不支持、配置不可读、跳过、开始/成功/失败 |

## 三、两套日志的读取

```powershell
node dist/src/cli.js logs                        # 核心日志（默认）
node dist/src/cli.js logs --source plugin        # 插件日志
node dist/src/cli.js logs --all-sources          # 合并两套，按时间排序
node dist/src/cli.js logs --level warn --limit 20
```

实测输出：

```
core log records: 2   events: run.start, core.listening
plugin log records: 2 events: adapter.load, tool.failed
merged records: 4 (core 2 + plugin 2)
warn-and-above: 1 -> tool.failed
doctor plugin-log: pass — …\amb-plugin.log.jsonl（241 字节）
```

## 四、自检覆盖两套日志

`doctor` 新增 `plugin-log-present` 检查：尚未生成时提示（附"在宿主中启用插件后重新运行自检"），已生成时给出路径与字节数。加上原有检查共 **11 项**。

## 五、控制台自检面板

桌面用户不应被迫开终端。控制台新增「自检」页签：

- 自检在**主进程**执行（那里已持有配置路径），渲染进程只拿到报告；
- 报告**结构上不含凭据**，因此回传给页面是安全的——界面显示的是「64 characters, prefix aaaa…」；
- 页签角标只显示**阻塞级**问题的数量，检查干净时不显示；
- 顶栏「状态」显示连接性。

已真实渲染并截图：`docs/implementation/console-selfcheck.png`（11 项检查、状态标签、逐项建议）。

## 六、面向 agent 的自检工具

自检此前只在 CLI 与控制台可用——**插件本身对 agent 没有自检入口**，而遇到失败时最需要解释的恰恰是 agent。已补 `amb_self_check`，**DSH 与 MCP 两端都提供**（工具面各 10 个，保持一致）。

返回的检查项：

| 项 | 内容 |
|---|---|
| `project-scope` | 当前会话是否位于配置的项目范围内（越界则自动注入与门禁被跳过） |
| `core-reachable` | 核心是否可达，含往返耗时；失败时给出处置建议 |
| `protocol-match` | 协议版本与运行状态；核心不可达时**跳过**而非谎报通过 |
| `knowledge-state` | 知识版本、规范与流程条数 |
| `log-file` | 日志可写性；不可写时报告为 `warn`（插件仍可用，但问题难以追溯） |
| `version` | 插件版本、Node 版本与平台 |
| `credentials` | 说明凭据仅在本地核心请求中使用，不写日志、不作为工具结果返回 |

设计要点：

- **凭据只报形态**（如 `64 characters, prefix aaaa…`），测试断言返回体不含凭据原文。
- 核心不可达时 `core-reachable` 为 `fail`，依赖它的 `protocol-match` 为 `skip`——**不把"无法核对"写成"通过"**。
- 日志不可写时报告为 `warn` 而非 `pass`：插件功能不受影响，但声称日志健康就是说谎。
- 结论带 `note`，明确要求按 `hint` 处理而不是凭猜测绕过。

## 七、过程中修复的缺陷

1. **产物中版本显示为 `unknown`**。`pluginVersion()` 只按仓库布局（`dist/src/` 上溯两级）查找，而产物布局是 `core/runtime/`（上溯一级）。改为**探测两种布局**，并加测试断言版本可读且格式正确。
2. **打包未包含新增模块**。`console/` 完全未被打包，`log.js`/`doctor.js`/`export-skills.js` 也不在产物内。已修：产物现含 console（源码形式，Electron 运行时由用户提供）与全部新增模块，共 **48 个文件**纳入哈希清单；来源校验也把 `console` 纳入，复制不一致会直接失败。
3. **产物内脚本失效**。原产物 `package.json` 只写 `start`。现补 `doctor`/`logs`/`console`，并让 `console` 的运行时解析**探测两种布局**，因此打包后的控制台不必从开发目录启动。

## 七、验证

- 全套 **116 项测试，115 通过，0 失败，1 条件跳过**。
- 新增 `adapter-log`（6 项）：两份实现逐字一致、结构化可过滤、**凭据不落盘**、不可写时静默降级、目录解析优先级、以及静态断言确认日志确实接在加载与失败路径上。
- 新增 `operations` 中的产物布局版本探测与插件日志检查（共 13 项）。
- `dsh-runtime` 端到端：在**真实 Cordis 运行时**里加载适配器，读回它实际写出的日志，断言含 `adapter.load`/`adapter.config`/`tool.out_of_scope` 与 `adapter.out_of_scope`，**并断言凭据未出现在日志中**。
- 从**打包产物本身**运行：`adopt`/`doctor`/`export`/`logs` 全部正常，导出为无 front matter 的标准 Markdown，产物含插件日志模块与控制台。
- `package-smoke` 通过（中文+空格路径下从产物启动核心与 MCP）。

## 八、仍未完成

- **技能结构化转换**：机制已就绪（`structure` 命令 + 工具），语义结构仍须人或模型提供；程序无法从 Markdown 可靠推导有序步骤，伪造即是欺骗。
- **真实桌面端验收**：所有结论仍是代码路径、隔离运行库与产物层面的判断。真实 DSH/Codex 桌面加载、hooks 信任与自动触发尚未验收——清单见 `desktop-acceptance-checklist.md`。
- `doctor` 的 `host-runtime` 检查在独立运行时下为 `skip`；只有宿主提供运行时版本时才有结论。
