/**
 * Stage one of the evolution pipeline: turn repeated raw signals into candidates.
 *
 * The existing `refine.ts` only reads the **proposal** table, so a failure that was captured
 * and then rejected, or one whose proposal expired, leaves nothing behind for it to notice —
 * the queue is the last stop, not the source. This stage reads the raw signals instead and
 * answers one question: *which observations keep coming back?*
 *
 * Deliberate limits, and they are the whole point of the module:
 *
 *  - It is a pure function over signals. It writes nothing, so it cannot touch the library
 *    even by accident, and it can be run against a copy to see what it *would* produce.
 *  - It never produces knowledge. Its output is candidates; promoting them to `norm`/`skill`
 *    or writing `knowledge` at all stays a person's decision (see `FORBIDDEN_AUTOMATIC`).
 *  - Repetition is measured across **time**, not just count. Two identical failures inside
 *    one batch are one event that happened twice in a second, not a pattern; the span gate
 *    is what stops a bulk import from looking like learning.
 */

export interface FailureSignal {
  id: string;
  projectId: string;
  /** When the signal was recorded. */
  at: number;
  /** Normalised failure signature (tool + observation, see `autoFailureSignature`). */
  signature: string;
  tool: string;
  observation: string;
}

export interface EvolveThresholds {
  /** Distinct occurrences before a pattern is worth naming. */
  minOccurrences: number;
  /** And how far apart the first and last must be, so a batch is not a pattern. */
  minSpanMs: number;
  /** Confidence at or above this is `eligible`; below it the candidate waits for a person. */
  eligibleConfidence: number;
}

/**
 * Two occurrences 120 seconds apart is the floor.
 *
 * One occurrence is an incident; the same one twice within the same second is a retry loop
 * or a bulk import. Two minutes is short enough to catch a real repeating failure inside one
 * working session and long enough that a single failing command retried in a loop does not
 * qualify.
 */
export const EVOLVE_DEFAULTS: EvolveThresholds = {
  minOccurrences: 2,
  minSpanMs: 120_000,
  eligibleConfidence: 0.75,
};

export type EvolveGate = 'eligible' | 'needs_review' | 'blocked';

export interface EvolveCandidate {
  signature: string;
  projectId: string;
  tool: string;
  observation: string;
  occurrences: number;
  spanMs: number;
  firstSeenAt: number;
  lastSeenAt: number;
  memberIds: string[];
  confidence: number;
  gate: EvolveGate;
  /** Why this gate. Always stated: a candidate with no reason cannot be reviewed. */
  reason: string;
}

export interface DistillOutcome {
  candidates: EvolveCandidate[];
  /** Signals that produced no candidate, each with the rule that stopped it. */
  skipped: Array<{ signature: string; occurrences: number; reason: string }>;
  scanned: number;
}

/**
 * Things this pipeline must never do on its own.
 *
 * Written as data rather than prose so a test can assert the list is still complete and so
 * the receipt can show what was withheld rather than only what was produced. Every entry is
 * something a *person* may still do; the list is about automation.
 */
export const FORBIDDEN_AUTOMATIC: readonly string[] = [
  'write a knowledge entry',
  'create or modify a norm',
  'supersede or retire an existing entry',
  'widen an entry\'s scope (especially to global)',
  'delete or archive knowledge or proposals',
  'change the thresholds stored in meta',
  'touch credentials or credential-shaped text',
  'approve a candidate the classifier marked autoPromotable=false',
] as const;

/**
 * Confidence from occurrence count alone, capped below certainty.
 *
 * Deliberately simple and explainable: a reviewer must be able to predict it from the
 * numbers shown beside the candidate. It never reaches 1 — repetition is evidence of
 * recurrence, not proof that the conclusion is right.
 */
export function confidenceOf(occurrences: number): number {
  const raw = (occurrences - 1) / (occurrences + 2);
  return Math.round(Math.max(0, Math.min(0.95, raw)) * 100) / 100;
}

/**
 * Stage two: relate candidates to each other, and notice which have gone quiet.
 *
 * Two relations only, and both are decided by a rule a person can check by reading two
 * sentences side by side:
 *
 *  - `duplicate_of` — two signatures whose observation texts are nearly the same wording.
 *    The signature already normalises paths, ids and numbers, so a pair that survives that
 *    and still differs usually differs only in how it was phrased.
 *  - `stale_against` — a candidate nothing has hit for a long time. Not deleted, not
 *    archived: a past problem that stopped happening is still a fact, and the interesting
 *    question ("did we fix it, or did we stop doing that?") needs it to stay readable.
 *
 * There is deliberately no `contradicts`. Deciding that two observations disagree needs
 * semantics, and a wrong contradiction would be worse than none: it would let the pipeline
 * mark a true statement as disputed.
 */
export interface ConsolidateInput {
  signature: string;
  observation: string;
  lastSeenAt: number;
  occurrences: number;
}

export type EvolveRelation = 'duplicate_of' | 'stale_against';

export interface EvolveLink {
  fromSignature: string;
  toSignature: string;
  relation: EvolveRelation;
  similarity: number;
  reason: string;
}

export interface ConsolidateOutcome {
  links: EvolveLink[];
  stale: Array<{ signature: string; lastSeenAt: number; reason: string }>;
}

/** Thirty days without a recurrence is long enough that "still happening" stops being true. */
export const EVOLVE_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** Jaccard similarity at or above this counts as the same wording. */
export const EVOLVE_SIMILARITY = 0.8;

