/**
 * W12 read-only measurement: decompose one real AMB injection into its parts, and
 * compare the pre-budget rendering of the recall passage with the budgeted one.
 *
 * It talks to the already-running local core with the invoking user's own adapter
 * credential, prints only lengths and ids, and never writes to the library
 * (search / read / prepare are read paths). The credential is never printed.
 *
 * Usage:
 *   node verification/r5/recall-budget-measure.mjs                  # default query set
 *   node verification/r5/recall-budget-measure.mjs --ids id1,id2    # size given entries
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { recallKnowledge, resolveRecallBudget } from '../../adapters/dsh/recall.mjs'

const dataDir = process.env.AMB_DATA_DIR?.trim() || join(homedir(), '.agent-memory-backpack')
const cfg = JSON.parse(readFileSync(join(dataDir, 'dsh-client.json'), 'utf8'))
const budget = resolveRecallBudget({})

async function post(path, body) {
  const response = await fetch(`${cfg.endpoint}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.token}`,
      'x-amb-protocol': '1',
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`)
  return response.json()
}

const logger = { info() {}, warn() {}, debug() {}, error() {} }
const client = { post: (route, body) => post(route, body) }
const header = '[AMB 自动检索并读取：task]\n以下为库内参考资料，请结合当前任务与验证结果使用。\n'

/** The rendering this path used before the budget existed (kept as the control). */
function legacyPassage(docs) {
  const blocks = []
  let remaining = 6000
  for (const doc of docs) {
    const excerpt = doc.located.slice(0, Math.min(2800, remaining))
    remaining -= excerpt.length
    blocks.push(`### ${doc.title} (${doc.id}@${doc.revision})\n${excerpt}`
      + (excerpt.length < doc.bodyLength ? '\n[正文节选；可用 amb_read_knowledge 读取全文。]' : '')
      + (doc.leaves.length ? `\n参考文档：${doc.leaves.map(leaf => leaf.path).slice(0, 12).join('、')}；需要时用 amb_read_knowledge(includeLeaves:true) 读取。` : '')
      + (doc.needsStructure ? '\n[原始技能尚未结构化；不能据此声称完整流程已验证。]' : ''))
  }
  return blocks.length ? `${header}${blocks.join('\n\n')}` : ''
}

async function readDoc(id, query) {
  const value = await post('/v1/knowledge/read', { projectId: cfg.projectId, knowledgeId: id, includeLeaves: false, query })
  const located = Array.isArray(value.passages) && value.passages.length
    ? value.passages.map(p => `[原文字符 ${p.offset}]\n${p.text}`).join('\n[…]\n')
    : value.body
  return {
    id: value.id ?? id,
    title: value.title ?? id,
    revision: value.revision ?? 0,
    located,
    bodyLength: String(value.body ?? '').length,
    leaves: Array.isArray(value.leaves) ? value.leaves : [],
    needsStructure: Boolean(value.needsStructure),
  }
}

async function compare(query) {
  const found = await post('/v1/knowledge/search-universal', { projectId: cfg.projectId, query, limit: 3, autoRecall: true })
  const candidates = (found.results ?? []).filter(item => typeof item?.id === 'string').slice(0, 2)
  const docs = []
  for (const item of candidates) docs.push(await readDoc(item.id, query))
  const legacy = legacyPassage(docs)
  const recalled = await recallKnowledge({ client, config: { ...cfg }, logger, adapter: 'dsh', sessionId: 'w12-measure', query, trigger: 'task' })
  return {
    query,
    revision: found.knowledgeRevision,
    selection: found.selection?.mode ?? '',
    candidates: docs.map(doc => `${doc.id}(${doc.bodyLength})`),
    legacyChars: legacy.length,
    budgetChars: recalled.context.length,
    disclosed: recalled.ids,
    sumOfBodies: docs.reduce((total, doc) => total + doc.bodyLength, 0),
  }
}

const queries = process.argv.includes('--ids')
  ? []
  : [
    'W12 召回预算 每轮注入上下文 字符预算 渐进披露',
    'missing binary look up before retrying',
    '调试渲染 run-to-node 定位第一个出错的阶段',
    'codex-router install.ps1 自更新 拒绝覆盖本地改动',
    'AMB 面板候选折叠 展开全文 首行渲染',
  ]

const rows = []
for (const query of queries) rows.push(await compare(query))

const sizes = []
if (process.argv.includes('--ids')) {
  const ids = (process.argv[process.argv.indexOf('--ids') + 1] ?? '').split(',').filter(Boolean)
  const docs = []
  for (const id of ids) docs.push(await readDoc(id, ''))
  const legacy = legacyPassage(docs)
  // Pin the candidate set so both renderings describe the same entries on the
  // same knowledge revision: the search call is answered locally, every read is
  // still a real core call.
  const pinned = {
    post: (route, body) => route.endsWith('search-universal')
      ? Promise.resolve({ results: docs.map(doc => ({ id: doc.id, revision: doc.revision })),
        knowledgeRevision: 0, selection: { mode: 'index', reason: 'pinned' } })
      : post(route, body),
  }
  const recalled = await recallKnowledge({
    client: pinned, config: { ...cfg }, logger, adapter: 'dsh', sessionId: 'w12-measure', query: 'pinned entries', trigger: 'task',
  })
  sizes.push({
    ids,
    entries: docs.map(doc => ({ id: doc.id, bodyChars: doc.located.length })),
    sumOfBodies: docs.reduce((total, doc) => total + doc.located.length, 0),
    legacyChars: legacy.length,
    budgetedChars: recalled.context.length,
    disclosed: recalled.ids,
    rendered: recalled.context,
  })
}

// The three fixed parts of one turn, measured rather than assumed.
const prepareFirstTurn = await post('/v1/prepare', { adapter: 'dsh', projectId: cfg.projectId, sessionId: 'w12-measure', query: 'measure' })
const prepareKnownVersion = await post('/v1/prepare', {
  adapter: 'dsh', projectId: cfg.projectId, sessionId: 'w12-measure', query: 'measure',
  knowledgeRevision: prepareFirstTurn.knowledgeRevision,
})

console.log(JSON.stringify({
  budget,
  normative: {
    fullChars: String(prepareFirstTurn.context ?? '').length,
    pointerChars: String(prepareKnownVersion.context ?? '').length,
    revision: prepareFirstTurn.knowledgeRevision,
  },
  queries: rows,
  entries: sizes,
}, null, 2))
