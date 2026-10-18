import test from 'node:test';
import assert from 'node:assert/strict';
import { distillFailures, confidenceOf, EVOLVE_DEFAULTS, FORBIDDEN_AUTOMATIC, type FailureSignal } from '../src/evolve.js';

/**
 * Stage one: repeated signals become candidates, and nothing else happens.
 *
 * The gates are the deliverable here, not the grouping — an aggregator that turns a retry
 * loop into "a pattern we learned" is worse than no aggregator, because the output looks like
 * knowledge. Each gate gets its own case, and one case asserts the forbidden list is still
 * complete, so a future edit cannot quietly drop an entry.
 */

const MINUTE = 60_000;
const signal = (over: Partial<FailureSignal> & Pick<FailureSignal, 'id' | 'at'>): FailureSignal => ({
  projectId: 'p0',
  signature: 'edit::cannot edit «path»: file changed',
  tool: 'edit',
  observation: 'cannot edit D:\\x.txt: file changed since it was read',
  ...over,
});

test('两次相隔足够久的同类失败会被提为候选', () => {
  const outcome = distillFailures([
    signal({ id: 'a', at: 1_000_000 }),
    signal({ id: 'b', at: 1_000_000 + 5 * MINUTE }),
  ]);
  assert.equal(outcome.candidates.length, 1, `应产出一条候选，跳过项：${JSON.stringify(outcome.skipped)}`);
  const candidate = outcome.candidates[0]!;
  assert.equal(candidate.occurrences, 2);
  assert.deepEqual(candidate.memberIds, ['a', 'b'], '成员按时间排序，供复核时逐条取回');
  assert.equal(candidate.spanMs, 5 * MINUTE);
  assert.ok(['eligible', 'needs_review'].includes(candidate.gate));
  assert.ok(candidate.reason.length > 0, '候选必须自带判定理由，否则无法复核');
});

test('同一秒内重复的不算规律，只是一次重试', () => {
  const outcome = distillFailures([
    signal({ id: 'a', at: 1_000_000 }),
    signal({ id: 'b', at: 1_000_500 }),
  ]);
  assert.equal(outcome.candidates.length, 0, '批量导入或重试循环不得被当成学习信号');
  assert.deepEqual(outcome.skipped.map(row => row.reason), ['too_fast']);
});

test('只出现一次的信号不产出候选', () => {
  const outcome = distillFailures([signal({ id: 'a', at: 1_000_000 })]);
  assert.equal(outcome.candidates.length, 0);
  assert.deepEqual(outcome.skipped.map(row => row.reason), ['below_threshold']);
});

test('没有可读观察的签名不产出候选', () => {
  const outcome = distillFailures([
    signal({ id: 'a', at: 1_000_000, observation: '   ' }),
    signal({ id: 'b', at: 1_000_000 + 5 * MINUTE, observation: '  ' }),
  ]);
  assert.equal(outcome.candidates.length, 0, '无法读出观察文本就无法形成可复核的陈述');
  assert.deepEqual(outcome.skipped.map(row => row.reason), ['no_observation']);
});

test('跨项目的同签名不会合并成一条', () => {
  const outcome = distillFailures([
    signal({ id: 'a', at: 1_000_000, projectId: 'p0' }),
    signal({ id: 'b', at: 1_000_000 + 5 * MINUTE, projectId: 'p1' }),
  ]);
  assert.equal(outcome.candidates.length, 0,
    '两个项目各发生一次是两条线索，合并会让一个项目的候选替另一个项目背书');
  assert.equal(outcome.skipped.length, 2);
});

test('置信度随次数上升但永不等于 1', () => {
  assert.equal(confidenceOf(2), 0.25);
  assert.ok(confidenceOf(5) > confidenceOf(3));
  assert.ok(confidenceOf(10_000) < 1, '重复只说明会复发，不证明结论正确');
});

test('门禁清单没有被删减', () => {
  // The list is the safety argument for the whole pipeline; a test is what makes removing
  // an entry a decision rather than an omission.
  assert.equal(FORBIDDEN_AUTOMATIC.length, 8);
  assert.ok(FORBIDDEN_AUTOMATIC.some(entry => entry.includes('write a knowledge entry')));
  assert.ok(FORBIDDEN_AUTOMATIC.some(entry => entry.includes('norm')));
  assert.ok(FORBIDDEN_AUTOMATIC.some(entry => entry.includes('autoPromotable=false')));
});

test('阈值可调，且默认值被固定下来当作契约', () => {
  assert.deepEqual(EVOLVE_DEFAULTS, { minOccurrences: 2, minSpanMs: 120_000, eligibleConfidence: 0.75 });
  const strict = distillFailures(
    [signal({ id: 'a', at: 1_000_000 }), signal({ id: 'b', at: 1_000_000 + 5 * MINUTE })],
    { ...EVOLVE_DEFAULTS, minOccurrences: 3 },
  );
  assert.equal(strict.candidates.length, 0, '提高门槛后同两条信号不再构成候选');
});
