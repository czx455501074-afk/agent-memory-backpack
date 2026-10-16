/**
 * R2 data-layer items: F17 (persistent outbox), F16 store side (retry before
 * freshness checks) and F18 (stage attribution).
 *
 * Everything here runs against an in-memory or temp-file SQLite store and a
 * random loopback port with synthetic credentials. No host installation, no real
 * library, no credentials of any kind.
 *
 * The assertions are behavioural on purpose: each one names the design rule it
 * checks, so a future change that weakens the rule fails a test whose name says
 * what was lost.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Store, OUTBOX_MAX_ENTRIES, OUTBOX_TTL_MS } from '../src/store.js';
import { createCoreServer } from '../src/server.js';
import { workflowSchema } from '../src/schema.js';

const DAY = 86400000;
const PROJECT = 'p0';

function workflow(id: string, projectId = PROJECT, overrides: Record<string, unknown> = {}) {
  return workflowSchema.parse({
    id, kind: 'workflow', title: `${id} title`, scope: { kind: 'project', projectId },
    baseRevision: 0, overview: 'overview', triggers: ['trigger'], categories: [['cat']],
    preconditions: ['precondition'],
    stages: [
      { id: 'backup', title: 'backup', instructions: 'take a backup', checks: ['backup exists'], dependencies: [] },
      { id: 'apply', title: 'apply', instructions: 'apply the change', checks: ['applied'], dependencies: [] },
    ],
    completion: ['done'], recovery: 'restore from backup', ...overrides,
  });
}

const code = (error: unknown) => (error as { code?: string }).code;

// ── F16 store side ──────────────────────────────────────────────────────────

test('F16：同 principal 同幂等键的重试必须先返回既有收据，不被 workflow 变更后的 baseRevision 校验遮挡', () => {
  const store = new Store(':memory:');
  store.import([workflow('alpha-flow')]);
  const payload = {
    idempotencyKey: 'retry-after-move', projectId: PROJECT,
    workflowId: 'alpha-flow', baseRevision: 1, discovery: '重试不应被前置校验挡成 409。',
  };
  const first = store.submit('dsh', payload);

  // The workflow moves on while the candidate waits. This is the exact state that
  // used to make a legitimate retry look like a stale-base write.
  store.import([workflow('alpha-flow', PROJECT, { baseRevision: 1, title: 'moved on' })]);

  const retry = store.submit('dsh', payload);
  assert.equal(retry.duplicate, true, '重试必须被识别为重复提交');
  assert.equal(retry.id, first.id, '重试必须返回既有记录 id');
  assert.equal(retry.state, first.state, '重试必须返回既有记录的真实状态');
  assert.equal(store.listProposals(PROJECT, 'pending').length, 1, '重试不得产生第二条候选');
  assert.equal(store.revision, 2, '重试不得推进知识版本');

  // A same-key submission with different content stays an idempotency conflict:
  // that is a different fact from a retry and must not be swallowed by it.
  assert.throws(() => store.submit('dsh', { ...payload, discovery: '不同内容' }), (error: unknown) => code(error) === 'idempotency_conflict');
  store.close();
});

test('F16：重试返回的状态是记录的真实状态，而不是新提交的 pending', () => {
  const store = new Store(':memory:');
  const submitted = store.submit('dsh', { idempotencyKey: 'state-echo', projectId: PROJECT, discovery: '一个候选' });
  store.requestEvidence(String(submitted.id), '缺少可核对结果');
  const retry = store.submit('dsh', { idempotencyKey: 'state-echo', projectId: PROJECT, discovery: '一个候选' });
  assert.equal(retry.state, 'needs_evidence', '重试必须回显 needs_evidence 而不是 pending');
  assert.equal(retry.duplicate, true);
  store.close();
});

// ── F18 stage attribution ───────────────────────────────────────────────────

test('F18：stageId 必须属于给定 workflow，未知步骤明确失败；单独给 stageId 也被拒', () => {
  const store = new Store(':memory:');
  store.import([workflow('flow-a')]);

  assert.throws(
    () => store.submit('dsh', { idempotencyKey: 'orphan-stage', projectId: PROJECT, stageId: 'backup', discovery: '没有 workflow 的步骤归属。' }),
    (error: unknown) => code(error) === 'invalid_request',
    '没有 workflowId 的 stageId 应被拒绝，而不是存成孤立片段',
  );
  assert.throws(
    () => store.submit('dsh', { idempotencyKey: 'ghost-stage', projectId: PROJECT, workflowId: 'flow-a', stageId: 'nope', discovery: '指向不存在的步骤。' }),
    (error: unknown) => code(error) === 'not_found',
    '未知 stage 必须明确失败',
  );
  assert.equal(store.listProposals(PROJECT, 'pending').length, 0, '被拒的提交不得留下候选');

  const accepted = store.submit('dsh', {
    idempotencyKey: 'good-stage', projectId: PROJECT, workflowId: 'flow-a', stageId: 'apply',
    discovery: '归属于升级流程的 apply 步骤。',
  });
  assert.equal(accepted.state, 'pending');

  const listed = store.listProposals(PROJECT, 'pending').find(item => item.id === accepted.id);
  assert.ok(listed, '候选应出现在列表中');
  // `resolved` records whether the attachment was actually located. The shape grew a
  // field when M1 needed to distinguish "kept unattributed" from "attributed", so the
  // expectation carries it — with the value the semantics require, not the value the
  // implementation happened to produce.
  assert.deepEqual(listed.attribution, { workflowId: 'flow-a', stageId: 'apply', resolved: true },
    '列表必须能看出归属哪个流程的哪一步，且标明已定位');
  store.close();
});

test('F18：没有归属的候选仍然保留为待归属候选，attribution 如实为空', () => {
  const store = new Store(':memory:');
  const submitted = store.submit('dsh', { idempotencyKey: 'unattached', projectId: PROJECT, discovery: '还没有找到归属的经验。' });
  const listed = store.listProposals(PROJECT, 'pending').find(item => item.id === submitted.id);
  // Nothing was attached, so `resolved` must be false. This is the assertion that
  // caught the flag reporting `true` here, which is the one thing it exists to
  // distinguish; the expectation is written from the semantics rather than copied
  // from the implementation.
  assert.deepEqual(listed?.attribution, { workflowId: null, stageId: null, resolved: false },
    '待归属候选不得被伪装成已归属，且必须标明未定位');
  store.close();
});

// ── F17 persistent outbox ───────────────────────────────────────────────────

test('F17：outbox 写入 SQLite，进程结束后仍可查询（不是进程内存）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'amb-outbox-'));
  try {
    const path = join(dir, 'knowledge.sqlite');
    const first = new Store(path);
    first.enqueue('dsh', {
      kind: 'candidate', projectId: PROJECT, idempotencyKey: 'offline-1',
      payload: { idempotencyKey: 'offline-1', projectId: PROJECT, discovery: '离线时产生的候选。' },
      error: 'fetch failed',
    });
    first.close();

    const reopened = new Store(path);
    const status = reopened.outboxStatus(PROJECT);
    assert.equal(status.pending, 1, '重开数据库后待发条目仍在');
    assert.equal(status.items[0]?.idempotencyKey, 'offline-1');
    assert.equal(status.items[0]?.lastError, 'fetch failed', '失败原因可查询');
    assert.equal(status.items[0]?.attempts, 0, '尝试次数可查询');
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('F17：重放走原幂等键，已送达的候选被识别为 duplicate 而不产生第二条', () => {
  const store = new Store(':memory:');
  const payload = { idempotencyKey: 'replay-dup', projectId: PROJECT, discovery: '重放不应重复写入。' };

  // The write landed but the response was lost: the adapter believes it failed
  // and queues the item. Replaying must recognise the existing record.
  const original = store.submit('dsh', payload);
  store.enqueue('dsh', { kind: 'candidate', projectId: PROJECT, idempotencyKey: 'replay-dup', payload, error: 'socket hang up' });

  const replayed = store.replayOutbox({ projectId: PROJECT });
  assert.deepEqual(replayed.delivered.map(item => item.result), ['sent'], '重放应完成该条目');
  assert.equal(store.listProposals(PROJECT).length, 1, '重放不得产生第二条候选');
  assert.equal(store.listProposals(PROJECT)[0]?.id, original.id, '重放后仍是同一条记录');
  assert.equal(store.outboxStatus(PROJECT).sent, 1, '已送达状态可查询');
  store.close();
});

test('F17：重放未送达的事件写入一次；再次重放不重复', () => {
  const store = new Store(':memory:');
  const payload = { eventId: 'offline-event', adapter: 'dsh', projectId: PROJECT, kind: 'turn_stopped', summary: '离线时的事件' };
  store.enqueue('dsh', { kind: 'event', projectId: PROJECT, idempotencyKey: 'offline-event', payload });

  store.replayOutbox({ projectId: PROJECT });
  assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM events WHERE event_id=?').get('offline-event')?.n), 1);

  // The row is resolved now, so a second replay has nothing to do; even a forced
  // one must not duplicate the event because the event key is idempotent too.
  const again = store.replayOutbox({ projectId: PROJECT, force: true });
  assert.equal(again.attempted, 0, '已送达条目不再重放');
  assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM events WHERE event_id=?').get('offline-event')?.n), 1);
  store.close();
});

test('F17：重放失败记录原因与尝试次数，并按退避推迟下一次尝试', () => {
  let now = Date.UTC(2026, 0, 1);
  const store = new Store(':memory:', () => now);
  /**
   * A payload that cannot succeed, so the replay fails for a real reason rather than
   * because of the clock.
   *
   * The reason has to be a transport-class one. This fixture used to point at a step
   * the workflow does not contain, which fails with 404 `not_found` — and that is now
   * terminal on the first attempt, because a refusal of a payload the queue cannot
   * change can only be repeated. That terminal path is covered in
   * `test/outbox-replay.test.ts`; what this test is about is the retry path, so an
   * unreadable payload stands in for a core the adapter cannot reach: it fails on
   * every attempt and stays retryable.
   */
  const queued = store.enqueue('dsh', {
    kind: 'candidate', projectId: PROJECT, idempotencyKey: 'will-fail',
    payload: { idempotencyKey: 'will-fail', projectId: PROJECT, discovery: '核心不可达时入队的候选。' },
  });
  store.db.prepare('UPDATE outbox SET payload=? WHERE id=?').run('{not json', queued.id);

  const first = store.replayOutbox({ projectId: PROJECT });
  assert.equal(first.attempted, 1);
  assert.equal(first.failed[0]?.attempts, 1, '失败次数被记录');
  assert.equal(first.delivered.length, 0);

  const status = store.outboxStatus(PROJECT);
  assert.equal(status.pending, 0);
  assert.equal(status.failed, 1, '失败条目可查询');
  assert.equal(status.due, 0, '退避期内不再是"可尝试"');
  assert.match(String(status.items[0]?.lastError), /JSON|Unexpected|token/i, '失败原因可查询');

  // Still inside the backoff window: the item is not attempted again.
  const tooSoon = store.replayOutbox({ projectId: PROJECT });
  assert.equal(tooSoon.attempted, 0, '退避期内不得立即重试');

  now += 5 * 60000; // first backoff is one minute
  const second = store.replayOutbox({ projectId: PROJECT });
  assert.equal(second.failed[0]?.attempts, 2, '退避结束后再次尝试并累计次数');
  store.close();
});

