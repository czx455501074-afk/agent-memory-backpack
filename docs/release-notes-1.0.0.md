# Agent Memory Backpack 1.0.0

让 DSH 与 Codex 两个桌面共享同一份本地知识（规范、经验、完整流程）的插件。知识不是"一段可检索的文本"，而是**有版本、要审核、可门禁**的东西。

本版是首个正式版，范围仅限 **Windows x64**。

## 装哪个

**只要插件（推荐）**——知识库与两个桌面共用，不需要装桌面程序：

```powershell
git clone https://github.com/czx455501074-afk/agent-memory-backpack.git
cd agent-memory-backpack
npm ci --ignore-scripts
npm run build
npm run install:local          # 建数据目录、生成凭据、跑自检

# 装进 DSH（宿主自己的命令，不要手工改配置）
dsh plugin --profile <profile> add "$PWD\adapters\dsh"
```

然后重启 DSH。管理界面由核心自己提供，不需要额外窗口：`amb ui --open`。

**桌面安装包**（想用托盘常驻的原生窗口时）：下载本页的 `Agent Memory Backpack_1.0.0_x64-setup.exe`（NSIS）或 `.msi`。主窗默认隐藏、驻留托盘，由托盘菜单唤出。

## 发行物校验

| 文件 | 字节 | SHA256 |
|---|---|---|
| `Agent Memory Backpack_1.0.0_x64_en-US.msi` | 4,104,192 | `3D09849054D7677C4842EF7E6F175056FCC79A1D3836F4F383E645657479FC59` |
| `Agent Memory Backpack_1.0.0_x64-setup.exe` | 2,797,766 | `ECA182260B539D72D3B73568F865B0725421197C9679226C56CB106D6FA0AC44` |

校验：`Get-FileHash <文件> -Algorithm SHA256`。

## 这一版验证到什么程度

- **测试**：567 项。干净检出 **534 通过 / 0 失败 / 33 跳过**（每项跳过都带原因）；本机备齐前置条件 **565 通过 / 0 失败 / 2 跳过**（两个 opt-in 的检索测量，要调模型）。
- **面板六项**：用 Windows UI 自动化在真实宿主里逐项确认——候选显示自己的文本、元信息（提交于/来自任务/字数）、点摘要展开 `<pre>` 全文、按钮层级（采纳实心/拒绝描边/归档红色）、点采纳先出「类别 + 标题」表单再确认、键盘焦点描边随 Tab 移动。
- **停用（disable）用对照实验证明**：同一个真实配置、同一个真实 hook、同一个 `SessionStart` 事件，只改 `enabled` —— `false` 输出 **0 字节**，`true` 输出 **950 字符**含 `[agent-memory-backpack]` 标记；配置改动前后 SHA256 一致。
- **迁移闭环**：`.ambpack` 导出 → 官方 `inspect` 读回 → 隔离库导入，11 张表计数逐一一致；同包二次导入幂等（`imported:0 / wrote:false`）。
- **安全性**：只绑 `127.0.0.1`；凭据 / 协议 / Origin / Host 四道门实测生效（401 / 426 / 403 / 403）；写入路径全部参数化。

## 已知限制

- **仅 Windows x64**。macOS 缺 `icon.icns`、Linux 未验证，两者明确不在本次范围内。
- **未发布到 npm**，所以 `npx <包名>` 走不通；用上面的 clone 路径，或把本仓库装成依赖（`npm install <本仓库路径>`，装完即可用 `node_modules/.bin/amb`）。
- **导出边界**：库内任一历史修订含"密钥形状"内容时，导出会被守卫拒绝且不可逆（历史不可变 × 守卫拒敏感形状 × 只增不删 三者叠加的结果）。规避方式是**描述而不是逐字复制**。只影响导出，读/写/搜索/导入/门禁都不受影响。
- **Codex 桌面 UI 里的插件开关**未取得证据；`config.toml` 的 `[plugins."<id>"] enabled = false` 已实测有效。

## 一项刻意没做的取舍

没有向量语义检索、没有实体关系图谱、不做多模态。用全文索引 + 归一化替代，理由是当前规模（数百条）下词法足够、可解释、可离线。这是取舍，不是未完成。

完整判定见 [`docs/implementation/release-verdict-2026-10-16.md`](../docs/implementation/release-verdict-2026-10-16.md)，同类项目对比与改进项见 [`docs/implementation/peer-comparison-and-improvement-list-2026-10-17.md`](../docs/implementation/peer-comparison-and-improvement-list-2026-10-17.md)。

MIT 许可。
