# W2 分类器诚性：经验不再被自动升格为硬规范（R5，2026-10-17）

本文件是本轮 W2 的交付说明。每条结论都附可核对的证据：`文件:行号`、测试输出，或对真实库的**只读**回放统计。凡是没做到的，写在最后一节，不写成已完成。

## 一、旧判定与缺陷成因（改动前实测）

旧判定只有一条正则（`src/semantic.ts:65`，改动前）：

```ts
function isNormative(text: string): boolean {
  return /(?:禁止|严禁|不得|必须|务必|规范|硬性要求|绝不|强制要求)/.test(text);
}
```

两个条件叠加成了缺陷：

- `src/semantic.ts:128`（改动前）：`if (hasNorm) kind = 'norm'` —— 规范优先级最高，一个词就压过整段文本里所有其它信号。
- `adapters/dsh/index.mjs:643` 的 `AUTO_PROMOTE_KINDS` 含 `norm`，`:666 entryFromClassification` 据此一键采纳（`:694-707` 直接由 classification 造出知识条目）。

而且词表里的 `规范` 是**名词**，它本身不表达任何义务；`必须/不得` 在中文经验写作里几乎必然出现，用来描述"我这次遇到的事"。于是"含某个词"被当成了"这是一条规则"。

**改动前依赖该判定的调用点（全部核过）**

| 调用点 | 作用 | 受影响方式 |
|---|---|---|
| `src/store.ts:1442` | `submit()` 内构造 `classification`，`:1495-1496` 用 `relation`/`needsSplit` 决定 `conflict`，`:1524` 写 `important`（影响 `expireProposals` 的豁免） | 候选记录里的 kind/needsSplit 随新判定变化；`important` 的判定面因此收窄 |
| `src/model-review.ts:35` | 模型不可用时的启发式回退 `analysis` | 返回结构新增字段；`:71` 模型路径的返回值也补齐了新字段（见第六节） |
| `adapters/dsh/index.mjs:668-707` | 面板"一键采纳"用 `payload.classification` 造条目 | **本轮未改**，因此线上行为不会因本次提交立刻变化；新字段是给接线用的 |
| `adapters/codex/*`、`src/ui.ts`、`src/cli.ts` | 只读展示/透传 `payload.classification` | 新增字段为可选读，无破坏 |
| `src/discovery.ts:393` | 另有自己的 `classifyKnowledgeDoc`，**不调用** `classifyCandidate` | 不受影响 |

`test/semantic.test.ts` 是唯一直接引用 `classifyCandidate` 的既有测试。

## 二、新判定

### 2.1 判定一条文本是不是规范：三个条件同时成立（`src/semantic.ts:187`）

1. **约束词命中**（`:104` `DEONTIC_ANCHOR`）：`禁止|严禁|不得|必须|务必|绝不|强制要求|硬性要求`。**移出了 `规范`** —— 它是名词，移除的理由是"它不表达义务"，不是为某个样例让路。
2. **该词支配一个实词从句**（`:124` `IMPERATIVE_CLAUSE`）：约束词后面必须紧跟一个**非空**内容片段（汉字/字母/数字/路径符号，允许其中含空格）。`必须带 x-amb-protocol: 1 请求头` 通过；"这是因为必须满足某些条件"这类从句里的出现不通过。
3. **文本不是经历叙述**（`:172` `isNarrativeExperience`）：命中强标记，或**两个不同**的弱标记，或标题带命名自己是经验体，即判为叙述 —— 此时即使 1、2 都成立也不判 norm。

**为什么这三条能分开经验与规则**

- 经验写作与规则写作的差别不在"是否出现约束词"，而在**约束词是否在命令某件事**（条件 2），以及**整段话是不是在报告一件发生过的事**（条件 3）。一条真规范在讲"下一次怎么做"，一段经验在讲"这一次发生了什么"。
- 强标记（`:135`）取的是**只能出现在叙述里**的东西：日期、`实测/踩坑/复现/跑通/报错/日志显示/根因/复盘/教训`、harness 自己写的 `自动捕获/待核实/尚未验证/失败事实`、自指的 `本记录/本文`，以及 `真实案例/真实排障/实例：/本例`。它们不可能出现在一条被下达的规则里。
- 弱标记（`:146`：`发现|观察|结论|总结|注意点|排查|步骤|记录`）要求**两个不同词**同时出现。单看一个词不足以定性 —— 反例就写在注释里：`若发现问题必须上报` 是一条规则，只有一个词，因此不被误降。
- 标题带（`:156`，只看前 48 字）用来接住"…闭环法：/…经验/…复盘/…判据："这种把自身命名为经验体的写法。只看标题带是有意的：同样的词出现在真规范正文里（`按流程执行`）不构成任何声明。

**kind 决策（`:296` 起）**：`norm` 仍最高优先，但只有通过上面三条才进入该分支；其后 `preference → material → skill(流程) → memory`。经历叙述且不是可复用流程的，落到 `memory`。

