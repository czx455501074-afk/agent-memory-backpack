# 开发状态

2026-10-09：用户已授权开发。开发过程由多个 agent 分工协作完成（详见本地保留的规划记录，不在发布面内）。

当前阶段 P0：制作共享核心接入原型、两端适配器和隔离验证包。尚未通过两桌面实际加载/信任/触发验证；后续完整知识治理阶段未被冒称完成。

最新用户需求：技能按完整工作流程组织；分类只索引流程，新经验定位到流程步骤。原子片段不得作为孤立有效skill暴露。

当前分工：集成、DSH 适配器、核心与发布前核对由一方负责；打包与 Codex 范围修复由另一方完成；困难合同经第三方独立审查后，由集成方对照真实 SDK 与反例验证再落地。

硬性P0退出条件：两端实际版本绑定，自动准备上下文、候选提交回执、覆盖范围内执行检查、禁用/未信任/失联行为有真实证据。隔离Node/Cordis/协议测试不等于桌面UI已通过。缺关键能力不能悄悄改成手动产品。

## 2026-10-09 20:18 阶段结果

已实现TypeScript/SQLite核心、HTTP协议、MCP stdio、Codex hooks及DSH适配器、本地打包。当时源码快照`npm test`为29/29通过（核心/协议15、Codex12、DSH2）；之后DSH子任务仍有改动，因此此结果不代表当前源码。实际桌面加载未验证，P0尚未退出。

旧产物：`<PROJECT_ROOT>/artifacts/p0-20261009121717175`，已过期，不能安装为当前版本；尚未完成打包产物独立启动/真实desktop安装验证。DSH测试采用真实Cordis事件总线配可观察工具registry fixture，不等于完整真实ToolRuntime/profile组合通过。

账号5小时窗口剩9%，按用户规则停止新实现，详细状态见内部交接记录（`docs/internal/handoffs/`，不随开源发布）。完整插件仍未完成，不把当前原型当作正式自动学习产品。

## 2026-10-10 接入边界修复与当前交付

当前代码：`npm test`构建通过，34项中33通过、1项打包冒烟因未设置产物路径跳过。随后单独设置产物路径运行打包冒烟：1/1通过、0跳过。不能将两次运行描述为同一份34/34桌面测试。

已修复并验证：

- DSH异步waterfall拒绝可被外层插件覆盖的问题：WeakMap保存每次执行结果，真实ToolRuntime最终同步guard复查；外层覆盖deny或跳过next均不能执行范围内工具。范围外普通工具继续工作。
- DSH手动知识工具同样校验agent项目范围，不能跨项目读写；使用realpath识别逃逸项目的目录junction。HTTP禁止重定向。
- DSH插件内容单独使用`agent-memory-backpack`来源，保留原用户消息；规范变更在下一次工具检查刷新。此来源依据安装包MessageSourceMap可扩展合同，不冒称system消息。
- Codex先确认项目范围，再验证连接配置。范围外坏endpoint/token不会阻断其他项目；范围内仍拒绝；范围未知时诊断并跳过。
- 打包使用Node直接调用npm CLI，按锁安装生产依赖；校验源文件与复制文件摘要，生成artifact-manifest；中文和空格路径下真实CLI/MCP启动通过。

当前验证产物：`<PROJECT_ROOT>/artifacts/p0-20261009162025694`。时间戳是UTC，对应上海2026-10-10 00:20。旧包保留为历史，不能安装旧包代替此包。

桌面验证工作区已实际创建：`<PROJECT_ROOT>/.local/desktop-p0/workspace`，含独立Git根、本地marketplace、启用配置、原样复制的安装包、前台核心启动脚本。测试凭据与数据库：`<USER_HOME>/.agent-memory-backpack`，projectRoot严格绑定该工作区，只有明确标注的P0种子知识。未改Codex/DSH真实profile，未安装/信任hooks，未启动常驻服务。

复现入口：`scripts/prepare-desktop-p0.mjs`；操作说明：`docs/implementation/p0-desktop-runbook.md`。初始化拒绝覆盖已有配置/工作区。

仍未验证：两桌面实际加载、信任、自动触发、禁用和失联组合；DSH真实Agent/session持久化与回放；Codex桌面是否提供有效hook审阅入口。P0 MCP凭据固定到测试项目，但不能独立证明调用方cwd，不得将其描述为完整跨项目访问隔离；仅在测试工作区启用。P0仍未退出，不能开始宣称完整自动学习产品已完成。

Opus审查记录保存在 `docs/internal/`（不随开源发布）。采纳guard与来源归属问题；没有采用其错误的`null`放行建议（真实合同是undefined），也未照搬未经验证的system来源。

### 同日00:28更新：用户找不到信任入口

用户反馈“没有找到需要我允许或信任的地方”。只读检查当时Agent Memory Backpack未安装：用户config无该插件、cache无该manifest；应用项目列表只有开发根，没有测试工作区。此前要求用户直接去桌面信任不够具体，已纠正。

本机官方CLI实际支持`plugin marketplace add`及`plugin add`。已完成安装`agent-memory-backpack@amb-local` 0.1.0-p0.1，缓存`<USER_HOME>/.codex/plugins/cache/amb-local/agent-memory-backpack/0.1.0-p0.1`；用户级新插件配置已设enabled=false，测试工作区配置enabled=true。官方CLI list确认installed=true、当前开发目录enabled=false。没有修改hook信任、没有重启桌面、没有修改DSH profile。安装前原用户config备份：`<USER_HOME>/.codex/backups/amb-p0-20261010/config.before-marketplace.toml`，含敏感配置不输出。

此更新取代上文“未改Codex真实profile、未安装”的时间点描述；DSH仍未安装，桌面运行仍未验证。原有证据报告属于历史探测，不用于证明当前未安装状态。

目前 Appx 包版本只读查询为 `26.1002.7124.0`，安装目录位于 `<Program Files>\WindowsApps\OpenAI.Codex_<版本>_x64__<发布者哈希>`；它不是此前应用自报的版本字符串，不直接判定桌面升级。已在只读检查其 `app.asar` 中是否存在 hooks 信任 UI。
