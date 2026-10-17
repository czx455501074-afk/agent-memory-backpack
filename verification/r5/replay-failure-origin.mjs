/**
 * Read-only: what the origin classification removes from the distillation thresholds.
 *
 * Answers, with counts rather than impressions:
 *   1. the origin distribution of the auto-captured failure facts in a real library —
 *      before the change every row counted as `task_failure`, and the point of the
 *      comparison is how much of the population was never a failure *pattern*;
 *   2. the `minOccurrences = 2` coverage before and after: groups and rows kept when
 *      every failure counts (the old behaviour) versus when only `task_failure` counts;
 *   3. whether the two shapes the usage report identified — `old_string was not found in
 *      "…"` and `file changed since it was read` — are out of the sampled population;
 *   4. which rule filed each row, so a rule that matches a shape it should not is
 *      visible as a row count and not as an opinion.
 *
 * The library is read through a disposable copy that is then `VACUUM INTO` a snapshot:
 * the original file is never opened for writing and its hash is checked before and after.
 * Nothing absolute is printed; the same shape as `replay-failure-distribution.mjs`.
 *
 * Usage: node verification/r5/replay-failure-origin.mjs [--json] [--db <path>]
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoFailureSignature } from '../../dist/src/store.js';
import { failureOriginOf, FAILURE_ORIGINS, REFINE_DEFAULTS, collect, proposalSourceFrom } from '../../dist/src/refine.js';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const dbPath = argv.includes('--db') ? argv[argv.indexOf('--db') + 1] : join(homedir(), '.agent-memory-backpack', 'knowledge.sqlite');
const source = argv.includes('--source') ? argv[argv.indexOf('--source') + 1] : null;
const hash = file => (existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16) : null);

/** A snapshot of the live library, taken without writing to it. */
function snapshot() {
  const work = join(tmpdir(), `amb-origin-${process.pid}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const copy = join(work, 'knowledge.sqlite');
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, copy + suffix);
  const snap = join(work, 'snapshot.sqlite');
  const db = new DatabaseSync(copy, { readOnly: true });
  db.exec(`VACUUM INTO '${snap.replace(/\\/g, '/')}'`);
  db.close();
  return { snap, work };
}

const before = { size: statSync(dbPath).size, sha: hash(dbPath) };
const { snap, work } = snapshot();
const after = { size: statSync(dbPath).size, sha: hash(dbPath) };

const db = new DatabaseSync(snap, { readOnly: true });
const rows = db.prepare(`SELECT id, project_id, state, created_at, payload FROM proposals WHERE state IN ('pending','needs_evidence')`).all();
/**
 * The real scheduler, on the real rows, through the same function the CLI calls.
 *
 * Reconciling this against the counts below is the point: if the two ever disagree, the
 * difference is in `collect`'s frame and not in this script's arithmetic. `collect` reads
 * the snapshot directly and writes nothing.
 */
const run = collect({
  source: proposalSourceFrom(db, []),
  meta: () => undefined,
});
db.close();
rmSync(work, { recursive: true, force: true });

const read = row => {
  let payload = {};
  try { payload = JSON.parse(String(row.payload ?? '{}')); } catch { /* torn */ }
  const discovery = typeof payload.discovery === 'string' ? payload.discovery : '';
  const signature = autoFailureSignature(discovery);
  if (!signature) return null;
  const origin = failureOriginOf(discovery);
  return {
    id: String(row.id), project: String(row.project_id), createdAt: Number(row.created_at),
    signature: signature.signature, tool: signature.tool, observation: signature.observation,
    origin: origin.origin, rule: origin.rule, basis: origin.basis,
  };
};
const items = rows.map(read).filter(Boolean);
const scanned = rows.length;

/** Groups over a member predicate, so "before" and "after" differ only in the predicate. */
function coverage(members) {
  const bySignature = new Map();
  for (const item of members) {
    const bucket = bySignature.get(item.signature) ?? [];
    bucket.push(item);
    bySignature.set(item.signature, bucket);
  }
  const groups = [...bySignature.values()].map(members => {
    const sorted = [...members].sort((a, b) => a.createdAt - b.createdAt);
    return { count: members.length, spanMs: sorted[sorted.length - 1].createdAt - sorted[0].createdAt };
  });
  const kept = groups.filter(group => group.count >= REFINE_DEFAULTS.minOccurrences);
  return {
    groups: groups.length,
    groupsKept: kept.length,
    groupsDropped: groups.length - kept.length,
    rowsKept: kept.reduce((sum, group) => sum + group.count, 0),
    rowsDropped: groups.filter(group => group.count < REFINE_DEFAULTS.minOccurrences).reduce((sum, group) => sum + group.count, 0),
  };
}

const sampled = items.filter(item => item.origin === 'task_failure');
const origins = FAILURE_ORIGINS.map(origin => {
  const members = items.filter(item => item.origin === origin);
  return {
    origin,
    rows: members.length,
    share: items.length === 0 ? 0 : Math.round(members.length / items.length * 1000) / 10,
    groups: new Set(members.map(item => item.signature)).size,
    rules: [...members.reduce((acc, item) => {
      const key = `${item.rule}`;
      acc.set(key, (acc.get(key) ?? 0) + 1);
      return acc;
    }, new Map()).entries()].map(([rule, count]) => ({ rule, rows: count })).sort((a, b) => b.rows - a.rows),
  };
});

/** The two shapes the usage report measured, matched by text rather than by signature. */
const reportShapes = [
  { label: 'old_string was not found in "…"', match: item => /old_string was not found in/.test(item.observation) },
  { label: 'file changed since it was read', match: item => /file changed since it was read/.test(item.observation) },
].map(shape => {
  const members = items.filter(shape.match);
  const sampledMembers = members.filter(item => item.origin === 'task_failure');
  return {
    label: shape.label,
    rows: members.length,
    origins: [...new Set(members.map(item => item.origin))],
    rules: [...new Set(members.map(item => item.rule))],
    bases: [...new Set(members.map(item => item.basis))],
    inSampledPopulation: sampledMembers.length,
    wouldReachMinOccurrences: sampledMembers.length >= REFINE_DEFAULTS.minOccurrences,
  };
});

const report = {
  library: { file: dbPath.split(/[\\/]/).at(-1), sha256_16: before.sha, untouched: before.sha === after.sha && before.size === after.size },
  totals: {
    scanned, failures: items.length, human: scanned - items.length,
    source: source ?? '(default user library)',
  },
  /** Before: no classification existed, so every failure fact counted. */
  before: {
    note: '分类前（旧口径）：没有来源分类，全部失败事实都参与阈值统计',
    origins: [{ origin: 'task_failure', rows: items.length, share: 100, groups: new Set(items.map(item => item.signature)).size }],
    atMinOccurrences2: coverage(items),
  },
  /** After: only `task_failure` counts. */
  after: {
    note: '分类后：tool_collision 与 environment 移出阈值统计',
    origins,
    atMinOccurrences2: coverage(sampled),
    excluded: coverage(items.filter(item => item.origin !== 'task_failure')),
    excludedGroups: [...new Set(items.filter(item => item.origin !== 'task_failure').map(item => item.signature))]
      .map(signature => {
        const members = items.filter(item => item.signature === signature);
        return {
          signature, occurrence: members.length,
          origins: [...new Set(members.map(item => item.origin))],
          sampled: members.filter(item => item.origin === 'task_failure').length,
          sample: members[0].observation.slice(0, 80),
        };
      })
      .sort((a, b) => b.occurrence - a.occurrence),
  },
  reportShapes,
  /** What the real scheduler reports for the same snapshot, unreconciled on purpose. */
  collect: {
    scanned: run.scanned, groups: run.groups, sampledGroups: run.sampledGroups,
    considered: run.considered, suggestions: run.suggestions.length,
    origins: run.origins,
    excludedSignatures: run.excludedByOrigin.length,
    excludedRows: run.excludedByOrigin.reduce((sum, entry) => sum + entry.occurrences, 0),
    excludedSample: run.excludedByOrigin.slice(0, 5).map(entry => `${entry.occurrences}× [${entry.origins.join('/')}] ${entry.signature.slice(0, 60)}`),
    thresholds: run.thresholds,
  },
  rules: origins.reduce((acc, entry) => [...acc, ...entry.rules.map(({ rule, rows }) => ({ origin: entry.origin, rule, rows }))], []),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`库文件 ${report.library.file}（sha256 ${report.library.sha256_16}…），只读且未改动：${report.library.untouched ? '是' : '否'}`);
  console.log(`待审候选 ${report.totals.scanned} 条 = 自动捕获失败事实 ${report.totals.failures} + 人工提交 ${report.totals.human}`);
  console.log(`\n来源分布（阈值门槛 minOccurrences=${REFINE_DEFAULTS.minOccurrences}）：`);
  console.log(`  分类前：失败事实 ${report.before.origins[0].rows} 条（100%）全部计入统计，${report.before.origins[0].groups} 个签名`);
  for (const entry of report.after.origins)
    console.log(`  分类后：${entry.origin.padEnd(15)} ${String(entry.rows).padStart(3)} 条 / ${String(entry.share).padStart(5)}%  签名 ${String(entry.groups).padStart(2)} 个  ${entry.rules.map(r => `${r.rule}×${r.rows}`).join(' ')}`);
  console.log('\n阈值覆盖（minOccurrences=2）：');
  console.log(`  分类前：留下 ${report.before.atMinOccurrences2.groupsKept} 组 / ${report.before.atMinOccurrences2.rowsKept} 条；丢掉 ${report.before.atMinOccurrences2.groupsDropped} 组 / ${report.before.atMinOccurrences2.rowsDropped} 条`);
  console.log(`  分类后：留下 ${report.after.atMinOccurrences2.groupsKept} 组 / ${report.after.atMinOccurrences2.rowsKept} 条；丢掉 ${report.after.atMinOccurrences2.groupsDropped} 组 / ${report.after.atMinOccurrences2.rowsDropped} 条`);
  console.log(`  移出统计的：${report.after.excluded.groups} 组 / ${report.after.excluded.rowsKept + report.after.excluded.rowsDropped} 条（其中 ${report.after.excluded.groupsKept} 组原本已达门槛 → 不再进入采样）`);
  console.log(`\n真实提炼器（collect，默认门槛）在同一快照上的结果：`);
  console.log(`  扫描 ${report.collect.scanned} 条；失败签名 ${report.collect.groups} 个，其中进入统计 ${report.collect.sampledGroups} 个；通过门槛 ${report.collect.considered} 个；产出 ${report.collect.suggestions} 条`);
  console.log(`  移出统计：${report.collect.excludedSignatures} 个签名 / ${report.collect.excludedRows} 条`);
  for (const line of report.collect.excludedSample) console.log(`    ${line}`);
  console.log('\n报告点名的两个签名：');  for (const shape of report.reportShapes)
    console.log(`  ${shape.label}：${shape.rows} 行；分类 ${shape.origins.join('/')}（判据 ${shape.rules.join(',')}，${shape.bases.join('/')}）；落在采样总体内 ${shape.inSampledPopulation} 行；能否达到门槛：${shape.wouldReachMinOccurrences ? '能' : '否'}`);
  console.log('\n逐组移出明细（最多 12 组）：');
  for (const group of report.after.excludedGroups.slice(0, 12))
    console.log(`  ${String(group.occurrence).padStart(3)}× [${group.origins.join('/')}] ${group.sample.slice(0, 70)}`);
}
