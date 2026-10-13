# DSH 桌面实操测试记录（本轮完成，含覆盖边界）

日期：2026-10-13，Asia/Shanghai。目标：用电脑控制对本项目 Agent Memory Backpack 最新源码版本做 DSH 桌面端全方位实操测试。

后续补充：用户要求更全面的真实使用测试，已追加 3 个桌面会话、7 轮、42 次真实工具调用，覆盖业务交付、知识更新、跨会话、离线恢复及管理操作。详细问题、复现与证据见 [真实使用详细报告](2026-10-13-dsh-realistic-full-operational-test.md)，此文件保留第一轮记录。

## 版本与部署

- 源码提交：025d184；插件版本 0.1.0-p0.1；构建 Node 24.19.0；DSH 运行 Node 24.18.1。
- 开始时 desktop/package.json 未声明该插件，bundles 也缺失；磁盘存在旧副本，不能视为运行生效。
- npm run build 退出 0；npm run pack:local 退出 0。
- 新产物：D:/huange-skill/artifacts/p0-20261013005030840。
- 新部署：%USERPROFILE%/.dsh/plugins/agent-memory-backpack-test-20261013。
- 项目部署脚本 --profiles desktop 完成，报告 active=true linked=yes。
- 原清单备份：D:/huange-skill/.local/dsh-desktop-test-20261013/backup/package.json。
- 桌面插件列表由 7 项变为 8 项，详情版本正确；冷启动前组件显示已关闭。
- 通过应用菜单退出并重新启动 DSH。日志 2026-10-13T00:53:35.793Z adapter.load、00:53:36.334Z adapter.config、00:53:36.931Z core.started，入口为新部署目录 runtime/cli.js。配置项目 p0-workflow，根 D:/huange-skill，核心 127.0.0.1:47631。

## 第一组真实会话结果

会话 session-955dfac4-8cf1-4bde-8de0-0dadda93ae8a，在 huange-skill 工作区通过桌面输入并发送。完成一个真实模型轮次，未启动子智能体。

| 项目 | 实测结果 |
|---|---|
| amb_prepare | 3 次真实调用成功，knowledgeRevision=2，Managed |
| amb_self_check | ok=true，范围、核心、协议、日志、版本等 7 项 pass |
| amb_search_workflows | 成功返回空列表，当前可见完整流程为 0 |
| amb_search_universal | 成功返回跨类型结果；工具回执文本 92930 字节 |
| amb_unstructured_skills | 成功，回执文本 32982 字节 |
| amb_read_knowledge | 普通 ID 和 ID@1 均成功，正文逐字相同、均无 U+FFFD |
| amb_knowledge_history | 成功，当前 revision=1、active，历史可读 |
| amb_read_stage 不存在流程 | isError=true，HTTP 404；预期错误，宿主继续完成轮次 |

12 个 AMB 工具被真实宿主模型枚举；第一组实际执行 8 种工具。

## 已确认差异与纠正

DSH amb_prepare 的 parameters 是 EMPTY_OBJECT_INPUT，execute 忽略参数且不传 query。前两次模型实际调用参数为 {}；第三次确实传 query，但回执 retrieval.query 仍为空。故 DSH 端不能使用该工具按任务 query 检索；这是适配器契约差异，不能宣称与 Codex 端查询能力完全一致。

prepare 工具回执反复 contextUnchanged=false，正文重复。自动注入去重由适配器 WeakMap 另行处理：本轮尚未独立核验自动注入次数，不能据工具回执宣布去重通过。

模型报告声称版本读取损坏字符、检索 4.44MB：原始回执均不支持。独立读取显示两次正文完全相同，检索工具回执约 93KB。不能直接引用模型总结为缺陷证据。

DSH 会话文件为串联 zstd 帧。应解压各帧后 Buffer.concat，再统一 UTF-8 解码；逐帧转字符串可能人为破坏跨帧中文。

原始解码会话：D:/huange-skill/.local/dsh-desktop-test-20261013/session-a.jsonl。
抽取回执：D:/huange-skill/.local/dsh-desktop-test-20261013/results-a.json。
这些文件包含本地知识正文，勿外发。

## 第二组真实会话与幂等

同一 DSH 桌面会话第二轮完成。至此 12 个 AMB 工具均被实际调用；不是每个工具都覆盖成功路径。

