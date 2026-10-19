import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { z } from 'zod';
import { Store, classificationApprovalGate } from './store.js';
import { contextSchema, gateSchema, proposalSchema, eventSchema, expandSchema, knowledgeSchema, workflowSchema, taskSchema, taskStatus, outboxEntrySchema, DomainError } from './schema.js';
import { FORBIDDEN_AUTOMATIC } from './evolve.js';
import { coreSchema, type CoreConfig } from './config.js';
import { exportArchive, importArchive, inspectArchive } from './archive.js';
import { capabilityManifest, operatingModeFromDisk } from './capabilities.js';
import { UI_CSS, UI_HTML, UI_JS } from './ui.js';
import { maintenanceStatus, initializeMaintenance } from './maintenance.js';
import { reviewPrefill, reviewPrefills, type ReviewPrefill } from './model-review.js';
import { enqueueWorkflowDraft, listWorkflowDrafts, readWorkflowDraft, approveWorkflowDraft, reviseWorkflowDraft } from './workflow-organization.js';
import { createRetrievalService, selectionSource } from './retrieval-service.js';
// Off unless both the endpoint and the model are configured; absence is the switch.
import { embeddingConfigFrom } from './embeddings.js';
import { relevantPassages } from './retrieval-excerpt.js';
// 分块读取：长条目不再一次给全文（见 retrieval-chunk.ts 的实测背景）。
import { chunkBody } from './retrieval-chunk.js';

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
  '/v1/proposals/request-evidence', '/v1/proposals/archive', '/v1/proposals/reopen', '/v1/proposals/batch', '/v1/proposals/group',
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
  '/v1/outbox/list', '/v1/outbox/purge', '/v1/outbox/requeue',
  // Running evolution writes candidates into a table a person then reviews; reading the
  // summary is a read, but it belongs beside it so one credential does not see half of it.
  '/v1/evolution/run', '/v1/evolution/summary',
  '/v1/evolution/consolidate', '/v1/evolution/promote',
  '/v1/maintenance/status',
  '/v1/maintenance/retry',
  '/v1/workflow-drafts/list', '/v1/workflow-drafts/get', '/v1/workflow-drafts/generate', '/v1/workflow-drafts/approve',
  '/v1/workflow-drafts/revise',
  // Widening a task-scoped entry to the whole project changes what every later
  // session reads, which the design reserves for the user. Convergence and the
  // per-task archive stay open to an adapter on purpose: they write only inside the
  // task they concern, and the "session ended" rule needs a caller to run it.
  '/v1/tasks/promote',
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

/**
 * The analyzer's suggestions for one project's candidates, in one read.
 *
 * `model_reviews` is the only place the analysis survives, keyed by proposal id.
 * Two facts have to be joined here rather than in the table: the row's own
 * `inputHash` against the candidate's current payload, which is the only way to
 * tell a suggestion that still describes the candidate from one computed against
 * text that has since been edited. Computing it per row would mean one query per
 * candidate on a list page, so the payloads are read once as well.
 */
function reviewSuggestions(store: Store, projectId: string): Map<string, ReviewPrefill> {
  const rows = store.db.prepare('SELECT proposal_id,result FROM model_reviews WHERE project_id=?')
    .all(projectId) as Array<{ proposal_id: string; result: string }>;
  if (!rows.length) return new Map();
  const payloads = store.db.prepare('SELECT id,payload FROM proposals WHERE project_id=?')
    .all(projectId) as Array<{ id: string; payload: string | null }>;
  // The same hash `maintenance.ts` stores, so the two can be compared at all.
  const hashes = new Map(payloads.map(row => [String(row.id), createHash('sha256').update(String(row.payload)).digest('hex')]));
  return reviewPrefills(rows.map(row => {
    let result: unknown = null;
    try { result = JSON.parse(String(row.result)); } catch { /* an unreadable row yields no suggestion */ }
    return { proposalId: String(row.proposal_id), result };
  }), hashes);
}

/** One candidate's stored suggestion, or `null` when the analyzer never decided one. */
function reviewSuggestion(store: Store, projectId: string, proposalId: string): ReviewPrefill | null {
  const row = store.db.prepare('SELECT result FROM model_reviews WHERE proposal_id=? AND project_id=?')
    .get(proposalId, projectId) as { result: string } | undefined;
  if (!row) return null;
  const payload = store.db.prepare('SELECT payload FROM proposals WHERE id=?').get(proposalId) as { payload: string | null } | undefined;
  let result: unknown = null;
  try { result = JSON.parse(String(row.result)); } catch { return null; }
  return reviewPrefill(result, { payloadHash: createHash('sha256').update(String(payload?.payload)).digest('hex') });
}

