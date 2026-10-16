import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableJobs } from '../src/jobs.js';

test('job enqueue participates in authority transaction and deduplicates', () => {
  const db = new DatabaseSync(':memory:'); const jobs = new DurableJobs(db);
  const id = jobs.enqueue('notify', 'revision:1', { revision: 1 });
  assert.equal(jobs.enqueue('notify', 'revision:1', { revision: 1 }), id);
  db.exec('BEGIN'); jobs.enqueue('notify', 'revision:2', { revision: 2 }); db.exec('ROLLBACK');
  assert.equal(jobs.list().length, 1); db.close();
});
test('interrupted jobs survive restart and lease expiry, failed handlers retry', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'amb-jobs-')), 'queue.sqlite');
  let now = 1000;
  let db = new DatabaseSync(file); let jobs = new DurableJobs(db, () => now);
  jobs.enqueue('model_review', 'proposal:1', { proposalId: 'p1' });
  assert.equal(jobs.claim()!.attempts, 1); db.close();
  db = new DatabaseSync(file); jobs = new DurableJobs(db, () => now);
  assert.equal(jobs.claim(), undefined);
  now += 90001;
  await jobs.run({ model_review() { throw new Error('SECRET never persisted'); } });
  assert.equal(jobs.list()[0]!.status, 'pending');
  assert.equal(jobs.list()[0]!.error, 'handler_failed');
  now += 100000;
  await jobs.run({ model_review() { return { analyzed: true }; } });
  assert.equal(jobs.list()[0]!.status, 'completed'); db.close();
});
