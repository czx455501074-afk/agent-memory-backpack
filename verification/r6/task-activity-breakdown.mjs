/**
 * Where does `taskActivity` spend its 71 ms?
 *
 * The event read was the suspect, but it is now an index seek and the call is still slow,
 * so the cost is somewhere else in the same method. This measures each public piece the
 * method composes, on a copy of the real library, rather than guessing.
 *
 * Usage: node verification/r6/task-activity-breakdown.mjs [--source <db>]
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
const work = mkdtempSync(join(tmpdir(), 'amb-activity-break-'));
const copy = join(work, 'knowledge.sqlite');

const median = (label, body, runs = 7) => {
  const samples = [];
  let last;
  for (let i = 0; i < runs; i += 1) {
    const start = process.hrtime.bigint();
    last = body();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  samples.sort((a, b) => a - b);
  console.log(`- ${label}: 中位 ${samples[Math.floor(samples.length / 2)].toFixed(2)} ms`);
  return last;
};

let store;
try {
  const live = new DatabaseSync(source, { readOnly: true });
  live.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
  live.close();
  const { Store } = await import('../../dist/src/store.js');
  store = new Store(copy, Date.now);

  const project = String(store.db.prepare('SELECT project_id FROM tasks ORDER BY updated_at DESC LIMIT 1').get().project_id);
  const taskId = String(store.db.prepare(`SELECT t.id FROM tasks t JOIN events e
      ON json_extract(e.payload,'$.taskId')=t.id WHERE t.project_id=? LIMIT 1`).get(project).id);
  const task = store.getTask(taskId, project);
  console.log(`项目 ${project}，任务 ${taskId}，会话 ${JSON.stringify(task.sessionIds)}\n`);

  store.taskActivity(project, { taskId }); // warm the revision cache
  median('getTask', () => store.getTask(taskId, project));
  median('allEntries（缓存命中）', () => store.allEntries());
  median('listProposals（全部状态）', () => store.listProposals(project));
  const scoped = median('taskScopedEntries', () => store.taskScopedEntries(project, taskId));
  median('taskActivity（整体）', () => store.taskActivity(project, { taskId }));
  console.log(`\n- taskScopedEntries 返回 ${Array.isArray(scoped) ? scoped.length : 'n/a'} 条`);

  // The pieces the method runs that are not directly callable are timed through the
  // statements they issue, so the split below is arithmetic rather than a guess.
  median('proposals 全表 select（仅 SQL，不解析）', () =>
    store.db.prepare('SELECT id,principal,idem,payload,state,created_at,expires_at FROM proposals WHERE 1=1 AND project_id = ? ORDER BY created_at DESC').all(project));
  const rows = store.db.prepare('SELECT payload FROM proposals WHERE project_id=?').all(project);
  console.log(`- 该项目 proposals 共 ${rows.length} 条，payload 合计 ${(rows.reduce((sum, row) => sum + String(row.payload).length, 0) / 1024).toFixed(0)} KiB`);
  median('proposals payload 全部 JSON.parse', () => rows.map(row => { try { return JSON.parse(String(row.payload)); } catch { return null; } }));

  // The event statement is the other half of the method, and the index has two candidate
  // paths. A plan that picks the project index walks tens of thousands of rows before
  // sorting; that is worth printing rather than inferring.
  const single = `SELECT id,payload,created_at FROM events
    WHERE json_extract(payload,'$.taskId')=? ORDER BY created_at DESC LIMIT 100`;
  const dual = `SELECT id,payload,created_at FROM events
    WHERE json_extract(payload,'$.taskId')=? AND json_extract(payload,'$.projectId')=?
    ORDER BY created_at DESC LIMIT 100`;
  const plan = (sql, params) => store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params).map(row => String(row.detail)).join(' | ');
  console.log(`\n单条件计划：${plan(single, [taskId])}`);
  console.log(`双条件计划：${plan(dual, [taskId, project])}`);
  median('events 单条件（产品当前未用）', () => store.db.prepare(single).all(taskId));
  median('events 双条件（产品当前使用）', () => store.db.prepare(dual).all(taskId, project));
} finally {
  try { store?.close(); } catch { /* closed */ }
  rmSync(work, { recursive: true, force: true });
}
