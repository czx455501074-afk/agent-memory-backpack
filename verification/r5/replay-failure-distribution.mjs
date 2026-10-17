/**
 * Read-only: the real distribution the distillation thresholds have to be chosen from.
 *
 * Answers four questions with counts rather than impressions:
 *   1. pending proposals per creation day, split into auto-captured failures and
 *      human submissions;
 *   2. the failure-fact signature population: how many signatures appear once, twice,
 *      eight times or more, and how many rows each threshold would keep or drop;
 *   3. which negative-filter rule would block which share of those rows;
 *   4. the hour-of-day shape of the busiest day, so "204 in one day" is known to be a
 *      burst or a steady stream.
 *
 * `readOnly: true`, no writes, no absolute path printed.
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { autoFailureSignature } from '../../dist/src/store.js';
import { NEGATIVE_FILTERS } from '../../dist/src/refine.js';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const dbPath = argv.includes('--db') ? argv[argv.indexOf('--db') + 1] : join(homedir(), '.agent-memory-backpack', 'knowledge.sqlite');
const hoursOf = (ms) => Math.floor((ms + 8 * 3600_000) % 86_400_000 / 3600_000); // local (UTC+8) hour

const hash = (p) => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16) : null);
const before = { size: statSync(dbPath).size, sha: hash(dbPath) };

const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db.prepare(`SELECT id, project_id, state, created_at, payload FROM proposals WHERE state='pending'`).all();
db.close();
const after = { size: statSync(dbPath).size, sha: hash(dbPath) };

const day = (ms) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
const read = (row) => {
  let payload = {};
  try { payload = JSON.parse(String(row.payload ?? '{}')); } catch { /* torn */ }
  const discovery = typeof payload.discovery === 'string' ? payload.discovery : '';
  const signature = autoFailureSignature(discovery);
  return {
    id: String(row.id), project: String(row.project_id), createdAt: Number(row.created_at), discovery,
    auto: signature !== null, signature: signature?.signature ?? null, tool: signature?.tool ?? null,
    observation: signature?.observation ?? '', insufficient: signature?.insufficient ?? false,
  };
};
const items = rows.map(read);
const human = items.filter((item) => !item.auto);
const failures = items.filter((item) => item.auto);

// ── 1. per day ──────────────────────────────────────────────────────────────
const days = new Map();
for (const item of items) {
  const key = day(item.createdAt);
  const bucket = days.get(key) ?? { day: key, total: 0, failures: 0, human: 0 };
  bucket.total += 1;
  bucket[item.auto ? 'failures' : 'human'] += 1;
  days.set(key, bucket);
}

// ── 2. signature population ─────────────────────────────────────────────────
const bySignature = new Map();
for (const item of failures) {
  const bucket = bySignature.get(item.signature) ?? [];
  bucket.push(item);
  bySignature.set(item.signature, bucket);
}
const groups = [...bySignature.entries()].map(([signature, members]) => {
  const sorted = [...members].sort((a, b) => a.createdAt - b.createdAt);
  return {
    signature, tool: sorted[0].tool, count: members.length,
    spanSec: Math.round((sorted[sorted.length - 1].createdAt - sorted[0].createdAt) / 1000),
    insufficient: sorted.every((member) => member.insufficient),
    sample: sorted[sorted.length - 1].observation.slice(0, 90),
  };
}).sort((a, b) => b.count - a.count);

const atLeast = (n) => groups.filter((group) => group.count >= n);
const threshold = (n) => ({
  threshold: n,
  groupsKept: atLeast(n).length,
  groupsDropped: groups.length - atLeast(n).length,
  rowsKept: atLeast(n).reduce((sum, group) => sum + group.count, 0),
  rowsDropped: groups.filter((group) => group.count < n).reduce((sum, group) => sum + group.count, 0),
});
const distribution = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12].map(threshold);
const onceOnly = groups.filter((group) => group.count === 1);

