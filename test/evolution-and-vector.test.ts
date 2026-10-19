import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createRetrievalService } from '../src/retrieval-service.js';

/**
 * Two evolution-pipeline defects and one wiring defect, all measured before the fixes.
 *
 * 1. Promoting a candidate twice threw `idempotency_conflict` once its counts moved,
 *    because the key was stable and the payload was not. A refreshed candidate is the
 *    same finding, so the second promotion has to answer "already filed".
 * 2. The model term bridge ran ten entries per *knowledge version*: its job key carried
 *    the revision, and saving a bridge never bumps it. A library with a hundred entries
 *    waiting therefore waited for a revision nothing was going to create.
 * 3. The vector half of retrieval accepted a `projectId` and ignored it, so another
 *    project's vectors could take the top slots and leave this project with nothing.
 */

const MODEL = 'stub-embed';
const CONFIG = { endpoint: 'https://embeddings.example.invalid/v1', model: MODEL };

function seedCandidate(store: Store, signature: string, projectId: string) {
  const now = Date.now();
  store.db.prepare(`INSERT INTO evolve_runs(id,project_id,started_at,scanned,distilled,skipped,dry_run,thresholds,knowledge_revision)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(`run-${signature}`, projectId, now, 2, 1, '[]', 0, '{}', store.revision);
  store.db.prepare(`INSERT INTO evolve_candidates(id,run_id,project_id,signature,tool,observation,occurrences,span_ms,
    first_seen_at,last_seen_at,member_ids,confidence,gate,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(`cand-${signature}`, `run-${signature}`, projectId, signature, 'edit',
      'cannot write fixture after it changed', 2, 7_200_000, now - 7_200_000, now, '["a","b"]',
      0.9, 'eligible', 'repeated', now);
}

test('候选计数变化后再次晋升仍返回同一条提案，而不是冲突', () => {
  const store = new Store(':memory:');
  try {
    seedCandidate(store, 'SIG-REFRESH', 'alpha');
    const first = store.promoteEvolution({ projectId: 'alpha', dryRun: false });
    assert.equal(first.promoted.length, 1);
    assert.equal(first.promoted[0]!.duplicate, false);
    const proposalId = first.promoted[0]!.proposalId;
    assert.ok(proposalId, '第一次晋升应产生提案');

    // The candidate is refreshed in place by the next pass.
    store.db.prepare('UPDATE evolve_candidates SET occurrences=occurrences+1, last_seen_at=last_seen_at+60000 WHERE signature=?')
      .run('SIG-REFRESH');

    const second = store.promoteEvolution({ projectId: 'alpha', dryRun: false });
    assert.equal(second.promoted.length, 1, '刷新后的候选仍应被处理，而不是抛错');
    assert.equal(second.promoted[0]!.duplicate, true, '第二次必须是 duplicate');
    assert.equal(second.promoted[0]!.proposalId, proposalId, '必须指回同一条提案');
    const count = store.db.prepare('SELECT count(*) AS n FROM proposals').get() as { n: number };
    assert.equal(Number(count.n), 1, '不得产生第二条提案');
  } finally { store.close(); }
});

test('术语桥的批次键随已补数量推进，不随知识版本停住', () => {
  const store = new Store(':memory:');
  try {
    store.import(Array.from({ length: 3 }, (_, index) => ({
      id: `bridge-${index}`, kind: 'memory' as const, title: `条目 ${index}`,
      body: `正文 ${index}`, scope: { kind: 'global' as const }, baseRevision: 0,
    })));
    const revision = store.revision;
    assert.equal(store.bridgeCount(), 0);

    store.saveBridge([{ id: 'bridge-0', revision: 1, model: MODEL, aliases: ['别名'], keywords: [], summary: '摘要' }]);
    assert.equal(store.revision, revision, '写桥不得改变知识版本（这正是旧键停住的原因）');
    assert.equal(store.bridgeCount(), 1);

    // The key the worker uses now moves because the count moved.
    const first = store.jobs.enqueue('term_bridge', `term_bridge:alpha:${0}`, { projectId: 'alpha', limit: 10 });
    const second = store.jobs.enqueue('term_bridge', `term_bridge:alpha:${store.bridgeCount()}`, { projectId: 'alpha', limit: 10 });
    assert.notEqual(first, second, '已补数量变化必须是新的作业键，否则第二批永远不会跑');
  } finally { store.close(); }
});

test('向量检索只看本项目可见的条目', async () => {
  const store = new Store(':memory:');
  try {
    // Project alpha owns one entry; project beta owns five and has vectors on all of them.
    store.import([{ id: 'a-only', kind: 'memory', title: '甲', body: '甲项目的条目。',
      scope: { kind: 'project', projectId: 'alpha' }, baseRevision: 0 }]);
    store.import(Array.from({ length: 5 }, (_, index) => ({
      id: `b-${index}`, kind: 'memory' as const, title: `乙 ${index}`, body: `乙项目条目 ${index}。`,
      scope: { kind: 'project' as const, projectId: 'beta' }, baseRevision: 0,
    })));
    store.saveEmbeddings([
      { id: 'a-only', revision: 1, model: MODEL, vector: [0, 1] },
      ...Array.from({ length: 5 }, (_, index) => ({ id: `b-${index}`, revision: 1, model: MODEL, vector: [1, 0] })),
    ]);

    const service = createRetrievalService(store, 'C:/nonexistent-fixture', {
      embeddings: CONFIG,
      embed: async () => [[1, 0]],
    });
    const selection = await service('alpha', '完全没有词法匹配的查询');

    const foreign = selection.selectedIds.filter(id => id.startsWith('b-'));
    assert.deepEqual(foreign, [], `不得选出他项目条目：${selection.selectedIds.join(',')}`);
    for (const id of selection.selectedIds) {
      assert.equal(id.startsWith('b-'), false, 'selectedIds 不得越界');
    }
  } finally { store.close(); }
});
