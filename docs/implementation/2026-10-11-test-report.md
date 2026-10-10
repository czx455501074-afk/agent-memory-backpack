# 本轮全部测试报告

**执行时间**：2026-10-11 01:48（Asia/Shanghai）
**对象**：`D:\huange-skill`，Agent Memory Backpack
**命令**：`npm test`（= `npm run build && node --test dist/test/*.test.js test/*.test.mjs`）

## 总结果

```
tests   191
pass    190
fail      0
skipped   1
duration  10.8s
```

**跳过项**（唯一一个，非失败）：

```
packaged core CLI and MCP run from a Chinese whitespace fixture directory
  → 需要 AMB_ARTIFACT_DIR 指向打包产物才运行
```

该项在指定产物路径后单独运行的结果见下文「跳过项的独立验证」。

## 逐文件明细（23 个 dist 测试 + 5 个 mjs 测试）

### dist/test/*.test.js

| 测试文件 | tests | pass | fail | skip |
|---|---|---|---|---|
| adapter-log.test | 6 | 6 | 0 | 0 |
| adapter-package.test | 5 | 5 | 0 | 0 |
| adoption.test | 7 | 7 | 0 | 0 |
| api.test | 6 | 6 | 0 | 0 |
| **archive.test** | **17** | **17** | 0 | 0 |
| backup.test | 13 | 13 | 0 | 0 |
| clean-install.test | 3 | 3 | 0 | 0 |
| cli-and-injection.test | 7 | 7 | 0 | 0 |
| **console.test** | **7** | **7** | 0 | 0 |
| desktop-accept.test | 3 | 3 | 0 | 0 |
| discovery.test | 8 | 8 | 0 | 0 |
| durability.test | 3 | 3 | 0 | 0 |
| operations.test | 13 | 13 | 0 | 0 |
| oversize-adoption.test | 3 | 3 | 0 | 0 |
| plugin-skills.test | 4 | 4 | 0 | 0 |
| protocol.test | 7 | 7 | 0 | 0 |
| readme-contract.test | 4 | 4 | 0 | 0 |
| rescan.test | 11 | 11 | 0 | 0 |
| security-review.test | 10 | 10 | 0 | 0 |
| skill-context.test | 5 | 5 | 0 | 0 |
| store.test | 16 | 16 | 0 | 0 |
| structure.test | 4 | 4 | 0 | 0 |
| tasks.test | 5 | 5 | 0 | 0 |
| **小计** | **167** | **167** | **0** | **0** |

### test/*.test.mjs（未编译，直接运行）

| 测试文件 | tests | pass | fail | skip |
|---|---|---|---|---|
| codex-hook.test.mjs | 15 | 15 | 0 | 0 |
| dsh-adapter.test.mjs | 3 | 3 | 0 | 0 |
| dsh-bundle-patch.test.mjs | 2 | 2 | 0 | 0 |
| dsh-runtime.test.mjs | 3 | 3 | 0 | 0 |
| package-smoke.test.mjs | 1 | 0 | 0 | **1** |
| **小计** | **24** | **23** | **0** | **1** |

`167 + 24 = 191`，与全量结果一致。

## 本轮为修复缺陷而新增/修改的测试

### 新增

**1. `test/archive.test.ts`（17 项，全新文件）**

覆盖本轮新增的单文件归档模块 `src/archive.ts`：

| 测试 | 验证什么 |
|---|---|
| 全表往返 | 所有权威表、历史、退役头、搜索索引逐行一致 |
| 是普通 gzip 文件 | magic `1f 8b`，另一台机器无需本插件即可解包 |
| 干跑不写 | 干跑后文件不存在、数据库不变，且预测与真实导入一致 |
| 非归档/外来 gzip 拒绝 | 报 `not a readable backpack file` |
| 缺失文件 | 报 `not found`，不伪装成空导入 |
| 路径穿越拒绝 | `../x`、`/etc/passwd`、`C:/...`、`a//b` 全部拒绝 |
| 篡改拒绝 | 破坏字节后拒绝，且目标库字节不变 |
| 凭据形态内容拒绝 | `api_key=sk-...` 拒绝且不留半个文件 |
| 重复导入幂等 | `imported=0`、`wrote=false`，历史与登记表不重复 |
| 本地较新版本存活 | 计入 conflicts，不被覆盖 |
| 失败整体回滚 | 注入晚期 SQL 失败，快照完全恢复 |
| 扩展名强制 | 非 `.ambpack` 拒绝 |
| 既有归档不覆盖 | 默认拒绝，`overwrite` 显式才替换 |
| 目录项/链接拒绝 | 手工构造 typeflag=5 的 tar，拒绝解包 |
| 无清单归档拒绝 | 报 `missing its manifest` |
| inspect 不写库 | 源库与目标库快照都不变 |

### 修改

**2. `test/console.test.ts`（7 项，本轮从 5 项增至 7 项）**

新增 2 项，都是为了锁住**真实使用中发现**的缺陷：

- `migration panel always reports conflicts and never shows a stale connection`
  锁三件事：冲突条数必须显示、必须**只显示一次**（我第一版修成了打印两遍）、取消对话框不得被当成连接成功。同时断言导出的每个失败分支都更新连接指示。

- `re-exporting over an existing archive works once the user confirmed replacement`
  **走真实 HTTP 层**，因为模块级保护本来就是对的，缺陷只在对话框与请求的接缝处。断言：未确认仍 409 → 确认后 200 → 覆盖后的文件仍可 `inspect`。

**3. 计数断言同步**（我新增 `amb_inspect_archive` 工具后必须更新）

