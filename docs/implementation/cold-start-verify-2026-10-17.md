# 冷启动验证记录（2026-10-17）

验证一个**全新用户**能否从零走通：安装 → 初始化 → 自检。全部在隔离 HOME 下进行，真实数据目录未被触碰。

## 一、作为依赖安装后，命令是否真的可用

在一个空的消费方项目里安装本包（`npm install <checkout>`），结果：

```
added 1 package in 386ms
node_modules\.bin\amb.cmd        EXISTS
运行 amb --help                  exit=0，列出 discover/adopt/rescan/supersede/history 等子命令
安装到的版本                     1.0.0
安装到的 bin                     {"amb":"dist/src/cli.js"}
```

**结论**：`bin` 声明有效——消费者拿到的不只是文件，而是一条可运行的命令。这是与同类项目（官方 MCP Memory、Basic Memory 等）对齐的那一项"零配置起步"。

## 二、全新用户能否开箱走通

在隔离 HOME 下依次执行初始化与自检：

```
amb init   → P0 configuration created at <隔离目录>
             Files written: codex(adapter), dsh(adapter), admin(admin)
             ACL ok codex/dsh/admin：凭据 ACL 已收紧为仅当前用户（+SYSTEM/Administrators），继承已移除
amb doctor → Agent Memory Backpack 自检：OK  pass=6 warn=5 fail=0 skip=3
             版本 plugin=1.0.0
             [通过] 适配器配置存在 / 配置字段合法 / 凭据格式（64 characters; value not printed）
             [通过] 核心配置合法（port=7777 适配器=codex/dsh/admin）/ 数据目录可写 / 运行日志可写
             [留意] 知识库存在 — 尚未创建（首次运行后生成）
             [留意] 插件运行日志 — 尚未生成（插件在宿主中加载后才会出现）
                    建议：在宿主中启用插件后重新运行自检
             [跳过] 核心可达 — 已按离线模式跳过
```

磁盘产物：`core.json` + 三份适配器凭据（codex/dsh/admin），共 5 个文件。

## 三、这轮验证说明了什么

1. **命令可用**：装完即能跑，版本与 `bin` 均正确。
2. **首启是自解释的**：`doctor` 不谎报——它把"知识库尚未创建"标为**留意**而不是通过，把离线跳过的项标为**跳过**而不是通过，并给出下一步建议。**"如实报告未知"比"全部显示绿色"更有用**，尤其是第一次运行时。
3. **凭据处理得当**：只打印路径不打印值；ACL 在初始化时就收紧到仅当前用户。这两条在冷启动阶段最容易做错，因为那正是权限最容易被放宽的时机。

## 四、本次未覆盖

- 真实宿主中的加载（DSH / Codex 的插件页交互）——需要人眼与鼠标，见 `dsh-panel-verify-2026-10-17.md` 与 `codex-side-verify-2026-10-17.md`。
- 从 npm registry 安装（本次是从本地 checkout 安装，二者在 `bin` 与 `files` 层面的行为一致，但 registry 还有发布元数据与体积因素）。