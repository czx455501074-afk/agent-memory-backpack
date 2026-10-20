# DSH 会话实际负载构成拆解

状态：已完成（只读分析）

数据来源：`%USERPROFILE%\.dsh\sessions\--<项目目录 slug>--\session-f15ed313-d07a-402a-8260-6872632ec28a\session.v4.jsonl.zstd`
解压副本写入系统 `%TEMP%`，未改动仓库任何其他文件，未访问真实知识库。

## 1. 文件物理形态

| 项 | 实测值 |
|---|---|
| 压缩文件字节 | 642,410 |
| zstd 帧数 | 229（追加写入的多帧拼接，单帧解压只能拿到 196 B 的 session 头） |
| 解压后字节 | 2,421,120 |
| JSONL 行数 | 432 |
| 记录类型数 | 30 种 |

`node:zlib` 的 `zstdDecompressSync` 只解第一帧，必须按魔数 `28 B5 2F FD` 切段逐帧解压后拼接，否则会把 2.4 MB 会话误判成 196 字节。这是本次分析的前置坑。

## 2. 记录类型分布

高频类型（共 30 种）：

| 类型 | 条数 |
|---|---|
| tool/call | 60 |
| tool/result | 60 |
| step/start | 40 |
| step/end | 39 |
| assistant/message | 35 |
| user/message | 29 |
| agent/inbox/spliced | 25 |
| job/registered | 23 |
| job/settled | 23 |
| assistant/attempt | 18 |
| llm/retry | 15 |
| llm/retry-started | 14 |
| session-log-deepseek/delivery-accepted | 14 |
| subagent/catalog | 9 |
| turn/start | 5 |
| turn/end | 4 |
| request/header | 3 |
| request/context | 3 |

记录级键：`type`、`seq`、`time`、`data` 为通用骨架；`surfaceOp` 出现 125 次，`sourceEventSeqs` 60 次。

## 3. 单条记录字节 Top 10

| 序 | 类型 | 字节 |
|---|---|---|
| 142 | request/header（reason=change） | 336,098 |
| 341 | request/header（reason=resume） | 336,018 |
| 16 | request/header（reason=initial） | 334,740 |
| 14 | user/message（技能目录注入） | 331,894 |
| 9 | system/message（operator prompt） | 115,633 |
| 80 | tool/result | 55,065 |
| 161 | assistant/message | 42,212 |
| 167 | assistant/message | 38,956 |
| 178 | assistant/message | 37,310 |
| 391 | assistant/message | 35,506 |

前 5 条即占全文件约 60%，负载高度集中在「请求头 + 系统提示 + 技能目录」三处。

## 4. 请求快照与工具定义

**有快照，但只是半个。** `request/header` 的 `data.header` 只有两个键：

| 键 | 内容 |
|---|---|
| `config` | 81 B |
| `tools` | 372 个工具定义，334,546 B / 333,854 字符 |

`messages` 与 `system` 不在 header 里。完整请求体需拼三处：`header.tools`（工具定义）、`system/message` 记录（系统提示）、`user/message` 与 `assistant/message` 记录（对话历史重放）。

三条 header 的 `reason` 分别为 `initial`、`change`、`resume`，工具数均为 372，字符数 333,854 与 335,156。

按前缀分组（初次快照）：

| 分组 | 工具数 | 字符数 | 占比 |
|---|---|---|---|
| `mcp__rea__` | 207 | 192,872 | 57.8% |
| 内建（`pwsh`/`read`/`write`/`edit`/`workflow` 等） | 71 | 53,451 | 16.0% |
| `mcp__github__` | 43 | 47,413 | 14.2% |
| `mcp__wincu__` | 24 | 20,479 | 6.1% |
| `ops_*` | 11 | 9,813 | 2.9% |
| `amb_*` | 16 | 9,453 | 2.8% |

单工具最大：`mcp__rea__inspect_analysis_view` 7,315 B、`mcp__rea__capture_process_scenario` 4,697 B、`mcp__github__issue_write` 3,648 B、`pwsh` 3,507 B、`workflow` 3,405 B。

## 5. 系统提示

`system/message` 仅 1 条，`role=system`，`content` 为单元素 text 数组：115,520 B / 105,425 字符。内容为 operator prompt（身份锁定、TASK PRIORITY、MODEL SELECTOR 等），其中**不含** AMB 标记。

