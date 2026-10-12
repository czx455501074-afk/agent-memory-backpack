# F22：核心离线时 Codex 被自己的策略钩子全面锁死

- 日期：2026-10-13（时间均为北京时间）
- 发现场景：用户要求在 desktop profile 安装 `dsh-computer-use-win`，再用它控制 Codex 跑"DSH 桌面版插件安装后的全面操作测试"
- 结论：**真缺陷，且属于最严重的一类**——一个可选的知识服务，在它自己离线时把整个 agent 锁死

## 1. 现象

Codex 会话（标题「测试 DSH 插件安装后操作」）向用户报告：

> 目前测试被环境拦截，尚未执行任何操作，也未修改项目。Agent Memory Backpack 的策略服务不可用，
> 自动审批钩子因此拒绝了报告读取、账户额度查询和电脑控制调用。请先恢复该策略服务。

会话记录里对应的工具调用结果：

```
Tool call blocked by PreToolUse hook: Agent Memory Backpack policy service is unavailable;
this supported tool call was blocked.. Tool: mcp__cua_repl__js
```

即：**Codex 的一切工具调用**（读文件、查额度、computer-use）全被拦，Codex 什么也做不了。

## 2. 根因

链条完整且每一步都有证据：

1. **核心没在运行。** `core.lock` 里是 pid 11732（已不存在），47631 端口无监听。
   数据目录 `~/.agent-memory-backpack` 里的 `core-service.log` 显示核心**曾经**启动过。
2. **钩子在服务够不到时 fail-closed。** 市场包里的 `scripts/hook.mjs` 直接：

   ```js
   deny("Agent Memory Backpack policy service is unavailable; this supported tool call was blocked.");
   ```

3. **Codex 侧没有任何人负责拉起核心。** 市场包的 `scripts/` 只有 `hook.mjs`、`log.mjs`、
   `resolve-config.mjs`——**没有 `ensure-core.mjs`**。核心由 DSH 侧或人工启动。

因果对照实验（`compare-hook-degradation.mjs`，同一输入只改"服务答不答"）：

| 钩子副本 | 核心不可达时的决定 |
|---|---|
| marketplace（Codex 实际运行） | **`deny`** |
| repo（仓库源码） | **`allow`**（降级放行） |

**同一份输入，只差一份副本，结果完全相反。**

## 3. 关键判断：修复早已存在，是部署件过期

仓库源码 `adapters/codex/scripts/hook.mjs` 里已经有正确实现，且注释写明了理由：

```js
// The service being unreachable is not the same as "this call is denied".
//
// Denying here blocked every tool whenever the core was down, which made an
// optional knowledge service a single point of failure for the whole agent.
// The design requires degrading visibly: enforce what a snapshot still knows,
// and otherwise step back and say so.
```

所以**不是设计缺陷，而是市场包里的钩子是旧版**（fail-closed），缺了：

| 文件 | 作用 | 市场包（旧） |
|---|---|---|
| `gate-cache.mjs` | 策略快照降级判定 | **缺** |
| `ensure-core.mjs` | 核心不可达时尝试拉起 | **缺** |
| `spool.mjs` | 事件本地缓冲（BUG-M3） | **缺** |
| `node-version.mjs` | Node 版本闸门（BUG-H5） | **缺** |

顺带印证：市场包的 `resolve-config.mjs` 仍是 `warning: null` 的静默回退（BUG-H7 修复前的样子），
而仓库版已给出可见告警。

## 4. 修复与验证

**已执行**：把仓库版 7 个源文件部署到市场包 `scripts/`（先整目录备份，哈希校验一致后再覆盖；
两份 `log.mjs` 原本就字节相同，说明该目录本是仓库文件的副本）。

**验证（正面）** —— 部署后市场副本行为翻转：

```
● marketplace（Codex 实际运行）  decision = allow（无输出，即放行）
● repo（仓库源码）               decision = allow（无输出，即放行）
→ 两份副本都在核心不可达时降级放行：修复已到位
```

**验证（反向，5/5）** —— 降级**不等于关掉策略引擎**，快照里已知的禁令仍须生效：

| 检查 | 结果 |
|---|---|
| 核心不可达 + 快照记录 `deniedTools:[write,…]` → `write` 被拦 | ✅ `write is prohibited by the last policy snapshot; the core is currently unreachable.` |
| 同上 → `Bash "echo hi > notes.txt"` 被拦 | ✅ 同一启发式生效 |
| 同上 → `Bash "ls -la"` 放行 | ✅ |
| 同上 → `read` 放行 | ✅ |
| 快照 `deniedTools:[]` → `write` 放行 | ✅ 不凭空拦截（机器当前的实际快照状态） |

**同时恢复了服务**：核心已在 47631 上运行，`health` 返回 `protocolVersion: 1, status: ok`；
数据文件大小在启停前后一致（23814144 字节），未受影响。

## 5. 两个必须记住的运维事实

1. **弹性的必要条件** `AMB_CORE_ENTRY`：钩子靠 `ensure-core.mjs` 拉起核心，它按
   `AMB_CORE_ENTRY` → `process.argv[1]` → `<root>/runtime/cli.js` → `<root>/dist/src/cli.js`
   依次找入口。市场包的入口是 **`runtime/cli.js`**，所以要让"核心离线也能自愈"，
   必须设置 `AMB_CORE_ENTRY=<市场包>/runtime/cli.js`，否则钩子找不到入口、只能降级。
2. **降级是"可见的"**：核心不可达时会记 `hook.degraded` 警告，并在快照可用时按 `ReadOnlySnapshot`
   执行已记录的禁令；快照不可用（缺失/过期/身份不符）时进入 `Ungoverned`，此时**只放行、不拦截**。
   这不是"策略失效"，而是"没有可依据的快照时不做臆断"。

## 6. 我在此项诊断中犯的错（如实记录）

- **探针把快照写错了目录**：`dataDir` 是 `dirname(configPath)`，我却写到嵌套的
  `.agent-memory-backpack/`，于是快照不可见、钩子正确地报"从未应答过"。这是我本会话第三次
  因"读了代码不用的路径"而得到笃定但错误的结论。
- **探针没镜像端点的规范化形式**：钩子用 `new URL()` 规范化端点，存快照时带尾斜杠
  （`http://127.0.0.1:47699/`）；我手写的快照没有斜杠，被判"属于另一个核心"而正确忽略。
  当时我一度以为这是"端点比对 bug"，查证后确认**代码是对的**——忽略身份不符的快照是**安全的正确行为**，
  否则一个来自别的项目/核心的旧策略会被错误套用。

两次都是**测量对象搞错**，不是被测代码有问题。两处已写进各自探针的注释，避免后人照着错结论去"修"正确实现。

## 7. 尚未处理的同类问题

`scripts/amb-uninstall.mjs` 的 Codex 处理只覆盖**工作区级** `<workspace>/.codex/config.toml`，
而 Codex 桌面版把插件记在**用户级** `$CODEX_HOME/config.toml`（`[marketplaces.<name>]` +
`hooks.state."<plugin>@<marketplace>:…"`）。卸载用户级安装目前没有脚本支持。
