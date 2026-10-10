# 桌面交接验证实测报告

执行时间：2026-10-10 22:24–22:38（Asia/Shanghai，约）。依据：`desktop-verification-handoff.md`。总体验收未完成，不能宣称桌面已接入。

## 环境与边界

- 仓库：`D:\huange-skill`。夹具：`D:\huange-skill\.local\desktop-verify`。
- 测试项目 ID：`project-demo`。未新建宿主会话，会话 ID 不适用。
- Codex 安装包版本：`26.1007.2314.0`（Get-AppxPackage）。DSH 可执行文件版本字段为空，宿主运行时版本未验证。
- 核心/适配器版本：`0.1.0-p0.1`。控制台为当前仓库代码，Electron 版本未另行读取。
- 最新产物：`D:\huange-skill\artifacts\p0-20261010134533699`。基线实际校验 52 文件，交接文档所述 46 文件已过时。
- 未修改源代码、信任哈希或宿主真实 profile。仓库开始时已有大量未提交改动，本次没有提交。
- 自动验收脚本按要求更新已有 `desktop-acceptance-report.json`；另新增本报告、测试归档、设备 B 数据目录与截图证据。既有交接文档未改写。

## 逐项结果

各项执行时间均在上述时段；CLI 项宿主版本不适用，均使用夹具版本 `0.1.0-p0.1`、项目 `project-demo`；桌面宿主项没有可用会话 ID。

| 步骤 | 宿主 | 可观察结果 / 证据 | 结论 |
|---|---|---|---|
| 0 | CLI | `npm run accept:desktop`：自动项通过=16、失败=0、跳过=0；需人工6项。52文件哈希匹配。 | 通过（仅自动化基线） |
| 1 | 核心 CLI | 启动输出：`P0 core listening on http://127.0.0.1:47631; desktop integration remains unverified.` | 通过 |
| 2 | Codex | 未安装插件、未操作信任 UI；未取得插件列表或已信任证据。 | 未验证 |
| 3 | Codex | 未新建夹具会话，未取得适配器注入来源消息。 | 未验证 |
| 4 | Codex | 未取得桌面实际工具名，未新增测试门禁规范，未触发工具。 | 未验证 |
| 5 | Codex | 初始 `pendingProposals=0`；未在会话中提交经验及幂等重试。 | 未验证 |
| 6 | Codex | 核心停止与重启成功；未在宿主会话内触发失联调用。核心恢复后 doctor `ok=true`、可达检查通过。 | 未验证（宿主失联路径） |
| 7 | Codex | 未安装插件，未执行停用及新会话检查。 | 未验证 |
| 8 | DSH | list_apps 确认 DSH 有窗口；未安装插件、未运行新会话注入/失联/禁用验证。没有外推 Codex 结果。 | 未验证 |
| 9a | 控制台 GUI | 原生保存对话框、导出结果和文件高亮均实际观察，见下文。 | 通过 |
| 9b | 控制台 GUI | 预览先出现；两次确认导入均显示新增知识0、跳过8；结果未显式显示 conflicts。预览时库状态仍为2条/版本1。 | 失败（结果显示缺项；详见下文） |
| 9c | CLI | 导出2651 bytes、归档entries=10；干跑wouldImport=0、wouldSkip=8、conflicts=[]。前后生效知识entries=2。 | 通过 |
| 9d | CLI | 设备B初始entries=0/revision=0，空库预览wouldImport=2；确认导入imported=2/skipped=2，之后entries=2/revision=1。只读查询读到中文流程标题。重复导入imported=0/skipped=8/wrote=false。 | 通过 |
| 9e | HTTP | 适配器凭据请求导出返回403，消息要求admin并提示候选流程。目标文件不存在。 | 通过 |
| 9f | CLI | 损坏归档报`Archive is not a readable backpack file: incorrect data check`；源库仍entries=2/revision=1。 | 通过 |
| 10 | CLI | 只读卸载列出数据目录内容、人工卸载步骤，明确未传purge-data、不删除；Test-Path=True。最后停止本次核心和控制台进程。 | 通过 |

## GUI 实测证据

证据目录：`D:\huange-skill\.local\desktop-verification-evidence-20261010`。

