import test from 'node:test'
import assert from 'node:assert/strict'
import { entryFromClassification, buildPanelAdminParams } from '../adapters/dsh/index.mjs'

/**
 * Where a candidate's shape comes from.
 *
 * Every candidate is classified when it is submitted (kind, scope, relation,
 * confidence, reasoning), and that classification is what the review gate uses. The
 * panel used to ask the reviewer to restate it, which made the ordinary approval a
 * two-step form for a judgement the system had already made - and the second step was
 * the one people missed, so an approved candidate looked unapproved and stayed in the
 * queue.
 *
 * These pin the derivation, including the two cases where it must refuse rather than
 * guess: widening to global, and a candidate with no classification at all.
 */

const candidate = (over = {}) => ({
  projectId: 'p0-workflow',
  discovery: '首行结论\n第二行细节',
  classification: { kind: 'norm', scope: 'project', relation: 'new', confidence: 0.71 },
  ...over,
})

test('the plugin decides the kind and scope, and the entry records that it did', () => {
  const entry = entryFromClassification(candidate(), 'p0-workflow', 'abc-123')

  assert.ok(entry, '有分类时必须能直接构造条目')
  assert.equal(entry.kind, 'norm')
  assert.deepEqual(entry.scope, { kind: 'project', projectId: 'p0-workflow' })
  assert.equal(entry.title, '首行结论', '标题取首个非空行')
  assert.equal(entry.body, '首行结论\n第二行细节', '正文必须是候选原文，不是摘要')
  assert.equal(entry.id, 'norm:abc-123', 'id 用完整候选 id，不能再截断')
  assert.equal(entry.provenance, 'agent', '形态是插件判定的，条目要记住这一点')
  assert.equal(entry.evidence, 'unverifiable', '评审不会让未核实的内容变成已核实')
})

test('a task-scoped candidate keeps its task', () => {
  const entry = entryFromClassification(candidate({
    taskId: 'task-42',
    classification: { kind: 'memory', scope: 'task' },
  }), 'p0-workflow', 'id-1')

  assert.deepEqual(entry.scope, { kind: 'task', projectId: 'p0-workflow', taskId: 'task-42' })
  assert.equal(entry.kind, 'memory')
})

test('a task-scoped candidate without a task id is refused rather than demoted', () => {
  // Silently turning it into a project entry would widen what the candidate said.
  const entry = entryFromClassification(candidate({ classification: { kind: 'memory', scope: 'task' } }), 'p0', 'id-2')
  assert.equal(entry, null)
})

test('global scope is never one click', () => {
  // Promoting one project's knowledge to every project is a widening decision the
  // store guards with its own flag; a single click must not do it by accident.
  const entry = entryFromClassification(candidate({ classification: { kind: 'norm', scope: 'global' } }), 'p0', 'id-3')
  assert.equal(entry, null)
})

test('no classification means no guess', () => {
  assert.equal(entryFromClassification(candidate({ classification: undefined }), 'p0', 'id-4'), null)
  assert.equal(entryFromClassification(null, 'p0', 'id-5'), null)
})

test('a kind the panel cannot show is refused instead of written', () => {
  const entry = entryFromClassification(candidate({ classification: { kind: 'workflow', scope: 'project' } }), 'p0', 'id-6')
  assert.equal(entry, null)
})

test('empty text is refused, and a long first line is truncated to the title limit', () => {
  assert.equal(entryFromClassification(candidate({ discovery: '   \n\n' }), 'p0', 'id-7'), null)

  const long = 'A'.repeat(400)
  const entry = entryFromClassification(candidate({ discovery: long }), 'p0', 'id-8')
  assert.equal(entry.title.length, 120, '标题必须截到 schema 允许的长度')
  assert.equal(entry.body, long, '正文不截断')
})

test('a candidate without a project falls back to the calling project', () => {
  const entry = entryFromClassification(candidate({ projectId: undefined }), 'fallback-project', 'id-9')
  assert.deepEqual(entry.scope, { kind: 'project', projectId: 'fallback-project' })
})

/**
 * The request the panel actually sends.
 *
 * Deriving the entry is only half the path: the approve verb has to receive it. This
 * drives the same builder the panel drives, with the same admin client shape, so a
 * break in the wiring fails here rather than in a click nobody can reproduce.
 */
const adminStub = payload => ({ post: async () => ({ payload }) })

test('a one-click approval sends a complete entry, built from the candidate', async () => {
  const params = await buildPanelAdminParams(
    'proposal-approve',
    { id: 'cand-1', projectId: 'p0-workflow' },
    { projectId: 'p0-workflow' },
    adminStub(candidate()),
  )
  assert.ok(params.entry, '必须带上 entry，否则核心无从写入')
  assert.equal(params.entry.kind, 'norm')
  assert.equal(params.entry.scope.projectId, 'p0-workflow')
  assert.equal(params.entry.title, '首行结论')
})

test('an explicit entry from the correction path is never overwritten', async () => {
  const explicit = { id: 'memory:x', kind: 'memory', title: '手选', body: 'b', scope: { kind: 'project', projectId: 'p0' } }
  const params = await buildPanelAdminParams(
    'proposal-approve',
    { id: 'cand-2', projectId: 'p0', entry: explicit },
    { projectId: 'p0' },
    adminStub(candidate()),
  )
  assert.deepEqual(params.entry, explicit)
})

test('a candidate the plugin cannot classify is refused, not guessed', async () => {
  await assert.rejects(
    () => buildPanelAdminParams(
      'proposal-approve',
      { id: 'cand-3', projectId: 'p0' },
      { projectId: 'p0' },
      adminStub({ discovery: '只有文本，没有分类' }),
    ),
    /分类|作用域/,
    '没有分类时必须说明原因，而不是编一个类别写进去',
  )
})