## 6. usage 实测

共 35 条 `assistant/message.data.usage`。字段为 `inputTokens`、`outputTokens`、`totalTokens`、`cacheReadTokens`。

| 位置 | input | output | total | cacheRead |
|---|---|---|---|---|
| 首条（i=20） | 41,429 | 455 | 159,004 | 117,120 |
| 末条（i=425） | 1,599 | 233 | 244,520 | 242,688 |

`totalTokens` 是上下文总量口径，`inputTokens` 为本轮未缓存新增，`cacheReadTokens` 为缓存命中部分。会话从 15.9 万涨到 24.4 万 token，涨幅约 8.5 万，与后续 tool/result 累积量级一致。

## 7. AMB 注入实测

标记出现次数与字符数（按消息体正文计，非 JSON 转义后字节）：

| 标记 | 次数 | 字符 |
|---|---|---|
| `[Project knowledge context]` 整段消息 | 9 | 20,228 |
| `【AMB 双向记忆】` 横幅段 | 6 | 3,581 |
| 其中独立消息内（i=11） | 1 | 1,541 |
| 其中嵌在 projectCtx 消息内 | 5 | 408 × 5 = 2,040 |
| `[memory-data]` | 0 | 0 |
| 技能目录 `<available_skills>`（宿主注入，非 AMB） | 1 | 144,996 |
| `### 任务日记` 块 | 5 | 含于上面 20,228 内 |

**AMB 独立注入去重后合计 21,769 字符**（20,228 + 1,541）；若把 projectCtx 消息内重复出现的横幅再算一遍则为 23,809 字符。

9 条 projectCtx 消息分布：i=12（5,049）、i=140（2,773）、i=281（3,472）、i=309（709）、i=315（2,751）、i=337（2,850）、i=356（661）、i=374（722）、i=390（1,241）。

本会话没有 `[memory-data]` 包裹块，记忆资料以 `### 任务日记`（5 处）和 `[AMB 自动检索并读取：task/failure]`（7 处）直接嵌在 projectCtx 段内。

## 8. 一次请求的构成与 token 粗估

估算口径：CJK 字符按 1 字符 ≈ 1 token，其余（ASCII、标点、空白）按 4 字符 ≈ 1 token。这是估算，不是实测分词结果。

| 组成 | 字符数 | CJK 字符 | 估算 token |
|---|---|---|---|
| 工具定义（372 个） | 333,854 | 319 | 83,703 |
| 系统提示（operator prompt） | 105,425 | 3,405 | 28,910 |
| 技能目录注入 | 144,996 | 7,012 | 41,508 |
| AMB 注入（去重） | 21,769 | 约 9,300 | 约 12,200 |
| 工具定义 + 系统提示小计 | 439,279 | — | 112,613 |

固定开销（工具 + 系统 + 技能目录 + AMB）合计约 60.6 万字符，估算约 16.1 万 token。首个 usage 的 `totalTokens` 为 159,004，两者误差约 1%，说明这份估算口径可用于后续预算核算。

关键结论：**工具定义一项就吃掉 33.4 万字符（约 8.4 万 token，占固定开销一半以上）**，其中 `mcp__rea__` 207 个工具独占 19.3 万字符。AMB 本体 2.2 万字符只占固定开销约 3.6%，真正的大头不是 AMB。

## 9. 未取得项

| 项 | 原因 |
|---|---|
| 各条 usage 的逐轮完整序列 | 已取得 35 条原始记录，本次只抽首末两条做对比，未逐条列表 |
| 服务端真实分词数 | 会话记录只存 usage 汇总，不存分词明细 |
| 工具定义是否被上游裁剪 | 记录侧无法判断；header 显示 372 个，实际是否全部发送需抓包验证 |
| 历史消息在请求中的实际字节 | header 不含 messages，只能由记录重放推算，未做重放序列化 |

## 10. 对 AMB 改造的直接含义

工具目录 33.4 万字符是最大的单点成本，其中 `mcp__rea__` 19.3 万字符对一个不跑逆向工程的会话几乎全是死重。系统提示 10.5 万字符里有大量重复的注入对抗段。技能目录 14.5 万字符由宿主一次注入、不受插件控制。AMB 自身注入 2.2 万字符，占比小，但 9 条 projectCtx 里有 4 条是 400 字以内的 Task Handoff 重复注入，存在合并空间。
