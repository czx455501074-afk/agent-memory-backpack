import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Script, createContext } from 'node:vm';
import { Store } from '../src/store.js';
import { classifyCandidate } from '../src/semantic.js';
import { assessMemory, TEMPORARY_MEMORY_TTL } from '../src/memory-policy.js';
import { createCoreServer } from '../src/server.js';
import { UI_JS } from '../src/ui.js';
import type { KnowledgeDraft } from '../src/schema.js';
import { sourceScope } from '../src/source-scope.js';
import { discover } from '../src/discovery.js';
import { candidateToKnowledge, applyRescan } from '../src/rescan.js';

const capture = '【自动捕获的失败事实；待核实】观察：当前服务 HTTP 503，下载超时。根因与修复：尚未验证，不得将其直接当作规范。';
const scope = { kind: 'project' as const, projectId: 'p' };
const memory = (id: string, body = '恢复步骤与验证条件'): KnowledgeDraft => ({ id, title: id, kind: 'memory', scope, body });
const isCode = (code: string) => (error: unknown) => (error as { code: string }).code === code;

function database(t: TestContext) {
  let now = 1_000_000;
  const store = new Store(':memory:', () => now);
  t.after(() => store.close());
  return { store, advance: (ms: number) => { now += ms; }, now: () => now };
}

test('intake distinguishes confirmations, transient observations and bounded verified conclusions', () => {
  for (const text of ['收到，谢谢！', '好的', 'OK', '已完成', 'test']) {
    assert.equal(assessMemory(text).value, 'noise', text);
  }
  const event = classifyCandidate(capture, [], { taskId: 't' });
  assert.equal(event.kind, 'journal');
  assert.equal(event.scope, 'task');
  assert.equal(event.assessment?.durability, 'temporary');
  assert.equal(event.autoPromotable, false);
  assert.equal(assessMemory(capture, { durability: 'durable' }).durability, 'temporary', 'self-declaration cannot erase unverified origin');
  const bounded = classifyCandidate('重试结论：适用：HTTP 429 且 Retry-After 有效。验证：test/retry.test.ts，服务恢复后正常重试，不应永久绕过接口。');
  assert.equal(bounded.kind, 'memory');
  assert.equal(bounded.assessment?.durability, 'durable');
  assert.equal(classifyCandidate('修复项目中的全局变量作用域解析错误').scope, 'project');
  assert.equal(classifyCandidate('日志解析器的通用函数只能用于本项目，不适用所有项目').scope, 'project');
  assert.equal(classifyCandidate('复现条件：SQLite WAL 并发写。证据：https://example.com/issue，验证：test/lock.test.ts').kind, 'memory', 'a citation does not turn experience into external material');
});

