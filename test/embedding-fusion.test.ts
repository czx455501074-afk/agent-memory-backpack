import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { Store } from '../src/store.js';
import { createRetrievalService } from '../src/retrieval-service.js';
import { cosine, decodeVector, encodeVector, embeddingConfigFrom, rrf } from '../src/embeddings.js';

/**
 * The optional semantic layer: off by default, and useful when on.
 *
 * Three properties, in the order they matter:
 *
 *   1. **Off means off.** With no endpoint configured the ids are exactly the lexical ones — the
 *      layer cannot change an answer it was never asked to give. (Timing counts too: the
 *      unconfigured branch does not await, because an extra yield point changed how concurrent
 *      requests merged, which the retrieval tests caught.)
 *   2. **Thin coverage is refused, not guessed.** A few vectors deciding the order of hundreds of
 *      entries is worse than the lexical answer and arrives looking just as confident.
 *   3. **When it runs, it adds something.** The check that gives this any value: a query the lexical
 *      path cannot match, answered because the vector half could. Without that, "the fusion ran" is
 *      a field, not a capability.
 */

const roots: string[] = [];
const stores: Store[] = [];
function open() {
  const directory = mkdtempSync(join(tmpdir(), 'backpack-embed-'));
  roots.push(directory);
  const store = new Store(join(directory, 'knowledge.sqlite'), () => 1000);
  stores.push(store);
  return { store, directory };
}
after(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of roots.splice(0)) {
    const rel = relative(resolve(tmpdir()), resolve(path));
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Windows keeps the handle open; leftover temp is not the verdict.
    }
  }
});

const CONFIG = { endpoint: 'https://embeddings.example.invalid/v1', model: 'stub-embed' };
/** Vectors are fixtures: one axis per topic, so similarity is arithmetic rather than a claim. */
const AXIS = (x: number, y: number, z: number) => [x, y, z];

/** Six entries: the coverage floor is five, so a fixture below that could never fuse. */
function seeded() {
  const { store, directory } = open();
  store.import([
    { id: 'memory:resist', baseRevision: 0, kind: 'memory', title: '光刻胶', body: '曝光剂量与显影时间的配合关系。', scope: { kind: 'global' } },
    { id: 'memory:a', baseRevision: 0, kind: 'memory', title: '甲', body: '无关内容甲。', scope: { kind: 'global' } },
    { id: 'memory:b', baseRevision: 0, kind: 'memory', title: '乙', body: '无关内容乙。', scope: { kind: 'global' } },
    { id: 'memory:c', baseRevision: 0, kind: 'memory', title: '丙', body: '无关内容丙。', scope: { kind: 'global' } },
    { id: 'memory:d', baseRevision: 0, kind: 'memory', title: '丁', body: '无关内容丁。', scope: { kind: 'global' } },
    { id: 'memory:e', baseRevision: 0, kind: 'memory', title: '戊', body: '无关内容戊。', scope: { kind: 'global' } },
  ]);
  // Four of six carry a vector: 67% coverage, above the floor the fusion insists on.
  store.saveEmbeddings([
    { id: 'memory:resist', revision: 1, model: CONFIG.model, vector: AXIS(1, 0, 0) },
    { id: 'memory:a', revision: 1, model: CONFIG.model, vector: AXIS(0, 1, 0) },
    { id: 'memory:b', revision: 1, model: CONFIG.model, vector: AXIS(0, 1, 0) },
    { id: 'memory:c', revision: 1, model: CONFIG.model, vector: AXIS(0, 0, 1) },
  ]);
  return { store, directory };
}

/** A query whose words appear nowhere in the library — only a vector can answer it. */
const PARAPHRASE = '涂布厚度怎么定';

test('with no configuration the layer is off, and the answer is the lexical one', async () => {
  const { store, directory } = seeded();
  const plain = createRetrievalService(store, directory);
  const off = createRetrievalService(store, directory, { embeddings: null });
  const a = await plain('p0-workflow', '光刻胶');
  const b = await off('p0-workflow', '光刻胶');
  assert.equal(b.vector?.used, false);
  assert.equal(b.vector?.reason, 'not_configured');
  assert.deepEqual(b.selectedIds, a.selectedIds, '未配置时不得改变任何选择结果');
});

test('thin coverage is refused rather than fused', async () => {
  const { store, directory } = seeded();
  // One vector out of six: enough to rank, nowhere near enough to decide.
  store.db.prepare('DELETE FROM embeddings WHERE id<>?').run('memory:resist');
  const service = createRetrievalService(store, directory, { embeddings: CONFIG, embed: async texts => texts.map(() => AXIS(1, 0, 0)) });
  const selection = await service('p0-workflow', '光刻胶');
  assert.equal(selection.vector?.used, false);
  assert.equal(selection.vector?.reason, 'coverage_too_thin');
});

test('a query the lexical path cannot match is answered because the vector half could', async () => {
  const { store, directory } = seeded();
  const lexicalOnly = createRetrievalService(store, directory);
  const before = await lexicalOnly('p0-workflow', PARAPHRASE);
  assert.deepEqual(before.selectedIds, [], '前提：这条查询在词法路径下选不到任何条目（否则下面的断言是空检查）');

  const service = createRetrievalService(store, directory, {
    embeddings: CONFIG,
    // The stub maps the paraphrase onto the same axis as the resist entry.
    embed: async texts => texts.map(() => AXIS(0.95, 0.05, 0)),
  });
  const after = await service('p0-workflow', PARAPHRASE);
  assert.equal(after.vector?.used, true);
  assert.equal(after.vector?.reason, 'fused');
  assert.ok(after.selectedIds.includes('memory:resist'), `向量应当把这条带进来：${after.selectedIds.join('、')}`);
});

test('an embedding service that fails degrades to lexical, and says so', async () => {
  const { store, directory } = seeded();
  const service = createRetrievalService(store, directory, {
    embeddings: CONFIG,
    embed: async () => null,   // exactly what a timeout or a 5xx produces
  });
  const selection = await service('p0-workflow', PARAPHRASE);
  assert.equal(selection.vector?.used, false);
  assert.equal(selection.vector?.reason, 'unavailable');
  assert.deepEqual(selection.selectedIds, [], '失败时回落词法，而不是猜');
});

test('the pure helpers behave: vectors round-trip, cosine is bounded, rank fusion is monotone', () => {
  const vector = [0.5, -1.25, 3];
  assert.deepEqual(decodeVector(encodeVector(vector)).map(value => Number(value.toFixed(2))), vector);
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([], []), 0, '退化输入返回 0 而不是 NaN');
  assert.ok(rrf(0) > rrf(1) && rrf(1) > rrf(10), '排名越靠前，融合分越高');
});

test('the switch is the environment, and both halves must be present', () => {
  assert.equal(embeddingConfigFrom({}), null);
  assert.equal(embeddingConfigFrom({ AMB_EMBEDDING_ENDPOINT: 'https://x.invalid/v1' }), null, '只有 endpoint 不算配置');
  assert.equal(embeddingConfigFrom({ AMB_EMBEDDING_MODEL: 'm' }), null, '只有 model 不算配置');
  assert.deepEqual(embeddingConfigFrom({ AMB_EMBEDDING_ENDPOINT: 'https://x.invalid/v1', AMB_EMBEDDING_MODEL: 'm' }),
    { endpoint: 'https://x.invalid/v1', model: 'm' });
});
