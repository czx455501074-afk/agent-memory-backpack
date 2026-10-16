# Skill 整理管理页：实际浏览器验收

日期：2026-10-14。使用 computer-use skill 的浏览器能力；IAB 不可用，使用自建 Chrome 标签。未控制用户 DSH 窗口。

## 隔离环境

- 临时 SQLite：系统临时目录下本轮独立的`amb-browser-fixture-*/knowledge.sqlite`（确切路径仅保留本机验收记录）。
- 自建 HTTP 模型 fixture，故意返回缺少原文依据的 recovery；没有调用真实模型或真实用户凭据。
- 临时 core 曾监听 `127.0.0.1:63271`，新 UI 核对实例曾监听 `127.0.0.1:63136`。
- 仅使用固定、无生产权限的测试凭据；文档和截图不记录凭据。

## 已实际操作并观察结果

1. 打开管理页，无凭据时看到连接说明；本版本没有显示可点击的登录表单。使用测试凭据 fragment 加载后，地址移除 fragment，页面显示 `ui-fixture / 已连接`。
2. 点击 **Skill 整理**、**生成或查看整理任务**、**刷新**。fixture 的恢复步骤没有原文依据，显示 `needs_evidence` 和明确缺项。
3. 点击 **原文与草稿对照**，看到完整流程、逐项引文、缺项；展开 **源 skill 与全部参考正文**，看到主文与 `refs/check.md` 的完整源快照。
4. 在页面编辑器把 recovery 改为源文中的“无监听则保留失败状态”，清空已解决 missing；点击 **保存并重新校验**，页面返回列表并显示 `ready_for_review`。
5. 再打开对照，点击 **确认已审阅并采纳流程**，列表显示 `approved`。无凭据截图已由浏览器工具输出。
6. 通过另一个 SQLite 连接更新这一临时源 skill。核心 `expand` 拒绝：`Source skill changed or is unavailable; review the derived workflow again`，搜索返回旧流程 `ready:false`。
7. 点击浏览器刷新，源 skill 变为 `@2`，旧草稿状态 `stale`；新版本整理任务仍为 `needs_evidence`。
8. 新编译 UI 在同一临时库上实际显示 **检索辅助归纳**、摘要、适用场景、排除条件、别名、适用版本，并明确“非已采纳流程”；此 fixture 未生成 digest 内容，因此栏目如实显示“尚无归纳 / 未提供”，不作为真实模型归纳质量证明。
9. 新 UI 的凭据说明如实显示 sessionStorage，不再声称仅纯内存。实际脚本语法和 digest HTML 转义通过回归断言。

## 修改与检查

- `src/ui.ts`：新增转义的 digest 栏目；修正文案；已批准草稿对照不再统一声称“尚未生效”。
- `test/retrieval-service.test.ts`：加入 digest 栏目、HTML 转义表达式及凭据文案断言；`npm run build` 成功，相关测试 5/5 通过。
- 第二张裁剪截图的 CDP capture 超时，未计成功，也未伪造本地图片路径。第一张 approved 截图仅在工具输出中，本轮没有持久图片文件。

## 清理与边界

自建 Chrome 标签已关闭。两个自建 Node PID `28140`、`29836` 按命令行核对后停止。临时 SQLite 保留供复核；没有部署或修改生产数据库。

没有验收真实模型归纳质量、所有浏览器类型、用户 DSH 会话或生产管理员登录。本轮验收证明管理页的隔离业务闭环可实际操作。