test('noise has an idempotent rejection receipt and never reaches knowledge or model review', t => {
  const { store } = database(t);
  const payload = { idempotencyKey: 'noise', projectId: 'p', discovery: '已完成' };
  const receipt = store.submit('agent', payload);
  assert.equal(receipt.state, 'rejected');
  assert.equal(receipt.disposition, 'discarded_low_value');
  assert.deepEqual(store.submit('agent', payload), { id: receipt.id, state: 'rejected', duplicate: true });
  assert.equal(store.searchUniversal('p').length, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM maintenance_jobs WHERE kind='model_review'").get()?.n, 0);
});

test('same text with different task attribution or conditions must not be merged', t => {
  const { store } = database(t);
  for (const id of ['t1', 't2']) store.recordTask('p', { id, title: id, status: 'in_progress' });
  const one = store.submit('a', { projectId: 'p', taskId: 't1', idempotencyKey: 'one', discovery: capture });
  const two = store.submit('a', { projectId: 'p', taskId: 't2', idempotencyKey: 'two', discovery: capture });
  assert.notEqual(one.id, two.id);
  const three = store.submit('a', { projectId: 'p', taskId: 't1', idempotencyKey: 'three', discovery: capture,
    memoryContext: { appliesWhen: ['provider B'] } });
  assert.notEqual(one.id, three.id);
});

test('legacy temporary candidates cannot become rules, skills, global or project-wide task facts', t => {
  const { store } = database(t);
  store.recordTask('p', { id: 't', title: 'temporary outage', status: 'in_progress' });
  const receipt = store.submit('a', { projectId: 'p', taskId: 't', idempotencyKey: 'event', discovery: capture });
  const row = store.db.prepare('SELECT payload FROM proposals WHERE id=?').get(receipt.id)!;
  const payload = JSON.parse(String(row.payload)); delete payload.classification;
  store.db.prepare('UPDATE proposals SET payload=? WHERE id=?').run(JSON.stringify(payload), receipt.id);
  const options = { projectId: 'p', allowGlobalScope: true, classificationAcknowledged: true };
  assert.throws(() => store.approveProposal(receipt.id, { id: 'rule', title: 'never retry', kind: 'norm', scope, body: '永远禁止使用接口' }, options), isCode('temporary_memory_requires_event'));
  assert.throws(() => store.approveProposal(receipt.id, { ...memory('global'), scope: { kind: 'global' } }, options), isCode('temporary_memory_requires_event'));
  assert.throws(() => store.approveProposal(receipt.id, memory('wide'), options), isCode('temporary_memory_requires_task'));
  assert.equal(store.getProposal(receipt.id, 'p').state, 'pending');
});

test('temporary facts expire on every retrieval path without deleting history or renewing on read', t => {
  const { store, now, advance } = database(t);
  store.recordTask('p', { id: 't', title: 'outage', status: 'in_progress' });
  const receipt = store.submit('a', { projectId: 'p', taskId: 't', idempotencyKey: 'event', discovery: capture,
    memoryContext: { appliesWhen: ['provider is unavailable'], invalidatedWhen: ['health check succeeds'] } });
  store.approveProposal(receipt.id, { ...memory('event', capture), scope: { kind: 'task', projectId: 'p', taskId: 't' } },
    { projectId: 'p', classificationAcknowledged: true });
  const expiry = now() + TEMPORARY_MEMORY_TTL;
  assert.equal(store.readKnowledge('p', 'event', false, 't').validity?.expiresAt, expiry);
  assert.equal(store.searchUniversal('p', '503', undefined, 20, 't').length, 1);
  assert.equal(store.searchUniversal('p', '503').length, 0);
  assert.throws(() => store.readKnowledge('p', 'event'), isCode('not_found'));
  assert.throws(() => store.readKnowledge('other', 'event', false, 't'), isCode('not_found'));
  advance(TEMPORARY_MEMORY_TTL - 1);
  assert.equal(store.readKnowledge('p', 'event', false, 't').validity?.expiresAt, expiry);
  advance(1);
  assert.equal(store.scopedEntries('p', 't').length, 0);
  assert.equal(store.prepare('p', '503', { taskId: 't' }).knowledge.length, 0);
  assert.throws(() => store.readKnowledge('p', 'event', false, 't'), isCode('not_found'));
  assert.equal(store.allEntries().find(e => e.id === 'event')?.content.validity?.expiresAt, expiry);
});

test('expiry applies to normative injection and tool gate as well as explicit search', t => {
  const { store, now, advance } = database(t);
  store.import([{ id: 'timed-rule', kind: 'norm', title: 'maintenance', scope, body: '维护期间禁止写入', deniedTools: ['write'],
    validity: { expiresAt: now() + 10, reason: 'maintenance window' } }]);
  assert.equal(store.gate('p', 'write').decision, 'deny');
  advance(10);
  assert.equal(store.gate('p', 'write').decision, 'allow');
  assert.equal(store.norms('p').length, 0);
  assert.equal(store.searchUniversal('p', '维护').length, 0);
  assert.equal(store.getKnowledge('p', 'timed-rule').content.id, 'timed-rule', 'management can still inspect expired records');
});

async function core(t: TestContext, withModel = false) {
  const dir = mkdtempSync(join(tmpdir(), 'amb-memory-quality-'));
  const store = new Store(join(dir, 'knowledge.sqlite'));
  const provider = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += String(part);
    const input = JSON.parse(body);
    const payload = JSON.parse(input.messages[1].content);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ selectedIds: [payload.catalog[0][0]], reason: 'selected a subset' }) } }] }));
  });
  if (withModel) {
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address(); assert(address && typeof address === 'object');
    writeFileSync(join(dir, 'model-review.json'), JSON.stringify({ endpoint: `http://127.0.0.1:${address.port}/v1`, model: 'fixture' }));
  }
  const token = 'memory-quality-isolated-test-token-000';
  const server = createCoreServer(store, { protocolVersion: 1, port: 47631, clients: [{ id: 'admin', token, projectId: 'p', role: 'admin' }] });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  t.after(async () => {
    for (const s of [server, provider]) if (s.listening) { s.closeAllConnections(); await new Promise<void>(resolve => s.close(() => resolve())); }
    store.close(); rmSync(dir, { recursive: true, force: true });
  });
  return { store, async post(path: string, data: Record<string, unknown>) {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-amb-protocol': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'p', ...data }) });
    return { status: response.status, data: await response.json() as any };
  } };
}

