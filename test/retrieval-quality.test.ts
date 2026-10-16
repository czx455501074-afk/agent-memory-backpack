import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Store } from '../src/store.js';
import type { KnowledgeDraft } from '../src/schema.js';

const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/retrieval-quality-holdout.json', import.meta.url), 'utf8')) as {
  documents: Array<{ id: string; kind: 'skill' | 'memory'; title: string; description?: string; body: string; leaf?: string; repeat?: number }>;
  cases: Array<{ split: string; query: string; relevant: string[] }>;
};

function corpus() {
  const store = new Store(':memory:');
  const entries: KnowledgeDraft[] = fixture.documents.map(document => {
    const common = { id: document.id, title: document.title, scope: { kind: 'global' as const }, baseRevision: 0 };
    return document.kind === 'memory'
      ? { ...common, kind: 'memory', body: document.body.repeat(document.repeat ?? 1) }
      : { ...common, kind: 'skill', body: `---\nname: ${document.id}\ndescription: ${document.description}\n---\n${document.body}`,
        leaves: document.leaf ? [{ path: 'references/shared.md', hash: 'fixture', body: document.leaf }] : [], needsStructure: true };
  });
  store.import(entries);
  return store;
}

function metrics(cases: typeof fixture.cases, retrieve: (query: string) => string[]) {
  let truePositive = 0, falsePositive = 0, expected = 0, correctAbstentions = 0, negativeCases = 0;
  for (const item of cases) {
    const ids = retrieve(item.query);
    expected += item.relevant.length;
    truePositive += ids.filter(id => item.relevant.includes(id)).length;
    falsePositive += ids.filter(id => !item.relevant.includes(id)).length;
    if (!item.relevant.length) { negativeCases++; if (!ids.length) correctAbstentions++; }
  }
  return { cases: cases.length, truePositive, falsePositive, expected,
    precision: truePositive / (truePositive + falsePositive || 1), recall: truePositive / (expected || 1),
    negativeCases, correctAbstentions, abstentionAccuracy: correctAbstentions / (negativeCases || 1) };
}

test('fixed development and diagnostic relevance corpus: automatic recall precision, recall and abstention', context => {
  const store = corpus();
  try {
    for (const split of ['development', 'diagnostic']) {
      const cases = fixture.cases.filter(item => item.split === split);
      // Baseline is the pre-change prepare selector: full-source lexical hits,
      // with advertised-purpose filtering for skills but none for daily logs.
      const baseline = metrics(cases, query => store.knowledge('p', query, 100, 400, 0).filter(entry => {
        const doc = fixture.documents.find(document => document.id === entry.id)!;
        if (doc.kind !== 'skill') return true;
        const raw = query.toLowerCase().match(/[a-z0-9_-]+|[\p{Script=Han}]+/gu) ?? [];
        const tokens = [...new Set(raw.flatMap(word => /\p{Script=Han}/u.test(word)
          ? Array.from({ length: Math.max(1, word.length - 1) }, (_, index) => word.slice(index, index + 2)) : [word]))]
          .filter(token => !['实现', '功能', '主动', '调用', '参考', '使用', '需要', '执行', '任务', '验收'].includes(token));
        const primary = `${doc.title} ${doc.description ?? ''}`.toLowerCase();
        return tokens.filter(token => primary.includes(token)).length >= (tokens.length >= 6 ? 2 : 1);
      }).slice(0, 5).map(entry => entry.id));
      const actual = metrics(cases, query => store.prepare('p', query).knowledge.map(entry => entry.id));
      context.diagnostic(JSON.stringify({ split, baseline, actual }));
      for (const item of cases) context.diagnostic(JSON.stringify({ query: item.query, expected: item.relevant,
        actual: store.prepare('p', item.query).knowledge.map(entry => entry.id) }));
      assert.equal(actual.precision, 1, `${split}: unexpected automatic injection`);
      assert.equal(actual.recall, 1, `${split}: missed labelled knowledge`);
      assert.equal(actual.abstentionAccuracy, 1, `${split}: unsupported query must abstain`);
      for (const item of cases) assert.deepEqual(store.autoRecall('p', item.query, undefined, 5).map(entry => entry.id).sort(),
        store.prepare('p', item.query).knowledge.map(entry => entry.id).sort(), 'both adapters must use the same automatic selection policy');
    }
  } finally { store.close(); }
});

test('explicit leaf search and ID expansion stay available when automatic purpose filtering abstains', () => {
  const store = corpus();
  try {
    assert.ok(store.searchUniversal('p', '经验落盘').some(entry => entry.id === 'skill-drama'));
    assert.ok(!store.autoRecall('p', '经验落盘').some(entry => entry.id === 'skill-drama'));
    assert.match(store.readKnowledge('p', 'skill-drama', true).leaves[0]!.body, /经验落盘/);
    assert.ok(store.autoRecall('p', 'skill-drama@1').some(entry => entry.id === 'skill-drama'));
  } finally { store.close(); }
});
