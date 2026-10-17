# 发布清单（Agent Memory Backpack）

本清单回答一个问题：**现在能不能发。** 每项都必须能指向一条命令或一个文件，不接受"应该没问题"。

## 一、阻塞项（未解决就不发）

| # | 项 | 现状 | 判据 |
|---|---|---|---|
| B1 | **审核门禁必须在服务端强制** | ❌ 未修 | 门禁目前只存在于 DSH 适配器，网页界面的单条批准与批量批准完全不查，服务端 `/v1/proposals/approve` 也不查分类判定。"经验不会被一键升格成规则"这条产品描述因此不成立。修后：从三个入口各留一条测试，都无法在无人工确认时写入。 |
| B2 | **存量候选的分类判定未回填** | ❌ 未修 | 库里 360 条待审仍有 255 条标着 `norm`（用当前分类器重算应为 13 条）。修后：给出回填前后的只读对比数字，且 payload 里记录分类器版本。 |
| B3 | **捕获管线把自身并发冲突当经验候选** | ❌ 未修 | 140 条失败事实里有 11 条"目标串不存在"、9 条"文件已被他人修改"，都来自工具互相踩踏。它们会抬高观测阈值，也可能被提炼成错误规范。修后：按来源分类，事故类不提炼且不参与阈值统计。 |

**判断**：B1 与 B2 直接违背 README 与 CHANGELOG 里已经写下的能力描述，属于**发布阻塞**；B3 是质量问题，会在发布后持续污染库，建议同批修掉但不单独阻塞。

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
