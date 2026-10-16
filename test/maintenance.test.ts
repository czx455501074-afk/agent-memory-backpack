import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { createCoreServer } from '../src/server.js';
import { createMaintenanceWorker, maintenanceStatus } from '../src/maintenance.js';

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'amb-maintenance-'));
  return { dir, close() { const rel = relative(resolve(tmpdir()), resolve(dir)); assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel)); rmSync(dir, { recursive: true, force: true }); } };
}

test('candidate transaction queues a real model job; no configuration stays awaiting_model', async () => {
  const f = scratch(); const store = new Store(':memory:');
  try {
    const receipt = store.submit('dsh', { projectId: 'p', idempotencyKey: 'candidate-1', discovery: 'SQLite WAL模式在并发写时需要设置busy_timeout。' });
    assert.equal(store.jobs.list().filter(job => job.kind === 'model_review').length, 1);
    const worker = createMaintenanceWorker(store, f.dir);
    await worker.tick();
    const status = maintenanceStatus(store, 'p');
    const job = status.jobs.find(job => job.kind === 'model_review')!;
    assert.equal(job.status, 'pending');
    assert.equal(job.error, 'awaiting_model');
    assert.equal(status.reviews[0]?.proposalId, receipt.id);
    assert.equal(status.reviews[0]?.result.status, 'awaiting_model');
    assert.equal(status.reviews[0]?.result.mode, 'heuristic_only');
    assert.equal(store.listProposals('p')[0]?.state, 'pending');
    assert.equal(store.allEntries().length, 0);
    worker.stop();
  } finally { store.close(); f.close(); }
});

test('local model worker persists advisory analysis, redacts response secrets and never approves', async () => {
  const f = scratch(); const store = new Store(':memory:');
  const key = 'private-model-fixture-key'; let calls = 0; let seen = '';
  const model = createServer(async (req, res) => {
    calls++; for await (const chunk of req) seen += chunk;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: 'memory', scope: 'project', relation: 'new', confidence: 0.9, needsSplit: false, summary: `结果 ${key}`, reasoning: '证据仍需人工核对' }) } }] }));
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const address = model.address(); assert.ok(address && typeof address !== 'string');
  try {
    writeFileSync(join(f.dir, 'model-review.json'), JSON.stringify({ endpoint: `http://127.0.0.1:${address.port}/v1`, model: 'fixture-model', apiKey: key }));
    const receipt = store.submit('codex', { projectId: 'p', idempotencyKey: 'model-candidate', discovery: `排障发现 SQLite连接重试有用，secret=${key}` });
    const worker = createMaintenanceWorker(store, f.dir); await worker.tick();
    const status = maintenanceStatus(store, 'p');
    assert.equal(calls, 1);
    assert.ok(!seen.includes(key));
    assert.equal(status.reviews[0]?.proposalId, receipt.id);
    assert.equal(status.reviews[0]?.result.status, 'analyzed');
    assert.equal(status.reviews[0]?.result.authority, 'advisory');
    assert.ok(!JSON.stringify(status).includes(key));
    assert.equal(status.jobs.find(job => job.kind === 'model_review')?.status, 'completed');
    assert.equal(store.listProposals('p')[0]?.state, 'pending');
    assert.equal(store.allEntries().length, 0);
    await worker.tick(); assert.equal(calls, 1, 'stable job identity must not reanalyze an already completed candidate');
    worker.stop();
  } finally { await new Promise<void>(done => model.close(() => done())); store.close(); f.close(); }
});

test('expired candidate bodies are never sent to configured model service', async () => {
  const f = scratch(); const store = new Store(':memory:'); let calls = 0;
  const model = createServer((_req, res) => { calls++; res.end('{}'); });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const address = model.address(); assert.ok(address && typeof address !== 'string');
  try {
    writeFileSync(join(f.dir, 'model-review.json'), JSON.stringify({ endpoint: `http://127.0.0.1:${address.port}`, model: 'fixture' }));
    const receipt = store.submit('dsh', { projectId: 'p', idempotencyKey: 'expired', discovery: '连接重试可减少瞬时网络错误。' });
    store.db.prepare('UPDATE proposals SET expires_at=0 WHERE id=?').run(receipt.id);
    const worker = createMaintenanceWorker(store, f.dir); await worker.tick();
    assert.equal(calls, 0);
    assert.equal(store.listProposals('p')[0]?.state, 'expired');
    assert.equal(maintenanceStatus(store, 'p').reviews.length, 0);
    worker.stop();
  } finally { await new Promise<void>(done => model.close(() => done())); store.close(); f.close(); }
});

test('revision notifications and explicitly configured skill exports survive worker replacement', async () => {
  const f = scratch(); const store = new Store(join(f.dir, 'knowledge.sqlite'));
  try {
    store.import([{ id: 'skill-1', kind: 'skill', title: '同步技能', scope: { kind: 'global' }, baseRevision: 0, body: '# 同步技能\n\n完整正文。', leaves: [], needsStructure: true }]);
    writeFileSync(join(f.dir, 'maintenance.json'), JSON.stringify({ exportDirectory: join(f.dir, 'exported') }));
    const first = createMaintenanceWorker(store, f.dir);
    first.stop();
    assert.ok(store.jobs.list().some(job => job.kind === 'notify' && job.status === 'pending'));
    const worker = createMaintenanceWorker(store, f.dir); await worker.tick();
    const status = maintenanceStatus(store, 'p');
    assert.ok(status.notifications.some(row => Number(row.revision) === store.revision));
    assert.equal(status.jobs.find(job => job.kind === 'export')?.status, 'completed');
    const exportedSkill = readdirSync(join(f.dir, 'exported'), { recursive: true }).map(String).find(path => path.endsWith('SKILL.md'));
    assert.ok(exportedSkill);
    assert.match(readFileSync(join(f.dir, 'exported', exportedSkill), 'utf8'), /完整正文/);
    const jobsCount = status.jobs.length;
    await worker.tick();
    assert.equal(maintenanceStatus(store, 'p').jobs.length, jobsCount);
    worker.stop();
  } finally { store.close(); f.close(); }
});

test('maintenance status is admin-only and scoped to the authenticated project', async () => {
  const store = new Store(':memory:');
  const token = 'a'.repeat(64), admin = 'b'.repeat(64);
  const server = createCoreServer(store, { protocolVersion: 1, port: 47631, clients: [
    { id: 'dsh', projectId: 'p', role: 'adapter', token }, { id: 'admin', projectId: 'p', role: 'admin', token: admin },
  ] });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const request = (credential: string, projectId = 'p') => fetch(`http://127.0.0.1:${address.port}/v1/maintenance/status`, {
    method: 'POST', headers: { authorization: `Bearer ${credential}`, 'x-amb-protocol': '1', 'content-type': 'application/json' }, body: JSON.stringify({ projectId }),
  });
  try {
    assert.equal((await request(token)).status, 403);
    assert.equal((await request(admin)).status, 200);
    assert.equal((await request(admin, 'other')).status, 403);
  } finally { await new Promise<void>(done => server.close(() => done())); store.close(); }
});