### 2.2 "可自动升格"判据（`:210` `promotionVerdict`，字段在 `:43` 的 `SemanticAnalysis` 上）

取值口径来自 `src/schema.ts`：`provenance` = `user|external|agent`（`:39`），`evidence` = `observed|verifiable|self-reported|unverifiable`（`:48`）。调用方通过新增的第三个参数 `ClassificationContext`（`:36`）传入；**默认值是候选的真实身份**：`provenance: 'agent'` + `evidence: 'self-reported'`（与 `src/store.ts:1307-1311` 计算审核层级所用的事实一致）。

| 情形 | `autoPromotable` | `promotionBlockedReason` |
|---|---|---|
| `kind !== 'norm'` 且 `scope !== 'global'` | `true` | 无 |
| `kind !== 'norm'` 且 `scope === 'global'` | `false` | 作用域为 global，扩到所有项目需人工确认 |
| `kind === 'norm'` 且是经历叙述 | `false` | 文本是经历叙述，不能升格为硬规范 |
| `kind === 'norm'` 且 `provenance === 'agent'` | `false` | 插件自身推断不足以升格为参与门禁判定的硬规范 |
| `kind === 'norm'` 且 `evidence` 为 `self-reported`/`unverifiable` | `false` | 证据等级不足 |
| `kind === 'norm'` 且无来源引用（`sourceRef` 或文本内 `AGENTS.md`/`CLAUDE.md`/URL/`来源：`/`依据：`，`:159`） | `false` | 缺少权威来源引用 |
| `kind === 'norm'` 且 `scope === 'global'` | `false` | 把单项目约束推广到所有项目需人工确认 |
| `kind === 'norm'` 且来源与证据均达标、非叙述、非 global | `true` | 无 |

净效果：**一条 agent 提交的规范候选默认不可一键采纳**，而外部权威（`AGENTS.md` 一类来源 + `verifiable` 以上证据）仍可自动。

## 三、正反样本回放（测试）

`test/classification-honesty.test.ts`（新增，6 个测试）：

- **经验型 7 段**（改写自真实库 pending 文本，已抹掉机器路径与用户名）：自动捕获的失败事实模板（含"不得"）、实测构建经验（含"必须"）、排查判据清单（含"不要"）、会话复盘（含日期与"不要用"）、方法论标题"闭环法"（两处"必须有"）、本会话自造 id 问题（含"必须先"）、带"实例："的计数陷阱（含"不要用"）→ 断言全部**不是** `norm`，并断言具体 kind（均为 `memory`）。
- **规范型 6 段**：其中 4 段是本项目库中**已采纳规范的原正文**（接口超时归因、日志窗口可比性、打包语法门禁、超时预算判定），另 2 段是既有测试样本（生产库禁则、分支推送禁则）→ 断言仍为 `norm`。反向样本是必须的：只证明"经验不再判 norm"的测试，在判定被改成"一律 memory"时同样会通过。
- **autoPromotable 4 组**：agent 自述规范 → `false`（原因含 `provenance=agent`）；外部权威但 global → `false`（原因含 global）；外部权威但 `self-reported` → `false`；外部权威 + `verifiable` + `AGENTS.md` → `true` 且 `promotionBlockedReason === undefined`；用户给出的规则 → `true`。
- **边界两条**：同一约束的叙述写法（含"实测"）判 `memory`、规范写法判 `norm`；规范里出现"例如"仍判 `norm`（举例不是经历）。

结果：**6/6 通过**。

## 四、真实库离线回放统计

工具：`scripts/classification-replay.mjs`（新增；`node:sqlite` + `readOnly: true`，**只读、不写库**，输出前把机器路径替换为 `<USER_HOME>`）。

口径：`proposals.state='pending'` 全量；「改前」按旧正则重算（与库中记录的 kind 完全一致，说明记录确由旧判定产生）；「改后」调用新 `dist/src/semantic.js` 的 `classifyCandidate(text, [])`（`existingEntries` 不影响 kind）。

快照：2026-10-17 14:2x（本地），pending **313**（运行期间库仍在增长：311→314，其它会话持续写入；比率以 313 为口径）。

| 指标 | 数值 |
|---|---|
| 库中记录的 `kind = 'norm'` | **229** |
| 旧规则重算 norm | 229（与上一致） |
| 新判定 norm | **13** |
| 降级（旧 norm → 新非 norm） | **216**（占旧 norm 的 94.3%） |
| 反向新增（旧非 norm → 新 norm） | **0**（改动只收紧、不放松） |
| pending 中 norm 占比 | 229/313 = **73.2%** → 13/313 = **4.2%** |

降级目标分布抽样（真实样本）：harness 自动捕获的失败事实 → `memory`；实测构建经验、会话复盘、"…闭环法"方法论、白屏/性能排查 → `memory`；含外部链接的经验 → `material`（原有 `isMaterial` 优先，非本次改动）。

**残留 13 条**（全部列出，均含 id，便于复核）：

