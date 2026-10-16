import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { DomainError } from '../src/schema.js';
import { Store, isPermanentReplayRefusal } from '../src/store.js';

const PROJECT = 'p-outbox-replay';
const tempDirs = new Set<string>();
const stores = new Set<Store>();

/** A throwaway database per test: nothing here ever touches a real store. */
async function openStore(now?: () => number): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), 'amb-outbox-replay-'));
  tempDirs.add(dir);
  const store = new Store(join(dir, 'knowledge.sqlite'), now);
  stores.add(store);
  return store;
}

/** Stand in for a core that answers with `error`; the returned function restores it. */
function stubFailure(store: Store, method: 'event' | 'submit', error: unknown): () => void {
  const own = Object.getOwnPropertyDescriptor(store, method);
  Object.defineProperty(store, method, { value: () => { throw error; }, configurable: true, writable: true });
  return () => {
    if (own) Object.defineProperty(store, method, own);
    else delete (store as unknown as Record<string, unknown>)[method];
  };
}

function outboxRow(store: Store, id: string) {
  return store.db.prepare('SELECT status,attempts,last_error,next_attempt_at FROM outbox WHERE id=?').get(id) as
    { status: string; attempts: number; last_error: string; next_attempt_at: number };
}

afterEach(async () => {
  for (const store of stores) store.close();
  stores.clear();
  await Promise.all([...tempDirs].map(dir => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

test('重放撞上幂等冲突：一次即判终态，不再进入可重试池', async () => {
  const store = await openStore();
  // The exact production shape: the event key is already stored with different content,
  // so `event()` answers 409 `idempotency_conflict` and always will — the queued payload
  // cannot change. This is what 451 failed + 533 abandoned production rows were re-sent
  // for, 9,773 times in total.
  store.event('dsh', { eventId: 'evt-conflict', adapter: 'dsh', projectId: PROJECT, kind: 'turn_stopped', summary: '先落地的事件。' });
  const queued = store.enqueue('dsh', {
    kind: 'event', projectId: PROJECT, idempotencyKey: 'evt-conflict',
    payload: { eventId: 'evt-conflict', adapter: 'dsh', projectId: PROJECT, kind: 'turn_stopped', summary: '内容不同的事件。' },
  });

  const first = store.replayOutbox({ projectId: PROJECT });
  assert.deepEqual(first.abandoned, [queued.id], '永久拒绝当次即判终态');
  assert.equal(first.failed.length, 0, '永久拒绝不得进入退避重试');
  assert.equal(first.delivered.length, 0);

  const row = outboxRow(store, queued.id);
  assert.equal(row.status, 'abandoned');
  assert.equal(Number(row.attempts), 1, '尝试次数停在一次，不随重放增长');
  assert.match(String(row.last_error), /^Permanent refusal: /, '终态原因标明这是永久拒绝');
  assert.match(String(row.last_error), /already has different content/i, '原始拒绝原因仍可查');

  const status = store.outboxStatus(PROJECT);
  assert.equal(status.abandoned, 1);
  assert.equal(status.failed, 0);
  assert.equal(status.due, 0, '终态条目不再"到期待试"');

  // Second call, forced so the clock cannot be the reason nothing happens: the terminal
  // row must not be picked up again.
  const second = store.replayOutbox({ projectId: PROJECT, force: true });
  assert.equal(second.attempted, 0, '终态条目不再被重放');
  assert.deepEqual(second.abandoned, []);
  assert.equal(Number(outboxRow(store, queued.id).attempts), 1, '尝试次数不得增长');
  assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM events WHERE event_id=?').get('evt-conflict')?.n), 1, '不得写入第二条事件');
});

test('重放撞上 5xx：保持 failed 并设置退避，与修复前一致', async () => {
  let now = Date.UTC(2026, 0, 1);
  const store = await openStore(() => now);
  const queued = store.enqueue('dsh', {
    kind: 'candidate', projectId: PROJECT, idempotencyKey: 'core-down',
    payload: { idempotencyKey: 'core-down', projectId: PROJECT, discovery: '核心暂时不可达时入队的候选。' },
  });

  const restore = stubFailure(store, 'submit', new DomainError('internal_error', 'core temporarily unavailable', 503));
  try {
    const first = store.replayOutbox({ projectId: PROJECT });
    assert.equal(first.failed.length, 1, '传输类失败仍是可重试失败');
    assert.equal(first.failed[0]?.attempts, 1);
    assert.equal(first.abandoned.length, 0, '传输类失败不得被判终态');

    const row = outboxRow(store, queued.id);
    assert.equal(row.status, 'failed');
    assert.ok(Number(row.next_attempt_at) > now, '设置了退避时间');
    assert.equal(store.outboxStatus(PROJECT).due, 0, '退避期内不是"可尝试"');

    const tooSoon = store.replayOutbox({ projectId: PROJECT });
    assert.equal(tooSoon.attempted, 0, '退避期内不得立即重试');

    now += 60000; // the first backoff step is one minute
    const second = store.replayOutbox({ projectId: PROJECT });
    assert.equal(second.failed[0]?.attempts, 2, '退避结束后再次尝试并累计次数');
  } finally { restore(); }
});

test('重放撞上拿不到结构化 code 的错误：仍按可重试失败处理', async () => {
  let now = Date.UTC(2026, 0, 1);
  const store = await openStore(() => now);
  const queued = store.enqueue('dsh', {
    kind: 'event', projectId: PROJECT, idempotencyKey: 'broken-payload',
    payload: { eventId: 'broken-payload', adapter: 'dsh', projectId: PROJECT, kind: 'turn_stopped', summary: '无论内容如何都无法解析。' },
  });
  // A payload the row cannot even parse: no DomainError, no code, and no permanent-conflict
  // wording either — so the message fallback must not claim it is terminal.
  store.db.prepare('UPDATE outbox SET payload=? WHERE id=?').run('{not json', queued.id);

  const first = store.replayOutbox({ projectId: PROJECT });
  assert.equal(first.failed.length, 1, '无法归类的错误保持可重试');
  assert.equal(first.abandoned.length, 0);
  assert.equal(outboxRow(store, queued.id).status, 'failed');
  assert.ok(Number(outboxRow(store, queued.id).next_attempt_at) > now, '仍然退避');
});

test('重放可送达的事件：标记 sent，不进入终态放弃', async () => {
  const store = await openStore();
  const queued = store.enqueue('dsh', {
    kind: 'event', projectId: PROJECT, idempotencyKey: 'delivers-fine',
    payload: { eventId: 'delivers-fine', adapter: 'dsh', projectId: PROJECT, kind: 'turn_stopped', summary: '正常可送达。' },
  });

  const replayed = store.replayOutbox({ projectId: PROJECT });
  assert.deepEqual(replayed.delivered, [{ id: queued.id, kind: 'event', result: 'sent' }]);
  assert.equal(replayed.abandoned.length, 0);
  assert.equal(outboxRow(store, queued.id).status, 'sent');
  assert.equal(store.outboxStatus(PROJECT).failed, 0);
});

test('重放批量由 limit 收窄：一次只处理调用方允许的条数', async () => {
  const store = await openStore();
  for (const n of [1, 2, 3]) {
    store.enqueue('dsh', {
      kind: 'event', projectId: PROJECT, idempotencyKey: `batch-${n}`,
      payload: { eventId: `batch-${n}`, adapter: 'dsh', projectId: PROJECT, kind: 'turn_stopped', summary: `第 ${n} 条。` },
    });
  }

  const narrow = store.replayOutbox({ projectId: PROJECT, limit: 1 });
  assert.equal(narrow.attempted, 1, 'limit 收窄后单次只尝试一条');
  const rest = store.replayOutbox({ projectId: PROJECT, limit: 10 });
  assert.equal(rest.attempted, 2, '剩余条目在后续调用中完成');
  assert.equal(store.outboxStatus(PROJECT).pending, 0);
});

test('永久拒绝判定：结构化 code/status 优先，文案仅作兜底', () => {
  // Structured decisions.
  assert.equal(isPermanentReplayRefusal(new DomainError('idempotency_conflict', 'Event key already has different content', 409)), true);
  assert.equal(isPermanentReplayRefusal(new DomainError('invalid_request', 'Candidate payload is invalid at field "discovery"', 400)), true);
  assert.equal(isPermanentReplayRefusal(new DomainError('forbidden', 'admin only', 403)), true);
  assert.equal(isPermanentReplayRefusal(new DomainError('not_found', 'Workflow flow-a has no stage ghost', 404)), true);
  assert.equal(isPermanentReplayRefusal(new DomainError('outbox_full', 'Outbox is full', 507)), false, '507 是容量问题，保持重试');
  assert.equal(isPermanentReplayRefusal(new DomainError('internal_error', 'unreadable revision', 500)), false, '5xx 保持重试');
  assert.equal(isPermanentReplayRefusal(new Error('fetch failed')), false, '传输错误保持重试');
  // Fallback: the identity was lost, only the wording survives.
  assert.equal(isPermanentReplayRefusal(new Error('Event key already has different content')), true);
  assert.equal(isPermanentReplayRefusal(new Error('Same idempotency key has different content')), true);
});
