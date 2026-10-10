# P0 DSH Desktop 接入证据（只读探测）

> 2026-10-10更正：下文是10月9日静态探测。真实ToolRuntime随后证明仅依赖pre-execute waterfall拒绝不够，现已加最终同步guard，见development-status.md和test/dsh-runtime.test.mjs。UserMessage的source不要求固定kind:user；已安装MessageSourceMap明确允许producer扩展，当前实现使用agent-memory-backpack并单独保留原用户消息。当前5项DSH测试通过，但真实桌面/Agent持久化仍未验证。

探测日期：2026-10-09（Asia/Shanghai）。范围：官方 DeepSeek Harness 桌面与当前本机 DSH 发布包契约。未安装插件、未写入 profile/配置、未读取或输出凭据。下面的版本/API证据来自本机已安装构件；桌面端接入链路尚未以新插件实测。

## 已确认的本机位置与版本

- 官方桌面进程正在运行；可执行文件：`<USER_HOME>\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe`。Windows 文件属性 `FileVersion=0.2.0-rc.2`、`ProductVersion=0.2.0.0`。安装资源含 `resources\app.asar`，没有通过它反编译或推断内部 loader 行为。
- 当前桌面 profile 文件：`<DSH_HOME>\data\profiles\desktop\package.json`；声明 DSH profile bundles，见第 14–29 行。该 profile 目录含 `node_modules`，其核心发布包通过共享包根解析：`<DSH_HOME>\data\profiles\node_modules\@deepseek-ai`。
- 契约核心版本：`@deepseek-ai/dsh`, `dsh-agent`, `dsh-agent-loop`, `dsh-tools`, `dsh-session`, `dsh-llm`, `dsh-app-boot` 均为 `0.1.7-rc.1`；`@deepseek-ai/cordis=4.0.4`、`cordis-plugin-loader=1.0.5`、`schemastery=3.18.4`。具体依据各包 `package.json`，例如 [dsh package.json](<DSH_HOME>/data/profiles/node_modules/@deepseek-ai/dsh/package.json)、[dsh-agent package.json](<DSH_HOME>/data/profiles/node_modules/@deepseek-ai/dsh-agent/package.json)、[dsh-tools package.json](<DSH_HOME>/data/profiles/node_modules/@deepseek-ai/dsh-tools/package.json)。这里的 profile package manifest 不是桌面 Electron 的包版本。
- 已读 `<DSH_HOME>\user\.agents\skills\plugin-write\SKILL.md`。本目标是外部插件，必须以精确目标版本发布 exports/types 为准；不能把 monorepo 私有/workspace 契约当作已发布 API。其 form 指引指向 [hook-plugin.md](<DSH_HOME>/user/.agents/skills/plugin-write/references/hook-plugin.md) 与 [service-plugin.md](<DSH_HOME>/user/.agents/skills/plugin-write/references/service-plugin.md)。

## API 能力矩阵

| 能力 | 结论 | 真实接口 / 证据 |
|---|---|---|
| 每个 step 前注入上下文 | 可用，模型可见内容有 session log 支撑 | `Agent.inject(message: UserMessage): void`，`dsh-agent/lib/types/runtime-types.d.ts:200–209`；UserMessage 来自 `dsh-llm/lib/types/message.d.ts:124–145`，需要 `id`、`content`、`source:{kind:'user'}`、`role:'user'`。`agent/pre-step` 可审核/替换本步消息，定义在同文件约 300 行以后。 |
| 阻止 tool 执行 | 可用，发生在 tool body 前 | `tools/pre-execute(exec: ToolExecution, next:()=>Promise<PreToolDecision>): Promise<PreToolDecision>`，`dsh-tools/lib/types/index.d.ts:30–49`；决定类型含 `{kind:'deny', reason}`，同文件 `PreToolDecision` 声明。该 waterfall 不调用 `next()` 即短路，参考 hook-plugin.md 的 tool pipeline 说明。 |
| 注册 tool | 可用；注册自动归 Cordis fiber 清理 | `ctx.tools.register(definition):()=>void`，`dsh-tools/lib/types/index.d.ts:631`。`ToolDefinition` 在同文件 `:115+`，包含 schema、强制 `output` 声明和 `execute(args, exec)`；工具执行需可协作响应 `exec.signal`。 |
| agent step 提前钩子 | 可用；可拒绝当前 step 或改入参 | `agent/pre-step(payload:{agent,messages:UserMessage[],turn,step,signal}, next:()=>Promise<PreStepDecision>)`，`dsh-agent/lib/types/runtime-types.d.ts:~290–330`。`PreStepDecision = {kind:'reject'} | {kind:'enter',messages,startsRequestSeries?}`，同文件 `:92–99`。使用 waterfall 必须 await `next()` 才委派；不委派则短路。 |
| agent request 钩子 | 可用，但不是改 prompt 内容通道 | `agent/request(payload:{agent,turn,step,signal}, next:()=>Promise<LlmCallConfig>)`，同 runtime-types.d.ts 的 `agent/request` 段。类型说明允许替换 frozen call config；模型可见内容要走已记录的消息渠道。 |
| 事后 agent/session 生命周期 | 可观测 | `session/event(this:Scoped<Session>, session:Session, event:SessionEvent):void`，`dsh-session/lib/types/index.d.ts:63`。这是 Cordis 通知，真正的生命周期类型放 `event.type`，不能监听 `turn/start` 作为 Cordis 事件。 |
| 事后 tool 生命周期 | 可观测 | `tools/result(exec:Readonly<ToolExecution>, result:Readonly<ToolExecutionResult>):undefined`，`dsh-tools/lib/types/index.d.ts:~85–95`，只读且冻结。 |
| durable event 类型 | 可用 | `dsh-session/lib/types/types.d.ts:255+` 的 `SessionEventMap` 包含 `turn/start`, `turn/end`, `step/start`, `step/end`, `tool/call`, `tool/result` 等；只应通过 `session/event(session,event)` 读取。 |

