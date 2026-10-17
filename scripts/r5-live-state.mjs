// Read-only snapshot of the live library's candidate state.
//
// Written to answer one question that came up during R5: did anything write to the
// user's real knowledge base, or were the measurements and backfills done on a copy?
// The distinction matters because "the numbers changed" and "my data changed" are
// different claims, and a report can be true about the first while wrong about the
// second.
//
// Read-only by construction (readOnly: true, no writes, no VACUUM). Prints the state
// that a backfill would move: the stored kind distribution, how many pending rows lack
// a decision the gate can act on, and how many carry a classifier version.
//
// Usage: node scripts/r5-live-state.mjs [--data-dir DIR] [--json]
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const dataDir = args.includes('--data-dir') ? args[args.indexOf('--data-dir') + 1] : join(homedir(), '.agent-memory-backpack');
const asJson = args.includes('--json');

const db = new DatabaseSync(join(dataDir, 'knowledge.sqlite'), { readOnly: true });
const one = (sql, ...params) => db.prepare(sql).get(...params);
const all = (sql, ...params) => db.prepare(sql).all(...params);

const total = one(`SELECT count(*) n FROM proposals WHERE state='pending'`).n;
const kinds = all(`SELECT COALESCE(json_extract(payload,'$.classification.kind'),'(缺)') kind, count(*) n
  FROM proposals WHERE state='pending' GROUP BY 1 ORDER BY n DESC`);
const missingAuto = one(`SELECT count(*) n FROM proposals WHERE state='pending'
  AND json_extract(payload,'$.classification.autoPromotable') IS NULL`).n;
const versioned = one(`SELECT count(*) n FROM proposals WHERE state='pending'
  AND json_extract(payload,'$.classification.classifierVersion') IS NOT NULL`).n;
const withVersionOf = all(`SELECT COALESCE(json_extract(payload,'$.classification.classifierVersion'),'(未标注)') v, count(*) n
  FROM proposals WHERE state='pending' GROUP BY 1 ORDER BY n DESC`);
// B3 writes the capture origin; a non-zero count here means that line has been
// through this library's capture path, not merely implemented in code.
let origins = [];
try {
  origins = all(`SELECT COALESCE(json_extract(payload,'$.origin'),'(无)') o, count(*) n
    FROM proposals WHERE state='pending' GROUP BY 1 ORDER BY n DESC`);
} catch { origins = []; }
db.close();

const state = { dataDir, total, kinds, missingAuto, versioned, versions: withVersionOf, origins };

if (asJson) { console.log(JSON.stringify(state, null, 2)); }
else {
  console.log(`真实库候选状态（只读）：${total} 条 pending\n`);
  console.log('存储的类别分布（回填会改的就是这一列）：');
  for (const row of kinds) console.log(`  ${String(row.kind).padEnd(12)} ${row.n}`);
  console.log(`\n缺 autoPromotable（门禁无法据此自动放行）：${missingAuto}`);
  console.log(`带 classifierVersion 的：${versioned}`);
  for (const row of withVersionOf) console.log(`  ${String(row.v).padEnd(24)} ${row.n}`);
  if (origins.length > 1 || (origins[0] && origins[0].o !== '(无)')) {
    console.log('\n捕获来源（B3）：');
    for (const row of origins) console.log(`  ${String(row.o).padEnd(16)} ${row.n}`);
  } else {
    console.log('\n捕获来源（B3）：本库的待审候选都还没有 origin 字段（该线尚未流经本库）');
  }
  console.log(`\n目录：${dataDir}`);
}
