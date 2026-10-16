# Skill 整理两阶段迁移验收与回滚说明

日期：2026-10-15（Asia/Shanghai）

## 实施边界

摘要与流程整理拆成两个持久作业。摘要作业最多重试 3 次；schema 校验成功后先写入原有 `workflow_drafts.result.digest`，再创建流程抽取作业。流程作业最多重试 5 次。流程提取不足 (`needs_evidence`) 是可审阅终态，不会因此重跑摘要。摘要和流程状态分开展示；摘要始终只是检索建议，人工核对和采纳门禁不变。

保留原草稿表列和 `result.digest` 格式，新增的阶段状态作为结果对象内的可选 `organization.digest`、`organization.workflow` 元数据。`source_hash` 及结果 `source.skillId/revision/hash` 继续绑定原技能版本。旧 result/旧 v1 备份可读；备份不导入设备本地作业队列。升级后发现旧 `structure_skill` 作业且没有持久 digest 时，worker 先创建摘要作业并结束旧作业，避免旧 payload 绕过新阶段顺序。

## 当前证据与限制

- 源码检查：`npm run check`、`npm run build` 通过。
- 针对 `workflow-organization`、`workflow-draft`、`backup-workflow-drafts`、`jobs` 的测试共 22 项，22 通过、0 失败。
- 只读真实库抽样聚合：149 草稿中 100 个 digest 通过当前 `digestSchema` 校验；流程状态为 `awaiting_model=3`、`needs_evidence=95`、`pending=49`、`ready_for_review=2`。这是查询时的动态快照，运行中服务可能继续改变计数。这些是当前运行中旧版本的状态，不是新两阶段 worker 部署后的结果。未写入真实库、未部署、未重启。
- `web-ui.test.ts` 中既有综合检索断言未通过（`searchBody.results.length >= 1`）；已交检索实现负责人排查，与本文组织作业测试分开报告。

## 隔离验收步骤

1. 使用临时数据库和本地模型 fixture，先调用 `enqueueWorkflowDraft`。确认只创建 `structure_skill_digest`，草稿 state 仍不表示流程可采纳。
2. fixture 返回符合 `digestSchema` 的摘要。运行 digest handler 后读回同一 `source_hash` 的 `result.digest`；确认下一步才创建 `structure_skill`。确认列表/详情分别显示 `digestStatus=ready` 与流程状态。
3. 让流程 fixture 返回不可用或无效结果。确认摘要字段字节等值保留；流程状态与失败原因单独显示；流程最多尝试 5 次后对应 job 为 `needs_action`。再次自动 tick 不得把计数清零或创建新 key。
4. 让流程 fixture 返回合法但缺少可引用步骤的结果。确认状态成为 `needs_evidence` 并正常结束作业；digest 仍为 ready，不自动审批。
5. 点击管理页“生成或查看整理任务”后确认只重排当前失败阶段：缺摘要时重试摘要；已有摘要时只重试流程。批准仍只能由管理端显式操作。
6. 在模型请求等待期间变更源 skill revision。确认原结果标记 `stale`，不覆盖其绑定的 digest；新源版本创建不同 `source_hash` 的整理任务。旧摘要不可作为新版本结果。
7. 从旧 v1 备份导入不带 workflow drafts 的 fixture；从旧 result 导入无 `organization` 元数据的 fixture；再 round-trip 新 `result.digest`/阶段元数据。校验均不得拒绝旧格式、丢摘要或还原设备本地作业。
8. 构造旧 `structure_skill` payload 且草稿没有 digest。新 worker 应将其迁移到 digest 作业；不得先抽流程。检查 SQLite 中失败记录仅含稳定原因码，不含模型原文或凭据。

## 上线后只读验收步骤

真实数据库在用户允许的只读范围内核对汇总，不主动重排或批准候选：统计总草稿数、合法 digest 数、digest/workflow 各阶段状态、`structure_skill_digest` 与 `structure_skill` 的 status/attempts/error 组合；抽样核验当前 skill revision/hash 与草稿 source 绑定；确认已成功的 digest 没有因流程 `awaiting_model` 或 `needs_evidence` 被清空；确认尝试次数不随每次 maintenance tick 回到 0。另由管理 UI 人工核对摘要与原文，保持现有审批门禁。

部署、真实作业重排和重启必须另行确认；本说明不构成部署授权。

## 回滚限制

工作流草稿表 schema 未变，`result.digest` 和旧格式仍可由旧代码读取。但旧 worker 不认识新 job kind `structure_skill_digest`；因此**存在 pending/running digest job 时直接回退旧 worker 不安全**，旧 worker 可能将其当作无 handler 并反复退避。回退前须先暂停该队列并确认无待处理 digest job，或部署具备兼容处理器的回退版本；保持 `workflow_drafts.result` 原样，不删除阶段状态或原始 refs。若已需恢复数据库，使用部署前 SQLite/官方备份按标准恢复流程，避免仅回退程序后把未完成任务误标完成。恢复后仍须核对 source revision/hash 和 digest 状态；不可自动批准任何草稿。

