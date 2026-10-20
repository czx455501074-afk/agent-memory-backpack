import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { DEFAULT_DATA_DIR } from './resolve-config.mjs'
import { hostname } from 'node:os'
import { fileURLToPath } from 'node:url'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { CoreClientError, clientFailureMeta, createClient, isCancelledClientError, isExplicitClientRejection, isRecordValue, isWithinProject, loadClientConfig, sanitizeServerMessage } from './core-client.mjs'
import { createAdapterLogger } from './log.mjs'
import { ensureCoreRunning } from './ensure-core.mjs'
import { checkShellWriteBypass, decideFromSnapshot, loadSnapshot, operatingMode, saveSnapshot } from './gate-cache.mjs'
import { loadSpool, spoolEnqueue, spoolReplay } from './spool.mjs'
import { captureFailure, failureCandidate } from './failure-capture.mjs'
import { captureMaterial, replayMaterials } from './material-capture.mjs'
import { isContinuationQuery, recallKnowledge } from './recall.mjs'

const evidenceReferencesSchema = {
  type: 'array', maxItems: 10, items: { type: 'object', additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: ['artifact', 'command', 'url', 'knowledge', 'event'] },
      locator: { type: 'string', minLength: 1, maxLength: 2000 },
      snapshot: { type: 'string', maxLength: 6000 },
      snapshotHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      reportedHash: { type: 'string', maxLength: 128 },
      revision: { type: 'integer', minimum: 1 }, observedAt: { type: 'integer', minimum: 0 },
      result: { type: 'string', maxLength: 1000 },
    }, required: ['kind', 'locator'],
  },
}

/** The packaged core entry point, resolved beside this adapter. */
const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url))
/**
 * Where the core entry point may live.
 *
 * Packaged: `dsh-plugin/runtime/cli.js` beside this file. A development checkout
 * has no such copy, so `dist/src/cli.js` two levels up is tried as well. Only
 * the first that exists is used; a missing entry is reported, never raised.
 *
 * `AMB_CORE_ENTRY` covers the third shape, which neither of the first two fits:
 * `dsh plugin --profile <p> add "github:<owner>/<repo>#<sha>&path:adapters/dsh"` installs the
 * adapter *alone* into the profile's `node_modules` — no packaged runtime beside it, no checkout
 * two levels up — so the plugin used to report `core-entry-missing` and never start a core. The
 * variable names a core built elsewhere: `npm i -g github:<owner>/<repo>` runs the root `prepare`
 * script, so that install does have `dist/src/cli.js`.
 */
const CORE_ENTRY_CANDIDATES = [
  join(ADAPTER_DIR, 'runtime', 'cli.js'),
  join(ADAPTER_DIR, '..', '..', 'dist', 'src', 'cli.js'),
  ...(process.env.AMB_CORE_ENTRY?.trim() ? [resolve(process.env.AMB_CORE_ENTRY.trim())] : []),
]

export const name = 'agent-memory-backpack'
export const inject = ['tools']

/** Kept in step with package.json; asserted by the adapter tests. */
const PLUGIN_VERSION = '1.0.0'

const JSON_OBJECT = Object.freeze({ type: 'object', additionalProperties: true })
const EMPTY_OBJECT_INPUT = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {},
})

