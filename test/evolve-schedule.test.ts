import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { createMaintenanceWorker } from '../src/maintenance.js';

/**
 * Evolution on a schedule, with two boundaries that matter more than the schedule.
 *
 * 1. **It must not run every tick.** A pass reads the whole candidate table, and a pass whose
 *    input has not changed produces the same candidates. The idempotency key carries a
 *    six-hour window, so a core that restarts every minute still runs it once per window —
 *    the throttle is part of the key rather than a remembered "last run", so it cannot drift.
 * 2. **It must not promote.** Distilling and relating is observation; promoting files
 *    proposals a person has to review. The worker runs unattended, so it stops at
 *    consolidation — that boundary is what `FORBIDDEN_AUTOMATIC` exists to state.
 */

const PROJECT = 'p0';
const MINUTE = 60_000;

const failure = (path: string) => [
  '【自动捕获的失败事实；待核实】',
  '所属流程：工具执行与故障恢复；步骤：记录失败、检索已有经验、验证修复。',
  '来源：dsh 会话 fixture；工具：edit。',
  `观察：cannot edit ${path}: file changed since it was read`,
  '根因与修复：尚未验证；请主动检索相关经验。',
].join('\n');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'amb-evolve-tick-'));
  const store = new Store(join(dir, 'knowledge.sqlite'));
  const worker = createMaintenanceWorker(store, dir, [PROJECT]);
  return { dir, store, worker };
}

test('维护循环会为进化入队，且窗口内只入队一次', async () => {
  const { dir, store, worker } = fixture();
  try {
    for (let pass = 0; pass < 8; pass += 1) await worker.tick();
    for (let pass = 0; pass < 8; pass += 1) await worker.tick();
    const jobs = store.db.prepare("SELECT idem FROM maintenance_jobs WHERE kind='evolve'").all()
      .map(row => String((row as { idem: string }).idem));
    assert.equal(jobs.length, 1, `六小时窗口内只应有一个进化作业，实际 ${JSON.stringify(jobs)}`);
    assert.match(jobs[0]!, new RegExp(`^evolve:${PROJECT}:\\d+$`), '幂等键应带窗口号，这样重启也不会重复');
  } finally {
    worker.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('进化作业写候选与关系，但不生成提案', async () => {
  const { dir, store, worker } = fixture();
  try {
    // The two observations must be far enough apart to be a pattern: the distill gate drops
    // anything inside two minutes as a retry loop or a bulk import, so giving both rows the
    // same timestamp would produce zero candidates and the assertion would look like a
    // missing feature rather than a wrong fixture.
    const base = Date.now() - 30 * MINUTE;
    for (const [index, key, file] of [[0, 'e1', 'D:\\a.txt'], [1, 'e2', 'D:\\b.txt']] as const) {
      const { id } = store.submit('agent', { idempotencyKey: key, projectId: PROJECT, discovery: failure(file) });
      store.db.prepare('UPDATE proposals SET created_at=? WHERE id=?').run(base + index * 10 * MINUTE, id);
    }
    const beforeRevision = store.revision;
    const beforeProposals = Number(store.db.prepare('SELECT count(*) AS n FROM proposals').get()!.n);

    for (let pass = 0; pass < 8; pass += 1) await worker.tick();

    const candidates = store.db.prepare('SELECT signature FROM evolve_candidates').all();
    assert.equal(candidates.length, 1, `应产出 1 条候选，实际 ${candidates.length}`);
    assert.equal(store.revision, beforeRevision, '进化不得改动知识库');
    assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM proposals').get()!.n), beforeProposals,
      '无人值守的作业不得提交提案：promote 属于人的决定');
  } finally {
    worker.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('作业完成后记录写下了知识库未变的凭据', async () => {
  const { dir, store, worker } = fixture();
  try {
    for (let pass = 0; pass < 8; pass += 1) await worker.tick();
    const row = store.db.prepare("SELECT result FROM maintenance_jobs WHERE kind='evolve' AND status='completed'").get() as
      { result: string } | undefined;
    assert.ok(row, '进化作业应已完成（无候选时也必须正常收尾）');
    const result = JSON.parse(row!.result) as { knowledgeUnchanged: boolean; scanned: number };
    assert.equal(result.knowledgeUnchanged, true, '回执须自带「知识库未变」这一条，否则读的人要自己去查');
    assert.equal(typeof result.scanned, 'number');
  } finally {
    worker.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
