import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

/**
 * Opening the library must be a read.
 *
 * Regression for the defect this file was added with: the constructor ran a full
 * `cleanup()`, which deletes lapsed events and re-queues abandoned outbox rows. With
 * a second process writing, the open then waited on the write lock and threw
 * `ERR_SQLITE_ERROR errcode 5 database is locked` out of the constructor - where no
 * caller catches it, so the CLI or the second host instance simply died.
 *
 * The probe holds a write transaction on one connection and opens the same file on
 * another, which is the same contention a core sees while it is importing. The busy
 * timeout is three seconds, so this test is deliberately slow: it has to wait out the
 * lock to prove the open survives it.
 */
test('并发写事务之下打开库不抛错，清理被跳过而不是让构造失败', () => {
  const dir = mkdtempSync(join(tmpdir(), 'amb-open-'));
  const path = join(dir, 'knowledge.sqlite');
  const writer = new Store(path);
  try {
    writer.import([{
      id: 'seed', kind: 'memory', title: 'seed', body: 'fixture',
      scope: { kind: 'global' }, baseRevision: 0,
    }]);
    // Hold the write lock the way a busy core does: an open transaction with a write.
    writer.db.exec('BEGIN IMMEDIATE');
    writer.db.prepare("UPDATE meta SET value=value WHERE key='revision'").run();

    let opened: Store | undefined;
    assert.doesNotThrow(() => { opened = new Store(path); }, '打开库不得因写锁被持有而抛错');
    opened?.close();
  } finally {
    try { writer.db.exec('ROLLBACK'); } catch { /* the transaction may already be gone */ }
    writer.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the handle */ }
  }
});

/**
 * The cleanup pass still runs when it can, so skipping under contention is not a way
 * to stop doing the work: a lapsed material row is purged by an ordinary open once the
 * lock is free.
 */
test('锁空闲时打开库仍会执行清理：过期资料被清掉', () => {
  const dir = mkdtempSync(join(tmpdir(), 'amb-open-clean-'));
  const path = join(dir, 'knowledge.sqlite');
  const first = new Store(path, () => 1_000);
  try {
    first.saveMaterial({
      id: 'lapsed', title: 'fixture', url: 'https://example.invalid/a',
      summary: 'fixture summary', body: 'fixture body',
      savedAt: 0, expiresAt: 1,
    });
  } finally { first.close(); }
  const second = new Store(path, () => 10_000);
  try {
    const row = second.db.prepare('SELECT count(*) AS n FROM knowledge WHERE id=?').get('lapsed') as { n: number };
    assert.equal(Number(row.n), 0, '过期资料应当在打开时被清理');
  } finally {
    second.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the handle */ }
  }
});
