import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

/**
 * A queue row has to say when its target can no longer receive it.
 *
 * The core refuses an approval whose workflow target is gone (`target_mismatch` /
 * `revision_conflict`), but the queue said nothing about it: on the real library 6 of 14
 * pending candidates named a workflow that no longer existed, so nearly half the queue
 * was undecidable for a reason only the detail view mentioned — after a click.
 *
 * The annotation is additive and three-valued. `missing` and `moved` need different
 * actions, and a candidate that names no workflow carries no field at all — which the
 * response's `note` states explicitly, so "absent" cannot be read as "server forgot".
 */

const PROJECT = 'p0';
const workflow = (id: string, baseRevision = 0) => ({
  id, kind: 'workflow' as const, title: `流程 ${id}`, scope: { kind: 'project' as const, projectId: PROJECT },
  baseRevision,
  overview: `用于测试 ${id} 的流程入口。`,
  triggers: ['需要验证目标标注'], categories: [['测试']], tags: [],
  preconditions: ['调用方已提供项目上下文'],
  stages: [{ id: 'step', title: '执行', instructions: '执行并核对。', checks: ['结果可核对'], dependencies: [] }],
  completion: ['完成'], recovery: '失败时停止。', isEntryPoint: false,
});

function submit(store: Store, key: string, extra: Record<string, unknown> = {}) {
  return store.submit('agent', {
    idempotencyKey: key, projectId: PROJECT, discovery: `候选 ${key} 的正文`, ...extra,
  });
}

// The queue answers with `items` (candidates and folded groups mixed), not with a field
// per slice. Reading `queue.actionable` here compiled against nothing and failed; the
// shape below is the one the store actually returns.
const rowOf = (store: Store, id: string) => {
  const queue = store.queueProposals(PROJECT, { include: 'all' });
  const items = queue.items as Array<{ id: string; kind?: string }>;
  const found = items.find(item => item.id === id && item.kind !== 'aggregate');
  assert.ok(found, `队列里必须能找到 ${id}；实际返回 ${items.length} 项`);
  return found as unknown as { target?: { workflowId: string; state: string; baseRevision: number | null; currentRevision: number | null } };
};

test('目标流程不存在时，队列行标为 missing', () => {
  const store = new Store(':memory:');
  try {
    const submitted = submit(store, 'wf-missing', { workflowId: 'gone-workflow', baseRevision: 3 });
    const row = rowOf(store, submitted.id);
    assert.ok(row.target, '标注了流程的候选必须带 target');
    assert.equal(row.target.state, 'missing', `目标已不存在，实际 ${JSON.stringify(row.target)}`);
    assert.equal(row.target.workflowId, 'gone-workflow');
    assert.equal(row.target.currentRevision, null);
  } finally { store.close(); }
});

test('目标流程存在但版本已推进时，标为 moved 并给出当前版本', () => {
  const store = new Store(':memory:');
  try {
    store.import([workflow('live-flow') as never]);
    const first = store.db.prepare('SELECT head FROM knowledge WHERE id=?').get('live-flow') as { head: number };
    // Submitted while the workflow was at this revision, so `submit` accepts it.
    const submitted = submit(store, 'wf-moved', { workflowId: 'live-flow', baseRevision: first.head });
    // Then the workflow moves on — the state a candidate drifts into just by waiting.
    store.import([workflow('live-flow', first.head) as never]);
    const current = store.db.prepare('SELECT head FROM knowledge WHERE id=?').get('live-flow') as { head: number };
    assert.equal(current.head, first.head + 1, '夹具必须真的推进了版本');

    const row = rowOf(store, submitted.id);
    assert.equal(row.target?.state, 'moved', `版本已推进，实际 ${JSON.stringify(row.target)}`);
    assert.equal(row.target?.currentRevision, current.head, '必须给出当前版本，否则读者无法重新比对');
  } finally { store.close(); }
});

test('目标流程与版本都吻合时标为 current', () => {
  const store = new Store(':memory:');
  try {
    store.import([workflow('stable-flow') as never]);
    const current = store.db.prepare('SELECT head FROM knowledge WHERE id=?').get('stable-flow') as { head: number };
    const submitted = submit(store, 'wf-current', { workflowId: 'stable-flow', baseRevision: current.head });
    const row = rowOf(store, submitted.id);
    assert.equal(row.target?.state, 'current', `实际 ${JSON.stringify(row.target)}`);
  } finally { store.close(); }
});

test('未标注流程的候选不带 target，且响应里说明了这个缺席', () => {
  const store = new Store(':memory:');
  try {
    const submitted = submit(store, 'wf-none');
    const row = rowOf(store, submitted.id);
    assert.equal(row.target, undefined, '没有目标流程就没有这个字段，而不是伪造一个空壳');
    const queue = store.queueProposals(PROJECT, { include: 'all' });
    assert.match(queue.note, /未标注流程的候选不提供该字段/, '缺席必须在 note 里解释，否则读者分不清“没有”与“服务端漏填”');
    assert.match(queue.note, /missing/, 'note 必须解释三个状态的含义');
  } finally { store.close(); }
});

test('详情视图与队列对同一行给出一致的可用性结论', () => {
  const store = new Store(':memory:');
  try {
    const submitted = submit(store, 'wf-detail', { workflowId: 'never-existed', baseRevision: 1 });
    const queueRow = rowOf(store, submitted.id);
    const detail = store.getProposal(submitted.id, PROJECT);
    assert.equal(queueRow.target?.state, 'missing');
    assert.equal(detail.target.available, false, '两处判据必须同源，否则换一页就换一个答案');
    assert.equal(detail.target.workflowId, 'never-existed');
  } finally { store.close(); }
});
