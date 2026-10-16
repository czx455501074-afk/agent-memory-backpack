import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Store } from '../dist/src/store.js'
import { createCoreServer } from '../dist/src/server.js'
import { normSchema, journalSchema, skillSchema, memorySchema, materialSchema } from '../dist/src/schema.js'
import adapter from '../adapters/dsh/index.mjs'
import { inspectRuntime, runtimeRoot } from './dsh-target.mjs'

/**
 * The three data routes the native DSH panel reads.
 *
 * The panel is a React view now, so it asks the host half of the adapter for
 * `GET /amb/summary`, `GET /amb/search` and `GET /amb/task` instead of loading a
 * page. These tests drive the real routes: a real Cordis context loads the adapter,
 * the adapter registers its `/amb` prefix on a webServer fixture, and every request
 * is answered by a real `createCoreServer` over a throwaway database. Nothing here
 * touches the installed library, and a failure in the fixture directory check below
 * is what keeps that true.
 */

// A clone of this repository has no extracted desktop runtime, so the adapter
// cannot be loaded at all. Skip with the probe's reason instead of failing.
const runtimeProbe = inspectRuntime()
const skip = runtimeProbe.available ? false : runtimeProbe.reason
const { Context } = runtimeProbe.available
  ? await import(pathToFileURL(resolve(runtimeRoot, '@deepseek-ai/cordis/lib/index.js')).href)
  : { Context: class {} }

const TOKEN = 'p'.repeat(64)
const PROJECT = 'panel-project'

/** A port nothing is listening on, obtained by opening one and closing it. */
async function closedPort() {
  const probe = createServer()
  await new Promise((done, fail) => { probe.once('error', fail); probe.listen(0, '127.0.0.1', done) })
  const { port } = probe.address()
  await new Promise(done => probe.close(done))
  return port
}

/** Send a raw request line, so a path is not normalized before the server sees it. */
function rawRequestStatus(port, path) {
  return new Promise((done, fail) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, res => {
      res.resume()
      res.on('end', () => done(res.statusCode))
    })
    req.on('error', fail)
    req.end()
  })
}

/**
 * A real core over a throwaway database, plus the adapter's own HTTP surface.
 *
 * The core is the only source of the data under test: the fixture plants rows
 * (two norms, one task, one queue item, one candidate) and every assertion compares
 * a route's answer against what the core itself reports, so a passing test means
 * the endpoint read the library rather than a stub.
 */
