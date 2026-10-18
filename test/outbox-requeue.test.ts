import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

/**
 * Reopening abandoned deliveries — and being honest about which ones.
 *
 * The fingerprint fix turns 1,168 refusals into replays that land as duplicates, but they
 * are still `abandoned`, and `replayOutbox` only looks at pending/failed. Reopening is
 * therefore a deliberate action with two failure modes worth pinning:
 *
 *   1. reopening a refusal that is still true — the queue looks busy while going nowhere;
 *   2. reopening without extending `expires_at` — every reopened row is past its deadline
 *      by definition, so the next replay pass would abandon it again immediately.
 */

const PROJECT = 'p0';

/** Queue one event delivery through the real API, then force it into `abandoned`. */
function abandonEvent(store: Store, eventId: string, reason: string) {
  store.enqueue('agent', {
    kind: 'event', projectId: PROJECT, idempotencyKey: eventId,
    payload: { eventId, adapter: 'dsh', projectId: PROJECT, kind: 'note', summary: '内容' },
  });
  store.db.prepare("UPDATE outbox SET status='abandoned', last_error=?, attempts=12, expires_at=? WHERE idem=?")
    .run(reason, Date.now() - 86_400_000, eventId);
}

test('预演只报数并给出原因分布，不改动任何一行', () => {
  const store = new Store(':memory:');
  try {
    abandonEvent(store, 'evt-a', 'Permanent refusal: Event key already has different content');
    abandonEvent(store, 'evt-a2', 'Event key already has different content');
    abandonEvent(store, 'evt-b', 'Permanent refusal: Task is unavailable');

    const preview = store.requeueAbandoned({ projectId: PROJECT, dryRun: true });
    assert.equal(preview.matched, 2, '只应匹配“内容不同”这一类，另一类不得被重开');
    assert.equal(preview.requeued, 0, '预演不得改动');
    assert.ok(preview.byError.length >= 1, '必须给出原因分布，空列表会让读者无法判断该不该执行');
    assert.equal(
      Number(store.db.prepare("SELECT count(*) AS n FROM outbox WHERE status='pending'").get()!.n), 0,
      '预演之后队列里不应出现待投递项',
    );
  } finally { store.close(); }
});

test('执行后重新入队：次数归零、截止时间延后，且不属于该类的仍关闭', () => {
  const store = new Store(':memory:');
  try {
    abandonEvent(store, 'evt-c', 'Permanent refusal: Event key already has different content');
    abandonEvent(store, 'evt-d', 'Permanent refusal: Task is unavailable');

    const applied = store.requeueAbandoned({ projectId: PROJECT, dryRun: false });
    assert.equal(applied.requeued, 1);

    const rows = store.db.prepare('SELECT idem, status, attempts, expires_at, last_error FROM outbox ORDER BY idem').all() as Array<Record<string, unknown>>;
    const reopened = rows.find(row => row.idem === 'evt-c')!;
    assert.equal(reopened.status, 'pending', '目标条目必须回到可重放状态');
    assert.equal(Number(reopened.attempts), 0, '重试预算属于上一轮，必须归零');
    assert.equal(String(reopened.last_error), '', '旧的拒绝原因必须清掉，否则下一次失败会读到过期理由');
    assert.ok(Number(reopened.expires_at) > Date.now(), '截止时间必须延后，否则下一次重放会立刻再次放弃');

    const stillClosed = rows.find(row => row.idem === 'evt-d')!;
    assert.equal(stillClosed.status, 'abandoned', '仍然成立的拒绝不得被重开');
  } finally { store.close(); }
});

test('重开之后的重放把这一条判为重复，而不是又一次冲突', () => {
  const store = new Store(':memory:');
  try {
    // The event is already in the library — that is why the retry was refused. The queued
    // payload must describe the *same* event: an earlier draft of this test queued it
    // without `taskId`/`sessionId`, so the refusal was correct on the merits and the
    // replayed failure said nothing about the fingerprint.
    const payload = { eventId: 'evt-e', adapter: 'dsh', projectId: PROJECT, taskId: 't', sessionId: 's', kind: 'note', summary: '内容' };
    store.event('agent', payload);
    store.enqueue('agent', { kind: 'event', projectId: PROJECT, idempotencyKey: 'evt-e', payload });
    store.db.prepare("UPDATE outbox SET status='abandoned', last_error=?, attempts=12, expires_at=? WHERE idem='evt-e'")
      .run('Permanent refusal: Event key already has different content', Date.now() - 86_400_000);

    const reopened = store.requeueAbandoned({ projectId: PROJECT, dryRun: false });
    assert.equal(reopened.requeued, 1, `必须先重开一条，实际匹配 ${reopened.matched}，原因 ${JSON.stringify(reopened.byError)}`);
    const queued = store.db.prepare('SELECT status, project_id FROM outbox WHERE idem=?').get('evt-e') as Record<string, unknown>;
    assert.equal(String(queued.status), 'pending', `重开后应为待投递：${JSON.stringify(queued)}`);
    assert.equal(String(queued.project_id), PROJECT, `项目必须一致：${JSON.stringify(queued)}`);

    const replay = store.replayOutbox({ projectId: PROJECT, force: true });
    assert.equal(replay.delivered.length, 1, `重放必须成功，失败原因：${JSON.stringify(replay.failed)}`);
    assert.equal(replay.failed.length, 0, '键序不同不得再被当成内容冲突');
    assert.equal(replay.abandoned.length, 0, '不得再次进入放弃状态');
    assert.equal(
      Number(store.db.prepare("SELECT count(*) AS n FROM outbox WHERE status='sent'").get()!.n), 1,
      '队列里该条应为已送达',
    );
    assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM events').get()!.n), 1, '库里仍只有一条事件');
  } finally { store.close(); }
});

test('默认规则只认事件那一类拒绝，不把候选的冲突一起重开', () => {
  const store = new Store(':memory:');
  try {
    store.enqueue('agent', {
      kind: 'candidate', projectId: PROJECT, idempotencyKey: 'cand-1',
      payload: { idempotencyKey: 'cand-1', projectId: PROJECT, discovery: '候选正文' },
    });
    // The candidate conflict is a different decision: its payload round-trips unchanged, so
    // the refusal was about content that really differs. Reopening it would guarantee
    // another refusal, which is exactly what the named-pattern rule exists to prevent.
    store.db.prepare("UPDATE outbox SET status='abandoned', last_error='Permanent refusal: Same idempotency key has different content' WHERE idem='cand-1'").run();

    const preview = store.requeueAbandoned({ projectId: PROJECT, dryRun: true });
    assert.equal(preview.matched, 0, '候选的冲突原因不属于已修复的那一类');
  } finally { store.close(); }
});
