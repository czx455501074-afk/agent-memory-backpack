/**
 * EV-CE-02: identical submissions must not become two entries.
 *
 * The evolution audit recorded: "同 discovery 不同幂等 key 形成两候选，人工批准两个 ID 得两条
 * 相同 memory". Idempotency is per (principal, key), so it structurally cannot see
 * this; and `classifyCandidate` compares against *existing knowledge* only, never
 * against the other candidates already in the queue.
 *
 * The design's §6.3 table places "明确重复资料或内容 — 合并重复来源/拒绝重复保存" in the
 * automatic tier, i.e. a deterministically decidable case. So the fix decides it on
 * exact text, and the boundary matters as much as the fix: an approximately similar
 * submission is a possible refinement, and merging those is the semantic judgement
 * the design reserves for review.
 *
 * In-memory store only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

const scope = { kind: 'project', projectId: 'p' } as const;
const TEXT = '导出前先核对设备数量，再执行导出。';

test('EV-CE-02：完全相同的候选不得形成两条，且第二次被告知重复', () => {
  const store = new Store(':memory:', () => 1_700_000_000_000);
  try {
    const first = store.submit('dsh', { idempotencyKey: 'key-a', projectId: 'p', discovery: TEXT });
    const second = store.submit('dsh', { idempotencyKey: 'key-b', projectId: 'p', discovery: TEXT });

    assert.equal(second.id, first.id, '同文本必须合并到既有候选，而不是新建一条');
    assert.equal(second.duplicate, true, '第二次提交必须被明确告知是重复');
    assert.equal((second as { duplicateOf?: string }).duplicateOf, first.id, '必须点名它合并到了哪一条');
    assert.equal(store.listProposals('p').filter(p => p.state === 'pending').length, 1, '队列中只应有一条');

    // Whitespace is not content: a trailing newline is the same submission. Checked
    // while the first candidate is still pending — dedup is about the live queue.
    const padded = store.submit('dsh', { idempotencyKey: 'key-d', projectId: 'p', discovery: `${TEXT}\n  ` });
    assert.equal(padded.duplicate, true, '仅空白差异仍应视为同一内容');
    assert.equal(padded.id, first.id);

    // Approving both ids must not be able to store the content twice. The merged
    // candidate was never inserted, so its id resolves to nothing.
    store.approveProposal(first.id, { id: 'mem-a', kind: 'memory', title: 'rule', scope, body: TEXT });
    assert.throws(
      () => store.approveProposal(second.id, { id: 'mem-b', kind: 'memory', title: 'rule', scope, body: TEXT }),
      (error: unknown) => (error as { code?: string }).code === 'not_found',
      '已被合并的那一条不得再被批准',
    );
    const duplicates = store.allEntries().filter(e => e.content.kind === 'memory' && e.content.body === TEXT);
    assert.equal(duplicates.length, 1, '同正文只应留下一条条目');
  } finally { store.close(); }
});

test('EV-CE-02 边界：相近但不同的内容不得被误并', () => {
  const store = new Store(':memory:', () => 1_700_000_000_000);
  try {
    const first = store.submit('dsh', { idempotencyKey: 'k1', projectId: 'p', discovery: TEXT });

    // A refinement of the same topic: same opening, extra requirement. Merging this
    // would destroy a genuine addition, which is why the check is exact identity.
    const refined = store.submit('dsh', { idempotencyKey: 'k2', projectId: 'p', discovery: `${TEXT}并记录批次号。` });
    assert.notEqual(refined.id, first.id, '细化内容必须作为独立候选保留');
    assert.equal(refined.duplicate, false);
    assert.equal(store.listProposals('p').filter(p => p.state === 'pending').length, 2, '两条不同内容的候选都应保留');

    // A different project is a different queue: the same text there is its own item,
    // because scope is what decides who may see it.
    const otherProject = store.submit('other', { idempotencyKey: 'k3', projectId: 'other', discovery: TEXT });
    assert.notEqual(otherProject.id, first.id, '不同项目的同文本不得互相合并');
    assert.equal(otherProject.duplicate, false);
  } finally { store.close(); }
});

test('EV-CE-02：已裁决的候选不阻断新的同文本提交', () => {
  const store = new Store(':memory:', () => 1_700_000_000_000);
  try {
    const first = store.submit('dsh', { idempotencyKey: 'r1', projectId: 'p', discovery: TEXT });
    store.rejectProposal(first.id, { reason: 'not useful', actor: 'admin', projectId: 'p' });

    // With nothing pending, the same text is a new submission again — dedup is about
    // the live queue, not a permanent tombstone that would silence re-discovery.
    const again = store.submit('dsh', { idempotencyKey: 'r2', projectId: 'p', discovery: TEXT });
    assert.notEqual(again.id, first.id, '既有候选已裁决后，同文本应可重新提交');
    assert.equal(again.duplicate, false);
  } finally { store.close(); }
});