test('F17：到期标记为 abandoned 而不是删除，正文与原因仍可查', () => {
  let now = Date.UTC(2026, 0, 1);
  const store = new Store(':memory:', () => now);
  const payload = { idempotencyKey: 'lapses', projectId: PROJECT, discovery: '超期后也不应被静默删除。' };
  store.enqueue('dsh', { kind: 'candidate', projectId: PROJECT, idempotencyKey: 'lapses', payload });

  now += OUTBOX_TTL_MS + 1000;
  const status = store.outboxStatus(PROJECT);
  assert.equal(status.pending, 0, '超期条目不再算待发');
  assert.equal(status.abandoned, 1, '超期条目被标记为已放弃');
  assert.equal(status.items.length, 0, '已放弃条目不再出现在待发列表');

  const row = store.db.prepare('SELECT status,payload,last_error FROM outbox WHERE idem=?').get('lapses') as { status: string; payload: string; last_error: string };
  assert.equal(row.status, 'abandoned');
  assert.notEqual(row.payload, '{}', '放弃不等于删除正文');
  assert.match(row.payload, /不应被静默删除/, '用户原文仍在');
  assert.match(row.last_error, /Deadline/, '放弃原因可查');

  const replay = store.replayOutbox({ projectId: PROJECT, force: true });
  assert.equal(replay.attempted, 0, '已放弃条目不再被重放');
  assert.equal(store.listProposals(PROJECT).length, 0, '超期条目没有被写入库');
  store.close();
});