function textOfMessage(message) {
  if (!Array.isArray(message?.content)) return ''
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function jsonTool({ name, description, parameters, execute }) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: JSON_OBJECT,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute,
  }
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string.`)
  return value.trim()
}

/**
 * Convert any task representation (from /v1/tasks/list or /v1/tasks/handoff)
 * into a payload conforming strictly to the core's taskSchema.
 *
 * taskSchema is .strict() and rejects server-managed fields like `projectId`,
 * `createdAt`, `updatedAt`, `knowledgeRevision`, `completedAt`.
 */
export function toTaskRecord(rawTask, extraSessionId) {
  if (!rawTask || typeof rawTask !== 'object') {
    throw new Error('Invalid task object passed to toTaskRecord')
  }
  const existingSessions = Array.isArray(rawTask.sessionIds) ? rawTask.sessionIds : []
  const sessionIds = (extraSessionId && !existingSessions.includes(extraSessionId))
    ? [...existingSessions, extraSessionId]
    : [...existingSessions]

  const record = {
    id: String(rawTask.id ?? ''),
    title: String(rawTask.title ?? ''),
    status: rawTask.status,
    summary: typeof rawTask.summary === 'string' ? rawTask.summary : '',
    notes: typeof rawTask.notes === 'string' ? rawTask.notes : '',
    unfinished: Array.isArray(rawTask.unfinished) ? rawTask.unfinished.map(String) : [],
    sessionIds,
    relatedExperiences: Array.isArray(rawTask.relatedExperiences) ? rawTask.relatedExperiences.map(String) : [],
    relatedProposals: Array.isArray(rawTask.relatedProposals) ? rawTask.relatedProposals.map(String) : [],
    files: Array.isArray(rawTask.files) ? rawTask.files.map(String) : [],
    fileStates: Array.isArray(rawTask.fileStates) ? rawTask.fileStates : [],
    verified: typeof rawTask.verified === 'string' ? rawTask.verified : '',
    evidence: typeof rawTask.evidence === 'string' ? rawTask.evidence : 'self-reported',
  }
  if (typeof rawTask.startedAt === 'number' && Number.isFinite(rawTask.startedAt) && rawTask.startedAt >= 0) {
    record.startedAt = Math.floor(rawTask.startedAt)
  }
  return record
}

/** A revision must be a non-negative safe integer; -3 is safe but impossible. */
function isRevision(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function assertPrepareResponse(value) {
  if (!isRecordValue(value) || value.protocolVersion !== 1 || !isRevision(value.knowledgeRevision)
    || value.mode !== 'Managed' || !Array.isArray(value.norms) || !Array.isArray(value.workflows)
    || typeof value.context !== 'string') {
    throw new Error('Agent Memory Backpack core returned an invalid prepare response.')
  }
  // `knowledge` (adopted skills and memories) is optional so an older core stays
  // compatible; when present it must be well-formed.
  if (value.knowledge !== undefined && !Array.isArray(value.knowledge)) {
    throw new Error('Agent Memory Backpack core returned an invalid prepare response.')
  }
  return value
}

function assertGateResponse(value) {
  if (!isRecordValue(value) || !['allow', 'deny'].includes(value.decision)
    || typeof value.reason !== 'string' || !isRevision(value.knowledgeRevision)
    || typeof value.context !== 'string') {
    throw new Error('Agent Memory Backpack core returned an invalid gate response.')
  }
  return value
}

/**
 * Validate a proposal receipt.
 *
 * An idempotent retry legitimately answers with the proposal's *current* state
 * (for example `approved` with `duplicate: true`) rather than `pending`, so the
 * earlier "must equal pending" rule turned a valid retry into a protocol error.
 * Any known state is accepted for a duplicate; a first-time submit must be
 * pending.
 */
const PROPOSAL_STATES = ['pending', 'approved', 'rejected', 'expired', 'needs_evidence', 'archived']

function assertReceipt(value, kind) {
  if (!isRecordValue(value) || typeof value.id !== 'string' || !value.id
    || typeof value.duplicate !== 'boolean') {
    throw new Error(`Agent Memory Backpack core returned an invalid ${kind} receipt.`)
  }
  const allowed = value.duplicate === true ? PROPOSAL_STATES
    : kind === 'pending' && value.disposition === 'discarded_low_value' ? ['rejected'] : [kind]
  if (!allowed.includes(value.state)) {
    throw new Error(`Agent Memory Backpack core returned an invalid ${kind} receipt.`)
  }
  return value
}

/**
 * A supersede response must confirm history was preserved.
 *
 * Checking this rather than trusting HTTP 200 keeps the guarantee visible at the
 * adapter boundary: if a future core ever returned success without retaining the
 * earlier revision, the agent would report a failure instead of silently
 * believing the old knowledge was still recoverable.
 */
function assertSupersedeResponse(value) {
  if (!isRecordValue(value) || value.historyPreserved !== true
    || (value.action !== 'supersede' && value.action !== 'supplement')
    || !Number.isSafeInteger(value.oldRevision) || !Number.isSafeInteger(value.newRevision)) {
    throw new Error('Agent Memory Backpack core returned an invalid supersede response.')
  }
  return value
}

function knowledgeMessage(context) {
  return {
    id: randomUUID(),
    role: 'user',
    source: { kind: 'agent-memory-backpack', form: 'instructions' },
    content: [{ type: 'text', text: `[Project knowledge context]\n${context}` }],
  }
}

/** How many recent session events are scanned when recovering handoff context. */
const SESSION_EVENT_WINDOW = 400
/** Tools whose arguments name a file the session actually read or wrote. */
const FILE_TOOLS = new Set(['read', 'write', 'edit', 'apply_patch', 'create_file', 'str_replace_editor'])

function looksLikePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && /[\\/.]/.test(value)
}

/**
 * Collect the project-local files a session's tool calls named.
 *
 * Only arguments of read/write/edit-style tools count, and only paths that
 * resolve inside the project root: the point is a checkable list of what the
 * previous session touched, not a dump of every string the model typed. Paths
 * are kept as the session named them (relative or absolute) so they still make
 * sense to a user reading the handoff. Write targets are returned first, because
 * "what was produced" matters more to a continuation than "what was looked at".
 *
 * `taskId` narrows the scan: an event tagged with a different task is skipped, so
 * one task's files cannot be attributed to another that runs later in the same
 * session (the verifier's cross-task counterexample). The caller passes only the
 * *current cohort* of events (those since its previous step); the real host tags
 * nothing, so cohort membership — not a tag — is what segments tasks in practice.
 */
function harvestSessionFiles(events, projectRoot) {
  const written = new Set()
  const read = new Set()
  for (const event of events) {
    if (event?.type !== 'tool/call') continue
    const data = event.data
    if (!isRecordValue(data) || typeof data.name !== 'string') continue
    const isFileTool = FILE_TOOLS.has(data.name)
    const isShell = data.name === 'pwsh' || data.name === 'bash' || data.name === 'shell'
    if (!isFileTool && !isShell) continue
    let args = data.arguments
    if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = undefined } }
    if (!isRecordValue(args)) continue
    const writeTool = data.name === 'write' || data.name === 'edit' || data.name === 'apply_patch' || data.name === 'create_file'
    const target = writeTool ? written : read
    for (const key of ['file_path', 'filePath', 'path', 'notebook_path']) {
      if (looksLikePath(args[key])) target.add(String(args[key]))
    }
    // A shell command may name the deliverable too; take only a path-shaped
    // token, never the whole command.
    if (isShell && typeof args.command === 'string') {
      for (const match of args.command.matchAll(/[A-Za-z0-9_./\\:-]{3,}\.(?:md|txt|json|ya?ml|ts|tsx|js|mjs|cjs|py|sql|html|css|csv)/g)) {
        if (looksLikePath(match[0])) read.add(match[0])
      }
    }
  }
  const inside = (set) => {
    const kept = []
    for (const candidate of set) {
      try {
        const absolute = isAbsolute(candidate) ? candidate : join(projectRoot, candidate)
        const rel = relative(realpathSync(projectRoot), realpathSync(dirname(absolute)))
        if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) kept.push(candidate)
      } catch { /* a path that does not exist yet cannot be confirmed inside the project */ }
    }
    return kept
  }
  return [...new Set([...inside(written), ...inside(read)])].slice(0, 100)
}

/**
 * A one-line account of the last thing the session was doing.
 *
 * Real DSH traces split the two halves: a `tool/call` event carries the tool
 * `name` and `arguments` (but no message), and a `tool/result` event carries the
 * output message (but no name). An earlier version looked for both on one event
 * and therefore never matched, so the handoff's Progress line was always
 * "未记录". The name is therefore recovered by pairing a result's `toolCallId`
 * with the call that carries it. The output is the session's own account, so it
 * is labelled as such beside the core-verified fields, and an aborted turn is
 * reported as stopped rather than as success.
 */
function lastSessionProgress(events) {
  const nameByCallId = new Map()
  for (const event of events) {
    if (event?.type !== 'tool/call') continue
    const data = event.data
    if (isRecordValue(data) && typeof data.callId === 'string' && typeof data.name === 'string') {
      nameByCallId.set(data.callId, data.name)
    }
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type === 'turn/end') {
      const reason = event.data?.reason?.kind
      if (reason === 'aborted') return `上一轮被中断（${reason}），未标记完成`
    }
    const data = event?.data
    if (!isRecordValue(data) || !isRecordValue(data.message)) continue
    const callId = typeof data.message.toolCallId === 'string'
      ? data.message.toolCallId
      : (isRecordValue(data.message.source) && typeof data.message.source.callId === 'string' ? data.message.source.callId : undefined)
    const name = callId ? nameByCallId.get(callId) : undefined
    const text = (Array.isArray(data.message.content) ? data.message.content : [])
      .map(block => (isRecordValue(block) && typeof block.text === 'string' ? block.text : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (text && name) return `最近一次工具 ${name}：${text.slice(0, 200)}`
    if (text) return `最近一次工具输出：${text.slice(0, 200)}`
  }
  return ''
}

/**
 * The read-only data routes the native DSH panel reads.
 *
 * The panel used to be an embedded page and asked this server for its own address;
 * it is now a React view inside the harness document, so it asks for data instead.
 * These three routes are the whole of that contract, and every field they return is
 * read from the real core through the same `client` - and therefore the same
 * credential and the same project scope - that the rest of the adapter uses.
 */

/**
 * How many entries the flat `knowledge` sample carries.
 *
 * This is the core's own per-request ceiling: the panel's "all entries" view is
 * a plain list of the library this credential can see, and a shorter page would
 * silently decide which entries exist for the reader. Categories use
 * `PANEL_KIND_FETCH_LIMIT`, one call per category.
 */
const PANEL_KNOWLEDGE_LIMIT = 200
/**
 * How many entries one knowledge category may carry in `facets`.
 *
 * The panel groups by category, and a group needs both a name and a truthful
 * size: asking the core for one page per category returns every entry of that
 * category up to this ceiling, so the panel can print what the core actually
 * holds instead of a count derived from a truncated page. The core's own ceiling
 * is 200 per call, so a category larger than this reports the ceiling it reached
 * and the panel says so; `counts.knowledge` remains the library-wide number.
 */
const PANEL_KIND_FETCH_LIMIT = 200
/**
 * The core's own ceilings, mirrored here so a bad parameter is refused with a
 * readable reason instead of surfacing as a zod "Request fields are invalid".
 * `/v1/knowledge/search-universal` takes `limit` up to 200, and `/v1/tasks/activity`
 * takes `taskId` up to 120 characters.
 */
const PANEL_SEARCH_MAX_LIMIT = 200
const PANEL_TASK_ID_MAX_CHARS = 120
const PANEL_QUERY_MAX_CHARS = 4000
/**
 * The knowledge categories the panel navigates, in the order it lists them.
 *
 * The names are the core's own `kind` values, read from `knowledge(id, kind,
 * head, status)`; nothing here invents a category or a count. `labelKey` and
 * `guideKey` are panel copy keys the browser half resolves, so a category the
 * core adds later simply does not appear until both halves agree on it.
 */
const KNOWLEDGE_KIND_GUIDES = [
  { kind: 'skill', labelKey: 'kind.skill.label', guideKey: 'kind.skill.guide' },
  { kind: 'journal', labelKey: 'kind.journal.label', guideKey: 'kind.journal.guide' },
  { kind: 'material', labelKey: 'kind.material.label', guideKey: 'kind.material.guide' },
  { kind: 'memory', labelKey: 'kind.memory.label', guideKey: 'kind.memory.guide' },
  { kind: 'norm', labelKey: 'kind.norm.label', guideKey: 'kind.norm.guide' },
]
/**
 * The data paths this file serves, matched exactly - never as a prefix. The task
 * states the panel groups by are the core's own `status` values; the browser half
 * holds their labels, since nothing on this side branches on them.
 */
const PANEL_DATA_PATHS = new Set(['/amb/summary', '/amb/search', '/amb/task', '/amb/ui-url'])

/**
 * The panel's management surface, allow-listed by action name.
 *
 * The browser half never names a core path. It names an *action*, and this table
 * decides which core endpoint that action may reach. A path passthrough would hand
 * a caller every endpoint the admin credential can reach, which is the whole
 * library - so the mapping is the security boundary, not a convenience.
 *
 * Every target here is one the core itself marks admin-only (`ADMIN_ONLY` in
 * src/server.ts), because each one changes the effective library or reviews a
 * change to it. The core's reasoning is exactly why the human's credential is
 * needed: an agent that could approve would be able to clear its own queue.
 *
 * `/v1/backup/inspect` is deliberately absent, matching the core's own note: it
 * reports only counts, file names and a timestamp, so it is not admin-only there
 * and it is not exposed here either. Import always follows an inspect, and both are
 * driven from the panel's backup section.
 *
 * `/v1/proposals/batch` is deliberately absent for now: it can act on many
 * proposals at once, and a single mis-click should not be able to clear the queue.
 * The per-proposal actions below cover the same ground one review at a time.
 */
const PANEL_ADMIN_ACTIONS = Object.freeze({
  'proposals-list': '/v1/proposals/list',
  'proposal-get': '/v1/proposals/get',
  'proposal-approve': '/v1/proposals/approve',
  'proposal-reject': '/v1/proposals/reject',
  'proposal-archive': '/v1/proposals/archive',
  // One action for a whole folded group. The core recomputes the members from the
  // signature, so this endpoint acts on the group rather than on the three samples the
  // queue shows inline.
  'proposal-group': '/v1/proposals/group',
  'proposal-reopen': '/v1/proposals/reopen',
  'proposal-request-evidence': '/v1/proposals/request-evidence',
  'backup-export': '/v1/backup/export',
  'backup-import': '/v1/backup/import',
  'knowledge-delete': '/v1/knowledge/delete',
  'knowledge-supersede': '/v1/knowledge/supersede',
  'material-renew': '/v1/material/renew',
  'material-purge': '/v1/material/purge',
  'outbox-list': '/v1/outbox/list',
  'outbox-purge': '/v1/outbox/purge',
  'maintenance-status': '/v1/maintenance/status',
  'maintenance-retry': '/v1/maintenance/retry',
  'rescan-mark': '/v1/rescan/mark',
  'workflow-drafts-list': '/v1/workflow-drafts/list',
  'workflow-draft-get': '/v1/workflow-drafts/get',
  'workflow-draft-approve': '/v1/workflow-drafts/approve',
  'workflow-draft-revise': '/v1/workflow-drafts/revise',
})

/**
 * Actions that change the library rather than read it.
 *
 * The browser half asks for confirmation before sending these; this side records
 * them on the plugin log so a surprising change can be traced to the panel, the
 * action and the moment. Reads are not logged - a log full of reads hides the
 * writes, which are the only entries worth keeping.
 */
const PANEL_ADMIN_WRITES = new Set([
  'proposal-approve', 'proposal-reject', 'proposal-archive', 'proposal-reopen', 'proposal-group',
  'proposal-request-evidence', 'backup-import', 'knowledge-delete', 'knowledge-supersede',
  'material-renew', 'material-purge', 'outbox-purge', 'maintenance-retry',
  'rescan-mark', 'workflow-draft-approve', 'workflow-draft-revise',
])

function panelJson(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    // Counts and lists move as work is recorded, so a cached copy would be stale.
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

/**
 * A failure reason that is safe to put in a response body.
 *
 * The core client already reduces a core failure to a fixed template plus a
 * sanitized detail, but this body is rendered inside the harness document, so the
 * text is passed through the same sanitizer once more: the credential must never be
 * able to reach a page, a log, or a screenshot.
 */
function panelReason(error, token) {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const safe = sanitizeServerMessage(raw, token).replace(/\s+/g, ' ').trim()
  return safe || 'AMB 核心请求失败。'
}

/** A count the panel can print, or null when the core did not report one. */
function panelCount(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * One knowledge entry as the panel shows it.
 *
 * `scope` is flattened from the core's discriminated union to its `kind`, which is
 * what the row's origin badge prints: `global` means the entry applies to every
 * project, `project` and `session` mean the reader's own scope. An entry whose
 * scope is absent or unknown is reported as `unknown` rather than assumed global -
 * the two would disagree the moment the core adds a scope.
 *
 * `status` is the core's own column (`knowledge.status`), passed through unchanged;
 * it is never inferred from anything else. `proposalState` has no source on this
 * path, so it stays null and the panel prints "not provided" rather than claiming a
 * candidate state it cannot read: `/v1/proposals/list` is admin-only.
 *
 * `updatedAt` has no source on this path either: the core's retrieval endpoint
 * returns id, revision, kind, title, scope, provenance and excerpt per entry, and no
 * timestamp. The field is present and empty rather than filled with a plausible
 * number, so the panel prints "not provided" instead of a date that would be wrong
 * next to real knowledge.
 */
function panelEntry(raw) {
  if (!isRecordValue(raw) || typeof raw.id !== 'string' || raw.id === '') return null
  const scope = isRecordValue(raw.scope) && typeof raw.scope.kind === 'string' ? raw.scope.kind : ''
  return {
    id: raw.id,
    kind: typeof raw.kind === 'string' ? raw.kind : '',
    title: typeof raw.title === 'string' && raw.title ? raw.title : raw.id,
    status: typeof raw.status === 'string' ? raw.status : '',
    scope,
    source: scope === 'global' || scope === 'project' || scope === 'session' ? scope : 'unknown',
    proposalState: null,
    updatedAt: null,
    excerpt: typeof raw.excerpt === 'string' ? raw.excerpt : '',
  }
}

/** Map `/v1/knowledge/search-universal` results; a missing array is a fault. */
function panelEntries(payload) {
  const results = isRecordValue(payload) && Array.isArray(payload.results) ? payload.results : null
  if (!results) throw new Error('AMB 核心返回的知识列表缺少 results 数组。')
  return results.map(panelEntry).filter(entry => entry !== null)
}

/**
 * One task record as the panel lists it.
 *
 * `projectId` travels with the record because the panel labels a task with the
 * project it belongs to; the core stores it per row, so the badge is the row's own
 * value and not the credential's project repeated. `evidence` is the core's own
 * column and is the only truthfulness marker the panel has for a task, so it is
 * passed through rather than summarized.
 */
function panelTask(raw) {
  if (!isRecordValue(raw) || typeof raw.id !== 'string' || raw.id === '') return null
  return {
    id: raw.id,
    title: typeof raw.title === 'string' && raw.title ? raw.title : raw.id,
    status: typeof raw.status === 'string' ? raw.status : '',
    projectId: typeof raw.projectId === 'string' ? raw.projectId : '',
    summary: typeof raw.summary === 'string' ? raw.summary.slice(0, 400) : '',
    evidence: typeof raw.evidence === 'string' ? raw.evidence : '',
    updatedAt: panelCount(raw.updatedAt),
  }
}

/** Whether this request names one of the panel's data routes, query aside. */
function isPanelDataRequest(rawUrl) {
  if (typeof rawUrl !== 'string') return false
  const query = rawUrl.indexOf('?')
  return PANEL_DATA_PATHS.has(query === -1 ? rawUrl : rawUrl.slice(0, query))
}

/** The panel's own management prefix, as opposed to the data routes above. */
const PANEL_ADMIN_PREFIX = '/amb/admin/'

/**
 * The admin credential, read on this side only.
 *
 * Holding the admin token inside the host process is the whole reason the panel's
 * management section can exist: the browser half names an *action*, and this side
 * checks it against the allow-list and performs it with a credential the page never
 * sees, stores or forwards. Nothing in a response body is ever built from the token.
 *
 * Resolution mirrors what the CLI does: the file is `<data dir>/admin-client.json`
 * and it must carry a token. A missing or unusable file is a capability the panel
 * reports as unavailable, not a stack trace the user has to decode.
 *
 * The returned client deliberately reuses this adapter's endpoint and project. The
 * admin credential authorises *reviews*; it does not move the panel to a different
 * library. Were the two allowed to disagree, the panel would be managing a core the
 * rest of the plugin is not talking to.
 */
function readPanelAdminClient(config) {
  try {
    const path = join(DEFAULT_DATA_DIR(), 'admin-client.json')
    if (!existsSync(path)) return null
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (!isRecordValue(raw) || typeof raw.token !== 'string' || !raw.token.trim()) return null
    return createClient({
      endpoint: config.endpoint,
      token: raw.token,
      projectId: config.projectId,
      projectRoot: config.projectRoot,
    })
  } catch {
    return null
  }
}

/**
 * Read a bounded JSON request body.
 *
 * The cap exists because this route is reachable from a page: without it a single
 * request could make the host buffer an unbounded amount of text. Oversized bodies
 * are refused rather than truncated, since a truncated JSON object is not a payload
 * anyone meant to send.
 */
async function readPanelAdminBody(req, maxBytes = 65_536) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) return { tooLarge: true }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return { body: {} }
  try {
    const parsed = JSON.parse(text)
    if (!isRecordValue(parsed)) return { invalid: true }
    return { body: parsed }
  } catch {
    return { invalid: true }
  }
}

/**
 * Fill in what the panel cannot know.
 *
 * Every admin route is scoped: the core's own schemas require a `projectId`, and
 * that is *this adapter's* project rather than something a page should be able to
 * pick. So the panel names the action and its subject, and this side supplies the
 * scope. This was learned from the first run against a live host, where every
 * action that carried an empty body came back `HTTP 400 invalid_request` - the
 * page was answering a question it had no business being asked.
 *
 * Two actions need more than a scope, and both are composed here rather than
 * pushed onto the page:
 *
 *   - `backup-export` writes to a path. The panel may pass one; when it does not,
 *     a default under the data directory keeps "export" a single click.
 *   - `proposal-approve` needs the candidate's *entry*, not just its id, because
 *     the core approves a knowledge object. The entry is read back from the
 *     candidate first, so the page never has to hold it.
 */
export async function buildPanelAdminParams(action, body, config, admin) {
  const params = { ...body }
  if (typeof params.projectId !== 'string' || params.projectId === '') params.projectId = config.projectId
  /**
   * Did a person fill in the compose form for this approval?
   *
   * Read before the fallback below fills `params.entry` itself: an entry the reviewer
   * typed (kind changed, title kept or edited, confirm pressed) is evidence that the
   * judgement happened; an entry this function derived is not, and must not be treated
   * as one. The two look identical by the time they reach the core.
   */
  const reviewerSuppliedEntry = action === 'proposal-approve' && isRecordValue(params.entry)

  // The queue view is the panel's default read: same rows, ordered by what deserves
  // attention, with repeated auto-captured failures folded into one entry per
  // signature. The parameters are passed through rather than fixed here, because the
  // panel offers both views and must be able to ask for the folded members back
  // (`include: 'failure-facts'`) — a caller that can only see the fold and never its
  // members has been shown a smaller queue, not an aggregated one.
  if (action === 'proposals-list') {
    if (params.view === undefined) params.view = 'queue'
    if (params.include === undefined) params.include = 'actionable'
  }

  if (action === 'backup-export' && (typeof params.file !== 'string' || params.file === '')) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = join(DEFAULT_DATA_DIR(), 'exports')
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      // A directory that cannot be created surfaces as the core's own write error,
      // which names the path. Inventing a second error here would only hide it.
    }
    params.file = join(dir, `amb-${stamp}.ambpack`)
  }

  if (action === 'proposal-approve' && !params.entry) {
    const got = await admin.post('/v1/proposals/get', { projectId: params.projectId, id: params.id })
    // `proposals/get` answers with the candidate itself, not a wrapper object.
    const payload = got && isRecordValue(got.payload) ? got.payload : null
    if (payload && isRecordValue(payload.entry)) {
      params.entry = payload.entry
    } else {
      // A captured candidate carries *text* (`payload.discovery`) rather than a
      // knowledge object - but it also carries the classification the plugin has
      // already computed for it (kind, scope, relation, confidence, reasoning).
      // Reviewing is the human saying "this belongs in the library"; deciding what
      // shape it takes is the plugin's job. Demanding it again turned the ordinary
      // case into a two-step form for a judgement the system had already made, and
      // the second step was the one people missed - the candidate then looked
      // unapproved and stayed in the queue.
      const derived = entryFromClassification(payload, params.projectId, params.id)
      if (!derived) {
        // Why the click was refused decides what the reviewer reads next. "The plugin
        // has no opinion" and "the plugin's opinion is that this must not be automatic"
        // are different instructions: the first asks for a classification, the second
        // already has one and says what is wrong with it. The reason travels with the
        // classification (`promotionBlockedReason`), so it is quoted verbatim instead
        // of being paraphrased into something vaguer.
        const classification = payload && isRecordValue(payload.classification)
          ? payload.classification : null
        /**
         * The reason, in the core's own words when the core gave one.
         *
         * Three cases, kept apart because they ask the reviewer to do different things:
         * the core's gate said this candidate needs a person (quote its sentence); the
         * stored verdict says `autoPromotable: false` (quote `promotionBlockedReason`);
         * or the verdict carries no usable field at all, which is the shape every stored
         * candidate has — "missing" is a reason to ask a person, so it is stated as such
         * rather than folded into "no classification".
         */
        const gate = payload && isRecordValue(payload.classificationGate) ? payload.classificationGate : null
        const blocked = gate && typeof gate.reason === 'string' && gate.reason !== ''
          ? gate.reason
          : classification && classification.autoPromotable === false
            ? (typeof classification.promotionBlockedReason === 'string' && classification.promotionBlockedReason !== ''
              ? classification.promotionBlockedReason
              : '该候选不得自动升格。')
            : classification
              ? '该候选的判定来自旧版本判定器（快照里没有可用的判定字段），无法据此自动放行。'
              : null
        throw new Error(
          blocked === null
            ? '该候选没有可用的分类判定，或它要成为全局知识，因此无法一键采纳。'
              + '请在评审流程里选定类别与作用域后再采纳。'
            : `该候选不能一键采纳：${blocked}请在评审流程里人工选定类别与作用域后再采纳。`,
        )
      }
      params.entry = derived
    }
  }
  /**
   * Carry the reviewer's confirmation to the core.
   *
   * The gate exists to stop a candidate from promoting *itself* — not to stop a person.
   * A reviewer who opened the form, saw the kind and the scope, and pressed confirm has
   * made exactly the judgement the gate asks for, so that intent has to travel with the
   * request. It did not: the panel sent the entry without `classificationAcknowledged`,
   * the core refused with 409, and the panel answered with guidance telling the reviewer
   * to do the thing they had just done. A withheld candidate could therefore be opened,
   * confirmed, and refused again — forever, which reads as "the button is broken".
   *
   * Only the form path sets this. A derived entry leaves the field alone, so anything
   * that reaches the core without a person behind it is still refused.
   */
  if (reviewerSuppliedEntry && params.classificationAcknowledged === undefined) {
    params.classificationAcknowledged = true
  }
  return params
}

/** Kinds a candidate may be promoted into without asking the reviewer to retype it. */
const AUTO_PROMOTE_KINDS = new Set(['skill', 'journal', 'material', 'memory', 'norm'])

/** The first non-empty line, which is what a candidate uses as its handle. */
function firstLineOf(text) {
  return String(text).split('\n').map((line) => line.trim()).find((line) => line !== '') ?? ''
}

/**
 * Build the knowledge entry a candidate should become, from the classification the
 * plugin already computed.
 *
 * Returns null when the plugin cannot answer on its own, and the caller then falls
 * back to asking. Two cases are deliberately refused rather than guessed:
 *
 *  - `scope: global` - promoting one project's knowledge to every project is a
 *    widening decision, and the store requires `allowGlobalScope` for exactly that
 *    reason. A silent guess here would apply one project's experience everywhere.
 *  - a candidate with no classification - there is nothing to derive from, and
 *    inventing a kind would produce a review nobody performed.
 *
 * `provenance: 'agent'` records who decided the shape: the plugin, not the person
 * who clicked. That distinction survives in the stored entry.
 */
export function entryFromClassification(payload, projectId, proposalId) {
  if (!isRecordValue(payload)) return null
  const classification = isRecordValue(payload.classification) ? payload.classification : null
  if (!classification) return null

  // Whether this candidate may be adopted unattended. The verdict is the core's when the
  // core sent one — `payload.classificationGate` on `/v1/proposals/get` — because the
  // core computes it with the same function its write path enforces. This adapter does
  // not re-derive it: two derivations of one rule is exactly how the previous
  // `autoPromotable === false` test came to disagree with the gate it mirrored, reading
  // `undefined === false` as "nothing objected" while the core read the same missing
  // field as "nobody has confirmed this".
  //
  // When no gate arrived (an older core, or a payload read from elsewhere) the rule is
  // applied here in the same words: only an explicit `true` is promoted unattended.
  // Missing is not consent — that was the defect: 255 stored candidates classified by an
  // older classifier were one click away from becoming rules, because "no opinion" had
  // been written into the code as "no objection". Returning null routes the caller to the
  // compose form, which is the existing path for "a human must pick the kind and scope".
  const gate = isRecordValue(payload.classificationGate) ? payload.classificationGate : null
  const mayPromoteUnattended = gate ? gate.required !== true : classification.autoPromotable === true
  if (!mayPromoteUnattended) return null

  const kind = typeof classification.kind === 'string' ? classification.kind : ''
  if (!AUTO_PROMOTE_KINDS.has(kind)) return null

  const text = typeof payload.discovery === 'string' ? payload.discovery : ''
  const title = firstLineOf(text).slice(0, 120)
  if (title === '') return null

  const scopeKind = typeof classification.scope === 'string' ? classification.scope : 'project'
  if (scopeKind === 'global') return null

  const owner = typeof payload.projectId === 'string' && payload.projectId !== ''
    ? payload.projectId : projectId
  if (typeof owner !== 'string' || owner === '') return null

  let scope
  if (scopeKind === 'task') {
    const taskId = typeof payload.taskId === 'string' ? payload.taskId : ''
    if (taskId === '') return null
    scope = { kind: 'task', projectId: owner, taskId }
  } else {
    scope = { kind: 'project', projectId: owner }
  }

  return {
    // The full id, not a prefix: two candidates of the same kind must never collide
    // on a truncated uuid.
    id: `${kind}:${String(proposalId)}`,
    baseRevision: 0,
    kind,
    title,
    body: text,
    scope,
    provenance: 'agent',
    // A captured candidate is unverified by definition; the review does not change
    // what the text is worth.
    evidence: 'unverifiable',
  }
}

/**
 * `POST /amb/admin/<action>`.
 *
 * The action name is resolved through PANEL_ADMIN_ACTIONS, so an unknown name is a
 * bare 404 and never reaches the core - the allow-list is the boundary, and there is
 * no path that forwards a caller-supplied core path.
 *
 * The body is completed by `buildPanelAdminParams` (scope, defaults, and the one
 * composed read-then-write) and then forwarded as the core's own parameters. The
 * core still validates its own schema: this side only supplies values the panel has
 * no way to know, and it never guesses a value the core would reject.
 *
 * Write actions are recorded on the plugin log so a surprising change can be traced
 * to the panel, the action and the moment. Reads are not logged: a log full of reads
 * hides the writes, which are the only entries worth keeping.
 */
async function handlePanelAdminRequest(req, res, { config, logger }) {
  let url
  try {
    url = new URL(typeof req.url === 'string' ? req.url : '', 'http://127.0.0.1')
  } catch {
    url = null
  }
  const action = url && url.pathname.startsWith(PANEL_ADMIN_PREFIX)
    ? url.pathname.slice(PANEL_ADMIN_PREFIX.length)
    : ''
  if (!action || !Object.prototype.hasOwnProperty.call(PANEL_ADMIN_ACTIONS, action)) {
    // Unlisted action: a bare 404 with no body, matching the rest of this prefix.
    res.writeHead(404, {})
    res.end()
    return
  }
  const target = PANEL_ADMIN_ACTIONS[action]
  if (req.method !== 'POST') {
    panelJson(res, 405, { ok: false, error: '该端点只接受 POST 请求。' })
    return
  }
  const admin = readPanelAdminClient(config)
  if (!admin) {
    panelJson(res, 200, {
      ok: false,
      action,
      admin: { available: false },
      error: '管理凭据不可用：未找到 admin-client.json。管理与导出导入需要管理员凭据。',
    })
    return
  }
  const read = await readPanelAdminBody(req)
  if (read.tooLarge) {
    panelJson(res, 200, { ok: false, action, error: '请求体超过 64 KB 上限。' })
    return
  }
  if (read.invalid) {
    panelJson(res, 200, { ok: false, action, error: '请求体必须是合法的 JSON 对象。' })
    return
  }
  try {
    if (PANEL_ADMIN_WRITES.has(action)) {
      logger.info('panel.admin_write', { action, target })
    }
    const params = await buildPanelAdminParams(action, read.body, config, admin)
    const payload = await admin.post(target, params)
    panelJson(res, 200, { ok: true, action, target, data: payload })
  } catch (error) {
    // Same treatment as the data routes: status stays 200, the reason is sanitized,
    // and neither the credential nor raw server text travels with it.
    const reason = panelReason(error, undefined)
    /**
     * When the core's review gate is what refused, the panel also says what to do about it.
     *
     * The gate is the core's decision and nothing here overrides it — the code is read
     * only to attach the instruction a person needs beside the core's own sentence (which
     * travels inside `reason` as its `Detail:` text). A refusal with no guidance is how
     * "the button does nothing" gets reported as a bug in the wrong component.
     */
    panelJson(res, 200, {
      ok: false, action, target, error: reason,
      ...(error && error.code === 'classification_confirmation_required'
        ? {
            requiresConfirmation: true,
            guidance: '该候选的判定不授权一键采纳（核心给出的原因见 error）。请在候选审阅里打开它，人工选定类别与作用域后再采纳；'
              + '管理界面在人工确认后会用 classificationAcknowledged: true 重试同一请求。',
          }
        : {}),
    })
  }
}

/**
 * `GET /amb/summary`.
 *
 * Every field has a real source, and the two whose semantics need stating are stated
 * here rather than quietly relabelled:
 *
 *   - `counts.knowledge` is `/v1/stats`'s `entries`: every currently effective entry
 *     in the shared library. The core does not filter that number by project, while
 *     the `knowledge` list below is scoped to the credential's own project, so on a
 *     library holding several projects the count is the larger one. That is the
 *     number the core reports; nothing here recomputes or approximates it.
 *   - `counts.pendingProposals` is `/v1/stats`'s `pendingProposals`, and
 *     `counts.outbox.{pending,failed,abandoned}` are `/v1/stats`'s `outbox` counters:
 *     exact fields, unchanged. They come from `/v1/stats` rather than
 *     `/v1/outbox/list` deliberately - listing the queue is admin-only, because the
 *     core keeps undelivered text for the human, so an adapter credential asking for
 *     it would be refused.
 *
 * `revision` is `/v1/stats`'s `knowledgeRevision`. The list comes from
 * `/v1/knowledge/search-universal` with `literal: true`, which keeps it a pure
 * synchronous full-text lookup inside the core; without that flag a non-empty query
 * may be routed through model selection, which a read-only panel has no reason to
 * trigger.
 *
 * Three grouped views are built on top of the same two calls, and each is explicit
 * about what it could not read:
 *
 *   - `facets` is one page per knowledge category, fetched from the core by `kind`,
 *     so each group's `total` is what the credential can actually see of that
 *     category rather than a count inferred from one mixed page. A category the core
 *     refuses is reported as its own failed group - empty entries, null total, and
 *     the sanitized reason - while the rest of the summary still answers, so one bad
 *     category cannot blank the panel.
 *   - `tasks` is `/v1/tasks/list`, which the core answers for an adapter credential
 *     and scopes to `projectId`. The panel groups these by `status` and labels each
 *     with the row's own `projectId`. `counts.tasks` from `/v1/stats` is a
 *     library-wide row count while this list is project-scoped, so the two are
 *     reported separately rather than forced to agree.
 *   - `proposals` carries only what an adapter credential may read. `pending` is
 *     `/v1/stats`'s `pendingProposals`; `approved` and `archived` are unreadable on
 *     this credential (`/v1/proposals/list` is admin-only), so both stay null and
 *     `reviewAvailable` is false. The panel prints "not provided" for them instead
 *     of a zero it cannot verify, and states that accepting or rejecting a candidate
 *     happens on the DSH/CLI side.
 */
async function readPanelSummary({ config, client }) {
  const core = { endpoint: config.endpoint, projectId: config.projectId }
  let stats
  try {
    stats = await client.post('/v1/stats', { projectId: config.projectId })
  } catch (error) {
    return { ok: false, core: { ...core, reachable: false }, error: panelReason(error, config.token) }
  }
  if (!isRecordValue(stats)) {
    return { ok: false, core: { ...core, reachable: true }, error: 'AMB 核心返回的概览数据不是 JSON 对象。' }
  }
  const outbox = isRecordValue(stats.outbox) ? stats.outbox : {}
  let knowledge
  try {
    knowledge = panelEntries(await client.post('/v1/knowledge/search-universal', {
      projectId: config.projectId, query: '', limit: PANEL_KNOWLEDGE_LIMIT, literal: true,
    }))
  } catch (error) {
    return { ok: false, core: { ...core, reachable: true }, error: panelReason(error, config.token) }
  }
  const facets = []
  for (const guide of KNOWLEDGE_KIND_GUIDES) {
    try {
      const payload = await client.post('/v1/knowledge/search-universal', {
        projectId: config.projectId, query: '', kind: guide.kind, limit: PANEL_KIND_FETCH_LIMIT, literal: true,
      })
      const entries = panelEntries(payload)
      facets.push({
        kind: guide.kind,
        labelKey: guide.labelKey,
        guideKey: guide.guideKey,
        total: entries.length,
        limit: PANEL_KIND_FETCH_LIMIT,
        entries,
        error: null,
      })
    } catch (error) {
      facets.push({
        kind: guide.kind,
        labelKey: guide.labelKey,
        guideKey: guide.guideKey,
        total: null,
        limit: PANEL_KIND_FETCH_LIMIT,
        entries: [],
        error: panelReason(error, config.token),
      })
    }
  }
  let tasks = null
  try {
    const payload = await client.post('/v1/tasks/list', { projectId: config.projectId })
    const rows = Array.isArray(payload?.tasks) ? payload.tasks : []
    tasks = rows.map(panelTask).filter(task => task !== null)
  } catch {
    // The task view is optional: the summary's own counts already answered, so a
    // refused task list is reported as unavailable instead of failing the endpoint.
    tasks = null
  }
  return {
    ok: true,
    core: { ...core, reachable: true },
    revision: panelCount(stats.knowledgeRevision),
    counts: {
      knowledge: panelCount(stats.entries),
      pendingProposals: panelCount(stats.pendingProposals),
      tasks: panelCount(stats.tasks),
      outbox: {
        pending: panelCount(outbox.pending),
        failed: panelCount(outbox.failed),
        abandoned: panelCount(outbox.abandoned),
      },
    },
    facets,
    tasks,
    proposals: {
      pending: panelCount(stats.pendingProposals),
      approved: null,
      archived: null,
      reviewAvailable: false,
    },
    knowledge,
  }
}

/** `GET /amb/search`: full-text lookup inside the credential's own project scope. */
async function readPanelSearch({ config, client }, query, limit) {
  const payload = await client.post('/v1/knowledge/search-universal', {
    projectId: config.projectId, query, limit, literal: true,
  })
  return { ok: true, results: panelEntries(payload) }
}

/** `GET /amb/task`: one task record, read from the core's own task activity view. */
async function readPanelTask({ config, client }, taskId) {
  let payload
  try {
    payload = await client.post('/v1/tasks/activity', { projectId: config.projectId, taskId })
  } catch (error) {
    // The core answers 404 for an id it does not hold. That is an answer, not a
    // fault: the contract reserves `task: null` for exactly this case and the panel
    // renders "no such task record" for it, so a missing record is translated here
    // instead of being reported as a failure with a retry button.
    if (error?.code === 'not_found' || error?.status === 404) return { ok: true, task: null }
    throw error
  }
  const raw = isRecordValue(payload) && isRecordValue(payload.task) ? payload.task : null
  if (!raw) return { ok: true, task: null }
  return {
    ok: true,
    task: {
      id: typeof raw.id === 'string' && raw.id ? raw.id : taskId,
      title: typeof raw.title === 'string' && raw.title ? raw.title : taskId,
      status: typeof raw.status === 'string' ? raw.status : '',
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      updatedAt: panelCount(raw.updatedAt),
    },
  }
}

/**
 * `limit` for `/amb/search`.
 *
 * Absent or empty means the panel's own page size. A value above the core's ceiling
 * is clamped rather than refused: the caller gets the largest page the core will
 * answer instead of an error it would have to guess about. Anything that is not a
 * positive integer is refused, because guessing there would silently change what was
 * asked for.
 */
function panelLimit(raw) {
  if (raw === null || raw === '') return PANEL_KNOWLEDGE_LIMIT
  if (!/^\d+$/.test(raw)) return null
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) return null
  return Math.min(value, PANEL_SEARCH_MAX_LIMIT)
}

/**
 * Dispatch the three panel data routes.
 *
 * The path is compared exactly, never as a prefix, so no crafted path can alias its
 * way onto a route it did not name, and only GET is answered: none of these routes
 * changes anything, and a write method is refused rather than treated as a read.
 * Every body is JSON with HTTP 200 even when the core is unreachable, because the
 * panel's own error state - with the reason and a retry control - is what the user
 * should see, not a status the renderer cannot describe.
 */
async function handlePanelRequest(req, res, { config, client, logger }) {
  let url
  try {
    url = new URL(typeof req.url === 'string' ? req.url : '', 'http://127.0.0.1')
  } catch {
    url = null
  }
  if (!url || !PANEL_DATA_PATHS.has(url.pathname)) {
    // Unchanged from the address routes: an unmapped /amb path is a bare 404.
    res.writeHead(404)
    res.end()
    return
  }
  if (req.method !== 'GET') {
    panelJson(res, 405, { ok: false, error: '该端点只接受 GET 请求。' })
    return
  }
  const deps = { config, client }
  try {
    if (url.pathname === '/amb/ui-url') {
      /**
       * The console address, credential included, so the panel can show the real thing.
       *
       * The panel rendered its own reduced view - three routes, a few lists - while the core
       * served a ten-tab console at /ui. That is the same split that put a four-button page in
       * front of the desktop user: two surfaces existed, and the smaller one was the one being
       * shown. Returning the address lets the panel embed the console instead of imitating it,
       * so one change reaches web, desktop and panel together.
       *
       * The credential sits in the URL fragment, which the browser never puts in a request line,
       * so it stays out of server logs. This route is already behind the panel's credential check.
       */
      /**
       * This route is the one token-bearing response under /amb, and it is worth being explicit
       * about why that is allowed here when the rest of the surface deliberately avoids it.
       *
       * The earlier revision removed `/amb/ui-url` for exactly this reason: it was the only
       * response in the prefix built from the credential, and the native panel never needed an
       * address. That conclusion was correct for a panel that drew its own view. It stops being
       * correct once the panel embeds the console, because an iframe cannot authenticate itself -
       * the address has to carry the fragment, and something has to hand the address over.
       *
       * So the exposure is narrowed rather than ignored: the reply requires a same-origin fetch
       * from the harness page (Origin must name a loopback authority), it is served only on the
       * loopback listener, and the credential still travels in the fragment so it never reaches a
       * request line or a server log. A caller that can already read /amb/summary learns nothing
       * qualitatively new; a caller without a browser Origin does not get the token at all.
       */
      const origin = String(req.headers?.origin ?? '')
      const sameOrigin = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)
      if (!sameOrigin) {
        panelJson(res, 403, { ok: false, error: '该地址只在宿主页面同源请求时提供。' })
        return
      }
      panelJson(res, 200, { url: `${String(config.endpoint).replace(/\/$/, '')}/ui#${config.token}` })
      return
    }
    if (url.pathname === '/amb/summary') {
      panelJson(res, 200, await readPanelSummary(deps))
      return
    }
    if (url.pathname === '/amb/search') {
      const query = url.searchParams.get('q')
      if (query === null || !query.trim()) {
        panelJson(res, 200, { ok: false, error: '缺少必填参数 q。' })
        return
      }
      if (query.length > PANEL_QUERY_MAX_CHARS) {
        panelJson(res, 200, { ok: false, error: `参数 q 超过 ${PANEL_QUERY_MAX_CHARS} 字符上限。` })
        return
      }
      const limit = panelLimit(url.searchParams.get('limit'))
      if (limit === null) {
        panelJson(res, 200, { ok: false, error: '参数 limit 必须是正整数。' })
        return
      }
      panelJson(res, 200, await readPanelSearch(deps, query, limit))
      return
    }
    const rawTaskId = url.searchParams.get('taskId')
    const taskId = rawTaskId === null ? '' : rawTaskId.trim()
    if (!taskId) {
      panelJson(res, 200, { ok: false, error: '缺少必填参数 taskId。' })
      return
    }
    if (taskId.length > PANEL_TASK_ID_MAX_CHARS) {
      panelJson(res, 200, { ok: false, error: `参数 taskId 超过 ${PANEL_TASK_ID_MAX_CHARS} 字符上限。` })
      return
    }
    panelJson(res, 200, await readPanelTask(deps, taskId))
  } catch (error) {
    // Reached when the core could not be asked at all, or answered in a shape this
    // adapter cannot use. The status stays 200 and the reason is sanitized: the panel
    // shows its error state, and neither the credential nor raw server text travels
    // with it.
    logger.warn('panel.request_failed', {
      path: url.pathname, failureKind: error?.kind, code: error?.code, status: error?.status,
    })
    const reachable = !(error?.kind === 'network' || error?.kind === 'transport' || error?.kind === 'timeout')
    panelJson(res, 200, {
      ok: false,
      core: { reachable, endpoint: config.endpoint, projectId: config.projectId },
      error: panelReason(error, config.token),
    })
  }
}

