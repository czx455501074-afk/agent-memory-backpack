import { createHash } from 'node:crypto'
import { spoolEnqueue } from './spool.mjs'

/**
 * Where a captured failure came from, decided from the observation text alone.
 *
 * Two agents editing one file produce a refusal the *tool* reported, not a defect in
 * the work: `old_string was not found in "…"` and `file changed since it was read`
 * mean another writer changed the file between this caller's read and its write. Host
 * accidents (a timeout, a cross-volume EPERM, EIO, a busy port, an interrupted call)
 * are the second class; everything else is a task failure.
 *
 * The three values and the rule table are the same as `src/refine.ts`, which
 * re-derives the origin for rows captured before this marker existed. The adapter
 * ships as a standalone plugin copy with no access to the compiled core, so the table
 * necessarily exists twice; `test/failure-capture.test.mjs` runs one fixture table
 * through both implementations, so drift fails the suite instead of silently filing
 * the same error under two classes depending on host.
 *
 * Why the text and not a request field: `proposalSchema` is `.strict()`, so an extra
 * key is a 400 and the capture is lost. Why the marker is not part of the signature:
 * the signature is the idempotency key input, and folding the origin into it would
 * re-capture every existing failure as a new candidate on the first run after upgrade.
 */
export const FAILURE_ORIGINS = ['tool_collision', 'environment', 'task_failure']

/**
 * Ordered, first match wins, `tool_collision` first.
 *
 * Each rule is a text form this library's queue actually contains, measured with
 * `verification/r5/replay-failure-origin.mjs`; a rule that matches nothing is visible
 * as such instead of being assumed useful. What the rule decides is narrow and stated
 * plainly: the write was refused because the file's state no longer matches what the
 * caller read (collision), or the host refused an operation for a reason that is not
 * about the content (environment). A mistyped `old_string` and a file the same agent
 * already changed fall into the collision rule as well — the accepted cost of a
 * decidable criterion, and the only consequence is "not sampled for distillation",
 * never "recorded as knowledge".
 */
const ORIGIN_RULES = [
  { origin: 'tool_collision', id: 'concurrent_edit_target_missing', matches: text => /old_string was not found in/.test(text) },
  { origin: 'tool_collision', id: 'concurrent_edit_file_changed', matches: text => /file changed since it was read/.test(text) },
  { origin: 'environment', id: 'timeout', matches: text => /\btime(?:d|s)?\s*out\b|\btimeout\b|ETIMEDOUT|超时/i.test(text) },
  { origin: 'environment', id: 'io_error', matches: text => /\bEIO\b|\bEXDEV\b|Win32 (?:1175|1176|1177)\b/.test(text) },
  { origin: 'environment', id: 'cross_volume_eperm', matches: text => /\bEPERM\b|cross-device link|跨盘符/.test(text) },
  { origin: 'environment', id: 'port_in_use', matches: text => /\bEADDRINUSE\b|address already in use|端口.{0,4}占用/i.test(text) },
  { origin: 'environment', id: 'interrupted', matches: text => /\btool call (?:was )?aborted\b|aborted before dispatch|\bEINTR\b|\bSIG(?:INT|TERM|KILL)\b|\binterrupt(?:ed|ion)\b|被中断/i.test(text) },
]

/** The line the capture writes so a reader (and `src/refine.ts`) can see the class. */
export const FAILURE_ORIGIN_MARKER = '失败来源类别：'

export function classifyFailureOrigin(observation) {
  const text = String(observation ?? '')
  const rule = ORIGIN_RULES.find(candidate => candidate.matches(text))
  return rule ? { origin: rule.origin, rule: rule.id } : { origin: 'task_failure', rule: 'default' }
}

