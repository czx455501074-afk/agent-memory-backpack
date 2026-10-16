import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CoreClient, assertPrepareResponse } from './client.js';
import { readClientConfig, resolveConfigPath } from './config.js';
import { dirname } from 'node:path';
import { Logger } from './log.js';
import { identifier, workflowSchema } from './schema.js';
import { pluginVersion } from './doctor.js';
/**
 * An id as it appears in injected text: `id`, or `id@revision`.
 * Extends `identifier` to allow an optional `@<digits>` revision suffix
 * while preserving character set restrictions (no slashes, whitespace, or path traversal).
 */
const referenceId = z.string().min(1).max(140).regex(/^[^\s]+(@\d{1,9})?$/);
export function createMcp(client, logger) {
    const server = new McpServer({ name: 'agent-memory-backpack', version: '0.1.0-p0.1' });
    const call = async (path, args, validate) => {
        try {
            const result = await client.post(path, args);
            logger?.info('knowledge.call', { adapter: 'codex', path, projectId: client.projectId,
                ...(path === '/v1/proposals' ? { proposalId: result.id, state: result.state } : {}),
                ...(path === '/v1/knowledge/read' ? { knowledgeId: args.knowledgeId } : {}) });
            return { content: [{ type: 'text', text: JSON.stringify(validate ? validate(result) : result) }] };
        }
        catch (error) {
            logger?.warn('knowledge.failed', { adapter: 'codex', path, projectId: client.projectId });
            return { isError: true, content: [{ type: 'text', text: error.message }] };
        }
    };
    /**
     * Self-check, so the agent can explain a failure instead of guessing.
     *
     * Mirror of the DSH adapter's tool. It never returns the credential: only
     * presence and shape are reported, which keeps the output safe to surface.
     */
    server.registerTool('amb_self_check', {
        description: 'Report whether this knowledge plugin is working: configuration, core reachability, protocol match and version. Use it to explain a failure instead of guessing. Never returns credentials.',
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: false },
    }, async () => {
        const checks = [];
        const pass = (id, detail) => checks.push({ id, status: 'pass', detail });
        const fail = (id, detail, hint) => checks.push({ id, status: 'fail', detail, hint });
        pass('project-scope', `凭据绑定项目 ${client.projectId}`);
        pass('credential-shape', `已配置凭据（${client.tokenShape}）`);
        pass('version', `插件 ${pluginVersion()}，Node ${process.versions.node}，平台 ${process.platform}`);
        const started = Date.now();
        try {
            const prepared = assertPrepareResponse(await client.post('/v1/prepare', { adapter: client.adapter }));
            pass('core-reachable', `核心回应正常（${Date.now() - started}ms）`);
            pass('protocol-match', `协议 v${prepared.protocolVersion}，运行状态 ${prepared.mode}`);
            pass('knowledge-state', `知识版本 ${prepared.knowledgeRevision}`);
        }
        catch (error) {
            fail('core-reachable', `无法从核心取得上下文：${error.message}`, '确认核心仍在运行，且本适配器的 endpoint 指向它');
            checks.push({ id: 'protocol-match', status: 'skip', detail: '核心不可达，无法核对协议' });
        }
        pass('credentials', '凭据仅用于本地核心请求，不写入日志、不作为工具结果返回');
        const ok = !checks.some(check => check.status === 'fail');
        return { content: [{ type: 'text', text: JSON.stringify({
                        ok, checks,
                        versions: { plugin: pluginVersion(), node: process.versions.node, platform: process.platform },
                        note: ok ? '自检未发现阻塞问题。' : '自检发现问题，请按 hint 处理后再继续；不要凭猜测绕过。',
                    }) }] };
    });
    server.registerTool('amb_prepare', {
        description: 'Read current applicable rules and complete workflow entry points before starting or changing a task. Does not grant permission for extra actions.',
        inputSchema: { query: z.string().max(4000).default(''), taskId: identifier.optional() },
        annotations: { readOnlyHint: true, openWorldHint: false },
    }, args => call('/v1/prepare', { ...args, adapter: client.adapter }, assertPrepareResponse));
    server.registerTool('amb_search_workflows', {
        description: 'Search complete workflows across categories; never combine isolated snippets into an unverified procedure.',
        inputSchema: { query: z.string().max(4000) }, annotations: { readOnlyHint: true, openWorldHint: false },
    }, args => call('/v1/search', args));
    server.registerTool('amb_search_universal', {
        description: 'Search across all knowledge entries (skills, norms, workflows, memories, journals) by free-text query with optional kind and limit filters.',
        inputSchema: {
            literal: z.boolean().optional().describe('Use literal full-text search instead of model relevance selection.'),
            query: z.string().max(4000).default(''),
            kind: z.string().max(100).optional(),
            limit: z.number().int().positive().max(200).optional(),
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
    }, args => call('/v1/knowledge/search-universal', args));
    server.registerTool('amb_read_stage', {
        description: 'Read a workflow stage, required prerequisites and exact dependencies. Unavailable dependencies block execution.',
        inputSchema: { workflowId: identifier, stageId: identifier }, annotations: { readOnlyHint: true, openWorldHint: false },
    }, args => call('/v1/expand', args));
    server.registerTool('amb_read_knowledge', {
        description: 'Expand one adopted skill or memory by the id shown in the prepare summary. Set includeLeaves to also read the reference documents a skill carries.',
        inputSchema: { knowledgeId: referenceId, includeLeaves: z.boolean().default(false) }, annotations: { readOnlyHint: true, openWorldHint: false },
    }, args => call('/v1/knowledge/read', args));
    server.registerTool('amb_supersede_experience', {
        description: 'After verifying in practice, replace or supplement an earlier experience. Both action values keep the earlier revision in history; a reason and evidence are required.',
        inputSchema: {
            oldId: identifier, newId: identifier,
            action: z.enum(['supersede', 'supplement']).default('supersede'),
            reason: z.string().min(1).max(500), evidence: z.string().min(1).max(2000),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, args => call('/v1/knowledge/supersede', args));
    server.registerTool('amb_knowledge_history', {
        description: 'Read the revision lineage of one knowledge entry: which versions exist and what replaced or supplemented what.',
        inputSchema: { knowledgeId: identifier }, annotations: { readOnlyHint: true, openWorldHint: false },
    }, args => call('/v1/knowledge/history', args));
    server.registerTool('amb_structure_skill', {
        description: 'Convert an adopted skill into a real workflow. The structure must be authored, not inferred from the Markdown; the raw skill is retired in the same transaction and kept in history.',
        inputSchema: {
            skillId: identifier,
            // Reuse the shared workflow schema so the tool surface cannot drift from
            // what the core actually validates.
            workflow: workflowSchema,
            derivedBy: z.enum(['user', 'agent']).default('agent'),
            evidence: z.string().min(1).max(2000),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, args => call('/v1/knowledge/structure', args));
    server.registerTool('amb_unstructured_skills', {
        description: 'List adopted skills that still hold their original text and have not been structured into a workflow.',
        inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false },
    }, args => call('/v1/knowledge/unstructured', args));
    server.registerTool('amb_checkpoint_task', {
        description: 'Persist task progress and a factual journal. Use paused for an interrupted turn. Completed requires verified text and verifiable evidence. Return the durable journal receipt.',
        inputSchema: { taskId: identifier.optional(), sessionId: z.string().min(1).max(256).optional(),
            title: z.string().min(1).max(2000).optional(), idempotencyKey: identifier.optional(),
            status: z.enum(['in_progress', 'paused', 'completed', 'failed', 'cancelled']).default('paused'),
            summary: z.string().max(2000).optional(), notes: z.string().max(4000).optional(),
            unfinished: z.array(z.string().min(1).max(2000)).max(50).optional(),
            verified: z.string().max(2000).optional(), evidence: z.enum(['verifiable', 'self-reported', 'unverifiable']).optional(),
            files: z.array(z.string().min(1).max(2000)).max(100).optional(),
            relatedExperiences: z.array(identifier).max(100).optional(), relatedProposals: z.array(identifier).max(100).optional(),
        }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }, args => call('/v1/tasks/checkpoint', args));
    server.registerTool('amb_task_activity', {
        description: 'Inspect the task, recorded events, proposal receipts and persisted journal for a task or session.',
        inputSchema: { taskId: identifier.optional(), sessionId: z.string().min(1).max(256).optional() },
        annotations: { readOnlyHint: true, openWorldHint: false },
    }, args => call('/v1/tasks/activity', args));
    server.registerTool('amb_save_material', {
        description: 'Save an external reference as expiring material, with its source URL and optional task. Material never becomes a behavioral rule.',
        inputSchema: { id: identifier, title: z.string().min(1).max(2000), url: z.string().min(1).max(2000),
            summary: z.string().min(1).max(2000), body: z.string().max(60000).optional(), taskId: identifier.optional() },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, args => call('/v1/material/save', args));
    server.registerTool('amb_submit_experience', {
        description: 'Submit a candidate experience with its parent workflow and observed revision. Provide verbatim discovery insight text without conversational framing or platform prefixes to preserve cross-client deduplication. Reuse idempotencyKey only for an identical retry.',
        inputSchema: {
            idempotencyKey: identifier,
            discovery: z.string().trim().min(1).max(12000).describe('Verbatim discovery text without conversational framing or client prefixes'),
            workflowId: identifier.optional(),
            baseRevision: z.number().int().positive().optional(),
            taskId: identifier.optional(),
            evidence: z.string().trim().max(4000).optional().describe('Observed verification evidence such as test pass output, command exit code, or verified facts'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, args => call('/v1/proposals', args));
    /**
     * Migration preview.
     *
     * Read-only, so it is safe to expose to an agent: it answers "what is in this
     * file" without merging anything. The two operations that actually move the
     * library (`/v1/backup/export`, `/v1/backup/import`) are admin-only in the
     * core, because an agent that could call them would either read every entry in
     * one request or write entries straight past the candidate queue. An adapter
     * that tries gets the core's 403 with the guidance to route through a human.
     */
    server.registerTool('amb_inspect_archive', {
        description: 'Read the manifest of a .ambpack migration archive without importing it: counts, export time and file list. Importing and exporting require the admin credential and are done by the human in the desktop console or the CLI.',
        inputSchema: { file: z.string().min(1).max(4096) },
        annotations: { readOnlyHint: true, openWorldHint: false },
    }, args => call('/v1/backup/inspect', args));
    return server;
}
export function assertSupportedNodeVersion() {
    const versionString = process.env.AMB_TEST_NODE_VERSION || process.versions.node;
    const raw = String(versionString ?? '').trim().replace(/^v/, '');
    const match = raw.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match || Number(match[1]) !== 24 || Number(match[2]) < 13) {
        throw new Error(`Agent Memory Backpack 需要 Node 24.x（>=24.13.0 <25），当前运行版本为 v${raw}。请让宿主使用支持的 Node 24 运行时启动。`);
    }
}
// The entry is exclusively the stdio server. Importing tests uses createMcp without launching it.
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    // This entry point serves the Codex adapter, so it reads the Codex credential
    // from the shared data directory by default. An explicit AMB_CONFIG still wins,
    // but only when it names a file that exists — a stale pointer used to disable
    // the plugin silently.
    //
    // There is deliberately no `cwd ⊆ projectRoot` check here. The host launches this
    // server from the plugin directory (`.mcp.json` declares `"cwd": "."`), so such a
    // check refused every legitimate session; and measurement shows the core's own
    // per-request scope enforcement is complete without it. See `CoreClient.post`.
    try {
        assertSupportedNodeVersion();
        const logger = new Logger(dirname(resolveConfigPath('codex').path), { fileName: 'amb-plugin.log.jsonl' });
        await createMcp(new CoreClient(readClientConfig(undefined, 'codex')), logger).connect(new StdioServerTransport());
    }
    catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
