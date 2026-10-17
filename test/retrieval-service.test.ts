import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { Store } from '../src/store.js';
import { createCoreServer } from '../src/server.js';
import { createRetrievalService, MODEL_BUDGET_MS } from '../src/retrieval-service.js';
import { UI_JS } from '../src/ui.js';

const entry = { id: 'recovery-note', kind: 'memory' as const, title: 'Transport recovery',
  scope: { kind: 'global' as const }, baseRevision: 0, provenance: 'user' as const,
  body: 'Restart the connection after verifying the endpoint. literalneedle exists only inside this complete source.' };
type Payload = { query: string; catalog: Array<[string, number, string, string, string]> };
async function fixture(t: TestContext, respond: (payload: Payload, response: ServerResponse) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'amb-retrieval-service-'));
  const store = new Store(join(dir, 'knowledge.sqlite'));
  store.import([entry]);
  let calls = 0;
  const provider = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += String(part);
    calls++;
    try {
      const input = JSON.parse(body) as { messages: Array<{ content: string }> };
      await respond(JSON.parse(input.messages[1]!.content) as Payload, res);
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise<void>(done => provider.listen(0, '127.0.0.1', done));
  const address = provider.address(); assert(address && typeof address === 'object');
  writeFileSync(join(dir, 'model-review.json'), JSON.stringify({ endpoint: `http://127.0.0.1:${address.port}/v1`, model: 'retrieval-fixture' }));
  const token = 'isolated-retrieval-service-token-32-characters';
  const core = createCoreServer(store, { protocolVersion: 1, port: 47631,
    clients: [{ id: 'codex', token, projectId: 'shared', role: 'adapter' }] });
  await new Promise<void>(done => core.listen(0, '127.0.0.1', done));
  const coreAddress = core.address(); assert(coreAddress && typeof coreAddress === 'object');
  t.after(async () => {
    for (const server of [core, provider]) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
    store.close(); rmSync(dir, { recursive: true, force: true });
  });
  return { store, dir, calls: () => calls, select: createRetrievalService(store, dir),
    async post(path: string, payload: Record<string, unknown>) {
      const res = await fetch(`http://127.0.0.1:${coreAddress.port}${path}`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-amb-protocol': '1' },
        body: JSON.stringify({ projectId: 'shared', ...payload }) });
      assert.equal(res.status, 200, await res.clone().text());
      return await res.json() as Record<string, any>;
    } };
}
function selected(payload: Payload, response: ServerResponse) {
  const candidate = payload.catalog.find(row => row[0] === entry.id)!;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ selected: [
    { id: candidate[0], revision: candidate[1], reason: 'Fixture chooses the configured relevant source' }] }) } }] }));
}

test('prepare, automatic recall and explicit semantic search share HTTP selection and query/revision cache', async t => {
  const f = await fixture(t, selected);
  const query = 'repair a disconnected transport';
  const prepared = await f.post('/v1/prepare', { adapter: 'codex', query });
  assert.equal(prepared.retrieval.selection.mode, 'model');
  assert.deepEqual(prepared.knowledge.map((item: any) => item.id), [entry.id]);
  const automatic = await f.post('/v1/knowledge/search-universal', { query, autoRecall: true });
  const explicit = await f.post('/v1/knowledge/search-universal', { query });
  assert.deepEqual(automatic.results.map((item: any) => item.id), [entry.id]);
  assert.deepEqual(explicit.results.map((item: any) => item.id), [entry.id]);
  assert.equal(f.calls(), 1, 'all three core routes share one query/revision selection');
  await f.post('/v1/knowledge/search-universal', { query: 'different substantive query' });
  assert.equal(f.calls(), 2, 'different query has a separate cache entry');
  f.store.import([{ ...entry, baseRevision: 1, body: entry.body + ' Updated verified detail.' }]);
  await f.post('/v1/knowledge/search-universal', { query });
  assert.equal(f.calls(), 3, 'knowledge update invalidates old cache entry');
});

test('identical concurrent decisions merge and an in-flight old revision is discarded', async t => {
  let release!: () => void, entered!: () => void;
  let gate = new Promise<void>(resolve => { release = resolve; });
  let start = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture(t, async (payload, response) => { entered(); await gate; selected(payload, response); });
  const one = f.select('shared', 'repair connection');
  const two = f.select('shared', 'repair connection');
  await start; assert.equal(f.calls(), 1);
  release();
  assert.deepEqual(await one, await two);
  assert.equal(f.calls(), 1);
  gate = new Promise<void>(resolve => { release = resolve; });
  start = new Promise<void>(resolve => { entered = resolve; });
  const stale = f.select('shared', 'repair another connection');
  await start;
  f.store.import([{ ...entry, baseRevision: 1, body: 'A newer source has replaced the original guidance.' }]);
  release();
  assert.deepEqual(await stale, { mode: 'lexical_fallback', selectedIds: [], reason: 'knowledge_changed' });
  assert.equal((await f.select('shared', 'repair another connection')).mode, 'model');
  assert.equal(f.calls(), 3, 'discarded old response is never cached as a current answer');
});

