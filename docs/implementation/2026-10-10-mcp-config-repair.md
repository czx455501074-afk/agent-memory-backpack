# MCP 客户端配置修复

目标：修复已安装且用户已信任hooks的Agent Memory Backpack没有amb工具的问题。用户授权“现在该怎么做，你来做”。

## 证据及修复

- 检查时AMB_CONFIG在Process、User、Machine三个环境范围均不存在。
- 在已安装插件目录直接启动 `node runtime/mcp.js` 返回退出码1：`Agent Memory Backpack client configuration missing or invalid. Run init; set AMB_CONFIG to the generated adapter config.`
- 插件的 `.mcp.json` 声明 `env_vars: ["AMB_CONFIG"]`，runtime与hooks均通过该变量寻找客户端配置；没有变量时回退默认用户数据目录。
- 已将用户级AMB_CONFIG设置为 `D:\huange-skill\.local\desktop-verify-data\codex-client.json`，读回确认值一致。之前用户级值为空。本轮没有编辑真实profile、hook定义、信任记录或既有源码。
- 这是用户级环境变量，重新启动后会供该用户新进程使用，指向测试库。其他配置来源或真实项目数据未迁移。测试插件的MCP绑定project-demo，不能将此测试配置用于真实项目知识验收。

## 实测结果

通过MCP SDK Client + StdioClientTransport连接已安装包等价的夹具MCP服务，显式设置相同AMB_CONFIG：

- 初始化成功，tools/list返回11项：amb_self_check、amb_prepare、amb_search_workflows、amb_read_stage、amb_read_knowledge、amb_supersede_experience、amb_knowledge_history、amb_structure_skill、amb_unstructured_skills、amb_submit_experience、amb_inspect_archive。
- amb_self_check：ok=true，核心可达，协议v1，运行状态Managed，知识版本1。
- amb_prepare、amb_search_workflows：返回p0-cn-workflow@1及中文标题、阶段、前提、完成判据。
- amb_read_stage：读取locate阶段成功。

诊断脚本：`D:\huange-skill\.local\desktop-verify\packages\verify-mcp.mjs`。
回执：`D:\huange-skill\.local\desktop-verify\packages\mcp-connection-verification.jsonl`。不含凭据值。

这些是stdio协议测试，不能替代桌面工具加载或自动注入证据。当前桌面进程仍可能持有旧环境。

## 用户完成重启

启动器：`D:\huange-skill\.local\desktop-verify\packages\launch-test-codex.cmd`，调用同目录launch-test-codex.ps1。脚本语法检查通过，未启动新的桌面实例，避免干扰当前聊天；实际用户双击启动尚未验证。

用户须完全退出Codex / ChatGPT桌面后，从资源管理器双击启动器。启动器检测现有桌面实例，存在则拒绝；不会杀进程。它显式携带AMB_CONFIG，在47631未监听时隐藏启动测试核心，等待health，再打开已安装Codex.exe。没有设置登录自启，也没有自动停用其他插件。

接着在desktop-verify项目新建会话验证amb_self_check / amb_prepare及来源标记。若仍没有工具，应采集该新会话的MCP启动日志，不再次修改信任。

回滚用户环境的方式：仅当不再使用本测试配置时，执行 `[Environment]::SetEnvironmentVariable('AMB_CONFIG', $null, 'User')`，然后重新启动宿主。本轮未执行回滚。

事实边界：没有取得桌面自动注入证据、门禁拒绝证据或DSH安装证据，这些验收项仍待完成。

## 桌面会话连接确认

用户报告启动器被运行中桌面进程拦住后，本聊天工具清单已实际出现mcp__amb。直接在桌面聊天调用amb_self_check返回ok=true、核心可达、协议v1、知识版本1；调用amb_prepare返回project-demo的p0-test-rule与p0-cn-workflow@1。这是桌面会话MCP工具可调用的证据，不再仅为独立stdio测试。

启动器运行中实例检查改为正常说明并exit 0，避免不必要的PowerShell错误堆栈，不杀进程、不启动第二实例。当前连接已成功，无须为此再次重启。自动hook注入仍未以来源消息证明。