export function createCoreServer(store: Store, config: CoreConfig) {
  initializeMaintenance(store);
  /**
   * The optional vector half is wired here, not only in tests.
   *
   * It used to be constructed without `embeddings`, so `fuseWithVectors` was reachable
   * from the unit tests and never from the running core: the layer could be configured
   * and still change nothing. `embeddingConfigFrom()` returns null unless both the
   * endpoint and the model are set, so an unconfigured install keeps the lexical answer
   * byte for byte.
   */
  const selectKnowledge=createRetrievalService(store,dirname(store.path),{embeddings:embeddingConfigFrom()});
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
      /**
       * No cleanup on the request path.
       *
       * It ran here to keep expiries and abandoned outbox rows current, at the cost of
       * turning every read into a write transaction: with a core busy importing, a
       * second process opening the same database failed with `database is locked`
       * (measured, 3 of 6 opens). Nothing on this path needs it - `liveEntries()`
       * filters lapsed material, `outboxStatus()` calls `abandonDueOutbox()` itself,
       * and the maintenance worker plus the CLI timer run the full pass every minute.
       */
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
          /**
           * An empty selection is two different facts, and the receipt must not merge them.
           *
           * `retrieval-service` answers with an empty `selectedIds` on several paths and
           * only some of them mean "nothing was asked":
           *
           *   - an empty query, `status_without_task` (a bare completion/status
           *     acknowledgement) and `no_positive_task` (a purely negative request, e.g.
           *     "不要 Postgres restore") never consulted the library at all;
           *   - `revision_mismatch`, a `local_index:*` verdict with no local hit, and
           *     `knowledge_changed` did consult it and either refused to widen the
           *     search or found nothing, which is a real coverage answer.
           *
           * Only the first group is reported as "no search was made". The distinction is
           * forwarded explicitly rather than inferred downstream, because the receipt's
           * `gaps` asserts "the library has no such fragment" — something the first group
           * cannot support, and the one claim a later investigation reads most literally.
           */
          const noRetrievalIntent = selection.selectedIds.length === 0
            && (!p.query.trim() || selection.reason === 'status_without_task' || selection.reason === 'no_positive_task');
          const prepared = store.prepare(p.projectId, p.query, {
            sessionId: p.sessionId, taskId: p.taskId, platform: p.adapter,
            ...(noRetrievalIntent ? { noRetrievalIntent: true } : {}),
            // The revision the caller already holds travels through, so a repeat call at the
            // same revision gets the pointer instead of the whole normative text again. It is
            // forwarded only when present: an absent version must still mean "send everything",
            // which is what a session's first turn needs.
            ...(p.knowledgeRevision !== undefined ? { knownRevision: p.knowledgeRevision } : {}),
            ...(selection.mode==='model'||selection.mode==='index'||selection.reason!=='not_configured'?{selectedIds:selection.selectedIds}:{}),
            // Which path made the choice travels with it, so the receipt can say
            // whether a model picked this entry or the local index did. Read off the
            // selection's own fields rather than carried as a second copy that could
            // drift out of step with them.
            ...(selectionSource(selection)?{selectionSource:selectionSource(selection)}:{}),
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
        /**
         * Reopen deliveries whose abandonment reason was a defect, not the content.
         *
         * Admin-only: it changes queue state, and the payloads it moves belong to the
         * human. `dryRun` defaults to true so the count and the reasons are visible before
         * anything is re-queued — the same shape as `amb reclassify`, because both are
         * "rewrite stored verdicts" operations.
         */
        case '/v1/outbox/requeue': {
          const p = z.object({
            projectId: z.string(),
            limit: z.number().int().positive().max(5000).optional(),
            reasonPattern: z.string().min(1).max(200).optional(),
            dryRun: z.boolean().default(true),
          }).parse(body);
          const result = store.requeueAbandoned({ projectId: p.projectId, limit: p.limit, reasonPattern: p.reasonPattern, dryRun: p.dryRun });
          return reply(res, 200, {
            ...result,
            note: result.dryRun
              ? '这是预演：只统计符合条件的已放弃条目与原因，没有改动任何一行。带 dryRun=false 才会真正重新入队。'
              : `已把 ${result.requeued} 条重新入队，截止时间延长 30 天、重试次数归零；下一次重放会按现有幂等路径送达或再次拒绝。`,
          });
        }
        /**
         * Stage one of the evolution pipeline: repeated signals → candidates.
         *
         * `dryRun` defaults to true, because the first call against a real library must be
         * able to show what it would produce before anything is stored. Even a real run
         * writes only to `evolve_candidates`: knowledge, norms and supersessions stay a
         * person's decision, and `forbidden` restates that list in the response rather than
         * leaving it to documentation nobody reads.
         */
        case '/v1/evolution/run': {
          const p = z.object({
            projectId: z.string(),
            dryRun: z.boolean().default(true),
            limit: z.number().int().positive().max(50000).optional(),
          }).parse(body);
          const result = store.runEvolution({ projectId: p.projectId, dryRun: p.dryRun, limit: p.limit });
          return reply(res, 200, {
            ...result,
            forbidden: FORBIDDEN_AUTOMATIC,
            note: result.dryRun
              ? '这是预演：只统计会产出哪些候选，没有写入任何一行。带 dryRun=false 才会写入 evolve_candidates。'
              : `已写入 ${result.candidates.length} 条候选；知识库未变（版本仍为 ${result.knowledgeRevision}），升格仍需要人。`,
          });
        }
        /**
         * Stages two and three.
         *
         * `consolidate` relates candidates and reports which went quiet; `promote` turns the
         * eligible ones into `pending` proposals — a review item, never a knowledge entry.
         * Both default to a dry run for the same reason stage one does: the first call
         * against a real library must be able to say what it would do first.
         */
        case '/v1/evolution/consolidate': {
          const p = z.object({ projectId: z.string(), dryRun: z.boolean().default(true) }).parse(body);
          const result = store.consolidateEvolution({ projectId: p.projectId, dryRun: p.dryRun });
          return reply(res, 200, {
            ...result,
            note: result.dryRun
              ? '这是预演：只报出会建立哪些关系、哪些候选已安静，未写入任何一行。'
              : `已建立 ${result.linked} 条关系（重复的不会重复写入）；过期只在结果里报出，不落库——它是时间的函数。`,
          });
        }
        case '/v1/evolution/promote': {
          const p = z.object({
            projectId: z.string(),
            dryRun: z.boolean().default(true),
            limit: z.number().int().positive().max(50).optional(),
            minConfidence: z.number().min(0).max(1).optional(),
          }).parse(body);
          const result = store.promoteEvolution({ projectId: p.projectId, dryRun: p.dryRun, limit: p.limit, minConfidence: p.minConfidence });
          return reply(res, 200, {
            ...result,
            forbidden: FORBIDDEN_AUTOMATIC,
            note: result.dryRun
              ? '这是预演：只说明会提交哪些候选，未创建任何提案。'
              : `已把 ${result.promoted.length} 条候选提交为待审提案；知识库未变——批准仍要人来做。`,
          });
        }
        case '/v1/evolution/summary': {
          const p = z.object({ projectId: z.string(), limit: z.number().int().positive().max(200).optional() }).parse(body);
          return reply(res, 200, { ...store.evolutionSummary(p.projectId, p.limit), forbidden: FORBIDDEN_AUTOMATIC });
        }
        case '/v1/outbox/purge': {
          const p = z.object({ projectId: z.string(), includePending: z.boolean().default(false) }).parse(body);
          const result = store.purgeOutbox({ projectId: p.projectId, includePending: p.includePending });
          return reply(res, 200, {
            ...result,
            note: p.includePending
              ? '已连同未送达条目一并清除，幂等键随之消失；discarded 列出被丢弃的内容，这是明确决定而非静默删除。'
              : '已送达条目被墓碑化：正文清空、行与幂等键保留，因此迟到的重试仍会被识别为重复而不是新任务。'
                + '已放弃条目原样保留——重新入队需要它的内容。要连带删除它们请显式传 includePending。',
          });
        }
        /**
         * The queue, in two views off the same rows.
         *
         * `flat` is the original reply and stays the default: one record per stored
         * row, newest first, which is what the console and the CLI already parse.
         * Changing that shape without a migration of its consumers would have made
         * this endpoint's callers depend on a review feature they never asked for.
         *
         * `queue` is the review view: same rows, ordered by what deserves attention,
         * with repeated auto-captured failures folded into one entry per signature.
         * It is derived on read — the endpoint writes nothing, so a caller can switch
         * between the two views and the batch actions below still act on the exact ids
         * the aggregate reported.
         *
         * `include` decides which slice is returned. The slice *not* returned is still
         * described in `groups`, so narrowing the reply never hides that the folded
         * group exists.
         */
        case '/v1/proposals/list': {
          const p = z.object({
            projectId: z.string(),
            state: z.string().optional(),
            view: z.enum(['flat', 'queue']).default('flat'),
            include: z.enum(['actionable', 'failure-facts', 'all']).default('actionable'),
            sampleLimit: z.number().int().min(1).max(20).default(3),
            limit: z.number().int().positive().max(500).optional(),
          }).parse(body);
          if (p.view === 'flat') {
            // `prefill` is added only for rows the analyzer actually decided, so
            // every existing consumer keeps reading exactly the fields it reads
            // today, and a candidate with no stored analysis stays field-for-field
            // identical to before.
            const suggestions = reviewSuggestions(store, p.projectId);
            return reply(res, 200, {
              proposals: store.listProposals(p.projectId, p.state).map(proposal => {
                const prefill = suggestions.get(proposal.id);
                /**
                 * The promotion verdict travels with the row that needs one.
                 *
                 * The queue shows the reason a candidate cannot be adopted on a bare
                 * click, and the rule for that reason lives in one place (`store`'s
                 * gate). Re-deriving "does this need confirmation" here would be a
                 * second opinion about one verdict, which is the shape of drift this
                 * whole change exists to remove — so the row carries the gate, and a
                 * row that needs nothing keeps exactly the fields it had before.
                 */
                const gate = classificationApprovalGate(
                  (proposal.payload as { classification?: unknown } | null)?.classification,
                );
                return {
                  ...proposal,
                  ...(prefill ? { prefill } : {}),
                  ...(gate.required ? { classificationGate: gate } : {}),
                };
              }),
            });
          }
          /**
           * The queue view is the one the panel opens by default, so the same
           * suggestion has to travel on its candidate entries: a prefill available
           * only in the flat list would sit on the road a reviewer rarely takes,
           * which is the same "computed and then unused" gap one layer down.
           *
           * `reviewSuggestions()` is reused rather than re-derived. Two paths that
           * each decide "is this suggestion still current" would drift apart —
           * same stored row, same payload hash, same vocabulary check, one answer.
           *
           * A candidate entry carries no `kind` (the stored projection has never had
           * one); only the folded group is tagged `aggregate`. That entry represents
           * repeated sightings of one failure signature rather than an adoptable
           * candidate, so it carries no suggestion, and the reply says so in `note`
           * instead of leaving a caller to guess whether a missing field meant
           * "nothing to suggest" or "the server forgot to fill it in".
           */
          const queue = store.queueProposals(p.projectId, {
            state: p.state, include: p.include, sampleLimit: p.sampleLimit, limit: p.limit,
          });
          const suggestions = reviewSuggestions(store, p.projectId);
          const items = (queue.items as unknown as Array<Record<string, unknown>>).map(item => {
            if (item.kind === 'aggregate') return item;
            const prefill = suggestions.get(String(item.id));
            return prefill ? { ...item, prefill } : item;
          });
          return reply(res, 200, {
            ...queue,
            items,
            note: `${queue.note} 聚合组（kind=aggregate）不提供建议：它代表同一签名的多次失败事实，不是一个可采纳的候选；`
              + '组内每条成员的建议可在 /v1/proposals/get 或扁平列表上逐条取到。',
          });
        }
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
          let stored: unknown;
          if (review) { try { stored = JSON.parse(String((review as { result: unknown }).result)); } catch { /* reported as awaiting below */ } }
          // The suggestion the form should open with, when the analyzer stored
          // one. It is advisory by construction: `prefill` never carries the
          // authority to approve, and its absence is reported by omission rather
          // than by a manufactured default.
          const prefill = reviewSuggestion(store, p.projectId, p.id);
          /**
           * The promotion verdict, always present on this read.
           *
           * Always, rather than only when something is required, because this is the
           * field a client branches on: an absent field would be read as "the server has
           * no opinion", and a client that treats "no opinion" as consent is the defect
           * this whole change removes. `required: false` is the server saying, in so many
           * words, that the stored verdict may promote itself.
           *
           * The verdict itself is computed by the store's own gate — the same function
           * the write path enforces — so this response cannot promise something the
           * approval would then refuse.
           */
          const classificationGate = classificationApprovalGate(
            (proposal.payload as { classification?: unknown }).classification,
          );
          return reply(res, 200, {
            ...proposal,
            modelReview: stored ?? { status: 'awaiting_model', authority: 'advisory' },
            ...(prefill ? { prefill } : {}),
            classificationGate,
          });
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
        //
        // `prefillSource` is a statement of what the form was pre-filled from, not
        // a substitute for the entry: a suggestion that arrived in `prefill` does
        // not appear here as an approvable object, so "the model already decided
        // this" can never become an approval. It only makes the reply say which
        // suggestion the reviewer confirmed, because that is a fact about this
        // decision and the entry itself has no field honest enough to hold it.
        case '/v1/proposals/approve': {
          const p = z.object({
            projectId: z.string(), id: z.string(), entry: knowledgeSchema,
            allowGlobalScope: z.boolean().default(false),
            prefillSource: z.enum(['model', 'heuristic']).optional(),
            /**
             * The reviewer stating that they acknowledged this candidate's classification.
             *
             * Optional, so an existing caller never breaks on a missing field, and a
             * candidate whose stored verdict may promote itself needs nothing new. Its
             * absence is not neutral: for a candidate whose verdict cannot speak for
             * itself, no field means no approval — never a quiet pass. Defaulting to
             * `false` rather than leaving it undefined keeps that reading in the schema
             * itself, so the two branches below cannot be reached by accident.
             */
            classificationAcknowledged: z.boolean().default(false),
          }).parse(body);
          /**
           * The gate, answered before anything is written.
           *
           * The verdict comes from the same function the write path enforces, so this
           * refusal cannot disagree with the one the store would raise; the store still
           * raises it, because a gate that lives only in the HTTP edge is the mistake
           * being repaired here. A candidate that cannot be read is left to the write
           * path's own error rather than being reported as a missing classification.
           */
          const preflight = (() => {
            try {
              return classificationApprovalGate(
                (store.getProposal(p.id, p.projectId).payload as { classification?: unknown }).classification,
              );
            } catch { return null; }
          })();
          if (preflight?.required && !p.classificationAcknowledged) {
            return reply(res, 409, {
              code: preflight.code,
              message: `该候选不能在没有人工确认的情况下采纳：${preflight.reason}`
                + '请人工核对类别与作用域；确认后在请求体里带上 classificationAcknowledged: true 重试。',
              requiredField: 'classificationAcknowledged',
              classificationGate: preflight,
            });
          }
          const knowledgeRevision = store.approveProposal(p.id, p.entry, {
            allowGlobalScope: p.allowGlobalScope, actor: principal.id, projectId: p.projectId,
            classificationAcknowledged: p.classificationAcknowledged,
          });
          return reply(res, 200, {
            knowledgeRevision,
            ...(p.prefillSource ? {
              prefillNote: `本次采纳由审阅人确认；类别与作用域取自${p.prefillSource === 'model' ? '模型建议' : '规则分析建议'}的预填。`
                + '建议本身不构成判定，条目的 provenance 仍按确认方记录。',
            } : {}),
          });
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
          const p = z.object({
            projectId: z.string(), id: z.string(),
            // Recorded with the state change: without these, "who moved this out and why"
            // is lost, and an undo has no object to restore.
            actor: z.string().min(1).max(200).optional(),
            reason: z.string().min(1).max(2000).optional(),
          }).parse(body);
          store.archiveProposal(p.id, { projectId: p.projectId, actor: p.actor, reason: p.reason });
          return reply(res, 200, { state: 'archived', note: '已移出待办队列，记录与决定仍可查阅。' });
        }
        /**
         * Disposing of a whole folded group.
         *
         * The queue folds repeats by signature but the members could only be handled one at
         * a time: 43 signatures covering 98 pending rows meant 98 clicks for one decision.
         * The ids are recomputed server-side from the signature, so the group the reviewer
         * saw and the rows this touches cannot diverge — and the three samples the queue
         * shows inline are a display limit, not the set being acted on.
         */
        case '/v1/proposals/group': {
          const p = z.object({
            projectId: z.string(),
            signature: z.string().min(1).max(200),
            action: z.enum(['archive', 'reject']),
            reason: z.string().min(1).max(500).optional(),
            actor: z.string().min(1).max(200).optional(),
          }).parse(body);
          const ids = store.proposalIdsBySignature(p.projectId, p.signature);
          if (!ids.length) {
            return reply(res, 404, {
              signature: p.signature, matched: 0,
              note: '该签名下没有待处理的候选；可能已被处理，或签名已不再匹配。',
            });
          }
          const result = store.reviewBatch(p.projectId, { action: p.action, ids, actor: p.actor, reason: p.reason });
          return reply(res, 200, {
            signature: p.signature, action: p.action, matched: ids.length, ...result,
            note: `按签名 ${p.signature} 处理 ${ids.length} 条；知识库未变，成员记录与原文全部保留，可用 /v1/proposals/reopen 逐条取回。`,
          });
        }
        case '/v1/proposals/batch': {
          const p = z.object({
            projectId: z.string(),
            action: z.enum(['approve', 'reject', 'archive', 'request-evidence']),
            ids: z.array(z.string().min(1)).min(1).max(200),
            entries: z.record(z.string(), knowledgeSchema).optional(),
            reason: z.string().min(1).max(500).optional(),
            /** Recorded on reject and archive; see the single-archive endpoint. */
            actor: z.string().min(1).max(200).optional(),
            allowGlobalScope: z.boolean().default(false),
            /** See the single-approval endpoint: absent means "no acknowledgement given". */
            classificationAcknowledged: z.boolean().default(false),
          }).parse(body);
          /**
           * A batch containing candidates that need confirmation is answered as a batch.
           *
           * The alternative — approving the ones that need nothing and failing the rest —
           * would leave a reviewer holding a half-applied decision they never agreed to,
           * and "5 approved, 12 refused" is exactly the report this endpoint's own note
           * says teaches nothing. So the whole batch is refused before a single write,
           * with the count and the reasons for the rows that need a person, and one
           * explicit acknowledgement (after the person has actually looked) completes it.
           *
           * Read-only: the pre-check reads stored payloads and writes nothing, and the
           * verdict comes from the store's own gate, so it cannot contradict the write
           * path it protects.
           */
          const gateRequired = p.action === 'approve' ? store.classificationGateFor(p.projectId, p.ids) : [];
          if (gateRequired.length && !p.classificationAcknowledged) {
            return reply(res, 409, {
              code: 'classification_confirmation_required',
              message: `这批候选里有 ${gateRequired.length} 条需要人工确认后才能采纳，整批未执行（一条也没写）：`
                + gateRequired.slice(0, 3).map(item => `${item.id}（${item.gate.reason}）`).join('；')
                + (gateRequired.length > 3 ? `；另有 ${gateRequired.length - 3} 条同样需要确认，完整清单见 proposals` : '')
                + '。请人工核对类别与作用域，确认后带上 classificationAcknowledged: true 重试；'
                + '也可以先只提交不需要确认的那几条。',
              requiredField: 'classificationAcknowledged',
              count: gateRequired.length,
              proposals: gateRequired.map(item => ({ id: item.id, reason: item.gate.reason, classificationGate: item.gate })),
            });
          }
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
          const p = z.object({
            projectId: z.string(), knowledgeId: z.string(), includeLeaves: z.boolean().optional(),
            query: z.string().max(4000).optional(),
            /**
             * 分块定位。**默认不再一次给全文**：实测最长条目 53117 字符，一次塞进去既挤占
             * 上下文、又让 agent 只读开头（Lost in the Middle 的中段召回跌到 30% 以下）。
             * 三种定位：`startLine`/`endLine`（精确行）→ `chunkIndex`（按块）→ 默认第 0 块。
             */
            chunkIndex: z.number().int().nonnegative().optional(),
            startLine: z.number().int().positive().optional(),
            endLine: z.number().int().positive().optional(),
            /** 显式要全文时才给（保留旧行为，供导出、审计这类确实需要全文的调用方）。 */
            full: z.boolean().optional(),
          }).parse(body);
          const knowledge=store.readKnowledge(p.projectId,p.knowledgeId,p.includeLeaves??false);
          const chars = String(knowledge.body ?? '').length;
          /**
           * `full` wins over `query`: an explicit request for the whole entry is not
           * narrowed by a question about it. Without this ordering the passage branch
           * emptied the body that `full=true` had asked for.
           */
          const passages = p.query && !p.full ? relevantPassages(knowledge.body, p.query) : undefined;
          /**
           * 查询与分块不并用：`query` 本身就是在缩小范围，再叠一层分块只会让读者分不清
           * "这是全部命中段落"还是"这只是第几块"。两者取其一，并在回执里说清是哪一种。
           */
          const chunk = (!p.full && !passages?.length)
            ? chunkBody(knowledge.body, { chunkIndex: p.chunkIndex, startLine: p.startLine, endLine: p.endLine })
            : undefined;
          return reply(res, 200, {
            ...knowledge,
            /**
             * A query narrows the answer; the full body must not ride along with it.
             *
             * `...knowledge` carries the whole prose, and the passage branch used to leave
             * it untouched: a request that asked for the parts relevant to a question
             * returned 20,017 characters of body beside a 497-character passage. That is
             * exactly the cost this endpoint's chunking exists to avoid, and it hit the
             * most common call shape. The length stays available in `chars`, and `full`
             * still returns everything when the caller really wants it.
             */
            ...(passages?.length ? { body: '' } : {}),
            chars,
            ...(chunk ? {
              body: chunk.text,
              chunk: {
                chunkIndex: chunk.chunkIndex, totalChunks: chunk.totalChunks, hasMore: chunk.hasMore,
                nextChunkIndex: chunk.nextChunkIndex, startLine: chunk.startLine, endLine: chunk.endLine,
                totalLines: chunk.totalLines, outline: chunk.outline, advisory: chunk.advisory,
              },
            } : {}),
            ...(passages ? {
              passages,
              note: passages.length
                ? `这是按查询取回的相关段落（共 ${passages.length} 段），不是全文；全文 ${chars} 字符未返回，要全文用 full=true，要更多段落就换关键词再取。`
                : '没有段落命中该查询；换关键词，或用 chunkIndex 逐块读。',
            } : {}),
            ...(!chunk && !passages ? { note: '本次按 full=true 返回全文，长度 ' + chars + ' 字符。' } : {}),
          });
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
        /**
         * Take an entry out of service, by the agent that found it wanting.
         *
         * `supersede` and `supplement` already let an agent correct or extend an entry, but
         * there was no way to retire one: `store.retire` existed and nothing could reach it.
         * A library whose only operations are "add" and "replace" cannot shed an entry that
         * turned out to be wrong - it can only grow, which is how 1160 abandoned deliveries and
         * a 65-entry norm pool accumulated.
         *
         * Retirement is reversible: the status flips to `retired`, the row and every revision
         * stay, and `reopen` can bring it back. That is why this is not admin-gated - the agent
         * that hit the wrong entry while using it is the one holding the evidence, and making it
         * ask permission to be correct would leave the entry in service meanwhile. `reason` is
         * mandatory: a retirement with no stated reason reads as an accident.
         */
        case '/v1/knowledge/retire': {
          const p = z.object({
            projectId: z.string(), id: z.string().min(1),
            baseRevision: z.number().int().nonnegative(),
            reason: z.string().min(1).max(500),
          }).parse(body);
          store.retire(p.id, p.baseRevision, { projectId: p.projectId, allowGlobal: principal.role === 'admin' });
          return reply(res, 200, { retired: p.id, reason: p.reason });
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
          // When the model selects nothing, fall back to the lexical ranking instead of
          // returning an empty set. The injection path has always done this; explicit
          // search did not, so the same query could find an entry through injection and
          // find nothing here. The reason is rewritten rather than dropped: a caller
          // must still be able to tell "the model abstained" from "the model judged
          // this irrelevant" - those are different facts and lead to different fixes.
          /**
           * 弃权与不可用**长得一样，结论相反**。
           *
           * 两者都可能是 `mode: 'index'` + 空 `selectedIds`，所以不能只看形状：
           *   - **弃权**（模型说"没什么适用"）：那是关于**相关性**的回答，可以用本地排名兜底；
           *   - **不可用**（provider 挂了/超时/排队）：那是关于**可用性**的回答，兜底就等于把
           *     "没查"当成"没找到"——正是这个项目反复禁止的那类混淆。
           *
           * 判据因此落在 reason 上：降级路径里只有 `model_abstained` 算弃权；而 `mode: 'model'`
           * 意味着模型真的作答了（选了空），也算弃权。既有测试
           * `unavailable model does not guess automatic recall` 守的正是这条边界——第一版按
           * "mode + 空集"判断，它立刻红了。
           */
          const modelAbstained=(selection.mode==='model'||selection.mode==='index')
            &&selection.selectedIds.length===0
            &&((selection.reason??'').includes('model_abstained')||selection.mode==='model');
          const effective=modelAbstained?{...selection,mode:'lexical_fallback' as const,reason:`model_abstained:${selection.reason??'no_selection'}`}:selection;
          const bySelection=effective.selectedIds.flatMap(id=>catalog.filter(entry=>entry.id===id)).slice(0,p.limit??(p.autoRecall?3:100));
          /**
           * One degradation rule for both branches of this endpoint.
           *
           * `autoRecall` decides how wide the local answer is, never whether there is
           * one. Measured before this change: a query on which the model abstained
           * returned an empty set with `autoRecall: true` and hits without it, so one
           * endpoint answered the same question two ways. A local verdict that the
           * index actually made - `mode: 'index'` - is still respected as it stands,
           * including an empty one: the stale-revision guard and "the model could not
           * speak" must not be softened into a broader search. Only an *undecided*
           * selection (the model said "nothing applies", the query asked for literal
           * text, the knowledge changed under it) is answered from the full-text
           * ranking.
           */
          // `decided` reads the *original* selection, not the rewritten `effective`:
          // an unavailable provider is rewritten to `lexical_fallback`, and treating
          // that as undecided would answer with a local guess exactly where
          // `retrieval-service` documents availability and relevance as different
          // claims.
          /**
           * 模型"明确弃权"**不是**一个决定。
           *
           * 上面那段注释本来就是这么写的（"the model said 'nothing applies' … is answered from
           * the full-text ranking"），但代码把 `mode === 'model'` 一律当 decided，于是弃权返回
           * 空集。实测抓到的形状：查询「规矩」在索引里命中 **29** 条、字面检索 5 条，而不带
           * `literal` 时是 **0** 条 —— agent 由此得出的结论会是"库里没有"，而库里有。
           * 同一个查询换个说法（"我以前写下的那些规矩"）反而能命中，正是因为多出来的词让模型
           * 给出了选择：**结果取决于模型当天怎么想，而不取决于库里有什么。**
           */
          /**
           * 显式检索与自动召回是**两个约定**，这条线由既有测试划着，我一开始把它当成一条：
           *   - `autoRecall: true` 走**自动召回**语义 —— 模型不可用时不猜（与 `/v1/prepare` 同一
           *     约定），因为"没查"不能被当成"没找到"；
           *   - **显式检索**（不带 autoRecall）是用户在明确找东西 —— 本地索引的严格门槛
           *     （`automaticRelevance` 的绝对下限）是为自动注入设的，不该拦显式查询。实测形状：
           *     同一个词在索引里命中 29 条、字面检索 5 条，而这个端点返回 0 条，用户据此断定
           *     库里没有。
           */
          const decided=(selection.mode==='model'&&!modelAbstained)
            ||(p.autoRecall===true&&selection.mode==='index');
          const results=p.kind==='norm'?store.searchUniversal(p.projectId,p.query,p.kind,p.limit)
            :decided?bySelection:store.searchUniversal(p.projectId,p.query,p.kind,p.limit??(p.autoRecall?3:100));
          return reply(res,200,{results,selection:effective,knowledgeRevision:store.revision});
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
        case '/v1/tasks/record': {
          const p = z.object({ projectId: z.string(), task: taskSchema }).parse(body);
          /**
           * The completion rule is the one the checkpoint path already enforces.
           *
           * This endpoint writes a task row directly, and it used to skip both checks:
           * an adapter could POST `completed` with no `verified` text and claim
           * `evidence: 'observed'`, and the diary generated from that row then recorded
           * `outcome: success` - measured end to end. `observed` is the plugin's own
           * record, which an adapter cannot make, and completion needs evidence that is
           * not merely the caller's prose.
           */
          if (principal.role !== 'admin' && p.task.evidence === 'observed')
            throw new DomainError('invalid_evidence', 'Adapters may record verifiable evidence, not claim plugin observations');
          if (p.task.status === 'completed'
            && (!p.task.verified.trim() || !['observed', 'verifiable'].includes(p.task.evidence)))
            throw new DomainError('verification_required', 'Completed tasks require verified text and verifiable evidence');
          return reply(res, 200, store.recordTask(p.projectId, p.task));
        }
        case '/v1/tasks/list': { const p = z.object({ projectId: z.string(), status: taskStatus.optional() }).parse(body); return reply(res, 200, { tasks: store.tasks(p.projectId, p.status) }); }
        case '/v1/tasks/handoff': { const p = z.object({ projectId: z.string(), taskId: z.string() }).parse(body); return reply(res, 200, store.handoff(p.taskId, p.projectId)); }
        /**
         * Run the session-end rule: converge stalled tasks, archive their diaries.
         *
         * One call because the two halves are one decision — a task with no recorded
         * activity is either still inside the idle window or it is not. The envelope
         * pins `projectId` to the credential's own project, so an adapter converges its
         * own project and nothing else; the core's timer is what runs the unscoped form
         * across all of them. `dryRun` exists so the rule can be shown to a user before
         * it is applied to a library.
         */
        case '/v1/tasks/converge': {
          const p = z.object({ projectId: z.string(), dryRun: z.boolean().default(false) }).parse(body);
          return reply(res, 200, {
            ...store.convergeTasks(p.projectId, { dryRun: p.dryRun }),
            note: p.dryRun
              ? '仅预演：只报告若执行会改变什么，未写入状态或条目。'
              : '已按阈值收敛：无进展的任务置为 paused 并写明原因，超过归档时长的任务把日记存进 task 作用域。'
                + '两者都是保留式处理：不删除内容，也不会自动标记 completed（完成需要核实依据）。',
          });
        }
        /**
         * File one task's diary under its own task scope.
         *
         * The single-task form of the archive inside `/v1/tasks/converge`, for a host
         * that knows a session just ended and does not want to wait for the timer.
         * Idempotent, so a host may call it on every stop.
         */
        case '/v1/tasks/archive': {
          const p = z.object({
            projectId: z.string(), taskId: z.string().min(1).max(120),
            /**
             * "The turn just ended" — the one moment the host knows a session stopped.
             *
             * The adapter cannot run the distiller itself: `/v1/evolution/run` is admin-only by
             * design (it is the pipeline that can eventually produce proposals), and widening that
             * to adapter credentials to save a round trip would trade a real boundary for a
             * convenience. So the adapter *signals* and the core acts — the same split the archive
             * itself already uses.
             */
            distill: z.boolean().optional(),
          }).parse(body);
          const archived = store.archiveTaskScope(p.projectId, p.taskId);
          /**
           * Distil at the turn boundary — and only distil.
           *
           * `runEvolution` writes `evolve_candidates` and nothing else: no knowledge entry, no
           * proposal, no norm. The eight-item `FORBIDDEN_AUTOMATIC` list is what pins that, and it
           * is why this is safe to run unattended. What it changes is when the work happens: the
           * pipeline already ran on a six-hour window, so a candidate could be produced long after
           * the session that earned it had ended. Here the candidate exists by the time the human
           * looks after the turn — which is the whole difference the peer comparison pointed at.
           *
           * A failure is reported, not swallowed and not fatal: an archive is bookkeeping, and a
           * turn that already ended must not fail because a background pass did. `error` travels
           * back so a silent zero is distinguishable from a pass that never ran.
           */
          let distilled: { scanned: number; candidates: number; skipped: number; error?: string } | undefined;
          if (p.distill) {
            try {
              const run = store.runEvolution({ projectId: p.projectId, dryRun: false });
              distilled = { scanned: run.scanned, candidates: run.candidates.length, skipped: run.skipped.length };
            } catch (error) {
              distilled = { scanned: 0, candidates: 0, skipped: 0, error: error instanceof Error ? error.message : String(error) };
            }
          }
          return reply(res, 200, {
            ...archived,
            ...(distilled ? { distilled } : {}),
            note: '本会话事实已归档为 task 作用域条目，可在任务活动里查到；它不是完成声明，也不改变任务状态。'
              + (distilled
                ? (distilled.error
                  ? ' 本轮结束时的提炼没有跑完（原因见 distilled.error）；六小时窗口那一趟仍会照常进行。'
                  : ` 本轮结束时按当前信号做了一次提炼：扫描 ${distilled.scanned} 条、产出 ${distilled.candidates} 条候选（只写候选表，绝不自动采纳）。`)
                : ''),
          });
        }
        /**
         * Widen a task-scoped entry to the project.
         *
         * Admin-only by the set above: this is the point at which "这一次" becomes a
         * rule for later work, and the design reserves that decision for the user.
         */
        case '/v1/tasks/promote': {
          const p = z.object({ projectId: z.string(), knowledgeId: z.string().min(1).max(120) }).parse(body);
          return reply(res, 200, {
            ...store.promoteTaskScope(p.projectId, p.knowledgeId),
            note: '已提升为项目作用域：该项目以后的会话都能读到它；原来的任务作用域修订仍留在历史里。',
          });
        }
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
      if (error instanceof z.ZodError) {
        /**
         * Say *which* field is wrong, not just that something is.
         *
         * The single sentence this used to return — "Request fields are invalid" — is true and
         * useless. The panel's approval form can build an entry for six different kinds, and the
         * kinds needing fields the form never collected (a `material` needs `url` and `summary`, a
         * `journal` needs `did`) failed with no way for the reader to learn why.
         *
         * `knowledgeSchema` is a union, and a union reports the union: the first version of this
         * fix only ever said `entry`, which is barely better than the sentence it replaced. Zod
         * keeps each branch's own issues under `errors`, so the branch that is *closest to valid*
         * is the one worth quoting — branches rejected solely because the `kind` differs are not
         * where the caller was heading.
         *
         * Paths and messages only — never the submitted values, which may be anything.
         */
        const fields: Array<{ path: string; message: string }> = [];
        for (const issue of error.issues) {
          const prefix = issue.path.join('.');
          /**
           * `errors` holds one issue list per union branch, and the list *is* the array — an earlier
           * read of it assumed `{ issues: [...] }` wrappers and threw on the first request. Accept
           * both shapes: the wrapper form costs nothing to support and a zod bump is not a reason to
           * turn a validation refusal into a 500.
           */
          const raw = (issue as { errors?: unknown }).errors;
          const branches: Array<Array<{ path: Array<string | number>; message: string }>> = Array.isArray(raw)
            ? raw.map(entry => (Array.isArray(entry) ? entry : ((entry as { issues?: unknown }).issues ?? [])) as Array<{ path: Array<string | number>; message: string }>)
            : [];
          if (branches.length) {
            const relevant = branches.filter(branch =>
              !branch.every(inner => inner.path.join('.') === 'kind' || /expected "/.test(inner.message)));
            const closest = (relevant.length ? relevant : branches)
              .reduce((best, branch) => (branch.length < best.length ? branch : best));
            for (const inner of closest.slice(0, 8)) {
              fields.push({ path: [prefix, inner.path.join('.')].filter(Boolean).join('.'), message: inner.message });
            }
            continue;
          }
          fields.push({ path: prefix, message: issue.message });
        }
        const listed = fields.slice(0, 12);
        return reply(res, 400, {
          code: 'invalid_request',
          message: '请求字段不合法：' + listed.map(field => (field.path ? field.path + ' ' : '') + field.message).join('；'),
          fields: listed,
        });
      }
      return reply(res, 500, { code: 'internal_error', message: 'Core operation failed' });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  return server;
}
