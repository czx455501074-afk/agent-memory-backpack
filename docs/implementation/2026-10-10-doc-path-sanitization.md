# 文档路径脱敏记录

**时间**：2026-10-10（Asia/Shanghai）
**原因**：仓库计划在 GitHub 开源，文档中的机器特定绝对路径属于个人环境信息，不应随源码发布。

## 替换规则

| 原始形态 | 替换为 | 说明 |
|---|---|---|
| 本仓库克隆的绝对路径（`<drive>:\...\agent-memory-backpack`） | `<PROJECT_ROOT>` | 本机克隆位置 |
| 本机 harness 数据目录（`<drive>:\harness`） | `<DSH_HOME>` | DSH 数据目录 |
| 本机用户主目录（`<drive>:\Users\<name>`） | `<USER_HOME>` | 用户主目录 |

具体用户名为避免二次泄露，此处不记录原文。

替换使用字面量 `split/join`，未使用正则，避免反斜杠转义错误；写入时未改变 BOM（原文件本就无 BOM）。

## 受影响文件（6 个）

- `docs/implementation/p0-codex-evidence.md`
- `docs/implementation/p0-desktop-runbook.md`
- `docs/implementation/p0-dsh-evidence.md`
- `docs/plans/2026-10-09-joint-plan-signoff.md`

另有两个内部交接与评审记录同样被清洗，其后已移入 `docs/internal/`（不随开源发布），故不在此列出。

早前一轮已处理另外 4 个文件。

## 未改动的冻结文件

`docs/plans/2026-10-09-joint-plan-final.md` **刻意保持原样**：它的 SHA256 已被双方审定记录为
`da958e53ae2cb5dc7b6b8c331471d62c65952c24efdddd279b616a84cac000fe`，
修改会使该审定失去可核对性。该文件的路径引用本就是仓库内相对引用，不构成个人信息。

清洗后已复查：`docs/` 下再无机器特定的绝对路径字面量（即上表「原始形态」列的三种形态）；
冻结文件哈希仍与审定记录一致。

## 对审定记录的影响

`2026-10-09-joint-plan-signoff.md` 自身没有对外公布的哈希，其中的**结论文本与 SHA 值未被改动**，
仅路径字面量替换为占位符。因此双方对最终报告的一致结论依然有效，可核对目标（被审定的那份报告）
未发生变化。

## 后续约定

新增文档一律使用相对路径或占位符描述外部位置；机器相关的真实路径只写在本机配置中，
不进入仓库。`docs/implementation/dsh-current-runtime-inventory.md` 等含环境探测结论的文档，
记录的是**版本与契约**，位置一律以占位符表达。
