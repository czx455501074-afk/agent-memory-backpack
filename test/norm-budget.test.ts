/**
 * The norm context budget, on both paths that carry normative text.
 *
 * Design §10 and acceptance 7 require a budget with a visible over-budget report,
 * and forbid that budget from weakening a rule. The audit's F23 found the context
 * unbounded: forty legitimate norms produced 480,687 characters for `prepare` and
 * the same again on every `gate` call.
 *
 * `gate` is the path that matters most in practice — it fires before *every* tool
 * call, so an unbounded gate is the larger cost — and it is the one an earlier fix
 * missed, because the same-revision suppression made the repeat call empty and so
 * hid the missing bound. These cases therefore measure the **first** gate call,
 * with no `knownRevision`, which is the only way the bound is observable.
 *
 * No host, no real library: an in-memory store and a fixed clock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

const scope = { kind: 'project', projectId: 'p' } as const;

/** Forty norms near the 12,000-character per-entry maximum — the audit's fixture. */
function bigLibrary(store: Store) {
  store.import(Array.from({ length: 40 }, (_, index) => ({
    id: `norm-${String(index).padStart(2, '0')}`, kind: 'norm' as const, title: `norm ${index}`,
    scope, body: 'N'.repeat(11_900),
    // One entry states a prohibition: it must never be dropped for size.
    deniedTools: index === 7 ? ['danger-tool'] : [],
  })));
}

test('规范上下文预算：prepare 与 gate 都受约束，且超预算可见', () => {
  const store = new Store(':memory:');
  try {
    bigLibrary(store);

    // prepare: bounded, and the omissions are itemised with reasons.
    const prepared = store.prepare('p', 'probe');
    assert.ok(prepared.context.length <= 20_000,
      `prepare 上下文必须受预算约束，实际 ${prepared.context.length} 字符`);
    assert.equal(prepared.budget.limitChars, store.normBudgetChars);
    assert.ok(prepared.budget.omitted.length > 0, '超预算条目必须被列出，而不是静默丢弃');
    assert.ok(prepared.budget.omitted.every(item => item.reason), '每条省略都要给出原因');
    assert.match(prepared.context, /预算/, '上下文本身要说明发生了省略');

    // gate, first call: the same ceiling. Measured without `knownRevision` because
    // the suppression would otherwise empty the context and hide an absent bound.
    const firstGate = store.gate('p', 'read');
    assert.ok(firstGate.context.length <= 20_000,
      `gate 首次调用必须同样受预算约束，实际 ${firstGate.context.length} 字符`);
    assert.equal(firstGate.budget.limitChars, store.normBudgetChars);
    assert.ok(firstGate.budget.omitted.length > 0, 'gate 的超预算条目也要列出');
    assert.match(firstGate.context, /预算/, 'gate 上下文也要说明省略');

    /**
     * Ten tool calls in one session, which is the quantity the audit measured
     * (4,806,290 characters). The assertion is deliberately loose — it guards the
     * order of magnitude, not a particular number, so an ordinary tuning change
     * does not fail it while a return to unbounded text does.
     */
    let tenCalls = 0;
    for (let index = 0; index < 10; index += 1) tenCalls += store.gate('p', 'read').context.length;
    assert.ok(tenCalls < 4_806_290 / 10,
      `十次 gate 累计字符应远低于审计基线的十分之一，实际 ${tenCalls}`);
  } finally { store.close(); }
});

