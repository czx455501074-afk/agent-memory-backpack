# 发布清单（Agent Memory Backpack）

本清单回答一个问题：**现在能不能发。** 每项都必须能指向一条命令或一个文件，不接受"应该没问题"。

## 一、阻塞项（未解决就不发）

| # | 项 | 现状 | 判据 |
|---|---|---|---|
| B1 | **审核门禁必须在服务端强制** | ✅ 已修，有测试 | `Store.approveProposal` 内部调用 `classificationApprovalGate`（`src/store.ts` 的 2591 起，门禁在 2622）：缺判定、或 `autoPromotable` 为 `false`、或显式 `false` 时，必须带 `classificationAcknowledged: true` 才写入。三条入口各有测试——网页单条、网页批量（批中混有需确认项时整批拒绝并给出条数）、适配器路径（拒绝与理由回到适配器）——另有边界测试要求字段缺失与显式 `false` 都需确认、显式 `true` 不受影响。见 `test/classification-gate.test.ts`。 |
| B2 | **存量候选的分类判定未回填** | ✅ 代码已修并测试；⚠️ **真实库尚未执行**，此项需人工操作才能闭环 | `reclassify` 默认 dry-run、`--yes` 才写，只重算 `pending`（已采纳/已归档的判定、state、discovery 一律不动），payload 记录 `classifierVersion`，重跑幂等（dry-run 报全部跳过）。四条测试覆盖 dry-run / apply / 范围 / CLI 入口。真实库的 dry-run 已跑：扫描 408、待改 407，主要形态是 `[norm → memory]`。**尚未跑 `--yes`**，所以线上仍是旧判定。 |
| B3 | **捕获管线把自身并发冲突当经验候选** | ✅ 已修 | `refine.ts` 引入 `FailureOrigin`（`tool_collision` / `environment` / `task_failure`），`concurrent_edit_target_missing`、`concurrent_edit_file_changed` 等归入 `tool_collision`，且工具互踩与环境类签名**不进入阈值统计**（运行报告打印被排除的签名条数）。 |

**判断**：三项**代码层面均已修复**。B1 与 B3 可直接按测试证据判定；**B2 的代码已就绪但真实库未回填**，因此 README / CHANGELOG 里关于分类判定的描述在回填执行前仍与线上不符——**这一项只有人工执行 `reclassify --yes` 才能闭环，不要在回填前宣称一致**。

## 二、发布前必过（每次都跑）

```powershell
npm test                     # 全量；0 失败才能继续（prepublishOnly 也会跑一次）
node scripts/r5-acceptance.mjs        # 离线验收：检索可达规范 / 回执诚实
node scripts/r5-live-verify.mjs       # 对运行中的核心验收（需核心在跑）
node scripts/verify-deliverables.mjs  # 此前每一轮的交付是否还在（逐条契约检查）
node scripts/verify-tool-surface.mjs  # MCP 工具面与服务端 admin 白名单对账
node --test dist/test/clean-install.test.js   # 发布面不得含机器路径
npm pack --dry-run --json             # 包内容：不得含 .pyc、凭据、本地库
```

判据与已知基线：

- `npm test`：**645 项 / 643 通过 / 0 失败 / 2 跳过**（两项跳过是 opt-in 检索测量，需要调模型；跳过项必须带原因打印）。
- `r5-acceptance`：两项都要 PASS。
- `r5-live-verify`：11/11。其中 `mode=model` 证明走的是生产路径而不是降级路径——**这一项如果显示 `local_index`，说明验收脚本在测另一条路，结论作废**。
- `npm pack --dry-run`：82 个文件左右、约 0.40MB、含 `README.md` / `CHANGELOG.md` / `LICENSE`，不含 `__pycache__`。

## 三、版本与文档

1. `package.json` 的 `version` 与本版发布说明一致（当前 `1.0.0`；本轮修复批次若单独发布，建议 `1.1.0`——它含新能力而不只是修复）。
2. `CHANGELOG.md` 的「未发布」段落要么随版本发布改标题，要么明确保留。
3. `README.md` 里的事实需要复核（**测试数、能力清单、已知限制**三项最容易漂移：本轮就发现测试数写着 564 而实际是 641，注入去重的机制描述写反）。
4. 依赖版本是精确固定的（`@modelcontextprotocol/sdk`、`zod` 无 `^`），`engines.node` 写明 `>=24.13.0 <25`。

## 四、打包与安装验证（发布面从零开始）

```powershell
npm run pack:local           # 产物写入 artifacts/，含 node --check 全量语法门
npm run deploy:plugin        # 部署到宿主 profile（读穿链接复核）
node scripts/verify-host-deployment.mjs   # 判断宿主是否真的加载了新构建
```

- `verify-host-deployment.mjs` 必须报 **RUNNING DEPLOYED BUILD**。若报 PREVIOUS BUILD，**先重启宿主再谈验收**——本项目已经因为忽略这一步而把排查方向带偏过一次。
- **核心是独立常驻服务，不随宿主退出**：宿主重启后旧核心仍在服务，需要单独 `amb service stop` / `start`，否则会出现"适配器已更新、核心还是旧代码"。这一条务必写进发布说明。
- 从零安装验证：干净目录 `npm i <tarball>` → `node_modules/.bin/amb init` → `amb doctor`，确认能起来再发。

## 五、回滚与善后

- 部署脚本会保留三组备份（插件目录、core 目录、profile 的 `package.json` 与链接），路径打印在部署输出里。
- 代码回滚点写在每次发布的 release notes 里；本轮为 `552a9f9`、`ec1fc1d`、`6f6c25a`、`4dc8a2c` 之后的提交。
- 发布后检查一次真实库的 `pending` 规模与 `in_progress` 任务数，确认没有因为新逻辑把队列或任务表推向更糟。

## 六、明确不阻塞发布、但必须写进说明的

- 宿主侧任务归档接线尚未在真实宿主里被触发过（需重启后看 `task.archived` 日志）。
- 指针级注入在真实宿主上尚未发生过（114 轮样本为 0），重新部署重启后才会出现。
- 失败事实去重键仍含 sessionId（刻意保留：改了会让"出现次数"无法增长）。
- 排序长度因子来自单一样本，未做分布级调参。
- 仅支持 Windows x64。
- **本地自动匹配路径的质量尚未达到产品级**：盲测夹具（18 用例，`test/retrieval-blind.test.ts`）当前为精确率 **0.381**、召回率 0.727、该弃权时正确弃权 **4/7**，而夹具自身的 `acceptance` 字段是 `quality-gaps-present-not-product-acceptance`。已知缺口为版本适用性（v1/v2 互串、不支持的版本应当弃权却返回一切）与同义改写漏检。**本版不得被描述为"精准检索已达成"。**
- `gaps` 仍可能列出**词内 bigram 伪片段**（例如"回预"）：中文按重叠二元组切分，而条目里该词组可能分开出现，于是回执会报出对读者没有意义的"缺口"。它不影响选择结果，彻底解决需要真正的中文分词。
- **模型超时或弃权时，选择会降级为本地排名**。该路径已加上"必须携带本地证据"的门槛（无关查询的零证据注入由 4/8 降到 0/32），但降级路径的整体质量仍低于模型路径；实测相关查询约有四分之一会走降级，宿主重启与回填后需重新测量这一比例。
