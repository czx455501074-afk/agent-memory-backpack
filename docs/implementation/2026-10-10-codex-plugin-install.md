# Codex 插件安装补充记录

时间：2026-10-10 23:03（Asia/Shanghai）。用户明确要求“你来安装我来授权”，授权安装本地测试插件。此补充覆盖先前报告的“未安装”状态，但不覆盖桌面信任及自动注入的未验证结论。

本机现有 codex CLI 可用；实际支持 `plugin add`，没有 `plugin install` 子命令。

在 `D:\huange-skill\.local\desktop-verify` 执行：

```powershell
codex plugin marketplace add 'D:\huange-skill\.local\desktop-verify' --json
codex plugin add agent-memory-backpack@amb-local --json
codex plugin list --marketplace amb-local --json
```

实际结果：marketplace `amb-local` 注册成功；插件 `agent-memory-backpack@amb-local`，版本 `0.1.0-p0.1`，`installed=true`、`enabled=true`。

安装位置：`<USER_HOME>\.codex\plugins\cache\amb-local\agent-memory-backpack\0.1.0-p0.1`。

来源：`D:\huange-skill\.local\desktop-verify\packages\codex-plugin`。仅通过官方CLI完成marketplace注册与插件安装，没有手工修改真实profile、信任哈希或信任记录；安装命令可能持久化插件设置，这属于本轮明确安装授权范围。

已有 `huange-local` marketplace 和当前会话可见的 `huange-workflow` 插件保持原样，没有停用或卸载。新插件是否在其他项目加载、与原插件是否同时注入，均未验证。

hook信任状态未知，未代点信任。未取得桌面插件列表截图、hook已信任截图或自动注入来源证据。不能将CLI已安装/已启用当作桌面完整验收通过。

下一步：刷新或重新打开宿主，在独立测试项目中查看本地插件；若有Hooks设置入口，审阅 `agent-memory-backpack` 定义后由用户信任。入口是否暴露仍须运行时确认。

## 用户完成信任后的检查

用户在本聊天明确确认“钩子已经信任 / 已经信任”。记录为用户确认，未取得信任界面截图。当前会话的技能目录已出现 `agent-memory-backpack`，但可调用工具清单没有 `amb_*`，所以不能判定MCP接入或自动注入通过。

检查时47631未监听，已按原验收授权重新启动测试核心，输出监听成功；exec会话43588保持运行，供下一步测试使用。

缓存中的MCP清单通过 `env_vars: ["AMB_CONFIG"]` 转发宿主环境。夹具 `.codex/config.toml` 不存在，runtime在没有AMB_CONFIG时回退用户默认目录。未读取或打印任何客户端凭据内容，未修改宿主配置。宿主是否已携带测试配置尚未验证。
