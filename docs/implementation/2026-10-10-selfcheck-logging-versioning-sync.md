# 自我检测、运行日志、版本宽容与技能同步

**时间**：2026-10-10（Asia/Shanghai）
**来源**：用户新要求——「这个插件要有自我检测机制。还要有运行日志，方便查找问题，适用版本，不要只局限于现在的20. R2而是在更新之后也要能用」「还要定期同步用户skill，如果有新增插件同步新增。原有skill要向插件每skill同步，即使脱离插件技能依然可用」

## 一、自我检测（`doctor`）

回答"为什么不能用"，不需要用户复现问题。检查项：

| 检查 | 内容 |
|---|---|
| `client-config-present` | 适配器配置是否存在 |
| `client-config-shape` | 字段是否合法（含 endpoint 与 projectId） |
| `credential-shape` | 凭据**形态**（长度、前缀），绝不输出值 |
| `core-config-shape` | 核心配置是否合法 |
| `data-dir-writable` | 数据目录可写性 |
| `database-present` | 知识库是否已创建 |
| `log-writable` | 日志可写性（不可写则问题无法追溯） |
| `core-reachable` | 核心是否可达（含耗时） |
| `protocol-match` | 协议版本是否一致 |
| `host-runtime` | 宿主运行时版本（见下节） |

两条刻意的性质：**检查永不抛错**（诊断工具在最需要时崩掉毫无价值），**凭据永不打印**（输出可直接贴进 issue）。

```powershell
node dist/src/cli.js doctor            # 人类可读
node dist/src/cli.js doctor --json     # 机器可读
node dist/src/cli.js doctor --offline  # 跳过网络探测
```

## 二、运行日志

结构化 JSONL（一行一对象，普通工具可过滤），带级别、事件名与任意字段。

关键设计：

- **凭据绝不落盘**。任何名字形似密钥的字段（`token`/`authorization`/`secret`/`password`/`apikey`…）在写入前被替换，因为调用点不能指望每次都记得。这是日志器强制的，不是靠约定。
- **写日志绝不破坏被观察的功能**。每次写入都被守卫，磁盘只读或写满时降级为静默，不抛错。
- **版本戳**。每次启动写一条 `run.start`，含插件版本、Node 版本、平台、适配器 ID、扫描根与周期。这正是"更新后仍能解读旧日志"所必需的。
- 轮转：默认 1 MB × 保留 3 份。

```powershell
node dist/src/cli.js logs                       # 最近 50 条
node dist/src/cli.js logs --level warn          # 只看警告以上
node dist/src/cli.js logs --event rescan        # 按事件名过滤
node dist/src/cli.js logs --all --json          # 含轮转文件
```

## 三、版本宽容（"更新之后也要能用"）

**原缺陷**：`adapters/dsh/package.json` 的 `peerDependencies` 与测试都**硬钉** `0.2.0-rc.2`，宿主升级后插件直接无法加载。这与要求正面冲突。

**修复**：

1. `peerDependencies` 改为区间：`>=0.2.0-rc.1 <0.3`。区间是**宿主自己的兼容性检查器**接受的（已实测，见下）。
2. 版本**只警告不拒绝**。区间外（含主版本差异）报告为 `warn` 并附建议，不再 fail。依据是插件按**能力探测**而非版本号决定行为：缺失的能力会在加载时明确报错，不会静默降级。
3. 记录**已验证版本**：`dsh.verifiedWith` 声明实际跑过的组合（运行时 `0.2.0-rc.2`、Cordis `4.0.4`），与"支持范围"分开陈述。
4. 测试从"精确相等"改为"落在区间内"，并把"已验证版本"作为提示而非断言。

**决定性实测**：用宿主真实的 `evaluatePluginCompatibility`：
- 当前构建（`0.2.0-rc.2`）通过；
- 区间内的更晚版本（`0.2.9`）**同样通过**——证明是区间在决定，不是匹配今天的构建；
- 超出区间的依赖声明（`>=0.1.0 <0.2`）仍被拒绝——证明放宽没有变成空检查。

## 四、技能同步与脱离插件的可用性

### 定期同步扩展

两个真实缺陷被发现并修复：

