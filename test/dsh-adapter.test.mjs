import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test, { after } from 'node:test'
import { inspectRuntime, isSupported, runtimeRoot, supportedRange, verifiedVersion } from './dsh-target.mjs'

// Cloned repositories have no extracted desktop runtime; skip with a reason.
const runtimeProbe = inspectRuntime()
const runtimeSkip = runtimeProbe.available ? false : runtimeProbe.reason
const adapterUrl = new URL('../adapters/dsh/index.mjs', import.meta.url)
const adapter = await import(adapterUrl.href)
const cordisUrl = pathToFileURL(resolve(runtimeRoot, '@deepseek-ai/cordis/lib/index.js'))
const { Context } = runtimeProbe.available ? await import(cordisUrl.href) : { Context: class {} }

const state = {
  requests: [],
  gateMode: 'allow',
  supersedeMode: 'ok',
  prepareMode: 'ok',
}
let server
let endpoint
let tempDir
let previousConfig
let activeFiber
let activeToolsFiber
let activeToolsAccessFiber

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  // A bodyless request is normal: the adapter probes `GET /health` before it
  // talks to the core, and an unconditional parse threw on the empty string,
  // surfacing as an unhandled rejection after the test had ended.
  if (!text.trim()) return undefined
  return JSON.parse(text)
}

async function startServer() {
  server = createServer(async (req, res) => {
    // The health probe is answered before anything else and needs no credential,
    // exactly like the real core. Without this the probe would fall through to
    // the body parse and be reported as a malformed request.
    if (req.url === '/health') return json(res, 200, { protocolVersion: 1, status: 'ok' })
    const body = await readBody(req)
    state.requests.push({
      path: req.url, body, authorization: req.headers.authorization,
      protocol: req.headers['x-amb-protocol'],
    })
    if (req.headers['x-amb-protocol'] !== '1') return json(res, 426, { error: 'protocol mismatch' })
    if (req.headers.authorization !== 'Bearer test-only-token') return json(res, 401, { error: 'unauthorized' })
    if (req.url === '/v1/prepare') {
      // Used by the self-check test to simulate an unreachable core.
      if (state.prepareMode === 'fail') return json(res, 503, { error: 'unavailable' })
      return json(res, 200, {
        protocolVersion: 1, knowledgeRevision: 7, mode: 'Managed',
        norms: [{ id: 'fixture-norm', deniedTools: ['amb_p0_blocked'] }], workflows: [],
        context: 'Only test knowledge context.',
      })
    }
    if (req.url === '/v1/gate') {
      if (state.gateMode === 'unavailable') return json(res, 503, { error: 'unavailable' })
      if (state.gateMode === 'deny') return json(res, 200, {
        decision: 'deny', reason: 'Test policy denial.', knowledgeRevision: 7, context: '',
      })
      return json(res, 200, {
        decision: 'allow', reason: '', knowledgeRevision: 7, context: '',
      })
    }
    if (req.url === '/v1/proposals') {
      return json(res, 200, { id: 'proposal-1', state: 'pending', duplicate: false })
    }
    if (req.url === '/v1/knowledge/supersede') {
      if (state.supersedeMode === 'malformed') return json(res, 200, { ok: true })
      return json(res, 200, {
        action: body.action ?? 'supersede', oldRevision: 1, newRevision: 2, historyPreserved: true,
      })
    }
    if (req.url === '/v1/knowledge/history') {
      return json(res, 200, {
        id: body.knowledgeId, current: { revision: 2, status: 'active', kind: 'norm', title: 'Fixture' },
        revisions: [{ revision: 1, createdAt: 1 }, { revision: 2, createdAt: 2 }], chain: [],
      })
    }
    if (req.url === '/v1/events') {
      return json(res, 200, { id: 'event-1', stored: true, duplicate: false })
    }
    if (req.url === '/v1/search') return json(res, 200, { workflows: [] })
    if (req.url === '/v1/expand') return json(res, 200, { workflow: {}, stage: {}, complete: true })
    return json(res, 404, { error: 'not found' })
  })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  endpoint = `http://127.0.0.1:${address.port}`
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))
  }
  assert.fail('timed out waiting for local DSH adapter request')
}

after(async () => {
  if (activeFiber) await activeFiber.dispose()
  if (activeToolsAccessFiber) await activeToolsAccessFiber.dispose()
  if (activeToolsFiber) await activeToolsFiber.dispose()
  if (server?.listening) {
    server.closeAllConnections()
    await new Promise((resolveClose) => server.close(resolveClose))
  }
  if (previousConfig === undefined) delete process.env.AMB_DSH_CONFIG
  else process.env.AMB_DSH_CONFIG = previousConfig
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
})