- 部署核验经验首次提交 pending，重复同一幂等键 duplicate=true，返回同一 ID 3b738a45-5e2c-4998-af90-01440dd7269e。候选仅一条，没有自动采纳。
- 当前库不存在指定完整流程，归属未解析，按未归属候选保存；不能声称结构化流程验证成功。
- amb_inspect_archive 不存在文件返回 404；amb_supersede_experience、amb_structure_skill 返回 403，验证权限拒绝，不验证正向写入。
- 原始回执：.local/dsh-desktop-test-20261013/session-ab.jsonl。所有原始知识内容仅保留本地。

## 管理页实操及修复

浏览器连接器未找到原 Chrome 标签后，改用可识别 URL 的应用内浏览器访问同一个本地核心。首次页面始终“正在读取核心”，开发日志报告 /ui/app.js SyntaxError。

确认 src/ui.ts 的外层模板将批量操作提示的单层换行转义变成 JavaScript 字符串内的真实换行，导致整个脚本解析失败。修复 10 处转义，并在 test/web-ui.test.ts 对实际 HTTP 提供的脚本使用 node:vm Script 做解析回归。修复后重新构建、备份部署 runtime/ui.js、替换并重启共享核心，浏览器重新加载正常连接。

实际 UI 覆盖：

| 页面/动作 | 实测结果 |
|---|---|
| 总览 | project=p0-workflow、知识版本2、连接成功、165生效条目 |
| 综合检索与管理 | 搜索“技能调度”，skill类型过滤有效，目标技能出现 |
| 规范与偏好 | 三条规范正确标记宿主加载；偏好空态正常 |
| 候选审阅 | DSH候选pending，内容、来源、审阅入口可见，未采纳 |
| 任务与日记 | 测试任务 task-1055ef7386766784 存在，工具调用/结果及轮次事件可读 |
| 跨端接续 | 生成知识版本、下一步和环境重核提示 |
| 临时资料 | 0条、90天保留期，未执行真实资料物理清理 |
| 历史追溯 | skill:577a28b2850ada49 当前v1 active及创建时间显示正确 |
| 自检与平台能力 | Managed、核心可达；能力表可读 |

任务仍 in_progress、unverified，没有把 Stop/轮次结束自动认定为完成。自检能力页的 DSH 路径显示 amb-verify 旧 profile，和本次实际 desktop 挂载路径不一致；应作为诊断展示问题，不据此判断本次插件未加载。

截图证据：.local/dsh-desktop-test-20261013/ui/overview.png、proposals.png、tasks-journal.png、search.png。测试中没有变更既有正式知识；另提交 UI 修复经验候选 ec215645-a4c6-4e92-9525-9b6396495945，pending未采纳。

## 自动验证与交付

- npm run check：通过。
- UI相关测试：14/14通过。
- npm test：共376，375通过，0失败，1跳过（需指定产物目录的package smoke）。首次失败是新增报告含本机用户名路径，已改为环境变量后通过。
- 桌面验收脚本：16自动项通过、0失败，6项标注需人工；脚本本身不证明桌面点击项全部完成。
- npm run pack:local：通过。修复后的产物 artifacts/p0-20261013011520735，包含hash manifest。
- 完整日志：.local/dsh-desktop-test-20261013/npm-test-final.log、acceptance.json、package-smoke.log。
- Git未提交：src/ui.ts、test/web-ui.test.ts、本报告。安装清单及运行时备份位于 .local/dsh-desktop-test-20261013/backup。

## 覆盖边界与剩余问题

本轮完成桌面部署、冷启动、两轮真实模型工具调用、幂等候选、权限/不存在错误路径、管理页八入口及回归验证。自动测试包含离线回放、门禁、跨项目隔离、任务接续、安装/卸载等隔离用例；这些不能替代真实桌面的停用、离线、门禁点击和长时间运行验收。真实知识库没有完整流程，因此真实桌面 read_stage/structure_skill/supersede 正向路径未覆盖；没有为验收改写正式知识。自动注入次数与去重尚未独立核验，不能宣布通过。DSH amb_prepare 忽略query及旧profile路径展示问题保留，未扩大修复范围。

额度检查2026-10-13约09:16 Asia/Shanghai：300分钟剩余72%，每周剩余79%，重置Unix1791870511、1792308740。没有低额度收尾或子智能体。

最终补验：指定 AMB_ARTIFACT_DIR 后产物 smoke 1/1通过（中文空格路径 CLI/MCP）；clean-install 3/3通过；部署代码/配置31文件与最终产物字节一致。最终总览待审候选2条（DSH部署经验及UI修复经验），知识版本仍2。最终截图 .local/dsh-desktop-test-20261013/ui/overview-final.png。总览已采纳技能数显示165，与总生效条目数相同；该统计口径未独立核验。
