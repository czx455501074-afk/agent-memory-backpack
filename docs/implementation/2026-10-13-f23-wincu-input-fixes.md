# F23：wincu 插件输入层三缺陷的源码级修复

- 日期：2026-10-13
- 被测/被修：`dsh-computer-use-win@0.2.5`，`scripts/windows-uia.ps1`（112364 → 114997 字节）
- 发现方式：用插件自身的工具做真实操作，以**不依赖插件正确性**的量（UIA `value`、记事本字符计数）判定

## 1. 三个缺陷

| 编号 | 现象 | 根因 |
|---|---|---|
| **D1** | `activate:true` 时按键丢失（工具仍报 `ok:true`） | `Activate-TargetIfRequested` 把**顶层窗口**带到前台，焦点从文档子控件回到窗口层；按键落在无文本焦点的窗口上 |
| **D2** | 文档写法 `Ctrl+A` **100% 失败** | `Convert-KeyChord` 只把**独立元素**识别为修饰键；`Ctrl+A` 落入兜底分支成 `{CTRL+A}`，SendKeys 拒绝。`^a` 也被大写化破坏成 `^A` |
| **D3** | 多主键只发最后一个，且**上报误导** | 循环里 `$main = $key` 后者覆盖前者；响应却把调用方传入的 `keys` 数组**原样回显** |

三者共同点：**工具报告成功，实际输入丢失**——比直接报错更危险。

## 2. 修复内容

### D1：激活后把焦点交还给文本控件

```powershell
try { [void](Focus-TextControl $target) } catch { }
Start-Sleep -Milliseconds 40
```

`Focus-TextControl` 是文件内既有函数（`:571`），复用它而不是新写一套。

### D2：接受两种修饰键写法

`Convert-KeyChord` 增加 `Ctrl+A` 形式的展开（`^(.+?)\+(.+)$` 按 `+` 切分后并入 token 流），
使 `["Ctrl+A"]` 与 `["ctrl","a"]` 走**同一条路径**。同时移除了兜底分支里的
`.ToUpperInvariant()`——那正是把 `^a` 变成 `^A` 的原因。**接受 `Ctrl+A` 而不是改文档**，
因为文档示例就写着 `Ctrl+L`，且两个 upstream 测试都发分离形式、不会发现该不一致。

### D3：逐个发送并如实上报

`Convert-KeyChord` 改为**返回数组**（每个主键一个和弦），`keypress` 逐个 `SendWait`，
响应新增 `chords` 字段并让 `sendKeys` 反映**实际发送内容**（如 `"1 2 3"`）。
歧义情形**明确拒绝**并给出可操作指引：

```
A request may hold either one key with modifiers (['ctrl','a']) or several plain keys
(['1','2']), not both. Split it into separate calls.
```

`Win` 键黑名单保持不变（仍正确拒绝）。

## 3. 验证（全部以 UIA `value` 读回为准）

| 检查 | 修复前 | 修复后 |
|---|---|---|
| `["Ctrl+A"]` → 全选 → Delete | **报错** `关键字"CTRL+A"无效` | ✅ `sendKeys="^A"`，`value` 由 `AAABBBCCC` 变 `""` |
| `["1","2","3"]` | 只发 `3`（`value` 只多一个字符） | ✅ `sendKeys="1 2 3"`，`value` = `XY123` |
| `activate:true` 单键 | **`value` 不变**，`hasKeyboardFocus` 变 false | ✅ `value` = `XY1239`，`hasKeyboardFocus` 保持 true |
| `["Ctrl+Shift+X"]` | （未测，先前不可用） | ✅ `sendKeys="^+X"` |
| `["ctrl","1","2"]` 歧义 | 静默只发一个 | ✅ **明确拒绝**并说明如何拆分 |
| `["win","r"]` | 拒绝 | ✅ 仍然拒绝（未被削弱） |
| 插件全栈自检 | 退出 0 | ✅ 退出 0（未破坏其它功能） |
| PowerShell 语法 | — | ✅ 解析零错误；换行 CRLF 一致（2425/0 裸 LF） |

## 4. 部署状态与风险

- **已部署到**：`<USER_HOME>\.dsh\profiles\desktop\node_modules\dsh-computer-use-win\scripts\windows-uia.ps1`
- **备份**：同目录 `.bak-wincu-fix-20261013-004034`（112364 字节，原文件哈希
  `90D31E2CD96AE06EE5AC976C16AEA77C36BC7234E9DA60BF360CAA919441DED2`）
- **持久后端**需重启才加载新脚本——已通过终止 `windows-uia` 的 powershell 进程完成（插件下次调用自动重启）
- **风险**：本修复改在 **node_modules 内**，`pnpm` 重装或升级插件会覆盖。仓库内副本见
  `.local/wincu/fixed-windows-uia.ps1`；根治需向上游提 PR（见 §5）

## 5. 上游反馈建议

1. **D1/D2/D3 都可直接合入**，改动集中在两个函数，不改变外部接口（仅 `keypress` 响应**新增** `chords` 字段，
   向后兼容）。
2. 建议上游补测试：`Ctrl+L` 字面形式、多主键、`activate:true` 后的输入，这三条现有测试**都没覆盖**——
   这正是缺陷能存活的原因。
3. `activate` 的语义建议在文档里写清楚：它对**输入类**工具是"确保目标是前台"，但在目标已聚焦时
   会**先夺走**焦点，因此实现必须自己把焦点交还（本修复做的），或让 `activate` 对输入类工具默认不生效。
