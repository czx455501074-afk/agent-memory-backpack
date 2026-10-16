import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { materialCandidates, captureMaterial, replayMaterials } from '../adapters/dsh/material-capture.mjs'
import { Store } from '../dist/src/store.js'
import { createCoreServer } from '../dist/src/server.js'

const base = { adapter: 'dsh', projectId: 'shared', sessionId: 'session-a', tool: 'web_fetch',
  result: { url: 'https://example.com/reference#section', title: 'Reference', text: 'Actual fetched page text. '.repeat(12) } }
test('capture is limited to structured successful page reads with actual text and source', () => {
  for (const tool of ['shell', 'exec_command', 'web_search', 'mcp__other__something', 'amb_read_knowledge'])
    assert.deepEqual(materialCandidates({ ...base, tool }), [])
  for (const result of [null, 'arbitrary output', { ...base.result, text: undefined, summary: 'search snippet' },
    { ...base.result, isError: true }, { ...base.result, status: 404 }, { ...base.result, success: false },
    { ...base.result, url: 'file:///secrets' }, { ...base.result, url: 'https://u:p@example.com' },
    { ...base.result, url: 'https://example.com?token=confidential' }])
    assert.deepEqual(materialCandidates({ ...base, result }), [])
  const [item] = materialCandidates(base)
  assert.equal(item.url, 'https://example.com/reference')
  assert.equal(item.provenance, 'external')
  assert.equal(item.body, base.result.text.trim())
  assert.equal(item.id, materialCandidates(base)[0].id)
  assert.notEqual(item.id, materialCandidates({ ...base, sessionId: 'b' })[0].id)
  const [redacted] = materialCandidates({ ...base, secret: 'private-token',
    result: { ...base.result, text: 'private-token Bearer confidential token=other-secret ' + 'a'.repeat(25000) } })
  assert.doesNotMatch(redacted.body, /private-token|confidential|other-secret/)
  assert.equal(redacted.body.length, 16000)
  assert.equal(materialCandidates({ ...base, result: { pages: Array(5).fill(base.result) } }).length, 3)
  assert.deepEqual(materialCandidates({ ...base, result: { isError: true, value: base.result } }), [])
  assert.equal(materialCandidates({ ...base, result: { value: { url: base.result.url, statusCode: 200,
    body: { kind: 'html', content: '<p>' + base.result.text + '</p>' }, truncated: false } } })[0].body, '<p>' + base.result.text + '</p>')
  assert.equal(readFileSync(new URL('../adapters/dsh/material-capture.mjs', import.meta.url), 'utf8'),
    readFileSync(new URL('../adapters/codex/scripts/material-capture.mjs', import.meta.url), 'utf8'))
})