test('unavailable model does not guess automatic recall; explicit literal full text remains available', async t => {
  const f = await fixture(t, (_payload, response) => { response.writeHead(503); response.end(); });
  const prepared = await f.post('/v1/prepare', { query: 'literalneedle' });
  assert.equal(prepared.retrieval.selection.mode, 'index');
  assert.equal(prepared.retrieval.selection.reason, 'local_index:unavailable');
  assert.deepEqual(prepared.knowledge, []);
  const automatic = await f.post('/v1/knowledge/search-universal', { query: 'literalneedle', autoRecall: true });
  assert.deepEqual(automatic.results, []);
  const calls = f.calls();
  const literal = await f.post('/v1/knowledge/search-universal', { query: 'literalneedle', literal: true });
  assert.deepEqual(literal.results.map((item: any) => item.id), [entry.id]);
  assert.equal(literal.selection.reason, 'explicit_full_text');
  assert.equal(f.calls(), calls, 'explicit literal path must not call the unavailable model');
});

test('management UI script compiles as delivered to the browser', () => {
  assert.doesNotThrow(() => new Script(UI_JS, { filename: 'amb-management-ui.js' }));
  for (const field of ['digest.summary', 'digest.whenToUse', 'digest.exclusions', 'digest.aliases', 'digest.versions']) assert(UI_JS.includes(field));
  assert(UI_JS.includes('检索辅助归纳'));
  assert(UI_JS.includes('非已采纳流程'));
  assert(UI_JS.includes("esc(digest.summary || '尚无归纳')"));
  assert(UI_JS.includes("esc((Array.isArray(row[1])?row[1]:[]).join('；')"));
  assert(!UI_JS.includes('凭据仅保存在当前标签页内存中，不写入磁盘'));
});

test('service sends current-revision digest as separate full-catalog advice, preserving source and ignoring newer stale drafts', async t => {
  const digest = { summary: 'semantic source summary', whenToUse: ['positive intent'], exclusions: ['excluded intent'], aliases: ['semantic alias'], versions: ['v2'] };
  let checked = false;
  const f = await fixture(t, (payload, response) => {
    const row = payload.catalog.find(item => item[0] === entry.id) as unknown as unknown[];
    assert.equal(row[4], entry.body.slice(0, 120));
    assert.deepEqual(row[5], [digest.summary, 'positive intent', 'excluded intent', 'semantic alias', 'v2']);
    checked = true;
    selected(payload, response);
  });
  const insert = f.store.db.prepare('INSERT INTO workflow_drafts VALUES(?,?,?,?,?,?,?)');
  insert.run('valid', 'shared', entry.id, 'source', 'needs_evidence', JSON.stringify({ source: { skillId: entry.id, revision: 1 }, digest }), 10);
  insert.run('old-version', 'shared', entry.id, 'old', 'needs_evidence', JSON.stringify({ source: { skillId: entry.id, revision: 2 }, digest: { ...digest, summary: 'wrong revision' } }), 20);
  insert.run('stale', 'shared', entry.id, 'stale', 'stale', JSON.stringify({ source: { skillId: entry.id, revision: 1 }, digest: { ...digest, summary: 'stale draft' } }), 30);
  assert.equal((await f.select('shared', 'different semantic task')).mode, 'model');
  assert.equal(checked, true);
});

test('calibration: no-provider service returns factual evidence, aliases and exact IDs without inference',async t=>{
  const f=await fixture(t,selected);
  rmSync(join(f.dir,'model-review.json'));
  f.store.import([{...entry,id:'memory:database',title:'Incident record',baseRevision:0,
    body:'Postgres restore failed with permission denied; grant schema ownership before restoring.'}]);
  const result=await f.select('shared','Postgres restore permission denied');
  assert.equal(result.mode,'index');
  assert.equal(result.reason,'local_index:not_configured');
  assert.deepEqual(result.selectedIds,['memory:database']);
  const exact=await f.select('shared','read memory:database@1');
  assert.equal(exact.reason,'exact_id');assert.deepEqual(exact.selectedIds,['memory:database']);
  assert.deepEqual((await f.select('shared','不要 Postgres restore')).selectedIds,[]);
  assert.deepEqual((await f.select('shared','好的')).selectedIds,[]);
  assert.equal(f.calls(),0);
});

