/**
 * Do the SQLite tuning values borrowed from basic-memory actually help here?
 *
 * The reference project publishes a measured combination (`cache_size=-64000`,
 * `temp_store=MEMORY`, `synchronous=NORMAL`, `busy_timeout=10000`, a 256 MiB mmap). Those
 * values were measured on *its* write load, not this one, so they are a hypothesis. This
 * script tests the hypothesis on a copy of the real library: the same 3,000 event inserts
 * under the current pragmas, then under each addition, and finally the read statements
 * with and without the larger page cache.
 *
 * Nothing is adopted from the result until the numbers say so; `synchronous=NORMAL` in
 * particular trades durability, and a performance claim is not a reason to take that
 * trade silently.
 *
 * Usage: node verification/r6/pragma-probe.mjs [--source <db>] [--inserts 3000]
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const value = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const inserts = Number(value('--inserts') ?? 3000);
const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
const source = resolve(value('--source') ?? join(home, '.agent-memory-backpack', 'knowledge.sqlite'));
if (!existsSync(source)) throw new Error(`找不到要测量的库：${source}`);
const work = mkdtempSync(join(tmpdir(), 'amb-pragma-'));

const configs = [
  { name: '当前（WAL + busy_timeout=3000）', pragmas: ['PRAGMA journal_mode=WAL', 'PRAGMA busy_timeout=3000'] },
  { name: '＋ cache_size=-64000 + temp_store=MEMORY', pragmas: ['PRAGMA journal_mode=WAL', 'PRAGMA busy_timeout=3000', 'PRAGMA cache_size=-64000', 'PRAGMA temp_store=MEMORY'] },
  { name: '＋ synchronous=NORMAL', pragmas: ['PRAGMA journal_mode=WAL', 'PRAGMA busy_timeout=3000', 'PRAGMA synchronous=NORMAL'] },
  { name: '＋ synchronous=OFF（对照，不采用）', pragmas: ['PRAGMA journal_mode=WAL', 'PRAGMA busy_timeout=3000', 'PRAGMA synchronous=OFF'] },
];

const rows = 4000;
const insertOne = (db, i, batch) => db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)')
  .run(`probe-${batch}-${i}`, 'probe', `evt-${batch}-${i}`, 'fp',
    JSON.stringify({ eventId: `evt-${batch}-${i}`, projectId: 'probe', kind: 'probe', summary: `第 ${i} 条` }),
    Date.now(), Date.now() + 86_400_000);

const readStatements = [
  ['事件按任务（索引）', "SELECT id FROM events WHERE json_extract(payload,'$.taskId')=? AND json_extract(payload,'$.projectId')=?", ['none', 'probe']],
  ['活动条目（688 条 JSON 解析）', 'SELECT k.id,k.head,r.content FROM knowledge k JOIN revisions r ON r.id=k.id AND r.revision=k.head WHERE k.status=? ORDER BY k.id', ['active']],
];

try {
  for (const [index, config] of configs.entries()) {
    const copy = join(work, `copy-${index}.sqlite`);
    const live = new DatabaseSync(source, { readOnly: true });
    live.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
    live.close();

    const db = new DatabaseSync(copy);
    try {
      for (const pragma of config.pragmas) db.exec(pragma);

      // Batched like the product does: every event write is its own statement, no explicit
      // transaction, which is what makes `synchronous` matter at all.
      const statement = db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)');
      const writeStart = process.hrtime.bigint();
      for (let i = 0; i < inserts; i += 1) {
        statement.run(`probe-${index}-${i}`, 'probe', `evt-${index}-${i}`, 'fp',
          JSON.stringify({ eventId: `evt-${index}-${i}`, projectId: 'probe', kind: 'probe', summary: `第 ${i} 条` }),
          Date.now(), Date.now() + 86_400_000);
      }
      const writeMs = Number(process.hrtime.bigint() - writeStart) / 1e6;

      const readTimes = readStatements.map(([label, sql, params]) => {
        const prepared = db.prepare(sql);
        const start = process.hrtime.bigint();
        let n = 0;
        for (let i = 0; i < 20; i += 1) n = prepared.all(...params).length;
        return { label, n, ms: Number(process.hrtime.bigint() - start) / 1e6 / 20 };
      });

      console.log(`## ${config.name}`);
      console.log(`- 写入 ${inserts} 条事件：${writeMs.toFixed(0)} ms（${(inserts / writeMs * 1000).toFixed(0)} 条/秒）`);
      for (const read of readTimes) console.log(`- ${read.label}：${read.ms.toFixed(2)} ms（${read.n} 行）`);
    } finally {
      db.close();
    }
  }
} finally {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { rmSync(work, { recursive: true, force: true, maxRetries: 3 }); break; }
    catch { await new Promise(done => setTimeout(done, 200)); }
  }
}
