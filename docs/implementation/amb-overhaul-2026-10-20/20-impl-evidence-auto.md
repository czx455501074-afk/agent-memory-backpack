# 第一刀：证据自动化（拦在注入层，不拦写入）

时间：2026-10-20 20:20。范围：`src/store.ts`、`src/schema.ts`、`src/memory-policy.ts`、`src/server.ts`、`test/evidence-retention.test.ts`。

## 一、方向纠正（用户当场否决了一版设计）

我第一版做的是"空证据候选采纳时抛错，并要求人写书面理由放行"。用户否决：

> 我要的是尽量减少人的参与，让 agent 来决定……一次工作会产生很多的经验、文字，都要人类给出理由就是失败的插件，插件应该有更高的自动化流程。

这条否决是对的，而且有独立证据支持：两份对抗评审都把"硬拒收/硬门禁"列为最坏情况——会导致 agent 沉默不提交，或学会写空话应付门禁。所以第一版被推翻，不是措辞问题，是位置错了。

**错在哪里**：把门放在"采纳"这一步，就等于要求"每条经验都过一次人"。而真正的风险不是"无证据条目存在"，是"无证据条目被当成规则每轮注入"。

**改后**：门放在**注入层**，采纳层不拦、不要求、不建队列。

## 二、改后的三个机制

### 1. 自动取证：提交时自动附带可核对引用

`src/store.ts` 的 `submit()` 在计算 support 之前新增：

- 调用方若自带 `evidenceRefs`，原样使用（人/agent 明确引用的优先）。
- 若没带，调用 `autoEvidenceFor(projectId, taskId, sessionId)`：从 `events` 表取**同一任务（或同一会话）最近 5 条事件**，转成 `kind: 'event'` 的引用，标 `autoCollected: true`。
- 该查询走既有表达式索引 `events_task` / `events_session`（`src/store.ts:1121-1124`），是索引查找，不是全表扫描。
- 任务没有任何事件时，结果仍为 `missing`——不假装有证据。

含义：agent 不需要为了"合规"去抄命令、抄路径、抄退出码；它做过的事本来就在事件流里。插件负责把书签补上，并如实标注"这是自动采集的"。

`evidenceReferenceSchema` 新增可选 `autoCollected`（`src/schema.ts`），`.strict()` 保持，未知字段仍被拒。

### 2. 无证据标记：自动打，不打扰人

`approveProposal()` 里，`support.status === 'missing'` 时：

- **不抛错**（既有流程、既有测试、既有候选都不被阻断）；
- 自动附加 `support.waiver = { reason: '无证据：自动标记，不参与自动注入', actor, at }`；
- `status` 仍为 `missing`——计数保持诚实，不被"已放行的例外"稀释。

`waiverReason` 是可选字段，人想写就写，不写也有默认文案。没有必填、没有表单、没有审批队列。

### 3. 注入层拦截：真正的闸

`src/memory-policy.ts` 的 `mayAutomaticallyRecall`：

- 原来只拦 `kind === 'memory' && status === 'missing'`——也就是说，无证据的 norm、skill、journal 每轮都会被注入，唯一有证据纪律的那类反而是权限最低的。
- 现在：`status === 'missing'` 一律不注入；`support.waiver` 存在也不注入。
- 该函数被 `prepare` 自动匹配、`search-universal` 的 autoRecall、检索候选集、打分入口四处调用，所以一处收紧，四条路径同时生效。

## 三、测试

改动后：

```
npm run build                                  # 通过
node --test dist/test/evidence-retention.test.js \
  dist/test/api.test.js dist/test/core-memory-loop.test.js \
  dist/test/curation.test.js dist/test/classification-honesty.test.js
# 27 / 27 通过
```

`evidence-retention.test.ts` 的断言已按新语义更新：无证据候选**可以被采纳**，采纳后 `status` 仍是 `missing`、`waiver` 存在、`prepare` 不返回它。

中途出现过 2 条失败（`api.test.js` 批准路由期望 200、实得 409），原因正是第一版把门放在采纳层。改到注入层后恢复。

## 四、影响与回滚

| 项 | 影响 |
|---|---|
| 既有候选 | 不受阻；下次读取时若无证据会看到 `waiver`，但不影响可读性 |
| 已有规范注入 | 无证据的 norm 从此不再每轮注入；本机 4 条规范均由宿主加载、`hostProvided` 分支不受影响 |
| 自动取证 | 只影响"没自带引用"的提交；自带引用时行为不变 |
| 回滚 | 三处改动各自独立：删 `autoEvidenceFor` 调用、删 waiver 赋值、恢复 `mayAutomaticallyRecall` 原判据 |

## 五、还没做（下一步）

1. **adapter 侧工具回执采集**：现在自动取证只能引用"事件 id"，事件本身只含 `kind` 与 `summary`，不含命令与退出码。要让证据真正"可核对到命令级"，需要在 DSH/Codex 的 hook 里把工具名、命令、退出状态写进事件 payload。这是下一刀，且要动两份适配器（有逐字节一致性测试）。
2. **event 引用可解析性校验**：`resolveReferences` 尚未落地，`event` 类引用目前只校验形状。
3. **噪声门槛**：零信息量会话仍会写 journal（`CHANNEL_OK` 探测那条实证），门槛还没加。

## 六、为什么这次不算"简单修改"

它改变的是**责任分配**：过去"证据"是调用方的义务，现在是插件的默认动作；过去"无证据"靠人挡，现在靠注入层自动排除。代码量小，但语义边界换了位置——这一类改动如果不写清"门在哪、为什么不在别处"，下一个人会把它改回去。
