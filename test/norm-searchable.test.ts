import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'

/**
 * A rule the agent cannot find is a rule it breaks silently.
 *
 * The full-text index used to skip `norm` on write, which made the one kind that
 * states rules the only kind a search could never return - while `searchUniversal`
 * advertised "all knowledge kinds". Measured on a real library: a query almost
 * verbatim from a stored rule returned nothing, and 19 of its 19 tokens were
 * reported as gaps.
 *
 * These pin both halves: new rules are indexed, and rules written before the fix
 * are backfilled on the next open rather than staying invisible forever.
 */

const rule = {
  id: 'norm:syntax-gate',
  kind: 'norm' as const,
  title: '发布脚本全量语法门禁规范',
  body: '打包发布脚本 scripts/package.mjs 必须包含 node --check 全量语法扫描，防止语法错误的脚本逃逸到安装目录。',
  scope: { kind: 'project' as const, projectId: 'p0' },
  baseRevision: 0,
}

const skill = {
  id: 'skill:unrelated',
  kind: 'skill' as const,
  title: '九宫格故事板法',
  body: '按场景与音色锚点分组，生成九宫格故事板锁定关键瞬间。',
  scope: { kind: 'global' as const },
  baseRevision: 0,
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'amb-norm-search-'))
  return { dir, path: join(dir, 'knowledge.sqlite') }
}

test('a stored rule is found by a search that quotes it', () => {
  const { dir, path } = scratch()
  const store = new Store(path)
  try {
    store.import([rule, skill])

    // This is the query that used to come back empty.
    const hits = store.searchUniversal('p0', '打包脚本必须包含全量语法扫描')
    assert.ok(hits.length > 0, '搜索必须能命中库里的规范')
    assert.equal(hits[0]!.id, rule.id, `首条应是那条规范，实际：${hits.map(h => h.id).join(', ')}`)
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('indexing rules does not hide the other kinds', () => {
  const { dir, path } = scratch()
  const store = new Store(path)
  try {
    store.import([rule, skill])
    const hits = store.searchUniversal('p0', '九宫格故事板')
    assert.ok(hits.some(h => h.id === skill.id), '加入规范后其他类型的检索必须不受影响')
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('a rule written before the fix is backfilled on the next open', () => {
  const { dir, path } = scratch()
  const first = new Store(path)
  try { first.import([rule]) } finally { first.close() }

  // Reproduce the old state: the row exists but has no index entry.
  const raw = new Store(path)
  try {
    raw.db.prepare('DELETE FROM workflow_search WHERE id=?').run(rule.id)
    assert.equal(
      raw.db.prepare('SELECT COUNT(*) AS n FROM workflow_search WHERE id=?').get(rule.id)!.n,
      0, '前置条件：该条此刻没有索引行',
    )
  } finally { raw.close() }

  const reopened = new Store(path)
  try {
    const hits = reopened.searchUniversal('p0', '全量语法扫描')
    assert.ok(hits.some(h => h.id === rule.id), '重开时必须补齐索引，否则存量规范永远搜不到')
  } finally { reopened.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('the backfill is idempotent: a second open changes nothing', () => {
  const { dir, path } = scratch()
  const first = new Store(path)
  try { first.import([rule]) } finally { first.close() }

  const countOnce = () => {
    const store = new Store(path)
    try { return store.db.prepare('SELECT COUNT(*) AS n FROM workflow_search').get()!.n } finally { store.close() }
  }
  const before = countOnce()
  const after = countOnce()
  assert.equal(after, before, '重复打开不得重复写入索引行')
  rmSync(dir, { recursive: true, force: true })
})

test('injection still reads rules through norms(), so indexing adds no duplicate', () => {
  const { dir, path } = scratch()
  const store = new Store(path)
  try {
    store.import([rule])
    const prepared = store.prepare('p0', '打包脚本语法门禁')
    assert.ok(prepared.norms.some(n => n.id === rule.id), '规范仍走常驻注入')
    // `knowledge` carries the searched entries; it must not carry the rule as well.
    assert.equal(prepared.knowledge.some(entry => entry.id === rule.id), false,
      '规范不得同时以“命中条目”的身份再出现一次')
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})