async function startPanelFixture({ coreReachable = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'amb-dsh-panel-'))
  let store = null
  let core = null
  let endpoint
  if (coreReachable) {
    store = new Store(join(dir, 'knowledge.sqlite'))
    store.import([
      normSchema.parse({
        id: 'norm:panel-fixture', kind: 'norm', title: 'Panel fixture rule',
        scope: { kind: 'project', projectId: PROJECT }, body: 'Panel fixture rule body text',
      }),
      // One entry of each remaining category, so the panel's five-way navigation
      // has a real row to group under every category it offers. A category with no
      // row at all is a different case, covered by its own test below.
      journalSchema.parse({
        id: 'journal:panel-fixture', kind: 'journal', title: 'Panel fixture journal',
        scope: { kind: 'project', projectId: PROJECT }, did: 'Recorded the panel fixture journal body',
        outcome: 'success',
      }),
      skillSchema.parse({
        id: 'skill:panel-fixture', kind: 'skill', title: 'Panel fixture skill',
        scope: { kind: 'global' }, body: 'Panel fixture skill body',
      }),
      materialSchema.parse({
        id: 'material:panel-fixture', kind: 'material', title: 'Panel fixture material',
        scope: { kind: 'project', projectId: PROJECT }, url: 'https://example.invalid/panel-fixture',
        fingerprint: 'panel-fixture-fingerprint', summary: 'Panel fixture material summary',
        savedAt: Date.now() - 1000, expiresAt: Date.now() + 89 * 86_400_000,
      }),
      // Another project's entry: it must never reach this credential's panel.
      normSchema.parse({
        id: 'norm:other-project', kind: 'norm', title: 'Another project rule',
        scope: { kind: 'project', projectId: 'other-project' }, body: 'Must stay invisible',
      }),
    ])
    store.recordTask(PROJECT, {
      id: 'task-panel-fixture', title: 'Panel fixture task', status: 'in_progress',
      summary: 'Fixture summary', sessionIds: ['panel-session'],
    })
    store.enqueue('dsh', {
      kind: 'event', projectId: PROJECT, idempotencyKey: 'panel-fixture-outbox',
      payload: { projectId: PROJECT, summary: 'undelivered fixture' }, error: 'fixture transport fault', attempts: 1,
    })
    core = createCoreServer(store, {
      protocolVersion: 1, port: 47631,
      clients: [{ id: 'dsh', token: TOKEN, projectId: PROJECT, role: 'adapter' }],
    })
    await new Promise((done, fail) => { core.once('error', fail); core.listen(0, '127.0.0.1', done) })
    endpoint = `http://127.0.0.1:${core.address().port}`
    // One real candidate, submitted over the wire, so `pendingProposals` has a
    // source the fixture cannot have written by hand.
    const posted = await fetch(`${endpoint}/v1/proposals`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-amb-protocol': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: PROJECT, idempotencyKey: 'panel-fixture-candidate', discovery: 'Panel fixture candidate' }),
    })
    assert.equal(posted.ok, true, `候选夹具提交失败: HTTP ${posted.status}`)
  } else {
    // Unreachable core: a port that was open a moment ago and is now closed, so the
    // connection is refused rather than hanging.
    endpoint = `http://127.0.0.1:${await closedPort()}`
  }

  const configPath = join(dir, 'client.json')
  await writeFile(configPath, JSON.stringify({ endpoint, token: TOKEN, projectId: PROJECT }), 'utf8')
  const previousConfig = process.env.AMB_DSH_CONFIG
  const previousLogDir = process.env.AMB_LOG_DIR
  process.env.AMB_DSH_CONFIG = configPath
  // The adapter logs next to its credential; keeping that inside the fixture stops a
  // test run from writing into the real library's log.
  process.env.AMB_LOG_DIR = join(dir, 'logs')

  const root = new Context()
  const fibers = []
  const webServer = { registrations: [], register(options) { this.registrations.push(options); return () => {} } }
  const tools = { guard() { return () => {} }, register() { return () => {} } }
  const plugin = async definition => {
    const fiber = root.plugin(definition)
    fibers.push(fiber)
    await fiber
    return fiber
  }
  await plugin({ name: 'panel-fixture-tools', apply(ctx) { ctx.provide('tools', tools) } })
  // Provided before the adapter loads, so `ctx.inject(['webServer'])` resolves while
  // apply runs and the routes exist by the time the first request is sent.
  await plugin({ name: 'panel-fixture-web-server', apply(ctx) { ctx.provide('webServer', webServer) } })
  await plugin(adapter)

  const route = webServer.registrations.find(entry => entry.path === '/amb')
  assert.ok(route, '适配器必须注册 /amb 前缀路由')
  assert.equal(route.kind, 'prefix')
  const panel = createServer((req, res) => route.handler(req, res))
  await new Promise((done, fail) => { panel.once('error', fail); panel.listen(0, '127.0.0.1', done) })
  const origin = `http://127.0.0.1:${panel.address().port}`

  const raw = async (path, init) => {
    const response = await fetch(origin + path, init)
    return { status: response.status, text: await response.text(), headers: response.headers }
  }

  return {
    endpoint,
    port: panel.address().port,
    store,
    async getJson(path, init) {
      const result = await raw(path, init)
      return { ...result, body: JSON.parse(result.text) }
    },
    raw,
    async dispose() {
      panel.closeAllConnections()
      await new Promise(done => panel.close(done))
      for (const fiber of fibers.reverse()) await fiber.dispose()
      if (core) {
        core.closeAllConnections()
        await new Promise(done => core.close(done))
        store.close()
      }
      if (previousConfig === undefined) delete process.env.AMB_DSH_CONFIG
      else process.env.AMB_DSH_CONFIG = previousConfig
      if (previousLogDir === undefined) delete process.env.AMB_LOG_DIR
      else process.env.AMB_LOG_DIR = previousLogDir
      // Guard rail before the delete: this suite must never remove anything outside
      // the system temporary directory.
      const rel = relative(resolve(tmpdir()), resolve(dir))
      assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), '夹具目录必须位于系统临时目录内')
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('GET /amb/summary answers with the core counts and a project-scoped entry list', { skip }, async t => {
  const f = await startPanelFixture()
  t.after(() => f.dispose())
  const stats = f.store.stats()

  const { status, body } = await f.getJson('/amb/summary')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.core.reachable, true)
  assert.equal(body.core.endpoint, f.endpoint)
  assert.equal(body.core.projectId, PROJECT)
  assert.equal(body.revision, stats.knowledgeRevision)

  // Every counter is compared against what the core itself reports, so these
  // assertions fail if the route ever starts inventing numbers.
  assert.equal(body.counts.knowledge, stats.entries)
  assert.equal(body.counts.pendingProposals, stats.pendingProposals)
  assert.equal(body.counts.pendingProposals, 1)
  assert.deepEqual(Object.keys(body.counts.outbox).sort(), ['abandoned', 'failed', 'pending'])
  assert.equal(body.counts.outbox.pending, stats.outbox.pending)
  assert.equal(body.counts.outbox.pending, 1)
  assert.equal(body.counts.outbox.failed, stats.outbox.failed)
  assert.equal(body.counts.outbox.abandoned, stats.outbox.abandoned)

  assert.ok(Array.isArray(body.knowledge))
  const ids = body.knowledge.map(entry => entry.id)
  assert.ok(ids.includes('norm:panel-fixture'))
  assert.equal(ids.includes('norm:other-project'), false, '面板不得看到其他项目的条目')

  const entry = body.knowledge.find(item => item.id === 'norm:panel-fixture')
  assert.deepEqual(Object.keys(entry).sort(),
    ['excerpt', 'id', 'kind', 'proposalState', 'scope', 'source', 'status', 'title', 'updatedAt'])
  assert.equal(entry.kind, 'norm')
  assert.equal(entry.title, 'Panel fixture rule')
  assert.equal(entry.scope, 'project')
  // The category badge and the lifecycle badge read these two columns directly.
  assert.equal(entry.status, 'active', '生效条目的状态必须来自核心的 status 列')
  assert.equal(entry.source, 'project', '作用域徽标必须来自条目的 scope')
  // No path in this adapter can read a candidate's state for an entry: the list
  // endpoint is admin-only, so the field stays null instead of being inferred.
  assert.equal(entry.proposalState, null)
  // The core's retrieval endpoint returns no per-entry timestamp; the field is
  // present and empty on purpose, and the panel renders "not provided" for it.
  assert.equal(entry.updatedAt, null)
  assert.match(entry.excerpt, /Panel fixture rule body/)

  // The category navigation: one group per category the panel offers, in a fixed
  // order, each carrying the label keys the browser half prints and the size the
  // core reported for that category - not a count taken from a mixed page.
  assert.deepEqual(body.facets.map(facet => facet.kind), ['skill', 'journal', 'material', 'memory', 'norm'])
  for (const facet of body.facets) {
    assert.deepEqual(Object.keys(facet).sort(),
      ['entries', 'error', 'guideKey', 'kind', 'labelKey', 'limit', 'total'])
    assert.equal(facet.labelKey, `kind.${facet.kind}.label`)
    assert.equal(facet.guideKey, `kind.${facet.kind}.guide`)
    assert.equal(facet.limit, 200)
    assert.equal(facet.error, null)
    assert.equal(facet.total, facet.entries.length, '分组条目数必须与核心返回的条目一致')
    for (const item of facet.entries) {
      assert.equal(item.kind, facet.kind, '分组成员必须属于该类别')
    }
  }
  const byKind = new Map(body.facets.map(facet => [facet.kind, facet]))
  assert.deepEqual(byKind.get('journal').entries.map(item => item.id), ['journal:panel-fixture'])
  assert.deepEqual(byKind.get('skill').entries.map(item => item.id), ['skill:panel-fixture'])
  assert.deepEqual(byKind.get('material').entries.map(item => item.id), ['material:panel-fixture'])
  assert.equal(byKind.get('norm').entries.some(item => item.id === 'norm:panel-fixture'), true)
  assert.equal(byKind.get('norm').entries.some(item => item.id === 'norm:other-project'), false,
    '分类导航不得看到其他项目的条目')
  assert.equal(byKind.get('memory').total, 0, '没有该类条目时计数必须是 0，而不是别的类别的数')
  assert.equal(byKind.get('skill').entries[0].source, 'global', '全局条目的作用域必须如实标注')
  assert.equal(byKind.get('skill').entries[0].status, 'active')

  // The task view reads the core's own task list, scoped to this credential's
  // project, and every row carries the project it belongs to plus its state.
  assert.ok(Array.isArray(body.tasks))
  const task = body.tasks.find(item => item.id === 'task-panel-fixture')
  assert.ok(task, '任务列表必须来自核心的任务表')
  assert.deepEqual(Object.keys(task).sort(),
    ['evidence', 'id', 'projectId', 'status', 'summary', 'title', 'updatedAt'])
  assert.equal(task.projectId, PROJECT)
  assert.equal(task.status, 'in_progress')
  assert.equal(task.title, 'Panel fixture task')
  assert.equal(body.counts.tasks, stats.tasks, '全库任务计数必须来自核心统计')
  assert.ok(body.tasks.length < body.counts.tasks || body.counts.tasks === body.tasks.length)

  // The candidate section reports only what this credential may read: the pending
  // total from `/v1/stats`. The two review outcomes are unreadable here, so they
  // are null and the panel prints "not provided" - never a zero.
  assert.deepEqual(Object.keys(body.proposals).sort(), ['approved', 'archived', 'pending', 'reviewAvailable'])
  assert.equal(body.proposals.pending, stats.pendingProposals)
  assert.equal(body.proposals.pending, 1)
  assert.equal(body.proposals.approved, null)
  assert.equal(body.proposals.archived, null)
  assert.equal(body.proposals.reviewAvailable, false, '面板没有采纳/拒绝能力，必须如实声明')
})

