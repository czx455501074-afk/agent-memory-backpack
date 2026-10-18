import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRetrievalIndex } from '../src/retrieval-index.js';
import type { RetrievalCandidate } from '../src/semantic-retrieval.js';

/**
 * A Chinese query must not be judged "long" merely because it is Chinese.
 *
 * `tokens()` splits a Han run into overlapping bigrams, so a two-word Chinese phrase
 * becomes three "terms". The guard that drops a request the library barely recognises
 * counted terms, so it fired on `日志损坏` (2 words, 3 bigrams, 1 recognised) and returned
 * nothing, while `log corrupt` (the same evidence, in English) returned a row scoring 6.26.
 *
 * The guard's own comment says it is about a *long request* — "Rowan PostgreSQL …" — so the
 * fix counts whitespace-separated words instead. These cases pin both directions: Chinese
 * short queries must reach the index, and genuinely long requests must still abstain.
 */

const entry = (over: Partial<RetrievalCandidate> & Pick<RetrievalCandidate, 'id' | 'title' | 'body'>): RetrievalCandidate => ({
  revision: 1, kind: 'journal', ...over,
});

// One library, two entries. Both queries below describe the same thing in different
// languages, and only the Chinese wording used to fail.
const library = () => buildRetrievalIndex([
  entry({
    id: 'journal-log-corruption',
    title: '日志损坏的排查记录',
    body: '日志损坏时先校验 WAL，再用 integrity_check 复核；不要在损坏的库上继续写入。',
  }),
  entry({
    id: 'journal-export-device',
    title: '导出设备清单',
    body: '导出设备清单时按项目过滤，导出的文件放在 artifacts 目录。',
  }),
]);

test('中文短查询不会被当成“长请求”而弃权', () => {
  const index = library();
  const hits = index.rank('日志损坏');
  assert.ok(hits.length > 0,
    '“日志损坏”必须命中“日志损坏的排查记录”；返回空会让中文用户以为库里没有这条');
  assert.equal(hits[0]!.candidate.id, 'journal-log-corruption');
});

test('另一个只认识一半词的中文短查询也同样命中', () => {
  const index = library();
  // Two words, one unknown ("清单" appears only in the other entry's title, so the
  // recognised term is "导出" alone): before the fix this shape abstained whenever the
  // bigram count reached three.
  const hits = index.rank('导出清单打印机');
  assert.ok(hits.length > 0, '只认识部分词的中文短查询不得弃权');
  assert.equal(hits[0]!.candidate.id, 'journal-export-device');
});

test('库里几乎不认识的真正长请求仍然弃权', () => {
  const index = library();
  // Three words, one recognised: this is the case the guard exists for. It must keep
  // abstaining, or the fix would just move the bug from Chinese to English.
  const hits = index.rank('Rowan PostgreSQL 分区');
  assert.equal(hits.length, 0, '只认识其中一词的长请求不应从那个共享词上编出一条答案');
});
