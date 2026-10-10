# Codex卸载失败实测

2026-10-10，Asia/Shanghai。用户反馈没有停用选项，且卸载失败。此次只读排查没有替用户点击UI、没有杀进程、没有删除缓存或改写真实profile。

桌面日志的两次plugin/uninstall请求（UTC15:41:16.624及15:41:28.730）均返回-32603：failed to uninstall plugin: failed to remove existing plugin cache entry: 另一个程序正在使用此文件，进程无法访问。 (os error 32)。文件占用是明确失败原因；尚未识别确切持有锁的进程。

原始日志：`<USER_HOME>/AppData/Local/Codex/Logs/2026/10/10/codex-desktop-<SESSION_ID>.log`。

随后官方CLI安装列表仍显示agent-memory-backpack@amb-local installed=true、enabled=true，但其缓存runtime/mcp.js已不存在；同期amb MCP初始化失败。说明卸载未完整完成，不能将此状态算作停用验证通过。没有取得用户所见UI截图，因此没有独立确认本构建是否存在停用入口。

已在允许的packages目录准备remove-test-codex-plugin.cmd及.ps1。由用户完全退出桌面后启动：脚本先检查Codex/ChatGPT进程，仍运行就退出；只调用官方codex plugin remove agent-memory-backpack@amb-local --json，不手工删除任何目录，不卸载huange-workflow。成功后核对官方安装列表并确认测试数据目录存在。结果保存在同目录codex-plugin-uninstall-result.txt和codex-plugin-uninstall-verification.json。

脚本尚未执行，卸载尚未完成。此操作验证的是卸载后的状态，不能替代UI停用测试。账号额度检查短期余51%、每周余67%，未触发低额度收尾。

## 2026-10-11 01:18 卸载后复核

用户说明DSH正在测试，随后确认已卸载。只读复核官方codex plugin list --json：agent-memory-backpack@amb-local已不在installed列表；对应缓存目录不存在；D:/huange-skill/.local/desktop-verify-data仍存在。本会话也已撤下mcp__amb工具命名空间。确认卸载及数据目录保留，不推断目录内容完全不变。

未执行本聊天准备的卸载脚本；不宣称用户具体使用哪种卸载方式。没有停止DSH或其测试进程。上述结果不能替代UI停用与新会话无注入验收；整体测试仍有未完成项。
