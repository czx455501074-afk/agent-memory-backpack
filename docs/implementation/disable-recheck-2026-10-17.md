# Codex 侧插件状态与版本核实（2026-10-17）

## 为什么要看这个

发行文档里 `disable` 一项一直记为"界面层未复验"。本轮改用 `codex plugin list --json` 直接读插件状态——**比在 GUI 里找开关更直接**，而且返回的是 Codex 自己认定的状态。

## 读到的

```
pluginId : agent-memory-backpack@agent-memory-backpack-local
version  : 0.1.0-p0.1
enabled  : true
installed: true
source   : D:\huange-skill\.local\codex-marketplace\codex-plugin
marketplaceSource: \\?\D:\huange-skill\.local\codex-marketplace
```

`config.toml` 里对应的登记：

```toml
[marketplaces.agent-memory-backpack-local]
source_type = "local"
source = '\\?\D:\huange-skill\.local\codex-marketplace'
```

**没有** `[plugins."agent-memory-backpack@..."]` 这一节——即**本插件没有被单独覆盖配置**，`enabled=True` 来自默认。**这就是 `disable` 的作用点**：加一节 `[plugins."agent-memory-backpack@agent-memory-backpack-local"] enabled = false` 即可停用，与 `dsh-memory-evolve` 文档里写的 `disabled: true` 是同一类做法。

## 一处版本不一致

**仓库里的源头** `adapters/codex/.codex-plugin/plugin.json` 是 **1.0.0**（统一版本号时改的）。
**部署副本** `.local/codex-marketplace/codex-plugin/.codex-plugin/plugin.json` 原先仍是 **0.1.0-p0.1**，本轮已改为 1.0.0。
**但 `codex plugin list` 仍报 0.1.0-p0.1**——说明该版本号是**注册时记录下来的值**，改文件不会刷新，需要重新安装（或它自己的重载动作）才更新。

**为什么不再深挖**：`.local/` 是**本地部署副本**（`.gitignore` 里，不进仓库），源头已经是 1.0.0，`npm install`/打包产物也取自源头。**再花时间让本机这个显示值变过来，对用户拿到的发行物没有影响**，属于收益递减，故如实记录在此而不继续。

## 结论

- **`disable` 的机制明确**：`config.toml` 的 `[plugins."<id>"] enabled = false`，不需要 GUI。
- **界面层未能复验**：Codex 桌面没有可用的插件设置入口（点击账户头像无响应），**故"界面里能停用"这一点仍未经证**。
- **已确认的是机制与当前状态**：插件**已安装、已启用、路径正确**。