test('loads and disposes DSH hooks and tools in the installed Cordis runtime', { skip: runtimeSkip }, async (t) => {
  // The runtime must sit inside the supported range; the exact build is reported
  // separately so an upgrade neither bricks the adapter nor hides itself.
  const packageInfo = await import(pathToFileURL(resolve(runtimeRoot, '@deepseek-ai/dsh-agent/package.json')).href, { with: { type: 'json' } })
  const toolsInfo = await import(pathToFileURL(resolve(runtimeRoot, '@deepseek-ai/dsh-tools/package.json')).href, { with: { type: 'json' } })
  for (const [name, version] of [['dsh-agent', packageInfo.default.version], ['dsh-tools', toolsInfo.default.version]]) {
    assert.equal(isSupported(version), true,
      `${name} ${version} 应落在支持区间 >=${supportedRange.min} <${supportedRange.max} 内`)
  }
  if (packageInfo.default.version !== verifiedVersion) {
    console.warn(`注意：宿主为 ${packageInfo.default.version}，已验证版本是 ${verifiedVersion}`)
  }

  tempDir = await mkdtemp(join(tmpdir(), 'amb-dsh-adapter-'))
  const configPath = join(tempDir, 'client.json')
  await writeFile(configPath, JSON.stringify({ endpoint, token: 'test-only-token', projectId: 'fixture-project', projectRoot: process.cwd() }), 'utf8')
  previousConfig = process.env.AMB_DSH_CONFIG
  process.env.AMB_DSH_CONFIG = configPath
  state.requests.length = 0
  state.gateMode = 'allow'

  const registeredTools = new Map()
  const tools = {
    guard() { return () => {} }, // Actual monotonic enforcement is tested by dsh-runtime.test.mjs.
    register(definition) {
      assert.equal(registeredTools.has(definition.name), false)
      registeredTools.set(definition.name, definition)
      return () => registeredTools.delete(definition.name)
    },
  }
  const base = new Context()
  const toolsFiber = base.plugin({ name: 'p0-test-tools', apply(ctx) { ctx.provide('tools', tools) } })
  await toolsFiber
  activeToolsFiber = toolsFiber
  const ctx = base
  const fiber = ctx.plugin(adapter.default)
  await fiber
  activeFiber = fiber

  assert.deepEqual([...registeredTools.keys()].sort(), [
    'amb_inspect_archive', 'amb_knowledge_history', 'amb_prepare', 'amb_read_knowledge',
    'amb_read_stage', 'amb_search_workflows', 'amb_self_check', 'amb_structure_skill',
    'amb_submit_experience', 'amb_supersede_experience', 'amb_unstructured_skills',
  ])

  const injected = []
  const agent = {
    id: 'fixture-session',
    session: { header: { cwd: process.cwd() } },
    inject(message) { injected.push(message) },
  }
  const userMessage = {
    id: 'user-1', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: 'Implement the requested feature.' }],
  }
  const preStep = await ctx.waterfall('agent/pre-step', {
    agent, messages: [userMessage], turn: 1, step: 1, signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [userMessage] }))
  assert.match(preStep.messages[1].content.at(-1).text, /Only test knowledge context/)
  assert.equal(preStep.messages[1].source.kind, 'agent-memory-backpack')
  assert.deepEqual(preStep.messages[0], userMessage)
  assert.equal(preStep.messages[0].id, userMessage.id)
  assert.equal(state.requests.find((request) => request.path === '/v1/prepare').body.adapter, 'dsh')

  let delegated = false
  const execution = { name: 'ordinary_tool', agent, signal: new AbortController().signal }
  state.gateMode = 'deny'
  const denied = await ctx.waterfall('tools/pre-execute', execution, async () => {
    delegated = true
    return { kind: 'allow' }
  })
  assert.deepEqual(denied, { kind: 'deny', reason: 'Test policy denial.' })
  assert.equal(delegated, false)

  state.gateMode = 'unavailable'
  const unavailable = await ctx.waterfall('tools/pre-execute', execution, async () => ({ kind: 'allow' }))
  assert.equal(unavailable.kind, 'deny')
  assert.match(unavailable.reason, /unavailable/)

  state.gateMode = 'allow'
  const allowed = await ctx.waterfall('tools/pre-execute', execution, async () => {
    delegated = true
    return { kind: 'allow' }
  })
  assert.equal(allowed.kind, 'allow')
  assert.equal(delegated, true)

  const proposal = await registeredTools.get('amb_submit_experience').execute(
    { idempotencyKey: 'fixture-proposal-1', discovery: 'A repeatable local fixture insight.', baseRevision: 1 },
    { agent, signal: new AbortController().signal },
  )
  assert.equal(proposal.state, 'pending')
  const proposalRequest = state.requests.find((request) => request.path === '/v1/proposals')
  assert.ok(proposalRequest.body.idempotencyKey)
  assert.equal(proposalRequest.body.projectId, 'fixture-project')
  assert.ok(state.requests.every((request) => request.protocol === '1'))
  assert.equal(JSON.stringify(state.requests.map(({ body }) => body)).includes('test-only-token'), false)

  // Supersede: the adapter must pass through the reason and evidence, and must
  // reject a 200 that does not actually confirm history was preserved.
  const superseded = await registeredTools.get('amb_supersede_experience').execute(
    { oldId: 'old-rule', newId: 'new-rule', reason: '实践中旧做法失败', evidence: '任务 T-1 复现' },
    { agent, signal: new AbortController().signal },
  )
  assert.equal(superseded.historyPreserved, true)
  assert.equal(superseded.action, 'supersede', '未指定 action 时应默认 supersede')
  const supersedeRequest = state.requests.filter((request) => request.path === '/v1/knowledge/supersede').at(-1)
  assert.equal(supersedeRequest.body.oldId, 'old-rule')
  assert.equal(supersedeRequest.body.reason, '实践中旧做法失败')
  assert.equal(supersedeRequest.body.evidence, '任务 T-1 复现')
  assert.equal(supersedeRequest.body.projectId, 'fixture-project')

  const supplemented = await registeredTools.get('amb_supersede_experience').execute(
    { oldId: 'a', newId: 'b', action: 'supplement', reason: 'r', evidence: 'e' },
    { agent, signal: new AbortController().signal },
  )
  assert.equal(supplemented.action, 'supplement', '补充必须原样传递')

  state.supersedeMode = 'malformed'
  await assert.rejects(
    () => registeredTools.get('amb_supersede_experience').execute(
      { oldId: 'a', newId: 'b', reason: 'r', evidence: 'e' },
      { agent, signal: new AbortController().signal },
    ),
    /invalid supersede response/,
    '未确认保留历史的响应必须被视为失败',
  )
  state.supersedeMode = 'ok'

  // History: read-only lineage lookup.
  const history = await registeredTools.get('amb_knowledge_history').execute(
    { knowledgeId: 'old-rule' }, { agent, signal: new AbortController().signal },
  )
  assert.equal(history.id, 'old-rule')
  assert.equal(history.revisions.length, 2)
  await assert.rejects(
    () => registeredTools.get('amb_knowledge_history').execute({}, { agent, signal: new AbortController().signal }),
    /knowledgeId/,
    '缺少参数时必须拒绝而不是发起空查询',
  )

  // Self-check: the agent's own way to explain a failure instead of guessing.
  const selfCheck = await registeredTools.get('amb_self_check').execute(
    {}, { agent, signal: new AbortController().signal },
  )
  assert.equal(selfCheck.ok, true, JSON.stringify(selfCheck.checks))
  assert.deepEqual(
    selfCheck.checks.map(c => c.id),
    ['project-scope', 'core-reachable', 'protocol-match', 'knowledge-state', 'log-file', 'version', 'credentials'],
  )
  assert.equal(selfCheck.checks.find(c => c.id === 'protocol-match').status, 'pass')
  assert.equal(selfCheck.checks.find(c => c.id === 'knowledge-state').detail.includes('知识版本 7'), true)
  // The report must never carry the adapter credential.
  assert.equal(JSON.stringify(selfCheck).includes('test-only-token'), false, '自检结果不得包含凭据')

  // When the core is unreachable, the check must fail loudly and say so, and the
  // dependent protocol check must be skipped rather than reported as passing.
  state.prepareMode = 'fail'
  const degraded = await registeredTools.get('amb_self_check').execute(
    {}, { agent, signal: new AbortController().signal },
  )
  assert.equal(degraded.ok, false, '核心不可达时自检必须判为失败')
  assert.equal(degraded.checks.find(c => c.id === 'core-reachable').status, 'fail')
  assert.ok(degraded.checks.find(c => c.id === 'core-reachable').hint, '失败项必须给出建议')
  assert.equal(degraded.checks.find(c => c.id === 'protocol-match').status, 'skip')
  state.prepareMode = 'ok'

  await ctx.emit('session/event', {
    id: 'fixture-session', header: { cwd: process.cwd() },
  }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  await waitFor(() => state.requests.some((request) => request.path === '/v1/events' && request.body.kind === 'turn_stopped'))
  assert.equal(state.requests.some((request) => request.body.kind === 'task_completed'), false)

  const priorRequestCount = state.requests.length
  await fiber.dispose()
  activeFiber = undefined
  assert.equal(registeredTools.has('amb_submit_experience'), false)
  await ctx.waterfall('tools/pre-execute', execution, async () => ({ kind: 'allow' }))
  await ctx.waterfall('agent/pre-step', {
    agent, messages: [userMessage], turn: 2, step: 1, signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [userMessage] }))
  assert.equal(state.requests.length, priorRequestCount)
})

