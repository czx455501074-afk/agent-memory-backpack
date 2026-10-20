import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.js';
import { captureSupport } from '../src/evidence.js';

const scope = { kind: 'project' as const, projectId: 'p' };
const entry = (id: string) => ({ id, kind: 'memory' as const, title: '恢复判据', scope, body: '适用：恢复配置。验证：独立复算摘要与清单。' });

test('adoption retains sanitized evidence snapshots and intake ownership even after proposal payload removal', () => {
  const store = new Store(':memory:', () => 1234);
  try {
    store.startTaskForSession('p', 'session-1', '恢复验证');
    const task = store.taskForSession('p', 'session-1')!;
    const receipt = store.submit('adapter', { projectId: 'p', taskId: task.id, sessionId: 'session-1', idempotencyKey: 'proof',
      discovery: entry('adopted').body, evidence: '回归验证：2 passed',
      evidenceRefs: [{ kind: 'command', locator: 'node verification/check.mjs', snapshot: '2 passed; SNAPSHOTONLYTOKEN', snapshotHash: '0'.repeat(64), result: 'exit 0', observedAt: 1200 }] });
    assert.equal(receipt.evidenceStatus, 'captured');
    store.approveProposal(receipt.id, entry('adopted'), { projectId: 'p', classificationAcknowledged: true });
    store.db.prepare('UPDATE proposals SET payload=? WHERE id=?').run('{}', receipt.id);
    const saved = store.readKnowledge('p', 'adopted').support!;
    assert.equal(saved.origin.principal, 'adapter');
    assert.equal(saved.origin.taskId, task.id);
    assert.deepEqual(saved.origin.sessionIds, ['session-1']);
    assert.equal(saved.summary, '回归验证：2 passed');
    assert.equal(saved.references[0]!.snapshotHash, createHash('sha256').update(saved.references[0]!.snapshot!).digest('hex'));
    assert.equal(store.searchUniversal('p', 'SNAPSHOTONLYTOKEN').length, 0, 'snapshot does not become normalized knowledge');
    store.rebuildSearchIndex();
    assert.equal(store.searchUniversal('p', 'SNAPSHOTONLYTOKEN').length, 0);
  } finally { store.close(); }
});

test('same claim with different evidence keeps independent receipts instead of silently dropping proof', () => {
  const store = new Store(':memory:');
  try {
    const payload = { projectId: 'p', idempotencyKey: 'one', discovery: entry('x').body, evidenceRefs: [{ kind: 'artifact' as const, locator: 'report.json', snapshot: 'first observation' }] };
    const a = store.submit('adapter', payload);
    const same = store.submit('adapter', { ...payload, idempotencyKey: 'two' });
    assert.equal(same.duplicateOf, a.id);
    const different = store.submit('adapter', { ...payload, idempotencyKey: 'three', evidenceRefs: [{ ...payload.evidenceRefs[0]!, snapshot: 'new counterexample' }] });
    assert.notEqual(different.id, a.id);
    assert.equal(different.duplicate, false);
    assert.equal(store.submit('adapter', payload).duplicate, true);
  } finally { store.close(); }
});

test('legacy candidate evidence and supplements survive adoption; absent evidence stays explicitly missing', () => {
  const store = new Store(':memory:');
  try {
    const receipt = store.submit('adapter', { projectId: 'p', idempotencyKey: 'legacy', discovery: entry('legacy').body, evidence: 'original check' });
    const row = store.db.prepare('SELECT payload FROM proposals WHERE id=?').get(receipt.id)!;
    const payload = JSON.parse(String(row.payload)); delete payload.support; delete payload.evidenceRefs;
    store.db.prepare('UPDATE proposals SET payload=? WHERE id=?').run(JSON.stringify(payload), receipt.id);
    store.requestEvidence(receipt.id, '补充复算', { projectId: 'p' });
    store.supplementEvidence(receipt.id, 'independent repeat check', { projectId: 'p', actor: 'human' });
    store.approveProposal(receipt.id, entry('legacy'), { projectId: 'p', classificationAcknowledged: true });
    assert.equal(store.readKnowledge('p', 'legacy').support!.supplements[0]!.evidence, 'independent repeat check');
    const noEvidence = store.submit('adapter', { projectId: 'p', idempotencyKey: 'missing', discovery: '适用：生成备份。验证：按清单核对，尚无证据附件。' });
    assert.equal(noEvidence.evidenceStatus, 'missing');
    // Nothing is blocked and nothing is asked of a reviewer: the entry is adopted, and the
    // plugin marks it itself. The protection is that a waived entry never becomes advice.
    store.approveProposal(noEvidence.id, entry('missing'), { projectId: 'p', classificationAcknowledged: true });
    const waived = store.readKnowledge('p', 'missing').support!;
    assert.equal(waived.status, 'missing');
    assert.match(waived.waiver!.reason, /无证据/);
    assert.equal(store.prepare('p', '恢复判据', { selectedIds: ['missing'], selectionSource: 'model' }).knowledge.length, 0);
  } finally { store.close(); }
});

test('checkpoint snapshots and source sessions survive journal storage and later stop checkpoints', () => {
  const store = new Store(':memory:', () => 2000);
  try {
    const first = store.checkpointTask('adapter', { projectId: 'p', sessionId: 'session', verified: '核对清单通过', evidence: 'verifiable',
      evidenceRefs: [{ kind: 'artifact', locator: 'report.json', snapshot: '{"passed":2}' }] });
    let journal = store.readKnowledge('p', String(first.journalId));
    assert.equal(journal.support!.references[0]!.snapshot, '{"passed":2}');
    assert.equal(journal.support!.summary, '核对清单通过');
    store.checkpointTask('adapter', { projectId: 'p', sessionId: 'session', summary: '回合停止，任务仍未完' });
    journal = store.readKnowledge('p', String(first.journalId));
    assert.equal(journal.support!.references[0]!.snapshot, '{"passed":2}');
    assert.deepEqual(journal.support!.origin.sessionIds, ['session']);
  } finally { store.close(); }
});

test('capture redacts credentials before hashing and never asserts plugin verification', () => {
  const support = captureSupport({ kind: 'proposal', id: 'p', principal: 'agent', projectId: 'project', sessionIds: [], capturedAt: 1 },
    '', [{ kind: 'artifact', locator: 'report', snapshot: 'api_key=sk-abcdefghijklmnopqrstuvwxyz0123456789' }]);
  assert(!support.references[0]!.snapshot!.includes('sk-abcdefghijklmnopqrstuvwxyz0123456789'));
  assert.equal(support.status, 'captured');
});
