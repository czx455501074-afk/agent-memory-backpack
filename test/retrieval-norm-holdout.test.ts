import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { createRetrievalService } from '../src/retrieval-service.js';
import { initializeWorkflowDrafts } from '../src/workflow-organization.js';
import type { KnowledgeDraft } from '../src/schema.js';

/**
 * The rule half of the retrieval corpus.
 *
 * `retrieval-quality-holdout.json` and `retrieval-blind-v1.json` contain skills and
 * memories only, so the kind whose recall failure matters most - a rule the agent
 * must obey - had never been measured. These cases are additions; no existing
 * expectation in either of those files was touched.
 */

const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/retrieval-norm-holdout.json', import.meta.url), 'utf8')) as {
  documents: Array<{ id: string; kind: 'norm' | 'memory' | 'journal'; title: string; body: string; repeat?: number }>;
  cases: Array<{ id: string; dimension: string; query: string; expectSelected: string[]; expectOmitted?: string[]; expectNotGap?: string[] }>;
};

function corpus() {
  const store = new Store(':memory:');
  initializeWorkflowDrafts(store);
  store.import(fixture.documents.map(document => {
    const common = { id: document.id, title: document.title, scope: { kind: 'global' as const }, baseRevision: 0 };
    const body = document.body.repeat(document.repeat ?? 1);
    if (document.kind === 'norm') return { ...common, kind: 'norm' as const, body };
    if (document.kind === 'memory') return { ...common, kind: 'memory' as const, body };
    return { ...common, kind: 'journal' as const, did: body, problems: '无', outcome: 'success' as const };
  }) as KnowledgeDraft[]);
  return store;
}

function noProviderService(store: Store) {
  const dir = mkdtempSync(join(tmpdir(), 'amb-norm-holdout-'));
  return { dir, select: createRetrievalService(store, dir) };
}

const casesOf = (dimension: string) => fixture.cases.filter(item => item.dimension === dimension);

test('准原文规范查询：规范必须进入自动检索的选择', async () => {
  const store = corpus();
  const { dir, select } = noProviderService(store);
  try {
    const items = casesOf('准原文规范查询');
    assert.ok(items.length >= 3, `规范用例不得少于 3 条，实际 ${items.length}`);
    for (const item of items) {
      const result = await select('p', item.query);
      for (const id of item.expectSelected) assert.ok(result.selectedIds.includes(id),
        `${item.id}: 查询「${item.query}」未命中规范 ${id}，实际 ${JSON.stringify(result.selectedIds)}（reason=${result.reason}）`);
    }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('准原文规范查询：全文检索路径给出同一答案', () => {
  const store = corpus();
  try {
    for (const item of casesOf('准原文规范查询')) {
      const hits = store.searchUniversal('p', item.query);
      for (const id of item.expectSelected) assert.ok(hits.some(hit => hit.id === id),
        `${item.id}: 全文检索未返回规范 ${id}，实际 ${hits.slice(0, 5).map(hit => hit.id).join(',')}`);
    }
  } finally { store.close(); }
});

test('规范被上下文预算省略后仍然可检索', async () => {
  const store = corpus();
  const { dir, select } = noProviderService(store);
  try {
    const items = casesOf('超预算省略后仍可检索');
    assert.ok(items.length >= 2, `超预算用例不得少于 2 条，实际 ${items.length}`);
    for (const item of items) {
      const prepared = store.prepare('p', item.query);
      for (const id of item.expectOmitted ?? []) assert.ok(prepared.budget.omitted.some(entry => entry.id === id),
        `${item.id}: 前置条件不成立——${id} 并未被预算省略（omitted=${prepared.budget.omitted.map(entry => entry.id).join(',')}）`);
      const hits = store.searchUniversal('p', item.query);
      for (const id of item.expectSelected) assert.ok(hits.some(hit => hit.id === id),
        `${item.id}: 被省略的规范必须仍能被搜到，实际 ${hits.slice(0, 5).map(hit => hit.id).join(',')}`);
      const result = await select('p', item.query);
      for (const id of item.expectSelected) assert.ok(result.selectedIds.includes(id),
        `${item.id}: 被省略的规范必须仍能被自动检索命中，实际 ${JSON.stringify(result.selectedIds)}`);
    }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('规范命中不得被回执报成缺口', () => {
  const store = corpus();
  try {
    for (const item of casesOf('规范命中不得计为缺口')) {
      const prepared = store.prepare('p', item.query, { selectedIds: item.expectSelected, selectionSource: 'index' });
      for (const token of item.expectNotGap ?? [])
        assert.ok(!prepared.retrieval.gaps.includes(token),
          `${item.id}: 「${token}」命中了规范却仍被列为缺口（gaps=${prepared.retrieval.gaps.join(',')}）`);
      assert.ok(prepared.retrieval.matchedTokens.length > 0, `${item.id}: 命中片段必须记录`);
    }
  } finally { store.close(); }
});
