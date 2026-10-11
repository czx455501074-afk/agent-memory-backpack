import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { type KnowledgeDraft } from '../src/schema.js';

/**
 * Retrieval reasons, coverage gaps, and rejected-proposal retention.
 *
 * The design requires each retrieved item to be able to answer *why it was
 * retrieved*, and requires the retrieval reason and known gaps to be recorded so a
 * missed recall can be investigated later. The case that matters most is the query
 * that found nothing: without a record it leaves no trace, and "it did not find
 * that" becomes unanswerable.
 */

function store(): Store {
  const s = new Store(':memory:', () => 1_700_000_000_000);
  s.import([
    { id: 'k-export', kind: 'memory', title: '导出流程', scope: { kind: 'global' }, baseRevision: 0, body: '导出数据的命令与参数。' },
    { id: 'k-migrate', kind: 'memory', title: '迁移记录', scope: { kind: 'global' }, baseRevision: 0, body: '迁移到另一台设备的过程。' },
    { id: 'k-other', kind: 'memory', title: '颜色校正', scope: { kind: 'global' }, baseRevision: 0, body: '色彩空间与查找表。' },
  ] as KnowledgeDraft[]);
  return s;
}

test('每条被检索到的条目都能说明为什么被检索到', () => {
  const s = store();
  try {
    const items = s.knowledge('p', '导出', 5);
    assert.ok(items.length > 0, '应检索到相关条目');
    const hit = items.find(item => item.id === 'k-export')!;
    assert.ok(hit.why, '必须带上检索理由');
    assert.deepEqual(hit.why.matched, ['导出'], '要点明命中的片段');
    assert.ok(hit.why.coverage > 0 && hit.why.coverage <= 1, '覆盖率应在合理范围');
  } finally { s.close(); }
});

test('浏览式调用不带检索理由，因为确实不是检索选出来的', () => {
  const s = store();
  try {
    // Listing the catalog is not retrieval, and inventing a reason for it would be
    // the same overstatement as claiming a match that never happened.
    const items = s.knowledge('p', '', 5);
    assert.ok(items.length > 0, '应列出目录');
    assert.ok(items.every(item => item.why === null), '无查询时理由应为空，不得编造');
  } finally { s.close(); }
});

test('prepare 记录检索理由与未命中片段，供排查漏检', () => {
  const s = store();
  try {
    const prepared = s.prepare('p', '导出设备');
    assert.ok(prepared.retrieval, '必须带检索报告');
    assert.equal(prepared.retrieval.query, '导出设备');
    assert.ok(prepared.retrieval.tokens.length > 0, '应记录查询片段');

    // "导出" matched the export entry; "出设" is a spurious bigram present nowhere.
    // Both facts are recorded, which is the point of the report.
    assert.ok(prepared.retrieval.matchedTokens.includes('导出'), '命中的片段应被记录');
    assert.ok(prepared.retrieval.gaps.includes('出设'),
      '未命中的片段必须被报出：它可能意味着覆盖缺口，而不是问错了问题');
    assert.match(prepared.retrieval.note, /未命中不等于/, '必须说明未命中不等于库中一定该有');

    // A partial match is still returned: the query has one word the library does not
    // know, and discarding the whole result because of it would answer a question
    // about exporting with silence.
    assert.ok(prepared.knowledge.some(item => item.id === 'k-export'),
      '多片段查询中只要有一个片段命中，就不应让整个查询落空');

    // Each selected item carries its own reason, so the two views agree.
    assert.ok(prepared.retrieval.selected.length > 0);
    assert.ok(prepared.retrieval.selected.every(entry => entry.why), '每条入选条目都要有理由');
  } finally { s.close(); }
});

test('完全无命中的查询同样留下记录，而不是静默返回空', () => {
  const s = store();
  try {
    const prepared = s.prepare('p', '完全不存在的词汇');
    assert.equal(prepared.knowledge.length, 0);
    assert.equal(prepared.workflows.length, 0);
    // The trace is the point: this is the case a later investigation needs most.
    assert.ok(prepared.retrieval.tokens.length > 0, '仍需记录查询片段');
    assert.equal(prepared.retrieval.matchedTokens.length, 0);
    assert.deepEqual(prepared.retrieval.gaps.length, prepared.retrieval.tokens.length,
      '全部片段未命中时应全部列为缺口');
  } finally { s.close(); }
});

test('已拒收的候选保留 90 天供查阅，之后正文失效但状态留存', () => {
  let clock = { now: 1_700_000_000_000 };
  const s = new Store(':memory:', () => clock.now);
  try {
    const created = String(s.submit('agent', { idempotencyKey: 'k1', projectId: 'p', discovery: '一条被拒的候选' }).id);
    s.rejectProposal(created);

    // Readable during the retention window.
    const during = s.listProposals('p', 'rejected');
    assert.equal(during.length, 1);
    assert.match(JSON.stringify(during[0]!.payload), /被拒的候选/, '保留期内正文可查阅');

    // Past ninety days the text lapses, but the fact of the rejection remains — an
    // audit needs "a claim was made and refused" to stay true.
    clock.now += 91 * 86_400_000;
    const outcome = s.expireProposals();
    assert.deepEqual(outcome.clearedRejected, [created], '到期应清理正文');
    const after = s.listProposals('p', 'rejected');
    assert.equal(after.length, 1, '记录本身仍在');
    assert.equal(JSON.stringify(after[0]!.payload), '{}', '正文已失效');
  } finally { s.close(); }
});
