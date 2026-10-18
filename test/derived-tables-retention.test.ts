import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

/**
 * Two derived tables, two different shapes of leak.
 *
 * `revision_notifications` gains one row per version bump and is only read as "the most
 * recent 20" — on the real library it held 2,608 rows against ~850 entries. `model_reviews`
 * is keyed by proposal id so it cannot outgrow the candidate table, but a proposal removed by
 * a restore leaves its review unreachable.
 *
 * Both cleanups run in `cleanup()`, which is the maintenance tick's job — not a side effect of
 * asking for stats (that distinction is pinned by `stats-read-only.test.ts`).
 */

const PROJECT = 'p0';

const notify = (store: Store, revision: number) =>
  store.db.prepare('INSERT OR IGNORE INTO revision_notifications(revision,payload,created_at) VALUES(?,?,?)')
    .run(revision, JSON.stringify({ revision }), revision);

test('版本通知只保留最近 500 条，且留下的是最新的', () => {
  const store = new Store(':memory:');
  try {
    for (let revision = 1; revision <= 620; revision += 1) notify(store, revision);
    assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM revision_notifications').get()!.n), 620);

    store.cleanup();
    const rows = store.db.prepare('SELECT revision FROM revision_notifications ORDER BY revision').all() as Array<{ revision: number }>;
    assert.equal(rows.length, 500, `应保留 500 条，实际 ${rows.length}`);
    assert.equal(Number(rows[0]!.revision), 121, '被删的应是最早的那些');
    assert.equal(Number(rows[rows.length - 1]!.revision), 620, '最新一条必须还在');
  } finally { store.close(); }
});

test('候选消失后，它的模型评审记录不会再留着', () => {
  const store = new Store(':memory:');
  try {
    const { id } = store.submit('agent', { idempotencyKey: 'mv-1', projectId: PROJECT, discovery: '候选正文' });
    store.db.prepare('INSERT INTO model_reviews(proposal_id,project_id,result,updated_at) VALUES(?,?,?,?)')
      .run(id, PROJECT, '{}', 1);
    store.db.prepare('INSERT INTO model_reviews(proposal_id,project_id,result,updated_at) VALUES(?,?,?,?)')
      .run('ghost-proposal', PROJECT, '{}', 1);

    store.cleanup();
    const left = store.db.prepare('SELECT proposal_id FROM model_reviews').all()
      .map(row => String((row as { proposal_id: string }).proposal_id));
    assert.deepEqual(left, [id], `孤儿评审应被清掉、真实候选的评审应保留，实际 ${JSON.stringify(left)}`);
  } finally { store.close(); }
});

test('清理不碰仍在使用的候选与知识', () => {
  const store = new Store(':memory:');
  try {
    const { id } = store.submit('agent', { idempotencyKey: 'mv-keep', projectId: PROJECT, discovery: '候选正文' });
    store.import([{ id: 'entry-keep', kind: 'memory', title: '条目', scope: { kind: 'global' }, baseRevision: 0, body: '正文' }]);
    store.cleanup();
    assert.equal(store.getProposal(id, PROJECT).state, 'pending', '待审候选不受派生表清理影响');
    assert.ok(store.db.prepare('SELECT count(*) AS n FROM knowledge WHERE id=?').get('entry-keep')!.n);
  } finally { store.close(); }
});
