/**
 * How much does one `prepare()` actually inject, and what did the budget cut?
 *
 * The cost of this plugin per turn is not the milliseconds — 15 ms is nothing next to a
 * model call — it is the characters pushed into the context window. A rule omitted for
 * budget is a rule that did not reach the turn that needed it, and until now that number
 * lived only in the receipt, never in a measurement.
 *
 * Runs against a read-only copy of the real library, with and without a known revision, so
 * the pointer-level shortcut can be compared with the full injection it replaces.
 *
 * Usage: node verification/r6/injection-budget.mjs [--source <db>]
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
const work = mkdtempSync(join(tmpdir(), 'amb-inject-'));
const copy = join(work, 'knowledge.sqlite');

const QUERIES = [
  ['相关查询', '知识库检索与规范注入怎么工作'],
  ['无关查询', '红烧肉怎么炖才不柴'],
  ['空查询', ''],
];

let store;
try {
  const live = new DatabaseSync(source, { readOnly: true });
  live.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
  live.close();
  const { Store } = await import('../../dist/src/store.js');
  store = new Store(copy, Date.now);
  const project = String(store.db.prepare('SELECT project_id FROM tasks ORDER BY updated_at DESC LIMIT 1').get().project_id);

  const report = (label, receipt) => {
    const context = String(receipt.context ?? '');
    const omitted = Array.isArray(receipt.omitted) ? receipt.omitted : [];
    const chars = context.length;
    console.log(`\n## ${label}`);
    console.log(`- context 字符数：${chars}（约 ${Math.round(chars / 2.2)} tokens）`);
    console.log(`- 规范 ${receipt.norms.length} 条 / 流程 ${receipt.workflows.length} 条 / 知识 ${receipt.knowledge.length} 条`);
    console.log(`- 本次省略：${omitted.length} 条`);
    for (const item of omitted.slice(0, 5)) console.log(`  · ${item.id}：${item.reason ?? ''}`);
    if (receipt.completeness) console.log(`- 完整度回执：${JSON.stringify(receipt.completeness)}`);
    return { chars, omitted: omitted.length, norms: receipt.norms.length };
  };

  console.log(`# 项目 ${project}，知识版本 ${store.revision}`);
  for (const [label, query] of QUERIES) {
    report(label, store.prepare(project, query));
  }

  // The pointer shortcut: a caller that already holds this revision gets a pointer instead
  // of the normative prose, so the saving is exactly the size of the repeated text.
  const revision = store.revision;
  const full = store.prepare(project, QUERIES[0][1]);
  const pointer = store.prepare(project, QUERIES[0][1], { knownRevision: revision });
  const fullChars = String(full.context ?? '').length;
  const pointerChars = String(pointer.context ?? '').length;
  console.log(`\n## 已知版本时的指针级注入`);
  console.log(`- 全文 ${fullChars} 字符 → 指针 ${pointerChars} 字符（省 ${fullChars - pointerChars}）`);
  console.log(`- 规范仍完整返回：${pointer.norms.length} 条（与全文一致：${pointer.norms.length === full.norms.length}）`);

  // What the library holds that never reaches a turn.
  const all = store.db.prepare(`SELECT k.kind AS kind, count(*) AS n FROM knowledge k WHERE k.status='active' GROUP BY k.kind ORDER BY n DESC`).all();
  console.log('\n## 库内活动条目按类别');
  for (const row of all) console.log(`- ${row.kind}: ${row.n}`);
  const normTotal = Number(store.db.prepare(`SELECT count(*) AS n FROM knowledge WHERE kind='norm' AND status='active'`).get().n);
  const normShown = full.norms.length;
  console.log(`\n## 规范覆盖：库内 ${normTotal} 条，本轮注入 ${normShown} 条，未到达 ${Math.max(0, normTotal - normShown)} 条`);
  store.close();
  store = undefined;
} finally {
  try { store?.close(); } catch { /* closed */ }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { rmSync(work, { recursive: true, force: true, maxRetries: 3 }); break; }
    catch { await new Promise(done => setTimeout(done, 200)); }
  }
}
