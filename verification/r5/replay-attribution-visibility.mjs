/**
 * Read-only replay: how many queued candidates are classified but unattributed,
 * and what the queue view shows for them before and after the fix.
 *
 * The library is opened with `readOnly: true` and no statement in this file
 * writes: the row count and the file hashes printed at the end are the evidence
 * that the source database was not touched. Nothing here prints an absolute
 * path, so the output can be pasted into a doc without leaking a home directory.
 *
 * Usage:
 *   node verification/r5/replay-attribution-visibility.mjs            # human readable
 *   node verification/r5/replay-attribution-visibility.mjs --json     # machine readable
 *   node verification/r5/replay-attribution-visibility.mjs --db <path> --project <id>
 */
import { createHash } from 'node:crypto';
import { statSync, readFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { autoFailureSignature, proposalPriority } from '../../dist/src/store.js';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const arg = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const dbPath = arg('--db') ?? join(homedir(), '.agent-memory-backpack', 'knowledge.sqlite');

if (!existsSync(dbPath)) {
  console.error(`No library at the expected location; pass --db <path>.`);
  process.exit(1);
}

const digestOf = (path) => (existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16) : null);
const before = { db: digestOf(dbPath), wal: digestOf(`${dbPath}-wal`), size: statSync(dbPath).size };

const db = new DatabaseSync(dbPath, { readOnly: true });
const projectFilter = arg('--project');
const rows = db.prepare(
  `SELECT id, payload, state, created_at FROM proposals WHERE state='pending'${projectFilter ? ' AND project_id=?' : ''}`,
).all(...(projectFilter ? [projectFilter] : []));
db.close();

/** One row, read the way the queue view reads it (probe: edit tool availability). */
const read = (row) => {
  let payload = {};
  try { payload = JSON.parse(String(row.payload || '{}')); } catch { /* torn row */ }
  const classification = payload.classification ?? {};
  const discovery = typeof payload.discovery === 'string' ? payload.discovery : '';
  const signature = autoFailureSignature(discovery);
  const recorded = payload.attribution;
  return {
    id: String(row.id),
    createdAt: Number(row.created_at),
    classified: typeof classification.kind === 'string',
    kind: typeof classification.kind === 'string' ? classification.kind : null,
    confidence: typeof classification.confidence === 'number' ? classification.confidence : null,
    hasEvidence: typeof payload.evidence === 'string' && payload.evidence.trim().length > 0,
    important: payload.important === true,
    relation: typeof classification.relation === 'string' ? classification.relation : 'unknown',
    needsSplit: classification.needsSplit === true,
    /**
     * The recorded verdict, exactly as stored.
     *
     * A row whose payload carries no `attribution` object is reported as
     * `notRecorded`: the stored record says nothing about where this candidate
     * belongs, which is not the same fact as "described but unverified". Older
     * rows were written when an unresolved workflow could not be stored at all,
     * so they name nothing. The three cases are counted separately below.
     */
    attribution: recorded && typeof recorded === 'object'
      ? { workflowId: recorded.workflowId ?? null, stageId: recorded.stageId ?? null, resolved: recorded.resolved === true }
      : { workflowId: payload.workflowId ?? null, stageId: payload.stageId ?? null, resolved: null },
    autoFailure: signature !== null,
    signature: signature ? signature.signature : null,
  };
};

const items = rows.map(read);
const classified = items.filter((item) => item.classified);
const unattributed = classified.filter((item) => item.attribution.resolved !== true);
const byReason = {
  namedButNotFound: unattributed.filter((item) => item.attribution.resolved === false).length,
  notRecorded: unattributed.filter((item) => item.attribution.resolved === null).length,
};

/** How the queue view scores one item, under a given reading of a missing verdict. */
const verdict = (item, missingVerdict) => {
  const resolved = item.attribution.resolved === null ? missingVerdict : item.attribution.resolved;
  return {
    id: item.id, createdAt: item.createdAt,
    priority: proposalPriority({
      important: item.important, relation: item.relation, needsSplit: item.needsSplit,
      confidence: item.confidence ?? 0, hasEvidence: item.hasEvidence, attributed: resolved,
      autoFailure: item.autoFailure,
    }),
  };
};

