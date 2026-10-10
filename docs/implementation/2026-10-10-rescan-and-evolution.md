# 周期性重扫描与经验演进记录

**时间**：2026-10-10（Asia/Shanghai）
**来源**：用户明确要求——「需要周期性扫描，冲突内容以最新记录为准，工作过程中验证后推翻旧经验、补充旧经验」

## 一、对「以最新记录为准」的实现理解

你的指令是**优先顺序**，不是「删掉旧的」。本项目的修订本就不可变（`revisions` 追加式、绝不修改），因此实现为：

> 新版成为当前生效版本；旧版退出默认检索，但正文永久保留，并记录「谁取代了谁、为什么、依据什么」。

这样既满足「最新为准」，也保住可追溯性——否则日后无法回答「当初为什么改」。这一取舍已写入代码注释与测试断言。

## 二、周期性扫描

### 触发与节奏

- **扫描根与周期持久化**到库：`scanRoots`、`rescanIntervalMs`（默认 86400000 ms = 1 天）、`lastRescanAt`。
- **定时任务在核心里**（`serve` 期间每 60 秒检查一次是否到期）。放在核心而非适配器，因为核心同时握有数据库与文件系统访问权，不依赖桌面端是否打开。
- 未配置扫描根时定时任务**空转并只更新时间戳**，不产生副作用。

```powershell
node dist/src/cli.js serve --data-dir DIR --roots "PATH1,PATH2" --rescan-interval 86400000
```

### 差异判定（`rescanDiff`）

以**来源路径**为身份（文件内容变化时身份不变），内容哈希区分是否变化：

| 状态 | 含义 | 处理 |
|---|---|---|
| `new` | 首次出现 | 采纳 |
| `unchanged` | 路径与内容都没变 | 不动 |
| `changed` | 同路径、内容不同 | **以最新为准自动刷新** |
| `vanished` | 曾采纳、现已消失 | **只报告，不自动退场** |

`vanished` 刻意不自动退场：路径可能只是暂时缺失（磁盘未挂载、目录改名），据此自动删除用户知识属于破坏性行为。移除仍是明确动作。

### 单个来源隔离

一个来源失败（例如对应条目已被退场）不会中断其余来源，失败被收集到 `errors` 而不是抛出。

## 三、工作过程中的推翻与补充

### 两种动作的含义区分

| 动作 | 语义 | 效果 |
|---|---|---|
| `supersede` | 旧结论**被推翻** | 新版生效，旧版退场，链路留存 |
| `supplement` | 旧结论**需补充** | 两者都保持生效（补充不是矛盾） |

### 强制理由与证据

`supersede` / `supplement` 都必须提供 `reason` 与 `evidence`，否则拒绝。这落实了「agent 自述不是独立验证」的原则：一次推翻必须能说明依据是什么。

```powershell
node dist/src/cli.js supersede --old ID --new ID --action supersede \
  --reason "实践中旧顺序会失败" --evidence "任务 T-42 复现失败，改序后通过"
node dist/src/cli.js history --id ID
```

### 演进链路（`supersessions` 表）

记录 `old/new` 的条目 ID 与版本、动作、理由、证据、来源（`rescan`/`agent`/`user`），以及**是否覆盖了本地编辑**。`history --id` 汇总当前状态、全部版本与完整链路。

## 四、过程中发现并修复的真实缺陷

**刷新会静默复活已退场条目**。测试「单个来源刷新失败不中断其余来源」时发现：`importInsideTransaction` 的 `ON CONFLICT ... status='active'` 会让已被退场的条目在来源刷新时重新变为生效。

这违反联合规划明确写的「恢复历史产生经审核的新当前版本，**不连带复活**失效规范」。已修复：`refreshAdoption` 在目标条目非 `active` 时明确报错（`not_active`），拒绝以刷新之名复活。

## 五、验证

新增 `test/rescan.test.ts`（11 项）：

- 推翻：新版生效、旧版退出检索，但旧正文仍可从 `revisions` 读出；
- 补充：两条都保持生效；
- 推翻必须有理由与证据，禁止自推翻与跨类型取代；
- `history` 给出当前状态、全部版本与链路；
- 重扫描四类状态判定；
- 「最新为准」就地刷新且保留旧版（同一 ID、2 个版本、1 条链路）；
- **本地编辑被覆盖时明确告警**，三个版本（来源初版/本地编辑/来源新版）全部留存；
- 消失来源只报告不自动退场；
- 单来源失败不阻断其余来源；
- 周期可配置、未到期不重复扫描；
- 扫描根持久化。

真实环境端到端（CLI 实测）：

```
1) dry wouldAdopt=2   adopted=2
2) rescan(no change): new=0 changed=0 unchanged=2 vanished=0  refreshed=0 adopted=0
3) rescan(changed+new+vanished): new=1 changed=1 unchanged=1
   refreshed=1 adopted=1 errors=0   entries before=2 after=3   supersessions=1
4) history: revisions=2 chain=1 action=supersede origin=rescan current=active
5) lastRescanAt set: true
6) 消失来源: vanished=1, entries retained=2（未自动退场）
```

全套 **82 项测试，81 通过，1 条件跳过**。

## 六、技能结构化转换

采纳的 skill 以原文保存并标记 `needsStructure`，**不会被当作已核实的完整方法**。把原文转成真正的 workflow 阶段需要**语义判断**：有序步骤、检查项与完成判据无法从 Markdown 可靠推导，程序编造它们就是伪造方法。因此实现的是**机制**而非推断：

- `structure` 命令（CLI）与 `amb_structure_skill`（DSH + MCP 两端）
- 结构由**调用方提供**（人或模型阅读技能后撰写），`--evidence` 强制填写依据，`derivedBy` 记录整理者
- 新流程生效与原技能退场**在同一事务**内完成；技能原文永久保留在 `revisions`，转换写入取代链路
- `unstructured` 命令列出待处理技能
- 拒绝空步骤结构、拒绝缺依据、拒绝自取代、拒绝非 skill 目标、拒绝已退场技能

### 真实技能端到端验证

在真实用户技能目录上实测（`~/.agents/skills`）：

```
adopted: 14 entries
awaiting structure: 14
target: "某运维判据技能" rev=1 leaves=4 body=8339 chars
structure without evidence refused: true
structured: workflowId=…-workflow retiredSkillRevision=1
awaiting structure after: 13 (was 14)
skill history: status=retired revisions=1 chain=1
chain: supersede skill:cb5277c279bcf16f -> skill:cb5277c279bcf16f-workflow (agent)
workflow: status=active kind=workflow
```

即：8.3 KB 正文 + 4 个参考文档的真实技能被正确转换，原技能退场但完整保留，链路可追溯，待处理数减一。

**仍未做**：把现有 13 个已采纳技能逐一结构化。这需要逐个阅读并撰写结构，不是机械操作；机制已就绪，工作本身须由人或模型完成。

## 七、真实桌面端验收（唯一未完成项）

**真实 DSH / Codex 桌面端的加载、hooks 信任与自动触发尚未验收**。此前所有结论都来自代码路径、隔离运行库与打包产物层面的验证，不能替代桌面实测。

可执行清单与证据模板见 `desktop-acceptance-checklist.md`，其中明确了哪些步骤必须由用户手动完成（安装、信任、观察注入），以及每一项需要留下的证据。核心契约核实与可行性结论见 `2026-10-10-management-ui-feasibility.md`。
