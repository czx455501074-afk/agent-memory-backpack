# 采纳闭环与上下文预算修复记录

**时间**：2026-10-10（Asia/Shanghai）
**本轮起因**：用户要求「安装后主动扫描已有 skill/规范/记忆，安全存储，不影响插件运行的内容不搬入，不破坏进行中的工作」。

## 一、新增：可逆采纳

### `adoptions` 账本（`src/store.ts`）

新增表记录每条被采纳条目的来源路径、内容哈希、所属批次时间与撤回时间。它**只引用知识库自身的 ID，不引用宿主文件**，因此撤销只影响插件数据库。

### `adopt()` / `revokeAdoption()`

- `adopt()` 在单个事务内完成：校验 → 写入新版本 → 记账。批次内任一条失败则整体回滚，不留半写。
- `revokeAdoption()` 只撤回该批次，且**只撤回版本号仍是采纳时那个的条目**。若某条目在采纳后被用户编辑过，则保留并报告为 `skipped`，理由是 `edited since adoption`——避免把用户后续工作静默丢弃。
- 重复撤回同一批次会明确报错（`No active adoption batch`），不是静默成功。

### CLI

```powershell
node dist/src/cli.js discover                       # 只读扫描
node dist/src/cli.js adopt                          # 干跑：只说明会采纳什么
node dist/src/cli.js adopt --yes                    # 确认采纳，打印撤销命令
node dist/src/cli.js adopt --revoke <时间戳>          # 一键撤销该批次
```

## 二、修复：已采纳知识在检索中不可见

**发现的真实缺陷**：`norms()` 只返回 `norm`，`search()` 只返回 `workflow`，FTS 索引也只为 workflow 建立。结果是在真实环境采纳 22 条（含 20 个技能）后，这些技能**在 `prepare` 中完全不可见**——用户采纳了却永远用不到。

**修复**：

- FTS 索引扩展为覆盖 workflow、skill、memory（仍排除 `norm`，规范走独立通道）。
- 新增 `knowledge(projectId, query)`：检索已采纳的技能与记忆，技能连同其叶子文本一起索引，因此**搜叶子主题也能找到入口**，不会返回孤立片段。
- 新增 `readKnowledge(projectId, id, includeLeaves)`：按 ID 展开全文；默认不返回叶子正文。
- 新增 `/v1/knowledge/read` 端点、MCP 工具 `amb_read_knowledge`、DSH 工具 `amb_read_knowledge`。

## 三、修复：上下文预算失控

**实测发现的第二个真实缺陷**：把技能正文整篇内联进 `prepare` 后，真实环境（22 条采纳）上下文膨胀到 **26k–53k 字符（约 9k–17k tokens）**，远超规划设定的 2k–4k token 预算，且随查询词增长。这与规划「先返回摘要与读取入口，正文按需展开」直接冲突。

**修复**：`prepare` 只为技能/记忆返回有界摘要（默认 400 字符）与调用提示，并报告正文原始长度：

```
已采纳技能 skill:xxx@1 某运维判据技能（含 4 个参考文档）（正文 8339 字符，需要时调用 amb_read_knowledge 读取）［尚未结构化：原文保存，未经核实为完整方法］
摘要: …（截断）
```

**修复后实测**（同一 22 条采纳库，4 种查询）：

| 查询 | 上下文字符 | 约 tokens |
|---|---|---|
| 空 | 5280 | 1760 |
| 查找本地流程资料 | 5294 | 1765 |
| 技能标题关键词 | 5282 | 1761 |
| codex desktop integration | 5298 | 1766 |

已落入 2k–4k token 预算。展开行为可验证：`readKnowledge` 不带叶子返回正文 8339 字符、叶子正文 4×0；带 `includeLeaves` 才返回 2597/5826/3971/4131 字符。

## 四、类型诚实性

新增两种知识类型，避免把不同性质的内容混为一谈：

- `skill`：采纳的技能，原文 + 叶子 + `needsStructure: true`。**不伪造 workflow 结构**——触发条件与有序步骤无法从 Markdown 可靠推导，编造即等于伪造方法。
- `memory`：背景事实，与 `norm` 分开，避免把「记住的事」当作「必须遵守的要求」。

`prepare` 上下文中二者标签不同（`已采纳技能` / `背景记忆`），未结构化的技能额外标注 `［尚未结构化］`。

## 五、测试

新增 `test/adoption.test.ts`（6 项）与 `test/skill-context.test.ts`（4 项，含摘要边界与展开）。全套 **70 项测试，69 通过，1 条件跳过**。

关键断言：

- 采纳与撤销前后，源文件树的 SHA-256 签名完全一致（真实环境 301 文件零改动）。
- 被编辑过的条目在撤销时保留并报跳过。
- 技能不在 `search()` 的 workflow 结果里出现。
- 叶子主题能找到所属入口。
- 摘要必须被截断且报告原始长度。

## 六、尚未完成

- 周期性重扫描。
- 技能结构化转换（把 `needsStructure` 的原文转为真正的 workflow 阶段）。
- 真实桌面端的安装与验收。
