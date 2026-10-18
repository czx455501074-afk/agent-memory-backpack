# 装配任务书（给 agent 执行）

> 这份文件是给**接手安装的 agent** 的任务书：按顺序执行，每步都有判据。使用者视角的说明在 [`../README.md`](../README.md)，仓库结构在 [`../AGENTS.md`](../AGENTS.md)。

## 目标

把 Agent Memory Backpack 装进宿主（DSH 与/或 Codex），并**用证据确认它真的在跑**——不是"命令没报错"。

## 步骤

**1. 确认前置条件**

```powershell
node -v      # 必须是 24.13–24.x
```

**2. 取到源码并构建**（本仓库未发布到 npm，这是唯一路径）

```powershell
git clone https://github.com/czx455501074-afk/agent-memory-backpack.git
cd agent-memory-backpack
npm ci --ignore-scripts
npm run build
```

判据：`dist/src/cli.js` 存在。

**3. 一条命令完成初始化**

```powershell
node dist/src/cli.js setup
```

它会：创建数据目录（默认 `~/.agent-memory-backpack`）、生成三组凭据（codex / dsh / admin，**只打印路径不打印值**）、收紧凭据 ACL、并**打印下一步的宿主命令**（profile 名与仓库路径都已解析，不需要你填）。

判据：输出里出现 `dsh plugin --profile <名字> add "<绝对路径>\adapters\dsh"`，且退出码为 0。

**4. 把插件装进宿主**（照抄上一步打印的那一行）

```powershell
dsh plugin --profile <你在用的 profile> add "<仓库路径>\adapters\dsh"
```

**不要手工往 `cordis.patch.yml` 里 insert 本插件**：它自带 bundle 补丁，安装命令会自动注册；重复 insert 会让加载器因 duplicate loader id 拒绝启动。

判据：`~/.dsh/profiles/<profile>/package.json` 里**两处**都出现它——`dependencies` 里的 `link:` 与 `dsh.profile.bundles` 数组里的一项。

**5. 重启宿主**（这一步只能由人做）

核心是**独立常驻服务**，宿主重启不会重启它；改了核心代码要另外重启：

```powershell
node dist/src/cli.js service stop ; Start-Sleep 3 ; node dist/src/cli.js service start ; node dist/src/cli.js service status
```

**6. 验证（两条判据，缺一不可）**

```powershell
node dist/src/cli.js doctor                      # 期望：fail=0（warn 可以有）
node scripts/verify-host-deployment.mjs          # 期望：RUNNING DEPLOYED BUILD
```

- `doctor` 的 `[留意]` 项是关于"当前会话是否已加载"的提醒，不是失败。
- `verify-host-deployment` 报 `PREVIOUS BUILD` 时**先重启宿主再谈验收**——本项目已经因为忽略这一步把排查方向带偏过一次。

## 边界与已知限制

- **仅 Windows x64**：macOS 缺 `icon.icns`，Linux 未验证。跨平台不在当前范围。
- **未发布到 npm**：所以没有 `npx` 捷径，也没有"一条命令装完"；上面第 2 步的 clone + build 是必需成本。
- **Codex 侧**的插件开关：`config.toml` 的 `[plugins."<id>"] enabled = false` 已实测有效；桌面 UI 里的开关未取得证据。
- 装完不要忘了：**库里已有的历史修订若含凭据形状的内容，导出会被守卫拒绝**。用 `backup --redact-credentials` 导出，或按拒绝信息给出的定位改写该条内容（拒绝信息会报出表:行与规则名，不回显值）。

## 失败时的排查顺序

1. `node dist/src/cli.js doctor` —— 自检逐项说明哪一步不通，并给可执行建议。
2. `node dist/src/cli.js service status` —— 区分"锁表示谁在运行"与"核心是否在回应"，这是两个不同的问题。
3. `node dist/src/cli.js logs --all-sources --level info` —— 插件与核心两侧的日志。
4. 工具在宿主里不出现时，先核对**版本线**（宿主会在加载前校验插件的 peer 范围，不匹配的组合会被整体跳过，工具与路由都不注册），再怀疑代码。