test('预算不得裁掉硬约束：被禁止的工具仍必须拒绝', () => {
  const store = new Store(':memory:');
  try {
    bigLibrary(store);

    // The prohibiting norm is included whatever the budget, and the decision list
    // is complete regardless — a budget that weakened either would be worse than
    // the unbounded context it replaced.
    const blocked = store.gate('p', 'danger-tool');
    assert.equal(blocked.decision, 'deny', '预算不得让被禁止的工具变为放行');
    assert.ok(blocked.deniedTools.includes('danger-tool'), '禁止清单一律完整返回');

    // And it stays enforced on the repeat call, where the prose is suppressed.
    const repeat = store.gate('p', 'danger-tool', { knownRevision: store.revision });
    assert.equal(repeat.decision, 'deny', '同版本抑制正文时判定仍必须完整');
    assert.equal(repeat.context, '', '同版本不重复发送正文');
    assert.equal(repeat.contextUnchanged, true);
    assert.ok(repeat.deniedTools.includes('danger-tool'));

    // An ordinary tool is still allowed: the budget must not make everything deny.
    assert.equal(store.gate('p', 'read').decision, 'allow');
  } finally { store.close(); }
});

/**
 * Reading norms must not parse the rest of the library.
 *
 * The audit noted that `current()` reads and decodes every active entry even when a
 * caller only needs norms, and a gate fires before every tool call — so at 5,000
 * entries it spent ~98% of its time decoding entries it immediately discarded,
 * measured at 48ms median against 0.57ms for the norm rows alone.
 *
 * A timing assertion would be flaky, so this checks the *behaviour* that makes the
 * saving possible and that a narrowing must preserve: the same rows come back, the
 * order is stable, and non-norm kinds are still reachable through their own paths.
 */
test('只读取规范时不得连带解析其它类型，且结果与全量读取一致', () => {
  const store = new Store(':memory:');
  try {
    store.import([
      { id: 'n-1', kind: 'norm', title: 'n1', scope, body: 'RULE-ONE', deniedTools: [] },
      { id: 'n-2', kind: 'norm', title: 'n2', scope, body: 'RULE-TWO', deniedTools: ['blocked'] },
      { id: 'm-1', kind: 'memory', title: 'm1', scope, body: 'MEMORY' },
      { id: 's-1', kind: 'skill', title: 's1', scope, body: 'SKILL', leaves: [] },
      { id: 'p-1', kind: 'preference', title: 'p1', scope, body: 'PREF' },
      { id: 'j-1', kind: 'journal', title: 'j1', scope, did: 'DID', outcome: 'unverified' as const },
    ]);

    const norms = store.norms('p');
    assert.deepEqual(norms.map(n => n.id), ['n-1', 'n-2'], '只应返回规范，且顺序稳定');
    // `norms()` returns a union because it spreads the entry content; narrow to the
    // norm member rather than asserting on the union.
    const first = norms.find(n => n.id === 'n-1');
    assert.equal(first && 'body' in first ? first.body : undefined, 'RULE-ONE');

    // The other kinds must remain fully reachable — the narrowing must not hide them.
    const all = store.scopedEntries('p').map(entry => entry.id).sort();
    assert.deepEqual(all, ['j-1', 'm-1', 'n-1', 'n-2', 'p-1', 's-1'], '其它类型必须仍然可见');
    assert.ok(store.searchUniversal('p', '').some(entry => entry.id === 'm-1'), '记忆仍可被检索');
    assert.equal(store.readKnowledge('p', 's-1').body, 'SKILL');

    // A norm-scoped prohibition still gates, and a non-norm's absence from the norm
    // set must not change any decision.
    assert.equal(store.gate('p', 'blocked').decision, 'deny');
    assert.equal(store.gate('p', 'other').decision, 'allow');

    // Material expiry still filters material — the TTL gate belongs to that kind and
    // must not have been lost with the narrowing of the norm read.
    const past = Date.now() - 86_400_000;
    store.import([{
      id: 'mat-expired', kind: 'material', title: 'old', scope, url: 'https://example.invalid/old',
      summary: 'S', body: 'OLD-BODY', fingerprint: 'fp', savedAt: past - 1000, expiresAt: past,
    }]);
    assert.equal(store.liveMaterial('p').some(m => m.id === 'mat-expired'), false, '到期资料仍被过滤');
    assert.equal(store.searchUniversal('p', 'OLD-BODY').some(e => e.id === 'mat-expired'), false, '到期资料仍不被检索召回');
  } finally { store.close(); }
});
