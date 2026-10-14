import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { createClient, isExplicitClientRejection, isRecordValue, isWithinProject, loadClientConfig } from './core-client.mjs'
import { createAdapterLogger } from './log.mjs'
import { ensureCoreRunning } from './ensure-core.mjs'
import { checkShellWriteBypass, decideFromSnapshot, loadSnapshot, operatingMode, saveSnapshot } from './gate-cache.mjs'
import { loadSpool, spoolEnqueue, spoolReplay } from './spool.mjs'

/** The packaged core entry point, resolved beside this adapter. */
const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url))
/**
 * Where the core entry point may live.
 *
 * Packaged: `dsh-plugin/runtime/cli.js` beside this file. A development checkout
 * has no such copy, so `dist/src/cli.js` two levels up is tried as well. Only
 * the first that exists is used; a missing entry is reported, never raised.
 */
const CORE_ENTRY_CANDIDATES = [
  join(ADAPTER_DIR, 'runtime', 'cli.js'),
  join(ADAPTER_DIR, '..', '..', 'dist', 'src', 'cli.js'),
]

export const name = 'agent-memory-backpack'
export const inject = ['tools']

/** Kept in step with package.json; asserted by the adapter tests. */
const PLUGIN_VERSION = '0.1.0-p0.1'

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
  const allowed = value.duplicate === true ? PROPOSAL_STATES : [kind]
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
        if (replayError?.name === 'AbortError') throw replayError
        logger.warn('outbox.replay_failed', {
          sessionId: currentSessionId, trigger,
          message: replayError instanceof Error ? replayError.message : String(replayError),
        })
      }
      try {
        const spoolOutcome = await spoolReplay(config.dataDir, client, logger)
        if (spoolOutcome.replayed > 0) {
          logger.info('spool.replay', { sessionId: currentSessionId, trigger, replayed: spoolOutcome.replayed, remaining: spoolOutcome.remaining })
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

    const query = userMessages.map(textOfMessage).filter(Boolean).join('\n').slice(0, 4_000)
    let rawTaskId = payload?.agent?.session?.header?.taskId
      ?? payload?.agent?.session?.header?.task_id
      ?? payload?.agent?.session?.taskId
      ?? payload?.agent?.session?.task_id
      ?? payload?.agent?.taskId
      ?? payload?.taskId
      ?? (payload?.agent?.id ? sessionTasks.get(payload.agent.id) : undefined)

    const isContinuation = /继续|接续|恢复.*任务|继续.*工作|接上次|接着上次|resume.*task|continue.*task/i.test(query)
    let handoffContext = ''
    if (rawTaskId || isContinuation) {
      try {
        const listRes = await client.post('/v1/tasks/list', { projectId: config.projectId }, { signal: payload.signal })
        const tasks = Array.isArray(listRes?.tasks) ? listRes.tasks : []
        let targetTask = rawTaskId ? tasks.find(t => t.id === rawTaskId) : undefined
        if (!targetTask && isContinuation) {
          const candidates = tasks.filter(t => t.status === 'in_progress' || t.status === 'paused')
          targetTask = candidates[0]
        }
        if (targetTask) {
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
      if (error?.name === 'AbortError') throw error
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

    const context = [handoffContext, prepared.context.trim()].filter(Boolean).join('\n\n')
    if (!context) return decision
    const userIds = new Set(userMessages.map((message) => message.id))
    const index = decision.messages.findLastIndex((message) => userIds.has(message?.id))
    if (index < 0) return decision
    const messages = [...decision.messages]
    messages.splice(index + 1, 0, knowledgeMessage(context))
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
      if (error?.message?.includes('protocol version mismatch') || error?.message?.includes('426')) {
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
        logger.debug('tool.ok', { tool: tool.name, ms: Date.now() - started })
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
    description: 'Search across all knowledge entries (skills, norms, workflows, memories, journals) by free-text query with optional kind and limit filters.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        query: { type: 'string' },
        kind: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
    },
    async execute(args, exec) {
      return await client.post('/v1/knowledge/search-universal', {
        projectId: config.projectId,
        query: typeof args?.query === 'string' ? args.query : '',
        ...(args?.kind ? { kind: String(args.kind) } : {}),
        ...(Number.isInteger(args?.limit) ? { limit: args.limit } : {}),
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
    description: 'Expand one adopted skill or memory by the id shown in the prepare summary, optionally with its reference documents.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        knowledgeId: { type: 'string', minLength: 1 },
        includeLeaves: { type: 'boolean' },
      }, required: ['knowledgeId'],
    },
    async execute(args, exec) {
      return await client.post('/v1/knowledge/read', {
        projectId: config.projectId,
        knowledgeId: requireString(args?.knowledgeId, 'knowledgeId'),
        includeLeaves: args?.includeLeaves === true,
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
    description: 'Submit a discovered experience as a pending candidate for human review. Provide verbatim discovery insight text without conversational framing or platform prefixes to preserve cross-client deduplication.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        // Bounds mirror the core schema exactly. An earlier version allowed 256
        // arbitrary characters here while the core accepts at most 120 from a
        // restricted character set, so the tool advertised inputs the core must
        // reject. The schema is the model's contract, so it must not overstate.
        idempotencyKey: { type: 'string', minLength: 1, maxLength: 120, pattern: '^[\\p{L}\\p{N}_.:-]+$' },
        discovery: { type: 'string', minLength: 1, maxLength: 12_000 },
        workflowId: { type: 'string', minLength: 1, maxLength: 120 },
        baseRevision: { type: 'integer', minimum: 1 },
        taskId: { type: 'string', minLength: 1, maxLength: 120 },
      }, required: ['idempotencyKey', 'discovery'],
    },
    async execute(args, exec) {
      const proposalPayload = {
        idempotencyKey: requireString(args?.idempotencyKey, 'idempotencyKey'),
        projectId: config.projectId,
        ...(typeof args?.workflowId === 'string' ? { workflowId: args.workflowId } : {}),
        ...(Number.isSafeInteger(args?.baseRevision) && args.baseRevision >= 1 ? { baseRevision: args.baseRevision } : {}),
        ...(typeof args?.taskId === 'string' ? { taskId: args.taskId } : {}),
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
        if (error?.name === 'AbortError') throw error
        // Deterministic 4xx rejections (400, 403, 409, 426) must not be queued
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
          if (enqueueErr?.name === 'AbortError') throw enqueueErr
          // When enqueue itself fails (e.g. core is completely down), do not break the host
          logger.warn('outbox.enqueue_failed', {
            kind: 'candidate',
            idempotencyKey: proposalPayload.idempotencyKey,
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
      eventId: randomUUID(), adapter: 'dsh', projectId: config.projectId,
      sessionId: session.id,
      ...(taskId ? { taskId } : {}),
      kind, summary,
    }
    void client.post('/v1/events', eventPayload).catch(async (error) => {
      // Event delivery must never break the turn, but a silent failure would
      // leave the diary incomplete with no way to find out why.
      if (client.isDisposed()) return
      if (error?.name === 'AbortError') return
      logger.error('event.delivery_failed', {
        kind, sessionId: session.id,
        message: error instanceof Error ? error.message : 'unknown error',
      })
      client.warnEventFailure()

      // 4xx semantic rejections should not be queued
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
          message: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
        })
        try {
          const outcome = spoolEnqueue(config.dataDir, {
            kind: 'event',
            idempotencyKey: eventPayload.eventId,
            projectId: config.projectId,
            payload: eventPayload,
            error: (enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr)).slice(0, 2000),
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

  // Serve the UI access link to the DSH client-side tab if webServer service is available
  ctx.inject(['webServer'], (host) => {
    if (host.webServer && typeof host.webServer.register === 'function') {
      host.webServer.register({
        kind: 'prefix',
        path: '/amb',
        handler: (req, res) => {
          if (req.url === '/amb/ui-url' || req.url === '/amb/config') {
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            })
            res.end(JSON.stringify({
              endpoint: config.endpoint,
              url: `${config.endpoint}/ui#${encodeURIComponent(config.token)}`,
              projectId: config.projectId,
            }))
            return
          }
          res.writeHead(404)
          res.end()
        },
      })
    }
  })
}

export default { name, inject, apply }