1. **插件技能被漏掉**。默认扫描根只含用户技能目录，不含已安装插件携带的技能。现已扫描 `<home>/{.codex,.dsh,.agents}/plugins/**/skills`（深度限制 5 层，不跟随符号链接）。真实环境：扫描根 5 → **20**（含 15 个插件技能目录），可采纳项 22 → **56**。

2. **`cache` 段规则误杀整个插件根**。排除规则此前对**绝对路径**判定，而插件技能位于 `.../plugins/cache/...`，于是被 `cache` 段全部排除——这正是修复第 1 点前无法发现插件技能的原因。改为对**相对扫描根**判定：规则仍作用于根内部的运行时目录，但根自身的名字不参与判定。

顺带修正：`credentials.md` 这类凭据文档此前会被采纳并注入上下文。已加文件名规则排除，同时保留 `secret-management.md` 这类"关于密钥的流程"为合法知识。

### 脱离插件仍可用（`export`）

要求："即使脱离插件技能依然可用"。因此导出**不是**插件专用缓存，而是宿主本来就能读的 `SKILL.md` 结构：

- 输出为普通 Markdown，**无插件专有 front matter**；
- 工作流渲染为可读步骤（触发条件／前提／步骤／完成判据／失败处理）；
- 采纳的技能**原样保留正文**，不摘要不改写；
- 导出**幂等**：内容未变不重写；
- **拒绝写入无归属标记的目录**（空目录除外），因此不可能覆盖用户手写的技能。

```powershell
node dist/src/cli.js export --dir <目标>            # 干跑
node dist/src/cli.js export --dir <目标> --yes      # 执行
```

产物目录可读：`巡检技能-4082259f/SKILL.md`（标题 + 短哈希保证唯一）。

## 五、管理界面（Electron 桌面端）

按用户要求"exe 桌面端 UI，不要 http"，实现为独立 Electron 应用：

- **凭据只留在主进程**，渲染进程通过 IPC 取具名视图，页面拿不到 token；
- 主进程用**显式视图白名单**而非通用代理，页面无法让主进程携凭据访问任意路径；
- 核心的既有安全边界（拒绝带 Origin 的请求）**无需放宽**；
- 不修改 DSH 或 Codex 任何文件，不占用其插槽。

样式参考 Codex / codexrouter：克制的开发者工具风格，标识符用等宽字体，无装饰性元素。**深浅色跟随系统**，并可被 `data-theme` 显式覆盖。

过程中修复两个真实缺陷：
1. **主题覆盖无效**。只在 `[data-theme]` 上声明 `color-scheme` 无法覆盖媒体查询里的变量，两张截图哈希完全相同。修正为在显式选择块内重定义全部颜色令牌。
2. **`ELECTRON_RUN_AS_NODE` 导致难以理解的崩溃**。该变量使 Electron 退化为普通 Node，`require('electron')` 返回路径字符串。现已点名真正原因并给出处置办法。

界面已真实渲染并截图留存：`docs/implementation/console-dark.png`、`console-light.png`（深浅色内容确实不同）。

## 六、验证

- 全套 **108 项测试，107 通过，0 失败，1 条件跳过**。
- 新增测试：`operations`（11 项，日志/自检/导出）、`console`（4 项，含真实启动 Electron 并确认凭据不泄露）、`plugin-skills`（4 项，插件技能发现与凭据排除）。
- 实测命令：`doctor`（10 项检查、版本正确、不泄露凭据）、`logs`、`export`（幂等）、真实环境扫描（只读，`wrote=false`）。

## 七、仍未完成

- **技能结构化转换**仍未做：采纳的技能以原文保存并标记 `needsStructure`，不会被当作已核实的完整方法。程序无法从 Markdown 可靠推导有序步骤，伪造即是欺骗；机制已就绪（`structure` 命令 + `amb_structure_skill`），但语义结构必须由人或模型提供。
- **真实桌面端验收**：所有结论仍是代码路径与隔离运行库层面的判断，真实 DSH/Codex 桌面加载与自动触发尚未验收。清单见 `desktop-acceptance-checklist.md`。
- DSH 适配器尚未暴露 `structure`/`unstructured` 之外的运维命令（`doctor`/`logs`/`export` 仅为 CLI）。
