import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

/**
 * Archiving has to leave a decision behind.
 *
 * `reject` always wrote one; `archive` changed the state and nothing else, so
 * `getProposal().decision` came back null and the console's decision line rendered
 * nothing. "Who moved this out, and on what grounds" disappeared — and with it the object
 * an undo would act on. Archiving does not judge whether the claim is true, and the note
 * says so explicitly, so a later reader cannot mistake silence for a verdict.
 */

const PROJECT = 'p0';
const submit = (store: Store, key: string) => store.submit('agent', {
  idempotencyKey: key, projectId: PROJECT, discovery: `候选 ${key} 的正文`,
});

test('归档会记下动作、操作者与理由', () => {
  const store = new Store(':memory:');
  try {
    const { id } = submit(store, 'arc-1');
    store.archiveProposal(id, { projectId: PROJECT, actor: 'dsh:reviewer', reason: '目标流程已下线' });

    const proposal = store.getProposal(id, PROJECT);
    assert.equal(proposal.state, 'archived');
    assert.ok(proposal.decision, '归档必须留下决定记录，否则“谁为什么移走”永久丢失');
    assert.equal(proposal.decision.action, 'archived');
    assert.equal(proposal.decision.actor, 'dsh:reviewer');
    assert.equal(proposal.decision.reason, '目标流程已下线');
    assert.match(String(proposal.decision.note), /未判定真假/, '必须写明归档不是对内容真假的判断');
  } finally { store.close(); }
});

test('没有署名时记为 unattributed，而不是编一个名字', () => {
  const store = new Store(':memory:');
  try {
    const { id } = submit(store, 'arc-2');
    store.archiveProposal(id, { projectId: PROJECT });
    const proposal = store.getProposal(id, PROJECT);
    assert.equal(proposal.decision?.actor, 'unattributed');
    assert.equal(proposal.decision?.reason, undefined, '没有理由就不要凭空补一个');
  } finally { store.close(); }
});

test('已决策的行不能再被归档覆盖', () => {
  const store = new Store(':memory:');
  try {
    const { id } = submit(store, 'arc-3');
    store.rejectProposal(id, { reason: '重复提交', actor: 'human' });
    assert.throws(
      () => store.archiveProposal(id, { projectId: PROJECT, actor: 'someone-else' }),
      (error: { code?: string }) => error.code === 'not_found',
      '归档不得改写一个已经做出决定的行；那是覆盖历史，不是归档',
    );
    assert.equal(store.getProposal(id, PROJECT).decision?.action, 'rejected');
  } finally { store.close(); }
});

test('归档之后仍能重新开启，决定记录随之保留', () => {
  const store = new Store(':memory:');
  try {
    const { id } = submit(store, 'arc-4');
    store.archiveProposal(id, { projectId: PROJECT, actor: 'human', reason: '暂缓' });
    const reopened = store.reopenProposal(id, { actor: 'human' });
    assert.equal(reopened.state, 'pending');
    const proposal = store.getProposal(id, PROJECT);
    assert.equal(proposal.state, 'pending');
    assert.equal(proposal.decision?.action, 'archived', '重新开启是又一次决定，不应抹掉上一次');
  } finally { store.close(); }
});

test('批量归档同样记录操作者', () => {
  const store = new Store(':memory:');
  try {
    const first = submit(store, 'arc-b1');
    const second = submit(store, 'arc-b2');
    const result = store.reviewBatch(PROJECT, {
      action: 'archive', ids: [first.id, second.id], actor: 'dsh:batch', reason: '同一批失效目标',
    });
    assert.equal(result.applied.length, 2, `批量归档应全部成功，失败项：${JSON.stringify(result.failed)}`);
    for (const id of [first.id, second.id]) {
      const decision = store.getProposal(id, PROJECT).decision;
      assert.equal(decision?.action, 'archived');
      assert.equal(decision?.actor, 'dsh:batch');
    }
  } finally { store.close(); }
});