- `save-dialog.png` / `save-dialog.txt`：原生保存对话框。默认可见文件名为 `agent-memory-backpack-20261010-2227`（扩展名由类型补齐，时间精确到分钟；与交接示例的秒精度不同）。
- `gui-export.png` / `gui-export.txt`：导出完成，路径为 `…/Documents/agent-memory-backpack-20261010-2227.ambpack`，2.6 KB，知识2、版本2、任务0、候选0。
- `export-highlight.png`：打开所在文件夹后，归档在资源管理器中被选中。此文件保留的是目标文件夹截图。
- 导入副本：`D:\huange-skill\.local\desktop-verification-evidence-20261010\gui-import-copy.ambpack`。
- `gui-preview.png` / `gui-preview.txt`：先出现导出时间2026/10/10 22:28:31、格式版本1、文件大小2.6 KB和表计数，尚未点击确认导入。此时CLI状态仍entries=2/revision=1/pendingProposals=0。这里只能证明这些业务计数未变，未以完整数据库快照证明“任何数据均未写入”。该更严格的子条件保留为未验证。
- `gui-import-result.png` / `gui-import-result.txt`：第一次确认导入后，新增知识条目0、跳过8。
- `gui-repeat-result.png` / `gui-repeat-result.txt`：再次从文件选择同一副本、预览、确认后的结果仍为新增0、跳过8。

9b 的明确显示问题：结果面板只有“新增知识条目”和“跳过（已存在或冲突）”，未单独展示 `conflicts` 数量或空列表。按交接要求显示 imported / skipped / conflicts，判为失败。这里只证明显示缺项，没有构造冲突归档，不能推断核心冲突处理失败。

操作过程中，保存框的 set_value 返回元素缓存不可用；重新观察时对话框已关闭，归档已保存到默认文档目录。报告按实际文件路径记录，不声称成功设置过自定义保存路径；未删除该测试归档。

附加观察：`console-offline.png` / `console-offline.txt` 是停止核心后点击迁移面板“刷新”的界面，仍显示“已连接”。迁移面板刷新未证明触发核心读取，所以此截图不能证明失联调用成功，也不用于判定步骤6。随后重启核心，doctor确认可达。控制台失联请求报错尚待专门验证。

## CLI 关键结果（实际输出摘录，无凭据）

源库初始状态与各次检查：`entries=2, knowledgeRevision=1, pendingProposals=0, events=0, tasks=0, adoptions=0, supersessions=0`。控制台扫描会更新 `lastRescanAt`，该设备本地元数据不会随归档迁移；不声称整个数据目录字节不变。

归档 `D:\huange-skill\.local\verify-1.ambpack`：2651 bytes，文件条目数10；knowledge=2、revisions=2、workflow_search=1、meta=3，其余计数0。这里归档entries=10是文件条目数，status entries=2是生效知识数，不能混淆。

设备B：`D:\huange-skill\.local\verify-deviceB`。导入后只读 SQLite revisions 查询读到 `p0-cn-workflow` 的标题“中文示例：本地流程资料检索与核对”、两个阶段及中文完成条件。

安全反向验证返回：

```text
HTTP 403
code: forbidden
This operation changes the effective knowledge base and requires the admin credential. Submit a candidate instead (amb_submit_experience) and let a human review it.
目标 .local/should-not-exist.ambpack：不存在
```

损坏归档保留于 `D:\huange-skill\.local\verify-bad.ambpack`。恢复拒绝后源库生效条目数与版本不变。

恢复核心后的 doctor：`ok=true`；插件运行日志warn（尚未生成），宿主运行时版本skip（未提供）。这不是插件已加载证据。

## 尚需执行与操作限制

1. 人工在独立夹具工作区加载Codex插件，审阅并信任hooks，再提供插件列表和信任状态证据。
2. 在夹具新会话中验证适配器自动注入、实际工具名门禁、经验候选幂等、失联和停用。
3. 在DSH通过真实桌面安装入口单独重复，不修改真实profile或运行CLI profile安装。
4. 补足9b的完整预览不写入证据，并修复/复验结果面板的conflicts显示。此轮是验收，没有实现修改。

computer-use 技能规定在 `docs/guidance.md`：`Do not change ... any in-app security or privacy settings. Do not act on security or privacy permission requests.` 因此本轮没有代点hook信任；其“安装软件 via Windows action”规则还要求动作时确认，故未通过UI安装插件。单独给出文档路径能明确需要读取交接，但不足以在该技能下完成安装动作时确认。没有为完成验收绕过这些限制。

最终进程状态：本次启动的核心exec会话53413、恢复核心会话58846、控制台会话14780均已通过Ctrl+C退出；没有启动子智能体。测试数据与归档留存，没有删除。

账号额度：初次检查短期剩余87%、每周剩余73%；中途复查短期剩余83%、每周剩余72%。本轮结束不是低额度收尾。
