/**
 * What would stage one of evolution produce on the real library?
 *
 * Runs against a read-only copy: the point of a dry run is to answer this *before* anything
 * is stored, so measuring it must not itself store anything.
 *
 * Usage: node verification/r6/evolve-measure.mjs [--source <db>]
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
const work = mkdtempSync(join(tmpdir(), 'amb-evolve-'));
const copy = join(work, 'knowledge.sqlite');

let store;
try {
  const live = new DatabaseSync(source, { readOnly: true });
  live.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
  live.close();

  const { Store } = await import('../../dist/src/store.js');
  store = new Store(copy, Date.now);
  const project = String(store.db.prepare(
    `SELECT project_id, count(*) AS n FROM proposals GROUP BY project_id ORDER BY n DESC LIMIT 1`).get().project_id);
  const totals = store.db.prepare('SELECT count(*) AS n FROM proposals WHERE project_id=?').get(project);

  const result = store.runEvolution({ projectId: project, dryRun: true });
  console.log(`# 项目 ${project}，候选表共 ${totals.n} 条（含全部状态）`);
  console.log(`- 扫描到的失败信号：${result.scanned}`);
  console.log(`- 产出的候选：${result.candidates.length}`);
  console.log(`- 被门禁挡下：${result.skipped.length}`);
  const byReason = new Map();
  for (const row of result.skipped) byReason.set(row.reason, (byReason.get(row.reason) ?? 0) + 1);
  for (const [reason, count] of [...byReason].sort((a, b) => b[1] - a[1])) console.log(`  · ${reason}: ${count}`);

  if (result.candidates.length) {
    console.log('\n## 前 5 条（按次数）');
    for (const candidate of result.candidates.slice(0, 5)) {
      console.log(`- ${candidate.occurrences} 次 / 跨 ${Math.round(candidate.spanMs / 60000)} 分钟 / 置信 ${candidate.confidence} / ${candidate.gate}`);
      console.log(`  ${candidate.observation.slice(0, 100)}`);
    }
  }

  const gateCount = new Map();
  for (const candidate of result.candidates) gateCount.set(candidate.gate, (gateCount.get(candidate.gate) ?? 0) + 1);
  console.log('\n## 门禁分布');
  for (const [gate, count] of gateCount) console.log(`- ${gate}: ${count}`);

  const before = Number(store.db.prepare('SELECT count(*) AS n FROM evolve_candidates').get().n);
  console.log(`\n## 预演后 evolve_candidates 行数：${before}（必须为 0）`);
  store.close();
  store = undefined;
} finally {
  try { store?.close(); } catch { /* closed */ }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { rmSync(work, { recursive: true, force: true, maxRetries: 3 }); break; }
    catch { await new Promise(done => setTimeout(done, 200)); }
  }
}
