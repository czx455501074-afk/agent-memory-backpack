# 部署记录：66c6f62 上线（2026-10-20 20:15）

本轮把工作区全部改动提交并推送到 GitHub，然后把新构建部署到本机两个宿主。

## 一、提交

| 项 | 值 |
|---|---|
| 提交 | `66c6f62` feat: auto-classify at intake, bridge bilingual queries, and gate unsupported claims at injection |
| 父提交 | `7704f0c` |
| 推送 | `1c5058b..66c6f62 master -> master`（成功） |
| 暂存文件 | 53 个：源码、测试、验证脚本、`docs/implementation/` 文档 |

提交前剔除了 4 个不该进仓库的东西：`01a-amb-tool-surface.md`、`03a-db-shape.md`（子代理未完成的骨架）与 `verification/amb-tool-surface.mjs`、`verification/db-shape.mjs`（写了但没跑通，不能当证据）。它们留在工作区未跟踪，需要时重新验证后再提交。

提交面复核：无 `.local/`、无 `artifacts/`、无 `*.sqlite`、无密钥；`.gitignore` 已覆盖这些与 `docs/handoffs/`。

## 二、打包

```
npm run pack:local
→ artifacts/p0-20261020121401793
→ Desktop acceptance passed (20 checks)
→ 轮转保留 3 份产物
```

## 三、部署

顺序按仓库规定：**停核心 → 部署 → 起核心**（核心运行时部署必然 EBUSY）。

| 步骤 | 结果 |
|---|---|
| 停核心 | pid 16892 停止，端口 47631 无监听 |
| `npm run deploy:plugin` | dsh-plugin → `toolchains/.../agent-memory-backpack`；core → `toolchains/.../core`；desktop 与 web 均 `active=true linked=yes` |
| 备份 | 6 份（插件目录、core 目录、两个 profile 的 package.json 与 node_modules） |
| 起核心 | pid 3640，`/health` 返回 `{"protocolVersion":1,"status":"ok","phase":"P0"}` |

## 四、版本判定的坑：`deployedAt` 不可信

`verify-host-deployment` 报 `RUNNING DEPLOYED BUILD`，但它的 `deployedAt` 是 **12:09:50Z**，而本次打包发生在 **12:14:01Z**——时间戳早于构建本身。拿它当"装的是最新"的证据会误判。

改用产物与部署副本的 SHA-256 逐一比对：

| 文件 | artifact | deployed | 一致 |
|---|---|---|---|
| `core/runtime/store.js` | E48E5B438E36E4F4… | 同 | 是 |
| `core/runtime/domain-taxonomy.js` | B7CE3FFEAE2FBCC3… | 同 | 是 |
| `dsh-plugin/index.mjs` | 8CA7854F70FCB956… | 同 | 是 |

`domain-taxonomy.js` 是本轮新增文件，旧构建里根本不存在——它出现在部署副本，是"装的是新构建"的硬证据。

## 五、端到端验证（对新核心）

用真实提交验证，而不是看日志自述：

| 观察点 | 部署前提交（dcaafd98 / ece7a939） | 部署后提交（a4991018） |
|---|---|---|
| `declared`（调用方声明） | kind/scope/durability | kind/scope/durability + domain |
| `inferred`（插件推断） | `null` | `memory/project/durable/plugin-ops` |
| `evidenceRefs` | 0 | 5，且 5 条全部 `autoCollected` |

同一份 `memoryContext.domain` 参数，部署前被旧核心以 `HTTP 400 Unrecognized key: "domain"` 拒收，部署后被接受——这是"新 schema 已生效"的直接对照。

## 六、还没生效的部分

`deploy:plugin` 只换磁盘上的包与核心，**宿主进程内的工具注册要重启 DSH 才刷新**。所以现在：

- 已生效：核心侧全部新行为（自动取证、自动分类、双语句 token 分流、召回缺口提示）。
- 未生效：工具列表里的新描述与面板改动，直到 DSH 重启。

重启 DSH 会中断当前会话，这一步留给用户决定。

## 七、回滚

部署脚本留下 6 份备份，路径在 `deploy:plugin` 输出里。回滚方式：停核心 → 用 `*.backup-13016-1792498475804-*` 覆盖回去 → 起核心 → 再次哈希比对确认回到旧版。
