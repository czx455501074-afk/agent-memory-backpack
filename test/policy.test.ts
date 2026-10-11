import test from 'node:test';
import assert from 'node:assert/strict';
import { mayAutoApply, reviewDecision, type ChangeFacts } from '../src/policy.js';
import { Store } from '../src/store.js';

/**
 * The automated-review boundary table (design §6.3).
 *
 * The table is program, not advice: it says an agent "may propose but must not
 * self-approve", and a boundary that exists only in prose is one an adapter can step
 * over by calling the right endpoint. These cases pin each row, with the checks that
 * matter most first — the ones an agent could otherwise make look innocuous.
 */

test('修改审核规则自身必须由用户批准，不能被自动应用', () => {
  const decision = reviewDecision({ intent: 'edit-policy', provenance: 'agent', evidence: 'observed' });
  assert.equal(decision.tier, 'user', '规则自改是设计的用户保留项');
  assert.equal(mayAutoApply(decision), false, 'agent 不得自我批准规则变更');
  assert.match(decision.constraint, /不得由 agent 自行应用/);
});

test('推断出的偏好不得当成用户陈述', () => {
  const decision = reviewDecision({ intent: 'infer-preference', provenance: 'agent', evidence: 'observed' });
  assert.equal(decision.tier, 'user');
  // Even with strong evidence: the design's rule is about who said it, not how
  // well-supported the inference is.
  assert.match(decision.reason, /推断|归纳/);
});

test('扩大作用范围必须由用户决定', () => {
  const taskToProject = reviewDecision({
    intent: 'new-experience', provenance: 'user', evidence: 'observed',
    scopeChange: { from: { kind: 'task', projectId: 'p', taskId: 't' }, to: { kind: 'project', projectId: 'p' } },
  });
  assert.equal(taskToProject.tier, 'user', 'task→project 是扩大，不是同范围修改');

  const toGlobal = reviewDecision({
    intent: 'new-experience', provenance: 'user', evidence: 'observed',
    scopeChange: { from: { kind: 'project', projectId: 'p' }, to: { kind: 'global' } },
  });
  assert.equal(toGlobal.tier, 'user');

  // Narrowing is not a widening and must not be flagged as one.
  const narrowing = reviewDecision({
    intent: 'new-experience', provenance: 'user', evidence: 'observed',
    scopeChange: { from: { kind: 'project', projectId: 'p' }, to: { kind: 'task', projectId: 'p', taskId: 't' } },
  });
  assert.notEqual(narrowing.tier, 'user', '收窄范围不应触发用户裁决');

  // A change that keeps global scope is a revision, not an escalation.
  const stillGlobal = reviewDecision({
    intent: 'new-experience', provenance: 'user', evidence: 'observed',
    scopeChange: { from: { kind: 'global' }, to: { kind: 'global' } },
  });
  assert.notEqual(stillGlobal.tier, 'user');
});

test('真实冲突必须留给用户，不得按最后写入解决', () => {
  const decision = reviewDecision({ intent: 'new-experience', provenance: 'user', evidence: 'verifiable', conflicts: true });
  assert.equal(decision.tier, 'user');
  assert.match(decision.constraint, /不得静默覆盖|保留/);
});

test('用户明确要求替换规范进入审阅，而非用户来源的替换被拒到用户层', () => {
  const byUser = reviewDecision({ intent: 'replace-norm', provenance: 'user', evidence: 'verifiable' });
  assert.equal(byUser.tier, 'review', '用户要求替换仍需核实原话与目标');
  assert.match(byUser.constraint, /旧版本必须留在历史/);

  const byAgent = reviewDecision({ intent: 'replace-norm', provenance: 'agent', evidence: 'verifiable' });
  assert.equal(byAgent.tier, 'user', 'agent 不得替换规范');
});

test('可自动处理的只有可核验的补全与明确的重复', () => {
  for (const intent of ['merge-duplicate', 'fix-typo'] as const) {
    const decision = reviewDecision({ intent, provenance: 'agent', evidence: 'verifiable' });
    assert.equal(decision.tier, 'auto', `${intent} 设计列为可自动处理`);
    assert.equal(mayAutoApply(decision), true);
    // The design's condition, stated so a caller cannot miss it.
    assert.match(decision.constraint, /不得顺带改变到期时间或作用范围/);
  }

  const complete = reviewDecision({ intent: 'complete-source', provenance: 'agent', evidence: 'observed' });
  assert.equal(complete.tier, 'auto', '可核验的来源补全可自动处理');
  assert.match(complete.constraint, /只补全来源，不改写结论/);

  // The same intent with no verifiable basis is not automatic: self-reporting is not
  // evidence, which the design says explicitly.
  const unverified = reviewDecision({ intent: 'complete-source', provenance: 'agent', evidence: 'self-reported' });
  assert.equal(unverified.tier, 'review');
  assert.equal(mayAutoApply(unverified), false);
});

test('自述内容永不被当作已验证证据', () => {
  const decision = reviewDecision({ intent: 'new-experience', provenance: 'agent', evidence: 'self-reported' });
  assert.equal(decision.tier, 'review');
  assert.match(decision.constraint, /自述|不得作为已验证/);

  const unverifiable = reviewDecision({ intent: 'revise-conclusion', provenance: 'external', evidence: 'unverifiable' });
  assert.equal(unverifiable.tier, 'review');
});

test('提交的候选带上层级判定，且判定来自事实而非提交者的声明', () => {
  const s = new Store(':memory:', () => 1_700_000_000_000);
  try {
    const result = s.submit('agent', { idempotencyKey: 'k1', projectId: 'p', discovery: '一条经验' });
    assert.ok(result.review, '候选必须带上审阅层级');
    // A submitted candidate is an agent's own account, so it cannot be automatic —
    // whatever the submitter might claim about it.
    assert.equal(result.review.tier, 'review', 'agent 自述的候选不得自动生效');
    assert.equal(mayAutoApply(result.review), false);

    // The tier is stored with the proposal so a reviewer sees why it needs attention,
    // and a later policy change cannot retroactively make it look low-risk.
    const listed = s.listProposals('p', 'pending')[0]!;
    assert.ok(listed.payload.review, '列表里能看到层级判定');
    assert.equal(listed.payload.review.tier, 'review');
  } finally { s.close(); }
});
