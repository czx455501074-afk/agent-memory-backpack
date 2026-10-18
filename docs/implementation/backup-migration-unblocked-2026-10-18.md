# 备份与迁移打通（2026-10-18）

本文记录一条**用户级功能完全不可用**的排查与修复：这台机器上 `amb backup` 一直失败，而失败信息只说了一句 `Credential-shaped content refused`。修完才发现它挡住的不是一件事，而是三件叠在一起的缺陷。

## 一、现象

```powershell
node dist/src/cli.js backup --file D:\amb-backup.ambpack --yes
→ Credential-shaped content refused
```

连**干跑**（不带 `--yes`）都被拒，说明拒绝发生在扫描阶段、写入之前。

## 二、三处根因（按发现顺序）

### 1. 守卫只报结论，不报位置，也没有出路

旧实现的拒绝信息只有一句话，且 `guardContent` 只检查**第一个**匹配：

```ts
const m = CREDENTIAL_PATTERN.exec(value);   // 只找第一处
if (m) { ... refuse('Credential-shaped content refused'); }
```

后果两层：

- **漏检**：一个字符串里"先出现占位写法、后出现形状完整的值"时，守卫看了第一处就放行，后面的真形状从来没被检查过（修复后同一库的命中数 **13 → 46**）。
- **不可诊断**：不知道是哪条内容、哪个字段、哪条规则，用户与维护者唯一能做的选择是"删点东西直到能过"或"削弱检查"——而这道检查存在的全部意义就是不让任何人需要削弱它。

### 2. 导出与导入的规则不对称

导出侧明确论证并**跳过**派生全文索引表 `workflow_search`（它的文本被分词器规范化，检查它是假阳性）；导入侧却对它做内容检查。于是包只要含一处索引里的凭据形状文本，就**永远导不回去**。

同一类不对称还有第二处：导入侧拒绝"没有生效条目支撑的索引行"（`Orphan search row`）。真实库 906 条索引行里有 **81 条**违反该规则（7 条规范 + 74 条已退役条目），导出侧照原样搬运——**真实库的包从来无法 restore**，与本次修复无关，是既有缺陷。

### 3. 被改写的来源会让草案的绑定失效

`workflow_drafts` 用"来源 revision 的哈希"绑定其来源。改写来源正文（替换凭据形状的值）会让绑定不再成立，导入侧据此拒绝整个包——这是**正确**的拒绝。

## 三、修复

| 位置 | 改动 |
|---|---|
| `src/backup.ts` | `guardContent` 改为扫描**每一处**匹配（`matchAll`），一处不漏 |
| `src/backup.ts` | 拒绝信息带**定位与规则名**（`revisions:journal-….content〔Bearer 值〕`），收集**全部**命中后一次性报出，**不回显任何命中值** |
| `src/backup.ts` | 新增 `redactCredentials`：命中值替换为 `[REDACTED-CREDENTIAL]`，位置写入归档 manifest 的 `redacted`；**默认仍是拒绝** |
| `src/backup.ts` | 导出只搬运"权威表能证明的"索引行（active 且非规范），其余记入 `skipped` |
| `src/backup.ts` | 来源被改写的草案**不随包**，并如实记录原因；**绝不重算哈希去凑一致性** |
| `src/backup.ts` | 导入侧对 `workflow_search` 采用与导出相同的豁免 |
| `src/cli.ts` / `src/archive.ts` | `backup --redact-credentials`，输出报告替换处数与 manifest 位置 |
| `test/backup-redact.test.ts` | 7 条：逐条钉住上面每一项，含"未命中行逐字节不变"与"导出必能导入" |

## 四、实测数字（真实库，全程只读）

| 项 | 结果 |
|---|---|
| 默认导出（修复后） | 拒绝 **46 处**，全部来自 `journal-task-513e109a1a091ea4` 与 `skill:1c95972569b47488`——内容是该守卫自己的回归测试样本与修复记录，**无一处真实凭据** |
| redact 导出 | 成功，归档 **18.0 MB**，替换 **23 处**（位置见 manifest.redacted） |
| 包内含夹具样本 | **0**（`sk-ant-api03-…`、`ghp_0123456789…` 均不存在） |
| 导入隔离库 | **成功**：导入 909 条、跳过 1 条、知识版本 2710 |
| 草案 | 168 → **167**（被改写来源的那一条不随包，原因记录在 skipped） |
| 索引行 | 906 → **825**（无支撑的 81 条不随包） |
| 源库 | revisions **2838 未变**、REDACTED 标记 **0**、版本 2710 —— 导出不写源库 |

复现命令（隔离目录，任意路径）：

```powershell
$tmp = Join-Path $env:TEMP ('amb-check-' + (Get-Random)); New-Item -ItemType Directory $tmp
node dist/src/cli.js backup --file "$tmp\plain.ambpack"                        # 仍被拒，带定位
node dist/src/cli.js backup --file "$tmp\ok.ambpack" --redact-credentials --yes # 写出
node dist/src/cli.js init --data-dir "$tmp\lib"
node dist/src/cli.js restore --data-dir "$tmp\lib" --file "$tmp\ok.ambpack" --yes
```

## 五、边界（不要读成"凭据问题解决了"）

- **替换是"能匹配到就替换"**。索引表的文本已被分词器规范化，某些形状在那里不再匹配正则，替换可能不完整。因此本修复的准确说法是"**权威正文里的凭据形状值不进包**"，不是"包里绝对没有任何凭据形状的字节"。
- **被改写来源的草案不随包迁移**。它留在源机器上；目的地的知识、任务、候选队列、提案不受影响。
- **默认行为没有放宽**。不写 `--redact-credentials` 时，该拒绝的仍然拒绝——放宽只需一个显式开关，是为了让"库里有教学文本"不再等于"这台机器无法备份"。
- 这道守卫判定的是**形状**，不判断语义。库里记着自己的样本，正是它最容易自锁的地方；本次修复没有去猜"这是不是引用"，而是给了显式出路。

## 六、留下的问题

- `r5-acceptance.mjs` 的「回执诚实」仍 FAIL（另一条线：本地索引命中被严格证据门槛滤掉，回执把命中的词报成缺口）。
- 部署目录落后仓库（部署 09:32 / 源码 17:32），需重新 `pack:local` + `deploy:plugin` 并**单独重启常驻核心**，否则修复只在磁盘上。
