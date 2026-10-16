# 桌面验收报告来源说明（desktop-acceptance-report.json）

日期：2026-10-16。写入者：验收文档同步线（`docs/implementation/` 的唯一写入者）。

## 结论先行

`desktop-acceptance-report.json` 采用方案 **(b)：用最近一次真实验收运行的产物替换**，而不是把旧报告改写成"当前通过"。替换前的报告逐字节留档为 `desktop-acceptance-report-2026-10-15-superseded.json`（与原文件 SHA256 相同，见下）。

## 现行报告（本次真实运行）

- 运行命令：`node scripts/desktop-accept.mjs --workspace <TEMP>\workspace --data-dir <TEMP>\data --report <TEMP>\report.json`
- 隔离目录：系统临时目录下的 `amb-accept-sync-20261016-195645/`；workspace 与 data 均在临时目录，**未触碰**生产 `artifacts/`、`.local/` 与真实 profile。
- 原始退出码：`0`
- `ranAt`：`2026-10-16T11:56:51.360Z`
- `summary`：`pass=20 fail=0 skip=0 manual=6 automatedOk=true`
- `buildIdentity.matched`：`true` —— 产物清单记录的 commit 为 `fe8ceba8d0c82f81375b97dfe2b0f1b33a5302a7`（工作树 dirty），与当前 HEAD 一致
- 结果条目 26 条，其中 **6 条 `manual` 仍是 `manual`**
- 本文件 SHA256：`53C8C8082181EC5EA9DE5075CD6A33743F0D7B786CFD416DB348641069664F9A`（与脚本写出的临时报告逐字节相同）
- 留档的旧报告 SHA256：`0824BA641B9F1793C9965ED92506E8B3D7A0E8E672BF6CA0C5CF44FB1A94A63C`

`artifact` 项只**读取** `artifacts/p0-20261016112420166` 的清单并核对哈希（133 个文件全部匹配），未写入该目录。

## 仍待人工的 6 项（本次运行未改变）

`codex-load`、`codex-inject`、`dsh-load`、`dsh-inject`、`gate-deny`、`disable`。自动化不代点，报告只给出观察点与证据要求。**不得**因为自动项全绿而把它们记为通过。

## 被取代的旧结论

留档的旧报告对应 `2026-10-15T14:38:13.473Z` 的运行，`summary` 为 `pass=15 fail=1 skip=0 manual=6 automatedOk=false`。它记录的是**旧版脚本**的断言集合，至少三处已与现状不符：

1. `no-client-half`（fail）：标题「插件未声明无法加载的浏览器半」，detail 断言「声明了 dsh.client 或 ./client，宿主会尝试加载并失败」。**该假设已被推翻** —— 插件故意提供原生浏览器半 `adapters/dsh/client.js`，宿主加载它并在 `conversation.view` 渲染原生面板。现行断言是 `client-half-valid`，本次运行已通过。
2. `origin-refused`（旧语义）：标题「带 Origin 的浏览器式请求被拒绝」，detail「HTTP 403（核心不接受页面来源的请求）」。现行语义收紧为「**非回环** Origin 被拒绝（`403 origin_denied`）」，并新增 `origin-loopback-admitted`（回环 Origin 有意放行）与 `host-refused`（非回环 Host 被拒）。
3. 旧报告**缺少** `buildIdentity`、`same-build`、`latest-build`，因此无法证明它核对的产物出自哪一次构建。

其余同名条目（`artifact`、`plugin-files`、`bundle-patch`、`runtime-load`、`core-init`、`fresh-empty`、`core-health`、`auth-ok`、`auth-reject`、`project-isolation`、`core-log`、`self-check`、`no-credential-leak`、`core-output`）语义未变，但其中的具体数字（如「125 个文件」「端口 60988」）只属于那一次运行，不代表当前状态。

## 为什么两次运行不可直接比较

两版报告对应**不同版本的验收脚本**，条目集合不同。「失败 1 → 失败 0」不是同一断言的修复证据，只是断言集合发生了变化。判断当前状态时只引用现行报告；要跨版本比较，先对齐条目集合。

## 复现方式

```powershell
$t = Join-Path $env:TEMP "amb-accept-$(Get-Date -Format yyyyMMdd-HHmmss)"
node scripts/desktop-accept.mjs --workspace "$t\workspace" --data-dir "$t\data" --report "$t\report.json"
"exit=$LASTEXITCODE"
```

约定：三个路径一律指向系统临时目录，不写生产 `artifacts/`、`.local/` 与真实 profile；不加 `--keep` 时脚本自行清理临时夹具。引用前先 `JSON.parse` 校验。

## 未验证 / 无权改动

- 本次未运行任何构建（`npm run build` 由其它线负责），因此「验收所依据的 `dist/` 与产物来自哪次构建」仅以 `buildIdentity` 记录的 commit 与 dirty 状态为据。
- 未在真实桌面点击任何人工项：两端 Codex / DSH 的桌面交互结论仍为**未验证**。
- 其它 `docs/implementation/` 文档中可能仍有过时表述（例如涉及 `no-client-half`、旧 Origin 语义或 `/amb/ui-url` 的历史记录），本次无权修改，未逐份核实。