/** Word-ish tokens: Latin runs stay whole, Han runs are cut into bigrams like the index. */
function tokenSet(text: string): Set<string> {
  const tokens = new Set<string>();
  const runs = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const run of runs) {
    if (/^[\u4e00-\u9fff]+$/.test(run)) {
      if (run.length === 1) tokens.add(run);
      for (let index = 0; index + 1 < run.length; index += 1) tokens.add(run.slice(index, index + 2));
      continue;
    }
    tokens.add(run);
  }
  return tokens;
}

export function jaccard(a: string, b: string): number {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export function consolidateCandidates(
  candidates: ConsolidateInput[],
  // `now` has no default on purpose: a default of 0 would mark every candidate stale,
  // and a default of `Date.now()` would make the function untestable with a fake clock.
  options: { now: number; staleAfterMs?: number; similarityThreshold?: number },
): ConsolidateOutcome {
  const staleAfterMs = options.staleAfterMs ?? EVOLVE_STALE_AFTER_MS;
  const threshold = options.similarityThreshold ?? EVOLVE_SIMILARITY;
  const links: EvolveLink[] = [];
  const stale: ConsolidateOutcome['stale'] = [];

  for (const candidate of candidates) {
    const quietFor = options.now - candidate.lastSeenAt;
    if (quietFor >= staleAfterMs) {
      stale.push({
        signature: candidate.signature,
        lastSeenAt: candidate.lastSeenAt,
        reason: `${Math.round(quietFor / 86_400_000)} 天没有再出现`,
      });
    }
  }

  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const a = candidates[i]!;
      const b = candidates[j]!;
      if (a.signature === b.signature) continue;
      const similarity = jaccard(a.observation, b.observation);
      if (similarity < threshold) continue;
      // The more frequent one is the survivor: merging in that direction keeps the link
      // pointing at the better-evidenced statement, and the direction is what a reader uses
      // to decide which row to keep.
      const [from, to] = a.occurrences >= b.occurrences ? [b, a] : [a, b];
      links.push({
        fromSignature: from.signature,
        toSignature: to.signature,
        relation: 'duplicate_of',
        similarity: Math.round(similarity * 100) / 100,
        reason: `观察文本相似度 ${Math.round(similarity * 100)}%，疑似同一种失败的两种写法`,
      });
    }
  }
  return { links, stale };
}

/**
 * The statement a promoted candidate turns into.
 *
 * Written here rather than at the call site so every promoted proposal reads the same, and
 * so the numbers a reviewer needs (how often, over how long, which signature) are always in
 * the text. It states that the candidate is unverified: the pipeline observed a repetition,
 * it did not establish a cause.
 */
export function promotionText(candidate: EvolveCandidate): string {
  const minutes = Math.round(candidate.spanMs / 60_000);
  return [
    '【进化候选；待核】同一失败反复出现，尚未验证根因。',
    `观察：${candidate.observation}`,
    `出现 ${candidate.occurrences} 次，跨约 ${minutes} 分钟；置信 ${candidate.confidence}。`,
    `来源签名：${candidate.signature}`,
    `门禁：${candidate.gate}（${candidate.reason}）。`,
  ].join('\n');
}

/**
 * Group raw failures by signature and keep the ones that recur.
 *
 * Signals from different projects never merge: the same tool failure in two libraries is two
 * findings, and merging them would let one project's candidate carry another's evidence.
 */
export function distillFailures(signals: FailureSignal[], thresholds: EvolveThresholds = EVOLVE_DEFAULTS): DistillOutcome {
  const groups = new Map<string, FailureSignal[]>();
  for (const signal of signals) {
    if (!signal.signature || typeof signal.at !== 'number' || !Number.isFinite(signal.at)) continue;
    const key = `${signal.projectId}\u0000${signal.signature}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(signal);
    else groups.set(key, [signal]);
  }

  const candidates: EvolveCandidate[] = [];
  const skipped: DistillOutcome['skipped'] = [];

  for (const bucket of groups.values()) {
    const ordered = [...bucket].sort((a, b) => a.at - b.at);
    const first = ordered[0]!;
    const last = ordered[ordered.length - 1]!;
    const spanMs = last.at - first.at;
    const occurrences = ordered.length;
    const observation = first.observation.trim();

    if (!observation) {
      // A signature with no readable observation cannot become a reviewable statement.
      skipped.push({ signature: first.signature, occurrences, reason: 'no_observation' });
      continue;
    }
    if (occurrences < thresholds.minOccurrences) {
      skipped.push({ signature: first.signature, occurrences, reason: 'below_threshold' });
      continue;
    }
    if (spanMs < thresholds.minSpanMs) {
      skipped.push({ signature: first.signature, occurrences, reason: 'too_fast' });
      continue;
    }

    const confidence = confidenceOf(occurrences);
    const gate: EvolveGate = confidence >= thresholds.eligibleConfidence ? 'eligible' : 'needs_review';
    candidates.push({
      signature: first.signature,
      projectId: first.projectId,
      tool: first.tool,
      observation,
      occurrences,
      spanMs,
      firstSeenAt: first.at,
      lastSeenAt: last.at,
      memberIds: ordered.map(signal => signal.id),
      confidence,
      gate,
      reason: gate === 'eligible'
        ? `${occurrences} 次、跨 ${Math.round(spanMs / 60000)} 分钟反复出现`
        : `${occurrences} 次、跨 ${Math.round(spanMs / 60000)} 分钟，证据尚不足以自动归类`,
    });
  }

  candidates.sort((a, b) => b.occurrences - a.occurrences || a.signature.localeCompare(b.signature));
  skipped.sort((a, b) => b.occurrences - a.occurrences || a.signature.localeCompare(b.signature));
  return { candidates, skipped, scanned: signals.length };
}
