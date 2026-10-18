import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { Store } from '../src/store.js';

/**
 * The receipt has to mean what it says, on both paths.
 *
 * Measured problem: on the degraded path the local index selected an entry, the strict evidence
 * floor withheld it, nothing was injected — and the receipt then listed *the entire query* as a
 * coverage gap. A reader could only conclude "this library knows nothing about that topic", about
 * a topic it had just found an entry for.
 *
 * Two things are therefore pinned here, and the second is the one that keeps the first honest:
 *
 *   - a gap means the library does not contain the fragment (verified against the index), not
 *     "no injected entry happened to match it";
 *   - a fragment the library *does* not contain is still reported as a gap, and a withheld
 *     candidate is reported as withheld rather than silently dropped.
 *
 * The evidence floor itself is unchanged: zero-evidence injection on unrelated queries measures
 * 0/32, which is exactly why it must not be relaxed to make a receipt look better.
 */

const roots: string[] = [];
const stores: Store[] = [];
function open() {
  const directory = mkdtempSync(join(tmpdir(), 'backpack-receipt-'));
  roots.push(directory);
  const store = new Store(join(directory, 'knowledge.sqlite'), () => 1000);
  stores.push(store);
  return store;
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

/** The live library's own case: the index ranks this entry first, the strict matcher withholds it. */
const QUERY = '排查接口超时要带协议头防 426';

function seeded() {
  const store = open();
  store.import([{
    id: 'memory:probe', baseRevision: 0, kind: 'memory', title: '延迟归因',
    body: '排查超时必须带协议头，并用无外部调用的同步端点作对照。',
    scope: { kind: 'global' },
  }]);
  return store;
}

test('a fragment the library contains is never reported as a coverage gap', () => {
  const store = seeded();
  // `local_index` mirrors the degraded path: the index chose the entry, so the evidence floor
  // decides whether it is injected. It withholds here — which is the case that produced the
  // false gap list.
  const prepared = store.prepare('p0-workflow', QUERY, { selectedIds: ['memory:probe'], selectionSource: 'local_index' });
  const { gaps, matchedTokens, withheld, shown } = prepared.retrieval;
  assert.equal(shown, 0, '证据不足时不得注入（这条断言是下面两条的前提）');
  assert.ok(withheld, '必须说明"索引选出过候选但被拦下"，否则读者只能读成"库里没有"');
  assert.ok(withheld.count > 0);
  assert.ok(!gaps.includes('排查'), '库里存在的词不得被报成覆盖缺口');
  assert.ok(!gaps.includes('超时'), '库里存在的词不得被报成覆盖缺口');
  assert.deepEqual(matchedTokens, [], '没有注入时没有命中词，这是如实的');
});

test('a fragment the library does not contain is still reported as a gap', () => {
  // The counter-direction: if this went quiet too, the field would stop carrying information and
  // "no gaps" would read as "the library covers everything".
  const store = seeded();
  const prepared = store.prepare('p0-workflow', '光刻胶的曝光剂量与显影时间');
  const { gaps, withheld } = prepared.retrieval;
  assert.ok(gaps.length > 0, '库里没有的片段必须如实报成缺口（否则这条断言是空检查）');
  assert.ok(gaps.includes('光刻胶') || gaps.includes('曝光'), `缺口里应当有那个不存在的词：${gaps.join('、')}`);
  assert.equal(withheld, undefined, '索引没有选出候选时不得出现该字段');
});

test('an injected entry is always explained: by hit words, or by the basis of selection', () => {
  const store = seeded();
  const prepared = store.prepare('p0-workflow', QUERY, { selectedIds: ['memory:probe'], selectionSource: 'model' });
  const { matchedTokens, gaps, shown, selectionBasis } = prepared.retrieval;
  assert.ok(shown > 0, '模型路径应当注入该条目（否则这条断言是空检查）');
  // The model may inject an entry the literal matcher finds no tokens for — that is what a
  // semantic judgement is. What the receipt may not do is leave the reader unable to tell
  // "injected on semantic grounds" from "injected for no stated reason".
  assert.ok(matchedTokens.length > 0 || selectionBasis,
    '注入了条目就必须说明依据：要么有命中词，要么说明是语义选择');
  const overlap = matchedTokens.filter(token => gaps.includes(token));
  assert.deepEqual(overlap, [], '同一个词不能既是命中又是缺口');
});
