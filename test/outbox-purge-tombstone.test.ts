import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

/**
 * Clearing the queue must not erase the memory of what was already delivered.
 *
 * `enqueue` recognises a retry by finding the `(principal, idem)` row and short-circuiting
 * when it is terminal. Deleting delivered rows removes that memory, so the same submission
 * arriving again looks brand new and is only stopped one layer down — by the events or
 * candidates table, which is exactly what the outbox exists to avoid. BullMQ documents the
 * same trap: a removed job no longer participates in deduplication.
 *
 * Abandoned rows are left alone on purpose: `requeueAbandoned` reads their payload to reopen
 * them, so destroying it would make a repairable queue unrepairable.
 */

const PROJECT = 'p0';
const candidate = (key: string) => ({
  kind: 'candidate' as const, projectId: PROJECT, idempotencyKey: key,
  payload: { idempotencyKey: key, projectId: PROJECT, discovery: `候选 ${key} 的正文` },
});

const row = (store: Store, idem: string) =>
  store.db.prepare('SELECT idem,status,payload FROM outbox WHERE idem=?').get(idem) as
    { idem: string; status: string; payload: string } | undefined;

test('默认清理把已送达条目变成墓碑：正文清空、行与幂等键保留', () => {
  const store = new Store(':memory:');
  try {
    store.enqueue('agent', candidate('k1'));
    store.db.prepare("UPDATE outbox SET status='sent' WHERE idem='k1'").run();

    const purged = store.purgeOutbox({ projectId: PROJECT });
    assert.equal(purged.tombstoned, 1);
    assert.equal(purged.deleted, 0);

    const kept = row(store, 'k1');
    assert.ok(kept, '行必须保留：删掉它等于删掉幂等键');
    assert.equal(kept.status, 'sent');
    assert.equal(kept.payload, '{}', '正文应当清空，清理才真的回收了空间');
  } finally { store.close(); }
});

test('清理之后同一个幂等键仍被识别为重复，而不是新任务', () => {
  const store = new Store(':memory:');
  try {
    store.enqueue('agent', candidate('k2'));
    store.db.prepare("UPDATE outbox SET status='sent' WHERE idem='k2'").run();
    store.purgeOutbox({ projectId: PROJECT });

    const again = store.enqueue('agent', candidate('k2'));
    assert.equal(again.duplicate, true, '迟到的重试必须仍被短路，否则同一份候选会被排队两次');
    assert.equal(Number(store.db.prepare("SELECT count(*) AS n FROM outbox WHERE idem='k2'").get()!.n), 1, '不得新增第二行');
  } finally { store.close(); }
});

test('已放弃条目默认不被清掉，因为重新入队需要它的内容', () => {
  const store = new Store(':memory:');
  try {
    store.enqueue('agent', candidate('k3'));
    store.db.prepare("UPDATE outbox SET status='abandoned', last_error='Permanent refusal: x' WHERE idem='k3'").run();

    store.purgeOutbox({ projectId: PROJECT });
    const kept = row(store, 'k3');
    assert.ok(kept, '已放弃条目必须保留');
    assert.notEqual(kept.payload, '{}', '正文还在，requeueAbandoned 才能把它救回来');
  } finally { store.close(); }
});

test('includePending 是显式的“全都删掉”，包括幂等键', () => {
  const store = new Store(':memory:');
  try {
    store.enqueue('agent', candidate('k4'));
    store.db.prepare("UPDATE outbox SET status='sent' WHERE idem='k4'").run();
    store.enqueue('agent', candidate('k5'));

    const purged = store.purgeOutbox({ projectId: PROJECT, includePending: true });
    assert.equal(purged.deleted, 2);
    assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM outbox').get()!.n), 0,
      '显式要求清空时，行与键一起消失，这是使用者的明确决定');
  } finally { store.close(); }
});
