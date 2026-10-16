import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { selectRelevantKnowledge, type RetrievalCandidate } from '../src/semantic-retrieval.js';
import type { ModelReviewConfig } from '../src/model-review.js';

// Opt-in measurement against the user's existing provider; no configuration or
// database writes. API keys and real user knowledge never enter diagnostics.
test('live configured-provider measurement on the previously frozen 18-case blind corpus', { skip: process.env.AMB_LIVE_RETRIEVAL !== '1' }, async context => {
  const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/retrieval-blind-v1.json', import.meta.url), 'utf8')) as {
    documents: Array<{ id: string; kind: string; title: string; description?: string; body: string; repeat?: number }>;
    cases: Array<{ id: string; query: string; relevant: string[] }>;
  };
  const config = JSON.parse(readFileSync(join(homedir(), '.agent-memory-backpack', 'model-review.json'), 'utf8')) as ModelReviewConfig;
  const candidates: RetrievalCandidate[] = fixture.documents.map(document => ({ id: document.id, revision: 1, kind: document.kind, title: document.title,
    body: document.kind === 'skill' ? `description: ${document.description}\n${document.body}` : document.body.repeat(document.repeat ?? 1) }));
  let tp = 0, fp = 0, fn = 0, modelCalls = 0, degradedCalls = 0, abstained = 0, negatives = 0;
  const latencies: number[] = [];
  for (let offset = 0; offset < fixture.cases.length; offset += 3) {
    const batch = await Promise.all(fixture.cases.slice(offset, offset + 3).map(async item => {
      const start = Date.now(); const result = await selectRelevantKnowledge(item.query, candidates, config);
      return { item, result, ms: Date.now() - start };
    }));
    for (const { item, result, ms } of batch) {
      latencies.push(ms);
      const falsePositive = result.selectedIds.filter(id => !item.relevant.includes(id));
      const falseNegative = item.relevant.filter(id => !result.selectedIds.includes(id));
      tp += result.selectedIds.filter(id => item.relevant.includes(id)).length; fp += falsePositive.length; fn += falseNegative.length;
      if (result.mode === 'model') modelCalls++; else degradedCalls++;
      if (!item.relevant.length) { negatives++; if (!result.selectedIds.length) abstained++; }
      context.diagnostic(JSON.stringify({ id: item.id, mode: result.mode, reason: result.reason, ms, actual: result.selectedIds, falsePositive, falseNegative }));
    }
  }
  context.diagnostic(JSON.stringify({ model: config.model, cases: fixture.cases.length, modelCalls, degradedCalls, truePositive: tp, falsePositive: fp, falseNegative: fn,
    precision: tp / (tp + fp || 1), recall: tp / (tp + fn || 1), negativeCases: negatives, correctAbstentions: abstained,
    latencyP50Ms: [...latencies].sort((a, b) => a - b)[Math.ceil(latencies.length * 0.5) - 1],
    latencyP95Ms: [...latencies].sort((a, b) => a - b)[Math.ceil(latencies.length * 0.95) - 1],
    acceptance: degradedCalls || fp || fn ? 'quality-or-provider-gaps-present' : 'all-labelled-cases-pass' }));
  assert.equal(modelCalls + degradedCalls, fixture.cases.length, 'measurement completeness only, not business acceptance');
});
