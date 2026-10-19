import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createCoreServer } from '../src/server.js';

/**
 * Completion must rest on evidence, on every write path.
 *
 * The checkpoint endpoint enforced this from the start; the plain record endpoint did
 * not, so an adapter could POST `completed` with empty `verified` text and
 * `evidence: 'observed'`, and the diary written from that row said `outcome: success`.
 * `observed` means the plugin saw it, which an adapter cannot assert about itself.
 */

const ADAPTER = 'a'.repeat(64);
const ADMIN = 'b'.repeat(64);

async function fixture() {
  const store = new Store(':memory:');
  const server = createCoreServer(store, {
    protocolVersion: 1, port: 47631,
    clients: [
      { id: 'dsh', token: ADAPTER, projectId: 'alpha', role: 'adapter' },
      { id: 'admin', token: ADMIN, projectId: 'alpha', role: 'admin' },
    ],
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const post = async (path: string, body: unknown, credential = ADAPTER) => {
    const response = await fetch(endpoint + path, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}`, 'x-amb-protocol': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'alpha', ...body as object }),
    });
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* keep empty */ }
    return { status: response.status, data: parsed };
  };
  return {
    store, post,
    async close() {
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
      store.close();
    },
  };
}

const task = (over: Record<string, unknown> = {}) => ({
  id: 'forged-task', title: '伪造完成', status: 'completed', ...over,
});

test('适配器不得以观察级证据写入完成', async () => {
  const f = await fixture();
  try {
    const refused = await f.post('/v1/tasks/record', { task: task({ evidence: 'observed', verified: '我说通过了' }) });
    assert.equal(refused.status, 400, `适配器不得声称插件观察，实际 ${refused.status}`);
    const stored = f.store.db.prepare('SELECT count(*) AS n FROM tasks WHERE id=?').get('forged-task') as { n: number };
    assert.equal(Number(stored.n), 0, '被拒的写入不得留下行');
  } finally { await f.close(); }
});

test('完成但没有任何验证文本必须被拒', async () => {
  const f = await fixture();
  try {
    const refused = await f.post('/v1/tasks/record', { task: task({ evidence: 'verifiable', verified: '   ' }) });
    assert.equal(refused.status, 400, `空验证文本不得记为完成，实际 ${refused.status}`);
  } finally { await f.close(); }
});

test('默认证据等级不足，完成同样被拒', async () => {
  const f = await fixture();
  try {
    // No `evidence` field: the schema default is `self-reported`.
    const refused = await f.post('/v1/tasks/record', { task: task() });
    assert.equal(refused.status, 400, `自述不足以记完成，实际 ${refused.status}`);
  } finally { await f.close(); }
});

test('有可核验证据与验证文本时完成被接受，且日记记为成功', async () => {
  const f = await fixture();
  try {
    const accepted = await f.post('/v1/tasks/record', {
      task: task({ evidence: 'verifiable', verified: 'test/example.test.ts 通过' }),
    });
    assert.equal(accepted.status, 200, `合法完成应被接受，实际 ${accepted.status}`);
    const archived = await f.post('/v1/tasks/archive', { taskId: 'forged-task' });
    assert.equal(archived.status, 200);
    const journal = f.store.db.prepare(
      "SELECT r.content FROM knowledge k JOIN revisions r ON r.id=k.id AND r.revision=k.head WHERE k.kind='journal'")
      .all() as Array<{ content: string }>;
    const outcome = journal.map(row => (JSON.parse(String(row.content)) as { outcome?: string }).outcome);
    assert.deepEqual(outcome, ['success'], `有证据的完成应记为成功，实际 ${outcome.join(',')}`);
  } finally { await f.close(); }
});

test('管理员可以记录观察级证据', async () => {
  const f = await fixture();
  try {
    const accepted = await f.post('/v1/tasks/record', {
      task: task({ evidence: 'observed', verified: '插件自身观察到核心响应' }),
    }, ADMIN);
    assert.equal(accepted.status, 200, `管理员应可记录观察，实际 ${accepted.status}`);
  } finally { await f.close(); }
});
