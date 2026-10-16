# AMB 共享记忆：社区方案调研与移入记录

## 已确认目标

Codex 和 DSH 的任何项目会话共用一个 AMB 库，由 agent 按任务主动检索知识、经验与日记，验证新发现后提交经验候选。原始失败事实必须可追溯，不能被当作已验证规范。

基线为 `fe8ceba`。该提交已有省略 projectRoot 时的全会话模式及双向记忆指引。本轮在此基础上补齐捕获、检索指引、日志证据与共享库接续行为。明确配置 projectRoot 的独立安装继续保留范围限制。

## 上游来源与取舍

2026-10-14 拉取下列仓库的固定快照，读取相应实现与根 LICENSE。此轮是按行为重新实现，未复制上游源代码、提示词或资源，也未引入这些仓库的运行依赖。

| 项目与快照 | 已读入口 | 采用的行为 / 取舍 |
| --- | --- | --- |
| [Hindsight coding-agents](https://github.com/vectorize-io/hindsight/tree/7a2df55b08f42784aebc3f9c2be8b414859d81a0/hindsight-integrations/coding-agents)，MIT | `src/dsh.ts`、`src/core/turn-journal.ts` | 按宿主事件挂接检索/写回、保留来源与幂等记录。该 DSH 实现按工作区建 RuntimeCore；AMB 按用户要求使用已有统一库身份。 |
| [OpenViking DSH 插件](https://github.com/volcengine/OpenViking/tree/a55e423b8bb9d9545f507c301d7d0ae5414fe7e4/examples/dsh-memory-plugin)，根许可证 AGPL-3.0 | `index.mjs`、`skills/ov-experience-memory/SKILL.md` | 检索后读正文、根据失败证据进行有界再检索。仅作为设计参照，未复制代码或技能文本。 |
| [Prime Memory](https://github.com/drscrewdriver/dsh-prime-memory/tree/918d5638ae0d1b73bb44716b0d72edb2d70c4332)，MIT | `src/hooks/capture.ts`、`src/util/redact.ts` | 捕获边界脱敏、原始事实和提炼结论分层。AMB 只保留结构化失败的短摘要，不复制完整会话。 |
| [Auto Memory](https://github.com/Aik358/dsh-auto-memory/tree/054942b54d15f46c4421c64d77c8de921e5042ab)，BSD-3-Clause | `lib/index.js`、README.zh-CN | 简短常驻指引、按需检索和展开、检索可跨工作区。未搬入其模型调用、自动晋升或大型嵌入组件。 |
| [Mneme](https://github.com/slow-stack/mneme/tree/a5bb13e05b9ff57f97e37c4fac87b82742f199ce/dsh-mneme)，MIT | `src/recall-stats.js`、`lib/index.js` | 区分检索、注入和捕获的观测口径；本轮采用事件日志，不引入统计面板、图谱或后台 dream。 |
| [Meow Memory](https://github.com/Phant0Meow/dsh-meow-memory/tree/90b642b4851aa1751506b2f295dc1316976b5ca4)，MIT | `src/index.ts`、`src/prompts/zh/system-guide.md` | 明确工具使用指引；参考其按宿主事件核实生命周期的做法。未复制提示词或反思引擎。 |
| [DSH Plugin Guide](https://github.com/PerryLink/dsh-plugin-guide/tree/4e35e31be5248fb602cd1ca650f93890ba19555a)，Apache-2.0 | `index.js`、README、LICENSE | 按需加载知识指引；宿主合同最终由本地 0.2.0-rc.2 源码和真实 ToolRuntime 验证。 |

额外 GitHub 检索发现 [haitang1/dsh-memory](https://github.com/haitang1/dsh-memory)（全局默认、MCP 共享存储、根代理回合摘要）与 [zilliztech/memsearch](https://github.com/zilliztech/memsearch)（多 agent 共用记忆层）。本轮未移植其代码：前者回合蒸馏需要额外模型调用，后者带有不同的索引后端；当前缺口可用 AMB 现有 SQLite、工具和队列解决。

## 本轮实现

- 两端使用相同的 `failure-capture.mjs`。只识别宿主的 `isError` / `is_error` 或结构化非零退出码。成功输出中出现 error 字样不会触发记录。
- 捕获结果提交到原有候选队列，写明来源会话、工具、所属“工具执行与故障恢复”流程和待核实状态。只存短错误摘要；不收集命令、参数或完整工具输出。工具名、会话标识和错误摘要在持久化前脱敏。
- 同一 adapter、库身份、会话、工具及相同错误摘要生成稳定幂等键，重放不会重复新增。默认开启；客户端配置可显式设置 `autoCaptureFailures: false`。失败事实不会自动批准。
- 服务不可达时回退到已有本地 spool，记录 `queued_local`。4xx 拒绝不会入队循环重试。候选写入失败不会修改原工具结果或假称已送达。
- DSH 接入真实 `tools/post-execute(exec, result, next)`；Codex 接入现有 PostToolUse。失败后引导搜索错误、读取经验、验证根因与修复后提交可复用结论。未向任意成功回合生成虚构经验。
- Codex 技能和共享 prepare 指引说明 `amb_search_universal` → `amb_read_knowledge` 的主动检索路径，覆盖日记等现有知识类型，并区分 pending、queued_local 和已采纳。
- 默认 info 日志新增 `context.injected`（含 adapter、session、知识 id）、DSH `tool.ok`、Codex `knowledge.call` / `knowledge.failed` 和 `experience.captured` / `experience.queued` / `experience.rejected` / `experience.queue_failed`。候选日志包含回执 id/state，不记录正文。
- 全会话模式中，泛化的“继续”只接续已关联当前会话的任务；用户明确给出 taskId 仍可接续指定任务。显式 projectRoot 的旧项目范围接续保持原有行为。

## 验证

- `npm test`：390 通过，0 失败，0 跳过。最初发现的 3 处回归（指引长度上限、旧项目范围接续两例）已修复，再跑全量通过。
- 最后的配置形状检查修改后，运行相关 24 项测试，全部通过。
- 真实 DSH 0.2.0-rc.2 ToolRuntime：不同 cwd 会话读取同库，重复真实工具异常仅一条 pending 候选，凭据不进候选或日志，Codex CoreClient 能读取同一条知识。
- Codex hook 作为独立进程运行，范围外 cwd 在全局配置下提交候选；稳定重试键且不转发原始输出。
- 故障队列、4xx 不重放、关闭捕获、脱敏、成功诊断不误判均有专门测试。
- `npm run pack:local` 生成两端插件及 core，打包脚本逐文件核对源码一致性。构建入口通过 Node 语法检查。

## 生效边界

这是本地开发构建，未发布 npm/GitHub release。更新本机安装文件前逐文件备份并记录 SHA-256；不改凭据、数据库或 profile 组成。

本机部署：DSH 的 `<HARNESS_HOME>\toolchains\<PLUGIN_TOOLCHAIN>\agent-memory-backpack` 与 Codex 插件缓存 `<USER_HOME>\.codex\plugins\cache\agent-memory-backpack-local\agent-memory-backpack\0.1.0-p0.1` 共更新 16 个文件。备份与前后 SHA-256 清单：`<PROJECT_ROOT>\.local\memory-deploy-1791977609557\manifest.json`；复查部署差异为 0。构建产物：`<PROJECT_ROOT>\artifacts\p0-20261014113216703`。

回滚时，按 manifest 将 backup 目录中 dsh/codex 对应旧文件复制回 dest；before 为 null 的条目是本次新增文件，应仅在旧入口已恢复后移走。不要删除安装目录、凭据或数据库。当前没有停止任何 DSH、MCP 或核心进程。

曾尝试更新原监控以区分三类证据；应用返回 automation `dsh` 不存在，未重建或恢复定时任务。接入经验已提交待审候选 `34135563-51dc-4630-81f8-6bf38cf5da45`（pending），未晋升正式知识；因库内没有已结构化的对应流程，回执显示未归属，仍需人工确认。

已启动 DSH 的 ESM 模块和已建立 Codex MCP 进程不能仅凭磁盘文件更新就视为重载。DSH 捕获/默认日志需要下次加载插件，MCP 调用日志需要下次建立 MCP 进程；共享核心中的新 prepare 文本需要核心下次启动。Codex hook 每次独立启动，下一次受支持 hook 即可读取新文件。测试环境通过不等于当前用户 DSH 会话已经使用新模块。

现有 PostToolUse 未覆盖宿主不提供的失败事件或不受支持的工具路径。只有结构化失败可自动捕获；纯文本输出中的业务错误仍需 agent 判断并主动提交。未验证任意模型一定遵循检索指引；实际读取以工具调用日志为证据。