// Host adapters call this only for a structured failed result. Never mine arbitrary
// stdout for the word "error": successful diagnostics often contain that word.
export function failureCandidate({ adapter, projectId, sessionId, tool, result, secret = '' }) {
  if (!sessionId || !tool || tool.startsWith('amb_') || tool.includes('__amb__')) return null
  if (!result || typeof result !== 'object') return null
  const value = result.value && typeof result.value === 'object' ? result.value : result
  const exit = value.exit_code ?? value.exitCode
  const failed = result.isError === true || result.is_error === true
    || value.isError === true || value.is_error === true
    || (typeof exit === 'number' && exit !== 0)
  if (!failed) return null
  const clean = input => {
    let text = String(input ?? '')
    if (secret) text = text.split(secret).join('[redacted]')
    return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[redacted]')
      .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/\b(?:sk|ghp|gho|xox[baprs])-[A-Za-z0-9_-]+/g, '[redacted]')
      .replace(/\bgh[pousr]_[A-Za-z0-9_]+/g, '[redacted]')
      .replace(/((?:api[_-]?key|access[_-]?token|token|password|secret|cookie)["']?\s*[=:]\s*["']?)[^\s"',;&]+/gi, '$1[redacted]')
      .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]')
      .replace(/[\r\n\t]+/g, ' ').slice(0, 500)
  }
  const error = result.error ?? value.error
  // Failure is already established above. stderr is evidence only after that
  // decision; success output mentioning "error" must never create candidates.
  // Read only explicit string fields, never full output, command or arguments.
  const message = clean(typeof error === 'string' ? error : error?.message)
  const rawStderr = typeof value.stderr === 'string' ? value.stderr : result.stderr
  const stderr = typeof rawStderr === 'string' ? clean(rawStderr) : ''
  const signature = stderr ? `${message ? message.slice(0, 140) + '; ' : ''}stderr: ${stderr}`.slice(0, 500)
    : message || (typeof exit === 'number' ? `exit_code=${exit}` : 'host reported isError=true')
  const insufficient = !message && !stderr
  const name = clean(tool)
  const session = clean(sessionId)
  // Classified from the same text that is stored, after redaction, so the adapter and
  // a later reader of the row are judging the same string.
  const { origin, rule } = classifyFailureOrigin(signature)
  const key = createHash('sha256').update(JSON.stringify([adapter, projectId, sessionId, name, signature])).digest('hex').slice(0, 32)
  return {
    projectId, idempotencyKey: `failure:${key}`,
    discovery: `【自动捕获的失败事实；待核实】\n所属流程：工具执行与故障恢复；步骤：记录失败、检索已有经验、验证修复。\n来源：${adapter} 会话 ${session}；工具：${name}。\n${FAILURE_ORIGIN_MARKER}${origin}；判据：${rule}。\n观察：${signature}${insufficient ? '\n信息不足：宿主未提供结构化错误正文或 stderr；退出码不能区分不同根因。' : ''}\n根因与修复：尚未验证；请主动检索相关经验，验证后用 amb_submit_experience 补充可复用结论。不得将本记录直接当作已采纳规范。`,
  }
}

export async function captureFailure(options, { config, client, logger }) {
  if (config.autoCaptureFailures === false) return null
  const candidate = failureCandidate({ ...options, projectId: config.projectId, secret: config.token })
  if (!candidate) return null
  const fields = { adapter: options.adapter, sessionId: options.sessionId, tool: options.tool, key: candidate.idempotencyKey }
  try {
    const receipt = await client.post('/v1/proposals', candidate)
    if (typeof receipt?.id !== 'string' || typeof receipt?.state !== 'string') throw new Error('Invalid failure candidate receipt')
    logger.info('experience.captured', { ...fields, proposalId: receipt.id, state: receipt.state, duplicate: receipt.duplicate === true })
    return receipt
  } catch (error) {
    // A rejected request needs correction, not replay. Keep failures observable.
    if (error?.status >= 400 && error.status < 500) {
      logger.warn('experience.rejected', { ...fields, status: error.status })
      return null
    }
    try {
      const queued = spoolEnqueue(config.dataDir, { kind: 'candidate', projectId: config.projectId,
        idempotencyKey: candidate.idempotencyKey, payload: candidate, error: 'Failure capture delivery unavailable' })
      logger[queued.enqueued ? 'info' : 'warn'](queued.enqueued ? 'experience.queued' : 'experience.queue_failed', { ...fields, reason: queued.reason })
      return queued.enqueued ? { state: 'queued_local', key: candidate.idempotencyKey } : null
    } catch {
      logger.warn('experience.queue_failed', fields)
      return null
    }
  }
}