/**
 * What the fix changes about visibility, stated as a number rather than a claim.
 *
 * Only rows whose payload carries no verdict can move: the old reading treated a
 * missing verdict as "attributed", the new one does not. The band (and therefore
 * the position in the queue) is compared, and the score delta is reported because
 * the attribution signal is worth 30 points inside a band.
 */
const movement = unattributed.map((item) => {
  const oldReading = verdict(item, true);
  const newReading = verdict(item, false);
  return {
    id: item.id,
    bandBefore: oldReading.priority.band, bandAfter: newReading.priority.band,
    scoreBefore: oldReading.priority.score, scoreAfter: newReading.priority.score,
    reasonBefore: oldReading.priority.reasons.at(-1) ?? null,
    reasonAfter: newReading.priority.reasons.at(-1) ?? null,
  };
});
const bandChanged = movement.filter((entry) => entry.bandBefore !== entry.bandAfter).length;
const scoreChanged = movement.filter((entry) => entry.scoreBefore !== entry.scoreAfter).length;

const after = { db: digestOf(dbPath), wal: digestOf(`${dbPath}-wal`), size: statSync(dbPath).size };

const report = {
  library: { file: dbPath.split(/[\\/]/).at(-1), sizeBytes: before.size, sha256_16: before.db },
  untouched: { sizeSame: before.size === after.size, dbHashSame: before.db === after.db, walHashSame: before.wal === after.wal },
  pending: {
    total: items.length,
    classified: classified.length,
    unattributed: unattributed.length,
    stillAttributed: classified.length - unattributed.length,
    byReason,
  },
  composition: {
    autoFailure: items.filter((item) => item.autoFailure).length,
    human: items.filter((item) => !item.autoFailure).length,
    humanUnattributed: unattributed.filter((item) => !item.autoFailure).length,
    humanAttributed: classified.filter((item) => !item.autoFailure && item.attribution.resolved === true).length,
  },
  visibility: {
    note: 'score/band 变化只发生在 payload 未记录 attribution 的行上；有 recorded.resolved=false 的行本来就按未归属计分。',
    unattributedScoredAsUnattributed: movement.filter((entry) => entry.scoreAfter !== entry.scoreBefore).length
      + unattributed.filter((item) => item.attribution.resolved === false).length,
    bandChanged,
    scoreChanged,
    sample: movement.filter((entry) => entry.scoreBefore !== entry.scoreAfter).slice(0, 5),
  },
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const r = report;
  console.log(`库文件 ${r.library.file}（${r.library.sizeBytes} 字节，sha256 ${r.library.sha256_16}…），只读打开，未改动：${r.untouched.sizeSame && r.untouched.dbHashSame && r.untouched.walHashSame ? '是（大小与哈希前后一致）' : '否，需要复查'}`);
  console.log('');
  console.log(`pending 总数                ${r.pending.total}`);
  console.log(`已分类                      ${r.pending.classified}`);
  console.log(`其中未归属（本次关注）      ${r.pending.unattributed}`);
  console.log(`  已记录但解析失败          ${r.pending.byReason.namedButNotFound}`);
  console.log(`  记录里没有归属字段        ${r.pending.byReason.notRecorded}`);
  console.log(`已归属                      ${r.pending.stillAttributed}`);
  console.log('');
  console.log(`人工提交 ${r.composition.human}（未归属 ${r.composition.humanUnattributed}，已归属 ${r.composition.humanAttributed}）／自动捕获 ${r.composition.autoFailure}`);
  console.log('');
  console.log(`可见性：未归属候选中 ${r.visibility.unattributedScoredAsUnattributed} 条按"未归属"计分`);
  console.log(`  排序 band 变化            ${r.visibility.bandChanged}（band 不变的条目位置不变，只是同 band 内分数差 30）`);
  console.log(`  分数变化                  ${r.visibility.scoreChanged}`);
  for (const item of r.visibility.sample) {
    console.log(`  ${item.id.slice(0, 8)} ${item.scoreBefore} → ${item.scoreAfter}（${item.reasonBefore} → ${item.reasonAfter}）`);
  }
}