- 约束型（保留正确）：`070c7c34`（工具字段约束）、`373dfc54`（`$home` 是只读自动变量）、`421a3e52`（`--output` 必须单参数）、`5db30865`（上游 schema 不接受的写法）、`20a971a0`（失败注入序号必须对应真实操作序列）。
- **仍误判的方法论型经验 8 条**：`4137ac3b`、`ce301633`、`f5800722`、`b6fabdb2`、`84cf620d`、`4e5a8b9e`、`fde9ead7`、`9bc8c5d1`。

误判率变化（人工抽样定性，非全量标注）：

| 口径 | 改前 | 改后 |
|---|---|---|
| pending 中被判 norm | 229 / 313（73.2%） | 13 / 313（4.2%） |
| 其中确认为经验型（人工看样本） | 抽样 19 条中 19 条 | 13 条中 8 条 |
| 每千条候选的残留误伤 | — | ≈ 25 条 |

## 五、测试命令与结果

```
node node_modules\typescript\bin\tsc -p tsconfig.json --noEmitOnError false   # 产出 dist
node --test dist/test/classification-honesty.test.js                          # 6/6 通过
node --test dist/test/*.test.js test/*.test.mjs                               # 全量
node scripts/classification-replay.mjs --samples=0                            # 只读回放
```

全量（W2 汇总时最新一次）：**605 项 → 602 通过 / 1 失败 / 2 跳过**。前一次运行为 600 项 / 596 通过 / 2 失败 / 2 跳过 —— 数字在两次之间变化，是因为 W1 的在途文件仍在被编辑（`git status` 显示 `src/retrieval-service.ts`、`src/retrieval-index.ts`、`src/server.ts`、`test/retrieval-norm-recall.test.ts` 为在途状态）。

唯一失败项**不在 W2 范围内**：

1. `test/retrieval-service.test.js:103`：`deepStrictEqual` 期望缺 `source: 'none'`。`source` 是 W1 有意新增的字段 → **旧期望过时**，依据是"实际值多出的字段正是本轮新引入的能力，而不是行为回归"。修与不修属 W1 范围，本线未改它的期望。
2. 前一次运行中的另外两处已由 W1 自行修掉：`retrieval-norm-recall` 的 `no such table: workflow_drafts`（在途未完成，非旧期望过时）、`retrieval-service.test.js:107` 的 `literalneedle` 命中数。

**构建阻塞（需总工程师处置）**：汇总时 `npm run build` 仍失败，错误全部来自 W1 在途文件（`src/server.ts:232` 连续 4 处 `RetrievalSelection` 缺 `source` 属性；同一文件在两次运行之间从 222 行移到 232 行，说明仍在编辑中）。W2 的验证因此使用 `tsc --noEmitOnError false` 产出 dist 后运行，未修改任何 W1 文件。

## 六、硬约束遵守情况

- 改动文件：`src/semantic.ts`（主）、`test/classification-honesty.test.ts`（新增）、`scripts/classification-replay.mjs`（新增，只读工具）、`docs/implementation/r5-classification.md`（本文件）。
- **一处越界的最小局部 edit**：`src/model-review.ts:66-72`。原因是 `SemanticAnalysis` 新增了必填字段，该文件第 71 行的模型路径返回值缺字段导致编译失败。改法是给模型判定显式补 `autoPromotable: false` + 原因，语义上正是"模型判定不授予自动升格"，与 W2 的目标一致，未触碰它的任何判断逻辑。
- `src/store.ts` **本线未改**：`submit()` 的调用点用默认 `ClassificationContext`（agent + self-reported），与 `store.ts:1307-1311` 的事实完全一致，不需要传参。（`git status` 中 `src/store.ts`、`src/schema.ts` 显示为已修改，那是其它实现线的在途改动，不是 W2 的。）
- `adapters/**` **未改**（按指令由总工程师接线）。
- 真实库只读：回放脚本以 `readOnly: true` 打开，只发 SELECT；未创建任何副本外写入。
- 未改任何既有测试的期望值。
- 本文件不含用户目录绝对路径。

## 七、未完成项与风险

1. **接线未做**：`autoPromotable`/`promotionBlockedReason` 目前只是字段，`adapters/dsh/index.mjs:643` 的 `AUTO_PROMOTE_KINDS` 仍无条件接受 `norm`。**这轮改动本身不会改变用户点一下"采纳"的行为** —— 必须由总工程师在 `entryFromClassification` 里读新字段才生效。
2. **残留误伤 8 条**（第四节已列 id）：祈使语气的方法论经验与约束在文本上不可分。继续加词会同时误伤 `070c7c34` 这类真规范（它确实是约束），因此本轮停在这里，把定性交给人。
3. **两个启发式的已知边界**：`isNarrativeExperience` 的弱标记取"两个不同词"，`若发现问题必须上报…并记录结论` 这类规则会被误降为 `memory`（代价是一次人工确认，比误升格为硬规范安全）；标题带只看前 48 字，一个经验体若把"经验"写在 48 字之后不会被这条捕获。
4. **未做**：真实宿主端到端验证（面板点采纳的实际效果）。它依赖第 1 条的接线，属 V1 验收线。
