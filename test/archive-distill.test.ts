import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { Store } from '../src/store.js';
import { createCoreServer } from '../src/server.js';

/**
 * The turn boundary distils — and only distils.
 *
 * Two facts are pinned here, and the second is the one that keeps the feature acceptable:
 *
 *   - when the host signals "this turn ended", the candidate exists by the time the human looks,
 *     instead of waiting for the six-hour window (the peer comparison's whole point);
 *   - what appears is a row in the *derived* candidate table, never a proposal and never
 *     knowledge. `runEvolution` cannot promote — the eight-item `FORBIDDEN_AUTOMATIC` list is what
 *     guarantees that — so the check is that the proposal count does not move.
 *
 * The adapter cannot run the distiller itself: `/v1/evolution/run` is admin-only by design. That is
 * why the signal travels through the archive call the adapter is already allowed to make, and why
 * this test drives the HTTP endpoint rather than the store method.
 */

const roots: string[] = [];
const stores: Store[] = [];
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

/**
 * The shape the failure-capture path writes, so the signature extractor sees a real signal.
 *
 * The two fixtures differ **only in fields the signature normalises away** (the session id). That
 * is not decoration: `submit` answers an exact-text twin with the existing candidate instead of
 * storing a second row, so two identical submissions produce one signal and the distiller's
 * "at least twice" gate can never be met. Same failure in two sessions is also what actually
 * happens — which is precisely what the signature is built to collapse.
 */
const failure = (session: string) => '【自动捕获的失败事实；待核实】\n所属流程：工具执行与故障恢复；步骤：记录失败、检索已有经验、验证修复。\n'
  + `来源：dsh 会话 ${session}；工具：pwsh。\n失败来源类别：task_failure；判据：default。\n观察：exit_code=1\n根因与修复：尚未验证；请主动检索相关经验。`;

/** Two same-signature failures, three minutes apart: the distiller's own entry gate. */
function seeded() {
  const directory = mkdtempSync(join(tmpdir(), 'backpack-distill-'));
  roots.push(directory);
  let clock = 1_000_000;
  const store = new Store(join(directory, 'knowledge.sqlite'), () => clock);
  stores.push(store);
  store.submit('principal', { idempotencyKey: 'fail-1', projectId: 'p0-workflow', discovery: failure('3f8c1111-1111-1111-1111-111111111111') });
  clock += 3 * 60 * 1000;
  store.submit('principal', { idempotencyKey: 'fail-2', projectId: 'p0-workflow', discovery: failure('91ab2222-2222-2222-2222-222222222222') });
  store.db.prepare(`INSERT INTO tasks(id,project_id,title,status,summary,notes,knowledge_revision,unfinished,created_at,updated_at,completed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run('task-1', 'p0-workflow', '任务', 'in_progress', '', '', 0, '[]', clock, clock, null);
  return store;
}

async function withServer(store: Store, run: (post: (body: unknown) => Promise<Record<string, any>>) => Promise<void>) {
  const token = 'w'.repeat(64);
  const server = createCoreServer(store, { protocolVersion: 1, port: 47631,
    clients: [{ id: 'dsh', token, projectId: 'p0-workflow', role: 'adapter' }] });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const post = async (body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${address.port}/v1/tasks/archive`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-amb-protocol': '1' },
      body: JSON.stringify(body) });
    assert.equal(res.status, 200, await res.clone().text());
    return await res.json() as Record<string, any>;
  };
  try { await run(post); }
  finally { server.closeAllConnections(); server.close(); }
}

const candidateRows = (store: Store) => Number((store.db.prepare('SELECT count(*) n FROM evolve_candidates').get() as { n: number }).n);
const proposalRows = (store: Store) => Number((store.db.prepare('SELECT count(*) n FROM proposals').get() as { n: number }).n);

test('a turn that ends with the signal produces candidates without touching knowledge', async () => {
  const store = seeded();
  const proposalsBefore = proposalRows(store);
  await withServer(store, async post => {
    const receipt = await post({ projectId: 'p0-workflow', taskId: 'task-1', distill: true });
    assert.ok(receipt.distilled, '带信号时必须如实回报这一趟的结果');
    assert.ok(receipt.distilled.scanned > 0, '至少要扫描到那两条同签名失败（否则这条断言是空检查）');
    assert.ok(receipt.distilled.candidates > 0, '同签名两次、跨度三分钟，应当产出一条候选');
    assert.equal(receipt.distilled.error, undefined);
    assert.match(receipt.note, /只写候选表/, '回执要说明它没有自动采纳');
  });
  assert.ok(candidateRows(store) > 0, '候选必须真的落进派生表');
  assert.equal(proposalRows(store), proposalsBefore, '提炼绝不产生提案：采纳仍然只能由人触发');
  assert.equal(Number((store.db.prepare('SELECT value v FROM meta WHERE key=?').get('revision') as { v: number }).v), store.revision,
    '知识版本不该因为一次提炼而改变');
});

test('without the signal nothing is distilled', async () => {
  // The counter-direction: if this also produced candidates, "the adapter decides when" would be
  // false, and every archive from an older adapter would silently start a pass.
  const store = seeded();
  await withServer(store, async post => {
    const receipt = await post({ projectId: 'p0-workflow', taskId: 'task-1' });
    assert.equal(receipt.distilled, undefined, '没有信号时不得出现该字段（否则无法区分"没跑"与"跑了没结果"）');
    assert.ok(receipt.note, '归档本身的说明照旧');
  });
  assert.equal(candidateRows(store), 0, '没有信号就不该产生任何候选');
});
