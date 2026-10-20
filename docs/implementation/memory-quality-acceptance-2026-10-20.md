# 2026-10-20 记忆质量验收

## 已验证

- 初始基线：881 项，879 通过、2 跳过、0 失败；宿主 RUNNING DEPLOYED BUILD。
- 改进后全量：893 项，891 通过、2 跳过、0 失败；.local/memory-quality-full.log。
- 51/51 交付契约：.local/memory-quality-contracts.log。
- DSH 实际 Cordis 运行时 3/3：新增字段透传、检索/读取续页参数、噪声拒收不进入 outbox；.local/memory-quality-dsh.log。
- 项目结构检查无未登记顶层路径。git diff --check 通过。
- 文档路径检查报告 1 个既有 Tauri target 生成脚本含用户路径，未修改生成文件。
- 只读存量快照：.local/memory-quality-audit.json，231 active，8 份复合 memory、7 份 global journal 待核对；不是人工判定错误率。

## 本机应用

- 数据库备份：项目 .local/amb-before-memory-quality-20261020.ambpack，10,411,223 字节；包含知识、历史、任务与候选，不包含凭据。导出结果见 .local/memory-quality-backup.json。
- 打包产物：artifacts/p0-20261019163828367；打包语法门通过，隔离桌面验收 20 项通过。该产物使用 UTC 时间命名，创建于上海 2026-10-20。
- DSH desktop/web 部署完成，核心 PID 30612，40 个部署文件核对，结论 RUNNING DEPLOYED BUILD。见 .local/memory-quality-host-final.json。
- 待审 p0-workflow：12 条分类快照回填到 semantic-2026-10-20，保留前一判定，不修改原始正文和 active 知识；重新 dry-run 为幂等跳过。见 .local/memory-quality-reclassify-applied.json、memory-quality-reclassify-idempotent.json。
- Codex 稳定 marketplace 的 codex-plugin 已更新；旧源在同一 marketplace 的 codex-plugin-backup-20261020-memory-quality 保留。插件仍 installed/enabled，版本 1.0.0。
- 官方 codex plugin add 刷新当前缓存失败：failed to back up plugin cache entry / 拒绝访问 / os error 5。进一步同步当前缓存文件的操作被自动审批拒绝，原因为 blocked by policy，未提供更具体说明；未继续改缓存。当前 MCP 代理访问新核心的只读搜索已实际返回 page/coverage/assessment。

关闭占用该缓存的 Codex 进程后，可执行官方命令：

```powershell
codex plugin add agent-memory-backpack@amb-local --json
```

然后重新加载 Codex 插件，并在方便时重启 DSH 以刷新注册工具参数。核心 HTTP 检索、采纳和有效期约束已经在新进程中生效；没有将源文件部署与进程加载混为一个结论。

## 未覆盖

未重启用户桌面或强制结束聊天。工具注册随宿主进程缓存，新参数需要插件重新加载；核心 HTTP 行为可独立生效。没有证明长期模型行为收益，没有删除或自动拆分旧历史合集，也没有改变原生 session 权限模型。

## 保存收据

- 复合历史治理经验候选 bdb7097b-3d81-4e80-8111-365198d5b543：pending，未采纳，未声明为已验证规范。
- 当前任务 task-200bdf7eb8f48c3d，日记 journal-task-200bdf7eb8f48c3d，状态 in_progress、结果 unverified；保留 Codex 刷新、旧数据审查和长期效果评测为未完成项。
- 审查快照的可跟踪副本：docs/implementation/memory-quality-audit-2026-10-20.json。后续工具调用和日记会继续改变候选数，快照数字不代表当前固定总数。
