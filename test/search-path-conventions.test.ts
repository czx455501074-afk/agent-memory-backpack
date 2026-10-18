import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { Store } from '../src/store.js';
import { createCoreServer } from '../src/server.js';

/**
 * 显式检索与自动召回是**两个约定** —— 这条线我曾把它当成一条，代价是用户查不到东西。
 *
 * 实测的病：查询「规矩」在索引里命中 29 条、`literal` 检索 5 条，而**不带任何选项**的显式
 * 检索返回 **0** 条。原因：`decided` 把降级路径（`mode: 'index'`，本机未配置模型时就是它）
 * 也算作"模型做了决定"，于是本地索引的严格证据门槛——那是为**自动注入**设的绝对下限——把
 * 显式查询一并拦掉。用户由此断定"库里没有"，而库里有。
 *
 * 三条路径各自的约定，缺一条都会让"没找到"与"没查"混起来：
 *   - **显式检索**（无选项）：用户在明确找东西 → 用全文索引兜底；
 *   - **`autoRecall: true`**：自动召回语义 → 模型不可用时不猜（`没查` ≠ `没找到`）；
 *   - **`literal: true`**：跳过模型，直接字面检索。
 */

const roots: string[] = [];
const stores: Store[] = [];
after(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of roots.splice(0)) {
    const rel = relative(resolve(tmpdir()), resolve(path));
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    try { rmSync(path, { recursive: true, force: true }); } catch { /* Windows 句柄未释放不算结论 */ }
  }
});

/** 一条含「规范」的条目：它没有「规矩」这个词，只有术语桥会把它接到「规矩」上。 */
function seeded() {
  const directory = mkdtempSync(join(tmpdir(), 'backpack-search-paths-'));
  roots.push(directory);
  const store = new Store(join(directory, 'knowledge.sqlite'), () => 1_000_000);
  stores.push(store);
  store.import([{
    id: 'norm:probe', baseRevision: 0, kind: 'norm', title: '入库纪律', scope: { kind: 'global' },
    body: '写库前先写规范、全面的描述，不要把流水原文写进正文。',
  }]);
  store.rebuildSearchIndex();
  return store;
}

async function withServer(store: Store, run: (post: (path: string, body: unknown) => Promise<Record<string, any>>) => Promise<void>) {
  const token = 'w'.repeat(64);
  const server = createCoreServer(store, { protocolVersion: 1, port: 47631,
    clients: [{ id: 'dsh', token, projectId: 'p0-workflow', role: 'adapter' }] });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-amb-protocol': '1' },
      body: JSON.stringify(body) });
    assert.equal(res.status, 200, await res.clone().text());
    return await res.json() as Record<string, any>;
  };
  try { await run(post); }
  finally { server.closeAllConnections(); server.close(); }
}

test('显式检索用全文索引兜底：索引里有的，就不能返回空', async () => {
  const store = seeded();
  await withServer(store, async post => {
    // 前提：这个词确实能通过字面检索找到（否则下面的断言是空检查）。
    const literal = await post('/v1/knowledge/search-universal', { projectId: 'p0-workflow', query: '规矩', literal: true });
    assert.ok((literal.results as unknown[]).length > 0, '前提：字面检索应命中（术语桥把它接到了「规范」上）');

    // 显式检索（不带选项）：本机没有配置模型，于是 selection 走降级路径 —— 那**不是**一个
    // "模型做的决定"，不该让本地索引的自动注入门槛把用户明确要找的东西拦掉。
    const explicit = await post('/v1/knowledge/search-universal', { projectId: 'p0-workflow', query: '规矩' });
    assert.ok((explicit.results as unknown[]).length > 0,
      `显式检索不得返回空：${JSON.stringify(explicit.results)}`);
  });
});

test('autoRecall 保持保守：模型不可用时不猜', async () => {
  // 反方向：如果这条也返回结果，"显式检索兜底"就变成了"任何情况都兜底"，而那正是本项目
  // 反复禁止的混淆——自动召回每轮都在跑、还吃注入预算，它宁可少给。
  const store = seeded();
  await withServer(store, async post => {
    const automatic = await post('/v1/knowledge/search-universal', { projectId: 'p0-workflow', query: '规矩', autoRecall: true });
    assert.deepEqual(automatic.results, [], 'autoRecall 在模型不可用时必须保守');
  });
});
