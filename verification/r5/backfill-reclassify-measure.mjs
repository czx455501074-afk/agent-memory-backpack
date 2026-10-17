/**
 * Measure the classification backfill against a *copy* of the real library.
 *
 * Why a copy: the real library belongs to the user and is being written by a running core.
 * Everything here is read from the original with a read-only connection and a `VACUUM INTO`
 * snapshot; the backfill itself then runs against the snapshot through the CLI, exactly as a
 * user would run it, and the original is never opened for writing.
 *
 * What it answers, in one run:
 *
 *   - how many pending candidates still carry a verdict from an older classifier;
 *   - the `kind` and `autoPromotable` distribution before and after the recomputation;
 *   - that a second dry run reports everything as skipped (the idempotence claim), which is
 *     the one number that separates "the backfill works" from "the backfill rewrites the
 *     same rows forever".
 *
 * Usage: node verification/r5/backfill-reclassify-measure.mjs [--source <db>] [--apply]
 * Without `--apply` the snapshot is only measured, never written.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name) => args.indexOf(name) >= 0;
const value = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };

const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
const source = resolve(value('--source') ?? join(home, '.agent-memory-backpack', 'knowledge.sqlite'));
if (!existsSync(source)) throw new Error(`找不到要测量的库：${source}`);

const work = mkdtempSync(join(tmpdir(), 'amb-backfill-measure-'));
const snapshot = join(work, 'knowledge.sqlite');
const counts = (db) => ({
  proposals: Number(db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n),
  pending: Number(db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE state='pending'").get().n),
});

/** A read-only snapshot: `VACUUM INTO` reads the original and writes only the copy. */
function snapshotTo(target) {
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    const before = counts(db);
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    return before;
  } finally {
    db.close();
  }
}

const distribute = (bag) => Object.entries(bag).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(' ');

try {
  const sourceCounts = snapshotTo(snapshot);
  const copy = new DatabaseSync(snapshot, { readOnly: true });
  const copyCounts = counts(copy);
  copy.close();
  const cli = join(repoRoot, 'dist', 'src', 'cli.js');
  const run = (extra) => {
    const result = spawnSync(process.execPath,
      [cli, 'reclassify', '--data-dir', work, '--project', value('--project') ?? 'p0-workflow', '--json', '--limit', '5000', ...extra],
      { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(`reclassify 失败：${result.stderr || result.stdout}`);
    return JSON.parse(result.stdout);
  };

  const dry = run([]);
  const applied = flag('--apply') ? run(['--yes']) : null;
  const rerun = run([]);
  // "Rewritten" and "the verdict actually moved" are different numbers, and both matter:
  // every stale snapshot is rewritten once (to carry the classifier version and the text
  // digest), while only some of them change what the queue would show.
  const kindChanged = dry.changes.filter(c => c.from !== c.to).length;
  const verdictFilled = dry.changes.filter(c => c.autoPromotableBefore === null && c.autoPromotableAfter !== null).length;
  const verdictChanged = dry.changes.filter(c => c.autoPromotableBefore !== c.autoPromotableAfter).length;

  console.log(JSON.stringify({
    source: { proposals: sourceCounts.proposals, pending: sourceCounts.pending },
    snapshot: copyCounts,
    dryRun: {
      scanned: dry.scanned, changed: dry.changed, skipped: dry.skipped, unreadable: dry.unreadable,
      kindBefore: distribute(dry.before), kindAfter: distribute(dry.after),
      autoPromotableBefore: distribute(dry.beforeAutoPromotable),
      autoPromotableAfter: distribute(dry.afterAutoPromotable),
      kindChanged, verdictChanged, verdictFilled,
      sampleChanges: dry.changes.slice(0, 8).map(c => `${c.id.slice(0, 8)} ${c.from}→${c.to} auto:${c.autoPromotableBefore}→${c.autoPromotableAfter}`),
      classifierVersion: dry.classifierVersion,
    },
    apply: applied ? { applied: applied.applied, changed: applied.changed, skipped: applied.skipped } : null,
    rerunAfterApply: { scanned: rerun.scanned, changed: rerun.changed, skipped: rerun.skipped },
    note: flag('--apply')
      ? '副本已回填；真实库从头到尾只被只读读取。'
      : '仅测量：副本也没有被写入（未传 --apply）。',
  }, null, 2));
} finally {
  rmSync(work, { recursive: true, force: true });
}
