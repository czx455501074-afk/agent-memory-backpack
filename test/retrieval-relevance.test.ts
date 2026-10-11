import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { type Knowledge } from '../src/schema.js';

/**
 * Retrieval relevance.
 *
 * The injected context is what an agent sees before it works, so a loose match
 * does not merely rank badly — it puts unrelated material in front of every task.
 * Measured on a real library, the query "已重启" matched 22 entries and
 * "导出数据" matched 48 under the previous OR join, most of them unrelated, and
 * those entries were injected.
 */

const memory = (id: string, title: string, body: string): Knowledge =>
  ({ id, baseRevision: 0, body, kind: 'memory', title, scope: { kind: 'global' } });

function store(): Store {
  const s = new Store(':memory:', () => 1000);
  s.import([
    memory('m-restart', '重启排查记录', '今天排查了核心重启后无法拉起的问题，原因是链接未更新。'),
    memory('m-media', '短剧生成流程', '短剧的分镜与生成步骤，包含镜头语言与运镜。'),
    memory('m-drama', '短剧台词规范', '短剧台词去 AI 化的写法。'),
    memory('m-export', '导出数据说明', '导出数据的命令与参数说明。'),
    memory('m-unrelated', '颜色校正', '色彩空间与查找表。'),
  ]);
  return s;
}

test('无查询时不注入任何知识，注入由 prepare 决定', () => {
  const s = store();
  try {
    // Browsing callers still get the catalog; injection is a different decision.
    assert.ok(s.knowledge('p', '', 5).length > 0, '浏览式调用仍应列出目录');

    const prepared = s.prepare('p', '');
    assert.equal(prepared.knowledge.length, 0, '无查询时不得注入任意知识');
    assert.equal(prepared.workflows.length, 0, '无查询时不得注入任意流程');
    // Norms are standing rules and apply regardless.
    assert.ok(prepared.context.includes('知识版本'), '上下文头仍在');
  } finally { s.close(); }
});

test('多片段查询按覆盖率收敛，不因单个公共片段放行', () => {
  const s = store();
  try {
    // "重启" alone is a common fragment; only the restart note should survive a
    // query that also contains "核心".
    const loose = s.knowledge('p', '重启', 5).map(k => k.id);
    assert.ok(loose.includes('m-restart'));

    const tight = s.knowledge('p', '核心重启', 5).map(k => k.id);
    assert.ok(tight.includes('m-restart'), '应包含真正相关的条目');
    assert.equal(tight.includes('m-media'), false, '无关条目不得因为共享片段被带入');
    assert.equal(tight.includes('m-unrelated'), false, '无关条目不得被带入');
  } finally { s.close(); }
});

test('查询无任何命中时返回空，而不是回落到全库', () => {
  const s = store();
  try {
    const none = s.knowledge('p', '完全不存在的词汇组合', 5);
    assert.deepEqual(none, [], '无命中必须返回空，不得把全库当结果');
  } finally { s.close(); }
});

test('通用对话词是已知限制：过滤它需要牺牲领域词', () => {
  // Recorded as a test so the limitation is visible rather than assumed fixed.
  //
  // A frequency filter was implemented and reverted: measured on a real library,
  // "短剧" occurs in 27.8% of documents and "这个" in 29.6%. Any threshold that
  // removes the filler also removes the domain vocabulary, and silently dropping a
  // user's core subject is worse than a loose match. This test pins the trade-off
  // so a future change has to confront it explicitly instead of re-deriving it.
  const s = store();
  try {
    // A domain word that is also common must still be returned.
    const domain = s.knowledge('p', '短剧', 5).map(k => k.id);
    assert.ok(domain.length > 0, '领域词即使常见也必须能检索到，不得被通用词过滤误杀');

    // A pure filler word may match; the point is that this is accepted, not that
    // it is impossible.
    const filler = s.knowledge('p', '好的', 5);
    assert.ok(Array.isArray(filler), '通用词的处理方式是已知限制，不是保证');
  } finally { s.close(); }
});

test('同一查询的结果顺序稳定', () => {
  const s = store();
  try {
    const a = s.knowledge('p', '短剧', 5).map(k => k.id);
    const b = s.knowledge('p', '短剧', 5).map(k => k.id);
    const c = s.knowledge('p', '短剧', 5).map(k => k.id);
    assert.deepEqual(a, b, '同一查询两次结果必须一致');
    assert.deepEqual(b, c, '同一查询三次结果必须一致');
  } finally { s.close(); }
});

test('prepared 上下文随查询规模保持有界', () => {
  const s = store();
  try {
    const empty = s.prepare('p', '').context.length;
    const hit = s.prepare('p', '短剧').context.length;
    assert.ok(empty < 500, `无查询的上下文应很小，实际 ${empty}`);
    assert.ok(hit < 20000, `有查询的上下文应有界，实际 ${hit}`);
  } finally { s.close(); }
});
