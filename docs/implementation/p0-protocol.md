# P0 最小接入试验合同 v1

只用于制作可运行的双端接入试验，不宣称已交付所有知识治理功能。总工程师当前冻结此接口，后续改动需同步两个适配器。

核心：Node24，HTTP仅127.0.0.1，默认端口动态由初始化配置提供；所有 `/v1/*` 请求Bearer适配器token；GET `/health`仅返回协议版本和状态，不泄露知识。客户端配置文件 `{endpoint,token,projectId}` 路径取 `AMB_CONFIG`，不把token写入插件manifest。未配置显式错误，不默认跳到未知服务。

每个适配器实现HTTP客户端，超时<=5秒，不自动重试有副作用POST；所有POST带 `X-AMB-Protocol: 1`，缺失或不匹配返回426。事件/提交按idempotencyKey去重可在以后实现持久重试。

Codex默认配置 `~/.agent-memory-backpack/client.json`（内容与codex-client.json相同）。DSH默认 `~/.agent-memory-backpack/dsh-client.json`，可用 `AMB_DSH_CONFIG` 或 `AMB_CONFIG` 指定；两端token独立且绑定固定adapter及项目，不能互用。

CLI生成客户端配置新增 `projectRoot`（绝对路径），自动hook必须核对真实宿主工作目录，不能因为profile全局加载就对其他项目应用该项目规范。缺少可靠目录绑定需显式标记自动能力不足。API端仍按凭据限定projectId。上下文/gate/event允许单独的sessionId字段，不把sessionId冒充taskId。gate.context返回当前规范全文，不是仅被拒绝的规范。

POST `/v1/prepare`：`{adapter:'codex'|'dsh',projectId,taskId?,query?}`；返回 `{protocolVersion:1,knowledgeRevision:number,mode:'Managed',norms:array,workflows:array,context:string}`。context是当前规范和完整流程入口概览，非全量细节。

POST `/v1/gate`：`{adapter,projectId,taskId?,toolName,knowledgeRevision?}`；返回 `{decision:'allow'|'deny',reason:string,knowledgeRevision:number,context:string}`。核心只执行明确登记的工具名禁用政策，不能假装理解任意自然语言规范。核心失联时hook在其覆盖的路径上拒绝继续，不允许静默以旧规范运行。

POST `/v1/proposals`：`{idempotencyKey,projectId,taskId?,workflowId?,baseRevision?,discovery:string}`；返回 `{id,state:'pending',duplicate:boolean}`。P0只验证可靠提交和回执，不能直接晋升有效经验。

POST `/v1/events`：`{eventId,adapter,projectId,taskId?,kind,summary}`；返回 `{id,stored:true,duplicate:boolean}`。只传短摘要，不能提交完整工具输出或凭据。Stop只记turn_stopped，绝不等同task_completed。

POST `/v1/search`：`{projectId,query}` 返回完整流程入口；POST `/v1/expand`：`{projectId,workflowId,stageId}` 返回单阶段和完整性信息，必需依赖不可用明确失败。

适配器公共工具建议：`amb_prepare`、`amb_search_workflows`、`amb_read_stage`、`amb_submit_experience`。用户授予客户端的只有读取、候选提交和事件记录权限；admin变更种子规范通过核心CLI单独管理，agent工具不暴露直接生效入口。

自动hook只绑定真实宿主支持的事件。Codex命令stdin/stdout格式以官方文档为准；DSH事件签名以安装的0.1.7-rc.1类型和运行库为准。任意工具/网页不在hook覆盖内时如实说明。

程序位置约定：TypeScript源码src，构建输出dist/src；CLI `node dist/src/cli.js`；MCP入口 `node dist/src/mcp.js`；Codex hook脚本单独位于 `adapters/codex/scripts/hook.mjs`，插件fixture由后续打包命令生成到 `artifacts/`，不可携带真实token。
