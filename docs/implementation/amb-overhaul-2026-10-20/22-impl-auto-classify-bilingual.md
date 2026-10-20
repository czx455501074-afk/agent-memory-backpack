# 第二刀：自动分类、受控域词表、中英双语检索

时间：2026-10-20 21:05。用户要求三件事：做自动分类、中英文双语检索、所有内容按需检索但要防止 agent 没检索到全部所需数据就开工。

## 一、自动分类：提交即定，不等人

此前分类器在提交时已经跑过一次（`classifyForStorage`），但结果只作为审阅参考存着；调用方不传 `memoryContext` 时，采纳后的条目 `applicability` 是空的——"这条是规范还是经验、属于哪类工作"要等几个月后由人回忆。

改动（`src/store.ts` 的 `submit`）：新增 `autoApplicability()`，把分类结果直接写进候选的 `memoryContext`。

两条落定边界，都是有意的：

- **kind/scope 只在 `autoPromotable` 为真时落**。`norm` 参与工具门禁（能直接 deny 一个工具），由推断自封它的代价远大于少一次自动化；这类仍走既有确认路径。
- **domain 任何时候都落**，因为它只做导航，不参与权限、门禁与采纳判定。

调用方显式给了 `memoryContext` 时不覆盖，只补空缺的 domain。

**踩到的坑：声明与推断必须分字段存。**

第一版把推断结果直接写进候选的 `memoryContext`。全量测试立刻红了两条——"完全相同的候选不得形成两条"与"相同文本+不同证据不得合并"。原因：去重比较里 `memoryContext` 是判定条件之一，旧条目带着推断值、新提交没有，同一段文字就被当成新提交。

改法：新增 `autoClassification` 字段专门存推断，`memoryContext` 只保留调用方声明。去重仍比 `memoryContext`（显式条件不同就不能合并），而推断不参与判定；采纳时若没有声明，才用推断补位。

这条不是命名洁癖：**参与判定的字段和推导出来的字段混在一起，会让"是不是同一条"这种确定性问题变成随时间漂移的问题**。

## 二、受控域词表

新建 `src/domain-taxonomy.ts`：12 个顶层域，中文名 + 判定线索 + 反例。

| 域 | 中文名 | 典型线索 |
|---|---|---|
| `retrieval-knowledge` | 检索与记忆库 | 检索、召回、注入、索引、向量 |
| `host-runtime` | 宿主运行时 | 宿主、适配器、hook、会话、重启 |
| `plugin-ops` | 插件安装与部署 | 安装、卸载、部署、打包、回滚 |
| `code-change` | 代码改动与测试 | 重构、编译、测试、断言、类型 |
| `network-proxy` | 网络与代理 | 代理、网关、端口、TLS、超时 |
| `model-routing` | 模型与路由 | 模型、路由、额度、provider |
| `media-generation` | 图像与视频生成 | 生图、首帧、参考图、LoRA |
| `short-drama` | 短剧与剧本 | 剧本、分镜、台词、角色卡 |
| `browser-automation` | 浏览器与抓取 | 浏览器、登录态、CDP、cookie |
| `docs-governance` | 文档与规范治理 | 文档、规范、交接、台账 |
| `data-recovery` | 数据迁移与恢复 | 迁移、备份、快照、integrity |
| `security-audit` | 安全与权限 | 权限、越权、审计、凭据 |

推断规则：命中线索计分，低于 2 分不猜；最高分与次高分差小于 1 时视为并列，返回空——**宁可不猜，也不把条目塞进错的域**。`isKnownDomain()` 供写入口拒收未知域，防止词表退化成标签垃圾场。

## 三、中英双语检索：只在查询侧补，且只用显式检索

### 为什么必须补查询侧

`withBridge()` 只给**条目**补别名：中文条目里出现「上下文」，会带上 `context`，于是英文查询能命中它。反过来从来不通——查询是按自己切词的，问 `context budget` 时中文库什么也答不上。只补一半等于只修单向。

`expandQueryTerms()`（`src/term-bridge.ts`）做另一半：命中概念组的词，扩展出同组说法。中文扩展词按 2-gram 返回（与 `searchable()` 的索引形状一致），英文整词返回（索引里的英文就是整词）。形状不一致的 token 永远匹配不上。

概念组从 24 组扩到 49 组，新增的都是本仓库真实高频说法（上下文/context、预算/budget、工具/tool、证据/evidence、分类/classify、索引/index、召回/recall、超时/timeout、限流/rate limit 等），不是通用同义词典。

### 关键教训：桥不能进自动召回

第一版把桥接词直接并进 `queryTokens`，**全量测试立刻抓到一条回归**：`automatic prepare filters skills matching only reference boilerplate` 失败——一个短剧配音技能靠参考文档里的样板文字被拉进了自动注入。

原因：自动召回的过滤依赖字面 token，桥接词让"只靠样板命中"的条目也通过了复核。

修正：拆成两个函数。

- `queryTokens()`：只有原词，供自动召回、prepare 的覆盖判据、打分使用。
- `expandedQueryTokens()`：原词优先 + 桥接补充，只用于**显式检索**（`search`、`searchUniversal`）。

这条分工不是洁癖：显式检索里漏检的代价高于多一条候选；自动召回里多一条无关条目的代价是每轮污染上下文。

## 四、没检索完就开工：把缺口变成一句话

`prepare` 原本已有 `considered / shown / withheld / gaps` 数字，但数字放在结构化字段里，读起来像"检索完成"。新增 `recallAdvice`：当本次召回不完整（有被扣下的候选或未覆盖词）时，在注入段末尾追加一段可执行提示：

> 【动手前先补检】本次自动召回并不完整：可见条目 318 条、本次注入 0 条，3 条候选未通过字面复核，未覆盖词：…。在写代码或下结论之前，先用 amb_search_universal 换一种说法（含英文与同义说法）复核，必要时用 amb_read_knowledge 读正文；确认没有更多相关条目再动手。

这是**提示层**，不是强制层。强制层（首次写操作前若本会话无检索记录则拦截一次）需要改适配器与宿主 hook，风险高于收益，列为下一步并需单独开关。

## 五、测试

```
npm run build                                   # 通过
node --test dist/test/auto-classification.test.js \
  dist/test/core-memory-loop.test.js            # 13 / 13 通过
```

新增 7 条断言：自动域判定、自动 kind/scope、显式 domain 不被覆盖、无线索不猜、双语桥双向、token 形状与索引同构、显式与自动两套 token 集必须不同。

全量结果见 `.local/after-auto-classify-v2-20261020.log`。

## 六、没做

1. 适配器强制检索门（需开关，见上）。
2. 域词表的模型归纳（规则版优先，模型版作为可选增强，尚未接入）。
3. 存量 900 条条目的 domain 回填：新逻辑只影响新提交；`amb reindex` 可刷新索引，但 applicability 需要一次性回填脚本，且必须先只读盘点。
4. 中文伪词项（`matchedTerms` 里出现 `"索噪"` 这类跨词碎片）尚未修——它在回执展示层，不在检索层，改动独立。
