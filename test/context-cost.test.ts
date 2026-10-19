import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createCoreServer } from '../src/server.js';
import { positiveRetrievalClauses } from '../src/retrieval-index.js';

/**
 * Two context-cost defects, both measured before this file existed.
 *
 * 1. A query with a negated tail lost its positive half: "检查数据库备份但不要修改文件"
 *    split on punctuation only, so the whole sentence matched `negation` and nothing was
 *    retrieved. The same text with a comma worked, which located the bug in the boundary
 *    rather than in the negation rule.
 * 2. Reading an entry with `query` returned the passages *and* the full body - 20,017
 *    characters beside a 497-character passage - so the most common call shape bypassed
 *    the chunking that exists to protect the context budget.
 */

const TOKEN = 'a'.repeat(64);

test('否定尾句不得吞掉正向目标', () => {
  assert.deepEqual(positiveRetrievalClauses('检查数据库备份但不要修改文件'), ['检查数据库备份']);
  assert.deepEqual(positiveRetrievalClauses('检查数据库备份，不要修改文件'), ['检查数据库备份']);
  // A request that is only a negation still has nothing to retrieve for.
  assert.deepEqual(positiveRetrievalClauses('不要修改任何文件'), []);
  // Two positive objectives separated by contrast keep both halves that are positive.
  assert.deepEqual(positiveRetrievalClauses('核对备份但不要删除，检查索引'), ['核对备份', '检查索引']);
});

test('带 query 读取只回段落，不再附带全文', async () => {
  const store = new Store(':memory:');
  const body = `${'无关背景。'.repeat(4000)}\nNEEDLE 事务回滚修复`;
  store.import([{
    id: 'long-note', kind: 'memory', title: 'probe', body,
    scope: { kind: 'project', projectId: 'alpha' }, baseRevision: 0,
  }]);
  const server = createCoreServer(store, {
    protocolVersion: 1, port: 47631,
    clients: [{ id: 'dsh', token: TOKEN, projectId: 'alpha', role: 'adapter' }],
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const post = async (payload: Record<string, unknown>) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/knowledge/read`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-amb-protocol': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'alpha', knowledgeId: 'long-note', ...payload }),
    });
    return await response.json() as { body?: string; chars?: number; passages?: Array<{ text: string }>; note?: string };
  };
  try {
    const withQuery = await post({ query: 'NEEDLE' });
    assert.ok(Array.isArray(withQuery.passages) && withQuery.passages.length > 0, '前提：该查询应命中段落');
    assert.equal(withQuery.body, '', '带 query 时不得返回全文');
    assert.equal(withQuery.chars, body.length, '全文长度仍可读，供调用方判断要不要取全文');
    const size = JSON.stringify(withQuery).length;
    assert.ok(size < 4000, `响应应保持在段落量级，实际 ${size} 字符`);

    // full=true 仍然给全文，这是显式请求，不是默认行为。
    const everything = await post({ query: 'NEEDLE', full: true });
    assert.equal(everything.body, body, 'full=true 必须返回完整正文');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    store.close();
  }
});
