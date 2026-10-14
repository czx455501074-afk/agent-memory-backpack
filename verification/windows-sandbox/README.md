# Windows Sandbox 测试环境

本次环境准备于 2026-10-13。`test.wsb` 使用本机绝对路径，迁移到其他机器时需要修改三个 HostFolder。

- 输入：`D:\huange-skill\.local\windows-sandbox-20261013\input`，只读映射为 `C:\AMB-Input`。
- 结果：`D:\huange-skill\.local\windows-sandbox-20261013\results`，可写映射为 `C:\AMB-Results`。
- 运行目录：沙盒内部 `C:\AMB-Test\project`。
- Node：24.19.0，输入中自带 Node/npm 与依赖快照。
- DSH：输入中包含已提取的 0.2.0-rc.2 运行时，不包含完整桌面安装程序。
- Electron：宿主 `node_modules/electron/dist` 只读映射为 `C:\AMB-Electron`，供沙盒内控制台测试使用。
- 网络：开启，供打包的锁文件安装和干净安装使用。
- 剪贴板、音视频输入、打印机映射与 vGPU：关闭。

输入快照仅复制源码、测试、依赖和提取的 DSH 运行时，没有复制宿主知识库、客户端凭据、真实桌面 profile 或账号登录状态。测试生成的凭据仅属于临时测试库。

双击 `test.wsb` 后，LogonCommand 自动执行映射的 `run.ps1`。成功进入脚本后首先写入 `status.json`，其 `computer`、`user` 与 `environment.json` 用于确认实际执行环境。每个步骤记录退出码与独立 stdout/stderr 日志。`completed` 表示执行流程结束；通过与否必须检查各步骤退出码、测试跳过项和验收报告，不能只看最终状态。

自动步骤：类型检查、编译、复制 Electron、锁文件打包、设置沙盒内产物路径、全量测试（含打包产物消费与部署实操）、桌面自动验收、干净依赖安装及安装后类型检查。复制源码时排除宿主 artifacts，避免旧清单内绝对路径跨环境失效。

`host-*` 文件是沙盒无法启动时在宿主独立副本运行的证据，不得记作沙盒测试。真实桌面加载、信任、注入、门禁与停用须另行验证；脚本不会自动登录账号或批准 hooks。

配置依据：[Microsoft Windows Sandbox 配置文档](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file)。