test('calibration: procedure queue changes preserve cached selection but digest changes invalidate it',async t=>{
  const f=await fixture(t,selected);
  const query='repair transport connection';
  await f.select('shared',query);assert.equal(f.calls(),1);
  const insert=f.store.db.prepare('INSERT INTO workflow_drafts VALUES(?,?,?,?,?,?,?)');
  insert.run('pending','shared',entry.id,'source','pending',null,100);
  await f.select('shared',query);assert.equal(f.calls(),1);
  f.store.db.prepare("UPDATE workflow_drafts SET state='awaiting_model',updated_at=200 WHERE id='pending'").run();
  await f.select('shared',query);assert.equal(f.calls(),1);
  const digest={summary:'Connection recovery',whenToUse:['repair transport connection'],aliases:[],exclusions:[],versions:[]};
  f.store.db.prepare("UPDATE workflow_drafts SET result=?,updated_at=300 WHERE id='pending'").run(JSON.stringify({source:{skillId:entry.id,revision:1},digest}));
  await f.select('shared',query);assert.equal(f.calls(),2);
  f.store.db.prepare("UPDATE workflow_drafts SET state='completed',updated_at=400 WHERE id='pending'").run();
  await f.select('shared',query);assert.equal(f.calls(),2);
});

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
// `restart the connection after verifying the endpoint` is written in the fixture
// source, so the local index has a real answer for it without any provider.
const budgetQuery = 'restart the connection after verifying the endpoint';

test('exhausted model budget cancels the provider request and a late answer never replaces or caches the verdict', async t => {
  let cancelled = false, reached = false;
  const f = await fixture(t, async (_payload, response) => {
    reached = true;
    response.on('close', () => { if (!response.writableEnded) cancelled = true; });
    await new Promise<void>(() => { /* this provider never answers */ });
  });
  const started = Date.now();
  const first = await f.select('shared', budgetQuery);
  assert.equal(first.mode, 'index');
  assert.equal(first.reason, 'local_index:model_timeout');
  assert.deepEqual(first.selectedIds, [entry.id], 'the deterministic local ranking is still an answer inside the budget');
  assert.equal(reached, true, 'the provider was actually asked before the budget expired');
  // The budget is MODEL_BUDGET_MS while the abandoned fetch bounds itself at 4000ms, so
  // observing the cancel after the budget but before 4000ms proves the budget aborted it
  // rather than the fetch giving up on its own. Read the constant instead of copying the
  // number: the previous version waited a hardcoded 3200ms, which was 700ms of slack against
  // a 2500ms budget, and raising the budget turned a correct assertion red.
  assert.ok(MODEL_BUDGET_MS < 4000, 'the fetch bound must stay longer than the budget, or this test proves nothing');
  while (Date.now() - started < MODEL_BUDGET_MS + 400 && !cancelled) await delay(50);
  assert.equal(cancelled, true, 'the exhausted budget aborts the request it stopped waiting for');
  // Wait past that 4000ms bound: it is when the abandoned fetch used to fail and
  // write `local_index:timeout` with an empty selection into the query cache.
  while (Date.now() - started < 4500) await delay(50);
  const second = await f.select('shared', budgetQuery);
  assert.notEqual(second.reason, 'local_index:timeout', 'the late failure must not overwrite the returned verdict');
  assert.equal(second.reason, 'local_index:model_timeout');
  assert.deepEqual(second.selectedIds, first.selectedIds, 'the same query keeps the same answer');
  assert.ok(second.selectedIds.length > 0);
});

test('a model answer is reused from the query/revision cache instead of re-inferred', async t => {
  const f = await fixture(t, selected);
  const first = await f.select('shared', budgetQuery);
  assert.equal(first.mode, 'model');
  assert.deepEqual(first.selectedIds, [entry.id]);
  assert.equal(f.calls(), 1);
  const second = await f.select('shared', budgetQuery);
  assert.deepEqual(second, first);
  assert.equal(f.calls(), 1, 'an identical question is answered from the cache');
});

test('a provider rejection stays a local index answer and never guesses', async t => {
  const f = await fixture(t, (_payload, response) => { response.writeHead(503); response.end(); });
  const result = await f.select('shared', budgetQuery);
  assert.equal(result.mode, 'index');
  assert.equal(result.reason, 'local_index:unavailable');
  assert.deepEqual(result.selectedIds, []);
});
