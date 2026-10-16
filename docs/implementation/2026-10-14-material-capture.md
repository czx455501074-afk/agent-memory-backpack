# 自动资料采集闭环（2026-10-14）

## 已实现

- DSH `tools/post-execute` 和 Codex `PostToolUse` 接入同一份资料提取逻辑，复用核心 `/v1/material/save`，默认启用；客户端 `autoCaptureMaterial: false` 可关闭，配置类型必须为 boolean。
- 仅接收明确页面读取工具：`web_fetch`、`webfetch`、`fetch_url`、`read_url`、`fetch_webpage`、`read_webpage`、`browser_read`、`browser.read`，以及以 `__` 分隔的同名 MCP 工具。不会抓取 shell、泛化 MCP、搜索摘要或任意 stdout。
- 成功结构对象必须带 HTTP(S) URL 及实际 `body/markdown/text/content` 字符串正文，正文至少 80 字符；支持 DSH 的 `body:{kind:'html'|'text',content}`、`value` 包装和最多三个 `pages`。失败、错误状态、带用户密码或敏感查询参数的 URL 被跳过。
- 来源 URL 保留，片段去除；正文最多 16,000 字符（保证中文正文序列化后仍在核心 64 KiB 请求上限内）、摘要为正文前 1,000 字符、标题最多 300 字符。已知客户端 token、私钥块和常见 token/password/secret 格式脱敏。不执行或解释页面内命令，资料标为 external，不能升级为规范。
- ID 由项目、会话、URL、脱敏正文散列产生；核心指纹进一步去重，重复读取不会续期。保留 90 天由核心资料规则管理，适用范围由调用凭据决定，不能通过正文宣称全局权限。
- `material.captured` 记录持久化回执及到期时间，不记录正文或 URL；网络/拒绝/无效回执仅记 `material.capture_failed`，不能声称保存成功。
- 可重试故障写入独立 `material-spool`，以 `queued_local` 回执区分本地排队与核心保存。每记录幂等文件、128 项/4 MiB 容量检查、7 天本地 TTL；目录 mode 0700、文件 mode 0600，Windows 继承父目录 ACL（未声称额外修改 NTFS ACL）。每次最多重放 5 条；两宿主会话恢复和工具完成路径接入。4xx 拒收不排队，重放 4xx 移除并记日志。
- `/v1/material/save` 新增可选 `capturedAt`，保留原采集时间并按原时点计算 90 天到期；未来或已过期时间拒收。省略字段的手动保存仍按当前时间默认处理。

## 真实检查结果

`node --test test/material-capture.test.mjs`：2/2 通过（2026-10-14）。

- 纯提取覆盖白名单、来源/正文缺失、错误、凭据 URL、脱敏、限长、多页上限、稳定 ID、两宿主模块字节相等。
- 临时 HTTP 核心和临时 SQLite：用独立数据库连接读回实际正文，验证 90 天、重复不续期、凭据作用域、关闭开关、失败日志。
- 使用真实 Codex `hook.mjs` 子进程投递 `PostToolUse`，同一临时核心和数据库观察到新增资料；工具提取与 hook 接入均实际执行。
- 离线落盘、重复排队只保留一条、恢复重放后 SQLite 可见，且到期时间仍为原捕获时间 +90 天；未来/过期 API 400 拒收，7 天过期本地条目清理均通过。`npm run build` 成功；加上已有失败采集回归合计 4/4 通过。

## DSH 实际工具结构证据

只读核对 `.local/dsh-runtime-0.2.0-rc.2/node_modules/@deepseek-ai/dsh-tool-web/lib/index.js`：第 737 行注册 `web_fetch`；第 806–814 行实际 `execute` 返回 `{url,statusCode,body:{kind,content},truncated}`。已将该结构加入提取回归用例。`dsh-web-fetch-http` 文档明确非 2xx 仍返回普通结构，因此状态码检查必不可少。

## 边界与未完成验收

- 未部署、未重启、未改真实配置或数据库。DSH 已安装版本的源码结构已核对，桌面真实浏览回合仍未在本轮执行；不能据此宣称所有浏览器/托管工具都已覆盖。
- Codex 测试证明本地 hook 入口可用，不证明宿主会为托管 `web.run` 发出本地 hook。当前不解析非结构化 `web.run` 结果；此类资料仍需主动调用 `amb_save_material`。
- 资料正文不进入经验候选 spool；独立 material spool 的 `queued_local` 不等于已进入核心。容量耗尽或磁盘不可写会记 `material.queue_failed`，不能承诺任何磁盘错误下都不丢数据。
- 模式匹配脱敏不能覆盖所有未知秘密格式，浏览得到的实际文本仍属于外部资料。资料不会自动成为技能或工作流。
