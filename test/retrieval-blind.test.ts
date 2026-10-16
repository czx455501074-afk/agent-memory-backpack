import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Store } from '../src/store.js';
import type { KnowledgeDraft } from '../src/schema.js';

const source = readFileSync(new URL('../../test/fixtures/retrieval-blind-v1.json', import.meta.url), 'utf8');
const fixture = JSON.parse(source) as {
  documents: Array<{ id: string; kind: 'skill' | 'memory'; title: string; description?: string; body: string; repeat?: number }>;
  cases: Array<{ id: string; query: string; relevant: string[]; dimension: string }>;
};

test('frozen-rule blind evaluation reports every false positive and false negative without changing labels or tuning rules', context => {
  const store = new Store(':memory:');
  try {
    store.import(fixture.documents.map(document => {
      const common = { id: document.id, title: document.title, scope: { kind: 'global' as const }, baseRevision: 0 };
      return document.kind === 'memory' ? { ...common, kind: 'memory', body: document.body.repeat(document.repeat ?? 1) }
        : { ...common, kind: 'skill', body: `---\nname: ${document.id}\ndescription: ${document.description}\n---\n${document.body}`,
          leaves: [], needsStructure: true };
    }) as KnowledgeDraft[]);
    let tp = 0, fp = 0, fn = 0, negatives = 0, abstained = 0;
    for (const item of fixture.cases) {
      const actual = store.prepare('p', item.query).knowledge.map(entry => entry.id);
      const falsePositive = actual.filter(id => !item.relevant.includes(id));
      const falseNegative = item.relevant.filter(id => !actual.includes(id));
      tp += actual.filter(id => item.relevant.includes(id)).length;
      fp += falsePositive.length;
      fn += falseNegative.length;
      if (!item.relevant.length) { negatives++; if (!actual.length) abstained++; }
      context.diagnostic(JSON.stringify({ id: item.id, dimension: item.dimension, query: item.query,
        expected: item.relevant, actual, falsePositive, falseNegative }));
      assert.equal(new Set(actual).size, actual.length, 'evaluation invariant: results contain no duplicate IDs');
    }
    context.diagnostic(JSON.stringify({ fixtureSHA256: createHash('sha256').update(source).digest('hex'), cases: fixture.cases.length,
      truePositive: tp, falsePositive: fp, falseNegative: fn, precision: tp / (tp + fp || 1), recall: tp / (tp + fn || 1),
      negativeCases: negatives, correctAbstentions: abstained, abstentionAccuracy: abstained / negatives,
      acceptance: fp === 0 && fn === 0 ? 'all-labelled-cases-pass' : 'quality-gaps-present-not-product-acceptance' }));
    assert.ok(fixture.cases.length >= 16, 'evaluation must include at least 16 pre-labelled cases');
    // This is a measurement harness. Passing harness invariants does not claim
    // acceptable quality; FP/FN and the explicit acceptance field carry that result.
  } finally { store.close(); }
});
