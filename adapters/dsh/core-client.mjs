import { homedir } from 'node:os'
import { isAbsolute, dirname, relative, resolve, sep } from 'node:path'
import { readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { resolveClientConfig } from './resolve-config.mjs'

const REQUEST_TIMEOUT_MS = 5_000

/**
 * Every failure this client raises, carrying what a caller must branch on.
 *
 * `kind` names the class of failure, `code` is the controlled machine-readable
 * reason (the core's own code when it supplies one in the accepted shape, a fixed
 * code otherwise) and `status` is the HTTP status when there was one. The message
 * is only ever a fixed template plus the status and that code: the core's
 * free-form `message` is never copied into it, because adapter errors travel into
 * logs and chat and server text may echo a payload, a path or an id.
 *
 * The kinds are a closed set, so a caller can decide exhaustively:
 *   `timeout`   - this client's own deadline passed
 *   `cancelled` - the caller (or plugin teardown) withdrew the request
 *   `network`   - fetch could not reach the core at all
 *   `transport` - the request failed in some other way before a response
 *   `protocol`  - a response arrived that this client cannot parse
 *   `http4xx`   - the core refused, including 426; retrying cannot help
 *   `http5xx`   - the core failed transiently
 *   `capacity`  - 507: the core's own outbox is full
 */
export class CoreClientError extends Error {
  constructor(message, kind, code, status, cause) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'CoreClientError'
    this.kind = kind
    this.code = code
    if (status !== undefined) this.status = status
  }
}

/** Map an HTTP status to the kind that describes it. */
function kindFromStatus(status) {
  // 507 means the core's own outbox is full: capacity, not a plain server fault.
  return status === 507 ? 'capacity' : status >= 500 ? 'http5xx' : 'http4xx'
}

/** Kinds a later attempt may still survive, and which may therefore be queued. */
const RETRYABLE_KINDS = new Set(['timeout', 'network', 'transport', 'http5xx', 'capacity'])

/**
 * Whether a failed delivery is worth queueing or replaying.
 *
 * `http4xx`, `protocol` and `cancelled` are decisions rather than faults: the core
 * refused on purpose, answered in a shape this client cannot trust, or the caller
 * withdrew the request. Queueing any of them guarantees a replay that fails the
 * same way, so they are reported instead. Errors that carry no `kind` (a foreign
 * error, or one from an older build) fall back to their status, then to their
 * message, and only an unrecognized failure is assumed retryable.
 */
export function isRetryableClientError(error) {
  if (!error) return false
  if (typeof error.kind === 'string') return RETRYABLE_KINDS.has(error.kind)
  if (error.name === 'AbortError') return false
  const status = error.status ?? error.statusCode
  if (typeof status === 'number') return status === 507 || status >= 500
  const message = error instanceof Error ? error.message : String(error)
  return !(/\bHTTP\s*4\d\d\b/.test(message) || message.includes('protocol version mismatch'))
}

/** Whether the caller (or plugin teardown) withdrew the request. */
export function isCancelledClientError(error) {
  if (!error) return false
  return error.kind === 'cancelled' || error.name === 'AbortError'
}

/**
 * Failure metadata kept with a queued item: kind, code, status, reason, at.
 *
 * `reason` is this client's own template message, never a server-supplied string,
 * so the spool file cannot become a place where a payload or a path is written.
 */
export function clientFailureMeta(error) {
  const status = Number(error?.status ?? error?.statusCode)
  const reason = String(error instanceof Error ? error.message : error ?? '').slice(0, 2000)
  const fromMessage = /\bHTTP\s*(\d{3})\b/.exec(reason)
  const meta = {
    // An error from an older build carries neither kind nor status, so its
    // `HTTP <n>` message is read instead: a legacy 4xx must still be recognised as
    // permanent by the replay logic rather than retried until the attempt cap.
    kind: typeof error?.kind === 'string' && error.kind
      ? error.kind
      : Number.isFinite(status) && status > 0 ? kindFromStatus(status)
        : fromMessage ? kindFromStatus(Number(fromMessage[1])) : 'unknown',
    at: Date.now(),
  }
  if (typeof error?.code === 'string' && error.code) meta.code = error.code
  if (Number.isFinite(status) && status > 0) meta.status = status
  else if (fromMessage) meta.status = Number(fromMessage[1])
  meta.reason = reason
  return meta
}

/** Cap on the core's message that is carried into an error. */
const MAX_SERVER_MESSAGE_CHARS = 500

