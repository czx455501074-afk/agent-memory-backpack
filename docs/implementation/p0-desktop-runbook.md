# P0 桌面接入验证

2026-10-10，Asia/Shanghai。**测试环境已准备，Codex插件已通过官方CLI安装；真实桌面验收待执行。** 本文不是完整产品交付声明。

## 已经准备好的本机文件

| 内容 | 路径 |
|---|---|
| 在两个桌面打开的测试工作区 | `<PROJECT_ROOT>\.local\desktop-p0\workspace` |
| 核心前台启动入口 | 工作区中的 `start-core.ps1` |
| Codex本地marketplace | 工作区中的 `.agents\plugins\marketplace.json` |
| Codex插件 | 工作区中的 `packages\codex-plugin` |
| DSH本地插件包 | 工作区中的 `packages\dsh-plugin` |
| 私有测试配置和SQLite | `<USER_HOME>\.agent-memory-backpack` |
| 已验证原始产物 | `<PROJECT_ROOT>\artifacts\p0-20261009162025694` |

工作区是独立Git根，没有提交；复制的包被工作区.gitignore忽略。配置仅含随机本地测试凭据，不含任何模型网关或平台账号密钥。不要将配置内容贴到聊天。桌面进程无需继承shell变量：未设覆盖变量时，两适配器均读取上述默认目录；若本机曾设置AMB_CONFIG/AMB_DSH_CONFIG，先核对是否覆盖了默认值。

## 首次加载

1. 在PowerShell运行下列命令，保留终端；这是前台测试服务，Ctrl+C可停止。不是自启动服务。若端口占用，不终止未知进程，先报告占用。

   ```powershell
   & '<PROJECT_ROOT>\.local\desktop-p0\workspace\start-core.ps1'
   ```

2. **不必重复安装。** 本机CLI `0.162.0-alpha.2` 已成功执行本地marketplace add和plugin add，安装ID为`agent-memory-backpack@amb-local`，缓存路径`<USER_HOME>\.codex\plugins\cache\amb-local\agent-memory-backpack\0.1.0-p0.1`。用户级该插件`enabled=false`，仅测试工作区`.codex/config.toml`声明`enabled=true`。用户级配置安装前备份在`<USER_HOME>\.codex\backups\amb-p0-20261010\config.before-marketplace.toml`，包含原有敏感配置，不分享。

   Codex桌面需打开上述测试工作区，项目配置加载后才能启用插件。此前应用项目列表仅登记`<PROJECT_ROOT>`，尚未登记测试工作区，不能假设已在正确项目中启用。用户反馈找不到允许/信任入口；官方文档明确的`/hooks`入口属于CLI，**桌面信任入口仍未确认，不再让用户凭猜测寻找**。如果桌面仍无入口，由工程侧调查宿主支持情况；不能编辑信任哈希或绕过信任，也不能将CLI安装成功当成桌面通过。[官方安装说明](https://developers.openai.com/plugins/build/plugins)、[官方hooks信任说明](https://learn.chatgpt.com/docs/hooks)。

3. DSH桌面在“设置 → 插件”通过其本地包入口加载 `<PROJECT_ROOT>\.local\desktop-p0\workspace\packages\dsh-plugin`。如果界面接收包spec，可使用该绝对路径对应的`link:`来源；具体界面支持须实测。不运行`dsh plugin --profile desktop`，不手工重复insert；包自带bundle patch。任何重载由桌面支持的入口处理，不能直接杀死正在工作的宿主。

4. 两端均在此测试工作区创建新会话。Codex桌面交互目前不能由本轮Computer Use流程代操作；尚未确认的信任入口需先调查再提供精确操作。DSH安装待验证，不将CLI安装Codex的结果外推到DSH。

## 验收用例与预期证据

| 场景 | 需要记录的真实结果 |
|---|---|
| 首次新任务 | 用自然语言“查找本地流程资料，并说明开始前的检查”，观察自动prepare是否在模型工作前发生；仅模型自述不足为证 |
| 共享版本 | 两端amb_prepare均读到knowledgeRevision=1和p0-cn-workflow；后续导入替换后均刷新 |
| 完整流程召回 | 分别按“工作准备”“完成核对”检索，同一workflow ID，前提/完成条件齐全；按阶段展开 |
| 候选提交 | 提交明确测试经验、同一idempotencyKey重试，回执相同且只产生一个pending；有效库不自动变化 |
| 工具拒绝 | 先获取桌面实际传递的工具名，再在测试库添加只禁止该无副作用测试调用的规范。不能假设MCP命名空间。观察工具体未执行、桌面显示拒绝 |
| 规范替换 | 同条目使用baseRevision替换，下一次检查使用新版本；拒绝过期baseRevision |
| Stop | 产生turn_stopped/相应事件，不产生任务完成声明 |
| 核心离线 | Ctrl+C停核心；已确认范围内的受支持工具拒绝/错误清楚，不能假装成功；重新启动可恢复 |
| 未信任/禁用 | 未信任hooks不执行；禁用后在新会话中不再注入/提供工具；记录是否需要重启 |
| 项目边界 | 普通范围外工作不被钩子阻断。P0 Codex MCP未做调用方cwd认证，测试插件仅在此工作区启用，不导入真实多项目数据 |

每项记录宿主版本、适配器版本、时间、项目/会话ID、可观察日志或回执及通过/失败/未验证。不得只把shell脚本输出当成桌面证据。DSH还需真实Agent消息落盘/回放测试；现有ToolRuntime测试中agent是fixture。

## 已通过的开发验证

- `npm test`：构建通过，33通过、1个产物测试跳过。
- 指定`AMB_ARTIFACT_DIR`后单独运行`test/package-smoke.test.mjs`：1通过、0跳过；在中文+空格路径复制产物后启动核心，使用官方MCP客户端连接并读取流程。
- DSH真实Cordis/SystemPrompt/ToolRuntime使用已安装的0.1.7-rc.1合同；守卫不能被覆盖或跳过、手动读写拒绝跨项目、junction逃逸拒绝、规范刷新、注销工具均通过。

## 停止与恢复

核心用Ctrl+C停止。桌面插件通过各自UI停用/卸载，再在新会话核查效果。保留测试工作区、配置和数据库用于诊断；不需要删除现有skills、全局规范或真实项目文件。不要在DSH卸载时删除其他插件或整个node_modules。

完整产品仍缺分类审核/自动晋升、正式日记与跨端任务接续、90天资料库、管理页和可靠常驻等功能。P0退出条件通过后继续这些阶段；不会将“手动能读”当作原自动化目标已实现。