// ── 1b. how many failures arrive per day, so the arrival rate is a fact ─────
const failuresPerDay = [...days.values()].map((row) => ({ day: row.day, total: row.total, failures: row.failures, human: row.human }));
const arrival = {
  /** Failure rows created on the busiest day, which is the population the filters see. */
  busiestFailureDay: Math.max(...failuresPerDay.map((row) => row.failures)),
  /** Days covered, so a per-day average is not taken from one outlier. */
  days: failuresPerDay.length,
  averageFailuresPerDay: Math.round(failures.filter((item) => true).length / failuresPerDay.length * 10) / 10,
};

// ── 3. what the negative filters would block ────────────────────────────────
const filterHits = NEGATIVE_FILTERS.map((filter) => {
  const hit = groups.filter((group) => filter.matches({
    observation: group.sample, tool: group.tool, occurrences: group.count, spanMs: group.spanSec * 1000,
  }));
  return {
    id: filter.id, groups: hit.length,
    rows: hit.reduce((sum, group) => sum + group.count, 0),
    examples: hit.slice(0, 2).map((group) => `${group.count}× ${group.tool}: ${group.sample.slice(0, 60)}`),
  };
}).filter((entry) => entry.groups > 0);
const blockedRows = new Set();
for (const filter of NEGATIVE_FILTERS)
  for (const group of groups)
    if (filter.matches({ observation: group.sample, tool: group.tool, occurrences: group.count, spanMs: group.spanSec * 1000 })) blockedRows.add(group.signature);
const blockedTotal = groups.filter((group) => blockedRows.has(group.signature)).reduce((sum, group) => sum + group.count, 0);

// ── 4. the busiest day, by hour ─────────────────────────────────────────────
const busiest = [...days.values()].sort((a, b) => b.total - a.total)[0];
const busiestHours = items.filter((item) => day(item.createdAt) === busiest.day)
  .reduce((acc, item) => { const h = hoursOf(item.createdAt); acc[h] = (acc[h] ?? 0) + 1; return acc; }, {});
const busiestProjects = new Map();
for (const item of items.filter((entry) => day(entry.createdAt) === busiest.day))
  busiestProjects.set(item.project, (busiestProjects.get(item.project) ?? 0) + 1);

const report = {
  library: { file: dbPath.split(/[\\/]/).at(-1), sha256_16: before.sha, untouched: before.sha === after.sha && before.size === after.size },
  totals: { pending: items.length, failures: failures.length, human: human.length, signatures: groups.length },
  perDay: [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1)),
  arrival,
  signatureDistribution: distribution,
  /**
   * What each bound removes, in the order `collect` applies them, so the funnel is
   * reported as a funnel rather than as four independent numbers.
   */
  funnel: (() => {
    const blocked = groups.filter((group) => blockedRows.has(group.signature));
    const afterFilters = groups.filter((group) => !blockedRows.has(group.signature));
    const afterOccurrences = afterFilters.filter((group) => group.count >= 2);
    const afterSpan = afterOccurrences.filter((group) => group.spanSec * 1000 >= 120_000);
    const rows = (set) => set.reduce((sum, group) => sum + group.count, 0);
    return [
      { step: '全部失败事实', groups: groups.length, rows: failures.length },
      { step: '负向过滤后', groups: afterFilters.length, rows: rows(afterFilters) },
      { step: '同签名 ≥2 次后', groups: afterOccurrences.length, rows: rows(afterOccurrences) },
      { step: '跨度 ≥120 秒后', groups: afterSpan.length, rows: rows(afterSpan) },
    ];
  })(),
  onceOnly: { signatures: onceOnly.length, rows: onceOnly.reduce((sum, g) => sum + g.count, 0), shareOfFailures: failures.length === 0 ? 0 : Math.round(onceOnly.reduce((sum, g) => sum + g.count, 0) / failures.length * 100) / 100 },
  topSignatures: groups.slice(0, 10),
  filters: filterHits,
  filtersTogether: {
    blockedGroups: blockedRows.size, blockedRows: blockedTotal,
    remainingRows: failures.length - blockedTotal,
    shareOfFailures: failures.length === 0 ? 0 : Math.round(blockedTotal / failures.length * 1000) / 1000,
    shareOfPending: items.length === 0 ? 0 : Math.round(blockedTotal / items.length * 1000) / 1000,
    /** Following the ≥2 bound as well, which is what actually reaches suggestion stage. */
    remainingAfterOccurrenceBound: groups.filter((group) => !blockedRows.has(group.signature) && group.count >= 2)
      .reduce((sum, group) => sum + group.count, 0),
  },
  busiestDay: { day: busiest.day, total: busiest.total, failures: busiest.failures, human: busiest.human, byHour: busiestHours, byProject: Object.fromEntries(busiestProjects) },
};

