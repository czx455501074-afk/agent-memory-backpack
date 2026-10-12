/**
 * Acceptance 16: continuing in a different checkout shows the file difference.
 *
 * "同项目但 checkout 不同：接续前展示文件状态差异，不假定对方修改已经在本地."
 *
 * The audit recorded this as unimplemented: the handoff named files but carried no
 * state, so nothing could show a difference — and a receiving end had no choice but
 * to assume. The property that matters is the three-way answer: a file that was
 * recorded and matches is `same`, one that was recorded and does not match is
 * `different`, and one with no recorded state is `unknown` — never silently
 * reported as `same`. Collapsing `unknown` into `same` is exactly the assumption the
 * acceptance case forbids.
 *
 * In-memory store and a stubbed HTTP handler: no host, no real checkout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { createCoreServer } from '../src/server.js';

const TOKEN = 'a'.repeat(64);
const PROJECT = 'p0';

async function fixture() {
  const store = new Store(':memory:');
  const server = createCoreServer(store, {
    protocolVersion: 1, port: 47631,
    clients: [{ id: 'dsh', token: TOKEN, projectId: PROJECT, role: 'adapter' }],
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body: unknown) => fetch(endpoint + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'x-amb-protocol': '1' },
    body: JSON.stringify({ projectId: PROJECT, ...body as object }),
  });
  return { store, post, async close() {
    server.closeIdleConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
  } };
}

test('验收16：交接带出已记录的文件状态，且接收端可判断差异', async () => {
  const f = await fixture();
  try {
    // The sending end records a task whose files it observed.
    f.store.recordTask(PROJECT, {
      id: 'task-a', title: 'run A', status: 'paused', summary: 'half done',
      unfinished: ['finish the exporter'],
      files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      fileStates: [
        { path: 'src/a.ts', digest: 'aaa', size: 100, observedAt: 1_700_000_000_000 },
        { path: 'src/b.ts', digest: 'bbb', size: 200, observedAt: 1_700_000_000_000 },
        // src/c.ts is listed under `files` but has no recorded state on purpose.
      ],
    });

    // The handoff carries the recorded state and says how much is actually usable.
    const handoff = await (await f.post('/v1/tasks/handoff', { taskId: 'task-a' })).json() as {
      files: string[]; fileStates: Array<{ path: string; digest?: string }>;
      compare: { recorded: number; unrecorded: number }; caveat: string;
    };
    assert.deepEqual(handoff.files, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
    assert.equal(handoff.fileStates.length, 2, '只带出真正记录过状态的文件');
    assert.equal(handoff.compare.recorded, 2);
    assert.equal(handoff.compare.unrecorded, 1, '未记录状态的文件必须被算出来并说明');
    assert.match(handoff.caveat, /比较|核对|不代表/, '必须声明收到的是记录而非已核对结论');

    // A receiving checkout: one file matches, one differs, one was never recorded,
    // and it has an extra file the task never knew about.
    const compared = await (await f.post('/v1/tasks/compare', {
      taskId: 'task-a',
      observed: [
        { path: 'src/a.ts', digest: 'aaa' },                    // same
        { path: 'src/b.ts', digest: 'CHANGED' },                // different
        { path: 'src/c.ts', digest: 'ccc' },                    // recorded nowhere
        { path: 'src/d.ts', digest: 'ddd' },                    // only on this side
      ],
    })).json() as { results: Array<{ path: string; status: string }>; summary: { same: number; different: number; unknown: number } };

    const byPath = new Map(compared.results.map(r => [r.path, r.status]));
    assert.equal(byPath.get('src/a.ts'), 'same', '记录一致的文件判为 same');
    assert.equal(byPath.get('src/b.ts'), 'different', '记录不一致的文件判为 different');
    assert.equal(byPath.get('src/c.ts'), 'unknown', '发送端未记录状态的文件必须判为 unknown，不得假定未变');
    assert.equal(byPath.get('src/d.ts'), 'unknown', '接收端多出的文件也必须报出，而不是被丢弃');
    assert.equal(compared.summary.different, 1);
    assert.equal(compared.summary.unknown, 2);
  } finally { await f.close(); }
});

test('验收16：接收端未提供摘要时一律 unknown，绝不冒充一致', async () => {
  const f = await fixture();
  try {
    f.store.recordTask(PROJECT, {
      id: 'task-b', title: 'run B', status: 'paused',
      files: ['src/a.ts'],
      fileStates: [{ path: 'src/a.ts', digest: 'aaa', size: 10 }],
    });

    // A receiving end that only names paths (no digests) must not be told the files
    // match. "I did not look" and "it has not changed" are different answers.
    const compared = await (await f.post('/v1/tasks/compare', {
      taskId: 'task-b', observed: [{ path: 'src/a.ts' }],
    })).json() as { results: Array<{ status: string; detail: string }>; summary: { same: number; unknown: number } };

    assert.equal(compared.results[0]!.status, 'unknown');
    assert.equal(compared.summary.same, 0, '不得把缺摘要当作一致');
    assert.equal(compared.summary.unknown, 1);
    assert.match(compared.results[0]!.detail, /未提供|不能判断/);

    // A path the task records but the receiving end never mentions is also unknown.
    const partial = await (await f.post('/v1/tasks/compare', { taskId: 'task-b', observed: [] })).json() as {
      results: Array<{ path: string; status: string }>;
    };
    assert.equal(partial.results.length, 1, '发送端记录的文件仍须列出');
    assert.equal(partial.results[0]!.status, 'unknown');

    // A task that never recorded state cannot produce a positive comparison at all.
    f.store.recordTask(PROJECT, { id: 'task-c', title: 'run C', status: 'paused', files: ['src/x.ts'] });
    const none = await (await f.post('/v1/tasks/compare', {
      taskId: 'task-c', observed: [{ path: 'src/x.ts', digest: 'zzz' }],
    })).json() as { summary: { same: number; unknown: number } };
    assert.equal(none.summary.same, 0, '未记录过状态时不得判为一致');
    assert.equal(none.summary.unknown, 1);

    // An unknown task is a clear 404 rather than an empty success.
    const missing = await f.post('/v1/tasks/compare', { taskId: 'nope', observed: [] });
    assert.equal(missing.status, 404, '未知任务必须明确失败');
  } finally { await f.close(); }
});