test('F17：容量上限一旦触及必须报错，而不是丢弃最旧条目或无限增长', () => {
  const store = new Store(':memory:');
  store.enqueue('dsh', {
    kind: 'event', projectId: PROJECT, idempotencyKey: 'oversize',
    payload: { eventId: 'oversize', adapter: 'dsh', projectId: PROJECT, kind: 'turn_stopped', summary: 'x'.repeat(200) },
  });
  // One payload larger than the byte budget is refused outright.
  assert.throws(
    () => store.enqueue('dsh', {
      kind: 'event', projectId: PROJECT, idempotencyKey: 'huge',
      payload: { eventId: 'huge', adapter: 'dsh', projectId: PROJECT, kind: 'turn_stopped', summary: 'y'.repeat(5 * 1024 * 1024) },
    }),
    (error: unknown) => code(error) === 'outbox_full',
    '超过字节上限必须明确报错',
  );

  for (let i = 0; i < OUTBOX_MAX_ENTRIES - 1; i += 1) {
    store.enqueue('dsh', {
      kind: 'event', projectId: PROJECT, idempotencyKey: `fill-${i}`,
      payload: { eventId: `fill-${i}`, adapter: 'dsh', projectId: PROJECT, kind: 'turn_stopped', summary: 's' },
    });
  }
  assert.equal(store.outboxStatus(PROJECT).pending, OUTBOX_MAX_ENTRIES, '队列填满到上限');
  assert.throws(
    () => store.enqueue('dsh', {
      kind: 'event', projectId: PROJECT, idempotencyKey: 'one-too-many',
      payload: { eventId: 'one-too-many', adapter: 'dsh', projectId: PROJECT, kind: 'turn_stopped', summary: 's' },
    }),
    (error: unknown) => code(error) === 'outbox_full',
    '超过条数上限必须明确报错',
  );
  assert.equal(store.outboxStatus(PROJECT).pending, OUTBOX_MAX_ENTRIES, '报错不得以丢弃最旧条目为代价');
  store.close();
});