test('HTTP search retains lexical hits beyond a model subset, paginates and rejects changed revisions', async t => {
  const f = await core(t, true);
  f.store.import([memory('a', 'restore checkpoint manifest'), memory('b', 'restore checksum verification'), memory('c', 'restore rollback rehearsal')]);
  const first = await f.post('/v1/knowledge/search-universal', { query: 'restore', limit: 1 });
  assert.equal(first.status, 200);
  assert.equal(first.data.page.total, 3);
  assert.equal(first.data.page.hasMore, true);
  assert.equal(first.data.coverage.complete, false);
  const second = await f.post('/v1/knowledge/search-universal', { query: 'restore', limit: 2, offset: first.data.page.nextOffset, knowledgeRevision: first.data.knowledgeRevision, searchSnapshot: first.data.page.searchSnapshot });
  assert.equal(second.data.results.length, 2);
  assert.equal(new Set([...first.data.results, ...second.data.results].map((e: any) => e.id)).size, 3);
  assert.equal(second.data.page.hasMore, false);
  assert.equal((await f.post('/v1/knowledge/search-universal', { query: 'restore', offset: 1, searchSnapshot: 'changed-result-order' })).status, 409);
  f.store.import([memory('d')]);
  assert.equal((await f.post('/v1/knowledge/search-universal', { query: 'restore', offset: 1, knowledgeRevision: first.data.knowledgeRevision })).status, 409);
});

test('HTTP query reads expose all matching passage pages, related ids and scope instead of a misleading prefix', async t => {
  const f = await core(t);
  const body = ['unrelated prefix '.repeat(200), ...Array.from({ length: 6 }, (_, i) => `\n## Section ${i}\nneedlecriterion${i} restore condition\n${'unrelated filler '.repeat(100)}`)].join('\n');
  f.store.import([memory('long', body), { ...memory('task', 'restore scoped task fact'), scope: { kind: 'task', projectId: 'p', taskId: 't' } },
    { ...memory('other', 'restore private'), scope: { kind: 'project', projectId: 'other' } }]);
  const search = await f.post('/v1/knowledge/search-universal', { query: 'needlecriterion5', literal: true });
  assert.match(search.data.results[0].excerpt, /needlecriterion5/);
  const first = await f.post('/v1/knowledge/read', { knowledgeId: 'long@1', query: 'restore' });
  assert.equal(first.data.body, '');
  assert.equal(first.data.coverage.complete, false);
  assert.equal(first.data.coverage.hasMore, true);
  const second = await f.post('/v1/knowledge/read', { knowledgeId: 'long@1', query: 'restore', passageOffset: first.data.coverage.nextPassageOffset });
  assert.equal(second.data.coverage.hasMore, false);
  assert.equal(new Set([...first.data.passages, ...second.data.passages].map((p: any) => p.offset)).size, first.data.coverage.matchedPassages);
  assert.equal((await f.post('/v1/knowledge/read', { knowledgeId: 'task' })).status, 404);
  assert.equal((await f.post('/v1/knowledge/read', { knowledgeId: 'task', taskId: 't' })).status, 200);
  const scoped = await f.post('/v1/knowledge/search-universal', { query: 'restore', literal: true, taskId: 't', scope: 'task' });
  assert.deepEqual(scoped.data.results.map((e: any) => e.id), ['task']);
  assert.equal((await f.post('/v1/knowledge/read', { knowledgeId: 'other' })).status, 404);
});