test('GET /amb/search returns core hits and holds q and limit to their contract', { skip }, async t => {
  const f = await startPanelFixture()
  t.after(() => f.dispose())

  const hit = await f.getJson('/amb/search?q=fixture&limit=5')
  assert.equal(hit.status, 200)
  assert.equal(hit.body.ok, true)
  assert.ok(Array.isArray(hit.body.results))
  const row = hit.body.results.find(item => item.id === 'norm:panel-fixture')
  assert.ok(row, '关键词命中必须来自核心检索')
  assert.deepEqual(Object.keys(row).sort(),
    ['excerpt', 'id', 'kind', 'proposalState', 'scope', 'source', 'status', 'title', 'updatedAt'])
  assert.equal(row.kind, 'norm')
  assert.equal(row.title, 'Panel fixture rule')
  // The category badge and the lifecycle badge read these two columns directly, so a
  // search hit must carry them exactly like a summary row does. `status` is the
  // core's own `knowledge.status`; `scope` is flattened for the origin badge.
  assert.equal(row.status, 'active', '搜索命中的条目必须带核心的状态列')
  assert.equal(row.scope, 'project', '搜索命中必须带作用域，来源徽标据此渲染')
  assert.match(row.excerpt, /Panel fixture rule body/)
  assert.equal(hit.body.results.some(item => item.id === 'norm:other-project'), false, '搜索结果不得跨项目')

  // `q` is required, and whitespace is not an answer.
  const missingQ = await f.getJson('/amb/search')
  assert.equal(missingQ.status, 200)
  assert.equal(missingQ.body.ok, false)
  assert.match(missingQ.body.error, /q/)
  const blankQ = await f.getJson('/amb/search?q=%20')
  assert.equal(blankQ.status, 200)
  assert.equal(blankQ.body.ok, false)

  // Above the core's 200-item ceiling the page is clamped, not refused: the core
  // rejects a larger limit with its own 400, so an `ok:true` here is what proves the
  // clamp happened.
  for (const limit of ['200', '201', '9999']) {
    const clamped = await f.getJson(`/amb/search?q=fixture&limit=${limit}`)
    assert.equal(clamped.status, 200)
    assert.equal(clamped.body.ok, true, `limit=${limit} 应被夹到核心上限而不是被拒`)
    assert.ok(Array.isArray(clamped.body.results))
  }
  for (const limit of ['0', '-1', 'abc', '1.5', ' ']) {
    const refused = await f.getJson(`/amb/search?q=fixture&limit=${encodeURIComponent(limit)}`)
    assert.equal(refused.status, 200)
    assert.equal(refused.body.ok, false, `limit=${limit} 必须是正整数`)
    assert.match(refused.body.error, /limit/)
  }
  // An absent limit is the panel's own page size, not an error.
  const omitted = await f.getJson('/amb/search?q=fixture')
  assert.equal(omitted.body.ok, true)
})

