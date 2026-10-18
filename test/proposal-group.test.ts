import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, autoFailureSignature } from '../src/store.js';

/**
 * A folded group must be disposable in one action.
 *
 * The queue folds repeats by signature, but the members could only be handled one at a
 * time — 43 signatures covering 98 pending rows meant 98 clicks for one decision, so the
 * queue never emptied. The endpoint recomputes the member set from the stored rows rather
 * than accepting the caller's list, because the queue shows only three samples per group:
 * trusting that list would act on the visible part and report success while leaving the
 * rest behind.
 *
 * The fixture builds a real failure shape, because the signature comes from the text —
 * inventing an arbitrary signature string would test nothing but my own string handling.
 */

const PROJECT = 'p0';

/** The shape `autoFailureSignature` recognises: a tool name plus a normalised observation. */
const failure = (observation: string) => [
  '【自动捕获的失败事实；待核实】',
  '所属流程：工具执行与故障恢复；步骤：记录失败、检索已有经验、验证修复。',
  '来源：dsh 会话 fixture；工具：edit。',
  `观察：${observation}`,
  '根因与修复：尚未验证；请主动检索相关经验。',
].join('\n');

/**
 * The fixture has to model the real repetition: the same failure twice, differing only in
 * the parts the signature normalises away (here a filesystem path). Two rows differing in
 * an ordinary word are *not* the same signature — the signature is the tool plus the whole
 * normalised observation — and an earlier draft of this test asserted otherwise.
 */
const repeatFailure = (path: string) => failure(`cannot edit ${path}: file changed since it was read`);

test('按签名一次处置整组，且不动其它候选', () => {
  const store = new Store(':memory:');
  try {
    const first = store.submit('agent', { idempotencyKey: 'g1', projectId: PROJECT, discovery: repeatFailure('D:\\proj\\alpha.txt') });
    const second = store.submit('agent', { idempotencyKey: 'g2', projectId: PROJECT, discovery: repeatFailure('D:\\proj\\beta.txt') });
    const unrelated = store.submit('agent', { idempotencyKey: 'g3', projectId: PROJECT, discovery: '一条普通候选，没有失败签名' });

    const signature = autoFailureSignature(repeatFailure('D:\\proj\\alpha.txt'))!.signature;
    assert.equal(autoFailureSignature(repeatFailure('D:\\proj\\beta.txt'))!.signature, signature,
      '路径差异必须被规范化掉，否则同一失败永远不会被折叠成一组');
    const ids = store.proposalIdsBySignature(PROJECT, signature);
    assert.equal(ids.length, 2, `同一签名的两条都应在集合内，实际 ${ids.length}：${JSON.stringify(ids)}`);
    assert.ok(ids.includes(first.id) && ids.includes(second.id));
    assert.ok(!ids.includes(unrelated.id), '不带签名的候选不得被卷入');

    const result = store.reviewBatch(PROJECT, { action: 'archive', ids, actor: 'human', reason: '同签名重复' });
    assert.equal(result.applied.length, 2, `整组应一次归档，失败项：${JSON.stringify(result.failed)}`);
    assert.equal(store.getProposal(unrelated.id, PROJECT).state, 'pending', '组外候选必须保持待审');
    for (const id of [first.id, second.id]) {
      const proposal = store.getProposal(id, PROJECT);
      assert.equal(proposal.state, 'archived');
      assert.equal(proposal.decision?.actor, 'human', '整组处置同样要记下是谁做的');
    }
  } finally { store.close(); }
});

test('签名不匹配时什么都不做，而不是猜一组', () => {
  const store = new Store(':memory:');
  try {
    store.submit('agent', { idempotencyKey: 'g4', projectId: PROJECT, discovery: repeatFailure('D:\\proj\\gamma.txt') });
    assert.deepEqual(store.proposalIdsBySignature(PROJECT, 'edit\u0000not-a-real-signature'), [],
      '找不到匹配就必须返回空集合，让调用方看到 404，而不是拿一批无关的 id 去执行');
  } finally { store.close(); }
});

test('已处理过的成员不会再次被整组处理', () => {
  const store = new Store(':memory:');
  try {
    const only = store.submit('agent', { idempotencyKey: 'g5', projectId: PROJECT, discovery: repeatFailure('D:\\proj\\delta.txt') });
    const signature = autoFailureSignature(repeatFailure('D:\\proj\\delta.txt'))!.signature;
    store.archiveProposal(only.id, { projectId: PROJECT, actor: 'human' });
    assert.deepEqual(store.proposalIdsBySignature(PROJECT, signature), [],
      '默认只找待审与待补证的条目，归档过的不应再出现在集合里');
  } finally { store.close(); }
});
