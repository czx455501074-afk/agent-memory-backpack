# wincu 插件实操测试记录（第一批：输入层与观察层）

- 日期：2026-10-13
- 被测：`dsh-computer-use-win@0.2.5`，装入 `desktop` profile（DSH 0.2.0-rc.2，Node 24.19.0）
- 方法：用插件自身的 `mcp__wincu__*` 工具操作**真实应用**，并用**可精确读回的量**判定结果

## 0. 方法说明：为什么不用 OCR 做判定

对 Codex（Chromium 画布）窗口做 OCR 时识别质量明显不足——"插件"读成"播件"、"测试"读成"试"、
"知识"读成"知"、"账号"读成"号"。用这种噪声判断"某字符是否丢失"是不可能的，而且**我一开始就因此
误判了一次**（见 §3 D0）。

改用**记事本**作为判定基座，它提供两个**独立于被测插件**的精确量：

1. **UIA `value`**：文档控件的真实文本，可逐字符比对；
2. **状态栏字符计数**：应用自己算的 `N 个字符`。

凡下文写"确认"，均以这两者之一为依据，而非 OCR 或截图目测。

## 1. 部署与可用性（已确认）

| 项目 | 证据 |
|---|---|
| 安装 | `dsh-plugin add` 成功；`cordis.patch.yml`、`mcp/server.mjs`、`scripts/windows-uia.ps1` 均落地 |
| bundle 路径解析 | `createRequire(profile/package.json).resolve('dsh-computer-use-win/mcp/server.mjs')` 解析成功 |
| 全栈自检 | `node mcp/server.mjs --self-test` 退出 0；桌面引擎、UIA、截图、SendInput、OCR、homing、failsafe 全部上报可用 |
| MCP 协议握手 | `initialize` → `tools/list` → `tools/call` 全通；**22 个工具**全部枚举、无缺无多 |
| 工具命名 | MCP 层为 `windows_computer_use_*`；经 DSH 桥接后模型侧为 `mcp__wincu__*` |
| 实际可用 | 本会话已直接调用 `health`/`list_windows`/`accessibility_tree`/`find`/`snapshot`/`ocr`/`click`/`type_text`/`keypress`/`set_value`/`invoke`/`move_window` 并取得真实效果 |

`health` 回报：`powershell=5.1.26100.9444, mode=persistent, uiAutomation=true, screenshot=true,
sendInput=true, postmessage=true, ocr=lazy, homing=true, failsafe=true`。

## 2. 已确认正常的能力

| 工具 | 验证方式与结果 |
|---|---|
| `list_windows` | 枚举 8 个真实窗口（`ChatGPT`、`Grok Bot`、`设置`、`Program Manager` 等） |
| `accessibility_tree` | 记事本树完整：`Notepad → NotepadTextBox → 文本编辑器(RichEditD2DPT)`，含 boundingBox 与 runtimeId |
| `find` | 按 `controlType`+`query` 命中，返回 `id`/`value`/`patterns`；中英文均可 |
| `snapshot` | 树 + `PrintWindow` 截图（非前台窗口也能抓），带 `imageScale`/`origin` 坐标映射 |
| `click` | **真实生效**：坐标点击后焦点转移到文档控件（`hasKeyboardFocus: true`） |
| `type_text`（clipboard） | **不丢字**：写入 `ABCDEFGHIJ` → 状态栏 `10 个字符`、`value` 逐字符一致 |
| `type_text`（sendinput-unicode） | 可用：追加 `Z` 成功；无粘贴场景（如密码框）走这条 |
| `keypress` 单键（聚焦时） | 可用：`"1"` → `…Zy1` |
| `keypress` 命名键（聚焦时） | 可用：`{ENTER}` → 插入 `\r` |
| `keypress` 修饰键（分离写法） | 可用：`["ctrl","a"]` → `^a`；`["ctrl","n"]` 在记事本开新标签页；`["ctrl","w"]` 关标签页 |
| `set_value` | 可用：`ValuePattern`，值精确写入（`SETVALUE-OK` 完整出现在 `value` 与标题） |
| `invoke` | 可用：`Toggle` 切换工具栏按钮；`Invoke` 点掉"不保存"对话框按钮 |
| `move_window` | 可用：窗口移动到指定坐标并生效 |
| **Win 键黑名单** | **正确拒绝**：`["win","r"]` 返回明确错误并说明理由 |