test('GET /amb/task reads the real task record and answers null for an unknown id', { skip }, async t => {
  const f = await startPanelFixture()
  t.after(() => f.dispose())

  const found = await f.getJson('/amb/task?taskId=task-panel-fixture')
  assert.equal(found.status, 200)
  assert.equal(found.body.ok, true)
  assert.deepEqual(Object.keys(found.body.task).sort(), ['id', 'status', 'summary', 'title', 'updatedAt'])
  assert.equal(found.body.task.id, 'task-panel-fixture')
  assert.equal(found.body.task.title, 'Panel fixture task')
  assert.equal(found.body.task.status, 'in_progress')
  assert.equal(found.body.task.summary, 'Fixture summary')
  assert.equal(typeof found.body.task.updatedAt, 'number')
  const stored = f.store.tasks(PROJECT).find(task => task.id === 'task-panel-fixture')
  assert.equal(found.body.task.updatedAt, stored.updatedAt)

  // The core answers 404 for an id it does not hold; that is an answer, not a fault,
  // so the route reports success with no record and the panel renders "not found".
  const absent = await f.getJson('/amb/task?taskId=no-such-task')
  assert.equal(absent.status, 200)
  assert.deepEqual(absent.body, { ok: true, task: null })

  const missing = await f.getJson('/amb/task')
  assert.equal(missing.status, 200)
  assert.equal(missing.body.ok, false)
  assert.match(missing.body.error, /taskId/)
  const blank = await f.getJson('/amb/task?taskId=%20')
  assert.equal(blank.status, 200)
  assert.equal(blank.body.ok, false)
  const oversized = await f.getJson(`/amb/task?taskId=${'t'.repeat(121)}`)
  assert.equal(oversized.status, 200)
  assert.equal(oversized.body.ok, false)
  assert.match(oversized.body.error, /taskId/)
})

