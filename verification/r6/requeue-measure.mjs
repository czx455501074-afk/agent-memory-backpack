/**
 * Can the abandoned deliveries actually be recovered?
 *
 * The fingerprint is now order-independent, so the refusals that closed 1,168 events are no
 * longer true. This runs the whole recovery on a copy of the real library — reopen, replay,
 * report — because "the fix is correct" and "the queue drains" are different claims and only
 * the second one matters to the user.
 *
 * The copy is writable on purpose; the live library is opened read-only and snapshotted.
 *
 * Usage: node verification/r6/requeue-measure.mjs [--source <db>] [--apply]
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const value = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
const source = resolve(value('--source') ?? join(home, '.agent-memory-backpack', 'knowledge.sqlite'));
if (!existsSync(source)) throw new Error(`找不到要测量的库：${source}`);
const work = mkdtempSync(join(tmpdir(), 'amb-requeue-'));
const copy = join(work, 'knowledge.sqlite');

const count = (db, sql, params = []) => Number(db.prepare(sql).get(...params).n);

let store;
try {
  const live = new DatabaseSync(source, { readOnly: true });
  live.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
  const before = {
    abandoned: count(live, "SELECT count(*) AS n FROM outbox WHERE status='abandoned'"),
    events: count(live, 'SELECT count(*) AS n FROM events'),
  };
  live.close();

  const { Store } = await import('../../dist/src/store.js');
  store = new Store(copy, Date.now);
  const project = String(store.db.prepare('SELECT project_id FROM outbox GROUP BY project_id ORDER BY count(*) DESC LIMIT 1').get().project_id);
  console.log(`# 副本：abandoned ${before.abandoned}，events ${before.events}，项目 ${project}\n`);

  const preview = store.requeueAbandoned({ projectId: project, dryRun: true, limit: 5000 });
  console.log(`## 预演：匹配 ${preview.matched} 条`);
  for (const row of preview.byError.slice(0, 5)) console.log(`- ${row.count}｜${row.error}`);

  if (!args.includes('--apply')) {
    console.log('\n未加 --apply：只预演，未改动副本。');
  } else {
    const applied = store.requeueAbandoned({ projectId: project, dryRun: false, limit: 5000 });
    console.log(`\n## 已重新入队 ${applied.requeued} 条`);

    let delivered = 0, failed = 0, abandoned = 0;
    for (let pass = 0; pass < 20; pass += 1) {
      const result = store.replayOutbox({ projectId: project, limit: 1000, force: true });
      delivered += result.delivered.length;
      failed += result.failed.length;
      abandoned += result.abandoned.length;
      if (result.attempted === 0) break;
    }
    console.log(`## 重放结果：送达 ${delivered}，失败待重试 ${failed}，再次放弃 ${abandoned}`);

    const after = {
      sent: count(store.db, "SELECT count(*) AS n FROM outbox WHERE status='sent'"),
      pending: count(store.db, "SELECT count(*) AS n FROM outbox WHERE status='pending'"),
      failed: count(store.db, "SELECT count(*) AS n FROM outbox WHERE status='failed'"),
      abandoned: count(store.db, "SELECT count(*) AS n FROM outbox WHERE status='abandoned'"),
      events: count(store.db, 'SELECT count(*) AS n FROM events'),
    };
    console.log(`## 队列：sent ${after.sent} / pending ${after.pending} / failed ${after.failed} / abandoned ${after.abandoned}`);
    console.log(`## 事件流：${before.events} → ${after.events}`);

    const remaining = store.db.prepare(`SELECT substr(last_error,1,70) AS e, count(*) AS n FROM outbox
        WHERE status='abandoned' GROUP BY e ORDER BY n DESC LIMIT 3`).all();
    if (remaining.length) {
      console.log('\n## 仍被放弃的原因（前 3）');
      for (const row of remaining) console.log(`- ${row.n}｜${row.e}`);
    }
  }
  store.close();
  store = undefined;
} finally {
  try { store?.close(); } catch { /* closed */ }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { rmSync(work, { recursive: true, force: true, maxRetries: 3 }); break; }
    catch { await new Promise(done => setTimeout(done, 200)); }
  }
}
