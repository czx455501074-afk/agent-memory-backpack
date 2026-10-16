import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { dirname } from 'node:path';
import { z } from 'zod';
import { Store } from './store.js';
import { contextSchema, gateSchema, proposalSchema, eventSchema, expandSchema, knowledgeSchema, workflowSchema, taskSchema, taskStatus, outboxEntrySchema, DomainError } from './schema.js';
import { coreSchema, type CoreConfig } from './config.js';
import { exportArchive, importArchive, inspectArchive } from './archive.js';
import { capabilityManifest, operatingModeFromDisk } from './capabilities.js';
import { UI_CSS, UI_HTML, UI_JS } from './ui.js';
import { maintenanceStatus, initializeMaintenance } from './maintenance.js';
import { enqueueWorkflowDraft, listWorkflowDrafts, readWorkflowDraft, approveWorkflowDraft, reviseWorkflowDraft } from './workflow-organization.js';
import { createRetrievalService } from './retrieval-service.js';
import { relevantPassages } from './retrieval-excerpt.js';

/**
 * Static responses the core serves for its own management interface.
 *
 * Keyed by exact path so no request can be turned into a file read: there is no
 * filesystem lookup here at all, and a path that is not one of these three falls
 * through to the API routes.
 */
const ASSETS: Record<string, { type: string; body: string }> = {
  '/ui': { type: 'text/html; charset=utf-8', body: UI_HTML },
  '/ui/': { type: 'text/html; charset=utf-8', body: UI_HTML },
  '/ui/app.js': { type: 'text/javascript; charset=utf-8', body: UI_JS },
  '/ui/app.css': { type: 'text/css; charset=utf-8', body: UI_CSS },
};

const MAX_BODY = 65536;
function matches(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function reply(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
async function readBody(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new DomainError('content_type', 'JSON required', 415);
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > MAX_BODY) throw new DomainError('too_large', 'Request too large', 413);
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new DomainError('invalid_json', 'Invalid JSON'); }
}
/**
 * Endpoints that change the effective library, or that review changes to it.
 *
 * The plan requires that an agent may propose but must not gain normative
 * management power, and acceptance case 18 tests exactly that. Blocking only the
 * approval URL would have been a partial fix: `supersede` and `structure` write a
 * new effective revision directly, so an adapter that could call them could still
 * change what every other session reads, without any review. They are therefore
 * admin-only alongside the review endpoints.
 */
const ADMIN_ONLY = new Set([
  '/v1/proposals/list', '/v1/proposals/get', '/v1/proposals/approve', '/v1/proposals/reject',
  // The rest of the review lifecycle is the human's for the same reason approval is:
  // holding a candidate for evidence, archiving it, or acting on many at once are all
  // review decisions, and an agent that could call them could clear its own queue.
  '/v1/proposals/request-evidence', '/v1/proposals/archive', '/v1/proposals/reopen', '/v1/proposals/batch',
  '/v1/rescan/interval', '/v1/rescan/mark',
  '/v1/knowledge/supersede', '/v1/knowledge/structure',
  // Migration moves the whole library, so it belongs to the human. An agent that
  // could export would be able to read every entry in one call regardless of
  // project scope, and an agent that could import would be able to write entries
  // straight into the effective library, bypassing both the candidate queue and
  // the project scope check that `prepare` applies.
  //
  // `/v1/backup/inspect` is deliberately NOT here: it reports only counts, file
  // names and a timestamp, which `/v1/stats` already exposes, so it grants an
  // agent nothing new while letting it answer "what is in this file?".
  '/v1/backup/export', '/v1/backup/import',
  // Renewal and purge both change how long material is kept, which the design
  // reserves for the user: a renewal has to state a reason, and a purge destroys
  // content. Saving stays open — an agent recording what it read is one of the
  // three collection entry points the design names.
  '/v1/material/renew', '/v1/material/purge',
  '/v1/knowledge/write', '/v1/knowledge/delete',
  // The offline queue's own management surface. Inspecting it exposes every
  // undelivered candidate's text and every queued event's summary, and purging it
  // destroys that text, so both belong to the human. *Enqueueing* and replaying do
  // not: an adapter holds the item that failed, so recording it is not a
  // management decision, and the replay only re-sends what the adapter already
  // tried to send.
  '/v1/outbox/list', '/v1/outbox/purge',
  '/v1/maintenance/status',
  '/v1/maintenance/retry',
  '/v1/workflow-drafts/list', '/v1/workflow-drafts/get', '/v1/workflow-drafts/generate', '/v1/workflow-drafts/approve',
  '/v1/workflow-drafts/revise',
]);

/**
 * Guidance returned when an adapter tries an admin-only operation.
 *
 * A bare 403 tells an agent nothing about what to do instead. This names the
 * alternative the plan actually intends: submit a candidate and let a human
 * decide.
 */
const ADMIN_ONLY_HINT = 'This operation changes the effective knowledge base and requires the admin credential. '
  + 'Submit a candidate instead (amb_submit_experience) and let a human review it.';

