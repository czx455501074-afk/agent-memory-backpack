# agent-memory-backpack Codex 端复验记录

复验日期：2026-10-17（Asia/Shanghai）

## 1. 实际执行的命令或动作（含原文）

### 本地只读检查

在 `D:\huange-skill` 中执行：

```powershell
Get-ChildItem -Force | Select-Object Mode,Name; rg --files -g AGENTS.md -g '*plugin*' -g '*memory*' docs .
```

读取 computer-use 操作规范：

```powershell
Get-Content '<USER_HOME>\.codex\plugins\cache\openai-bundled\computer-use\26.1013.31256\skills\computer-use\SKILL.md' -Raw
```

AMB 历史知识检索调用原文：

```js
tools.mcp__amb__amb_search_universal({
  query: "agent-memory-backpack Codex 插件设置 停用 新会话 上下文注入",
  limit: 5
})
```

### 创建并检查启用态新会话

先列出 Codex 项目，再在 `D:\huange-skill` 项目中创建本次测试会话。创建调用原文：

```js
tools.mcp__codex_app__create_thread({
  title: "AMB 注入复验（启用态）",
  prompt: "请只回复“收到”。",
  target: {
    type: "project",
    projectId: "05a994bb-d56e-4e64-916f-25452794ab71",
    environment: { type: "local" }
  }
})
```

会话 ID：`01a14614-b502-7520-8a89-32a5aee6d9b9`。

随后向该会话提问，调用原文：

```js
tools.mcp__codex_app__send_message_to_thread({
  threadId: "01a14614-b502-7520-8a89-32a5aee6d9b9",
  hostId: "local",
  prompt: "本会话启动时的上下文是否包含以 [agent-memory-backpack] 开头的插件注入？如有，请逐字给出该注入的首行；只根据你实际看到的启动上下文回答，未见则明确说未见。"
})
```

读取新会话结果的调用：

```js
tools.mcp__codex_app__read_thread({
  threadId: "01a14614-b502-7520-8a89-32a5aee6d9b9",
  hostId: "local",
  turnLimit: 2,
  includeOutputs: true
})
```

### 查找可用设置界面

检查界面清单的原始调用：

```js
await cua.getState();
```

尝试枚举原生窗口的原始调用：

```js
await cua.listWindows();
```

该调用返回错误：`cua.listWindows is not a function`。

查询插件管理接口名称的原始表达式：

```js
ALL_TOOLS.filter(x => x.name.startsWith("mcp__codex_apps__plugin_management")).map(x => x.name)
```

结果只有 `get_app_permissions`、`get_plugin_dependencies`、`search_plugins`、`suggest_plugins`、`uninstall_app`、`update_app_permissions`；没有启用/停用接口。未调用卸载接口。

## 2. 观察到的原始证据

### 启用态注入存在

新会话收到的首条测试提示是“请只回复‘收到’。”随后该会话对启动上下文的检查原始回答为：

> 有。首行是：
>
> `[agent-memory-backpack]`

因此，本次新会话实际报告看到以 `[agent-memory-backpack]` 开头的注入。首行原文为：

```text
[agent-memory-backpack]
```

### 停用态注入证据

没有停用插件，也没有创建停用后的新会话；因此没有“停用后仍有注入”或“停用后无注入”的观察证据。

## 3. 无法完成的部分及具体卡点

无法完成停用态复验及复验后重新启用，卡在访问 Codex 插件设置 UI：

- 可用界面清单中 `apps` 为空；浏览器清单中 Codex MCP Apps 标签页为空，只有既有 Chrome 标签。没有可绑定的 Codex 原生设置窗口或设置页。
- 尝试调用 `cua.listWindows()` 枚举窗口，但当前界面工具没有暴露该函数，原始错误为 `cua.listWindows is not a function`。
- 可用的插件管理连接器未提供启用/停用动作；其结果没有可替代 UI 开关的停用接口。
- 因用户明确要求从插件设置中停用，未通过改本地设置文件或其他途径切换状态。
- 实际没有执行停用；故插件保持本次观测到的启用状态。没有重启 DSH，也没有修改代码。

## 4. 结论状态

| 项目 | 状态 | 依据 |
|---|---|---|
| codex-load | 通过 | 新建 Codex 会话成功运行并回复“收到”。 |
| codex-inject | 通过 | 新会话明确报告注入存在，并给出原始首行 `[agent-memory-backpack]`。 |
| disable | 无法验证 | 无法访问插件设置中的开关；未停用，因此没有停用后新会话的观察，也未执行重新启用。 |

本记录不代表停用缺陷已修复；该项需要在能操作 Codex 插件设置 UI 的环境中完成停用、新会话观察和重新启用复验。

