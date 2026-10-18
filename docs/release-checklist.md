# 发布清单（Agent Memory Backpack）

本清单回答一个问题：**现在能不能发。** 每项都必须能指向一条命令或一个文件，不接受"应该没问题"。

## 一、阻塞项（未解决就不发）

| # | 项 | 现状 | 判据 |
|---|---|---|---|
| B1 | **审核门禁必须在服务端强制** | ✅ 已修，有测试 | `Store.approveProposal` 内部调用 `classificationApprovalGate`（`src/store.ts` 的 2591 起，门禁在 2622）：缺判定、或 `autoPromotable` 为 `false`、或显式 `false` 时，必须带 `classificationAcknowledged: true` 才写入。三条入口各有测试——网页单条、网页批量（批中混有需确认项时整批拒绝并给出条数）、适配器路径（拒绝与理由回到适配器）——另有边界测试要求字段缺失与显式 `false` 都需确认、显式 `true` 不受影响。见 `test/classification-gate.test.ts`。 |
| B2 | **存量候选的分类判定未回填** | ✅ **已闭环**（代码 + 真实库都已执行） | `reclassify` 默认 dry-run、`--yes` 才写，只重算 `pending`，payload 记录 `classifierVersion`，重跑幂等。**真实库已回填**：`r5-live-verify` 的「待审候选的判定带判定器版本」实测 **39/39（100.0%）**，全脚本 **12/12 通过**（回填前该条必然 FAIL）。⚠️ **2026-10-17 之前本节写的是"真实库尚未执行"，那是过期状态；引用本项前先重跑 `r5-live-verify`。** |
| B3 | **捕获管线把自身并发冲突当经验候选** | ✅ 已修 | `refine.ts` 引入 `FailureOrigin`（`tool_collision` / `environment` / `task_failure`），且工具互踩与环境类签名**不进入阈值统计**（运行报告打印被排除的签名条数）。 |
| B4 | **备份与迁移可用** | ✅ 已修（2026-10-18） | 修复前：`amb backup` 一律失败且只报一句结论，导入侧还会拒绝导出侧放行的索引行——**这台机器无法备份**。现在守卫报出定位与规则名、`--redact-credentials` 提供出路、导出/导入规则对称。判据：`node --test dist/test/backup-redact.test.js` **7/7**；真实库 redact 导出 18.0 MB → `restore` 进空库**成功**（909 条 / 跳过 1 条 / 版本 2710），源库零改动。详见 `docs/implementation/backup-migration-unblocked-2026-10-18.md`。 |

**判断**：四项**代码层面均已修复**，B2 的真实库回填也已执行完毕。B4 的**边界要一并说清**：`--redact-credentials` 保证的是"权威正文里的凭据形状值不进包"，不是"包里绝对没有任何凭据形状的字节"（派生索引的文本已被分词规范化，替换可能不完整）；被改写来源的草案不随包迁移。

## 二、发布前必过（每次都跑）

```powershell
npm test                     # 全量；0 失败才能继续（prepublishOnly 也会跑一次）
node verification/contracts.mjs       # 逐条契约：此前每一轮的交付是否还在（31 条）
node verification/knowledge-normalization.mjs  # 落库规范化普查（只读，恒 0：报告而非门禁）
node verification/project-map.mjs              # 仓库结构对账：导览是否过期、有无未登记顶层目录
node scripts/r5-acceptance.mjs        # 离线验收：检索可达规范 / 回执诚实
node scripts/r5-live-verify.mjs       # 对运行中的核心验收（需核心在跑）
node scripts/verify-deliverables.mjs  # 交付清单的粗粒度核对
node scripts/verify-tool-surface.mjs  # MCP 工具面与服务端 admin 白名单对账
node --test dist/test/clean-install.test.js   # 发布面不得含机器路径
node --test dist/test/backup-redact.test.js   # 备份守卫的定位/替换/对称（B4）
npm pack --dry-run --json             # 包内容：不得含 .pyc、凭据、本地库
```

**迁移链路要单独跑一次往返**（只测导出会漏掉一半问题，B4 就是这么漏的）：

```powershell
$tmp = Join-Path $env:TEMP ('amb-roundtrip-' + (Get-Random)); New-Item -ItemType Directory $tmp
node dist/src/cli.js backup  --file "$tmp\a.ambpack" --redact-credentials --yes
node dist/src/cli.js init    --data-dir "$tmp\lib"
node dist/src/cli.js restore --data-dir "$tmp\lib" --file "$tmp\a.ambpack" --yes
```

**复核这类脚本时的一个坑（本清单的复核者踩过）**：`npm pack --dry-run --json` 的 `files` 数组里，文件名字段是 **`path`**，不是 `name`。按 `name` 取值会静默得到一列空字符串，于是"包里有 README"被判成"没有"——**检查写错字段名不会报错，只会给出错误结论**。


判据与已知基线：

