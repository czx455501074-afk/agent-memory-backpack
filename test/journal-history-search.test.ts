import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

/**
 * A detail that a later revision dropped must still be findable.
 *
 * The full-text row used to be deleted and re-inserted on every write, so only the current
 * version was indexed. On the real library that left 1,881 revisions behind 176 journals
 * unreachable: the text was still in `revisions`, but no query could get to it.
 *
 * The fix keeps the *result* pointing at the head — a stale document must not outrank the
 * current one — and only makes the words it used reachable. These cases pin both halves.
 */

const PROJECT = 'p0';

const memory = (id: string, body: string, baseRevision: number) => ({
  id, kind: 'memory' as const, title: `条目 ${id}`, body, baseRevision,
  scope: { kind: 'global' as const },
});

test('旧版本里的词仍能搜到这条知识，结果指向当前版本', () => {
  const store = new Store(':memory:');
  try {
    store.import([memory('kept', '第一版里提到 quartz 分片会话的隐患。', 0)]);
    store.import([memory('kept', '第二版改写为：定时任务需要幂等键。', 1)]);

    // The word from the *first* revision is gone from the body now. Read it from the row
    // rather than through an accessor whose exact shape this test would then be pinning.
    const head = store.db.prepare('SELECT head FROM knowledge WHERE id=?').get('kept') as { head: number };
    const stored = store.db.prepare('SELECT content FROM revisions WHERE id=? AND revision=?').get('kept', head.head) as { content: string };
    const body = (JSON.parse(stored.content) as { body: string }).body;
    assert.ok(!body.includes('quartz'), '前提：当前版本已不含那个词');
    assert.equal(head.head, 2);

    const hits = store.searchUniversal(PROJECT, 'quartz') as Array<{ id: string; revision: number }>;
    const found = hits.find(item => item.id === 'kept');
    assert.ok(found, `旧版本的词必须仍能命中，实际命中：${JSON.stringify(hits.map(i => i.id))}`);
    assert.equal(found!.revision, 2, '命中必须指向当前版本，而不是旧版本');
  } finally { store.close(); }
});

test('当前版本的内容照常可检索', () => {
  const store = new Store(':memory:');
  try {
    store.import([memory('fresh', '第一版无关内容。', 0)]);
    store.import([memory('fresh', '第二版：重试要带退避。', 1)]);
    const hits = store.searchUniversal(PROJECT, '退避') as Array<{ id: string; revision: number }>;
    assert.ok(hits.some(item => item.id === 'fresh'), '新版本的词当然必须命中');
  } finally { store.close(); }
});

test('索引只合并最近三版，不会无上限膨胀', () => {
  const store = new Store(':memory:');
  try {
    store.import([memory('grow', '最早的一版含有 ancientword 这个词。', 0)]);
    for (let revision = 1; revision <= 6; revision += 1) {
      store.import([memory('grow', `第 ${revision + 1} 版：例行更新。`, revision)]);
    }
    const rows = store.db.prepare('SELECT terms FROM workflow_search WHERE id=?').all('grow') as Array<{ terms: string }>;
    assert.equal(rows.length, 1, '一条知识只应有一行索引');
    assert.ok(rows[0]!.terms.length <= 40_000, '索引长度必须有上限');
    assert.ok(!rows[0]!.terms.includes('ancientword'),
      '只合并最近三版：更早的版本不再进索引，否则被反复重写的条目会挤占索引');
  } finally { store.close(); }
});
