import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

/**
 * The evolution pipeline's first stage against a real store.
 *
 * Two properties matter more than the grouping itself:
 *
 *  - **Nothing happens by default.** A dry run must leave the database byte-for-byte as it
 *    was — no run row, no candidate row — because the first call against a real library is
 *    the one nobody has reviewed yet.
 *  - **Even a real run cannot reach the library.** It writes `evolve_candidates` only; the
 *    knowledge revision must be unchanged afterwards, and no proposal may be created. A
 *    pipeline that can promote itself is the one thing the design forbids outright.
 */

const PROJECT = 'p0';
const MINUTE = 60_000;

/** A captured failure whose signature survives normalisation (path differs, rest does not). */
const failureProposal = (store: Store, key: string, path: string, at: number) => {
  const discovery = [
    '【自动捕获的失败事实；待核实】',
    '所属流程：工具执行与故障恢复；步骤：记录失败、检索已有经验、验证修复。',
    '来源：dsh 会话 fixture；工具：edit。',
    `观察：cannot edit ${path}: file changed since it was read`,
    '根因与修复：尚未验证；请主动检索相关经验。',
  ].join('\n');
  const { id } = store.submit('agent', { idempotencyKey: key, projectId: PROJECT, discovery });
  // `submit` stamps its own clock; move the row to the time this case needs so the span gate
  // is exercised instead of accidentally satisfied.
  store.db.prepare('UPDATE proposals SET created_at=? WHERE id=?').run(at, id);
  return id;
};

test('预演不写任何一行，且知识版本不变', () => {
  const store = new Store(':memory:');
  try {
    const base = 1_700_000_000_000;
    failureProposal(store, 'e1', 'D:\\a.txt', base);
    failureProposal(store, 'e2', 'D:\\b.txt', base + 5 * MINUTE);

    const before = store.revision;
    const result = store.runEvolution({ projectId: PROJECT });
    assert.equal(result.dryRun, true, '默认必须是预演');
    assert.equal(result.runId, null);
    assert.equal(result.candidates.length, 1, `应识别出一组重复失败，跳过项：${JSON.stringify(result.skipped)}`);
    assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM evolve_runs').get()!.n), 0, '预演不得写运行记录');
    assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM evolve_candidates').get()!.n), 0, '预演不得写候选');
    assert.equal(store.revision, before, '预演不得改动知识版本');
  } finally { store.close(); }
});

test('真跑只写 evolve_candidates，不碰知识库与提案', () => {
  const store = new Store(':memory:');
  try {
    const base = 1_700_000_000_000;
    failureProposal(store, 'r1', 'D:\\a.txt', base);
    failureProposal(store, 'r2', 'D:\\b.txt', base + 5 * MINUTE);

    const beforeRevision = store.revision;
    const beforeProposals = Number(store.db.prepare('SELECT count(*) AS n FROM proposals').get()!.n);
    const beforeKnowledge = Number(store.db.prepare('SELECT count(*) AS n FROM knowledge').get()!.n);

    const result = store.runEvolution({ projectId: PROJECT, dryRun: false });
    assert.equal(result.dryRun, false);
    assert.ok(result.runId, '真跑必须返回 runId，供反查与撤销');
    assert.equal(result.candidates.length, 1);

    assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM evolve_runs').get()!.n), 1);
    assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM evolve_candidates').get()!.n), 1);
    assert.equal(store.revision, beforeRevision, '进化不得改动知识库');
    assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM proposals').get()!.n), beforeProposals,
      '第一阶段只产出候选，不生成提案');
    assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM knowledge').get()!.n), beforeKnowledge);
  } finally { store.close(); }
});

test('重复运行是刷新而不是堆行', () => {
  const store = new Store(':memory:');
  try {
    const base = 1_700_000_000_000;
    failureProposal(store, 'd1', 'D:\\a.txt', base);
    failureProposal(store, 'd2', 'D:\\b.txt', base + 5 * MINUTE);

    store.runEvolution({ projectId: PROJECT, dryRun: false });
    const first = store.db.prepare('SELECT occurrences, confidence FROM evolve_candidates').get() as { occurrences: number; confidence: number };

    failureProposal(store, 'd3', 'D:\\c.txt', base + 10 * MINUTE);
    store.runEvolution({ projectId: PROJECT, dryRun: false });

    const rows = store.db.prepare('SELECT occurrences, confidence FROM evolve_candidates').all() as Array<{ occurrences: number; confidence: number }>;
    assert.equal(rows.length, 1, '同一签名只能有一行，否则每跑一次就长一行');
    assert.ok(rows[0]!.occurrences > first.occurrences, '重复运行应把新的出现次数并进来');
    assert.ok(rows[0]!.confidence >= first.confidence);
  } finally { store.close(); }
});

test('摘要把运行与候选一起报出来，并且总带上禁止清单', () => {
  const store = new Store(':memory:');
  try {
    const base = 1_700_000_000_000;
    failureProposal(store, 's1', 'D:\\a.txt', base);
    failureProposal(store, 's2', 'D:\\b.txt', base + 5 * MINUTE);
    store.runEvolution({ projectId: PROJECT, dryRun: false });

    const summary = store.evolutionSummary(PROJECT);
    assert.equal(summary.runs.length, 1);
    assert.equal(summary.candidates.length, 1);
    const candidate = summary.candidates[0]!;
    assert.ok(String(candidate.signature).includes('edit::'));
    assert.ok(Number(candidate.occurrences) >= 2);
    assert.ok(String(candidate.reason).length > 0);
  } finally { store.close(); }
});
