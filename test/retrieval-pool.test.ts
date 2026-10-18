import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRetrievalIndex } from '../src/retrieval-index.js';
import type { RetrievalCandidate } from '../src/semantic-retrieval.js';

/**
 * The ranking pool has to be able to exceed twelve.
 *
 * `rank(query)` defaults to a limit of twelve, and `retrieval-service` called it with no
 * argument — so a library of 800 entries answered every query from the same top twelve, and
 * the relative threshold that follows had almost nothing left to choose from. `rank` now
 * receives a pool size that grows with the library (10%, floor 24, ceiling 60).
 *
 * What this file can prove is the half that lives in the index: the limit is honoured and
 * ordering is stable. That the service *passes* a larger pool is a contract check
 * (`verification/contracts.mjs`), because the value is computed inside a call chain this
 * test cannot observe without exporting internals for the sake of a test.
 */

const candidate = (id: string): RetrievalCandidate => ({
  id, revision: 1, kind: 'memory', title: `条目 ${id}`,
  body: 'alpha 相关的记录：这里讨论 alpha 的词频与排序。',
});

const library = (count: number) => buildRetrievalIndex(Array.from({ length: count }, (_, index) => candidate(`m-${String(index).padStart(2, '0')}`)));

test('默认上限仍是 12（改动只在调用方放大它）', () => {
  const index = library(30);
  assert.equal(index.rank('alpha').length, 12);
});

test('传更大的池子时返回更多候选，且顺序稳定', () => {
  const index = library(30);
  const wide = index.rank('alpha', 24);
  assert.equal(wide.length, 24, `池子应放得下 24 条，实际 ${wide.length}`);
  const ids = wide.map(hit => hit.candidate.id);
  assert.equal(new Set(ids).size, ids.length, '同一候选不得重复出现');
  // Re-running must produce the same order, or a caller cannot reason about the cursor.
  assert.deepEqual(index.rank('alpha', 24).map(hit => hit.candidate.id), ids);
});

test('池子不会超过库本身的规模', () => {
  const index = library(5);
  assert.equal(index.rank('alpha', 60).length, 5, '库里只有 5 条时不该凭空多出结果');
});