test('automatic HTTP search cannot inject unresolved or historical curation through literal fallback', async t => {
  const f = await core(t);
  const curation = { batchId: 'fixture', role: 'record' as const, scopeStatus: 'unresolved' as const, durability: 'historical' as const, sources: [], members: [] };
  f.store.import([{ ...memory('old-observation', 'restore service recovered on an earlier date'), curation }]);
  const explicit = await f.post('/v1/knowledge/search-universal', { query: 'restore', literal: true });
  assert.equal(explicit.data.results.length, 1);
  const automatic = await f.post('/v1/knowledge/search-universal', { query: 'restore', literal: true, autoRecall: true });
  assert.equal(automatic.data.results.length, 0);
});

test('HTTP ingestion retains structured evidence through adoption and checkpoint journal reads', async t => {
  const f = await core(t);
  const evidenceRefs = [{ kind: 'artifact', locator: 'verification/report.json', snapshot: '{"checks":3,"passed":3}' }];
  const submission = await f.post('/v1/proposals', { idempotencyKey: 'http-proof', sessionId: 'session-proof',
    discovery: '适用：恢复配置。验证：核对三个清单项并复算摘要。', evidence: '三个清单项通过', evidenceRefs });
  assert.equal(submission.status, 200);
  assert.equal(submission.data.evidenceStatus, 'captured');
  const adoption = await f.post('/v1/proposals/approve', { id: submission.data.id, entry: memory('http-proof'), classificationAcknowledged: true });
  assert.equal(adoption.status, 200);
  const read = await f.post('/v1/knowledge/read', { knowledgeId: 'http-proof' });
  assert.equal(read.data.support.references[0].snapshot, evidenceRefs[0]!.snapshot);
  assert.deepEqual(read.data.support.origin.sessionIds, ['session-proof']);
  const checkpoint = await f.post('/v1/tasks/checkpoint', { sessionId: 'session-proof', verified: '三个清单项通过', evidence: 'verifiable', evidenceRefs });
  assert.equal(checkpoint.status, 200);
  const journal = await f.post('/v1/knowledge/read', { knowledgeId: checkpoint.data.journalId });
  assert.equal(journal.data.support.references[0].snapshot, evidenceRefs[0]!.snapshot);
});

test('browser approval creates a valid task journal rather than widening it or retaining invalid body fields', () => {
  const fields: Record<string, { value: string }> = Object.fromEntries(Object.entries({ 'pe-scope': 'task', 'pe-id': 'j', 'pe-title': 'Outage', 'pe-body': capture, 'pe-did': capture, 'pe-kind': 'journal' }).map(([key,value])=>[key,{value}]));
  const context = createContext({ document: { getElementById: (id: string) => fields[id], addEventListener() {}, querySelectorAll: () => [] },
    window: {}, localStorage: { getItem: () => 'p', setItem() {} }, setInterval: () => 0, setTimeout: () => 0, clearInterval() {}, fetch: async () => { throw Error('unused'); }, location: { search: '' }, URLSearchParams });
  // Execute the delivered form function itself; top-level tab wiring needs a real DOM.
  const source = UI_JS.slice(UI_JS.indexOf('function buildApprovalEntry('), UI_JS.indexOf('function programmaticApproval('));
  new Script('function getProject(){return "p";}\n' + source).runInContext(context);
  const result = new Script(`buildApprovalEntry({payload:{taskId:'t'},target:{}})`).runInContext(context);
  assert.equal(result.entry.scope.kind, 'task');
  assert.equal(result.entry.scope.taskId, 't');
  assert.equal(result.entry.outcome, 'unverified');
  assert.equal('body' in result.entry, false);
});