test('the panel routes stay additive: the /amb prefix keeps its bare-404 and exact-match boundary', { skip }, async t => {
  const f = await startPanelFixture()
  t.after(() => f.dispose())

  // The two address routes this prefix used to answer (`/amb/ui-url`, `/amb/config`)
  // were retired with the embedded page by the same work that introduced the native
  // panel; `dsh-adapter.test.mjs` pins that down on its own. What this test holds is
  // the boundary the data routes must respect: the path is matched exactly, an
  // unmapped path is still a bare 404, and a write method is refused rather than
  // treated as a read.
  for (const path of ['/amb/other', '/amb/summary/extra', '/amb/summary-x', '/amb/task/1', '/amb/search/x']) {
    const missing = await f.raw(path)
    assert.equal(missing.status, 404, `${path} 必须是 404`)
    assert.equal(missing.text, '')
  }

  // A path that would normalize onto a data route is not one: the check runs on the
  // request line as sent, before any URL resolution could alias it.
  assert.equal(await rawRequestStatus(f.port, '/amb/summary/../task'), 404)
  assert.equal(await rawRequestStatus(f.port, '/amb/%73ummary'), 404)

  // These routes only read, so a write method is refused rather than treated as one.
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const written = await f.raw('/amb/summary', { method })
    assert.equal(written.status, 405, `${method} 必须被拒`)
    assert.equal(JSON.parse(written.text).ok, false)
  }
  const writtenSearch = await f.raw('/amb/search?q=fixture', { method: 'POST' })
  assert.equal(writtenSearch.status, 405)

  // This prefix must never become a way for a page to read the library, so no
  // response it serves may carry a wildcard CORS grant.
  const summary = await f.raw('/amb/summary')
  assert.equal(summary.headers.get('access-control-allow-origin'), null)
})

test('an unreachable core answers ok:false with a reason and never leaks the credential', { skip }, async t => {
  const f = await startPanelFixture({ coreReachable: false })
  t.after(() => f.dispose())

  const probes = ['/amb/summary', '/amb/search?q=fixture', '/amb/task?taskId=task-panel-fixture']
  for (const path of probes) {
    const { status, text, body } = await f.getJson(path)
    // The panel needs an error state it can render, not an HTTP failure it cannot
    // describe, so the transport status stays 200.
    assert.equal(status, 200, `${path} 必须仍返回 200`)
    assert.equal(body.ok, false, `${path} 必须报告 ok:false`)
    assert.equal(body.core.reachable, false, `${path} 必须报告核心不可达`)
    assert.equal(body.core.endpoint, f.endpoint)
    assert.equal(body.core.projectId, PROJECT)
    assert.equal(typeof body.error, 'string')
    assert.ok(body.error.length > 0, `${path} 必须带回原因`)
    assert.equal(text.includes(TOKEN), false, `${path} 响应不得包含凭据`)
    assert.equal(text.includes('Bearer'), false, `${path} 响应不得包含授权头文本`)
  }
})
