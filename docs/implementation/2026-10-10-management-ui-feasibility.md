# 管理界面可行性核实与实现决策

**时间**：2026-10-10（Asia/Shanghai）
**触发**：目标要求"核实并实现管理界面，须基于真实 DSH Slot/remote 契约，禁止臆造接口"。

## 一、核实过程与证据

全部结论来自读取本机 DSH 安装内容（`resources/app.asar`）与真实 Slot/Service 契约，未做猜测。

### 1. 面板插槽确实存在（可注册）

DSH 客户端插槽树中确有两个可用座位：

- `sidebar.panellist`（list，registration: `id` / `order` / `label`）——侧边栏底部面板图标
- `main`（keyed，key 为面板 id）——主区域内容

真实内部插件的注册写法（取自 `@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js`）：

```js
ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
  name: "sidebar.panellist", id: PANEL_ID, order: 0, label: () => t("panel"), locale: NS,
}, PluginsPanelIcon));
ctx.slots.inject("main", function* () {
  yield ctx.slots.register({ name: "main", key: PANEL_ID, locale: NS, ... }, PluginManagerPage);
  ...
});
ctx.layout.selectPanel(PANEL_ID);
```

双面插件声明格式（权威模板 `@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/templates/decoration`）：

```json
"exports": { ".": "./index.js", "./client": "./client.js" },
"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web", "immediately": true, "inject": [...] } }
```

客户端半必须用 `window.__ModuleLoader__.load({ id, factory })` 包装，浏览器半拿到的是受限符号集（`React`、`console`、`styles`、`host`），**没有 `fetch`**。

### 2. 关键阻塞：客户端半拿不到我的核心

三条证据合起来构成阻塞：

1. **渲染进程运行在 HTTP origin**：`main.js` 中 `window.loadURL(`${this.origin}/`)`，不是 `file://`。因此页面内发起的请求会带 `Origin` 头。
2. **我的核心拒绝带 Origin 的请求**：`src/server.ts:31` 明确 `if (req.headers.origin) throw new DomainError('origin_denied', ...)`——这是 P0 阶段的刻意设计，用来杜绝浏览器侧访问。
3. **第三方静态包无法自行新增 Remote 命名空间**：全仓搜索 `typert.remotes.register` 的调用点，只出现在应用装配层（`@deepseek-ai/dsh-api-gateway/lib/client.js`、`@deepseek-ai/dsh-typert-registry`）。`dsh-api-remotes` 的文档也写明"客户端不在运行时发现宿主的活动 Service 或 Remote 定义；新增能力需要显式的 `/remote` 值导入并在该装配层挂载"。

客户端半虽可用 `host.call(method, args)` 调用**自己**的主机半（`harness.handle(method, fn)` 注册），但那属于动态插件沙箱路径，且仍需主机半能访问核心——主机半可以访问，这条路技术上可行，但需要一个由 DSH 加载的双面插件包，并把核心客户端逻辑放进主机半。

结论：**内嵌面板要在 P0 核心现状下工作，必须先放开核心的 Origin 策略**，而那会削弱"浏览器不可访问核心"这条既有安全边界，且需要把适配器令牌交给渲染进程。

## 二、实现决策

按用户明确要求（"本地管理界面必须是 exe 桌面端的 UI 界面，不要用 http"），采用 **Electron 独立桌面应用**：

- 令牌**留在主进程**，渲染进程通过 IPC 取数据，凭据永不进入页面上下文。
- 主进程复用与适配器相同的核心客户端逻辑，因此核心的既有安全边界（拒绝 Origin、要求 Bearer 令牌与协议头）**无需放宽**。
- 不修改 DSH 或 Codex 的任何文件，不占用它们的插槽，也就不会与宿主既有 UI 冲突。

这与联合规划 §3.3 并不矛盾：规划写的是"先提供两端都能打开的本地页面，不先开发独立 Electron 桌面应用"，那是 P0 阶段"先验证"的建议；用户后续明确要求桌面 UI，且核实表明内嵌路径会迫使核心放宽安全边界，因此改选独立应用是更合适的取舍。此判断记录在此，供双方复审。

## 三、待验收项

- Electron 应用可在本机启动并显示真实数据（需真实运行验证）。
- 令牌不出现在渲染进程可见的任何位置（可用进程检查与页面 DOM 检查验证）。
- 核心不因该应用而放宽任何既有策略。