test('F17：同一幂等键重复入队合并为一条；已送达的键不再被重新入队', () => {
  const store = new Store(':memory:');
  const payload = { idempotencyKey: 'coalesce', projectId: PROJECT, discovery: '同键合并。' };
  const a = store.enqueue('dsh', { kind: 'candidate', projectId: PROJECT, idempotencyKey: 'coalesce', payload, error: 'first failure' });
  const b = store.enqueue('dsh', { kind: 'candidate', projectId: PROJECT, idempotencyKey: 'coalesce', payload, error: 'second failure' });
  assert.equal(b.id, a.id, '同键必须合并到同一条');
  assert.equal(b.duplicate, true);
  assert.equal(store.outboxStatus(PROJECT).pending, 1);

  store.replayOutbox({ projectId: PROJECT });
  const afterDelivery = store.enqueue('dsh', { kind: 'candidate', projectId: PROJECT, idempotencyKey: 'coalesce', payload });
  assert.equal(afterDelivery.status, 'sent', '已送达的条目如实回显 sent');
  assert.equal(store.outboxStatus(PROJECT).pending, 0, '已送达条目不再算待发');

  // A same key with the other kind is a conflict, not a merge.
  assert.throws(
    () => store.enqueue('dsh', { kind: 'event', projectId: PROJECT, idempotencyKey: 'coalesce', payload: { eventId: 'x', projectId: PROJECT } }),
    (error: unknown) => code(error) === 'idempotency_conflict',
  );
  store.close();
});

