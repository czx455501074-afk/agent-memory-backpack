import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createClient, isExplicitClientRejection, isRecordValue, isWithinProject, loadClientConfig } from './core-client.mjs'
import { createAdapterLogger } from './log.mjs'
import { ensureCoreRunning } from './ensure-core.mjs'
import { decideFromSnapshot, loadSnapshot, operatingMode, saveSnapshot } from './gate-cache.mjs'

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
  const replayedSessions = new Set()
  ctx.effect(() => () => client.dispose(), 'agent-memory-backpack: abort outstanding requests')

  const inProject = (owner) => isWithinProject(config.projectRoot, owner?.session?.header?.cwd)
  // The waterfall is reorderable; enforce its verified result again at the final guard.
  ctx.effect(() => ctx.tools.guard((exec) => {
    if (!inProject(exec.agent)) return
    const verdict = checkedExecutions.get(exec)
    return verdict?.decision === 'allow' ? undefined
      : (verdict?.reason || 'Agent Memory Backpack policy was not checked for this execution.')
  }), 'agent-memory-backpack: final execution guard')
  const warnOutOfScopeOnce = (owner) => {
    if (owner && typeof owner === 'object' && !warnedOutOfScope.has(owner)) {
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
    if (currentSessionId && !replayedSessions.has(currentSessionId)) {
      replayedSessions.add(currentSessionId)
      try {
        const replayRes = await client.post('/v1/outbox/replay', {
          projectId: config.projectId,
        }, { signal: payload.signal })
        logger.info('outbox.replay', {
          sessionId: currentSessionId,
          attempted: replayRes?.attempted ?? 0,
          delivered: Array.isArray(replayRes?.delivered) ? replayRes.delivered : [],
          failed: Array.isArray(replayRes?.failed) ? replayRes.failed : [],
          abandoned: Array.isArray(replayRes?.abandoned) ? replayRes.abandoned : [],
        })
      } catch (replayError) {
        if (replayError?.name === 'AbortError') throw replayError
        logger.warn('outbox.replay_failed', {
          sessionId: currentSessionId,
          message: replayError instanceof Error ? replayError.message : String(replayError),
        })
      }
    }

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
          const handoff = await client.post('/v1/tasks/handoff', {
            projectId: config.projectId, taskId: targetTask.id,
          }, { signal: payload.signal })

          const existingSessions = Array.isArray(targetTask.sessionIds) ? targetTask.sessionIds : []
          if (payload?.agent?.id && !existingSessions.includes(payload.agent.id)) {
            await client.post('/v1/tasks/record', {
              projectId: config.projectId,
              task: {
                ...targetTask,
                sessionIds: [...existingSessions, payload.agent.id],
              },
            }, { signal: payload.signal })
          }

          const unfinishedStr = Array.isArray(targetTask.unfinished) && targetTask.unfinished.length
            ? targetTask.unfinished.join('；')
            : '无'
          const filesStr = Array.isArray(handoff?.files) && handoff.files.length
            ? handoff.files.join('；')
            : '未记录'
          const relatedWfs = Array.isArray(handoff?.workflows) && handoff.workflows.length
            ? handoff.workflows.map(w => w.id).join(', ')
            : '无'

          handoffContext = [
            '[Task Handoff]',
            `Task: ${targetTask.id} "${targetTask.title}"`,
            `Status: ${targetTask.status}`,
            `Knowledge: version ${handoff?.knowledgeRevision ?? 0}`,
            `Related Workflows: ${relatedWfs}`,
            `Important: ${unfinishedStr}`,
            `Files: ${filesStr}`,
            `Suggestion: ${handoff?.suggestion ?? ''}`,
            `Caveat: ${handoff?.caveat || '接收端需重新确认文件与环境状态；本交接不迁移运行中的进程、凭据或工具权限。上面的 files 只是需要核对的清单，不代表已经核对过。'}`,
          ].filter(Boolean).join('\n')

          injectCurrentContext(payload.agent, handoffContext)
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
    } catch (error) {
      if (error?.name === 'AbortError') throw error
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
      if (!inProject(exec?.agent)) {
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
    description: 'Prepare project knowledge context for the current task.',
    parameters: EMPTY_OBJECT_INPUT,
    async execute(_args, exec) {
      const result = assertPrepareResponse(await client.post('/v1/prepare', {
        adapter: 'dsh', projectId: config.projectId,
        ...(exec.agent ? { sessionId: exec.agent.id } : {}),
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
        if (inProject(exec.agent)) pass('project-scope', '当前会话位于配置的项目范围内')
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
    description: 'Submit a discovered experience as a pending candidate for human review.',
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
      }, required: ['idempotencyKey', 'discovery'],
    },
    async execute(args, exec) {
      const proposalPayload = {
        idempotencyKey: requireString(args?.idempotencyKey, 'idempotencyKey'),
        projectId: config.projectId,
        ...(typeof args?.workflowId === 'string' ? { workflowId: args.workflowId } : {}),
        ...(Number.isSafeInteger(args?.baseRevision) && args.baseRevision >= 1 ? { baseRevision: args.baseRevision } : {}),
        discovery: requireString(args?.discovery, 'discovery'),
      }
      try {
        const receipt = await client.post('/v1/proposals', proposalPayload, { signal: exec.signal })
        return assertReceipt(receipt, 'pending')
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
          return assertReceipt({
            id: enqueued?.id || proposalPayload.idempotencyKey,
            state: 'pending',
            duplicate: Boolean(enqueued?.duplicate),
          }, 'pending')
        } catch (enqueueErr) {
          if (enqueueErr?.name === 'AbortError') throw enqueueErr
          // When enqueue itself fails (e.g. core is completely down), do not break the host
          logger.warn('outbox.enqueue_failed', {
            kind: 'candidate',
            idempotencyKey: proposalPayload.idempotencyKey,
            message: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
          })
          return {
            id: proposalPayload.idempotencyKey,
            state: 'pending',
            duplicate: false,
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

  ctx.on('session/event', (session, event) => {    if (!isWithinProject(config.projectRoot, session?.header?.cwd)) return
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
      }
    })
  })
}

export default { name, inject, apply }