- `test/protocol.test.ts`：MCP 工具名单加 `amb_inspect_archive`（10 → 11 个）
- `test/dsh-adapter.test.mjs`：注册工具名单同步（10 → 11 个）
- `test/dsh-runtime.test.mjs`：真实 ToolRuntime 工具数 `10 → 11`
- `test/adapter-package.test.ts`：`registered.length >= 10` → `>= 11`

**4. `test/readme-contract.test.ts`**

README 从「无安装入口的原型」改为「可一键安装」后，两项断言过时：安装段落名称、以及「必须说明尚未交付」的要求。改为断言新事实（安装脚本入口存在、桌面步骤仍需人工说明）。同时把 `backup`/`restore` 加入「必须带 `--data-dir`」的清单——这条测试**抓出了我写的 README 示例会静默写入另一个库**，是真缺陷。

## 跳过项的独立验证

`package-smoke.test.mjs` 需要产物路径。指定后单独运行：

```
AMB_ARTIFACT_DIR=<artifacts/latest.json 指向的目录>
node --test test/package-smoke.test.mjs
→ tests 1 / pass 1 / fail 0 / skipped 0
```

即：把跳过的那一项单独跑通后，**191 项全部有通过结果（191 通过 / 0 失败 / 0 跳过）**。

> **计数更正（2026-10-11 01:57）**：本节初稿写作「191 项 / 190 通过 / 0 跳过」，算术上不成立（191 − 190 = 1，却被写成 0 跳过）。独立核对者复跑后指出了这一点。正确关系是：全量一次运行下为 191/190/**1 跳过**，跳过项即 `package-smoke`；该项在给定产物路径后单独跑为 1/1/0 跳过；两次运行合并去重后 191 项均有通过结果。原文未做静默改写，此说明保留更正痕迹。

## 产物完整性（与源码分离的验证）

最新产物 `artifacts/p0-20261010174038206`，逐文件校验其自身清单：

```
产物哈希: 52 通过 / 0 失败
```

**重要区分**：最新产物与本轮桌面验收夹具所用的产物**不是同一份**。

| 项 | 产物 |
|---|---|
| `artifacts/latest.json` | `p0-20261010174038206`（含 GPU 修复、冲突去重、overwrite 传参） |
| 桌面验收夹具 `sourceArtifact` | `p0-20261010134533699`（**不含**上述三项修复） |

已实测确认夹具仍带旧代码：其 `console/renderer/app.js` 仍有重复打印冲突行的模式，其 `console/main.cjs` 没有 `disableHardwareAcceleration`。因此**不能把旧夹具上的真实 GUI 验证外推为最新修复已在桌面复验**。要复验这些修复，必须把夹具更新到最新产物。

## 本轮测试之外的真实使用验证

测试通过不等于功能可用，以下是测试套件之外、由真实使用取得的证据：

| 验证 | 结果 | 证据来源 |
|---|---|---|
| 跨设备迁移（A 导出 → B 导入） | 通过 | 2 条目完整迁移，中文标题保真，`knowledgeRevision` 一致 |
| 控制台覆盖导出 | **失败→已修** | 用户报 409；修复后回归测试覆盖，夹具复验待做（见上节） |
| 控制台 conflicts 显示 | **缺项→已修** | 旧夹具上的复核确认显示生效；数字重复打印已修，夹具复验待做 |
| 控制台 401/403 | 非缺陷 | 我的探测请求字段写错（`adapter` 必须等于凭据 id） |
| GPU 崩溃 | **已修** | 用户截图 `GPU process exited unexpectedly: exit_code=-1`；夹具复验待做 |
| DSH 自动注入 | 通过 | 会话记录 `source.kind="agent-memory-backpack"`，位于用户消息后、模型回复前 |
| **Codex 规范门禁** | **通过** | 见下节 |
| 端口冲突 | 真实问题 | Codex 发现我的残留核心占着 47631，已释放 |

## 门禁实测结果（独立核对者补充）

独立核对者用真实 hook 子进程 + 隔离核心，对三个工具名各发一次 `PreToolUse`，规范同时禁止 `exec` 与 `mcp__amb__amb_self_check`：

| 输入 `tool_name` | decision |
|---|---|
| `exec` | **deny** |
| `mcp__amb__amb_self_check` | **deny** |
| `amb_self_check` | no-deny |

这说明两件不同的事，必须分开读：

1. **门禁确实生效**：宿主实际传递的外层名 `exec` 和内层名 `mcp__amb__amb_self_check` 都能被拒绝。此前「工具名不匹配导致门禁失效」的担忧，在这两个名字上被证伪。
2. **裸名不被拒绝是既有边界，不是缺陷**：`amb_self_check` 不带命名空间前缀，与本项目已记录的规则一致——显式工具名禁止**不做别名归并**，因为等价关系取决于宿主的工具表而非本项目能推断的。README 早已写明「禁止 `Bash` 不会自动禁止 `pwsh`」。

证据文件：`gui-retest-20261011/exact-gate-evidence.json`。该脚本直接调用真实 hook 子进程，未使用 shell 或 HTTP 绕过路径。

## 未验证项（如实记录）

1. **Codex 桌面 hooks 信任入口的状态页面**：hook 的运行与拒绝行为已确认（见上节），但**信任状态页截图仍缺**。不能拿自动测试通过冒充该项桌面验收。
2. **DSH 完整链路**：本轮安装、失联恢复、停用新会话三项均无当前轮原始证据，仍待独立验证。
3. **控制台最新修复的桌面复验**：夹具仍是旧产物，需更新后才能在真实 GUI 复验 GPU 修复与冲突去重。
4. **控制台非零冲突的真实渲染**：独立核对者用渲染器 handler + 模拟 IPC 验证了 0 与 1 两种情形都正确；**真实原生窗口中的非零冲突导入**尚未构造。
