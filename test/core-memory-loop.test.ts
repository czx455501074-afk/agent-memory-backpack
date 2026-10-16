import test from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { candidateToKnowledge } from '../src/rescan.js';

test('stop event atomically pauses task and persists one idempotent journal', () => {
  const s = new Store(':memory:');
  try {
    const e = { eventId: 'stop-1', projectId: 'shared', adapter: 'dsh', sessionId: 'session-1', kind: 'turn_stopped', summary: '' };
    const receipt = s.event('dsh', e);
    assert.equal(receipt.stored, true);
    const activity = s.taskActivity('shared', { sessionId: 'session-1' });
    assert.equal(activity.task?.status, 'paused');
    assert.equal(activity.journal?.outcome, 'unverified');
    assert.equal(activity.events.length, 1);
    const revision = s.revision;
    const duplicate = s.event('dsh', e);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.journalId, receipt.journalId);
    assert.equal(s.revision, revision);
    assert.ok(s.readKnowledge('shared', String(receipt.journalId)).body);
  } finally { s.close(); }
});

test('checkpoint requires completion evidence and preserves actual task summary and long notes', () => {
  const s = new Store(':memory:');
  try {
    const t = s.startTaskForSession('p', 'session', '部署');
    s.recordTask('p', { id: t.id, title: '部署', status: 'in_progress', summary: '已修改代码但未部署', notes: '长'.repeat(3500) });
    const stop = s.event('codex', { eventId: 'stop', projectId: 'p', adapter: 'codex', sessionId: 'session', kind: 'turn_ended', summary: '' });
    const journal = s.readKnowledge('p', String(stop.journalId));
    assert.equal(journal.body, '已修改代码但未部署');
    assert.equal(s.generateJournal(t.id, 'p').problems.length, 3500);
    assert.throws(() => s.checkpointTask('codex', { projectId: 'p', taskId: t.id, status: 'completed' }), /require/);
    const done = s.checkpointTask('codex', { projectId: 'p', taskId: t.id, status: 'completed', verified: 'artifact sha256 checked', evidence: 'verifiable', idempotencyKey: 'done' });
    assert.equal(done.outcome, 'success');
    const after = s.event('codex', { eventId: 'stop-after-complete', projectId: 'p', adapter: 'codex', sessionId: 'session', kind: 'turn_stopped', summary: '' });
    assert.equal(after.outcome, 'success');
    assert.equal(s.getTask(t.id, 'p')?.status, 'completed');
    assert.equal(s.tasks('p').length, 1);
    assert.throws(() => s.checkpointTask('codex', { projectId: 'other', taskId: t.id }), /unavailable/);
  } finally { s.close(); }
});

test('offline stop event replay also persists task journal', () => {
  const s = new Store(':memory:');
  try {
    const payload = { eventId: 'offline-stop', projectId: 'p', adapter: 'dsh', sessionId: 'offline', kind: 'turn_stopped', summary: '' };
    s.enqueue('dsh', { kind: 'event', idempotencyKey: payload.eventId, projectId: 'p', payload });
    assert.equal(s.replayOutbox({ force: true }).delivered.length, 1);
    assert.ok(s.taskActivity('p', { sessionId: 'offline' }).journal);
  } finally { s.close(); }
});

test('journal adoption stores and searches full source beyond former 2000 character cutoff', () => {
  const s = new Store(':memory:');
  try {
    const body = `${'日记原文'.repeat(700)}\n末尾独特marker-end-6721\n`;
    const entry = candidateToKnowledge({ id: 'journal-long', title: '日记', kind: 'journal', source: { path: '2026-10-14.md', hash: 'abc', bytes: Buffer.byteLength(body) }, rationale: 'dated', hostProvided: false, body });
    s.import([entry]);
    assert.equal(s.readKnowledge('p', 'journal-long').body, body);
    assert.ok(s.searchUniversal('p', 'marker-end-6721').some(hit => hit.id === 'journal-long'));
  } finally { s.close(); }
});

test('automatic prepare filters skills matching only reference boilerplate; explicit search retains them', () => {
  const s = new Store(':memory:');
  try {
    const query = 'AMB 全项目共享记忆 主动检索 经验落盘 日记 skill 同步 功能实现验收';
    s.import([
      { id: 'memory-skill', kind: 'skill', title: '记忆经验沉淀', scope: { kind: 'global' }, baseRevision: 0,
        body: '---\nname: memory-skill\ndescription: 记忆检索、经验落盘、日记与 skill 同步\n---\n完整做法', leaves: [], needsStructure: true },
      { id: 'drama-skill', kind: 'skill', title: '短剧配音', scope: { kind: 'global' }, baseRevision: 0,
        body: '---\nname: drama-audio\ndescription: 为短剧配音和音色选择\n---\n读取参考并执行',
        leaves: [{ path: 'references/common.md', hash: 'abc', body: `${query} 通用工作约定` }], needsStructure: true },
    ]);
    assert.ok(s.searchUniversal('p', query).some(entry => entry.id === 'drama-skill'));
    assert.ok(s.autoRecall('p', query).some(entry => entry.id === 'memory-skill'));
    assert.ok(!s.autoRecall('p', query).some(entry => entry.id === 'drama-skill'));
    const selected = s.prepare('p', query).retrieval.selected;
    assert.ok(selected.some(entry => entry.id === 'memory-skill'));
    assert.ok(!selected.some(entry => entry.id === 'drama-skill'));
  } finally { s.close(); }
});

test('adapter HTTP can checkpoint and inspect journals but cannot fabricate observed completion', async () => {
  const { createCoreServer } = await import('../src/server.js');
  const s = new Store(':memory:');
  const token = 'a'.repeat(64);
  const server = createCoreServer(s, { protocolVersion: 1, port: 47631, clients: [{ id: 'dsh', projectId: 'p', role: 'adapter', token }] });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const post = async (path: string, body: Record<string, unknown>) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-amb-protocol': '1', 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'p', ...body }),
  });
  try {
    const response = await post('/v1/sessions/reflect', { adapter: 'dsh', sessionId: 'http-session', eventId: 'http-stop', reason: 'stopped' });
    assert.equal(response.status, 200);
    const receipt = await response.json() as Record<string, unknown>;
    assert.equal(receipt.stored, true);
    assert.equal(receipt.outcome, 'unverified');
    assert.ok(receipt.journalId);
    const activity = await post('/v1/tasks/activity', { sessionId: 'http-session' });
    const data = await activity.json() as { journal: { id: string }; task: { status: string } };
    assert.equal(data.journal.id, receipt.journalId);
    assert.equal(data.task.status, 'paused');
    assert.equal((await post('/v1/tasks/checkpoint', { taskId: receipt.taskId, status: 'completed' })).status, 400);
    assert.equal((await post('/v1/tasks/checkpoint', { taskId: receipt.taskId, status: 'completed', verified: 'claim', evidence: 'observed' })).status, 400);
    assert.equal((await post('/v1/tasks/checkpoint', { taskId: receipt.taskId, status: 'completed', verified: 'artifact sha256 recorded', evidence: 'verifiable' })).status, 200);
    const retry = await post('/v1/sessions/reflect', { adapter: 'dsh', sessionId: 'http-session', eventId: 'http-stop', reason: 'stopped' });
    assert.equal((await retry.json() as { duplicate: boolean }).duplicate, true);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); s.close(); }
});
