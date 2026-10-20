# 证据随知识保留（2026-10-20）

## 已确认缺陷

1. submit保存候选evidence，但approveProposal只写审阅人的entry，证据未随采纳进入知识修订。候选队列清理后，知识正文与原证据失去可靠关联。
2. generateJournal产生verification诊断信息，writeJournal因schema不接收该字段而丢弃；任务验证说明和文件指针没有作为专门证据保存到知识中。
3. 相同discovery被待审去重时，没有比较证据。不同测试、反例或不同会话提交的支持材料可能被当成完全重复而丢弃。
4. 候选schema没有sessionId；文件导入虽有独立adoptions账本，但知识修订本身不携带源路径、源哈希和当时摘录。

## 实现

知识增加可选support元数据，兼容旧数据，无新增SQL表。每次候选提交由核心记录principal、收到时间、项目、任务和已知会话，保存脱敏证据说明及引用；采纳时将这份材料与补充证据固化到同一知识修订。对旧候选采纳也读取其已有evidence与supplements，不要求重新提交。修订现有知识时带predecessor指向上一修订。

MCP与DSH两个入口均支持evidenceRefs；DSH使用当前exec.agent.id记录会话。MCP可传真实sessionId，给定taskId时核心也保留任务已有sessionIds，不猜未知会话。引用包含artifact/command/url/knowledge/event类别、locator、可选observedAt/result/revision/reportedHash及至多6000字符的snapshot；每次最多10个快照。不得提交凭据或完整工具流水。

核心在脱敏后计算snapshotHash，覆盖实际保留的摘录；上游提供的hash只作为reportedHash，不冒充本地核验。整个证据包另有摘要哈希。文件导入把真实源路径、源字节哈希、有限摘录与导入时间存入该修订，完整原件正文和技能叶子仍按原结构保存。读取文件这一事实不证明文件里的结论正确。

任务checkpoint将verified说明、文件指针及evidenceRefs写入日记support。后续Stop没有新的证据时，保留同一验证说明对应的已存快照，避免自动收尾再次抹掉附件。

| 状态 | 含义 |
|---|---|
| missing | 没有证据说明或引用；新采纳memory仍可显式查阅，但不能自动注入 |
| referenced | 有说明/定位/补充材料，尚无非空快照 |
| captured | 已保留至少一份非空脱敏快照；不表示插件独立确认事实 |

知识读取返回完整support；搜索只给状态、数量和来源身份。support和curation的引用原文退出全文索引与字符串兜底检索，防止日志、源引用和哈希污染知识匹配。索引重建也遵守此边界。

同文但证据或会话不同的提交分别保留；同文同证据仍可去重，原idempotencyKey重试约定不变。快照内的文本是数据，不是对agent的新指令。

## 验证与限制

`test/evidence-retention.test.ts`验证：候选清空后证据仍可读取；核心重算快照哈希；证据快照不污染检索与重建；不同证据不丢失；旧候选及补充证据完整采纳；missing不自动注入；checkpoint到日记再到Stop保留；敏感字段先脱敏。另有HTTP完整链路回归与两端schema/运行时测试。

证据包只保存主动提交的有界快照，不会自行读取任意磁盘路径或抓取URL。agent未提交的原始输出不能靠哈希补出；定位存在也不等于其内容已被独立复验。旧知识缺失的历史证据不编造回填，已有来源可通过curation精确引用保留。后续可基于宿主授权的事件记录继续扩展自动取证，但本次不声称已完整捕获每个工具的输出。
