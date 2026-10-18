/**
 * Does an expression index actually turn the event reads into index seeks?
 *
 * The product reads the event stream three times with a full scan and filters in
 * JavaScript: `taskActivity`, `generateJournal` and `exportTask`. On the real library that
 * table holds tens of thousands of rows, so this measures the two candidate shapes — a
 * query plan before and after the index, and the time each statement takes — on a
 * disposable copy. A plan that says SCAN before and SEARCH after is the claim; the
 * milliseconds are the reason to care.
 *
 * Columns are deliberately NOT added: `paylooad` is already the record, and the backup
 * and archive paths move whole rows by column name, so an index on `json_extract` gets
 * the same speed without touching any write or export shape.
 *
 * Usage: node verification/r6/event-index-probe.mjs [--source <db>] [--runs 20]
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const value = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const runs = Number(value('--runs') ?? 20);
const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
const source = resolve(value('--source') ?? join(home, '.agent-memory-backpack', 'knowledge.sqlite'));
if (!existsSync(source)) throw new Error(`找不到要测量的库：${source}`);

const work = mkdtempSync(join(tmpdir(), 'amb-event-index-'));
const copy = join(work, 'knowledge.sqlite');

/** The three statements the product runs, expressed the way they would be after the change. */
const statements = [
  {
    id: 'taskActivity',
    before: "SELECT id,payload,created_at FROM events ORDER BY created_at DESC",
    after: `SELECT id,payload,created_at FROM events
            WHERE json_extract(payload,'$.taskId') = ?
            ORDER BY created_at DESC LIMIT 100`,
    params: ['task-does-not-exist'],
  },
  {
    id: 'generateJournal',
    before: 'SELECT payload, created_at FROM events ORDER BY created_at',
    after: `SELECT payload, created_at FROM events
            WHERE (json_extract(payload,'$.taskId') = ?
                   OR (json_extract(payload,'$.taskId') IS NULL
                       AND json_extract(payload,'$.sessionId') = ?))
              AND (json_extract(payload,'$.projectId') IS NULL OR json_extract(payload,'$.projectId') = ?)
            ORDER BY created_at`,
    params: ['task-does-not-exist', 'session-does-not-exist', 'p0-workflow'],
  },
  {
    id: 'exportTask',
    before: 'SELECT payload, created_at FROM events ORDER BY created_at',
    after: `SELECT payload, created_at FROM events
            WHERE json_extract(payload,'$.taskId') = ?
              AND (json_extract(payload,'$.projectId') IS NULL OR json_extract(payload,'$.projectId') = ?)
            ORDER BY created_at`,
    params: ['task-does-not-exist', 'p0-workflow'],
  },
  {
    id: 'cleanup',
    before: 'DELETE FROM events WHERE expires_at<=?',
    after: 'DELETE FROM events WHERE expires_at<=?',
    params: [0],
    planOnly: true,
  },
];

const indexes = [
  "CREATE INDEX IF NOT EXISTS events_task ON events(json_extract(payload,'$.taskId'), created_at)",
  "CREATE INDEX IF NOT EXISTS events_project ON events(json_extract(payload,'$.projectId'), created_at)",
  "CREATE INDEX IF NOT EXISTS events_session ON events(json_extract(payload,'$.sessionId'), created_at)",
  'CREATE INDEX IF NOT EXISTS events_expiry ON events(expires_at)',
];

const plan = (db, sql, params) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params ?? []))
  .map(row => String(row.detail)).join(' | ');

const time = (db, sql, params) => {
  const prepared = db.prepare(sql);
  const start = process.hrtime.bigint();
  let rows = 0;
  for (let i = 0; i < runs; i += 1) rows = prepared.all(...(params ?? [])).length;
  return { rows, ms: Math.round(Number(process.hrtime.bigint() - start) / 1e6 / runs * 100) / 100 };
};

try {
  const live = new DatabaseSync(source, { readOnly: true });
  live.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
  live.close();

  const db = new DatabaseSync(copy);
  console.log(`事件行数：${db.prepare('SELECT count(*) AS n FROM events').get().n}，runs=${runs}\n`);
  console.log('## 建索引前');
  for (const statement of statements) {
    const p = plan(db, statement.after, statement.params);
    if (statement.planOnly) { console.log(`- ${statement.id}: ${p}`); continue; }
    const { rows, ms } = time(db, statement.before, undefined);
    console.log(`- ${statement.id}（当前实现）: ${rows} 行, ${ms} ms, 计划 ${plan(db, statement.before)}`);
  }

  const beforeSize = db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size;
  const started = process.hrtime.bigint();
  for (const sql of indexes) db.exec(sql);
  const buildMs = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
  db.exec('ANALYZE');
  const afterSize = db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size;

  console.log(`\n## 建索引：${buildMs} ms，库体积 ${(beforeSize / 1048576).toFixed(1)} → ${(afterSize / 1048576).toFixed(1)} MiB`);
  console.log('\n## 建索引后（SQL 下推形态）');
  for (const statement of statements) {
    const p = plan(db, statement.after, statement.params);
    if (statement.planOnly) { console.log(`- ${statement.id}: ${p}`); continue; }
    const { rows, ms } = time(db, statement.after, statement.params);
    console.log(`- ${statement.id}: ${rows} 行, ${ms} ms, 计划 ${p}`);
  }

  // A hit path too: pick a task id that actually exists, so the measurement is not only
  // the empty case. An index that is fast only when nothing matches is not an answer.
  const real = db.prepare("SELECT json_extract(payload,'$.taskId') AS t FROM events WHERE t IS NOT NULL LIMIT 1").get();
  if (real?.t) {
    const params = [String(real.t), 'session-x', 'p0-workflow'];
    console.log(`\n## 命中路径（taskId=${String(real.t).slice(0, 24)}…）`);
    for (const statement of statements.filter(s => s.id !== 'cleanup')) {
      const { rows, ms } = time(db, statement.after, params);
      console.log(`- ${statement.id}: ${rows} 行, ${ms} ms`);
    }
  } else {
    console.log('\n## 命中路径：库内没有带 taskId 的事件，跳过');
  }
  db.close();
} finally {
  rmSync(work, { recursive: true, force: true });
}