- `npm test`：**794 项 / 792 通过 / 0 失败 / 2 跳过**（2026-10-18 实测；两项跳过是 opt-in 检索测量，需要调模型；跳过项必须带原因打印）。本清单此前记的是 685/683——**这个数字每轮都会变，引用前必须重跑，不要抄**。
- `verification/contracts.mjs`：**31 / 31 成立**（2026-10-18）。
- `verification/project-map.mjs`：**顶层 27 条 = 已登记 27 + 历史快照 0 + 未登记 0**（2026-10-18 清理后基线；清理前是 120 条 = 27 + 93 快照）。`artifacts/` 下的 `p0-*` 打包副本应 **≤3**（轮转上限见 `scripts/package.mjs` 的 `ARTIFACT_KEEP`）——**这个数字重新上涨就说明轮转失效了**。
- 本轮新增能力的三条专属判据（都是 `npm test` 的一部分，单独跑更快）：`node --test dist/test/backup-redact.test.js`（导出守卫的定位/替换/对称）、`node --test dist/test/redact-on-write.test.js`（写入前脱敏）、`node --test dist/test/injection-data-boundary.test.js`（注入数据边界）、`node --test dist/test/archive-distill.test.js`（回合结束提炼只写候选表）、`node --test dist/test/embedding-fusion.test.js`（可选向量层：默认关闭 / 覆盖不足拒绝 / 失败降级）。
- `verification/knowledge-normalization.mjs`：**912 条 / 原文型 66 条（7.2%）/ 原文型占用约 104 万字符**（2026-10-18 实测基线）。判据与处置见 `docs/implementation/knowledge-normalization-before-write.md`。**这个数字是基线不是门禁**：它只回答"要改写多少"，新写入按规范执行后该比例应逐步下降。
- `r5-acceptance`：检索可达规范 **PASS**；**回执诚实 FAIL**——见第六节，这是当前唯一未解决的发布门禁项。
- `r5-live-verify`：**12/12**（2026-10-18 实测）。其中 `mode=model` 证明走的是生产路径而不是降级路径——**这一项如果显示 `local_index`，说明验收脚本在测另一条路，结论作废**。
- `npm pack --dry-run`：**90 个文件、498KB**（2026-10-18 实测），含 `README.md` / `LICENSE` / `CHANGELOG.md`，不含 `__pycache__`、凭据或本地库。

## 三、版本与文档

1. `package.json` 的 `version` 与本版发布说明一致（当前 `1.0.0`；本轮修复批次若单独发布，建议 `1.1.0`——它含新能力而不只是修复）。
2. `CHANGELOG.md` 的「未发布」段落要么随版本发布改标题，要么明确保留。
3. `README.md` 里的事实需要复核（**测试数、能力清单、已知限制**三项最容易漂移：本轮就发现测试数写着 564 而实际是 641，注入去重的机制描述写反）。
4. 依赖版本是精确固定的（`@modelcontextprotocol/sdk`、`zod` 无 `^`），`engines.node` 写明 `>=24.13.0 <25`。

## 四、打包与安装验证（发布面从零开始）

```powershell
npm run pack:local           # 产物写入 artifacts/，含 node --check 全量语法门
npm run deploy:plugin        # 部署到宿主 profile（读穿链接复核）
node scripts/verify-host-deployment.mjs   # 判断宿主是否真的加载了新构建
```

- `verify-host-deployment.mjs` 必须报 **RUNNING DEPLOYED BUILD**。若报 PREVIOUS BUILD，**先重启宿主再谈验收**——本项目已经因为忽略这一步而把排查方向带偏过一次。
- **核心是独立常驻服务，不随宿主退出**：宿主重启后旧核心仍在服务，需要单独 `amb service stop` / `start`，否则会出现"适配器已更新、核心还是旧代码"。这一条务必写进发布说明。
- 从零安装验证：干净目录 `npm i <tarball>` → `node_modules/.bin/amb init` → `amb doctor`，确认能起来再发。

## 五、回滚与善后

- 部署脚本会保留三组备份（插件目录、core 目录、profile 的 `package.json` 与链接），路径打印在部署输出里。
- 代码回滚点写在每次发布的 release notes 里；本轮为 `552a9f9`、`ec1fc1d`、`6f6c25a`、`4dc8a2c` 之后的提交。
- 发布后检查一次真实库的 `pending` 规模与 `in_progress` 任务数，确认没有因为新逻辑把队列或任务表推向更糟。

## 六、明确不阻塞发布、但必须写进说明的

