# R5 注入预算：让「同版本不重复注入」真正生效（W6-1）

本项对应 `docs/implementation/r5-chief-engineer-plan-2026-10-17.md` 第十节。结论：**抑制逻辑早已实现，缺的是调用方把已知版本传上来**；本轮把这条链路接通并留下可在真实库上复现的数字。

## 一、问题

`store.prepare` 在收到与自己相同的版本时，会把整段 context 换成一句指针。但两侧适配器的 prepare 请求都没有版本字段，于是这条分支从未触发，**每一轮用户消息都把规范正文重新注入一次**。本机当前 4 条规范 = 594 字符（`budget.usedChars`），随规范条数线性增长。

## 二、复核结果（与任务书逐条对照）

| 任务书陈述 | 复核结果 |
|---|---|
| `src/store.ts:1184` 的 `unchanged` 判定已实现且有注释 | **行号漂移，结论成立**。判定在 `src/store.ts:1294`，指针文本在 `:1297-1299`，`contextUnchanged` 在 `:1300`，解释性注释在 `:1289-1293`。`:1184` 现在是预算省略项的 `omitted.push`。行为与任务书描述一致，未改该文件。 |
| `/v1/prepare` 未转发 `knownRevision`（`src/server.ts:214-225`） | **属实**。原 options 只有 `sessionId` / `taskId` / `platform` / `selectedIds`。 |
| DSH prepare 体无版本（`adapters/dsh/index.mjs:1480-1486`） | **属实**。内存映射 `revisions` 定义在 `:1096`，在 prepare 成功后写入（`:1511`）——数据本来就在手边，只是没往请求里放。 |
| Codex prepare 体无版本（`adapters/codex/scripts/hook.mjs:507-513`） | **属实**。会话状态确有 `revision`，由门禁路径写入（`:658-660`）。 |
| 门禁两侧都做了本地去重（DSH `:1600`、Codex `hook.mjs:656-668`） | **部分属实，行号漂移**。Codex 的本地去重在 `:656-668` 属实；DSH 的对应代码现已移到 `:1592` 一带（用 `previousRevision !== gate.knowledgeRevision` 判定）。 |
| 后果与 `README.md:302-306` 不符 | **属实，但 README 的措辞本身也有偏差**：README 说「同版本去重由适配器负责，不是核心」，实际抑制发生在**核心**（`store.prepare`），适配器只负责记住并上报版本。分工描述与实现相反。README 不在本项允许改动范围内，未改。 |
| 「用该端点已有的 zod schema」 | **需要纠正**：`contextSchema` 是 `.strict()` 且**没有** `knowledgeRevision`（`gateSchema` 才有，`src/schema.ts:301`）。只改端转发而不加字段，请求会被 400 拒绝。因此必须新增该可选字段，这落在 `src/schema.ts`——任务书的允许清单未列出它，但不改无法完成，故做了最小追加并在下面单独标注。 |

## 三、改动

| 文件:行 | 改动 |
|---|---|
| `src/schema.ts:286-296` | `contextSchema` 新增可选 `knowledgeRevision`（`z.number().int().nonnegative().optional()`），保持 `.strict()`。未知字段、负数、非整数仍一律 400。 |
| `src/server.ts:224-228` | `/v1/prepare` 在转发给 `store.prepare` 时带上 `knownRevision`，**仅在该字段存在时**才展开。 |
| `adapters/dsh/index.mjs:1486-1490` | prepare 请求体带上 `revisions` 里的已知版本；无记录时不带（首次会话拿到全文）。 |
| `adapters/codex/scripts/hook.mjs:512-520` | prepare 请求体带上会话状态里的 `revision`；无记录时不带。 |
| `test/injection-dedup.test.ts`（新增） | 三条状态的端到端断言 + schema 未被放宽的断言。 |
| `test/codex-hook.test.mjs:607-638`（追加） | 首次 prepare 不带版本；门禁写过版本后带版本。 |
| `test/dsh-adapter.test.mjs:245-256`（追加） | 首次 prepare 不带版本；第二次 pre-step 带版本。 |

