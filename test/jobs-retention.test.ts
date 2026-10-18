import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DurableJobs } from '../src/jobs.js';

/**
 * Completed maintenance jobs must not accumulate forever.
 *
 * The real library held 3,664 rows — every one terminal — growing by about one row per
 * notification and per model review, with nothing to remove them. Two things must survive
 * the cleanup: `needs_action` rows (still somebody's work) and a recent window of
 * completions (so "did last night's pass run?" is answerable).
 *
 * The fixture sets terminal states with SQL rather than through `finish()`, because `finish`
 * only touches a job in `status='running'` — going through it here would have produced rows
 * that were never completed, and the assertions would then have passed for the wrong reason.
 */

const DAY = 86_400_000;
const at = (clock: { now: number }) => () => clock.now;

function fixture() {
  const clock = { now: 1_700_000_000_000 };
  const db = new DatabaseSync(':memory:');
  const jobs = new DurableJobs(db, at(clock));
  const setTerminal = (idem: string, status: string, updatedAt: number) => {
    db.prepare('UPDATE maintenance_jobs SET status=?, updated_at=? WHERE idem=?').run(status, updatedAt, idem);
  };
  return { clock, db, jobs, setTerminal };
}

test('过期已完成作业被清理，needs_action 与近期记录保留', () => {
  const { clock, db, jobs, setTerminal } = fixture();
  jobs.enqueue('notify', 'old-done', {});
  jobs.enqueue('model_review', 'old-stuck', {});
  jobs.enqueue('notify', 'recent-done', {});
  setTerminal('old-done', 'completed', clock.now - 30 * DAY);
  setTerminal('old-stuck', 'needs_action', clock.now - 30 * DAY);
  setTerminal('recent-done', 'completed', clock.now - DAY);

  // `keep` is a *count* window, so a tiny fixture must state it: with the default 200 both
  // completed rows would be inside the window and nothing would be removed — correct
  // behaviour for a small library, wrong shape for a test about the age rule.
  const removed = jobs.purgeCompleted(14 * DAY, 1);
  assert.equal(removed, 1, '只应删掉那条又旧又已完成的');

  const left = jobs.list(50).map(job => job.key).sort();
  assert.deepEqual(left, ['old-stuck', 'recent-done'], `保留项不对：${JSON.stringify(left)}`);
  // Guard against the fixture itself being wrong: the surviving rows must really be in the
  // states the assertions claim.
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM maintenance_jobs WHERE status='needs_action'").get()!.n), 1);
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM maintenance_jobs WHERE status='completed'").get()!.n), 1);
});

test('最近窗口按数量保留，即使它们已经过期', () => {
  const { clock, db, jobs, setTerminal } = fixture();
  for (let index = 0; index < 6; index += 1) {
    jobs.enqueue('notify', `done-${index}`, {});
    // Distinct completion times, so "the newest three" is a well-defined set.
    setTerminal(`done-${index}`, 'completed', clock.now - 40 * DAY + index * 60_000);
  }

  const removed = jobs.purgeCompleted(14 * DAY, 3);
  assert.equal(removed, 3);
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM maintenance_jobs WHERE status='completed'").get()!.n), 3,
    '保留窗口是给“昨晚那一趟跑了吗”留的证据，不能因为过期就全删');
  const kept = db.prepare("SELECT idem FROM maintenance_jobs WHERE status='completed' ORDER BY updated_at DESC").all()
    .map(row => String((row as { idem: string }).idem));
  assert.deepEqual(kept, ['done-5', 'done-4', 'done-3'], `应保留最新的三条，实际 ${JSON.stringify(kept)}`);
});