test('F17：purge 默认只清理已送达/已放弃条目，未送达条目要显式声明才会被丢弃', () => {
  const store = new Store(':memory:');
  store.enqueue('dsh', { kind: 'candidate', projectId: PROJECT, idempotencyKey: 'keep-me', payload: { idempotencyKey: 'keep-me', projectId: PROJECT, discovery: '未送达的候选。' } });
  const conservative = store.purgeOutbox({ projectId: PROJECT });
  assert.equal(conservative.removed, 0, '默认不得丢弃未送达条目');
  assert.equal(store.outboxStatus(PROJECT).pending, 1);

  const explicit = store.purgeOutbox({ projectId: PROJECT, includePending: true });
  assert.equal(explicit.removed, 1);
  assert.deepEqual(explicit.discarded.map(item => item.status), ['pending'], '被丢弃的内容要列出来，而不是只给一个计数');
  assert.equal(store.outboxStatus(PROJECT).pending, 0);
  store.close();
});

// ── F17 over HTTP, isolated instance ────────────────────────────────────────

const token = 'a'.repeat(64), adminToken = 'c'.repeat(64);

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'amb-outbox-http-'));
  const store = new Store(join(dir, 'knowledge.sqlite'));
  store.import([workflow('flow-a')]);
  const server = createCoreServer(store, { protocolVersion: 1, port: 47631, clients: [
    { id: 'dsh', token, projectId: PROJECT, role: 'adapter' },
    { id: 'admin', token: adminToken, projectId: PROJECT, role: 'admin' },
  ] });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body: unknown, bearer = token) =>
    fetch(endpoint + path, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'x-amb-protocol': '1' }, body: JSON.stringify(body) });
  return { store, endpoint, post, async close() {
    server.closeIdleConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  } };
}

test('F17 HTTP：适配器可入队与重放，list/purge 需要 admin，且不得跨项目', async () => {
  const f = await fixture();
  try {
    const enqueued = await f.post('/v1/outbox/enqueue', {
      kind: 'candidate', idempotencyKey: 'http-offline', projectId: PROJECT,
      payload: { idempotencyKey: 'http-offline', projectId: PROJECT, discovery: 'HTTP 入队的候选。' },
    });
    assert.equal(enqueued.status, 200);
    const enqueuedBody = await enqueued.json() as { status: string; duplicate: boolean };
    assert.equal(enqueuedBody.status, 'pending');
    assert.equal(enqueuedBody.duplicate, false);

    assert.equal((await f.post('/v1/outbox/list', { projectId: PROJECT })).status, 403, '适配器不得列出队列');
    assert.equal((await f.post('/v1/outbox/purge', { projectId: PROJECT })).status, 403, '适配器不得清空队列');

    const asAdmin = await f.post('/v1/outbox/list', { projectId: PROJECT }, adminToken);
    assert.equal(asAdmin.status, 200);
    const listed = await asAdmin.json() as { pending: number; items: Array<{ lastError: unknown }> };
    assert.equal(listed.pending, 1, '待发条数可查询');
    assert.equal(listed.items.length, 1, '失败原因与尝试次数随条目返回');

    const replayed = await f.post('/v1/outbox/replay', { projectId: PROJECT });
    assert.equal(replayed.status, 200);
    assert.equal((await replayed.json() as { delivered: unknown[] }).delivered.length, 1);
    assert.equal(f.store.listProposals(PROJECT).length, 1, '重放只产生一条候选');

    const stats = await (await f.post('/v1/stats', { projectId: PROJECT })).json() as { outbox: { pending: number; failed: number } };
    assert.equal(stats.outbox.pending, 0);
    assert.equal(stats.outbox.failed, 0);

    // The envelope's project must match the credential's project, as everywhere else.
    const cross = await f.post('/v1/outbox/enqueue', {
      kind: 'candidate', idempotencyKey: 'cross', projectId: 'other',
      payload: { idempotencyKey: 'cross', projectId: 'other', discovery: 'x' },
    });
    assert.equal(cross.status, 403, '不得为他项目入队');

    const purged = await f.post('/v1/outbox/purge', { projectId: PROJECT }, adminToken);
    assert.equal(purged.status, 200);
    assert.equal((await purged.json() as { removed: number }).removed, 1, '已送达条目可被 admin 清理');
  } finally { await f.close(); }
});