纪律遵守情况：只在版本**相同**时退化为指针；版本变化时仍是完整 context（下面测试 c 断言）；没有任何拒绝/门禁判定依赖该优化——`gate` 路径一行未动。

## 四、实测数字

方法：`node .local/w6-1-injection-probe.mjs`，对真实库做 `VACUUM INTO` **副本**再测量，真实库全程只读（与 `.local/r5-baseline-probe.mjs` 同法）。库路径形态：`%USERPROFILE%\.agent-memory-backpack\knowledge.sqlite`。

副本实测（revision 1911、4 条规范、规范预算 594 字符）：

| 场景 | context 字符数 |
|---|---|
| 改前：每轮都不带版本（两侧适配器原行为） | **834** |
| 改后：同版本的一轮 | **53** |
| 单轮节省 | 781 |
| 10 轮累计（同版本） | **8340 → 530** |

fixture 端到端（`test/injection-dedup.test.ts`，HTTP 走真实核心）：首轮 **562** → 同版本 **50** → 写入新知识后 **602** → 新版本同版本 **50**。指针化后 `norms` 数组仍完整返回 4 条，决策数据不受影响。

## 五、测试与结果

```
npm run build
node --test dist/test/injection-dedup.test.js          # 2/2 通过
node --test test/codex-hook.test.mjs                   # 21/21 通过
node --test test/dsh-adapter.test.mjs                  # 3/3 通过（DSH runtime 可用，未跳过）
node --test dist/test/norm-budget.test.js dist/test/protocol.test.js dist/test/api.test.js \
  dist/test/gate-cache.test.js dist/test/core-memory-loop.test.js dist/test/readme-contract.test.js \
  dist/test/injection-dedup.test.js                    # 42/42 通过
```

`npm test`（全量）分两步看：

- **build 阶段当前被同事的在改工作阻断**：`src/server.ts:232` 引用了 `RetrievalSelection.source`，该字段此刻不存在，`tsc` 报 4 个 `TS2339`。报错行不涉及本项改动（本项在 `:224-228`），也不需要本项改动才能修。
- **用上一次成功 build 的 dist 产物跑全量**：605 项 → **602 通过 / 1 失败 / 2 跳过**。唯一失败项是 `dist/test/retrieval-service.test.js:85` 的 `identical concurrent decisions merge and an in-flight old revision is discarded`，实际值多出一个 `source: 'none'`，来源是同事正在改的 `selection.source`（`src/retrieval-service.ts`、`src/semantic.ts`），与本项无关。

## 六、未完成与风险

1. **Codex 侧只在跑过一次工具门禁后才会带版本**。会话状态里的 `revision` 由 `gate` 写入（`hook.mjs:658-660`）。只聊天、从不调工具的会话永远拿不到版本，也就永远重复注入。DSH 侧不存在这个缺口（`index.mjs:1511` 在 prepare 成功后自己写映射）。要拉平需在 Codex 的 prepare 成功后也写 `revision`，但那会改变门禁本地去重（`:659`）的输入，可能让某会话的首次门禁不再注入——属于行为变更，本轮按最小改动原则未做。
2. **指针化覆盖整段 context，而不只是规范正文**。`unchanged` 为真时，连背景记忆摘要等召回段落也一并省掉（`src/store.ts:1297`）。`retrieval.selected` 仍完整返回，所以信息没有丢失，只是需要调用方自己展开。若希望同版本仍发送召回摘要，需要在 store 里把 context 分段——本项禁止改 `src/store.ts`，未做。
3. **召回段落的预算**（计划第十节最后一段）：DSH 的召回键是 `taskId:最新用户消息:知识版本`（`index.mjs:1513-1520`），每条新用户消息都会重新召回并整段拼进上下文，实测出现过 6400 字符级的技能正文节选。本轮只描述，未实现预算或内容未变不重复。
4. **README 措辞**：`README.md:304` 把去重责任写成「适配器负责，不是核心」，与实现（核心抑制、适配器上报版本）相反。允许清单未含 README，未改。