## 3. 确认的缺陷

### D1（中）`activate:true` 会夺走输入焦点，导致按键丢失

| 调用（文档控件已聚焦） | 结果 |
|---|---|
| `keypress ["y"], activate:true` | **值不变**；事后 `hasKeyboardFocus` 由 true 变 **false** |
| 先 `click` 聚焦，再 `keypress ["y"], activate:false` | 值变为 `…Zy` → **正常** |

**机理**：`activate` 把**顶层窗口**带到前台，焦点从**文档子控件**回到窗口层；合成的按键落在没有
文本输入焦点的窗口上，于是丢失。

**影响**：按文档"输入类工具也支持 activate"去用，会得到"工具报告成功、实际什么都没输入"。
这是最容易被踩的坑。

### D2（中）组合键写法与文档不一致：`Ctrl+L` 形式 100% 失败

| 输入 | 实际 `sendKeys` | 结果 |
|---|---|---|
| `keys=["Ctrl+A"]` | `{CTRL+A}` | 报错 `关键字"CTRL+A"无效` |
| `keys=["^a"]` | `^A` | 报错 `关键字"^A"无效`（被大写化破坏） |
| `keys=["ctrl","a"]` | `^a` | **成功** |

**根因**：`Convert-KeyChord`（`scripts/windows-uia.ps1:1467`）只把**独立元素**识别为修饰键；
`Ctrl+A` 单字符串形式落入兜底分支 `"{" + 大写 + "}"`，既非修饰键也非命名键。
报错信息直接暴露内部编码（`{CTRL+A}`），用户无从得知正确写法。

### D3（中）多主键被静默丢弃，且上报误导

| 调用 | `sendKeys` | `value` 变化 |
|---|---|---|
| `keys=["1","2"]` | `"2"` | 只追加 `2`，`1` 丢失 |
| `keys=["a","b"]` | `"b"` | 未追加（当时另有 D1 干扰） |

**根因**：`Convert-KeyChord` 的循环对每个非修饰键执行 `$main = $key`，后者覆盖前者，只保留**最后一个**；
而响应把**调用方传入的 `keys` 数组原样回显**，于是调用者以为两个键都发了。

## 4. D0：我在此项测试中自己的误判（如实记录）

第一次对 Codex 窗口 `type_text` 后，OCR 显示文本开头为 `ncu 插件实操测试`（缺 `wi`），
我一度怀疑 `type_text` 丢首字符。**改用记事本 + 字符计数复测后确认：`type_text` 不丢字**
（10 字符写入、计数 10、`value` 完全一致）。

**教训**：不能拿一个本身不可靠的观测器（画布 OCR）去判定被测对象的正确性。这是本会话第三次
"测量对象/工具选错导致笃定但错误的结论"。

## 5. 尚未测（下一批）

- `scroll` / `move` / `drag` / `wait_for` / `close_window` 逐项实测
- 安全机制主动触发：failsafe 急停、identity guard（窗口被换）、`stale` 元素处理
- `ocr` 对 **Win32 控件**与 **CJK** 的准确度单独评估（本批只发现了画布场景的噪声）
- `activate:true` 在**非输入类**工具（截图、窗口管理）上是否正确（预期：正确，问题仅限输入类）

## 6. 结论

观察层（树/截图/查找/OCR）与语义动作层（`invoke`/`set_value`）**在正确用法下可靠**；
输入层有 **3 个确认缺陷**，全部集中在 `Convert-KeyChord` 与 `activate` 的焦点处理，属**源码级可修**。