export async function apply(ctx) {
  const logger = createAdapterLogger()
  // Stamped at load so a later failure can be tied to a specific plugin build and
  // host, which is what makes an old log interpretable after an update.
  logger.info('adapter.load', {
    adapter: 'dsh',
    pluginVersion: PLUGIN_VERSION,
    nodeVersion: process.versions.node,
    platform: process.platform,
    logFile: logger.file,
  })

  let config
  try {
    config = await loadClientConfig()
  } catch (error) {
    // Logged and rethrown: the host reports the failure, and the log records why.
    logger.error('adapter.config_failed', { message: error instanceof Error ? error.message : 'unknown' })
    throw error
  }
  logger.info('adapter.config', {
    endpoint: config.endpoint, projectId: config.projectId, projectRoot: config.projectRoot,
  })

  // The core is a local service, but asking a user to run it by hand turns a
  // plugin into an operation; when they forget, every tool fails with no hint
  // why. Start it here instead.
  //
  // Deliberately *not* awaited. Loading a plugin must stay fast, and the core
  // takes seconds to become healthy; blocking the host's plugin load on it would
  // trade one delay for another. The first tool call waits for the core anyway,
  // so the work overlaps with whatever else the session does first.
  //
  // Failures are logged, never thrown: a core that will not start must not look
  // like a broken plugin, and the adapter's tools already report an unreachable
  // core clearly.
  const coreEntry = CORE_ENTRY_CANDIDATES.find(path => existsSync(path))
  // Tied to the plugin's lifecycle: an unloaded plugin stops waiting. A poll that
  // outlives its plugin is a leak, and in tests it surfaces as asynchronous
  // activity reported after the test ended.
  const coreAbort = new AbortController()
  ctx.effect(() => () => coreAbort.abort(), 'agent-memory-backpack: stop waiting for the core')
  void ensureCoreRunning({
    endpoint: config.endpoint, dataDir: config.dataDir,
    coreEntry: coreEntry ?? CORE_ENTRY_CANDIDATES[0], signal: coreAbort.signal,
  }).then(outcome => {
    if (outcome.reason === 'already-running') logger.debug('core.already_running', { endpoint: config.endpoint })
    else if (outcome.started) logger.info('core.started', { endpoint: config.endpoint, entry: coreEntry })
    else logger.warn('core.start_failed', { reason: outcome.reason, detail: outcome.detail ?? '' })
  }).catch(error => {
    // `ensureCoreRunning` is written not to throw; this guards a future edit and
    // keeps a rejection from surfacing as an unhandled one.
    logger.warn('core.start_failed', { reason: 'unexpected', detail: error instanceof Error ? error.message : 'unknown' })
  })

  const client = createClient(config)
  const revisions = new WeakMap()
  const checkedExecutions = new WeakMap()
  const injectedContextIds = new WeakMap()
  const warnedOutOfScope = new WeakSet()
  const sessionTasks = new Map()
  /**
   * Per-session bookkeeping, keyed by session id.
   *
   * Everything here is per *session*, not per plugin, because a DSH process can
   * serve several sessions: a shared accumulator leaked one task's files into
   * another task's handoff (the verifier's cross-task counterexample) and would
   * equally leak between sessions.
   *
   * F05 replay: `firstEntryDone` — the first-entry replay attempt has run;
   *   `degraded` — a prepare failure was observed, so the next successful prepare
   *   is the unreachable→reachable transition that triggers one controlled replay.
   * F03 handoff: `eventBuffer` — a bounded window of this session's events;
   *   `cursor` — how many buffered events a pre-step has already consumed, so each
   *   step harvests only the cohort that arrived *since* the previous step. That
   *   cohort is what segments work by task even when the host tags nothing: a
   *   task switch is followed by the new task's first events and then its first
   *   step, so old-task events are never in a new-task cohort. `touchedFiles` —
   *   files accumulated for the current task; `lastProgress` — the last progress
   *   line, reused on idle steps; `currentTaskId` — reset point for a switch;
   *   `files`/`proposals`/`notes` — last values written back, for hysteresis;
   *   `handoffKeys` — tasks whose handoff this session already injected.
   * Task linking: `submittedProposalIds`/`registeredProposalIds`.
   */
  const sessionStates = new Map()
  const getSessionState = (id) => {
    let state = sessionStates.get(id)
    if (!state) {
      state = {
        firstEntryDone: false, degraded: false,
        eventBuffer: [], cursor: 0, touchedFiles: new Set(), currentTaskId: '',
        lastProgress: '',
        files: '', proposals: '', notes: '', handoffKeys: new Set(),
        submittedProposalIds: [], registeredProposalIds: new Set(),
        recallKey: '', recallContext: '',
        businessSinceCheckpoint: false, reflectionTurn: null,
      }
      sessionStates.set(id, state)
    }
    return state
  }
  ctx.effect(() => () => client.dispose(), 'agent-memory-backpack: abort outstanding requests')

  const inProject = (owner) => {
    if (!config.projectRoot) return Boolean(owner)
    return isWithinProject(config.projectRoot, owner?.session?.header?.cwd)
  }
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (!inProject(exec.agent)) return decision
    await captureMaterial({ adapter: 'dsh', sessionId: exec.agent?.id, tool: exec.name, result,
      taskId: exec.agent?.id ? getSessionState(exec.agent.id).currentTaskId || undefined : undefined }, { config, client, logger })
    if (exec.agent?.id && !exec.name.startsWith('amb_') && !exec.name.includes('__amb__')) {
      getSessionState(exec.agent.id).businessSinceCheckpoint = true
    }
    const receipt = await captureFailure({ adapter: 'dsh', sessionId: exec.agent?.id,
      tool: exec.name, result }, { config, client, logger })
    const failure = failureCandidate({ adapter: 'dsh', projectId: config.projectId,
      sessionId: exec.agent?.id, tool: exec.name, result, secret: config.token })
    if (failure && !receipt?.duplicate) {
      const recalled = await recallKnowledge({ client, config, logger, adapter: 'dsh',
        sessionId: exec.agent.id, query: failure.discovery.match(/观察：(.*)/)?.[1] ?? exec.name, trigger: 'failure' })
      if (recalled.context) injectCurrentContext(exec.agent, recalled.context)
    }
    if (receipt && !receipt.duplicate) injectCurrentContext(exec.agent,
      `AMB 已记录工具失败事实（${receipt.state}，${receipt.id ?? receipt.key}）。请用 amb_search_universal 检索该错误的已有经验，读取相关正文；验证修复后提交包含根因、步骤和证据的经验候选。`)
    return decision
  })
  // The waterfall is reorderable; enforce its verified result again at the final guard.
  ctx.effect(() => ctx.tools.guard((exec) => {
    if (!inProject(exec.agent)) return
    const verdict = checkedExecutions.get(exec)
    return verdict?.decision === 'allow' ? undefined
      : (verdict?.reason || 'Agent Memory Backpack policy was not checked for this execution.')
  }), 'agent-memory-backpack: final execution guard')
  const warnOutOfScopeOnce = (owner) => {
    if (config.projectRoot && owner && typeof owner === 'object' && !warnedOutOfScope.has(owner)) {
      warnedOutOfScope.add(owner)
      logger.warn('adapter.out_of_scope', { projectRoot: config.projectRoot })
      console.warn('agent-memory-backpack: this DSH agent has no matching projectRoot; automatic context and gating are skipped.')
    }
  }
  const contextIdsFor = (agent) => {
    let ids = injectedContextIds.get(agent)
    if (!ids) {
      ids = new Set()
      injectedContextIds.set(agent, ids)
    }
    return ids
  }
  const injectCurrentContext = (agent, context) => {
    if (!context.trim() || typeof agent?.inject !== 'function') return
    const message = knowledgeMessage(context)
    contextIdsFor(agent).add(message.id)
    agent.inject(message)
  }

  /**
   * File this session's task diary the moment the host says the turn is over.
   *
   * The core's convergence rule is the slow path: it waits for a task to sit idle
   * and the deployed core may not run its periodic pass at all. A real library
   * showed the cost — 19 tasks whose turn-end event had already been recorded were
   * still `in_progress`, because the signal arrived before the core could converge
   * on it. The host knows the turn ended *now*, so it asks the core to file the
   * diary immediately rather than waiting for a clock.
   *
   * `/v1/tasks/archive` is idempotent by construction: an unchanged diary writes
   * nothing and answers `unchanged: true`. The per-session set below means one
   * session asks at most once per task, and a failed attempt releases its claim so
   * the next turn retries it. Every failure is logged and swallowed — an archive is
   * bookkeeping, and a turn that has already ended must not fail because bookkeeping
   * did.
   */
  const archivedTasks = new Map()
  const archiveSessionTask = (agent, rawTaskId) => {
    const taskId = typeof rawTaskId === 'string' ? rawTaskId.trim() : ''
    if (!taskId) return
    const seen = archivedTasks.get(agent.id) ?? new Set()
    if (seen.has(taskId)) return
    // The claim is taken before the request, not after it. A second stop arriving
    // while the first archive is still in flight would otherwise ask again: the
    // core would answer `unchanged`, but this adapter's own "once per session and
    // task" would have been false exactly when the core is slow.
    seen.add(taskId)
    archivedTasks.set(agent.id, seen)
    // No request signal on purpose: at this boundary the turn's own signal may
    // already be aborted, and an archive cancelled for that reason would have
    // nothing left to retry it.
    void client.post('/v1/tasks/archive', { projectId: config.projectId, taskId, distill: config.autoDistill !== false }).then(receipt => {
      logger.info('task.archived', { adapter: 'dsh', sessionId: agent.id, taskId,
        knowledgeId: receipt?.knowledgeId, revision: receipt?.revision, unchanged: receipt?.unchanged,
        // The turn boundary is where a candidate becomes visible; logging the pass is what makes
        // "it ran and found nothing" distinguishable from "it never ran".
        distilled: receipt?.distilled })
    }).catch(error => {
      // A failed attempt must stay retryable, so the claim is released instead of
      // being remembered as done.
      seen.delete(taskId)
      if (client.isDisposed() || isCancelledClientError(error)) return
      logger.warn('task.archive_failed', { adapter: 'dsh', sessionId: agent.id, taskId,
        failureKind: error?.kind, code: error?.code, status: error?.status,
        message: error instanceof Error ? error.message : String(error) })
    })
  }

  // Verified against dsh-agent-loop: this serial hook runs only at a natural
  // stop boundary. steer() schedules one more step; an aborted user turn never
  // reaches it. At most one reflection request per turn, never an endless gate.
  ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
    if (signal?.aborted || !inProject(agent)) return
    const state = getSessionState(agent.id)
    // The end of the turn is the host's own knowledge that this session stopped;
    // it is what makes the archive immediate instead of idle-based.
    archiveSessionTask(agent, sessionTasks.get(agent.id) ?? state.currentTaskId)
    if (!config.autoReflect || typeof agent?.steer !== 'function') return
    if (!state.businessSinceCheckpoint || state.reflectionTurn === turn) return
    state.reflectionTurn = turn
    state.businessSinceCheckpoint = false
    logger.info('reflection.requested', { adapter: 'dsh', sessionId: agent.id, turn })
    agent.steer(knowledgeMessage('AMB 收尾记录：本轮执行了业务工具。请调用 amb_checkpoint_task 保存实际进展、未完成项与验证证据；若有经过验证的可复用经验，再用 amb_submit_experience 提交候选并说明所属流程和步骤。没有新经验就明确无新增经验，不要编造。回合结束不表示任务完成；尚未验证时用 paused 或 in_progress。保存后报告回执。此收尾请求每轮最多一次。'))
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!inProject(payload.agent)) {
      warnOutOfScopeOnce(payload.agent)
      return decision
    }
    if (decision.kind !== 'enter' || payload.messages.length === 0) return decision

    const currentSessionId = payload?.agent?.id
    /**
     * The session's replay bookkeeping, created on first sight.
     *
     * F05: the old flag was set on first entry and never cleared, so a session
     * that queued work while the core was down never replayed after recovery —
     * B's 21 items only cleared when a brand-new session C started. Two failure
     * modes had to be avoided at once: never replaying again (the original bug),
     * and replaying on every turn (a naive re-arm, which turns a gated action into
     * an unbounded retry loop). The schedule is:
     *   - the first entry of a session attempts one replay, so a session that
     *     starts with a backlog clears it immediately;
     *   - after that, a replay runs only on the unreachable→reachable transition:
     *     a failed prepare marks the session degraded, and the first successful
     *     prepare afterwards runs one controlled replay;
     *   - once a replay has reached the core the session rests, and only a fresh
     *     failure makes the next recovery eligible again.
     */
    const sessionState = getSessionState(currentSessionId)
    const sessionReplayState = sessionState
    const sessionLastWritten = sessionState
    const REPLAY_ONCE = async (trigger) => {
      try {
        const replayRes = await client.post('/v1/outbox/replay', {
          projectId: config.projectId,
        }, { signal: payload.signal })
        logger.info('outbox.replay', {
          sessionId: currentSessionId, trigger,
          attempted: replayRes?.attempted ?? 0,
          delivered: Array.isArray(replayRes?.delivered) ? replayRes.delivered : [],
          failed: Array.isArray(replayRes?.failed) ? replayRes.failed : [],
          abandoned: Array.isArray(replayRes?.abandoned) ? replayRes.abandoned : [],
        })
      } catch (replayError) {
        if (isCancelledClientError(replayError)) throw replayError
        logger.warn('outbox.replay_failed', {
          sessionId: currentSessionId, trigger,
          failureKind: replayError?.kind, code: replayError?.code, status: replayError?.status,
          message: replayError instanceof Error ? replayError.message : String(replayError),
        })
      }
      try {
        const spoolOutcome = await spoolReplay(config.dataDir, client, logger)
        await replayMaterials({ config, client, logger })
        if (spoolOutcome.replayed > 0 || spoolOutcome.rejected > 0) {
          // Logged by category, never by payload: a replayed item was delivered, a
          // rejected one was refused permanently and dropped.
          logger.info('spool.replay', {
            sessionId: currentSessionId, trigger,
            replayed: spoolOutcome.replayed, rejected: spoolOutcome.rejected ?? 0, remaining: spoolOutcome.remaining,
          })
        }
      } catch (spoolError) {
        logger.warn('spool.replay_failed', {
          sessionId: currentSessionId, trigger,
          message: spoolError instanceof Error ? spoolError.message : String(spoolError),
        })
      }
    }
    if (currentSessionId && !sessionReplayState.firstEntryDone) {
      // First entry: one attempt. A failure leaves the session eligible for the
      // recovery transition below once the core is back.
      sessionReplayState.firstEntryDone = true
      await REPLAY_ONCE('session-first-entry')
    }
    // Local files this session actually touched, so the handoff names them
    // instead of leaving `files` empty. Cleared after each injection so the same
    // names are not re-reported on every step.
    let touchedFiles = []
    let pendingLocalCount = 0
    // Surface the local queue so a caller can tell "nothing to send" from
    // "cannot send right now" without reading the spool file by hand.
    try {
      pendingLocalCount = loadSpool(config.dataDir).length
      if (pendingLocalCount > 0) logger.info('spool.pending', { sessionId: currentSessionId, pending: pendingLocalCount })
    } catch { /* the count is advisory; never let it break the step */ }

    const contextIds = contextIdsFor(payload.agent)
    const userMessages = payload.messages.filter((message) => {
      if (contextIds.has(message.id)) {
        contextIds.delete(message.id)
        return false
      }
      return message.role === 'user' && message.source?.kind !== 'agent-memory-backpack'
    })
    if (userMessages.length === 0) return decision

    const userQuery = textOfMessage(userMessages.at(-1)).slice(0, 4_000)
    let query = isContinuationQuery(userQuery) ? (sessionState.lastMeaningfulQuery || '') : userQuery
    if (query && !isContinuationQuery(userQuery)) sessionState.lastMeaningfulQuery = query
    let rawTaskId = payload?.agent?.session?.header?.taskId
      ?? payload?.agent?.session?.header?.task_id
      ?? payload?.agent?.session?.taskId
      ?? payload?.agent?.session?.task_id
      ?? payload?.agent?.taskId
      ?? payload?.taskId
      ?? (payload?.agent?.id ? sessionTasks.get(payload.agent.id) : undefined)

    const isContinuation = isContinuationQuery(userQuery) || /继续|接续|恢复.*任务|继续.*工作|接上次|接着上次|resume.*task|continue.*task/i.test(userQuery)
    let handoffContext = ''
    if (rawTaskId || isContinuation) {
      try {
        const listRes = await client.post('/v1/tasks/list', { projectId: config.projectId }, { signal: payload.signal })
        const tasks = Array.isArray(listRes?.tasks) ? listRes.tasks : []
        let targetTask = rawTaskId ? tasks.find(t => t.id === rawTaskId) : undefined
        if (!targetTask && isContinuation) {
          // A shared library has many unrelated projects. A bare "continue" may
          // resume only a task already linked to this session.
          const candidates = tasks.filter(t => (t.status === 'in_progress' || t.status === 'paused')
            && (config.projectRoot || (Array.isArray(t.sessionIds) && t.sessionIds.includes(currentSessionId))))
          targetTask = candidates[0]
        }
        if (targetTask) {
          if (!query && !isContinuationQuery(targetTask.title)) query = [targetTask.title, targetTask.summary].filter(Boolean).join(' ').slice(0, 4000)
          rawTaskId = targetTask.id
          if (payload?.agent?.id) sessionTasks.set(payload.agent.id, targetTask.id)
          /**
           * Harvest the cohort of events that arrived since the previous step.
           *
           * F03: the task recorded no files and no progress, so a handoff could only
           * say "check the files" with an empty list, and the next model had to
           * re-read the disk. The session's own event stream recovers the files it
           * touched, but *which* of those belong to this task matters: the real host
           * tags nothing, so the boundary between tasks is the step sequence itself.
           * Each step therefore consumes only the events buffered since its last
           * consumption; a task switch is followed by the new task's events and then
           * its first step, so an old task's calls can never appear in a new task's
           * cohort. The cursor advances to the current end of the buffer.
           */
          const cohortStart = Math.min(sessionState.cursor, sessionState.eventBuffer.length)
          const cohort = sessionState.eventBuffer.slice(cohortStart)
          sessionState.cursor = sessionState.eventBuffer.length
          // A task switch starts a fresh accumulator and a fresh progress line;
          // work already flushed to the previous task's record lives in the core.
          if (sessionState.currentTaskId && sessionState.currentTaskId !== targetTask.id) {
            sessionState.touchedFiles = new Set()
            sessionState.lastProgress = ''
            sessionState.files = ''
            sessionState.proposals = ''
            sessionState.notes = ''
          }
          sessionState.currentTaskId = targetTask.id

          // Only paths that resolve inside the project are kept, so the list is a
          // record rather than a guess.
          const sessionCwd = payload?.agent?.session?.header?.cwd ?? config.projectRoot ?? process.cwd()
          const harvested = harvestSessionFiles(cohort, sessionCwd)
          for (const file of harvested) sessionState.touchedFiles.add(file)
          touchedFiles = [...sessionState.touchedFiles]
          // Progress is this cohort's last tool output, carried forward on a step
          // that produced no new output. It travels as the session's account, never
          // as a core-verified fact.
          const cohortProgress = lastSessionProgress(cohort)
          if (cohortProgress) sessionState.lastProgress = cohortProgress
          const progress = sessionState.lastProgress

          const recordedFiles = Array.isArray(targetTask.files) ? targetTask.files : []
          const recordedProposals = Array.isArray(targetTask.relatedProposals) ? targetTask.relatedProposals : []
          const mergedFiles = [...new Set([...recordedFiles, ...touchedFiles])].slice(0, 100)
          const recordedUnfinished = Array.isArray(targetTask.unfinished) ? targetTask.unfinished : []

          const handoff = await client.post('/v1/tasks/handoff', {
            projectId: config.projectId, taskId: targetTask.id,
          }, { signal: payload.signal })

          /**
           * Recover the candidates this session submitted, and bind them to the task.
           *
           * The submission receipt carries a proposal id, and the local record of it
           * lives here; linking it is what lets a later handoff say which candidates
           * this task produced, instead of the task showing no proposals. A candidate
           * submitted while the core was unreachable has no server id yet and is
           * reported from the local spool instead. Registration is tracked so a
           * repeated pre-step cannot re-append the same id.
           */
          const newProposals = sessionState.submittedProposalIds.filter(id => !sessionState.registeredProposalIds.has(id))
          const mergedProposals = [...new Set([...recordedProposals, ...newProposals])].slice(0, 100)
          for (const id of newProposals) sessionState.registeredProposalIds.add(id)

          /**
           * Write back this session's findings, then decide whether to inject.
           *
           * The write-back has hysteresis on purpose: the fields are only sent when
           * they actually changed since this session last wrote them. Sending them
           * unconditionally re-stamped `updatedAt` on every tool step, which made
           * the "content changed" check below fire on every step and re-inject the
           * handoff — the F03 duplication pattern. With hysteresis the first step of
           * a session may update the record; a step that learns nothing new does
           * not.
           */
          const writeFiles = mergedFiles.length > 0 && JSON.stringify(mergedFiles) !== sessionLastWritten.files
          const writeProposals = mergedProposals.length > 0 && JSON.stringify(mergedProposals) !== sessionLastWritten.proposals
          const writeNotes = Boolean(progress) && progress !== sessionLastWritten.notes
          if ((writeFiles || writeProposals || writeNotes) && payload?.agent?.id) {
            await client.post('/v1/tasks/record', {
              projectId: config.projectId,
              task: {
                ...toTaskRecord(targetTask, payload.agent.id),
                ...(writeFiles ? { files: mergedFiles } : {}),
                ...(writeProposals ? { relatedProposals: mergedProposals } : {}),
                ...(writeNotes ? { notes: [targetTask.notes, progress].filter(Boolean).join('\n').slice(0, 4000) } : {}),
              },
            }, { signal: payload.signal })
            if (writeFiles) sessionLastWritten.files = JSON.stringify(mergedFiles)
            if (writeProposals) sessionLastWritten.proposals = JSON.stringify(mergedProposals)
            if (writeNotes) sessionLastWritten.notes = progress
          }

          /**
           * Inject the handoff once per (session, task).
           *
           * F03 reported one unchanged [Task Handoff] appearing six times in a
           * session, and the verifier's counterexample showed a content-keyed gate
           * re-injecting it on every active tool step — because "the last tool
           * output" changes on every step. The receiving end needs the block at the
           * moment it picks the task up, not each time the session does something;
           * later state changes are persisted to the task record (with hysteresis,
           * see the write-back above) instead of being announced again. A different
           * task in the same session still gets its own block.
           */
          touchedFiles = []
          const seenKey = `${targetTask.id}`
          const alreadyAcked = sessionLastWritten.handoffKeys.has(seenKey)
          sessionLastWritten.handoffKeys.add(seenKey)
          const skipHandoff = alreadyAcked

          const unfinishedStr = recordedUnfinished.length
            ? recordedUnfinished.join('；')
            : '无'
          const filesStr = mergedFiles.length
            ? mergedFiles.join('；')
            : '未记录'
          const relatedWfs = Array.isArray(handoff?.workflows) && handoff.workflows.length
            ? handoff.workflows.map(w => w.id).join(', ')
            : '无'

          handoffContext = skipHandoff ? '' : [
            '[Task Handoff]',
            `Task: ${targetTask.id} "${targetTask.title}"`,
            `Status: ${targetTask.status}`,
            `Knowledge: version ${handoff?.knowledgeRevision ?? 0}`,
            `Related Workflows: ${relatedWfs}`,
            `Important: ${unfinishedStr}`,
            `Files: ${filesStr}`,
            `Progress: ${progress || targetTask.summary || '未记录'}`,
            `Candidates: ${mergedProposals.length ? mergedProposals.join('；') : (pendingLocalCount ? `${pendingLocalCount} 条候选仍在本机待发送队列（尚未送达核心）` : '未记录')}`,
            `Suggestion: ${handoff?.suggestion ?? ''}`,
            `Caveat: ${handoff?.caveat || '接收端需重新确认文件与环境状态；本交接不迁移运行中的进程、凭据或工具权限。上面的 files 只是需要核对的清单，不代表已经核对过。'}`,
          ].filter(Boolean).join('\n')

          if (!skipHandoff) injectCurrentContext(payload.agent, handoffContext)
        }
      } catch (err) {
        logger.warn('handoff.failed', { message: err instanceof Error ? err.message : 'failed to fetch handoff' })
      }
    }

    if (payload?.agent?.id && rawTaskId) {
      sessionTasks.set(payload.agent.id, String(rawTaskId))
    }
    let prepared
    try {
      prepared = assertPrepareResponse(await client.post('/v1/prepare', {
        adapter: 'dsh',
        projectId: config.projectId,
        sessionId: payload.agent.id,
        ...(rawTaskId ? { taskId: String(rawTaskId) } : {}),
        ...(query ? { query } : {}),
        // The version this session already holds, so the core can answer with the
        // pointer instead of the whole normative text on every turn. `revisions` is the
        // same map the gate path uses, and a session with no entry sends nothing —
        // which is what makes the first turn of a session get the full context.
        ...(payload.agent && revisions.has(payload.agent) ? { knowledgeRevision: revisions.get(payload.agent) } : {}),
      }, { signal: payload.signal }))
      warnedDegraded.delete(payload.agent)
      /**
       * The unreachable→reachable transition is exactly here: prepare just
       * succeeded. If a previous step failed to reach the core, run one
       * controlled replay so the session's queue is delivered without waiting for
       * a new chat (F05), and clear the degraded flag so this fires once per
       * outage rather than on every turn.
       */
      if (currentSessionId && sessionReplayState.degraded) {
        sessionReplayState.degraded = false
        await REPLAY_ONCE('core-recovered')
      }
    } catch (error) {
      if (isCancelledClientError(error)) throw error
      // Mark the session degraded so the next successful prepare is recognised as
      // the recovery transition that triggers a replay.
      if (currentSessionId) sessionReplayState.degraded = true
      const identity = { projectId: config.projectId, endpoint: config.endpoint }
      const snapshot = loadSnapshot(config.dataDir, identity)
      const { mode } = operatingMode({ coreReachable: false, snapshot })
      logger.warn('prepare.degraded', { mode, detail: snapshot?.detail ?? (error instanceof Error ? error.message : '核心不可达'), at: Date.now() })
      warnDegradedOnce(payload.agent, mode, snapshot?.detail ?? (error instanceof Error ? error.message : '核心不可达'))
      return decision
    }
    revisions.set(payload.agent, prepared.knowledgeRevision)
    const latestUser = userMessages.at(-1)
    const recallKey = `${rawTaskId ?? ''}:${latestUser?.id ?? textOfMessage(latestUser)}:${prepared.knowledgeRevision}`
    if (sessionState.recallKey !== recallKey) {
      const recalled = await recallKnowledge({ client, config, logger, adapter: 'dsh',
        sessionId: currentSessionId, query, trigger: 'task' })
      sessionState.recallKey = recallKey
      sessionState.recallContext = recalled.context
    }
    const context = [handoffContext, prepared.context.trim(), sessionState.recallContext].filter(Boolean).join('\n\n')
    if (!context) return decision
    const userIds = new Set(userMessages.map((message) => message.id))
    const index = decision.messages.findLastIndex((message) => userIds.has(message?.id))
    if (index < 0) return decision
    const messages = [...decision.messages]
    messages.splice(index + 1, 0, knowledgeMessage(context))
    logger.info('context.injected', { adapter: 'dsh', sessionId: currentSessionId,
      knowledgeRevision: prepared.knowledgeRevision, chars: context.length,
      knowledgeIds: (prepared.knowledge ?? []).map(item => item.id) })
    return { ...decision, messages }
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!inProject(exec.agent)) {
      warnOutOfScopeOnce(exec.agent)
      return next()
    }
    let gate
    try {
      gate = assertGateResponse(await client.post('/v1/gate', {
        adapter: 'dsh',
        projectId: config.projectId,
        sessionId: exec.agent.id,
        toolName: exec.name,
        ...(exec.agent && revisions.has(exec.agent) ? { knowledgeRevision: revisions.get(exec.agent) } : {}),
      }, { signal: exec.signal }))
    } catch (error) {
      if (error?.status === 426 || error?.code === 'protocol_mismatch' || error?.message?.includes('HTTP 426')) {
        checkedExecutions.set(exec, { decision: 'deny', reason: 'Agent Memory Backpack 协议版本不匹配（HTTP 426），已拒绝工具执行。' })
        return { kind: 'deny', reason: 'Agent Memory Backpack 协议版本不匹配（HTTP 426），已拒绝工具执行。' }
      }
      // The core is unreachable, which is NOT the same as "this call is denied".
      //
      // Denying here made the plugin a single point of failure: an optional
      // knowledge service, when down, blocked `read`, `grep` and everything else,
      // so a user could be locked out of their own work by a process they did not
      // know was involved. The design requires degrading visibly instead, and names
      // the modes: enforce what a snapshot still knows, and otherwise step back and
      // say so rather than halting the agent.
      const identity = { projectId: config.projectId, endpoint: config.endpoint }
      const snapshot = loadSnapshot(config.dataDir, identity)
      const { mode } = operatingMode({ coreReachable: false, snapshot })
      if (mode === 'ReadOnlySnapshot') {
        const decision = decideFromSnapshot(snapshot.record, exec.name, identity)
        if (decision === 'deny') {
          checkedExecutions.set(exec, { decision: 'deny', reason: `${exec.name} 由最近一次规则快照禁止（核心当前不可达）。` })
          return { kind: 'deny', reason: `${exec.name} 由最近一次规则快照禁止（核心当前不可达）。` }
        }
        const cmd = (exec.args && typeof exec.args === 'object' ? exec.args.command : '')
          || (typeof exec.args === 'string' ? exec.args : '')
          || (exec.arguments && typeof exec.arguments === 'object' ? exec.arguments.command : '')
        const bypass = checkShellWriteBypass(exec.name, cmd, snapshot.record?.deniedTools)
        if (bypass.denied) {
          checkedExecutions.set(exec, { decision: 'deny', reason: bypass.reason })
          return { kind: 'deny', reason: bypass.reason }
        }
        checkedExecutions.set(exec, { decision: 'allow', reason: 'snapshot allowed' })
        warnDegradedOnce(exec.agent, mode, snapshot.detail)
        return next()
      }
      // Ungoverned: nothing was ever recorded to enforce, so nothing is claimed and
      // nothing is blocked.
      checkedExecutions.set(exec, { decision: 'allow', reason: 'ungoverned' })
      warnDegradedOnce(exec.agent, mode, snapshot?.detail)
      return next()
    }
    const previousRevision = revisions.get(exec.agent)
    revisions.set(exec.agent, gate.knowledgeRevision)
    // Recorded on every successful gate so a later outage still enforces the current
    // prohibitions. A write failure only costs the snapshot its freshness; it must
    // not fail the call that is succeeding.
    const identity = { projectId: config.projectId, endpoint: config.endpoint }
    saveSnapshot(config.dataDir, {
      projectId: config.projectId,
      endpoint: config.endpoint,
      deniedTools: Array.isArray(gate.deniedTools) ? gate.deniedTools : [],
      revision: gate.knowledgeRevision,
      at: Date.now(),
    }, identity)
    if (previousRevision !== gate.knowledgeRevision) injectCurrentContext(exec.agent, gate.context)
    checkedExecutions.set(exec, gate)
    if (gate.decision === 'deny') return { kind: 'deny', reason: gate.reason || 'Blocked by Agent Memory Backpack knowledge policy.' }
    const cmd = (exec.args && typeof exec.args === 'object' ? exec.args.command : '')
      || (typeof exec.args === 'string' ? exec.args : '')
      || (exec.arguments && typeof exec.arguments === 'object' ? exec.arguments.command : '')
    const bypass = checkShellWriteBypass(exec.name, cmd, gate.deniedTools)
    if (bypass.denied) {
      checkedExecutions.set(exec, { decision: 'deny', reason: bypass.reason })
      return { kind: 'deny', reason: bypass.reason }
    }
    return next()
  })

  /**
   * Say once per session that the gate is running degraded.
   *
   * Once, not per call: a warning repeated on every tool call is noise that trains
   * the reader to ignore it, and the state does not change between calls. The
   * wording distinguishes the two degraded modes, because "policy from a snapshot"
   * and "no policy at all" call for different levels of trust.
   */
  const warnedDegraded = new WeakSet()
  const warnDegradedOnce = (agent, mode, detail) => {
    if (!agent || warnedDegraded.has(agent)) return
    warnedDegraded.add(agent)
    logger.warn('adapter.degraded', { mode, detail: detail ?? '' })
    console.warn(`agent-memory-backpack: 运行模式 ${mode} — ${detail ?? ''}`)
  }

  const registerTool = (tool) => ctx.effect(() => ctx.tools.register({
    ...tool,
    // One wrapper at the single registration point: scope check, timing and
    // failure recording all happen here, so no tool can be added without them.
    async execute(args, exec) {
      const started = Date.now()
      if (config.projectRoot && !inProject(exec?.agent)) {
        logger.warn('tool.out_of_scope', { tool: tool.name })
        throw new Error('Agent Memory Backpack knowledge tool requires the configured project context.')
      }
      try {
        const result = await tool.execute(args, exec)
        logger.info('tool.ok', { adapter: 'dsh', sessionId: exec?.agent?.id, tool: tool.name, ms: Date.now() - started,
          ...(tool.name === 'amb_submit_experience' ? { proposalId: result?.id, state: result?.state } : {}) })
        return result
      } catch (error) {
        logger.error('tool.failed', {
          tool: tool.name,
          ms: Date.now() - started,
          message: error instanceof Error ? error.message : 'unknown error',
        })
        throw error
      }
    },
  }), `agent-memory-backpack: ${tool.name}`)
  registerTool(jsonTool({
    name: 'amb_save_material',
    description: 'Save a useful external reference with its source URL and summary for later retrieval. This records external material, not an adopted rule.',
    parameters: { type: 'object', additionalProperties: false,
      properties: { id: { type: 'string' }, title: { type: 'string' }, url: { type: 'string' },
        summary: { type: 'string' }, body: { type: 'string' }, taskId: { type: 'string' } },
      required: ['id', 'title', 'url', 'summary'] },
    async execute(args, exec) {
      return await client.post('/v1/material/save', { ...args, projectId: config.projectId }, { signal: exec.signal })
    },
  }))
  registerTool(jsonTool({
    name: 'amb_checkpoint_task',
    description: 'Persist task progress, unfinished work, and a journal. Completion needs explicit verification evidence. A turn ending does not mean the task is complete. This is also the moment to audit what you used: did any entry you read or cited this turn turn out to be stale, incomplete, or contradicted by what you measured? If so, act on it before recording - amb_supersede_experience with action supplement (extend it) or supersede (replace it), or amb_retire_knowledge (take it out of service). A defect noticed and only written into the journal is a defect that stays in the library.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        taskId: { type: 'string' }, title: { type: 'string' },
        status: { type: 'string', enum: ['in_progress', 'paused', 'completed', 'failed', 'cancelled'] },
        summary: { type: 'string' }, notes: { type: 'string' },
        unfinished: { type: 'array', items: { type: 'string' } },
        verified: { type: 'string' }, evidence: { type: 'string', enum: ['unverifiable', 'self-reported', 'verifiable'] },
        evidenceRefs: evidenceReferencesSchema,
        idempotencyKey: { type: 'string' },
      },
    },
    async execute(args, exec) {
      const receipt = await client.post('/v1/tasks/checkpoint', {
        ...args, projectId: config.projectId, sessionId: exec.agent.id,
      }, { signal: exec.signal })
      if (receipt?.taskId) sessionTasks.set(exec.agent.id, receipt.taskId)
      getSessionState(exec.agent.id).businessSinceCheckpoint = false
      logger.info('journal.persisted', { adapter: 'dsh', sessionId: exec.agent.id,
        taskId: receipt.taskId, journalId: receipt.journalId, revision: receipt.revision, outcome: receipt.outcome })
      return receipt
    },
  }))
  registerTool(jsonTool({
    name: 'amb_task_activity',
    description: 'Read the current session task and persisted event, proposal and journal receipts. Use to verify what was actually saved.',
    parameters: { type: 'object', additionalProperties: false, properties: { taskId: { type: 'string' } } },
    async execute(args, exec) {
      return await client.post('/v1/tasks/activity', { projectId: config.projectId,
        sessionId: exec.agent.id, ...(args?.taskId ? { taskId: args.taskId } : {}) }, { signal: exec.signal })
    },
  }))
  registerTool(jsonTool({
    name: 'amb_prepare',
    description: 'Prepare project knowledge context before starting or changing a task. Pass the task text as `query` to retrieve the workflows, skills and memories that match it; without a query only the standing rules are returned. Read-only: it grants no permission for extra actions.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        // The tool previously advertised no inputs and ignored what it was given,
        // so a model that passed `query` silently retrieved nothing (F08). The
        // schema now matches what the core's /v1/prepare actually accepts.
        query: { type: 'string', minLength: 1, maxLength: 4000 },
        taskId: { type: 'string', minLength: 1, maxLength: 120 },
      },
    },
    async execute(args, exec) {
      const result = assertPrepareResponse(await client.post('/v1/prepare', {
        adapter: 'dsh', projectId: config.projectId,
        ...(exec.agent ? { sessionId: exec.agent.id } : {}),
        ...(typeof args?.query === 'string' && args.query.trim() ? { query: args.query.trim() } : {}),
        // The session's own task is the default; an explicit taskId overrides it,
        // which is how a caller asks about a task other than the current one.
        ...(typeof args?.taskId === 'string' && args.taskId.trim() ? { taskId: args.taskId.trim() } : {}),
      }, { signal: exec.signal }))
      if (exec.agent) revisions.set(exec.agent, result.knowledgeRevision)
      return result
    },
  }))

  registerTool(jsonTool({
    name: 'amb_search_workflows',
    description: 'Search project workflows and return their complete entry points.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { query: { type: 'string', minLength: 1 } }, required: ['query'],
    },
    async execute(args, exec) {
      const query = requireString(args?.query, 'query')
      return await client.post('/v1/search', { projectId: config.projectId, query }, { signal: exec.signal })
    },
  }))

  registerTool(jsonTool({
    name: 'amb_search_universal',
    description: 'Search knowledge by query, kind and scope. Supply taskId for task memories. Results are excerpts, not complete procedures. Follow page.nextOffset with the same query and knowledgeRevision; read relevant entries, relations and conditions before stopping. coverage.missingTerms are lexical clues, not proof that knowledge is absent.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        literal: { type: 'boolean', description: 'Literal full-text search; bypass model relevance selection.' },
        query: { type: 'string' },
        kind: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        scope: { type: 'string', enum: ['global', 'project', 'task'] },
        taskId: { type: 'string', minLength: 1, maxLength: 120 },
        offset: { type: 'integer', minimum: 0, maximum: 100000 },
        knowledgeRevision: { type: 'integer', minimum: 0 },
        searchSnapshot: { type: 'string', maxLength: 64 },
        includeSources: { type: 'boolean', description: 'Include archived originals for provenance review.' },
      },
    },
    async execute(args, exec) {
      return await client.post('/v1/knowledge/search-universal', {
        projectId: config.projectId,
        query: typeof args?.query === 'string' ? args.query : '',
        ...(args?.kind ? { kind: String(args.kind) } : {}),
        ...(typeof args?.literal==='boolean' ? { literal:args.literal } : {}),
        ...(Number.isInteger(args?.limit) ? { limit: args.limit } : {}),
        ...(typeof args?.scope === 'string' ? { scope: args.scope } : {}),
        ...(typeof args?.taskId === 'string' ? { taskId: args.taskId } : {}),
        ...(Number.isInteger(args?.offset) ? { offset: args.offset } : {}),
        ...(Number.isInteger(args?.knowledgeRevision) ? { knowledgeRevision: args.knowledgeRevision } : {}),
        ...(typeof args?.searchSnapshot === 'string' ? { searchSnapshot: args.searchSnapshot } : {}),
        ...(typeof args?.includeSources === 'boolean' ? { includeSources: args.includeSources } : {}),
      }, { signal: exec.signal })
    },
  }))

  registerTool(jsonTool({
    name: 'amb_read_stage',
    description: 'Read one workflow stage and its dependency completeness information.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        workflowId: { type: 'string', minLength: 1 },
        stageId: { type: 'string', minLength: 1 },
      }, required: ['workflowId', 'stageId'],
    },
    async execute(args, exec) {
      return await client.post('/v1/expand', {
        projectId: config.projectId,
        workflowId: requireString(args?.workflowId, 'workflowId'),
        stageId: requireString(args?.stageId, 'stageId'),
      }, { signal: exec.signal })
    },
  }))

  registerTool(jsonTool({
    name: 'amb_read_knowledge',
    // 与 src/mcp.ts 的同名工具保持一致：长条目默认分块，回执带总块数、目录与未读数量。
    // 两处必须一起改 —— 只改一处，问题会换条链路复发。
    description: 'Read one entry by the id shown in the prepare summary. Long entries come back in CHUNKS by default: the reply carries chunk.totalChunks, chunk.outline (every chunk heading) and an advisory naming how many chunks remain. Continue with chunkIndex, or pass query to get only the passages relevant to a question. includeLeaves also reads the reference documents a skill carries. full=true returns everything and is rarely what you want.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        knowledgeId: { type: 'string', minLength: 1 },
        includeLeaves: { type: 'boolean' },
        query: { type: 'string', maxLength: 4000 },
        chunkIndex: { type: 'integer', minimum: 0 },
        startLine: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 1 },
        full: { type: 'boolean' },
        taskId: { type: 'string', minLength: 1, maxLength: 120 },
        passageOffset: { type: 'integer', minimum: 0 },
      }, required: ['knowledgeId'],
    },
    async execute(args, exec) {
      return await client.post('/v1/knowledge/read', {
        projectId: config.projectId,
        knowledgeId: requireString(args?.knowledgeId, 'knowledgeId'),
        includeLeaves: args?.includeLeaves === true,
        ...(typeof args?.query === 'string' && args.query.trim() ? { query: args.query } : {}),
        ...(Number.isInteger(args?.chunkIndex) ? { chunkIndex: args.chunkIndex } : {}),
        ...(Number.isInteger(args?.startLine) ? { startLine: args.startLine } : {}),
        ...(Number.isInteger(args?.endLine) ? { endLine: args.endLine } : {}),
        ...(args?.full === true ? { full: true } : {}),
        ...(typeof args?.taskId === 'string' ? { taskId: args.taskId } : {}),
        ...(Number.isInteger(args?.passageOffset) ? { passageOffset: args.passageOffset } : {}),
      }, { signal: exec.signal })
    },
  }))

  registerTool(jsonTool({
    name: 'amb_supersede_experience',
    description: 'After verifying in practice, replace or supplement an earlier experience. Both actions keep the earlier revision in history; a reason and evidence are required.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        oldId: { type: 'string', minLength: 1 },
        newId: { type: 'string', minLength: 1 },
        action: { type: 'string', enum: ['supersede', 'supplement'] },
        reason: { type: 'string', minLength: 1, maxLength: 500 },
        evidence: { type: 'string', minLength: 1, maxLength: 2_000 },
      }, required: ['oldId', 'newId', 'reason', 'evidence'],
    },
    async execute(args, exec) {
      const action = args?.action === 'supplement' ? 'supplement' : 'supersede'
      const result = await client.post('/v1/knowledge/supersede', {
        projectId: config.projectId,
        oldId: requireString(args?.oldId, 'oldId'),
        newId: requireString(args?.newId, 'newId'),
        action,
        reason: requireString(args?.reason, 'reason'),
        evidence: requireString(args?.evidence, 'evidence'),
      }, { signal: exec.signal })
      return assertSupersedeResponse(result)
    },
  }))

  registerTool(jsonTool({
    name: 'amb_retire_knowledge',
    description: 'Take an entry out of service after using it revealed that it is wrong or obsolete. Reversible: the entry and every revision stay, and it can be reopened. Use amb_supersede_experience instead when the right fix is to replace or extend the entry - retire is for entries that should stop being injected at all.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1 },
        baseRevision: { type: 'number', minimum: 0 },
        reason: { type: 'string', minLength: 1, maxLength: 500 },
      }, required: ['id', 'baseRevision', 'reason'],
    },
    async execute(args, exec) {
      return await client.post('/v1/knowledge/retire', {
        projectId: config.projectId,
        id: requireString(args?.id, 'id'),
        baseRevision: Number(args?.baseRevision),
        reason: requireString(args?.reason, 'reason'),
      }, { signal: exec.signal })
    },
  }))

  registerTool(jsonTool({
    name: 'amb_knowledge_history',
    description: 'Read the revision lineage of one knowledge entry: which versions exist and what replaced or supplemented what.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { knowledgeId: { type: 'string', minLength: 1 } },
      required: ['knowledgeId'],
    },
    async execute(args, exec) {
      return await client.post('/v1/knowledge/history', {
        projectId: config.projectId,
        knowledgeId: requireString(args?.knowledgeId, 'knowledgeId'),
      }, { signal: exec.signal })
    },
  }))

  registerTool(jsonTool({
    name: 'amb_unstructured_skills',
    description: 'List adopted skills that still hold their original text and have not been structured into a workflow.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute(_args, exec) {
      return await client.post('/v1/knowledge/unstructured', { projectId: config.projectId }, { signal: exec.signal })
    },
  }))

  registerTool(jsonTool({
    name: 'amb_structure_skill',
    description: 'Convert an adopted skill into a real workflow. The structure must be authored, not inferred from the Markdown; the raw skill is retired in the same transaction and kept in history.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        skillId: { type: 'string', minLength: 1 },
        // The authored workflow is passed through as-is; the core validates it
        // against the shared schema, so the two ends cannot disagree on shape.
        workflow: { type: 'object', additionalProperties: true },
        derivedBy: { type: 'string', enum: ['user', 'agent'] },
        evidence: { type: 'string', minLength: 1, maxLength: 2_000 },
      }, required: ['skillId', 'workflow', 'evidence'],
    },
    async execute(args, exec) {
      const result = await client.post('/v1/knowledge/structure', {
        projectId: config.projectId,
        skillId: requireString(args?.skillId, 'skillId'),
        workflow: args?.workflow,
        derivedBy: args?.derivedBy === 'user' ? 'user' : 'agent',
        evidence: requireString(args?.evidence, 'evidence'),
      }, { signal: exec.signal })
      if (!isRecordValue(result) || typeof result.workflowId !== 'string' || !result.workflowId
        || !isRevision(result.knowledgeRevision)) {
        throw new Error('Agent Memory Backpack core returned an invalid structure response.')
      }
      return result
    },
  }))

  registerTool(jsonTool({
    name: 'amb_self_check',
    description: 'Report whether this plugin is working: configuration, core reachability, protocol match, log health and version. Use it to explain a failure instead of guessing. Never returns credentials.',
    parameters: EMPTY_OBJECT_INPUT,
    async execute(_args, exec) {
      const checks = []
      const pass = (id, detail) => checks.push({ id, status: 'pass', detail })
      const warn = (id, detail, hint) => checks.push({ id, status: 'warn', detail, hint })
      const fail = (id, detail, hint) => checks.push({ id, status: 'fail', detail, hint })

      // Scope: the plugin is installed but only acts inside the configured project.
      const cwd = exec?.agent?.session?.header?.cwd
      if (exec?.agent) {
        if (!config.projectRoot) pass('project-scope', '全局共享知识库模式：支持所有项目会话访问')
        else if (inProject(exec.agent)) pass('project-scope', '当前会话位于配置的项目范围内')
        else fail('project-scope', '当前会话不在配置的项目范围内，自动注入与门禁会被跳过',
          `确认会话工作目录位于 ${config.projectRoot} 之下`)
      } else {
        checks.push({ id: 'project-scope', status: 'skip', detail: '调用未附带代理上下文，无法核对范围' })
      }

      // Reachability and protocol: the two failures that make everything else moot.
      const started = Date.now()
      try {
        const health = await client.post('/v1/prepare', {
          adapter: 'dsh', projectId: config.projectId,
          ...(exec?.agent ? { sessionId: exec.agent.id } : {}),
        }, { signal: exec.signal })
        const parsed = assertPrepareResponse(health)
        pass('core-reachable', `核心回应正常（${Date.now() - started}ms）`)
        pass('protocol-match', `协议 v${parsed.protocolVersion}，运行状态 ${parsed.mode}`)
        pass('knowledge-state', `知识版本 ${parsed.knowledgeRevision}，规范 ${parsed.norms.length} 条，流程 ${parsed.workflows.length} 条`)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown'
        fail('core-reachable', `无法从核心取得上下文：${message}`,
          '确认核心仍在运行，且本插件的 endpoint 指向它')
        checks.push({ id: 'protocol-match', status: 'skip', detail: '核心不可达，无法核对协议' })
      }

      // A degraded log is reported as a warning, never as a pass: the plugin
      // still works, but claiming log health it does not have would be a lie.
      if (logger.isDegraded()) {
        warn('log-file', `日志不可写：${logger.file}`, '修复数据目录写权限；插件功能不受影响，但问题将难以追溯')
      } else {
        pass('log-file', `日志可写：${logger.file}`)
      }
      pass('version', `插件 ${PLUGIN_VERSION}，Node ${process.versions.node}，平台 ${process.platform}`)
      pass('credentials', '凭据仅在本进程内使用，不写入日志、不返回给调用方')

      const ok = !checks.some(check => check.status === 'fail')
      return {
        ok,
        checks,
        versions: { plugin: PLUGIN_VERSION, node: process.versions.node, platform: process.platform },
        note: ok
          ? '自检未发现阻塞问题。'
          : '自检发现问题，请按 hint 处理后再继续；不要凭猜测绕过。',
      }
    },
  }))

  registerTool(jsonTool({
    name: 'amb_submit_experience',
    description: 'Submit a discovered experience as a pending candidate for human review. Write a normalized description first: one claim per entry, when it applies and when it does not, the check that makes it verifiable, and evidence as pointers (commands, files, numbers) instead of pasted output. Do not put raw transcripts, tool logs or whole source files into the body - raw text competes with real entries in retrieval and spends the injection budget, so it lowers the accuracy of every later call. Keep it free of conversational framing and platform prefixes so cross-client deduplication still works.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        // Bounds mirror the core schema exactly. An earlier version allowed 256
        // arbitrary characters here while the core accepts at most 120 from a
        // restricted character set, so the tool advertised inputs the core must
        // reject. The schema is the model's contract, so it must not overstate.
        // ASCII-only on purpose. \p{L}/\p{N} is legal in JS but not in the JSON
        // Schema dialect Grok's sampler accepts, and one unsupported pattern
        // fails the entire request before any tool is called.
        idempotencyKey: { type: 'string', minLength: 1, maxLength: 120, pattern: '^[^\\s]+$' },
        discovery: { type: 'string', minLength: 1, maxLength: 12_000 },
        workflowId: { type: 'string', minLength: 1, maxLength: 120 },
        baseRevision: { type: 'integer', minimum: 1 },
        taskId: { type: 'string', minLength: 1, maxLength: 120 },
        evidence: { type: 'string', maxLength: 4000 },
        evidenceRefs: evidenceReferencesSchema,
        stageId: { type: 'string', minLength: 1, maxLength: 120 },
        memoryContext: {
          type: 'object', additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['norm', 'preference', 'memory', 'skill', 'material', 'journal'] },
            scope: { type: 'string', enum: ['global', 'project', 'task'] },
            durability: { type: 'string', enum: ['durable', 'temporary'] },
            appliesWhen: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 2000 } },
            invalidatedWhen: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 2000 } },
          },
        },
      }, required: ['idempotencyKey', 'discovery'],
    },
    async execute(args, exec) {
      const proposalPayload = {
        idempotencyKey: requireString(args?.idempotencyKey, 'idempotencyKey'),
        projectId: config.projectId,
        ...(exec.agent?.id ? { sessionId: exec.agent.id } : {}),
        ...(typeof args?.workflowId === 'string' ? { workflowId: args.workflowId } : {}),
        ...(typeof args?.stageId === 'string' ? { stageId: args.stageId } : {}),
        ...(Number.isSafeInteger(args?.baseRevision) && args.baseRevision >= 1 ? { baseRevision: args.baseRevision } : {}),
        ...(typeof args?.taskId === 'string' ? { taskId: args.taskId } : {}),
        ...(typeof args?.evidence === 'string' && args.evidence.trim() ? { evidence: args.evidence.trim() } : {}),
        ...(Array.isArray(args?.evidenceRefs) ? { evidenceRefs: args.evidenceRefs } : {}),
        ...(isRecordValue(args?.memoryContext) ? { memoryContext: args.memoryContext } : {}),
        discovery: requireString(args?.discovery, 'discovery'),
      }
      try {
        const receipt = await client.post('/v1/proposals', proposalPayload, { signal: exec.signal })
        // The core accepted the candidate itself, so the receipt can say so. The
        // distinction matters on the read side: an agent must not report
        // "已入服务器待审" from the offline branch, and the two used to be the same
        // shape of `pending`.
        const validatedReceipt = assertReceipt(receipt, 'pending')
        if (typeof validatedReceipt.id === 'string' && validatedReceipt.id && exec.agent?.id) {
          getSessionState(exec.agent.id).submittedProposalIds.push(validatedReceipt.id)
        }
        return { ...validatedReceipt, receiptSource: 'core', deliveryState: 'delivered', clientSubmissionId: proposalPayload.idempotencyKey, serverProposalId: validatedReceipt.id }
      } catch (error) {
        if (isCancelledClientError(error)) throw error
        // `http4xx` (400, 403, 409, 426), `protocol` and `cancelled` are decisions,
        // not faults: queueing one would only replay a guaranteed failure.
        if (isExplicitClientRejection(error)) {
          throw error
        }
        // Transport, timeout or 5xx failures: enqueue full payload into persistent outbox
        try {
          const enqueued = await client.post('/v1/outbox/enqueue', {
            kind: 'candidate',
            idempotencyKey: proposalPayload.idempotencyKey,
            projectId: config.projectId,
            payload: proposalPayload,
            error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
            attempts: 1,
          }, { signal: exec.signal })
          logger.info('outbox.enqueued', { kind: 'candidate', idempotencyKey: proposalPayload.idempotencyKey })
          return {
            ...assertReceipt({
              id: enqueued?.id || proposalPayload.idempotencyKey,
              state: 'pending',
              duplicate: Boolean(enqueued?.duplicate),
            }, 'pending'),
            receiptSource: 'outbox',
            deliveryState: 'queued',
            clientSubmissionId: proposalPayload.idempotencyKey,
            lastError: (error instanceof Error ? error.message : String(error)).slice(0, 400),
            note: '核心当前不可达或暂态失败：候选已进入服务器持久队列，尚未正式受理；核心恢复后重放，重放按原幂等键不会重复写入。',
          }
        } catch (enqueueErr) {
          if (isCancelledClientError(enqueueErr)) throw enqueueErr
          // When enqueue itself fails (e.g. core is completely down), do not break the host
          logger.warn('outbox.enqueue_failed', {
            kind: 'candidate',
            idempotencyKey: proposalPayload.idempotencyKey,
            failureKind: enqueueErr?.kind, code: enqueueErr?.code, status: enqueueErr?.status,
            message: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
          })
          let spooled = false
          try {
            const outcome = spoolEnqueue(config.dataDir, {
              kind: 'candidate',
              idempotencyKey: proposalPayload.idempotencyKey,
              projectId: config.projectId,
              payload: proposalPayload,
              error: (enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr)).slice(0, 2000),
              // Structured kind/code/status/reason: replay must tell a transient
              // fault (worth another attempt) from a permanent refusal (drop)
              // without parsing text.
              failure: clientFailureMeta(enqueueErr),
            })
            spooled = outcome.enqueued === true
            if (outcome.enqueued) {
              logger.info('spool.enqueued', { kind: 'candidate', idempotencyKey: proposalPayload.idempotencyKey })
            } else {
              logger.warn('spool.enqueue_refused', { kind: 'candidate', idempotencyKey: proposalPayload.idempotencyKey, reason: outcome.reason })
            }
          } catch (spoolErr) {
            logger.warn('spool.enqueue_failed', {
              kind: 'candidate',
              idempotencyKey: proposalPayload.idempotencyKey,
              message: spoolErr instanceof Error ? spoolErr.message : String(spoolErr),
            })
          }
          /**
           * The honest receipt for "the server never saw this".
           *
           * F04: this branch used to return the same `pending` as an accepted
           * candidate, so a caller (and the model reading it) could claim
           * "已入服务器待审" when nothing had been received. `receiptSource: 'local'`
           * and `deliveryState: 'queued-local'` state plainly that the candidate is
           * recorded on this machine and will be delivered after reconnection -
           * which is what the disk spool actually guarantees.
           */
          return {
            id: proposalPayload.idempotencyKey,
            state: 'pending',
            duplicate: false,
            receiptSource: 'local',
            deliveryState: spooled ? 'queued-local' : 'local-unsynced',
            clientSubmissionId: proposalPayload.idempotencyKey,
            serverProposalId: null,
            lastError: (enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr)).slice(0, 400),
            note: spooled
              ? '核心不可达：候选已保存在本机待发送队列（未送达服务器）。恢复后会自动重放；重放前不要把它当作已受理。'
              : '核心不可达且本地队列未能写入：候选仅在本次回执中保留，请立即重试提交，避免丢失。',
          }
        }
      }
    },
  }))

  registerTool(jsonTool({
    name: 'amb_inspect_archive',
    description: 'Read the manifest of a .ambpack migration archive without importing it: entry counts, export time and file list. Importing and exporting move the whole library, so they require the admin credential and are done by the human in the desktop console or the CLI.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { file: { type: 'string', minLength: 1, maxLength: 4096 } },
      required: ['file'],
    },
    async execute(args, exec) {
      return await client.post('/v1/backup/inspect', {
        projectId: config.projectId,
        file: requireString(args?.file, 'file'),
      }, { signal: exec.signal })
    },
  }))

  ctx.on('session/event', (session, event) => {
    if (config.projectRoot && !isWithinProject(config.projectRoot, session?.header?.cwd)) return
    // Retain a bounded window of THIS session's events so a later handoff can name
    // the files the session actually touched and the last thing it did (F03). The
    // buffer is per session. Task segmentation is done by the pre-step cursor (each
    // step consumes only the events since its last consumption), which works with
    // the real host's untagged events; any taskId the event does carry is kept as a
    // hint but is never required.
    if (session?.id) {
      const state = getSessionState(session.id)
      const buffer = state.eventBuffer
      buffer.push({ type: event.type, data: event.data })
      if (buffer.length > SESSION_EVENT_WINDOW) {
        buffer.shift()
        // Keep the cursor aligned so it never points past the window start.
        if (state.cursor > 0) state.cursor -= 1
      }
    }
    const kind = event.type === 'turn/end' && event.data.reason?.kind === 'aborted'
      ? 'turn_stopped'
      : event.type
    if (!['turn/start', 'turn/end', 'step/start', 'step/end', 'tool/call', 'tool/result'].includes(event.type)) return
    const summary = kind === 'turn_stopped' ? 'DSH agent turn stopped.' : `DSH ${kind}`
    const rawTaskId = event?.taskId
      ?? event?.task_id
      ?? event?.data?.taskId
      ?? event?.data?.task_id
      ?? session?.header?.taskId
      ?? session?.header?.task_id
      ?? session?.taskId
      ?? session?.task_id
      ?? session?.header?.goalId
      ?? session?.goalId
      ?? (session?.id ? sessionTasks.get(session.id) : undefined)
    const taskId = typeof rawTaskId === 'string' && rawTaskId.trim() ? rawTaskId.trim() : undefined
    const eventPayload = {
      eventId: event.type === 'turn/end' && (event.id !== undefined || event.data?.turn !== undefined)
        ? `dsh-end:${createHash('sha256').update(JSON.stringify([session.id, event.id ?? event.data.turn])).digest('hex')}`
        : randomUUID(), adapter: 'dsh', projectId: config.projectId,
      sessionId: session.id,
      ...(taskId ? { taskId } : {}),
      kind, summary,
    }
    void client.post('/v1/events', eventPayload).then(receipt => {
      if (receipt?.journalId) {
        logger.info('journal.persisted', { adapter: 'dsh', sessionId: session.id,
          taskId: receipt.taskId, journalId: receipt.journalId, revision: receipt.revision, outcome: receipt.outcome })
      }
    }).catch(async (error) => {
      // Event delivery must never break the turn, but a silent failure would
      // leave the diary incomplete with no way to find out why.
      if (client.isDisposed()) return
      if (isCancelledClientError(error)) return
      logger.error('event.delivery_failed', {
        kind, sessionId: session.id,
        failureKind: error?.kind, code: error?.code, status: error?.status,
        message: error instanceof Error ? error.message : 'unknown error',
      })
      client.warnEventFailure()

      // `http4xx` (including 426), `protocol` and `cancelled` are decisions, not
      // faults: queueing one would only replay a guaranteed failure.
      if (isExplicitClientRejection(error)) return

      // Transport, timeout or 5xx: enqueue full event into outbox
      try {
        await client.post('/v1/outbox/enqueue', {
          kind: 'event',
          idempotencyKey: eventPayload.eventId,
          projectId: config.projectId,
          payload: eventPayload,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
          attempts: 1,
        })
        logger.info('outbox.enqueued', { kind: 'event', idempotencyKey: eventPayload.eventId })
      } catch (enqueueErr) {
        // Enqueue failure must not break the turn
        logger.warn('outbox.enqueue_failed', {
          kind: 'event',
          idempotencyKey: eventPayload.eventId,
          failureKind: enqueueErr?.kind, code: enqueueErr?.code, status: enqueueErr?.status,
          message: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
        })
        try {
          const outcome = spoolEnqueue(config.dataDir, {
            kind: 'event',
            idempotencyKey: eventPayload.eventId,
            projectId: config.projectId,
            payload: eventPayload,
            error: (enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr)).slice(0, 2000),
            // Structured kind/code/status/reason: replay must tell a transient
            // fault (worth another attempt) from a permanent refusal (drop)
            // without parsing text.
            failure: clientFailureMeta(enqueueErr),
          })
          if (outcome.enqueued) {
            logger.info('spool.enqueued', { kind: 'event', idempotencyKey: eventPayload.eventId })
          } else {
            logger.warn('spool.enqueue_refused', { kind: 'event', idempotencyKey: eventPayload.eventId, reason: outcome.reason })
          }
        } catch (spoolErr) {
          logger.warn('spool.enqueue_failed', {
            kind: 'event',
            idempotencyKey: eventPayload.eventId,
            message: spoolErr instanceof Error ? spoolErr.message : String(spoolErr),
          })
        }
      }
    })
  })

  // Serve the panel's data routes to the DSH client-side tab when webServer is available.
  //
  // The earlier revision served `/amb/ui-url` and `/amb/config` from this same
  // prefix: both answered with the core endpoint, the page address and the
  // credential, so an embedded document could pick them up. The native panel
  // reads JSON only and never asked for an address (`client.js` fetches
  // `/amb/summary`, `/amb/search`, `/amb/task`), so both routes were removed with
  // the embedded page they existed for. Removing them also removes the only
  // token-bearing response this prefix ever produced; the data routes below
  // report counts, entries and one task record, and never the credential.
  ctx.inject(['webServer'], (host) => {
    if (host.webServer && typeof host.webServer.register === 'function') {
      host.webServer.register({
        kind: 'prefix',
        path: '/amb',
        handler: (req, res) => {
          if (isPanelDataRequest(req.url)) {
            // The native panel's three data routes, served from this same /amb
            // prefix so the panel's whole surface stays on one loopback route. The
            // handler reports every outcome itself, so it is not awaited here.
            void handlePanelRequest(req, res, { config, client, logger }).catch(() => {
              // handlePanelRequest answers its own failures; this only stops a
              // broken response stream from surfacing as an unhandled rejection.
            })
            return
          }
          if (typeof req.url === 'string' && req.url.startsWith(PANEL_ADMIN_PREFIX)) {
            // The management surface. Every action is allow-listed by name on this
            // side and performed with the admin credential, which the browser half
            // never receives; see handlePanelAdminRequest.
            void handlePanelAdminRequest(req, res, { config, logger }).catch(() => {
              // Same contract as above: the handler answers its own failures.
            })
            return
          }
          // An explicit, empty header set: this prefix answers 404 with no body and
          // no CORS grant, and a caller must be able to tell "no grant" from "no
          // header object at all" when it checks that boundary.
          res.writeHead(404, {})
          res.end()
        },
      })
    }
  })
}

export default { name, inject, apply }
