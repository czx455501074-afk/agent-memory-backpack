/**
 * Time the product's own event reads on a copy of the real library.
 *
 * The SQL probe (`event-index-probe.mjs`) shows the plan change; this shows the effect
 * through the code that actually runs, which is the only thing a user experiences. It
 * opens a `VACUUM INTO` copy with the real `Store`, picks a task that really has events,
 * and times `taskActivity`, `generateJournal`, `exportTask` and two consecutive
 * `allEntries()` calls (cold decode, then the revision cache).
 *
 * The copy is disposable and writable on purpose: `Store` builds its indexes and runs
 * its cleanup on open, which is what a real start-up does. The live library is only ever
 * read.
 *
 * Usage: node verification/r6/event-read-timing.mjs [--source <db>] [--runs 5]
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const value = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const runs = Number(value('--runs') ?? 5);
const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
const source = resolve(value('--source') ?? join(home, '.agent-memory-backpack', 'knowledge.sqlite'));
if (!existsSync(source)) throw new Error(`找不到要测量的库：${source}`);

const work = mkdtempSync(join(tmpdir(), 'amb-event-timing-'));
const copy = join(work, 'knowledge.sqlite');

const time = (label, body) => {
  const samples = [];
  let last;
  for (let i = 0; i < runs; i += 1) {
    const start = process.hrtime.bigint();
    last = body();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  console.log(`- ${label}: 中位 ${median.toFixed(2)} ms（${samples.map(n => n.toFixed(2)).join(' / ')}）`);
  return last;
};

let store;
try {
  const live = new DatabaseSync(source, { readOnly: true });
  live.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
  const counts = {
    events: Number(live.prepare('SELECT count(*) AS n FROM events').get().n),
    knowledge: Number(live.prepare('SELECT count(*) AS n FROM knowledge').get().n),
    proposals: Number(live.prepare('SELECT count(*) AS n FROM proposals').get().n),
  };
  live.close();
  console.log(`# 副本：events ${counts.events} / knowledge ${counts.knowledge} / proposals ${counts.proposals}，runs=${runs}\n`);

  const { Store } = await import('../../dist/src/store.js');
  const openStart = process.hrtime.bigint();
  store = new Store(copy, Date.now);
  console.log(`- Store 打开（含建索引与清理）: ${(Number(process.hrtime.bigint() - openStart) / 1e6).toFixed(0)} ms\n`);

  const project = store.db.prepare("SELECT project_id FROM tasks ORDER BY updated_at DESC LIMIT 1").get();
  const projectId = String(project?.project_id ?? 'p0-workflow');
  const task = store.db.prepare(`SELECT t.id FROM tasks t
      JOIN events e ON json_extract(e.payload,'$.taskId')=t.id
      WHERE t.project_id=? LIMIT 1`).get(projectId);
  const taskId = String(task?.id ?? '');
  if (!taskId) throw new Error('副本里没有带事件的任务，无法测量任务活动');
  const eventCount = Number(store.db.prepare("SELECT count(*) AS n FROM events WHERE json_extract(payload,'$.taskId')=?").get(taskId).n);
  console.log(`- 取样任务：${taskId}（${eventCount} 条事件），项目 ${projectId}\n`);

  // Cold and warm are measured separately: repeating the "cold" call would measure the
  // cache four more times and quietly report the wrong number.
  const coldStart = process.hrtime.bigint();
  const coldEntries = store.allEntries();
  console.log(`- allEntries 冷读（解析 ${coldEntries.length} 条）: ${(Number(process.hrtime.bigint() - coldStart) / 1e6).toFixed(2)} ms`);
  time('allEntries 再读（revision 缓存命中）', () => store.allEntries());
  const activity = time('taskActivity', () => store.taskActivity(projectId, { taskId }));
  const journal = time('generateJournal', () => {
    try { return store.generateJournal(taskId, projectId); } catch { return null; }
  });
  const exported = time('exportTask', () => {
    try { return store.exportTask(taskId, projectId); } catch { return null; }
  });

  console.log(`\n- 结果自证：活动事件 ${activity.events.length} 条，日记 ${journal ? '生成成功' : '该任务无日记草稿'}，导出事件 ${exported ? exported.json.events.length : '不可用'} 条`);
  if (activity.events.length === 0) throw new Error('任务活动为空：索引路径没有返回数据，测量无意义');
} finally {
  try { store?.close(); } catch { /* already closed */ }
  rmSync(work, { recursive: true, force: true });
}