### P0 最小实现样例（接口示意，未在运行时执行）

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'

export const name = 'p0-desktop-probe'
export function apply(ctx: Context) {
  ctx.on('agent/pre-step', async (payload, next) => {
    // 纯观测时保留原消息，务必委派给既有 waterfall。
    return next()
  })
  ctx.on('tools/pre-execute', async (_exec, next): Promise<PreToolDecision> => next())
  ctx.on('session/event', (_session, event) => {
    // 用 event.type 做受控诊断；不记录对话内容/凭据。
    void event.type
  })
}
```

如果要加注入验证，应由测试 plugin 在测试 Agent 的 `agent/pre-step` 中调用 `payload.agent.inject(userMessage)`，并在隔离 session log 上验证注入事件。不要在原桌面 profile 上试验。上面示意不注册 tool，因此避开了尚未验证的 ToolDefinition output schema 细节；接入 tool 的最小签名以 `ToolDefinition` 声明为准。

## Profile 加载与隔离试验入口

- DSH CLI 的 `@deepseek-ai/dsh` `0.1.7-rc.1` 有公开 `./profile-boot` export；其声明文件 `dsh/lib/types/profile-boot.d.ts` 记载 `prepareProfile()`、`runProfile()`。CLI `dsh --profile <name>` 在 `dsh/lib/bin.js`；`dsh plugin --profile <name> <pnpm args...>` 是 profile 内 package 操作入口，源码注释在 `dsh/lib/plugin-*.js`。 profile bundle 清单由 profile 的 `package.json` 中 `dsh.profile.bundles` 声明；bundle patch 与 profile `cordis.patch.yml` 叠加。
- 隔离时可把 `DSH_HOME` 指向专用临时目录，再创建独立 profile/package manifest，确保 profile 根仅含 `@deepseek-ai/dsh-base` 和待测插件 bundle；启动使用本机同版本 `dsh --profile p0`。若用 CLI 初始化模板，`dsh --profile p0 --from-default-profile desktop` 会复制模板 bundle 列表，属于非最小桌面组合；package manager 的 `dsh plugin --profile p0 add <本地插件路径>` 会改变该临时 profile 的 manifest 与 lockfile。CLI 接受环境变量隔离的依据：`dsh-home-paths/lib/index.js:~65–90`，`DSH_HOME` 是默认 home 的 override；`dsh/lib/types/profile-boot.d.ts` 说明 profile 初始化会创建/读取 profile 文件。
- **建议的最小隔离路线**：从空临时目录设 `DSH_HOME=<temp>`；创建 `profiles/p0/package.json`，声明 `dsh.profile.bundles` 为 `@deepseek-ai/dsh-base` 与 P0 插件，并声明该插件为 `file:` 依赖；使用可解析这组精确 `@deepseek-ai/* 0.1.7-rc.1` 的临时 `node_modules`（可通过指向本机共享包目录的临时 fixture 依赖解析）。随后仅在此 `$DSH_HOME` 启动 `dsh --profile p0`。这是从当前 CLI/profile 机制推导出的建议，尚未运行验证；不要对 `<DSH_HOME>\data` 或默认 `~/.dsh` 写入。
- **不确定项**：官方桌面 Electron 从何处确定 profile 绝对路径、桌面是否使用上述 DSH CLI `runProfile`/同一 Loader 实例、是否能通过 CLI profile 替代启动桌面 UI，都不能仅凭当前进程与文件静态证明。app.asar 存在但本次没有分析其内容。需在临时 profile/package 准备好后用真实官方桌面启动/插件呈现做验证；隔离 CLI composition 可覆盖 hooks、工具拒绝、事件签名、agent 注入及 package loading，但不能证明桌面前端UI接入/桌面自身 profile 路径。

## 建议的验证顺序

1. 只在 `$DSH_HOME` 临时树准备最小 `p0` profile 与本地 `file:` 插件，先确认 DSH 能解析发布 package exports 并启动。
2. composition 插件里仅订阅 `agent/pre-step`、`tools/pre-execute`、`session/event`；通过测试 Agent/工具验证 waterfall 委派与拒绝；禁止真实副作用。
3. 单独验证 `agent.inject()` 的 UserMessage 格式与 session replay，再决定是否进入官方桌面 profile 的接入实现。
4. 官方桌面需要单独实测：桌面实际加载 profile 路径、插件包扫描/动态加载、桌面 app 对 agent/tool API 的桥接与 UI 可观测状态。不要由 CLI composition 成功推断这些能力。

## 事实与推断分界

**事实**：进程 executable/version；desktop profile manifest 的 bundle 机制；本机 exact package versions、exports、类型声明签名；DSH_HOME 环境覆盖；CLI profile 和 plugin 命令入口。

**未验证推断**：从公开 DSH CLI 的 Loader composition 将来可较低成本搭一个与桌面同版本的独立测试 profile。该测试不能替代桌面实际加载路径验证。

**未验证/不得猜测**：桌面内部 profile resolver/bootstrap、pre-step 面向 UI 的行为、官方桌面是否读同一包目录/Node module graph。app.asar 没有被检查，且本次不触碰配置。
