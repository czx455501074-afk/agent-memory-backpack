import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'

const REQUEST_TIMEOUT_MS = 5_000

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function loadClientConfig(env = process.env) {
  const explicitPath = env.AMB_DSH_CONFIG?.trim() || env.AMB_CONFIG?.trim()
  const configPath = explicitPath
    ? resolve(explicitPath)
    : resolve(homedir(), '.agent-memory-backpack', 'dsh-client.json')

  let raw
  try {
    raw = JSON.parse(await readFile(configPath, 'utf8'))
  } catch (cause) {
    if (cause?.code === 'ENOENT') {
      throw new Error('Agent Memory Backpack DSH client is not configured. Set AMB_DSH_CONFIG or create ~/.agent-memory-backpack/dsh-client.json.')
    }
    throw new Error('Agent Memory Backpack client configuration could not be read or parsed.')
  }

  if (!isRecord(raw) || typeof raw.endpoint !== 'string' || typeof raw.token !== 'string'
    || !raw.token.trim() || typeof raw.projectId !== 'string' || !raw.projectId.trim()
    || typeof raw.projectRoot !== 'string' || !isAbsolute(raw.projectRoot)) {
    throw new Error('Agent Memory Backpack DSH client configuration must define endpoint, token, projectId, and an absolute projectRoot.')
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
    projectRoot: resolve(raw.projectRoot),
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
      if (cause?.name === 'TimeoutError') throw new Error('Agent Memory Backpack request timed out.')
      if (cause?.name === 'AbortError') throw cause
      throw new Error('Agent Memory Backpack core is unavailable.')
    }

    if (response.status === 426) throw new Error('Agent Memory Backpack protocol version mismatch.')
    if (!response.ok) throw new Error(`Agent Memory Backpack core returned HTTP ${response.status}.`)
    try {
      return await response.json()
    } catch {
      throw new Error('Agent Memory Backpack core returned an invalid JSON response.')
    }
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

export const isRecordValue = isRecord