test('rejects non-loopback endpoints without exposing configured token', async () => {
  const { loadClientConfig } = await import('../adapters/dsh/core-client.mjs')
  tempDir = await mkdtemp(join(tmpdir(), 'amb-dsh-config-'))
  const configPath = join(tempDir, 'client.json')
  previousConfig = process.env.AMB_DSH_CONFIG
  await writeFile(configPath, JSON.stringify({ endpoint: 'http://example.com', token: 'secret-never-print', projectId: 'p', projectRoot: process.cwd() }), 'utf8')
  process.env.AMB_DSH_CONFIG = configPath
  try {
    await assert.rejects(loadClientConfig(), (error) => {
      assert.match(error.message, /127\.0\.0\.1/)
      assert.equal(error.message.includes('secret-never-print'), false)
      return true
    })
  } finally {
    if (previousConfig === undefined) delete process.env.AMB_DSH_CONFIG
    else process.env.AMB_DSH_CONFIG = previousConfig
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('connects to the in-memory Agent Memory Backpack core using the DSH identity and protocol header', async (t) => {
  const [{ Store }, { createCoreServer }, { normSchema }, { createClient }] = await Promise.all([
    import('../dist/src/store.js'),
    import('../dist/src/server.js'),
    import('../dist/src/schema.js'),
    import('../adapters/dsh/core-client.mjs'),
  ])
  const store = new Store(':memory:')
  store.import([normSchema.parse({
    id: 'fixture-rule', kind: 'norm', title: 'Fixture gate',
    scope: { kind: 'project', projectId: 'fixture-project' },
    body: 'Only block the named fixture tool.', deniedTools: ['amb_p0_blocked'],
  })])
  const token = 'b'.repeat(64)
  const core = createCoreServer(store, {
    protocolVersion: 1,
    port: 47631,
    clients: [{ id: 'dsh', token, projectId: 'fixture-project' }],
  })
  await new Promise((resolveListen, reject) => {
    core.once('error', reject)
    core.listen(0, '127.0.0.1', resolveListen)
  })
  t.after(async () => {
    core.closeAllConnections()
    await new Promise((resolveClose, reject) => core.close((error) => error ? reject(error) : resolveClose()))
    store.close()
  })

  const address = core.address()
  assert.ok(address && typeof address !== 'string')
  const client = createClient({
    endpoint: `http://127.0.0.1:${address.port}`,
    token,
    projectId: 'fixture-project',
  })
  const prepared = await client.post('/v1/prepare', {
    adapter: 'dsh', projectId: 'fixture-project', sessionId: 'fixture-session', query: 'test task',
  })
  assert.equal(prepared.protocolVersion, 1)
  assert.equal(prepared.norms.find((rule) => rule.id === 'fixture-rule')?.title, 'Fixture gate')
  assert.match(prepared.context, /Only block the named fixture tool/)
  const gate = await client.post('/v1/gate', {
    adapter: 'dsh', projectId: 'fixture-project', sessionId: 'fixture-session', toolName: 'amb_p0_blocked',
  })
  assert.equal(gate.decision, 'deny')
  assert.match(gate.context, /Only block the named fixture tool/)
  const proposal = await client.post('/v1/proposals', {
    projectId: 'fixture-project', idempotencyKey: 'fixture-idem-1',
    baseRevision: 1, discovery: 'A candidate fixture proposal.',
  })
  assert.equal(proposal.state, 'pending')
  const event = await client.post('/v1/events', {
    eventId: 'fixture-event-1', adapter: 'dsh', projectId: 'fixture-project',
    sessionId: 'fixture-session', kind: 'turn_stopped', summary: 'DSH turn stopped.',
  })
  assert.equal(event.stored, true)
  assert.equal(client.isDisposed(), false)
  client.dispose()
  assert.equal(client.isDisposed(), true)
})

await startServer()
