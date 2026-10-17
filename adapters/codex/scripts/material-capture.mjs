import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'

const QUEUE_TTL = 7 * 86400000
const QUEUE_MAX_BYTES = 4 * 1024 * 1024
function queueDir(config) { return config.dataDir ? join(config.dataDir, 'material-spool') : null }
function queuedFiles(config) {
  const dir = queueDir(config)
  if (!dir) return []
  try { return readdirSync(dir).filter(name => /^material-auto-[a-f0-9]{32}\.json$/.test(name)).map(name => join(dir, name)) } catch { return [] }
}
function enqueueMaterial(config, payload) {
  const dir = queueDir(config)
  if (!dir) return false
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const files = queuedFiles(config)
  const file = join(dir, `${payload.id}.json`)
  if (files.includes(file)) return true
  const encoded = JSON.stringify(payload)
  if (files.length >= 128 || files.reduce((sum, path) => sum + statSync(path).size, 0) + Buffer.byteLength(encoded) > QUEUE_MAX_BYTES) return false
  try { writeFileSync(file, encoded, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); return true } catch (error) {
    if (error.code === 'EEXIST') return true
    throw error
  }
}

export async function replayMaterials({ config, client, logger }) {
  // Opt-in, same reason as failure capture: an absent setting used to mean "capture", so every
  // adapter that never configured the field submitted by default. Deciding that a page is worth
  // keeping is a judgement, and the agent that fetched it can make it.
  if (config.autoCaptureMaterial !== true) return { replayed: 0, remaining: queuedFiles(config).length }
  let replayed = 0
  for (const file of queuedFiles(config).slice(0, 5)) {
    try {
      const payload = JSON.parse(readFileSync(file, 'utf8'))
      // Never replay another credential's records or extend their capture date.
      if (payload.projectId !== config.projectId) continue
      if (!Number.isFinite(payload.capturedAt) || Date.now() - payload.capturedAt > QUEUE_TTL || payload.capturedAt > Date.now()) {
        unlinkSync(file); logger.warn('material.queue_expired', { materialId: payload.id }); continue
      }
      const receipt = await client.post('/v1/material/save', payload)
      if (typeof receipt?.id !== 'string' || !Number.isFinite(receipt?.expiresAt) || typeof receipt?.duplicate !== 'boolean') throw new Error('Invalid material receipt')
      unlinkSync(file); replayed++
      logger.info('material.replayed', { materialId: receipt.id, duplicate: receipt.duplicate, expiresAt: receipt.expiresAt })
    } catch (error) {
      if (error?.status >= 400 && error.status < 500) {
        try { unlinkSync(file) } catch {}
        logger.warn('material.replay_rejected', { status: error.status })
      } else logger.warn('material.replay_failed', {})
    }
  }
  return { replayed, remaining: queuedFiles(config).length }
}

// Only explicit page-reading tools qualify. Search snippets, shell stdout and
// generic MCP output are not page bodies and must never be inferred as such.
const PAGE_TOOLS = new Set(['web_fetch', 'webfetch', 'fetch_url', 'read_url', 'fetch_webpage', 'read_webpage', 'browser_read', 'browser.read'])
const SECRET_PARAM = /^(?:api[-_]?key|access[-_]?token|token|password|secret|cookie|signature|sig|auth)$/i
function clean(value, secret, limit) {
  let text = String(value ?? '')
  if (secret) text = text.split(secret).join('[redacted]')
  return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|ghp|gho|xox[baprs])-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|token|password|secret|cookie)\s*[=:]\s*)[^\s,;&]+/gi, '$1[redacted]')
    .slice(0, limit)
}

export function materialCandidates({ projectId, sessionId, tool, result, taskId, secret = '' }) {
  if (!sessionId || typeof tool !== 'string' || !PAGE_TOOLS.has(tool.split('__').at(-1))) return []
  if (!result || typeof result !== 'object' || result.isError || result.is_error) return []
  const value = result.value && typeof result.value === 'object' ? result.value : result
  if (value.isError || value.is_error || value.error || value.success === false) return []
  const pages = Array.isArray(value.pages) ? value.pages.slice(0, 3) : [value]
  const captures = []
  for (const page of pages) {
    if (!page || typeof page !== 'object' || page.error || page.isError || page.success === false) continue
    const status = page.statusCode ?? page.status_code ?? page.status
    if (typeof status === 'number' && (status < 200 || status >= 300)) continue
    let url
    try {
      url = new URL(page.url)
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
        || url.href.length > 2000
        || [...url.searchParams.keys()].some(key => SECRET_PARAM.test(key)) || (secret && url.href.includes(secret))) continue
      url.hash = ''
    } catch { continue }
    // Actual returned text only. Never follow URLs or execute instructions found
    // in the page, and never synthesize a body from a search result summary.
    // DSH 0.2.0-rc.2 dsh-tool-web canonical output is body:{kind,content}.
    const nestedBody = ['html', 'text'].includes(page.body?.kind) ? page.body.content : undefined
    const raw = nestedBody ?? page.body ?? page.markdown ?? page.text ?? (typeof page.content === 'string' ? page.content : undefined)
    if (typeof raw !== 'string' || raw.trim().length < 80) continue
    // Keep UTF-8 JSON below core's 64 KiB request cap even for CJK pages.
    const body = clean(raw.trim(), secret, 16000)
    const summary = body.slice(0, 1000)
    const hash = createHash('sha256').update(JSON.stringify([projectId, sessionId, url.href, body])).digest('hex').slice(0, 32)
    captures.push({ projectId, id: `material-auto-${hash}`, url: url.href,
      title: clean(page.title || url.hostname + url.pathname, secret, 300), summary, body,
      provenance: 'external', capturedAt: Date.now(), ...(taskId ? { taskId } : {}) })
  }
  return captures
}

export async function captureMaterial(options, { config, client, logger }) {
  if (config.autoCaptureMaterial !== true) return []
  await replayMaterials({ config, client, logger })
  const candidates = materialCandidates({ ...options, projectId: config.projectId, secret: config.token })
  const receipts = []
  for (const payload of candidates) {
    const fields = { adapter: options.adapter, sessionId: options.sessionId, tool: options.tool, materialId: payload.id }
    try {
      const receipt = await client.post('/v1/material/save', payload)
      if (typeof receipt?.id !== 'string' || typeof receipt?.duplicate !== 'boolean' || !Number.isFinite(receipt?.expiresAt)) throw new Error('Invalid material receipt')
      logger.info('material.captured', { ...fields, materialId: receipt.id, duplicate: receipt.duplicate, expiresAt: receipt.expiresAt })
      receipts.push(receipt)
    } catch (error) {
      logger.warn('material.capture_failed', { ...fields, ...(Number.isInteger(error?.status) ? { status: error.status } : {}) })
      if (!(error?.status >= 400 && error.status < 500)) {
        let queued = false
        try { queued = enqueueMaterial(config, payload) } catch {}
        logger[queued ? 'info' : 'warn'](queued ? 'material.queued' : 'material.queue_failed', fields)
        if (queued) receipts.push({ id: payload.id, state: 'queued_local' })
      }
    }
  }
  return receipts
}