export function createCoreServer(store: Store, config: CoreConfig) {
  initializeMaintenance(store);
  const selectKnowledge=createRetrievalService(store,dirname(store.path));
  const validated = coreSchema.parse(config);
  if (new Set(validated.clients.map(c => c.token)).size !== validated.clients.length)
    throw new Error('Adapter credentials must be distinct');
  const server = createServer(async (req, res) => {
    try {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : validated.port;
      const selfOrigin = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
      /**
       * Browser-origin requests stay refused except from the page this core serves.
       *
       * The rule exists because the core is an app's backend, not a website: a page
       * from anywhere else must not be able to drive it. Serving the management
       * interface from here makes one origin legitimate — the page itself — and a
       * browser sends `Origin` on its own POSTs even same-origin, so refusing all
       * of them would refuse the interface too.
       *
       * Only that exact origin is admitted. A page on another site still fails, and
       * the Host check below still refuses a non-loopback host, so a name that
       * resolves to 127.0.0.1 is turned away for two independent reasons.
       */
      const origin = req.headers.origin;
      // The management page is also embedded in the DSH desktop, whose page lives
      // on a different loopback port. A browser then sends that port as Origin on
      // every POST, and refusing it blanks every tab. Only a loopback origin is
      // added to the page's own origin; any other site is still refused, and the
      // Host check below still rejects a non-loopback host.
      const loopbackOrigin = origin !== undefined && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin);
      if (origin && !selfOrigin.includes(origin) && !loopbackOrigin)
        throw new DomainError('origin_denied', 'Browser requests from another origin are refused', 403);
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host ?? ''))
        throw new DomainError('host_denied', 'Invalid host', 403);
      if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { protocolVersion: 1, status: 'ok', phase: 'P0' });
      // The interface itself. Static assets carry no data, so they need no
      // credential; every call that returns knowledge or changes it is a POST and
      // still authenticated below. The page keeps the credential in memory only.
      if (req.method === 'GET' && ASSETS[req.url ?? '']) {
        const asset = ASSETS[req.url ?? '']!;
        return void res.writeHead(200, {
          'Content-Type': asset.type,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          // No inline script or style, and allow embedding from local loopback origins.
          'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self' http://127.0.0.1:* http://localhost:*",
        }).end(asset.body);
      }
      if (req.method !== 'POST') throw new DomainError('method', 'POST required', 405);
      const header = req.headers.authorization ?? '';
      const principal = validated.clients.find(c => matches(header, `Bearer ${c.token}`));
      if (!principal) throw new DomainError('unauthorized', 'Adapter authentication required', 401);
      if (req.headers['x-amb-protocol'] !== '1') throw new DomainError('protocol_mismatch', 'Unsupported or missing protocol version', 426);
      const role = principal.role;
      const body = await readBody(req);
      /**
       * The management page's identity bootstrap.
       *
       * The page holds a credential but does not know which project that
       * credential belongs to, and it must not be told by the URL or ask the user:
       * either would let a caller name a project it has no credential for. Asking
       * the core is the only sound way, so `/v1/stats` answers for the credential's
       * own project when the envelope omits `projectId`.
       *
       * This is not a relaxation of the scope rule below. A request that *does*
       * name a project is still checked against the credential exactly as before —
       * naming someone else's project is still a 403. Only this one read-only
       * endpoint may omit the envelope, and its answer is derived from the
       * credential rather than from anything the caller supplied.
       */
      const bootstrapIdentity = req.url === '/v1/stats'
        && (body === null || typeof body !== 'object' || !('projectId' in (body as Record<string, unknown>)));
      const envelope = z.object({
        projectId: bootstrapIdentity ? z.string().default(principal.projectId) : z.string(),
        adapter: z.string().optional(),
      }).passthrough().parse(body);
      if (envelope.projectId !== principal.projectId || (envelope.adapter && envelope.adapter !== principal.id))
        throw new DomainError('scope_denied', 'Credential cannot access that project or adapter identity', 403);
      // Role check before the handler runs, so a management endpoint cannot be
      // reached by an adapter at all rather than being guarded case by case.
      if (ADMIN_ONLY.has(req.url ?? '') && role !== 'admin')
        throw new DomainError('forbidden', ADMIN_ONLY_HINT, 403);
      store.cleanup();
      switch (req.url) {
        case '/v1/workflow-drafts/list': return reply(res,200,{drafts:listWorkflowDrafts(store,envelope.projectId),
          skills:store.scopedEntries(envelope.projectId).filter(e=>e.content.kind==='skill').map(e=>({id:e.id,title:e.content.title,revision:e.revision}))});
        case '/v1/workflow-drafts/get': {
          const p=z.object({id:z.string().min(1)}).parse(body); return reply(res,200,readWorkflowDraft(store,envelope.projectId,p.id));
        }
        case '/v1/workflow-drafts/generate': {
          const p=z.object({skillId:z.string().min(1)}).parse(body); return reply(res,200,enqueueWorkflowDraft(store,envelope.projectId,p.skillId,true));
        }
        case '/v1/workflow-drafts/approve': {
          const p=z.object({id:z.string().min(1)}).parse(body); return reply(res,200,approveWorkflowDraft(store,envelope.projectId,p.id));
        }
        case '/v1/workflow-drafts/revise': {
          const p=z.object({id:z.string().min(1),draft:z.unknown()}).parse(body);
          return reply(res,200,reviseWorkflowDraft(store,envelope.projectId,p.id,p.draft));
        }
        case '/v1/maintenance/status': {
          return reply(res, 200, maintenanceStatus(store, envelope.projectId));
        }
        case '/v1/maintenance/retry': {
          const p = z.object({ id: z.string().min(1), projectId: z.string() }).parse(body);
          const jobs = initializeMaintenance(store);
          const job = jobs.list(200).find(item => item.id === p.id);
          if (!job || (job.payload.projectId && job.payload.projectId !== p.projectId)) throw new DomainError('not_found', 'Job unavailable', 404);
          return reply(res, 200, { requeued: jobs.requeue(p.id) });
        }
        case '/v1/prepare': {
          const p = contextSchema.parse(body);
          const selection=await selectKnowledge(p.projectId,p.query);
          const prepared = store.prepare(p.projectId, p.query, {
            sessionId: p.sessionId, taskId: p.taskId, platform: p.adapter,
            ...(selection.mode==='model'||selection.mode==='index'||selection.reason!=='not_configured'?{selectedIds:selection.selectedIds}:{}),
          });
          // Organize the skill currently being used, asynchronously and once per source version.
          const selected=prepared.knowledge.find(item=>item.kind==='skill');
          if(selected) enqueueWorkflowDraft(store,p.projectId,selected.id);
          return reply(res,200,{...prepared,retrieval:{...prepared.retrieval,selection}});
        }
        // Workflow search, not knowledge search - the response carries `workflows`, and
        // this only looks up workflow stages. Knowledge retrieval lives at
        // `/v1/knowledge/search-universal`, which is almost always the endpoint a caller
        // wants. The name here reads like general search and has been mistaken for it in
        // practice (including by whoever wrote this comment: querying it for knowledge
        // returned nothing eight times in a row before the distinction was noticed).
        // Kept as-is rather than renamed, because callers already depend on the path.
        case '/v1/search': { const p = contextSchema.parse(body); return reply(res, 200, { workflows: store.search(p.projectId, p.query), knowledgeRevision: store.revision }); }
        case '/v1/expand': { const p = expandSchema.parse(body); return reply(res, 200, store.expand(p.projectId, p.workflowId, p.stageId)); }
        case '/v1/gate': {
          const p = gateSchema.parse(body);
          // The task id and the host identity travel with the check: "这一次用 Banana"
          // is a rule for one task, and a host-specific rule must not reach the other
          // host's session. Passing only the tool name made both dimensions inert.
          return reply(res, 200, store.gate(p.projectId, p.toolName, {
            taskId: p.taskId, platform: p.adapter, knownRevision: p.knowledgeRevision,
          }));
        }
        case '/v1/proposals': { const p = proposalSchema.parse(body); return reply(res, 200, store.submit(principal.id, p)); }
        case '/v1/events': { const p = eventSchema.parse(body); return reply(res, 200, store.event(principal.id, p)); }
        /**
         * The offline queue.
         *
         * A candidate or event that fails on the way to the core is recorded here
         * by the adapter that produced it, and the same table lets the adapter try
         * again later. The replay goes back through the ordinary submission path,
         * so an item that actually arrived before the transport error is recognised
         * by its idempotency key as a duplicate rather than stored twice.
         *
         * Replay is open to adapters because it can only deliver work the adapter
         * itself already attempted; listing and purging are admin-only because they
         * expose or destroy text that has not been delivered.
         */
        case '/v1/outbox/enqueue': {
          // The body's own projectId is already part of the entry schema, and the
          // envelope check above has confirmed it is the credential's project.
          const p = outboxEntrySchema.parse(body);
          const result = store.enqueue(principal.id, p);
          return reply(res, 200, {
            ...result,
            note: result.duplicate
              ? '该幂等键已在队列中，未重复入队。'
              : '已写入持久队列；核心可达时可重放，重放走原幂等键，不会重复写入。',
          });
        }
        case '/v1/outbox/replay': {
          const p = z.object({
            projectId: z.string(), limit: z.number().int().positive().max(200).optional(),
            force: z.boolean().default(false),
          }).parse(body);
          const result = store.replayOutbox({ projectId: p.projectId, limit: p.limit, force: p.force });
          return reply(res, 200, {
            ...result,
            note: '重放走原有幂等路径：已送达的条目会被识别为 duplicate，不产生第二条。',
          });
        }
        case '/v1/outbox/list': {
          const p = z.object({ projectId: z.string(), limit: z.number().int().positive().max(500).optional() }).parse(body);
          return reply(res, 200, store.outboxStatus(p.projectId, p.limit));
        }
        case '/v1/outbox/purge': {
          const p = z.object({ projectId: z.string(), includePending: z.boolean().default(false) }).parse(body);
          const result = store.purgeOutbox({ projectId: p.projectId, includePending: p.includePending });
          return reply(res, 200, {
            ...result,
            note: p.includePending
              ? '已连同未送达条目一并清除；discarded 列出被丢弃的内容，这是明确决定而非静默删除。'
              : '只清除了已送达或已放弃的条目；未送达条目仍在队列中。',
          });
        }
        case '/v1/proposals/list': { const p = z.object({ projectId: z.string(), state: z.string().optional() }).parse(body); return reply(res, 200, { proposals: store.listProposals(p.projectId, p.state) }); }
        /**
         * One candidate, for the review page's approval form.
         *
         * The page needs the resolved target — workflow id, the revision the
         * candidate was based on, and the current entry — because the core refuses
         * to approve a workflow-bearing candidate as anything other than that
         * workflow. Without this the page could only offer the candidate's UUID
         * and every approval of a workflow candidate came back `target_mismatch`.
         */
        case '/v1/proposals/get': {
          const p = z.object({ projectId: z.string(), id: z.string().min(1) }).parse(body);
          const proposal = store.getProposal(p.id, p.projectId);
          const review = store.db.prepare('SELECT result FROM model_reviews WHERE proposal_id=? AND project_id=?').get(p.id, p.projectId);
          return reply(res, 200, { ...proposal, modelReview: review ? JSON.parse(String(review.result)) : { status: 'awaiting_model', authority: 'advisory' } });
        }
        /**
         * Reopen an archived, rejected or expired candidate.
         *
         * F09: the queue kept these rows readable but offered no way back, so a
         * candidate set aside by mistake could only be recovered by hand. An
         * approved proposal is deliberately not reopenable — its decision already
         * changed the library, and the history of that decision must stay single.
         */
        case '/v1/proposals/reopen': {
          const p = z.object({ projectId: z.string(), id: z.string().min(1) }).parse(body);
          const result = store.reopenProposal(p.id, { actor: principal.id, projectId: p.projectId });
          return reply(res, 200, { ...result, note: '已回到待审队列，重新开启 30 天审阅期；原记录与历史保留。' });
        }
        // Approval carries the reviewer-supplied structured entry; the discovery text is never promoted as-is.
        // `allowGlobalScope` must be stated explicitly, because promoting a
        // project-scoped proposal to a global entry applies it everywhere.
        case '/v1/proposals/approve': {
          const p = z.object({
            projectId: z.string(), id: z.string(), entry: knowledgeSchema,
            allowGlobalScope: z.boolean().default(false),
          }).parse(body);
          return reply(res, 200, { knowledgeRevision: store.approveProposal(p.id, p.entry, { allowGlobalScope: p.allowGlobalScope, actor: principal.id, projectId: p.projectId }) });
        }
        case '/v1/proposals/reject': { const p = z.object({ projectId: z.string(), id: z.string(), reason: z.string().max(500).optional() }).parse(body); store.rejectProposal(p.id, { reason: p.reason, actor: principal.id, projectId: p.projectId }); return reply(res, 200, { state: 'rejected' }); }
        /**
         * The rest of the review lifecycle, admin-only like the endpoints above.
         *
         * Batch review exists so a user is not interrupted per candidate, and the
         * outcome is reported per id rather than as one count: a batch that says
         * "5 approved" while two were refused for a stale base revision tells the
         * user nothing about which two.
         */
        case '/v1/proposals/request-evidence': {
          const p = z.object({ projectId: z.string(), id: z.string(), reason: z.string().min(1).max(500) }).parse(body);
          const result = store.requestEvidence(p.id, p.reason, { actor: principal.id, projectId: p.projectId });
          return reply(res, 200, {
            ...result,
            note: '该候选未判定真假：缺证据既不该批准，也不该当成假的丢掉。到期未补证会自动归档。',
          });
        }
        case '/v1/proposals/archive': {
          const p = z.object({ projectId: z.string(), id: z.string() }).parse(body);
          store.archiveProposal(p.id, { projectId: p.projectId });
          return reply(res, 200, { state: 'archived', note: '已移出待办队列，记录仍可查阅。' });
        }
        case '/v1/proposals/batch': {
          const p = z.object({
            projectId: z.string(),
            action: z.enum(['approve', 'reject', 'archive', 'request-evidence']),
            ids: z.array(z.string().min(1)).min(1).max(200),
            entries: z.record(z.string(), knowledgeSchema).optional(),
            reason: z.string().min(1).max(500).optional(),
            allowGlobalScope: z.boolean().default(false),
          }).parse(body);
          const result = store.reviewBatch(p.projectId, p);
          return reply(res, 200, {
            ...result,
            note: result.failed.length
              ? '部分条目未处理，逐条原因见 failed；其余已按动作执行。'
              : '全部按要求处理。',
          });
        }
        // Filtered by project: an earlier version returned every norm in the
        // database, so one project's credential could read another project's
        // normative text. `scopedEntries()` applies the same scope rule as
        // prepare, gate and search while keeping the Entry shape callers expect.
        case '/v1/norms': { const p = z.object({ projectId: z.string() }).parse(body); return reply(res, 200, { norms: store.scopedEntries(p.projectId).filter(e => e.content.kind === 'norm'), knowledgeRevision: store.revision }); }
        case '/v1/preferences': { const p = z.object({ projectId: z.string() }).parse(body); return reply(res, 200, { preferences: store.scopedEntries(p.projectId).filter(e => e.content.kind === 'preference'), knowledgeRevision: store.revision }); }
        case '/v1/capabilities': {
          const p = z.object({ projectId: z.string() }).parse(body);
          const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
          const dataDir = dirname(store.path);
          return reply(res, 200, {
            adapters: capabilityManifest(home),
            ...operatingModeFromDisk(dataDir, true),
          });
        }
        case '/v1/history/recent': {
          const p = z.object({ projectId: z.string(), limit: z.number().int().positive().max(200).optional() }).parse(body);
          // Scoped to the caller's project: an unscoped ledger handed one project
          // another project's entry titles plus the reason and evidence text of its
          // replacements — precisely the material scope exists to protect.
          return reply(res, 200, { history: store.supersessions(undefined, p.projectId).slice(0, p.limit ?? 50) });
        }
        case '/v1/knowledge/read': {
          const p = z.object({ projectId: z.string(), knowledgeId: z.string(), includeLeaves: z.boolean().optional(), query:z.string().max(4000).optional() }).parse(body);
          const knowledge=store.readKnowledge(p.projectId,p.knowledgeId,p.includeLeaves??false);
          return reply(res,200,{...knowledge,...(p.query?{passages:relevantPassages(knowledge.body,p.query)}:{})});
        }
        // The caller's own projectId is echoed back so a UI can label what it is
        // showing. It is not a disclosure: the request already had to name it, and
        // it is the credential's own project rather than anyone else's. `role` is
        // included for the same reason — the page must know whether this credential
        // may review, and reading it from the credential is better than the page
        // guessing and offering buttons that will be refused.
        //
        // The already-validated envelope is the source, not a re-parse of the raw
        // body: on the bootstrap path the body carries no `projectId` at all, and
        // parsing it again demanded the very field that was deliberately optional.
        case '/v1/stats': { const p = z.object({ projectId: z.string().default(envelope.projectId) }).parse(body); return reply(res, 200, { projectId: p.projectId, role: principal.role, ...store.stats() }); }
        // Rescan cadence: an adapter asks whether a scan is due instead of
        // rescanning on every session start.
        case '/v1/rescan/state': { const p = z.object({ projectId: z.string(), at: z.number().int().optional() }).parse(body); const state = store.rescanState(); return reply(res, 200, { ...state, due: store.rescanDue(p.at) }); }
        case '/v1/rescan/interval': { const p = z.object({ projectId: z.string(), intervalMs: z.number().int() }).parse(body); return reply(res, 200, store.setRescanInterval(p.intervalMs)); }
        case '/v1/rescan/mark': { const p = z.object({ projectId: z.string(), at: z.number().int().optional() }).parse(body); return reply(res, 200, store.markRescanned(p.at)); }
        // Working-time correction: replace or complement an earlier experience
        // after verifying it in practice. History is always retained.
        case '/v1/knowledge/supersede': {
          const p = z.object({
            projectId: z.string(), oldId: z.string(), newId: z.string(),
            action: z.enum(['supersede', 'supplement']).default('supersede'),
            reason: z.string().min(1).max(500), evidence: z.string().min(1).max(2000),
          }).parse(body);
          return reply(res, 200, store.supersede({ ...p, origin: 'agent', projectId: p.projectId }));
        }
        case '/v1/knowledge/history': { const p = z.object({ projectId: z.string(), knowledgeId: z.string() }).parse(body); return reply(res, 200, store.history(p.knowledgeId, p.projectId)); }
        /**
         * Read one historical revision, read-only.
         *
         * The retrieval path deliberately refuses a stale `@revision` so a caller
         * cannot act on an old version; that guard must not make the history page
         * blind. This returns the past revision's prose as a read-only view and
         * never as a usable handle (F09).
         */
        case '/v1/knowledge/history/read': {
          const p = z.object({ projectId: z.string(), id: z.string().min(1), revision: z.number().int().positive() }).parse(body);
          return reply(res, 200, store.readRevision(p.id, p.revision, p.projectId));
        }
        // Structuring: the caller supplies the authored workflow; nothing is
        // inferred from the adopted Markdown.
        case '/v1/knowledge/structure': {
          const p = z.object({
            projectId: z.string(), skillId: z.string(), workflow: workflowSchema,
            derivedBy: z.enum(['user', 'agent']).default('agent'),
            evidence: z.string().min(1).max(2000),
          }).parse(body);
          return reply(res, 200, store.structureSkill({ skillId: p.skillId, workflow: p.workflow, derivedBy: p.derivedBy, evidence: p.evidence, projectId: p.projectId }));
        }
        case '/v1/knowledge/unstructured': { const p = z.object({ projectId: z.string(), limit: z.number().int().positive().max(200).optional() }).parse(body); return reply(res, 200, { skills: store.unstructuredSkills(p.projectId, p.limit) }); }
        case '/v1/knowledge/search-universal': {
          const p = z.object({ projectId: z.string(), query: z.string().optional().default(''), kind: z.string().optional(), limit: z.number().int().positive().max(200).optional(), autoRecall: z.boolean().optional(),literal:z.boolean().optional() }).parse(body);
          const selection=p.kind!=='norm'&&!p.literal&&p.query.trim()?await selectKnowledge(p.projectId,p.query):{mode:'lexical_fallback' as const,selectedIds:[],reason:'explicit_full_text'};
          const catalog=store.searchUniversal(p.projectId,'',p.kind,Number.MAX_SAFE_INTEGER);
          const results=p.kind==='norm'?store.searchUniversal(p.projectId,p.query,p.kind,p.limit):selection.mode==='model'||selection.mode==='index'||(p.autoRecall&&selection.reason!=='not_configured')?selection.selectedIds.flatMap(id=>catalog.filter(e=>e.id===id)).slice(0,p.limit??(p.autoRecall?3:100))
            :p.autoRecall?store.autoRecall(p.projectId,p.query,p.kind,p.limit):store.searchUniversal(p.projectId,p.query,p.kind,p.limit);
          return reply(res,200,{results,selection,knowledgeRevision:store.revision});
        }
        case '/v1/knowledge/get': {
          const p = z.object({ projectId: z.string(), id: z.string().min(1) }).parse(body);
          return reply(res, 200, store.getKnowledge(p.projectId, p.id));
        }
        case '/v1/knowledge/write': {
          const p = z.object({ projectId: z.string(), entry: knowledgeSchema }).parse(body);
          // The envelope's projectId is checked against the credential above, but
          // nothing inspected the *entry* being written. A credential for one
          // project could therefore write an entry scoped to another, or widen one
          // to global, which applies it everywhere — the escalation the plan
          // reserves for an explicit user decision.
          const scope = p.entry.scope;
          if (scope.kind === 'global' && principal.role !== 'admin')
            throw new DomainError('scope_denied', 'Only an explicit admin decision may write a global entry', 403);
          if (scope.kind !== 'global' && scope.projectId !== p.projectId)
            throw new DomainError('scope_denied', 'The entry is scoped to a different project', 403);
          const rev = store.import([p.entry]);
          return reply(res, 200, { success: true, id: p.entry.id, knowledgeRevision: rev, note: '条目已保存并生效。' });
        }
        case '/v1/knowledge/delete': {
          const p = z.object({ projectId: z.string(), id: z.string().min(1), baseRevision: z.number().int().nonnegative().optional() }).parse(body);
          const entry = store.getKnowledge(p.projectId, p.id);
          const baseRev = p.baseRevision ?? entry.revision;
          store.retire(p.id, baseRev);
          return reply(res, 200, { success: true, id: p.id, knowledgeRevision: store.revision, note: '条目已退役删除，历史版本完整保留可追溯。' });
        }
        /**
         * Temporary material.
         *
         * Saving is open to adapters: an agent that read a page should be able to
         * record it, and that is one of the three collection entry points the
         * design names. Renewal and purge require the admin credential, because
         * both change how long something is kept — a decision the design reserves
         * for the user, and one that must carry a stated reason.
         */
        case '/v1/material/save': {
          const p = z.object({
            projectId: z.string(), id: z.string().min(1).max(120),
            title: z.string().min(1).max(2000), url: z.string().min(1).max(2000),
            summary: z.string().min(1).max(2000), body: z.string().max(60000).optional(),
            taskId: z.string().min(1).max(120).optional(),
            provenance: z.enum(['user', 'external', 'agent']).optional(),
            capturedAt: z.number().int().nonnegative().optional(),
          }).parse(body);
          const captureNow = Date.now();
          if (p.capturedAt !== undefined && (p.capturedAt > captureNow || p.capturedAt + 90 * 86_400_000 <= captureNow))
            throw new DomainError('invalid_capture_time', 'Material capture time is future or expired', 400);
          const isAdmin = principal.role === 'admin';
          /**
           * The linked task must belong to the recording project.
           *
           * The design (§8) lists 关联任务 as one of the fields a piece of material
           * records, and attribution is exactly what F04 established for events:
           * accepting another project's task id lets one project's credential point
           * its data at a task it has no claim to, and that task's diary and export
           * are the records which then go wrong.
           *
           * The lookup is scoped to the caller's own project, so a foreign or
           * unknown id is refused with the same 404 — deliberately not
           * distinguished. Answering "that id exists, but not for you" would let a
           * credential probe another project's task ids, which is the disclosure
           * the scope rule exists to prevent and the same reason `getKnowledge`
           * answers 404 across projects.
           */
          if (p.taskId !== undefined && !store.getTask(p.taskId, p.projectId))
            throw new DomainError('not_found', `Task ${p.taskId} is unavailable`, 404);
          const result = store.saveMaterial({
            ...p,
            ...(p.capturedAt !== undefined ? { savedAt: p.capturedAt, expiresAt: p.capturedAt + 90 * 86_400_000 } : {}),
            // Scope and provenance are decided by the caller's *identity*, never by
            // the request body. An adapter records material for its own project —
            // a project's short-lived reference must not become readable by every
            // other project — and a page it fetched is external prose by definition,
            // so it can never claim the user's authority. Only the human's admin
            // credential may record a global item or label it `user`.
            scope: isAdmin ? { kind: 'global' } : { kind: 'project', projectId: p.projectId },
            taskId: p.taskId,
            provenance: isAdmin ? (p.provenance ?? 'user') : 'external',
            body: p.body ?? '',
          });
          return reply(res, 200, {
            ...result,
            note: result.duplicate
              ? '同样的页面已在库中，未重复保存，也未延长其到期时间。'
              : '已作为临时资料保存，到期后自动退出检索并清理。普通读取不会延长它的期限。',
          });
        }
        case '/v1/material/list': {
          const p = z.object({ projectId: z.string(), limit: z.number().int().positive().max(200).optional() }).parse(body);
          // Only the caller's own project's material is listed: a project's
          // temporary references are not another project's business.
          return reply(res, 200, { material: store.liveMaterial(p.projectId, p.limit), stats: store.materialStats() });
        }
        case '/v1/material/renew': {
          const p = z.object({ projectId: z.string(), id: z.string().min(1).max(120), reason: z.string().min(1).max(500) }).parse(body);
          const result = store.renewMaterial(p.id, p.reason, p.projectId);
          return reply(res, 200, { ...result, note: '已按明确理由续期；普通读取不会延长资料期限。' });
        }
        case '/v1/material/purge': {
          const p = z.object({ projectId: z.string() }).parse(body);
          const result = store.purgeExpiredMaterial();
          return reply(res, 200, {
            ...result,
            note: '已到期资料的正文与索引已删除；失败项可重试。'
              + (result.failed.length ? ` ${result.failed.length} 条未成功，需重试。` : ''),
          });
        }
        // The task is derived from the session, so "one task across sessions" holds
        // without the adapter inventing an id. A task-scoped entry also becomes
        // applicable once this is known, which is what keeps "this time only" from
        // leaking into every later task.
        case '/v1/sessions/reflect': {
          const p = z.object({ projectId: z.string(), adapter: z.enum(['codex', 'dsh']),
            sessionId: z.string().min(1).max(256), eventId: z.string().min(1).max(120).optional(),
            taskId: z.string().min(1).max(120).optional(), reason: z.enum(['turn-ended', 'stopped']),
            summary: z.string().max(2000).optional() }).parse(body);
          return reply(res, 200, store.event(principal.id, {
            projectId: p.projectId, adapter: p.adapter, sessionId: p.sessionId,
            ...(p.taskId ? { taskId: p.taskId } : {}),
            eventId: p.eventId ?? `reflect-${crypto.randomUUID()}`,
            kind: p.reason === 'stopped' ? 'turn_stopped' : 'turn_ended', summary: p.summary ?? '',
          }));
        }
        case '/v1/tasks/checkpoint': {
          const p = z.object({ projectId: z.string(), sessionId: z.string().min(1).max(256).optional(),
            taskId: z.string().min(1).max(120).optional(), title: z.string().min(1).max(2000).optional(),
            idempotencyKey: z.string().min(1).max(120).optional(), status: taskStatus.optional(),
            summary: z.string().max(2000).optional(), notes: z.string().max(4000).optional(),
            unfinished: z.array(z.string().min(1).max(2000)).max(50).optional(),
            verified: z.string().max(2000).optional(),
            evidence: z.enum(['observed', 'verifiable', 'self-reported', 'unverifiable']).optional(),
            files: z.array(z.string().min(1).max(2000)).max(100).optional(),
            relatedExperiences: z.array(z.string().min(1).max(120)).max(100).optional(),
            relatedProposals: z.array(z.string().min(1).max(120)).max(100).optional(),
          }).parse(body);
          if (principal.role !== 'admin' && p.evidence === 'observed')
            throw new DomainError('invalid_evidence', 'Adapters may record verifiable evidence, not claim plugin observations');
          return reply(res, 200, store.checkpointTask(principal.id, p));
        }
        case '/v1/tasks/activity': {
          const p = z.object({ projectId: z.string(), taskId: z.string().min(1).max(120).optional(),
            sessionId: z.string().min(1).max(256).optional() }).parse(body);
          return reply(res, 200, store.taskActivity(p.projectId, p));
        }
        case '/v1/tasks/start': {
          const p = z.object({ projectId: z.string(), sessionId: z.string().min(1).max(256), title: z.string().min(1).max(2000) }).parse(body);
          const result = store.startTaskForSession(p.projectId, p.sessionId, p.title);
          return reply(res, 200, { ...result, note: '会话已关联到任务；同一任务可跨多个会话。' });
        }
        case '/v1/tasks/journal': {
          if (principal.role !== 'admin') throw new DomainError('forbidden', ADMIN_ONLY_HINT, 403);
          const p = z.object({ projectId: z.string(), taskId: z.string().min(1).max(120) }).parse(body);
          return reply(res, 200, {
            ...store.writeJournal(p.taskId, p.projectId),
            note: '日记由任务事实生成，不作为行为指令；成功、失败与未验证分开记录。',
          });
        }
        case '/v1/tasks/export': {
          const p = z.object({ projectId: z.string(), taskId: z.string().min(1).max(120), format: z.enum(['markdown', 'json']).default('markdown') }).parse(body);
          const result = store.exportTask(p.taskId, p.projectId);
          return reply(res, 200, p.format === 'json'
            ? { format: 'json', task: result.json }
            : { format: 'markdown', markdown: result.markdown });
        }
        case '/v1/tasks/record': { const p = z.object({ projectId: z.string(), task: taskSchema }).parse(body); return reply(res, 200, store.recordTask(p.projectId, p.task)); }
        case '/v1/tasks/list': { const p = z.object({ projectId: z.string(), status: taskStatus.optional() }).parse(body); return reply(res, 200, { tasks: store.tasks(p.projectId, p.status) }); }
        case '/v1/tasks/handoff': { const p = z.object({ projectId: z.string(), taskId: z.string() }).parse(body); return reply(res, 200, store.handoff(p.taskId, p.projectId)); }
        /**
         * Compare a checkout's file states against what a task recorded.
         *
         * Acceptance 16: continuing in a *different* checkout must show how the files
         * differ rather than assume the other end's edits are present. The receiving
         * end supplies what it observes; the core answers `same` / `different` /
         * `unknown` per path and never infers "unchanged" from a matching name.
         */
        case '/v1/tasks/compare': {
          const p = z.object({
            projectId: z.string(), taskId: z.string().min(1).max(120),
            observed: z.array(z.object({
              path: z.string().min(1).max(1000),
              digest: z.string().trim().min(1).max(128).optional(),
              size: z.number().int().nonnegative().optional(),
            }).strict()).max(200),
          }).parse(body);
          return reply(res, 200, {
            ...store.compareFileStates(p.taskId, p.projectId, p.observed),
            note: 'unknown 表示该文件在发送端或接收端缺状态记录，不能视为未变化；different 表示本地可能落后或已被改动。',
          });
        }
        /**
         * Migration: write every authority row into one portable file, read one
         * back, or merge one in.
         *
         * The path is supplied by the caller because the core cannot ask a
         * desktop user where to put a file; the Electron console opens a native
         * save dialog in its main process and passes the chosen path here. Only
         * the path travels, never the file contents, so the 64 KB request limit
         * does not apply and the archive is built from the database instead of
         * being uploaded over HTTP.
         */
        case '/v1/backup/export': {
          // `overwrite` is the caller asserting that a human already answered the
          // replace question. The console opens a native save dialog with
          // `showOverwriteConfirmation`, so the user has confirmed; without this
          // flag the core could only see "the file exists" and refuse, making the
          // dialog's confirmation meaningless and a second export impossible.
          // It defaults to false because a caller that skipped the dialog must
          // not be able to silently destroy an existing archive.
          const p = z.object({
            projectId: z.string(), file: z.string().min(1).max(4096),
            dryRun: z.boolean().default(false), overwrite: z.boolean().default(false),
          }).parse(body);
          const result = exportArchive(store, { file: p.file, dryRun: p.dryRun, overwrite: p.overwrite });
          return reply(res, 200, {
            ...result,
            note: '归档包含全部知识、历史版本、任务与候选队列，但不含任何凭据。把它复制到另一台设备，装上插件后在「数据迁移」里导入即可。',
          });
        }
        case '/v1/backup/inspect': {
          const p = z.object({ projectId: z.string(), file: z.string().min(1).max(4096) }).parse(body);
          return reply(res, 200, inspectArchive(p.file));
        }
        case '/v1/backup/import': {
          const p = z.object({
            projectId: z.string(), file: z.string().min(1).max(4096),
            dryRun: z.boolean().default(false), onConflict: z.enum(['skip', 'fail']).default('skip'),
          }).parse(body);
          const result = importArchive(store, { file: p.file, dryRun: p.dryRun, onConflict: p.onConflict });
          return reply(res, 200, { ...result, note: '合并式导入：只新增，不删除。本机更新或分叉的条目会保留并计入 conflicts。' });
        }
        default: throw new DomainError('not_found', 'Unknown endpoint', 404);
      }
    } catch (error) {
      if (error instanceof DomainError) return reply(res, error.status, { code: error.code, message: error.message });
      if (error instanceof z.ZodError) return reply(res, 400, { code: 'invalid_request', message: 'Request fields are invalid' });
      return reply(res, 500, { code: 'internal_error', message: 'Core operation failed' });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  return server;
}
