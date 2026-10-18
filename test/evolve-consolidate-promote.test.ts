import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

/**
 * Stages two and three: relate, then propose — and never write knowledge.
 *
 * The promotion stage is the only place the pipeline produces something a person will see in
 * the review queue, so the assertions that matter are about where it stops: a `pending`
 * proposal appears, the knowledge revision does not move, and nothing is approved on the
 * candidate's behalf.
 */

const PROJECT = 'p0';
const DAY = 86_400_000;
const MINUTE = 60_000;

const failureProposal = (store: Store, key: string, path: string, at: number, extra = '') => {
  const discovery = [
    '【自动捕获的失败事实；待核实】',
    '所属流程：工具执行与故障恢复；步骤：记录失败、检索已有经验、验证修复。',
    '来源：dsh 会话 fixture；工具：edit。',
    `观察：cannot edit ${path}: file changed since it was read${extra}`,
    '根因与修复：尚未验证；请主动检索相关经验。',
  ].join('\n');
  const { id } = store.submit('agent', { idempotencyKey: key, projectId: PROJECT, discovery });
  store.db.prepare('UPDATE proposals SET created_at=? WHERE id=?').run(at, id);
  return id;
};

/** Seed one distilled candidate directly; stage one is covered by its own tests. */
const seedCandidate = (store: Store, signature: string, observation: string, over: { occurrences?: number; lastSeenAt?: number; confidence?: number; gate?: string } = {}) => {
  const now = store['now']();
  store.db.prepare(`INSERT INTO evolve_candidates(
      id, run_id, project_id, signature, tool, observation, occurrences, span_ms,
      first_seen_at, last_seen_at, member_ids, confidence, gate, reason, created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(`cand-${signature}`, 'run-fixture', PROJECT, signature, 'edit', observation,
      over.occurrences ?? 5, 5 * MINUTE, now - 10 * DAY, over.lastSeenAt ?? now - DAY,
      JSON.stringify(['a', 'b']), over.confidence ?? 0.9, over.gate ?? 'eligible', 'fixture', now);
};

test('相似写法被连成重复关系，且方向指向证据更多的那条', () => {
  const store = new Store(':memory:');
  try {
    seedCandidate(store, 'edit::alpha', 'cannot edit D:/a.txt file changed since it was read', { occurrences: 3 });
    seedCandidate(store, 'edit::alpha-2', 'cannot edit D:/b.txt file changed since it was read', { occurrences: 9 });

    const preview = store.consolidateEvolution({ projectId: PROJECT });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.links.length, 1, `应识别出一对近似，实际：${JSON.stringify(preview.links)}`);
    const link = preview.links[0]!;
    assert.equal(link.relation, 'duplicate_of');
    assert.equal(link.toSignature, 'edit::alpha-2', '关系应指向出现次数更多的那条');
    assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM evolve_links').get()!.n), 0, '预演不写关系');
  } finally { store.close(); }
});

test('关系写入是幂等的：重跑不会堆行', () => {
  const store = new Store(':memory:');
  try {
    seedCandidate(store, 'edit::beta', 'cannot edit D:/a.txt file changed since it was read', { occurrences: 3 });
    seedCandidate(store, 'edit::beta-2', 'cannot edit D:/b.txt file changed since it was read', { occurrences: 9 });

    const first = store.consolidateEvolution({ projectId: PROJECT, dryRun: false });
    assert.equal(first.linked, 1);
    const second = store.consolidateEvolution({ projectId: PROJECT, dryRun: false });
    assert.equal(second.linked, 0, '同一对关系第二次不应再写入');
    assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM evolve_links').get()!.n), 1);
  } finally { store.close(); }
});

test('安静很久的候选被报为过期，但不被删除', () => {
  const store = new Store(':memory:');
  try {
    const now = store['now']();
    seedCandidate(store, 'edit::old', 'cannot edit D:/a.txt file changed', { lastSeenAt: now - 40 * DAY });
    seedCandidate(store, 'edit::new', 'cannot open D:/b.txt permission denied', { lastSeenAt: now - DAY });

    const result = store.consolidateEvolution({ projectId: PROJECT });
    assert.equal(result.stale.length, 1, `应只有一条过期，实际 ${JSON.stringify(result.stale)}`);
    assert.equal(result.stale[0]!.signature, 'edit::old');
    assert.match(result.stale[0]!.reason, /天没有再出现/);
    assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM evolve_candidates').get()!.n), 2,
      '过期只是报出来，不删行——过去发生过的问题是事实');
  } finally { store.close(); }
});

test('升级只产出待审提案，知识库不动、也不替人批准', () => {
  const store = new Store(':memory:');
  try {
    seedCandidate(store, 'edit::promote', 'cannot edit D:/a.txt file changed since it was read');
    const beforeRevision = store.revision;
    const beforeProposals = Number(store.db.prepare('SELECT count(*) AS n FROM proposals').get()!.n);

    const preview = store.promoteEvolution({ projectId: PROJECT });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.promoted.length, 1, '预演应说明会提交哪一条');
    assert.equal(preview.promoted[0]!.proposalId, null);
    assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM proposals').get()!.n), beforeProposals, '预演不得建提案');

    const applied = store.promoteEvolution({ projectId: PROJECT, dryRun: false });
    assert.equal(applied.promoted.length, 1);
    assert.ok(applied.promoted[0]!.proposalId);
    assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM proposals').get()!.n), beforeProposals + 1);
    assert.equal(store.revision, beforeRevision, '提交提案不是批准，知识版本不得变化');

    const proposal = store.getProposal(applied.promoted[0]!.proposalId!, PROJECT);
    assert.equal(proposal.state, 'pending', '必须停在待审，不能自行生效');
    assert.match(String((proposal.payload as Record<string, unknown>).discovery), /【进化候选；待核】/);
  } finally { store.close(); }
});

test('重复升级是同一个提案，而不是第二条', () => {
  const store = new Store(':memory:');
  try {
    seedCandidate(store, 'edit::idem', 'cannot edit D:/a.txt file changed since it was read');
    const first = store.promoteEvolution({ projectId: PROJECT, dryRun: false });
    const second = store.promoteEvolution({ projectId: PROJECT, dryRun: false });
    assert.equal(second.promoted[0]!.duplicate, true, '第二次必须是 duplicate，否则同一发现会被反复提交');
    assert.equal(second.promoted[0]!.proposalId, first.promoted[0]!.proposalId);
    assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM proposals').get()!.n), 1);
  } finally { store.close(); }
});

test('门禁未通过的候选不会被升级', () => {
  const store = new Store(':memory:');
  try {
    seedCandidate(store, 'edit::review', 'cannot edit D:/a.txt file changed', { gate: 'needs_review', confidence: 0.25 });
    const result = store.promoteEvolution({ projectId: PROJECT, dryRun: false });
    assert.equal(result.promoted.length, 0, 'needs_review 的候选必须留给人，不能被流水线推上去');
    assert.equal(result.withheld.length, 1);
    assert.match(result.withheld[0]!.reason, /needs_review/);
    assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM proposals').get()!.n), 0);
  } finally { store.close(); }
});
