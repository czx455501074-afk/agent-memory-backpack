import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DurableJobs } from '../src/jobs.js';

/**
 * A lease without renewal is a lease that expires under slow work.
 *
 * `model_review` calls an external model; the lease was a fixed 90 seconds with nothing
 * renewing it. When a review took longer, the next tick saw `status='running' AND
 * lease_until<=now`, decided the worker had died, and claimed the same job again — so the
 * same review ran twice and both runs wrote a result. `finish`/`retry` had no generation
 * check either, so the first worker's write could land after the second worker's.
 */

const at = (clock: { now: number }) => () => clock.now;

function fixture() {
  const clock = { now: 1_700_000_000_000 };
  const db = new DatabaseSync(':memory:');
  const jobs = new DurableJobs(db, at(clock));
  jobs.enqueue('model_review', 'review:knowledge:1', {});
  return { clock, jobs, db };
}

test('租约过期后任务会被另一个 worker 重新领取，代次随之递增', () => {
  const { clock, jobs } = fixture();
  const first = jobs.claim();
  assert.ok(first, '首次领取必须成功');
  assert.equal(first.attempts, 1);

  clock.now += 30_000;
  assert.equal(jobs.claim(), undefined, '租约未过期时不得被再次领取');

  clock.now += 70_000; // 共 100 秒，超过 90 秒租约
  const second = jobs.claim();
  assert.ok(second, '租约过期后必须允许接手，否则崩溃的工作永远卡住');
  assert.equal(second.attempts, 2, '代次必须递增，旧 worker 才能被识别出来');
});

test('续租之后同一个任务不会被重复领取', () => {
  const { clock, jobs } = fixture();
  const job = jobs.claim();
  assert.ok(job);

  for (let elapsed = 0; elapsed < 200_000; elapsed += 40_000) {
    clock.now += 40_000;
    assert.equal(jobs.heartbeat(job.id, job.attempts), true, '持有者必须能续租');
    assert.equal(jobs.claim(), undefined, `第 ${elapsed / 1000 + 40} 秒时任务仍在被处理，不得被别人领走`);
  }
});

test('过期的 worker 不能覆盖新一代的结果', () => {
  const { clock, jobs, db } = fixture();
  const first = jobs.claim();
  assert.ok(first);

  clock.now += 100_000;
  const second = jobs.claim();
  assert.ok(second, '必须能被接手');
  jobs.finish(second.id, { by: 'second' }, second.attempts);

  const row = () => jobs.list(1)[0]!;
  assert.equal(row().status, 'completed');

  // The stale worker wakes up and tries to finish its own generation.
  jobs.finish(first.id, { by: 'first' }, first.attempts);
  assert.equal(row().status, 'completed', '状态不得被旧代次改写');

  const stored = JSON.parse(String(db.prepare('SELECT result FROM maintenance_jobs WHERE id=?').get(first.id)!.result));
  assert.deepEqual(stored, { by: 'second' }, '结果必须来自真正完成它的那一代');
});

test('过期的 worker 也不能把已完成的任务重新排队', () => {
  const { clock, jobs } = fixture();
  const first = jobs.claim();
  assert.ok(first);
  clock.now += 100_000;
  const second = jobs.claim();
  assert.ok(second);
  jobs.finish(second.id, { ok: true }, second.attempts);

  jobs.retry(first, 'handler_failed');
  assert.equal(jobs.list(1)[0]!.status, 'completed', '旧代次的重试不得把已完成任务拉回 pending');
});