test('core receipt proves persistence, duplicate reads do not renew 90 day material', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'amb-material-capture-'))
  const dbPath = join(dir, 'knowledge.sqlite')
  const store = new Store(dbPath)
  const token = 'isolated-material-test-credential'
  const codexToken = 'isolated-codex-material-credential'
  const server = createCoreServer(store, { protocolVersion: 1, port: 47631, clients: [
    { id: 'dsh', token, projectId: 'shared' }, { id: 'codex', token: codexToken, projectId: 'shared' }] })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); store.close(); rmSync(dir, { recursive: true, force: true }) })
  const records = []
  const logger = { info: (...args) => records.push(args), warn: (...args) => records.push(args) }
  const config = { projectId: 'shared', token }
  const client = { post: async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-amb-protocol': '1' }, body: JSON.stringify(body) })
    if (!response.ok) throw Object.assign(new Error('HTTP failure'), { status: response.status })
    return response.json()
  } }
  const before = Date.now()
  const [receipt] = await captureMaterial(base, { config, client, logger })
  assert.equal(receipt.duplicate, false)
  assert(receipt.expiresAt >= before + 90 * 86400000)
  const [duplicate] = await captureMaterial(base, { config, client, logger })
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.expiresAt, receipt.expiresAt)
  const observer = new Store(dbPath)
  try {
    const items = observer.liveMaterial('shared')
    assert.equal(items.length, 1)
    assert.equal(observer.readKnowledge('shared', receipt.id).body, base.result.text.trim())
    assert.equal(observer.liveMaterial('other-project').length, 0)
  } finally { observer.close() }
  assert(records.some(([event]) => event === 'material.captured'))
  assert.deepEqual(await captureMaterial(base, { config: { ...config, autoCaptureMaterial: false }, client, logger }), [])
  assert.deepEqual(await captureMaterial(base, { config, client: { post: async () => { throw new Error('offline secret') } }, logger }), [])
  assert(records.some(([event]) => event === 'material.capture_failed'))
  assert.doesNotMatch(JSON.stringify(records), /offline secret|Actual fetched/)
  // Run the actual Codex hook entry, not a direct call to its handler.
  const configPath = join(dir, 'codex-client.json')
  writeFileSync(configPath, JSON.stringify({ ...config, token: codexToken, endpoint: `http://127.0.0.1:${server.address().port}` }))
  const hookUrl = new URL('../adapters/codex/scripts/hook.mjs', import.meta.url)
  const { fileURLToPath } = await import('node:url')
  const exit = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(hookUrl)], {
      env: { ...process.env, AMB_CONFIG: configPath, AMB_LOG_DIR: dir }, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    child.stdout.resume()
    child.stderr.on('data', data => { stderr += data })
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Hook timed out')) }, 15000)
    child.on('error', error => { clearTimeout(timeout); reject(error) })
    child.on('close', code => { clearTimeout(timeout); resolve({ code, stderr }) })
    child.stdin.end(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'codex-material-session',
      cwd: dir, tool_name: 'web_fetch', tool_response: { ...base.result, url: 'https://example.com/codex-hook' } }))
  })
  assert.equal(exit.code, 0, exit.stderr)
  assert.equal(store.liveMaterial('shared').length, 2, 'Actual Codex PostToolUse must persist fetched page through core')
  const offlineConfig = { ...config, dataDir: dir }
  const offlinePage = { ...base, result: { ...base.result, url: 'https://example.com/offline' } }
  const offlineClient = { post: async () => { throw new Error('offline') } }
  const [queued] = await captureMaterial(offlinePage, { config: offlineConfig, client: offlineClient, logger })
  assert.equal(queued.state, 'queued_local')
  await captureMaterial(offlinePage, { config: offlineConfig, client: offlineClient, logger })
  assert.equal(readdirSync(join(dir, 'material-spool')).length, 1, 'repeated offline capture must keep one stable record')
  const spoolFile = join(dir, 'material-spool', `${queued.id}.json`)
  const payload = JSON.parse(readFileSync(spoolFile, 'utf8'))
  payload.capturedAt -= 2 * 86400000
  writeFileSync(spoolFile, JSON.stringify(payload))
  assert.deepEqual(await replayMaterials({ config: offlineConfig, client, logger }), { replayed: 1, remaining: 0 })
  const replayed = store.liveMaterial('shared').find(item => item.id === queued.id)
  assert.equal(replayed.expiresAt, payload.capturedAt + 90 * 86400000, 'offline replay must not extend original capture retention')
  assert(records.some(([event]) => event === 'material.replayed'))
  await assert.rejects(client.post('/v1/material/save', { ...payload, id: 'future-capture', capturedAt: Date.now() + 86400000 }), error => error.status === 400)
  await assert.rejects(client.post('/v1/material/save', { ...payload, id: 'expired-capture', capturedAt: Date.now() - 91 * 86400000 }), error => error.status === 400)
  const expiredPayload = { ...payload, id: 'material-auto-' + '0'.repeat(32), capturedAt: Date.now() - 8 * 86400000 }
  writeFileSync(join(dir, 'material-spool', `${expiredPayload.id}.json`), JSON.stringify(expiredPayload))
  assert.deepEqual(await replayMaterials({ config: offlineConfig, client, logger }), { replayed: 0, remaining: 0 })
  assert(records.some(([event]) => event === 'material.queue_expired'))
})
