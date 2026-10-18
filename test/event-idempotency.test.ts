import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.js';

/**
 * Idempotency must compare content, not the order the object happened to be built in.
 *
 * One event reaches `Store.event` by two roads that disagree about key order:
 * `POST /v1/events` parses the body with `eventSchema` (zod rebuilds it in schema order —
 * `taskId` before `sessionId`), while the outbox replays the stored body verbatim in the
 * adapter's order (`taskId` last, because the adapter spreads it after `sessionId`).
 *
 * The fingerprint used to be `sha256(JSON.stringify(payload))`, so those two orders hashed
 * differently and the retry was refused as "event key already has different content" —
 * permanently, since a refusal is not retried. Measured on the real library: 1,168 of
 * 1,170 abandoned deliveries were events refused this way, and three sampled outbox/stored
 * pairs were byte-identical field by field.
 */

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// The two orders, written out rather than derived, so a change to either the schema or
// the adapter shows up here as a failing test instead of as a silent resurrection.
const ADAPTER_ORDER = { eventId: 'e-1', adapter: 'dsh', projectId: 'p', sessionId: 's', taskId: 't', kind: 'note', summary: '内容' };
const SCHEMA_ORDER = { eventId: 'e-1', adapter: 'dsh', projectId: 'p', taskId: 't', sessionId: 's', kind: 'note', summary: '内容' };

test('同一事件以另一种键序再次提交，判为重复而不是内容冲突', () => {
  const store = new Store(':memory:');
  try {
    const first = store.event('principal', ADAPTER_ORDER);
    assert.equal(first.duplicate, false, '首次提交必须落库');

    const again = store.event('principal', SCHEMA_ORDER);
    assert.equal(again.duplicate, true, '键序不同、字段相同必须判为重复');
    assert.equal(again.id, first.id, '重复提交必须指向同一行，而不是新写一条');
    assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM events').get()!.n), 1,
      '事件流里只能有一条');
  } finally { store.close(); }
});

test('旧版本写下的指纹（按 schema 键序计算）在重放时仍被接受', () => {
  const store = new Store(':memory:');
  try {
    // A row written before this fix: the fingerprint is the hash of the schema-ordered
    // payload, which is what the HTTP path stored. Replay arrives in adapter order.
    const legacyFingerprint = sha(SCHEMA_ORDER);
    store.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(
      'legacy-row', 'principal', 'e-1', legacyFingerprint, JSON.stringify(SCHEMA_ORDER), 1_700_000_000_000, 1_700_000_000_000 + 86_400_000);

    const receipt = store.event('principal', ADAPTER_ORDER);
    assert.equal(receipt.duplicate, true,
      '历史行必须仍能被识别为重复，否则整条队列永久不可重放');
    assert.equal(receipt.id, 'legacy-row');
    assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM events').get()!.n), 1,
      '不得因为键序而多写一条');
  } finally { store.close(); }
});

test('同一个键、内容真的不同时仍然冲突', () => {
  const store = new Store(':memory:');
  try {
    store.event('principal', ADAPTER_ORDER);
    assert.throws(
      () => store.event('principal', { ...ADAPTER_ORDER, summary: '另一种说法' }),
      (error: { code?: string }) => error.code === 'idempotency_conflict',
      '内容不同必须拒绝：否则幂等键就成了覆盖已有记录的后门',
    );
  } finally { store.close(); }
});

test('落库的 payload 是规范键序，读取方看到稳定的形状', () => {
  const store = new Store(':memory:');
  try {
    store.event('principal', ADAPTER_ORDER);
    const stored = JSON.parse(String(store.db.prepare('SELECT payload FROM events LIMIT 1').get()!.payload)) as Record<string, unknown>;
    assert.deepEqual(Object.keys(stored), ['eventId', 'adapter', 'projectId', 'taskId', 'sessionId', 'kind', 'summary'],
      `落库键序必须是 schema 顺序，实际 ${Object.keys(stored).join(',')}`);
  } finally { store.close(); }
});
