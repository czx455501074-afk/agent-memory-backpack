import { createHash } from 'node:crypto'
import { spoolEnqueue } from './spool.mjs'

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
  const key = createHash('sha256').update(JSON.stringify([adapter, projectId, sessionId, name, signature])).digest('hex').slice(0, 32)
  return {
    projectId, idempotencyKey: `failure:${key}`,
    discovery: `【自动捕获的失败事实；待核实】\n所属流程：工具执行与故障恢复；步骤：记录失败、检索已有经验、验证修复。\n来源：${adapter} 会话 ${session}；工具：${name}。\n观察：${signature}${insufficient ? '\n信息不足：宿主未提供结构化错误正文或 stderr；退出码不能区分不同根因。' : ''}\n根因与修复：尚未验证；请主动检索相关经验，验证后用 amb_submit_experience 补充可复用结论。不得将本记录直接当作已采纳规范。`,
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
