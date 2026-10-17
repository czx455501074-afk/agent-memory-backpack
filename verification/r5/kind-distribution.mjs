/**
 * What the adopted library actually contains, by kind.
 *
 * `r5-live-state.mjs` answers the same question for pending candidates; this one answers it
 * for the entries that are already in force. The two are different populations and only one
 * of them is affected by the review gate.
 *
 * Reads a VACUUM INTO copy: the running core holds the live file, and a probe has no business
 * touching it.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = process.env.AMB_DATA_DIR ?? join(homedir(), '.agent-memory-backpack');
const copy = join(tmpdir(), `amb-kind-distribution-${Date.now()}.sqlite`);
const live = new DatabaseSync(join(dataDir, 'knowledge.sqlite'));
live.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
live.close();

try {
  const db = new DatabaseSync(copy);
  // Content lives in `revisions`; `knowledge` holds only id/head/status. Reading `content`
  // off `knowledge` is the mistake this script made first, and the EPERM from the cleanup
  // buried it for two runs.
  const atHead = "FROM knowledge k JOIN revisions r ON r.id = k.id AND r.revision = k.head";
  const kinds = db.prepare(
    `SELECT json_extract(r.content, '$.kind') AS kind, COUNT(*) AS n ${atHead} GROUP BY kind ORDER BY n DESC`,
  ).all();
  const statuses = db.prepare('SELECT status, COUNT(*) AS n FROM knowledge GROUP BY status ORDER BY n DESC').all();
  const workflows = db.prepare(
    `SELECT k.id AS id, json_extract(r.content, '$.title') AS title ${atHead} WHERE json_extract(r.content, '$.kind') = 'workflow'`,
  ).all();
  db.close();

  console.log('已采纳条目按类型：');
  for (const row of kinds) console.log(`  ${row.kind}\t${row.n}`);
  console.log('按状态：');
  for (const row of statuses) console.log(`  ${row.status}\t${row.n}`);
  console.log(`workflow 条目：${workflows.length} 个`);
  for (const row of workflows) console.log(`  ${row.id}  ${row.title}`);
  if (workflows.length === 0) {
    // Say it plainly rather than letting a zero row pass as a normal result.
    console.log('  （没有 workflow：prepare 的 workflow 段在真实库上不会被触发，改动它不会改变本机任何一次注入）');
  }
} finally {
  // Best effort only. On this machine the temp copy is sometimes still held by something
  // outside this process, and a failed cleanup must never bury the numbers - the first two
  // versions of this script threw EPERM from the finally block and printed nothing at all.
  try {
    rmSync(copy, { force: true, maxRetries: 3, retryDelay: 120 });
  } catch {
    console.log(`（临时副本未能删除，可稍后自行清理：${copy}）`);
  }
}
