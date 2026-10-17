# 归档导入导出审计（R5）

`.ambpack` 是这套系统里唯一能把外部内容带进知识库的入口，也是唯一的迁移通道。发布前把它读一遍：**合并会不会覆盖本地已采纳的知识？revision 会不会回退？失败会不会留下半截状态？**

本文件只做审计，**未改动任何代码**。结论：**满足发布要求**，两点观察记在末尾。

## 一、解包路径（`src/archive.ts:138-168`）

| 检查 | 事实 |
|---|---|
| 体积炸弹 | `gunzipSync(raw, { maxOutputLength: MAX_ARCHIVE_BYTES })`，超限给出明确错误（区分 `ERR_BUFFER_TOO_LARGE`） |
| 是不是本工具的归档 | **必须包含 manifest**（`BACKUP_MARKER`），否则拒绝："it is not an Agent Memory Backpack file" |
| 临时目录 | 解包到 `mkdtempSync`，`withTemp` 在 `finally` 里 `rmSync` 清理——**校验失败也不会把用户的知识留在系统临时目录里** |
| 未知条目名 | 逐条 `writeFileSync(join(directory, entry.name))`（如实现中有路径穿越防护则在 `untar` 层，本次审计未展开这一层） |

`inspectArchive` 只读 manifest，**不碰知识库**；CLI 的 `restore` 因此可以"先看再合"。

## 二、合并策略（`src/backup.ts:320-357`）——这是关键部分

| 情形 | 行为 |
|---|---|
| **默认冲突策略** | `onConflict: 'skip'`（`server.ts:931` 的默认值）。即：**默认不覆盖本地**；要严格失败须显式传 `'fail'`（抛 409） |
| 本地已有同一行（按 id / `(id,revision)` / `proposal_id` / 身份键 `principal+event_id` 或 `idem`） | 记为冲突并**跳过**，理由 "Local ledger row differs" |
| `knowledge` 行已存在 | **只 `UPDATE head, status`**，不覆盖内容 → **revision 血缘被保护** |
| `revision` 这个 meta 键 | 取**两者最大值**（`Math.max`）→ 知识版本**单调不回退** |
| 其他 meta 设置项 | 若本地 `revision ≠ 0`（即本地已在用）则**保留本地设置**并记为冲突 |
| `checkpoint:*` 回执 | 本地已有即冲突跳过（本地回执为准） |
| 执行时机 | 先算好 `operations` 列表，`dryRun` 时不执行；只有 `!dryRun` 才逐条执行 → **dry-run 真的不写** |

**四点结论**：① 导入是**保守 merge**，不会静默覆盖本地已采纳的知识；② 知识版本单调性被显式保护（取最大值，不是取后者覆盖）；③ 本地设置优先；④ 失败不会产生"写一半"的库状态（先收集后执行）。

## 三、两点观察（不阻塞发布，如实记录）

1. **没有校验和或签名**：归档只保证"gzip + tar + 有 manifest"，任何能构造出这种文件的人都能做出一个会被接受的归档。对一个**本地迁移工具**这是可接受的取舍（威胁模型是"用户自己的两台机器之间搬数据"），但如果将来支持"从他人处获取 `.ambpack`"，就应当补上来源标识与完整性校验。
2. **没有"来源未知"的信任提示**：导入进来的内容会进入知识库、并可能被**注入**到 agent 上下文里。这与 `r5-injection-trust-audit.md` 记的那条链直接相连——**导入是那条链的上游**。低成本处置：导入完成后，在回执与 `amb doctor` 里标明"本库含 N 条来自外部归档的内容"。

## 四、本次审计没有做的事

- 没有实际构造恶意归档去试探解包路径（例如 tar 条目名含 `..`）。`untar` 层的路径穿越防护**未逐行核对**。
- 没有做跨版本语义验证（旧版归档导入新版）。
- 没有验证大体积归档的性能。
