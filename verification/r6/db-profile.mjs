/**
 * Profile the real library: how big each table is, which indexes exist, and what SQLite
 * actually does for the statements this product runs on every turn.
 *
 * Why a copy: the real library belongs to the user and is being written by a running core.
 * The original is opened read-only and snapshotted with `VACUUM INTO`; every measurement
 * below runs against the snapshot, so nothing here can change the live file.
 *
 * The question this answers is not "is SQLite fast" but "does the schema carry the queries
 * the code asks". A plan that says SCAN on a table that grows without bound is a latency bug
 * that only shows up months later, and this prints the plan next to the timing so a claim
 * about indexing can be checked instead of believed.
 *
 * Usage: node verification/r6/db-profile.mjs [--source <db>] [--runs 20]
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
void repoRoot;
const args = process.argv.slice(2);
const value = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const runs = Number(value('--runs') ?? 20);

const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
const source = resolve(value('--source') ?? join(home, '.agent-memory-backpack', 'knowledge.sqlite'));
if (!existsSync(source)) throw new Error(`找不到要测量的库：${source}`);

const work = mkdtempSync(join(tmpdir(), 'amb-db-profile-'));
const snapshot = join(work, 'knowledge.sqlite');
const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;

function snapshotTo() {
  const db = new DatabaseSync(source, { readOnly: true });
  try { db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`); }
  finally { db.close(); }
}

/** The statements the product runs, copied from the call sites they belong to. */
const statements = [
  {
    purpose: 'prepare: every checkpoint — current entries for one project',
    sql: `SELECT k.id,k.head,k.status,r.content FROM knowledge k
          JOIN revisions r ON r.id=k.id AND r.revision=k.head ORDER BY k.id`,
  },
  {
    purpose: 'prepare: recent progress (journal heads, newest first)',
    sql: `SELECT k.id AS id, k.head AS head, r.content AS content, r.created_at AS at
          FROM knowledge k JOIN revisions r ON r.id = k.id AND r.revision = k.head
          WHERE k.kind = 'journal' AND k.status = 'active'
          ORDER BY r.created_at DESC LIMIT 12`,
  },
  {
    purpose: 'review queue: proposals of one project, newest first',
    sql: `SELECT id,principal,idem,payload,state,created_at,expires_at FROM proposals
          WHERE 1=1 AND project_id = ? ORDER BY created_at DESC`,
    params: ['p0-workflow'],
  },
  {
    purpose: 'refine: pending candidates across the library',
    sql: `SELECT id,state,created_at,payload FROM proposals WHERE state IN ('pending','needs_evidence')`,
  },
  {
    purpose: 'cleanup: expired pending proposals',
    sql: `SELECT id FROM proposals WHERE state='pending' AND expires_at<=? AND payload NOT LIKE '%"important":true%'`,
    params: [Date.now()],
  },
  {
    purpose: 'tasks: the diary digest reads every event, oldest first',
    sql: 'SELECT payload, created_at FROM events ORDER BY created_at',
  },
  {
    purpose: 'cleanup: expired events',
    sql: 'DELETE FROM events WHERE expires_at<=?',
    params: [0],
    planOnly: true,
  },
  {
    purpose: 'outbox: ready items for replay',
    sql: `SELECT id,kind,idem,payload,project_id,principal,attempts,expires_at FROM outbox
          WHERE status IN ('pending','failed') AND next_attempt_at<=? ORDER BY next_attempt_at, created_at LIMIT ?`,
    params: [Date.now(), 20],
  },
  {
    purpose: 'proposals: per-id lookup (approve / detail)',
    sql: 'SELECT state,payload,project_id FROM proposals WHERE id=?',
    params: ['x'],
  },
];

const timeStatement = (db, sql, params) => {
  // A delete is planned but never executed: this script must not write to the snapshot
  // either, so the measurement that cannot be read-only is replaced by its plan.
  const prepared = db.prepare(sql);
  const start = process.hrtime.bigint();
  let rows = 0;
  for (let i = 0; i < runs; i += 1) {
    const result = prepared.all(...(params ?? []));
    rows = result.length;
  }
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6 / runs;
  return { rows, ms: Math.round(elapsed * 100) / 100 };
};

const planOf = (db, sql, params) => {
  try {
    return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params ?? []))
      .map(row => String(row.detail)).join(' | ');
  } catch { return '(plan unavailable)'; }
};

try {
  snapshotTo();
  const db = new DatabaseSync(snapshot, { readOnly: true });
  const tables = db.prepare("SELECT name,type FROM sqlite_master WHERE type IN ('table','index','view') ORDER BY type,name").all();
  const indexes = tables.filter(row => row.type === 'index').map(row => String(row.name));
  const userTables = tables.filter(row => row.type === 'table' && !String(row.name).startsWith('sqlite_')
    && !String(row.name).includes('_data') && !String(row.name).includes('_idx') && !String(row.name).includes('_content')
    && !String(row.name).includes('_docsize') && !String(row.name).includes('_config'));

  console.log(`# 库文件：${kb(statSync(source).size)}（快照 ${kb(statSync(snapshot).size)}），runs=${runs}\n`);
  console.log('## 表规模');
  for (const table of userTables) {
    const name = String(table.name);
    let n = 0;
    try { n = Number(db.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n); } catch { n = -1; }
    console.log(`- ${name}: ${n}`);
  }

  console.log('\n## 索引');
  for (const name of indexes) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name);
    console.log(`- ${name}: ${String(row?.sql ?? '').replace(/\s+/g, ' ').trim() || '(implicit)'}`);
  }

  console.log('\n## 热语句：计划与耗时');
  for (const statement of statements) {
    const plan = planOf(db, statement.sql, statement.params);
    if (statement.planOnly) {
      console.log(`\n### ${statement.purpose}\n- 计划：${plan}\n- 耗时：未执行（写入型语句，只取计划）`);
      continue;
    }
    const { rows, ms } = timeStatement(db, statement.sql, statement.params);
    const scans = (plan.match(/SCAN/g) ?? []).length;
    console.log(`\n### ${statement.purpose}\n- 计划：${plan}\n- 行数：${rows}，单次 ${ms} ms${scans ? `，SCAN×${scans}` : ''}`);
  }
  db.close();
} finally {
  rmSync(work, { recursive: true, force: true });
}
