import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { collect, proposalSourceFrom, REFINE_DEFAULTS } from '../src/refine.js';

/**
 * Repetition does not stop counting when a candidate leaves the queue.
 *
 * The refinement source used to read `pending`/`needs_evidence` only, so a failure whose
 * candidate was rejected or expired became invisible at exactly the point its evidence was
 * strongest — it kept recurring. `evolve.ts` was widened for that reason; this source kept
 * the old filter, so the two tools that exist to find repetitions disagreed about where to
 * look. `collect` never branches on state, so widening the read changes which rows it sees,
 * not what it concludes.
 */

const PROJECT = 'p0';
const MINUTE = 60_000;

const failure = (path: string) => [
  '【自动捕获的失败事实；待核实】',
  '所属流程：工具执行与故障恢复；步骤：记录失败、检索已有经验、验证修复。',
  '来源：dsh 会话 fixture；工具：edit。',
  `观察：cannot edit ${path}: file changed since it was read`,
  '根因与修复：尚未验证；请主动检索相关经验。',
].join('\n');

const meta = () => undefined; // defaults only

test('被拒收的同类失败仍应计入重复', () => {
  const store = new Store(':memory:');
  try {
    const base = 1_700_000_000_000;
    const pending = store.submit('agent', { idempotencyKey: 'r1', projectId: PROJECT, discovery: failure('D:\\a.txt') });
    const rejected = store.submit('agent', { idempotencyKey: 'r2', projectId: PROJECT, discovery: failure('D:\\b.txt') });
    store.db.prepare('UPDATE proposals SET created_at=? WHERE id=?').run(base, pending.id);
    store.db.prepare('UPDATE proposals SET created_at=? WHERE id=?').run(base + 10 * MINUTE, rejected.id);
    store.rejectProposal(rejected.id, { reason: '单次失败不构成经验', actor: 'human' });

    const source = proposalSourceFrom(store.db as never, [PROJECT]);
    const rows = source.all();
    assert.equal(rows.length, 2, `被拒收的候选必须仍被读到，实际读到 ${rows.length} 条`);
    assert.ok(rows.some(row => row.id === rejected.id), '拒收不等于从未发生');

    const run = collect({ source, meta, now: base + 60 * MINUTE });
    assert.equal(run.groups, 1, `两条同类失败应在同一签名下，实际分组数 ${run.groups}`);
    assert.equal(run.thresholds.minOccurrences, REFINE_DEFAULTS.minOccurrences);
  } finally { store.close(); }
});

test('只有一条时仍按阈值挡下（放宽来源不等于放宽门槛）', () => {
  const store = new Store(':memory:');
  try {
    const { id } = store.submit('agent', { idempotencyKey: 'r3', projectId: PROJECT, discovery: failure('D:\\c.txt') });
    store.db.prepare('UPDATE proposals SET created_at=? WHERE id=?').run(1_700_000_000_000, id);
    const run = collect({ source: proposalSourceFrom(store.db as never, [PROJECT]), meta, now: 1_700_000_000_000 + MINUTE });
    assert.equal(run.suggestions.length, 0, '单个失败仍然不构成重复，门槛没有被放宽');
  } finally { store.close(); }
});
