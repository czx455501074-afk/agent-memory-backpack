# 重复注入防护与上下文收敛记录

**时间**：2026-10-10（Asia/Shanghai）
**触发**：排查「插件是否会破坏用户既有工作」时，发现宿主已原生加载同类指令文件。

## 一、发现的真实冲突

查证 DSH 安装内容时确认：

- DSH 自带 `@deepseek-ai/dsh-agent-instructions`，描述为 *Workspace context loader for AGENTS.md/CLAUDE.md instruction files*。
- 其候选清单为 `DEFAULT_INSTRUCTION_FILE_CANDIDATES = ["AGENTS.md", "CLAUDE.md"]`。
- 另有用户级作用域 `$DSH_HOME/AGENTS.md`（常量 `USER_GLOBAL_FILE = "AGENTS.md"`，目录标识 `user-global`）。
- 它还有自己的「基线替换」语义（`REPLACEMENT_AGENT_INSTRUCTIONS_INTRO` / `EMPTY_REPLACEMENT_...`）与字节预算压缩（`COMPACT_AGENT_INSTRUCTIONS_INTRO`）。

即：**宿主已经在加载并注入 `AGENTS.md`**。若插件采纳后再把同样正文注入一次，会造成两个真实问题：

1. **重复注入**：同一份指令在上下文里出现两次，浪费预算并可能让模型对「权威来源」产生混淆。
2. **语义冲突**：宿主用「基线替换」管理自己的注入，第三方再插一份游走于该机制之外，可能让用户看到互相矛盾的两份「工作契约」。

这正属于用户明确禁止的「破坏 agent 已产生的工作」。

## 二、修复：只在登记、不再注入

`normSchema` 新增 `hostProvided` 字段；`discover()` 在分类时标记宿主原生加载的文件（`agents.md` / `claude.md` / `agent.md`）。

行为区分：

| 场景 | 处理 |
|---|---|
| 宿主已加载的指令文件 | **仍索引、仍可检索、仍参与工具拒绝判定**，但 `prepare` 与 `gate` 不再重复发送其正文 |
| 插件自有规范 | 正常注入 |
| 上下文中的呈现 | 单列一行登记，例如「宿主已自行加载的规范（插件不重复注入，仅登记以便检索）：norm:xxx@1」 |

关键设计判断：**抑制的是「重复注入」，不是「效力」**。用户在 `AGENTS.md` 里写的工具禁止项依然生效——`gate()` 照常据此拒绝工具调用，只是不再把宿主已有的正文重发一遍。

## 三、验证

真实环境（采纳 22 条，其中 2 条为宿主 `AGENTS.md`）：

```
status: 200
norms injected: 0   workflows: 0   knowledge: 5
context chars: 2827   ~tokens: 942

宿主登记行存在: true
宿主 AGENTS.md 正文泄露进上下文: false
```

上下文从修复前的 26k–53k 字符收敛到 2827 字符（约 942 tokens），既消除了重复注入，也落进 2k–4k token 预算。

新增 2 项测试专门覆盖这一点：

- 宿主已加载的指令文件不重复注入，但其他规范正常注入。
- 宿主规范被抑制时仍参与工具拒绝判定（`deny` 生效，且拒绝理由里不含被抑制的正文）。

## 四、当前测试状态

**71 项测试，70 通过，1 条件跳过**（打包冒烟测试需 `AMB_ARTIFACT_DIR`）。

## 五、尚未完成

- 周期性重扫描：宿主 `AGENTS.md` 更新后，插件内的登记副本不会自动同步。
- 技能结构化转换：采纳的技能仍是 `needsStructure: true` 的原文。
- 真实桌面端安装与验收。
