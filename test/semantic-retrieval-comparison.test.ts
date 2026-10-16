import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { selectRelevantKnowledge, type RetrievalCandidate } from '../src/semantic-retrieval.js';
import type { ModelReviewConfig } from '../src/model-review.js';

test('opt-in two-provider comparison using fixed diagnostic corpus and three real-library queries', { skip: process.env.AMB_COMPARE_RETRIEVAL !== '1' }, async context => {
  const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/retrieval-blind-v1.json', import.meta.url), 'utf8')) as {
    documents: Array<{ id: string; kind: string; title: string; description?: string; body: string; repeat?: number }>;
    cases: Array<{ id: string; query: string; relevant: string[] }>;
  };
  const config = JSON.parse(readFileSync(join(homedir(), '.agent-memory-backpack', 'model-review.json'), 'utf8')) as ModelReviewConfig;
  const synthetic: RetrievalCandidate[] = fixture.documents.map(document => ({ id: document.id, revision: 1, kind: document.kind, title: document.title,
    body: document.kind === 'skill' ? `description: ${document.description}\n${document.body}` : document.body.repeat(document.repeat ?? 1) }));
  const db = new DatabaseSync(join(homedir(), '.agent-memory-backpack', 'knowledge.sqlite'), { readOnly: true });
  const real: RetrievalCandidate[] = db.prepare("SELECT r.content,k.head FROM knowledge k JOIN revisions r ON r.id=k.id AND r.revision=k.head WHERE k.status='active' AND k.kind IN ('skill','memory','journal','workflow')").all()
    .map(row => {
      const content = JSON.parse(String(row.content));
      return { ...content, revision: Number(row.head), body: content.body ?? content.did ?? content.overview ?? '' };
    }).filter(entry => entry.scope.kind === 'global' || (entry.scope.kind === 'project' && entry.scope.projectId === 'p0-workflow'));
  db.close();
  const realQueries = [
    '已重启dsh',
    'codex和dsh的任何项目会话都共享一个amb库，agent主动去库中搜索需要用到的知识、经验、日记等',
    '主动调用插件数据和主动落盘到插件数据库，还有skill融入数据库如何实现',
  ];
  const reports: unknown[] = [];
  const modelNames = process.env.AMB_COMPARE_MODELS?.split(',').filter(Boolean) ?? ['gemini-3.8-flash-high', 'cmdc-gemini-3.8-flash'];
  for (const model of modelNames) {
    const records: Array<{ id: string; actual: string[]; mode: string; reason?: string; ms: number; falsePositive: string[]; falseNegative: string[] }> = [];
    for (let offset = 0; offset < fixture.cases.length; offset += 3) {
      const batch = await Promise.all(fixture.cases.slice(offset, offset + 3).map(async item => {
        const start = Date.now(); const result = await selectRelevantKnowledge(item.query, synthetic, { ...config, model });
        return { id: item.id, actual: result.selectedIds, mode: result.mode, reason: result.reason, ms: Date.now() - start,
          falsePositive: result.selectedIds.filter(id => !item.relevant.includes(id)), falseNegative: item.relevant.filter(id => !result.selectedIds.includes(id)) };
      }));
      records.push(...batch);
    }
    const expected = fixture.cases.reduce((sum, item) => sum + item.relevant.length, 0);
    const fp = records.reduce((sum, row) => sum + row.falsePositive.length, 0), fn = records.reduce((sum, row) => sum + row.falseNegative.length, 0);
    const tp = expected - fn, latencies = records.map(row => row.ms).sort((a, b) => a - b);
    const realResults = [];
    for (let index = 0; index < realQueries.length; index++) {
      const start = Date.now(); const result = await selectRelevantKnowledge(realQueries[index]!, real, { ...config, model });
      realResults.push({ queryIndex: index, mode: result.mode, reason: result.reason, selectedIds: result.selectedIds, ms: Date.now() - start });
    }
    const summary = { model, datasetStatus: 'previously-inspected-diagnostic-not-new-blind-test', cases: records.length,
      modelCalls: records.filter(row => row.mode === 'model').length, degradedCalls: records.filter(row => row.mode !== 'model').length,
      timeoutCalls: records.filter(row => row.reason === 'timeout').length, truePositive: tp, falsePositive: fp, falseNegative: fn,
      precision: tp / (tp + fp || 1), recall: tp / expected, latencyP50Ms: latencies[Math.ceil(latencies.length * .5) - 1],
      latencyP95Ms: latencies[Math.ceil(latencies.length * .95) - 1], records, realLibraryEntryCount: real.length, realResults };
    reports.push(summary);
    context.diagnostic(JSON.stringify(summary));
    assert.equal(records.length, 18, 'measurement completeness only');
  }
  const reportName = modelNames.length === 1 ? `2026-10-14-retrieval-model-comparison-${modelNames[0]!.replace(/[^a-z0-9-]/gi, '_')}.json`
    : '2026-10-14-retrieval-model-comparison.json';
  writeFileSync(new URL(`../../docs/implementation/${reportName}`, import.meta.url), JSON.stringify({
    evaluatedAt: new Date().toISOString(), budgetMs: 4000, defaultConfigurationChanged: false, realLibraryReadOnly: true,
    realQueries, reports,
  }, null, 2));
});