- 宿主侧任务归档接线尚未在真实宿主里被触发过（需重启后看 `task.archived` 日志）。
- 指针级注入在真实宿主上尚未发生过（114 轮样本为 0），重新部署重启后才会出现。
- 失败事实去重键仍含 sessionId（刻意保留：改了会让"出现次数"无法增长）。
- 排序长度因子来自单一样本，未做分布级调参。
- 仅支持 Windows x64。
- **本地自动匹配路径的质量尚未达到产品级**：盲测夹具（18 用例，`test/retrieval-blind.test.ts`）当前为精确率 **0.381**、召回率 0.727、该弃权时正确弃权 **4/7**，而夹具自身的 `acceptance` 字段是 `quality-gaps-present-not-product-acceptance`。已知缺口为版本适用性（v1/v2 互串、不支持的版本应当弃权却返回一切）与同义改写漏检。**本版不得被描述为"精准检索已达成"。**
- `gaps` 仍可能列出**词内 bigram 伪片段**（例如"回预"）：中文按重叠二元组切分，而条目里该词组可能分开出现，于是回执会报出对读者没有意义的"缺口"。它不影响选择结果，彻底解决需要真正的中文分词。
- **可选向量层默认关闭，且未在真实嵌入服务上端到端验证**：机制有测试钉住（默认关闭时结果不变、覆盖率不足拒绝融合、服务失败回落词法、**词法匹配不到的查询由向量补上**），但**没有用真实嵌入服务跑过一遍**——本机没有配置该凭据，只有替身。在真实服务上验证之前，**不得声称"混合检索已生效"**；启用方式（两个环境变量）与设计取舍见 `CHANGELOG.md` 的未发布段。
- **回合结束提炼的候选尚未在真实宿主上被人工看过**：接线与安全性质（只写派生候选表、提案数与知识版本不变、无信号不产候选）都有测试，但"一个真实的会话结束后候选是否如期出现"需要重启宿主后观察一次 `task.archived` 日志里的 `distilled` 字段。

## 七、回执诚实：已解决（以及判据为什么这样写）

**状态：`r5-acceptance` 两项均 PASS（2026-10-18）。** 下面保留原现象与**为什么没有靠放宽门槛解决**，因为这条的处理方式比结论更值得留下。

### 原现象

查询「排查接口超时要带协议头防 426」在**降级路径**（`selection.mode=index`、`reason=local_index:not_configured`）下，本地索引把它排第一（正文含"排查超时必须带协议头"），而 `store.prepare` 的严格匹配器 `automaticRelevance` 对同一条得出零证据（body 覆盖率约 0.42 < 0.5），于是被"零证据注入"门槛整体滤掉。回执给出 `matchedTokens: []`，并把**整个查询**列进 `gaps`——读者只能读成"库里没有这个主题"，而库里刚为它找到了条目。

### 为什么没有放宽门槛

门槛是**保护**，不是缺陷。改之前先测：`verification/r5/selection-noise-rate.mjs` 实测**无关查询零证据注入 0/32**（保护有效），相关查询 8/12 注入、其中 3 次含零证据条目（模型路径的正常行为）。放宽 `bodyCoverage` 会直接动第一组数字，而第一组数字正是它存在的理由。**所以修的是回执的语义，不是选择层的门槛。**

### 实际修法（三处，都在回执侧）

1. **`gaps` 回到字面含义**：一个片段只有在库里确实不存在时才算覆盖缺口。判定用库自己的索引（`workflow_search`）。**范围刻意收窄到 `withheld` 场景**——索引确实选出过候选、却被证据门槛拦下时。没有候选在手上时，"检索过、没命中"的既有语义保持不变（既有测试钉住它，而且它说的是真话）。
2. **新增 `withheld`**：如实说明"索引选出 N 条候选但未通过字面复核，本次未注入"，并让 `hint` 给出对应解释（而不是"库内没有"）。
3. **新增 `selectionBasis`**：当条目因**模型语义选择**被注入、而没有任何字面命中词时，回执说明依据是模型选择——"注入了却没说为什么"与"按语义注入"是两件事。

### 判据也改了，而且改得更严

原判据是 `matchedTokens.length > 0`，而脚本头部描述的属性是"命中的词不能同时被报成缺口"——**实现与描述不是同一件事**。现在的判据是三条：命中词与 `gaps` **无交集**（原描述的本意，此前从未实现）、注入了条目就必须说明依据、没有注入也没有命中词时不得声称覆盖缺口。

**它经过反面验证**：把第 1 条的扣除逻辑摘掉（模拟旧行为）后，脚本报 `FAIL 把库内存在的片段报成覆盖缺口：426、排查、查接、接口、口超`；恢复后 PASS。**一个不能失败的新判据，和没有判据是一样的**——第一版判据就是因为只检查"`withheld` 字段在不在"而放过了一次故意回退。

### 仍未解决的（不在本节）

- **本地匹配质量**本身没变：盲测夹具（18 用例）精确率 **0.381**、召回 **0.727**，`acceptance` 字段仍是 `quality-gaps-present-not-product-acceptance`。本节修的是"回执怎么说"，不是"匹配有多准"——**本版仍不得被描述为"精准检索已达成"**。
- `gaps` 仍可能列出**词内 bigram 伪片段**（如"回预"）：中文按重叠二元组切分，彻底解决需要真正的中文分词。