test('file adoption uses source ownership, namespaces project ids and keeps shared histories for scope review', t => {
  const dir = mkdtempSync(join(tmpdir(), 'amb-source-scope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = join(dir, 'project'), global = join(dir, 'user-agent');
  mkdirSync(project); mkdirSync(global);
  writeFileSync(join(project, 'AGENTS.md'), '# Rule\nNever leak credentials.');
  writeFileSync(join(global, 'AGENTS.md'), '# User rule\nRedact secrets.');
  writeFileSync(join(global, 'MEMORY.md'), '# Memory\nA fact from an unidentified project.');
  const context = { projectId: 'p', projectRoot: project, globalRoots: [global] };
  assert.equal(sourceScope(join(project, 'AGENTS.md'), context, 'norm').scope.kind, 'project');
  assert.equal(sourceScope(join(global, 'AGENTS.md'), context, 'norm').scope.kind, 'global');
  const report = discover([project, global], 100, context);
  const projectRule = report.candidates.find(c => c.source.path === join(project, 'AGENTS.md'))!;
  assert.equal(candidateToKnowledge(projectRule).scope.kind, 'project');
  assert.equal(candidateToKnowledge(projectRule).support?.references[0]?.locator, join(project, 'AGENTS.md'));
  assert.equal(candidateToKnowledge(projectRule).support?.references[0]?.reportedHash, projectRule.source.hash);
  const secondProjectRule = discover([project], 100, { ...context, projectId: 'other' }).candidates[0]!;
  assert.notEqual(projectRule.id, secondProjectRule.id, 'same bytes in different projects cannot collapse into one global identity');
  assert.equal(report.candidates.find(c => c.kind === 'memory')?.scopeReviewRequired, true);
  const { store } = database(t);
  const result = applyRescan(store, [project, global], context);
  assert.equal(result.errors.length, 1, 'unattributed shared history remains in source files for review');
  assert.equal(store.searchUniversal('other').some(c => c.scope.kind === 'project'), false);
  const explicit = discover([global], 100, { ...context, explicitProject: true }).candidates.find(c => c.kind === 'memory')!;
  assert.equal(explicit.scopeReviewRequired, undefined);
  assert.equal(explicit.scope?.kind, 'project');
});

test('model low-value or split advice tightens every approval route without granting model authority', t => {
  const { store } = database(t);
  const receipt = store.submit('a', { projectId: 'p', idempotencyKey: 'low-value', discovery: '这是一条没有适用条件但需要人工核对的新发现。' });
  assert.equal(store.proposalClassificationGate(receipt.id, 'p').required, false);
  store.db.prepare('INSERT INTO model_reviews VALUES(?,?,?,?)').run(receipt.id, 'p', JSON.stringify({
    mode: 'model', status: 'analyzed', analysis: { kind: 'memory', scope: 'project', relation: 'low_value', needsSplit: false },
  }), 1000);
  assert.equal(store.proposalClassificationGate(receipt.id, 'p').required, true);
  assert.equal(store.classificationGateFor('p', [receipt.id]).length, 1);
  assert.throws(() => store.approveProposal(receipt.id, memory('reviewed'), { projectId: 'p' }), isCode('classification_confirmation_required'));
  store.approveProposal(receipt.id, memory('reviewed'), { projectId: 'p', classificationAcknowledged: true });
  assert.equal(store.searchUniversal('p', '恢复').length, 1);
});

test('large chronological memories are detected as composite journals instead of a single durable fact', () => {
  const text = '[2026-09-27 01:48] 服务当前不可用，HTTP 503\n§\n[2026-09-28 02:30] 服务已恢复，不能沿用昨日状态';
  const analysis = classifyCandidate(text);
  assert.equal(analysis.kind, 'journal');
  assert.equal(analysis.needsSplit, true);
  assert.equal(analysis.autoPromotable, false);
  assert.equal(analysis.assessment?.mixedContexts, true);
  const split = classifyCandidate('严禁泄漏凭据；用户偏好中文回复').suggestedSplit!;
  assert.ok(split.every(part => !/部分$/.test(part.text)));
  assert.match(split.find(part=>part.kind==='norm')!.text, /严禁泄漏凭据/);
});
