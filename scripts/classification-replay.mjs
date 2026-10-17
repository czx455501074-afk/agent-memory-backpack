#!/usr/bin/env node
/**
 * Offline replay of the W2 content classifier over the real proposal queue.
 *
 * Read-only by construction: the database is opened with `readOnly: true` and the
 * script only ever issues SELECTs. It exists to answer one measurable question —
 * how many candidates the old heuristic called `norm` are still called `norm`
 * after the imperative-structure requirement was tightened — so the size of the
 * change is a number rather than an opinion.
 *
 * Usage:
 *   node scripts/classification-replay.mjs                 # counts only
 *   node scripts/classification-replay.mjs --samples=20    # + demoted examples
 *   node scripts/classification-replay.mjs --samples=20 --demoted    # only demoted
 *   node scripts/classification-replay.mjs --db=<path>     # override the library
 *
 * Candidate text is sanitised before printing: machine paths and user names are
 * replaced, so the output can be pasted into a document.
 */
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The judgement in force before this change: any deontic word means `norm`. */
const LEGACY_NORMATIVE = /(?:禁止|严禁|不得|必须|务必|规范|硬性要求|绝不|强制要求)/;

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const has = (name) => argv.includes(`--${name}`);

const dbPath = flag('db', join(homedir(), '.agent-memory-backpack', 'knowledge.sqlite'));
const sampleCount = Number(flag('samples', '0')) || 0;

/** Replace anything that identifies this machine before text reaches a document. */
function sanitize(text) {
  return String(text)
    .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/g, '<USER_HOME>')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<PATH>')
    .replace(/\/(?:home|Users)\/[^\s"']+/g, '<USER_HOME>')
    .replace(/\s+/g, ' ')
    .trim();
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db.prepare("SELECT id,payload FROM proposals WHERE state='pending' ORDER BY created_at").all();

let classifyCandidate = null;
let classifierSource = 'legacy only (dist/src/semantic.js not built)';
try {
  ({ classifyCandidate } = await import('../dist/src/semantic.js'));
  classifierSource = 'dist/src/semantic.js';
} catch {
  // The counters below still work: they only need the legacy judgement.
}

const counters = { pending: rows.length, legacyNorm: 0, newNorm: 0, demoted: 0, promoted: 0, unclassified: 0 };
const recorded = { norm: 0, normNowNorm: 0, normNowOther: 0, kindCounts: {} };
const demotedSamples = [];
const promotedSamples = [];
const keptNormSamples = [];

for (const row of rows) {
  let payload;
  try { payload = JSON.parse(String(row.payload)); } catch { continue; }
  const text = typeof payload.discovery === 'string' ? payload.discovery : '';
  if (text === '') continue;

  const recordedKind = payload.classification && typeof payload.classification === 'object'
    ? String(payload.classification.kind ?? '') : '';
  if (recordedKind === '') counters.unclassified += 1;
  recorded.kindCounts[recordedKind || '(none)'] = (recorded.kindCounts[recordedKind || '(none)'] ?? 0) + 1;

  const legacy = LEGACY_NORMATIVE.test(text) ? 'norm' : 'not-norm';
  if (legacy === 'norm') counters.legacyNorm += 1;

  if (!classifyCandidate) continue;
  const now = classifyCandidate(text, []).kind;
  if (now === 'norm') counters.newNorm += 1;
  if (recordedKind === 'norm') {
    recorded.norm += 1;
    if (now === 'norm') recorded.normNowNorm += 1;
    else recorded.normNowOther += 1;
  }
  if (legacy === 'norm' && now !== 'norm') {
    counters.demoted += 1;
    if (demotedSamples.length < sampleCount) demotedSamples.push({ id: row.id, kind: now, text: sanitize(text).slice(0, 220) });
  }
  if (legacy !== 'norm' && now === 'norm') {
    counters.promoted += 1;
    if (promotedSamples.length < sampleCount) promotedSamples.push({ id: row.id, text: sanitize(text).slice(0, 220) });
  }
  if (legacy === 'norm' && now === 'norm' && sampleCount > 0 && keptNormSamples.length < sampleCount) {
    keptNormSamples.push({ id: row.id, recorded: recordedKind, text: sanitize(text).slice(0, 220) });
  }
}

console.log(JSON.stringify({ database: sanitize(dbPath), classifier: classifierSource, ...counters },
  null, 2));
console.log(JSON.stringify({ '库中已记录的判定分布': recorded }, null, 2));
const section = (title, items) => {
  if (items.length === 0) return;
  console.log(`\n== ${title} ==`);
  for (const item of items) console.log(`- [${item.kind ?? 'norm'}] ${item.id}\n  ${item.text}`);
};
if (!has('promoted')) section('旧判 norm → 新判非 norm（降级样本）', demotedSamples);
section('旧判非 norm → 新判 norm（反向样本，须人工确认是否合理）', promotedSamples);
if (!has('demoted')) section('仍判 norm（真实规范应向样本）', keptNormSamples);
db.close();