/**
 * The core's own message, made safe to carry.
 *
 * The server's text is the actionable half of a refusal: it names the missing
 * dependency, the conflicting key or the field that was wrong. It is therefore
 * kept, not dropped. What is removed is anything credential-shaped - this client's
 * own token, a `Bearer` header, a `password=`/`api_key=` pair, a long base64 or hex
 * blob, and a body that is nothing but a JSON dump - because an adapter error
 * travels into logs, receipts and chat. The result is capped so a chatty core
 * cannot push the adapter's error into unbounded output.
 */
export function sanitizeServerMessage(value, token) {
  if (typeof value !== 'string') return ''
  let text = value
  if (typeof token === 'string' && token) text = text.split(token).join('[redacted]')
  text = text
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|authorization)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1$2[redacted]')
    .replace(/[A-Za-z0-9+/=_-]{40,}/g, '[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
  if (!text) return ''
  // A body that is nothing but a JSON dump is a payload echo, not guidance.
  if (/^[[{]/.test(text) && text.length > 200) return '[redacted-json]'
  return text.slice(0, MAX_SERVER_MESSAGE_CHARS)
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function loadClientConfig(env = process.env) {
  // Shared resolution: both adapters must read the same core and the same
  // database. A stale AMB_DSH_CONFIG / AMB_CONFIG now falls back to the shared
  // default with a warning, rather than failing with "not configured" and
  // leaving the user to guess which pointer went bad.
  const resolved = resolveClientConfig('dsh', env)
  if (resolved.warning) {
    console.warn(`agent-memory-backpack: ${resolved.warning}`)
  }
  const configPath = resolved.path

  let raw
  try {
    raw = JSON.parse(await readFile(configPath, 'utf8'))
  } catch (cause) {
    if (cause?.code === 'ENOENT') {
      throw new Error(`Agent Memory Backpack DSH client is not configured. Run "amb-install" or create ${configPath}.`)
    }
    throw new Error('Agent Memory Backpack client configuration could not be read or parsed.')
  }

  if (!isRecord(raw) || typeof raw.endpoint !== 'string' || typeof raw.token !== 'string'
    || !raw.token.trim() || typeof raw.projectId !== 'string' || !raw.projectId.trim()
    || (raw.projectRoot !== undefined && raw.projectRoot !== null && (typeof raw.projectRoot !== 'string' || !isAbsolute(raw.projectRoot)))) {
    throw new Error('Agent Memory Backpack DSH client configuration must define endpoint, token, and projectId.')
  }
  if (raw.autoCaptureFailures !== undefined && typeof raw.autoCaptureFailures !== 'boolean') {
    throw new Error('autoCaptureFailures must be a boolean when configured.')
  }
  if (raw.autoCaptureMaterial !== undefined && typeof raw.autoCaptureMaterial !== 'boolean') {
    throw new Error('autoCaptureMaterial must be a boolean when configured.')
  }
  if (raw.autoReflect !== undefined && typeof raw.autoReflect !== 'boolean') {
    throw new Error('autoReflect must be a boolean when configured.')
  }

  let endpoint
  try {
    endpoint = new URL(raw.endpoint)
  } catch {
    throw new Error('Agent Memory Backpack endpoint must be an HTTP URL on 127.0.0.1.')
  }
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1'
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || endpoint.pathname !== '/') {
    throw new Error('Agent Memory Backpack endpoint must be a base HTTP URL on 127.0.0.1 without credentials, path, query, or fragment.')
  }

  return Object.freeze({
    endpoint: endpoint.origin,
    token: raw.token,
    projectId: raw.projectId.trim(),
    autoCaptureFailures: raw.autoCaptureFailures !== false,
    autoCaptureMaterial: raw.autoCaptureMaterial !== false,
    autoReflect: raw.autoReflect !== false,
    projectRoot: (typeof raw.projectRoot === 'string' && raw.projectRoot.trim()) ? resolve(raw.projectRoot) : null,
    // Where the shared database lives. The adapter needs it to start a core
    // when none is running; the credential's own directory is authoritative.
    dataDir: dirname(configPath),
  })
}

export function createClient(config, fetchImpl = fetch) {
  const disposed = new AbortController()
  const warnedEvents = { value: false }

  async function post(path, body, { signal } = {}) {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const requestSignal = signal ? AbortSignal.any([signal, timeout, disposed.signal]) : AbortSignal.any([timeout, disposed.signal])
    let response
    try {
      response = await fetchImpl(`${config.endpoint}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'x-amb-protocol': '1',
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: requestSignal,
      })
    } catch (cause) {
      /**
       * Classify the failure where the cause is still visible.
       *
       * A caller cannot act on "it failed": a timeout and a caller cancellation
       * look identical once flattened, and a `TypeError` from fetch means the core
       * was never reached while any other error means it answered badly. The
       * kind/code pair is what the adapters branch on - only `timeout`, `network`
       * and `transport` faults may be queued for a later replay; the rest are
       * decisions to report. Only a timeout this client raised itself counts as
       * `timeout`: when the caller's own signal is the reason, it is `cancelled`.
       */
      const name = cause instanceof Error ? cause.name : ''
      const kind = name === 'TimeoutError' && timeout.aborted && timeout.reason === cause
        ? 'timeout'
        : (signal?.aborted || disposed.signal.aborted) ? 'cancelled'
          : cause instanceof TypeError ? 'network' : 'transport'
      const code = kind === 'timeout' ? 'request_timeout'
        : kind === 'cancelled' ? 'request_cancelled'
          : kind === 'network' ? 'network_error' : 'transport_error'
      throw new CoreClientError(
        'Agent Memory Backpack core unavailable. Governance could not be checked.',
        kind, code, undefined, cause,
      )
    }

    let result
    try {
      result = await response.json()
    } catch (cause) {
      // A body that will not parse is a protocol fault, not a transport one: the
      // core answered, but not in the shape this client was built against. The
      // status is kept so a caller can still tell a 200 with garbage from a 500.
      throw new CoreClientError(
        `Agent Memory Backpack core returned an invalid response (HTTP ${response.status}, invalid_response).`,
        'protocol', 'invalid_response', response.status, cause,
      )
    }
    if (!response.ok) {
      const status = response.status
      /**
       * Keep the core's structured code, and only the code.
       *
       * `code` is taken when it matches the controlled shape (lowercase word,
       * digits, underscores), so a buggy or hostile body cannot inject arbitrary
       * text into a log line or a model-visible error. The core's `message` is
       * deliberately not copied: it is free-form server text that may echo the
       * payload, a project id or a filesystem path, and an adapter error ends up in
       * logs and in chat. `code` plus `status` is everything a caller needs to
       * decide between fixing and retrying, and it is what the spool stores.
       */
      const structuredCode = typeof result.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(result.code)
        ? result.code : undefined
      const kind = kindFromStatus(status)
      // 507 reports the core's own outbox as full; the code names it when the core
      // sends one, and falls back to a fixed code the caller can still branch on.
      const code = structuredCode ?? (status === 507 ? 'capacity_exhausted' : status >= 500 ? 'http5xx' : 'http4xx')
      // The core's message is the actionable half of a refusal: it names the missing
      // dependency, the conflicting key or the field that was wrong. It is kept -
      // sanitized and capped - while `code` and `status` stay the fields a caller
      // branches on.
      const detail = sanitizeServerMessage(result.message, config.token)
      const err = new CoreClientError(
        `Agent Memory Backpack request rejected (HTTP ${status}, ${code}).${detail ? ` Detail: ${detail}` : ''}`,
        kind, code, status,
      )
      err.coreStatus = status
      err.retryable = isRetryableClientError(err)
      throw err
    }
    return result
  }

  return Object.freeze({
    post,
    dispose() { disposed.abort(new Error('Agent Memory Backpack DSH adapter disposed.')) },
    isDisposed() { return disposed.signal.aborted },
    warnEventFailure() {
      if (warnedEvents.value) return
      warnedEvents.value = true
      console.warn('agent-memory-backpack: Agent Memory Backpack event delivery failed; no event payload was logged.')
    },
  })
}

export function isWithinProject(projectRoot, cwd) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return false
  try {
    const rel = relative(realpathSync(projectRoot), realpathSync(cwd))
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  } catch {
    return false
  }
}

/**
 * Whether this failure is a decision the caller must act on, not a fault to queue.
 *
 * Defined as the complement of {@link isRetryableClientError} so the two can never
 * drift apart: `http4xx` (including 426), `protocol` and `cancelled` are explicit
 * rejections, and queueing one would only replay a guaranteed failure.
 */
export function isExplicitClientRejection(error) {
  if (!error) return false
  return !isRetryableClientError(error)
}

export const isRecordValue = isRecord
