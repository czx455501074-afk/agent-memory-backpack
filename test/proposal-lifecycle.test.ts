import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

/**
 * The review lifecycle beyond approve and reject.
 *
 * The design asks for four outcomes and a deadline on each, and for batch review so
 * a user is not interrupted per candidate. The interesting cases are the ones a
 * plausible implementation gets subtly wrong: treating "needs evidence" as a
 * rejection, letting a batch cross a project boundary, or reporting a batch as
 * successful when some of it failed.
 */

const clock = { now: 1_700_000_000_000 };
const DAY = 86_400_000;
const open = () => new Store(':memory:', () => clock.now);

function pending(s: Store, key: string, projectId = 'p'): string {
  // The id is a string in practice; the store's return type is a loose record, so
  // the narrowing happens once here rather than at every call site.
  return String(s.submit('agent', { idempotencyKey: key, projectId, discovery: `发现 ${key}` }).id);
}

const entry = (id: string) => ({
  // Project-scoped, matching the proposals: approving a project candidate as a
  // global entry is refused unless the caller asks for it explicitly, and a test
  // that ignored that would be asserting the guard does not exist.
  id, kind: 'memory' as const, title: `条目 ${id}`,
  scope: { kind: 'project' as const, projectId: 'p' }, baseRevision: 0, body: '正文',
});

test('需补证是第四种结果：不批准、也不当假的丢掉，且带期限', () => {
  const s = open();
  try {
    const created = pending(s, 'k1');
    const result = s.requestEvidence(created, '缺少可核对的结果');
    assert.equal(result.state, 'needs_evidence');
    assert.equal(result.dueAt, clock.now + 30 * DAY, '期限按设计的 30 天');

    const item = s.listProposals('p', 'needs_evidence')[0]!;
    assert.match(JSON.stringify(item.payload), /缺少可核对的结果/,
      '请求理由必须留在记录里，否则以后没人知道当初为什么把它挂起来');
    // The distinction from rejection is the point.
    assert.equal(s.listProposals('p', 'rejected').length, 0, '挂起不是拒收');

    // A reason is required: an unexplained hold is indistinguishable from neglect.
    assert.throws(() => s.requestEvidence(created, '  '), /reason|missing|必须/i);
  } finally { s.close(); }
});

test('需补证到期自动归档，而不是无限期留在队列里', () => {
  const s = open();
  try {
    const created = pending(s, 'k1');
    s.requestEvidence(created, '等一个复现');
    clock.now += 31 * DAY;
    const outcome = s.expireProposals();
    assert.deepEqual(outcome.archived, [created], '未补证的请求应转为归档');
    assert.equal(s.listProposals('p', 'needs_evidence').length, 0, '不再留在待补证队列');
    // Archived, not deleted: the record must stay readable.
    assert.equal(s.listProposals('p', 'archived').length, 1, '记录仍在，只是离开了队列');
  } finally { s.close(); }
});

test('未审阅的候选到期作废，记录保留', () => {
  const s = open();
  try {
    const created = pending(s, 'k1');
    clock.now += 31 * DAY;
    const outcome = s.expireProposals();
    assert.deepEqual(outcome.expired, [created]);
    assert.equal(s.listProposals('p', 'pending').length, 0);
  } finally { s.close(); }
});

test('批量审阅逐条报结果，一条失败不拖累其余', () => {
  const s = open();
  try {
    const a = pending(s, 'ka'), b = pending(s, 'kb'), c = pending(s, 'kc');
    const result = s.reviewBatch('p', {
      action: 'approve',
      ids: [a, b, c],
      // Deliberately missing the entry for `b`: that one must fail alone.
      entries: { [a]: entry('ea'), [c]: entry('ec') },
    });
    assert.deepEqual(result.applied.sort(), [a, c].sort(), '其余两条应成功');
    assert.equal(result.failed.length, 1, '失败必须被逐条报出');
    assert.equal(result.failed[0]!.id, b);
    assert.match(result.failed[0]!.message, /No entry|entry/i, '原因要说清是缺条目');

    // The successful ones really took effect; the failed one is still pending.
    assert.equal(s.listProposals('p', 'approved').length, 2);
    assert.equal(s.listProposals('p', 'pending').length, 1);
  } finally { s.close(); }
});

test('批量批准同样受"不得静默提升为全局"约束', () => {
  const s = open();
  try {
    const a = pending(s, 'ka');
    // A batch is a convenient way to approve many at once, which is exactly why the
    // scope guard has to fire here too: without it, one call could promote every
    // project's candidate to a global rule.
    const refused = s.reviewBatch('p', {
      action: 'approve', ids: [a],
      entries: { [a]: { ...entry('ea'), scope: { kind: 'global' } } },
    });
    assert.equal(refused.applied.length, 0, '未声明 allowGlobalScope 时不得提升为全局');
    assert.match(refused.failed[0]!.message, /allowGlobalScope/, '必须说明如何显式允许');

    // Asking deliberately is honoured.
    const allowed = s.reviewBatch('p', {
      action: 'approve', ids: [a],
      entries: { [a]: { ...entry('ea'), scope: { kind: 'global' } } },
      allowGlobalScope: true,
    });
    assert.deepEqual(allowed.applied, [a], '显式声明后应当允许');
  } finally { s.close(); }
});

test('批量操作不得越过项目边界', () => {
  const s = open();
  try {
    const mine = pending(s, 'ka', 'p');
    const theirs = pending(s, 'kb', 'other-project');
    // The ids arrive as a caller-supplied list, which is exactly where a foreign id
    // would otherwise slip through: the outer credential check passes, and nothing
    // looks at the individual proposals.
    const result = s.reviewBatch('p', { action: 'reject', ids: [mine, theirs] });
    assert.deepEqual(result.applied, [mine], '只应处理本项目条目');
    assert.equal(result.failed.length, 1, '外部条目必须被拒绝');
    assert.match(result.failed[0]!.message, /another project/);
    assert.equal(s.listProposals('other-project', 'pending').length, 1, '别项目的候选不受影响');
  } finally { s.close(); }
});

test('批量挂起与归档各自生效', () => {
  const s = open();
  try {
    const a = pending(s, 'ka'), b = pending(s, 'kb');
    const held = s.reviewBatch('p', { action: 'request-evidence', ids: [a], reason: '缺证据' });
    assert.deepEqual(held.applied, [a]);

    const archived = s.reviewBatch('p', { action: 'archive', ids: [b] });
    assert.deepEqual(archived.applied, [b]);
    assert.equal(s.listProposals('p', 'archived').length, 1);
    assert.equal(s.listProposals('p', 'needs_evidence').length, 1);
  } finally { s.close(); }
});

test('已归档的条目不再可被审阅动作改动', () => {
  const s = open();
  try {
    const a = pending(s, 'ka');
    s.archiveProposal(a);
    // Archiving is a decision to set it aside; a later approve would resurrect work
    // the reviewer already put down.
    const again = s.reviewBatch('p', { action: 'reject', ids: [a] });
    assert.equal(again.failed.length, 1, '已归档条目不得再被拒收');
    assert.equal(s.listProposals('p', 'archived').length, 1);
  } finally { s.close(); }
});