test('F17 HTTP：重放已落地但回执丢失的候选，核心识别为 duplicate', async () => {
  const f = await fixture();
  try {
    const payload = { idempotencyKey: 'lost-receipt', projectId: PROJECT, discovery: '回执丢失后的重放。' };
    assert.equal((await f.post('/v1/proposals', payload)).status, 200);
    assert.equal((await f.post('/v1/outbox/enqueue', { kind: 'candidate', idempotencyKey: 'lost-receipt', projectId: PROJECT, payload })).status, 200);

    const replayed = await f.post('/v1/outbox/replay', { projectId: PROJECT });
    assert.equal((await replayed.json() as { delivered: Array<{ result: string }> }).delivered[0]?.result, 'sent');
    assert.equal(f.store.listProposals(PROJECT).length, 1, '重放不得产生第二条候选');
  } finally { await f.close(); }
});

/**
 * Material's `taskId` is an attribution field, so it follows the same rule F04
 * established for events: it must name a task the recording project owns.
 *
 * Found by the R0 exit sweep rather than by the original audit — the event path was
 * validated, the material path was not. The effect was measured before fixing so the
 * severity is stated accurately: the record stays in the recording project (its scope
 * is correct), so this is misattribution, not a cross-project disclosure.
 */
test('F04 延伸：资料关联的任务必须属于记录它的项目', async () => {
  const f = await fixture();
  try {
    // A task belonging to a different project, and the caller's own task.
    f.store.recordTask('other', { id: 'other-task', title: 'other', status: 'in_progress' });
    f.store.recordTask(PROJECT, { id: 'own-task', title: 'own', status: 'in_progress' });

    const foreign = await f.post('/v1/material/save', {
      projectId: PROJECT, id: 'mat-foreign', title: 'page', url: 'https://example.invalid/f',
      summary: 'summary', taskId: 'other-task',
    });
    assert.equal(foreign.status, 404, '他项目的任务 id 必须被拒');
    assert.equal(
      f.store.allEntries().some(entry => entry.id === 'mat-foreign'), false,
      '被拒的资料不得落库',
    );

    // An id that resolves to nothing is refused too: a link that points at no task
    // is the same misattribution, and accepting it would make the field untrustworthy.
    const unknown = await f.post('/v1/material/save', {
      projectId: PROJECT, id: 'mat-unknown', title: 'page', url: 'https://example.invalid/u',
      summary: 'summary', taskId: 'no-such-task',
    });
    assert.equal(unknown.status, 404, '未知任务 id 必须被拒');

    // The project's own task still works — the check must not lock out the feature.
    const own = await f.post('/v1/material/save', {
      projectId: PROJECT, id: 'mat-own', title: 'page', url: 'https://example.invalid/o',
      summary: 'summary', taskId: 'own-task',
    });
    assert.equal(own.status, 200, '本项目任务的资料必须仍可保存');
    const saved = f.store.allEntries().find(entry => entry.id === 'mat-own');
    assert.equal(
      saved && 'taskId' in saved.content ? saved.content.taskId : undefined,
      'own-task', '关联任务必须如实落库',
    );

    // Omitting the link entirely remains valid: it is optional by design.
    const unlinked = await f.post('/v1/material/save', {
      projectId: PROJECT, id: 'mat-unlinked', title: 'page', url: 'https://example.invalid/n',
      summary: 'summary',
    });
    assert.equal(unlinked.status, 200, '不关联任务时仍应可保存');
  } finally { await f.close(); }
});