if (asJson) { console.log(JSON.stringify(report, null, 2)); } else {
  console.log(`库文件 ${report.library.file}（sha256 ${report.library.sha256_16}…），只读且未改动：${report.library.untouched ? '是' : '否'}`);
  console.log(`\npending ${report.totals.pending} = 自动捕获失败事实 ${report.totals.failures} + 人工提交 ${report.totals.human}；失败事实签名 ${report.totals.signatures} 个`);
  console.log('\n按创建日：');
  for (const row of report.perDay) console.log(`  ${row.day}  合计 ${String(row.total).padStart(3)} = 失败 ${String(row.failures).padStart(3)} + 人工 ${String(row.human).padStart(3)}`);
  console.log('\n同签名出现次数阈值（针对失败事实）：');
  for (const row of report.signatureDistribution)
    console.log(`  ≥${String(row.threshold).padStart(2)} 次：留下 ${String(row.groupsKept).padStart(2)} 组 / ${String(row.rowsKept).padStart(3)} 条；丢掉 ${String(row.groupsDropped).padStart(2)} 组 / ${String(row.rowsDropped).padStart(3)} 条`);
  console.log(`\n只出现一次的签名：${report.onceOnly.signatures} 个，占失败事实 ${report.onceOnly.rows} 条（${Math.round(report.onceOnly.shareOfFailures * 100)}%）`);
  console.log('\n出现最多的签名：');
  for (const group of report.topSignatures) console.log(`  ${String(group.count).padStart(3)}× ${String(group.spanSec).padStart(6)}s ${group.tool}: ${group.sample.slice(0, 70)}`);
  console.log('\n负向过滤命中：');
  for (const filter of report.filters) console.log(`  ${filter.id.padEnd(22)} ${String(filter.groups).padStart(3)} 组 / ${String(filter.rows).padStart(3)} 条  ${filter.examples.join(' | ')}`);
  console.log(`  合计挡住 ${report.filtersTogether.blockedGroups} 组 / ${report.filtersTogether.blockedRows} 条 = 失败事实的 ${Math.round(report.filtersTogether.shareOfFailures * 100)}%、全部待审的 ${Math.round(report.filtersTogether.shareOfPending * 100)}%；剩余 ${report.filtersTogether.remainingRows} 条`);
  console.log(`  再叠加"同签名 ≥2 次"后剩余 ${report.filtersTogether.remainingAfterOccurrenceBound} 条`);
  console.log('\n逐级削减（collect 的实际顺序）：');
  for (const step of report.funnel) console.log(`  ${step.step.padEnd(18)} ${String(step.groups).padStart(2)} 组 / ${String(step.rows).padStart(3)} 条`);
  console.log(`\n到达率：最忙一天失败事实 ${report.arrival.busiestFailureDay} 条；覆盖 ${report.arrival.days} 天，平均每天 ${report.arrival.averageFailuresPerDay} 条失败事实`);
  console.log(`\n最忙的一天 ${report.busiestDay.day}：${report.busiestDay.total} 条（失败 ${report.busiestDay.failures} + 人工 ${report.busiestDay.human}）`);
  console.log('  按小时：' + Object.entries(report.busiestDay.byHour).sort((a, b) => a[0] - b[0]).map(([h, n]) => `${h}时:${n}`).join(' '));
  console.log('  按项目：' + JSON.stringify(report.busiestDay.byProject));
}
