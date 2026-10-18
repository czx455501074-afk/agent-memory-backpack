/**
 * What one `prepare()` costs, end to end, on a copy of the real library.
 *
 * This is the call an agent makes on every turn, so it is the number that decides whether
 * the data layer is fast enough — the per-statement timings only explain it. Measured
 * with no `model-review.json` beside the copy, which is the deterministic local path: no
 * provider is contacted, so the timing is this process's own work.
 *
 * Usage: node verification/r6/prepare-timing.mjs [--source <db>] [--runs 9]
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const value = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const runs = Number(value('--runs') ?? 9);
const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
const source = resolve(value('--source') ?? join(home, '.agent-memory-backpack', 'knowledge.sqlite'));
if (!existsSync(source)) throw new Error(`找不到要测量的库：${source}`);
const work = mkdtempSync(join(tmpdir(), 'amb-prepare-timing-'));
const copy = join(work, 'knowledge.sqlite');

const median = (label, body) => {
  const samples = [];
  let last;
  for (let i = 0; i < runs; i += 1) {
    const start = process.hrtime.bigint();
    last = body();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  samples.sort((a, b) => a - b);
  console.log(`- ${label}: 中位 ${samples[Math.floor(samples.length / 2)].toFixed(2)} ms（最慢 ${samples[samples.length - 1].toFixed(2)}）`);
  return last;
};

let store;
try {
  const live = new DatabaseSync(source, { readOnly: true });
  live.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
  const counts = {
    events: Number(live.prepare('SELECT count(*) AS n FROM events').get().n),
    knowledge: Number(live.prepare('SELECT count(*) AS n FROM knowledge').get().n),
    drafts: Number(live.prepare('SELECT count(*) AS n FROM workflow_drafts').get().n),
    tasks: Number(live.prepare('SELECT count(*) AS n FROM tasks').get().n),
  };
  live.close();
  mkdirSync(work, { recursive: true });
  console.log(`# events ${counts.events} / knowledge ${counts.knowledge} / drafts ${counts.drafts} / tasks ${counts.tasks}，runs=${runs}\n`);

  const { Store } = await import('../../dist/src/store.js');
  store = new Store(copy, Date.now);
  const project = String(store.db.prepare('SELECT project_id FROM tasks ORDER BY updated_at DESC LIMIT 1').get().project_id);

  const coldStart = process.hrtime.bigint();
  store.prepare(project, '冷启动第一次 prepare：状态如何');
  console.log(`- 冷启动首次 prepare: ${(Number(process.hrtime.bigint() - coldStart) / 1e6).toFixed(2)} ms\n`);

  median('相关查询（命中库内主题）', () => store.prepare(project, '知识库检索与规范注入怎么工作'));
  median('无关查询（应当弃权）', () => store.prepare(project, '红烧肉怎么炖才不柴'));
  median('空查询（不检索，只注入规范）', () => store.prepare(project, ''));
  const related = store.prepare(project, '知识库检索与规范注入怎么工作');
  const unrelated = store.prepare(project, '红烧肉怎么炖才不柴');
  console.log(`\n- 相关查询注入 ${related.knowledge.length} 条知识、${related.norms.length} 条规范`);
  console.log(`- 无关查询注入 ${unrelated.knowledge.length} 条知识、${unrelated.norms.length} 条规范`);
} finally {
  try { store?.close(); } catch { /* closed */ }
  rmSync(work, { recursive: true, force: true });
}
