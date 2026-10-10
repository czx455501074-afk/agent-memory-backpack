import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CoreClient, assertGateResponse, assertPrepareResponse } from './client.js';
import { readClientConfig } from './config.js';
import { identifier, workflowSchema } from './schema.js';
import { pluginVersion } from './doctor.js';

export function createMcp(client: CoreClient) {
  const server = new McpServer({ name: 'agent-memory-backpack', version: '0.1.0-p0.1' });
  const call = async (path: string, args: Record<string, unknown>, validate?: (value: unknown) => Record<string, unknown>) => {
    try {
      const result = await client.post(path, args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(validate ? validate(result) : result) }] };
    } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: (error as Error).message }] }; }
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
    const checks: Array<{ id: string; status: string; detail: string; hint?: string }> = [];
    const pass = (id: string, detail: string) => checks.push({ id, status: 'pass', detail });
    const fail = (id: string, detail: string, hint?: string) => checks.push({ id, status: 'fail', detail, hint });

    pass('project-scope', `凭据绑定项目 ${client.projectId}`);
    pass('credential-shape', `已配置凭据（${client.tokenShape}）`);
    pass('version', `插件 ${pluginVersion()}，Node ${process.versions.node}，平台 ${process.platform}`);

    const started = Date.now();
    try {
      const prepared = assertPrepareResponse(await client.post('/v1/prepare', { adapter: client.adapter }));
      pass('core-reachable', `核心回应正常（${Date.now() - started}ms）`);
      pass('protocol-match', `协议 v${prepared.protocolVersion}，运行状态 ${prepared.mode}`);
      pass('knowledge-state', `知识版本 ${prepared.knowledgeRevision}`);
    } catch (error) {
      fail('core-reachable', `无法从核心取得上下文：${(error as Error).message}`,
        '确认核心仍在运行，且本适配器的 endpoint 指向它');
      checks.push({ id: 'protocol-match', status: 'skip', detail: '核心不可达，无法核对协议' });
    }

    pass('credentials', '凭据仅用于本地核心请求，不写入日志、不作为工具结果返回');
    const ok = !checks.some(check => check.status === 'fail');
    return { content: [{ type: 'text' as const, text: JSON.stringify({
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
  server.registerTool('amb_read_stage', {
    description: 'Read a workflow stage, required prerequisites and exact dependencies. Unavailable dependencies block execution.',
    inputSchema: { workflowId: identifier, stageId: identifier }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, args => call('/v1/expand', args));
  server.registerTool('amb_read_knowledge', {
    description: 'Expand one adopted skill or memory by the id shown in the prepare summary. Set includeLeaves to also read the reference documents a skill carries.',
    inputSchema: { knowledgeId: identifier, includeLeaves: z.boolean().default(false) }, annotations: { readOnlyHint: true, openWorldHint: false },
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
  server.registerTool('amb_submit_experience', {
    description: 'Submit a candidate experience with its parent workflow and observed revision. This never directly changes active knowledge. Reuse idempotencyKey only for an identical retry.',
    inputSchema: { idempotencyKey: identifier, discovery: z.string().min(1).max(12000), workflowId: identifier.optional(), baseRevision: z.number().int().positive().optional(), taskId: identifier.optional() },
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

// The entry is exclusively the stdio server. Importing tests uses createMcp without launching it.
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await createMcp(new CoreClient(readClientConfig())).connect(new StdioServerTransport()); }
  catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}
