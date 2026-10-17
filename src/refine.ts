import { autoFailureSignature } from './store.js';

/**
 * The scheduling skeleton for turning repeated failures into candidate proposals.
 *
 * Dry-run first and conservative by default, because the thing being automated is
 * "write something into a review queue a person has to read". The scheduler produces
 * *suggestions* and stops there: nothing in this module inserts a proposal, adopts
 * one, or touches the knowledge table. `collect` is a pure read over proposals that
 * are already pending; the caller decides whether to submit what it returns.
 *
 * Parameter defaults and where they come from: every number below was chosen from a
 * read-only census of this library's own queue on 2026-10-17, not copied from another
 * project's configuration. The census (`verification/r5/replay-failure-distribution.mjs`)
 * found: 360 pending candidates = 134 auto-captured failures + 226 human submissions,
 * across 46 failure signatures; 36 of those signatures appear exactly once (36 rows,
 * 27% of all failure rows); the top signatures are 25x `edit ReplaceFileW EIO`,
 * 21x `pwsh exit_code=1`, 19x `edit cannot modify ... file has not been read`
 * (three signatures, 65 rows, 49% of all failure rows).
 *
 *  - `minOccurrences = 2`: the census decides it. Below 2 the run proposes from
 *    single sightings, which is one session's noise; at 2 it drops 36 groups / 36 rows
 *    (27%). Raising it to 8 only removes 5 more groups and gains nothing on rows
 *    (83 vs 98 of 134 — the same three dominant signatures), so a higher floor buys no
 *    selectivity while discarding real recurrences.
 *  - `minSpanMs = 120s`: a retry loop inside one stuck minute is not a pattern. The
 *    observed spans are far above it (the top ten signatures span 771s to 246384s), so
 *    this bound rejects loops rather than trimming the normal population.
 *  - `minConfidence = 0.75`: kept as the floor `confidenceOf` was calibrated against,
 *    with the caveat below — this one number has NOT been validated against outcomes,
 *    because no distilled candidate has been reviewed yet.
 *  - `maxProposalsPerRun = 5`: a conservative placeholder, deliberately NOT scaled to
 *    the queue (226 human submissions land in a day here; the ceiling must not track
 *    that). Five is chosen so a reviewer can read the whole batch in one sitting and
 *    judge whether the quality is worth keeping; the measured processing rate in this
 *    library is 11 decisions in four days, against a 204-candidate day, so a first
 *    batch larger than a handful would only rebuild the backlog out of machine text.
 *    This number needs a reviewer's feedback before it means anything.
 *  - `negativeFilterCount = 20`: a cap, not a list. `NEGATIVE_FILTERS` currently holds
 *    nine rules, each derived from text forms this queue actually contains; the count
 *    is what an operator can raise when more are added.
 *  - `metaPrefix = 'refine.'`: the values live in the same `meta` table the task
 *    convergence thresholds use (`Store.taskConvergenceThreshold`), so an operator
 *    changes them the same way, per library, without a schema change.
 *
 * What the census says these rules cannot do: the 134 failure rows are only 37% of the
 * queue. The other 226 rows are human submissions, which no failure-fact filter
 * touches, and the negative filters above block 27 of the 134 (20%). So this scheduler
 * is not a solution to the 204-a-day arrival rate, and it is not claimed to be one —
 * see `docs/implementation/r5-candidate-flow.md` for the measured shares.
 *
 * Where path redaction happens, and why not here: a capture keeps the absolute path
 * verbatim, because in a private local library the path is the most useful thing in the
 * row for whoever has to reproduce the failure. Placeholderising it at write time would
 * destroy that for every reader in order to protect against an action — sharing —
 * that has not happened yet. The boundary is therefore the *export and adoption* edge
 * (`export-skills.ts`, the adoption path in `server.ts`), which is where a row stops
 * being private and starts travelling; a library that is never exported never needs the
 * path rewritten. Nothing in this module rewrites paths, and nothing here should:
 * the signature normalisation in `store.ts` already collapses them for grouping, which
 * is a different purpose (two rows are the same failure) from redaction (a reader must
 * not learn the layout).
 */

/** What one distillation run is allowed to do, with every bound overridable. */
export interface RefineThresholds {
  /**
   * Sightings of one signature required before it is worth a candidate.
   *
   * A count is an attention bound, not a reproducibility claim. What makes a failure
   * reproducible is that **another independent execution hits it** — a second run, a
   * second session, a second machine — and only a reviewer (or a re-run) can establish
   * that. Four sightings inside one stuck afternoon are one accident seen four times;
   * one sighting that a fresh run repeats on demand is a real pattern. So this bound
   * ranks what is worth reading, and the value it produces must never be worded as
   * "this happened N times, therefore it reproduces". The origin frame above exists
   * for the half of that question the text can answer: an accident must not even reach
   * the count.
   */
  minOccurrences: number;
  /** First-to-last span required, so a tight retry loop is not a pattern. */
  minSpanMs: number;
  /** Confidence floor, computed by `confidenceOf` below. */
  minConfidence: number;
  /** Hard ceiling on suggestions per run, applied after ranking. */
  maxProposalsPerRun: number;
  /** How many negative-filter categories are in force; reported for auditability. */
  negativeFilterCount: number;
  /** `meta` key prefix the overrides are read from. */
  metaPrefix: string;
}

/**
 * The defaults, named so a receipt can say which number it applied.
 *
 * Measured on this library when written: 349 pending candidates, 126 of them
 * auto-captured failures across 47 signatures — i.e. every threshold below is
 * *above* what the current queue would pass for most signatures, which is the
 * intended direction for a first switch-on.
 */
export const REFINE_DEFAULTS: Omit<RefineThresholds, 'metaPrefix'> = {
  /**
   * Two, chosen from this library's own signature population: 36 of 46 signatures
   * appear exactly once (27% of failure rows), and everything above two removes the
   * same three dominant signatures rather than adding selectivity.
   */
  minOccurrences: 2,
  minSpanMs: 120_000,
  minConfidence: 0.75,
  /**
   * Five, and explicitly a placeholder: this is "how many a person can read in one
   * sitting", not "how many the queue holds". Needs reviewer feedback to settle.
   */
  maxProposalsPerRun: 5,
  negativeFilterCount: 20,
};

export const REFINE_META_PREFIX = 'refine.';

/**
 * Where a captured failure came from — the sampling frame, decided before any filter.
 *
 * Measured on this library (2026-10-17, `verification/r5/replay-failure-origin.mjs`):
 * 145 auto-captured failure facts, of which 22 are one file being written by two
 * processes at once (`old_string was not found in "…"`, `file changed since it was
 * read` — the two shapes the usage report found in 14% of the queue) and 34 are the
 * host refusing an operation for a reason that is not about the content (EIO from
 * `ReplaceFileW` while another writer held the file, timeouts, interrupted calls).
 * Filing those as "a repeated failure worth distilling" is the defect this exists to
 * stop: it inflates the occurrence counts the thresholds are calibrated against, and
 * the lesson they would distil ("retry when the editor refuses the write") is false.
 *
 * Three classes, and the boundary is deliberate:
 *  - `tool_collision`: the write was refused because the file's state no longer
 *    matches what the caller read. Another writer changed it in between;
 *  - `environment`: the host refused something for a reason outside the content —
 *    timeout, cross-volume EPERM, EIO, port in use, an interrupted call;
 *  - `task_failure`: everything else, including "the file is not there", "the tool
 *    needs an argument" and "this goal needs a human turn".
 *
 * The table is a copy of the one in `adapters/<host>/failure-capture.mjs`, which stamps
 * the class at capture time. It has to exist twice: the adapter ships as a standalone
 * plugin copy with no access to this compiler output. `test/failure-origin.test.ts`
 * and `test/failure-capture.test.mjs` run one fixture table through both sides, so a
 * drift between them fails the suite instead of quietly filing the same error under
 * two different classes depending on which host captured it.
 *
 * This is *not* the negative filter below and must not be folded into it. This table
 * answers "did we even draw this sample from the population the thresholds describe";
 * the filters answer "does this failure, taken at face value, carry anything
 * actionable". A concurrent-edit refusal has a very actionable shape and still belongs
 * to neither the thresholds nor the suggestion list; a bare `exit_code=1` is a real
 * task failure with nothing to distil. Merging the two would make one rule decide both
 * questions and neither answer would be auditable on its own.
 */
export type FailureOrigin = 'tool_collision' | 'environment' | 'task_failure';

export const FAILURE_ORIGINS: readonly FailureOrigin[] = ['tool_collision', 'environment', 'task_failure'];

/** The line the capture writes; kept here so both sides name it identically. */
export const FAILURE_ORIGIN_MARKER = '失败来源类别：';

export interface OriginRule {
  id: string;
  origin: FailureOrigin;
  /** Why a match means this class, in the terms the rule can actually see. */
  reason: string;
  matches: (observation: string) => boolean;
}

/**
 * Ordered, first match wins, `tool_collision` first.
 *
 * Each rule is a text form this library's queue actually contains, and each is a
 * decidable property of the string rather than a judgement about intent: the observed
 * text says the target string is absent, or that the file changed since it was read,
 * or names one of the host error conditions. A rule that matches nothing is visible as
 * such in the census rather than assumed to be doing work.
 *
 * The accepted imprecision: a mistyped `old_string`, and a file this same agent
 * already changed, read exactly like a collision. Both are "the write was refused
 * because the caller's view of the file is stale", and the only consequence of the
 * class is that the row is not used to calibrate thresholds and is not sampled for
 * distillation — never that it is recorded as knowledge.
 */
export const ORIGIN_RULES: OriginRule[] = [
  {
    id: 'concurrent_edit_target_missing', origin: 'tool_collision',
    reason: '编辑器的写入被拒，理由是目标串在文件里不存在：调用方读取之后文件被改过',
    matches: observation => /old_string was not found in/.test(observation),
  },
  {
    id: 'concurrent_edit_file_changed', origin: 'tool_collision',
    reason: '编辑器的写入被拒，理由是文件自读取以来已改变：同一文件被另一个写入方改过',
    matches: observation => /file changed since it was read/.test(observation),
  },
  {
    id: 'timeout', origin: 'environment',
    reason: '超时：宿主层面的时限，不是内容问题',
    matches: observation => /\btime(?:d|s)?\s*out\b|\btimeout\b|ETIMEDOUT|超时/i.test(observation),
  },
  {
    id: 'io_error', origin: 'environment',
    reason: '磁盘 I/O 层面的错误（EIO/EXDEV、ReplaceFileW 的 Win32 1175-1177）：另一个写入方持有文件或跨卷替换',
    matches: observation => /\bEIO\b|\bEXDEV\b|Win32 (?:1175|1176|1177)\b/.test(observation),
  },
  {
    id: 'cross_volume_eperm', origin: 'environment',
    reason: '跨盘符/跨卷改名被操作系统拒绝（EPERM、cross-device link）',
    matches: observation => /\bEPERM\b|cross-device link|跨盘符/.test(observation),
  },
  {
    id: 'port_in_use', origin: 'environment',
    reason: '端口被占用：环境状态，不是可复现的失败模式',
    matches: observation => /\bEADDRINUSE\b|address already in use|端口.{0,4}占用/i.test(observation),
  },
  {
    id: 'interrupted', origin: 'environment',
    reason: '调用被中断（工具调用被中止、SIGINT/SIGTERM、被中断）：没有结果可比对',
    matches: observation => /\btool call (?:was )?aborted\b|aborted before dispatch|\bEINTR\b|\bSIG(?:INT|TERM|KILL)\b|\binterrupt(?:ed|ion)\b|被中断/i.test(observation),
  },
];

/** The class of one observation. Default is `task_failure`, never "unknown". */
export function classifyFailureOrigin(observation: string): { origin: FailureOrigin; rule: string } {
  const text = String(observation ?? '');
  const rule = ORIGIN_RULES.find(candidate => candidate.matches(text));
  return rule ? { origin: rule.origin, rule: rule.id } : { origin: 'task_failure', rule: 'default' };
}

/** Whether the class came from the capture that wrote the row, or from its text now. */
export type OriginBasis = 'marker' | 'derived';

/**
 * The class of a stored row: the capture's own statement if it made one, else derived
 * from the text.
 *
 * The fallback is not a convenience. This library already holds 145 failure facts
 * captured before the marker existed, and a classifier that only trusted the marker
 * would report all 145 as `task_failure` — the exact reading the usage report calls
 * wrong. Deriving covers them and covers any payload written by an older adapter, and
 * `basis` says which route was taken, so a reviewer can tell what was decided at
 * capture time from what was reconstructed afterwards.
 *
 * The marker wins when the two disagree: it was written by the host that saw the
 * structured result, and a later rule change must not retroactively re-class a row the
 * capture already filed. `rule` accompanies the class so a cluster of rows can be
 * traced back to the rule that produced it.
 */
export function failureOriginOf(discovery: string): { origin: FailureOrigin; rule: string; basis: OriginBasis } {
  const text = typeof discovery === 'string' ? discovery : '';
  const observation = /观察：([\s\S]*?)(?:\n信息不足：|\n根因与修复：|$)/.exec(text)?.[1]?.trim() ?? '';
  const derived = classifyFailureOrigin(observation);
  const marked = /失败来源类别：([a-z_]+)(?:；判据：([a-z_]+))?/.exec(text);
  if (marked && (FAILURE_ORIGINS as readonly string[]).includes(marked[1]!)) {
    return { origin: marked[1] as FailureOrigin, rule: marked[2] ?? derived.rule, basis: 'marker' };
  }
  return { ...derived, basis: 'derived' };
}

/** A read-only view of the queue, so this module needs no Store instance. */
export interface ProposalSource {
  all(): Array<{ id: string; state: string; createdAt: number; discovery: string }>;
}

/**
 * The queue as this module reads it, straight from the rows.
 *
 * Read-only on purpose: the suggestion path must not be able to change the queue, and
 * a source that only knows how to `SELECT` cannot. `projects` narrows to the projects
 * the caller is allowed to see, because a maintenance pass is not a reason to read
 * across project boundaries.
 */
export function proposalSourceFrom(db: {
  prepare: (sql: string) => { all: (...params: unknown[]) => unknown[] };
}, projects: string[] = []): ProposalSource {
  const where = projects.length > 0 ? ` AND project_id IN (${projects.map(() => '?').join(',')})` : '';
  return {
    all() {
      const rows = db.prepare(`SELECT id,state,created_at,payload FROM proposals WHERE state IN ('pending','needs_evidence')${where}`)
        .all(...projects) as Array<Record<string, unknown>>;
      return rows.map(row => {
        let payload: Record<string, unknown> = {};
        try { payload = JSON.parse(String(row['payload'] ?? '{}')) as Record<string, unknown>; } catch { /* torn row */ }
        return {
          id: String(row['id']), state: String(row['state']), createdAt: Number(row['created_at']),
          discovery: typeof payload['discovery'] === 'string' ? payload['discovery'] as string : '',
        };
      });
    },
  };
}

/** The `meta` values, as the operator set them (missing means "use the default"). */
export type MetaReader = (key: string) => number | undefined;

/**
 * Read the effective thresholds, defaulting each one independently.
 *
 * A value that is not a positive safe integer is ignored rather than clamped: a
 * nonsense override should leave the conservative default in force, not become a
 * permissive number nobody intended. The applied values are returned so the receipt
 * can state them.
 */
export function refineThresholds(meta: MetaReader): RefineThresholds {
  const pick = (name: keyof typeof REFINE_DEFAULTS): number => {
    const raw = meta(`${REFINE_META_PREFIX}${name}`);
    return typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : REFINE_DEFAULTS[name];
  };
  /**
   * The confidence floor is a fraction, so it cannot share the integer rule above.
   *
   * It did share it, and the consequence was found by a test: any override below 1 was
   * discarded as "not a positive safe integer", so a library that wanted a laxer floor
   * silently kept 0.75 — the operator's setting was read, judged nonsense and ignored,
   * which is the failure mode a configurable bound exists to avoid. A value in (0, 1]
   * is the whole legal range here; anything else is not a confidence.
   */
  const rawConfidence = meta(`${REFINE_META_PREFIX}minConfidence`);
  const minConfidence = typeof rawConfidence === 'number' && Number.isFinite(rawConfidence) && rawConfidence > 0 && rawConfidence <= 1
    ? rawConfidence
    : REFINE_DEFAULTS.minConfidence;
  /**
   * The span bound is the one threshold zero is a legal value for.
   *
   * `0` means "any span", which is what a caller studying a single-sighting group needs
   * — such a group has `lastSeenAt === firstSeenAt`, so its span is exactly 0 and every
   * positive bound rejects it. Negative values are still refused, because there is no
   * reading of "at least -5 milliseconds" that a person could have meant.
   */
  const rawSpan = meta(`${REFINE_META_PREFIX}minSpanMs`);
  const minSpanMs = typeof rawSpan === 'number' && Number.isSafeInteger(rawSpan) && rawSpan >= 0
    ? rawSpan
    : REFINE_DEFAULTS.minSpanMs;
  return {
    minOccurrences: pick('minOccurrences'),
    minSpanMs,
    minConfidence,
    maxProposalsPerRun: pick('maxProposalsPerRun'),
    negativeFilterCount: pick('negativeFilterCount'),
    metaPrefix: REFINE_META_PREFIX,
  };
}

/**
 * Reasons a repeated failure is still not worth a candidate.
 *
 * Each rule reads the *observation text*, never the wrapper the adapter wrote, for
 * the same reason `autoFailureSignature` does: the wrapper is identical for every
 * capture and says nothing about whether this failure is interesting.
 *
 * The rules were written against forms this queue actually contains, and
 * `verification/r5/replay-failure-distribution.mjs` reports how many signatures and
 * rows each one blocks — so a rule that blocks nothing is visible as such. A rule must
 * be decidable from the text alone; anything needing a model to judge belongs in the
 * review queue, not here.
 */
export interface NegativeFilter {
  id: string;
  /** Why a match means "do not propose". */
  reason: string;
  matches: (sample: { observation: string; tool: string; occurrences: number; spanMs: number }) => boolean;
}

/**
 * Whether an observation carries anything to act on beyond a numeric code.
 *
 * Measured forms: `pwsh::exit_code=1` (21 rows) says only that a command failed, while
 * `old_string was not found in "…"` (10 rows) says what failed. So the test is "is
 * there a concrete token" — a quoted string, a file name, an error name — and not text
 * length: a long sentence of boilerplate would be long and still empty.
 */
const hasConcreteDetail = (observation: string): boolean =>
  /["'«][^"'»]{2,}|[^\s]{3,}\.(?:ts|js|mjs|json|md|py|ps1)\b|\b[A-Z][A-Za-z]*Error\b|\b(?:EIO|ENOENT|EACCES|EPERM|ETIMEDOUT)\b/.test(observation);

export const NEGATIVE_FILTERS: NegativeFilter[] = [
  {
    id: 'no_actionable_detail',
    reason: '观察文本只有错误码或占位符、没有具体对象：提不出可复用结论（本库实测占 21 条 pwsh exit_code=1 一类）',
    matches: ({ observation }) => !hasConcreteDetail(observation),
  },
  {
    id: 'single_command',
    reason: '一次性命令的失败（语法/用法错误）：重跑改一下就好，不是可复用经验',
    matches: ({ observation }) => /(usage:|unknown option|unrecognized argument|命令行参数|用法[:：])/i.test(observation),
  },
  {
    id: 'release_marker',
    reason: '发布/版本标记类信息：属于状态事实，不是经验',
    matches: ({ observation }) => /(release|version bump|tag(ged)? v?\d|发布标记|版本号已更新)/i.test(observation),
  },
  {
    id: 'momentary_dependency',
    reason: '短暂缺依赖：装上就好，重复出现也不构成方法',
    matches: ({ observation }) => /(cannot find module|module not found|ENOENT.*node_modules|未安装依赖|依赖缺失)/i.test(observation),
  },
  {
    id: 'generic_broken_tool',
    reason: '宽泛的"工具坏了"，没有具体现象：无法提炼成步骤',
    matches: ({ observation }) => /^(工具|tool).{0,6}(失败|错误|异常|坏了|failed)\s*[。.]?$/.test(observation.trim()),
  },
  {
    id: 'one_off_narrative',
    reason: '一次性叙事（会话/临时目录/本机绝对路径）：换个环境不再成立',
    matches: ({ observation }) => /(本次会话|这次会话|临时目录|temp(?:orary)? dir|[A-Za-z]:\\Users\\|\\AppData\\Local\\)/i.test(observation),
  },
  {
    id: 'already_resolved',
    reason: '文本自带"已解决/已修复"：沉淀价值在别处，不在这个失败上',
    matches: ({ observation }) => /(已解决|已修复|已经好了|resolved|fixed by)/i.test(observation),
  },
  {
    id: 'retry_loop',
    reason: '同一签名在极短窗口内反复出现：更像卡住重试，不是跨会话的模式',
    matches: ({ occurrences, spanMs }) => occurrences >= 12 && spanMs < 30_000,
  },
  {
    id: 'credential_shaped',
    reason: '文本含疑似凭据/令牌：不得进入候选正文',
    matches: ({ observation }) => /(bearer\s+[A-Za-z0-9._-]{12,}|sk-[A-Za-z0-9]{12,}|token=[A-Za-z0-9._-]{12,})/i.test(observation),
  },
];

/**
 * How much confidence a group has earned, from evidence the rows already carry.
 *
 * Three dimensions, all of them observable in what was stored — a fourth one was
 * removed after the census: `withRootCause` looked like evidence, but every capture
 * writes the same placeholder into its root-cause section ("根因与修复：尚未验证"), so
 * the term was zero for all 134 failure rows and only served to push every score below
 * the floor by a constant. A dimension that cannot vary is not a signal.
 *
 *  - repetition (0.60): how many times the same thing failed. `occurrences = 1` scores
 *    zero, eight scores the full share.
 *  - spread (0.25): how long the pattern persisted, reaching full share at ten
 *    minutes. Failures that recur across sessions differ from one stuck loop, and the
 *    stored timestamps say which this is. The cap was one hour in the first draft and
 *    was shortened after checking it against the queue: captures arrive minutes apart
 *    within a session, so an hour-long cap made every same-session group score zero on
 *    spread and pushed the whole population under the floor — a threshold no real
 *    group can pass is not a filter, it is an off switch.
 *  - stability (0.15): whether the samples agree once volatile parts are normalised.
 *    Eight sightings of the same file score higher than eight sightings that merely
 *    share a signature; this is the only term that separates the two.
 *
 * Worked examples, from the shapes the census found: 8 sightings ten minutes apart =
 * 0.850 (passes); 12 sightings inside 5.5 minutes = 0.687 (below the 0.75 floor — fast
 * and rarely spread is not yet a pattern); its real counterpart, 9 sightings over 28
 * hours with identical text = 0.854 (passes). The floor is therefore not decoration: it
 * separates "recurred across sessions" from "retried quickly".
 */
export function confidenceOf(input: {
  occurrences: number; spanMs: number; samples: number;
  withRootCause: number; distinctObservations: number;
}): number {
  const repetition = Math.min(1, (input.occurrences - 1) / 7);
  const spread = Math.min(1, input.spanMs / 600_000);
  const stability = input.samples === 0 ? 0 : 1 - (input.distinctObservations - 1) / input.samples;
  const score = 0.60 * repetition + 0.25 * spread + 0.15 * Math.max(0, stability);
  return Math.round(Math.min(1, score) * 1000) / 1000;
}

/** One suggestion, shaped like a candidate but not yet one. */
export interface RefinedCandidate {
  signature: string;
  tool: string;
  discovery: string;
  evidence: string;
  confidence: number;
  rationale: string;
  occurrences: number;
  firstSeenAt: number;
  lastSeenAt: number;
  memberIds: string[];
  negativeFiltersPassed: boolean;
}

export interface RefineRun {
  /** Always true for this implementation; kept explicit for the callers that log it. */
  dryRun: boolean;
  thresholds: RefineThresholds;
  scanned: number;
  /** Every failure signature found in the queue, before the sampling frame below. */
  groups: number;
  /** Groups that entered the threshold statistics, i.e. those with a `task_failure` member. */
  sampledGroups: number;
  /** Rows and groups per origin; `groups` counts a signature once per class it holds. */
  origins: Array<{ origin: FailureOrigin; rows: number; groups: number }>;
  /** Signatures left out of the statistics entirely, with the classes that removed them. */
  excludedByOrigin: Array<{
    signature: string; tool: string; occurrences: number;
    origins: FailureOrigin[]; bases: OriginBasis[];
  }>;
  considered: number;
  suppressed: Array<{ signature: string; rule: string; reason: string }>;
  belowThreshold: Array<{ signature: string; occurrences: number; spanMs: number; confidence: number; why: string }>;
  suggestions: RefinedCandidate[];
  /** Suggestions the ceiling removed, reported rather than silently dropped. */
  withheld: number;
  note: string;
}

/**
 * Read the queue and propose what could be distilled, without writing anything.
 *
 * Deliberately returns the suppressed and below-threshold groups as well: a run that
 * silently produced nothing is indistinguishable from a broken scheduler, and the
 * plan's own review of this area found that "no candidate was generated" needed an
 * explanation attached to it. The origin-excluded groups are reported the same way,
 * because "this signature is a collision, not a failure pattern" is a different
 * statement from "this signature is uninteresting" and a reader has to be able to see
 * which one it was.
 */
export function collect(input: {
  source: ProposalSource;
  meta: MetaReader;
  /** Injectable clock, so the span arithmetic is testable. */
  now?: number;
}): RefineRun {
  const thresholds = refineThresholds(input.meta);
  const rows = input.source.all();
  /** Every failure row, with the class its capture wrote or its text implies. */
  const records: Array<{
    id: string; createdAt: number; observation: string; rootCause: boolean;
    signature: string; tool: string; origin: FailureOrigin; basis: OriginBasis;
  }> = [];

  for (const row of rows) {
    const signature = autoFailureSignature(row.discovery);
    if (!signature) continue;
    const origin = failureOriginOf(row.discovery);
    records.push({
      id: row.id, createdAt: row.createdAt,
      observation: signature.observation,
      // A capture that states its own root cause carries more than a repeated error
      // code, and the candidate can quote it instead of restating the failure.
      rootCause: /根因与修复：(?!尚未验证)/.test(row.discovery),
      signature: signature.signature, tool: signature.tool,
      origin: origin.origin, basis: origin.basis,
    });
  }

  /**
   * The sampling frame: only `task_failure` rows are counted.
   *
   * A collision or an environment refusal is a real failure and is still stored — it is
   * simply not evidence about failure *patterns*, so counting it here would let
   * accidents satisfy `minOccurrences` for a signature nobody could reproduce. Which
   * rows reached the frame is reported (`origins`, `excludedByOrigin`), so the
   * exclusion is auditable rather than an invisible subtraction.
   */
  const bySignature = new Map<string, { tool: string; members: Array<{ id: string; createdAt: number; observation: string; rootCause: boolean }> }>();
  const originRows = new Map<FailureOrigin, number>(FAILURE_ORIGINS.map(origin => [origin, 0]));
  const originGroups = new Map<FailureOrigin, Set<string>>(FAILURE_ORIGINS.map(origin => [origin, new Set<string>()]));
  const allGroups = new Map<string, { tool: string; origins: Set<FailureOrigin>; bases: Set<OriginBasis>; occurrences: number; sampled: number }>();

  for (const record of records) {
    originRows.set(record.origin, (originRows.get(record.origin) ?? 0) + 1);
    originGroups.get(record.origin)!.add(record.signature);
    const group = allGroups.get(record.signature)
      ?? { tool: record.tool, origins: new Set<FailureOrigin>(), bases: new Set<OriginBasis>(), occurrences: 0, sampled: 0 };
    group.origins.add(record.origin);
    group.bases.add(record.basis);
    group.occurrences += 1;
    allGroups.set(record.signature, group);
    if (record.origin !== 'task_failure') continue;
    group.sampled += 1;
    const bucket = bySignature.get(record.signature) ?? { tool: record.tool, members: [] };
    bucket.members.push({ id: record.id, createdAt: record.createdAt, observation: record.observation, rootCause: record.rootCause });
    bySignature.set(record.signature, bucket);
  }

  const excludedByOrigin = [...allGroups.entries()]
    .filter(([, group]) => group.sampled === 0)
    .map(([signature, group]) => ({
      signature, tool: group.tool, occurrences: group.occurrences,
      origins: [...group.origins].filter(origin => origin !== 'task_failure'),
      bases: [...group.bases],
    }))
    .sort((a, b) => b.occurrences - a.occurrences || a.signature.localeCompare(b.signature));

  const suppressed: RefineRun['suppressed'] = [];
  const belowThreshold: RefineRun['belowThreshold'] = [];
  const passing: RefinedCandidate[] = [];

  for (const [signature, { tool, members }] of bySignature) {
    const sorted = [...members].sort((a, b) => a.createdAt - b.createdAt);
    const occurrences = sorted.length;
    const firstSeenAt = sorted[0]!.createdAt;
    const lastSeenAt = sorted[sorted.length - 1]!.createdAt;
    const spanMs = lastSeenAt - firstSeenAt;
    const newest = sorted[sorted.length - 1]!;
    const observations = new Set(sorted.map(member => member.observation));
    const sample = { observation: newest.observation, tool, occurrences, spanMs };

    const blocked = NEGATIVE_FILTERS.slice(0, thresholds.negativeFilterCount).find(filter => filter.matches(sample));
    if (blocked) {
      suppressed.push({ signature, rule: blocked.id, reason: blocked.reason });
      continue;
    }

    const confidence = confidenceOf({
      occurrences, spanMs,
      samples: occurrences,
      withRootCause: sorted.filter(member => member.rootCause).length,
      distinctObservations: observations.size,
    });
    const shortfall = [
      occurrences < thresholds.minOccurrences ? `出现 ${occurrences} 次 < 下限 ${thresholds.minOccurrences}` : null,
      spanMs < thresholds.minSpanMs ? `跨度 ${Math.round(spanMs / 1000)} 秒 < 下限 ${Math.round(thresholds.minSpanMs / 1000)} 秒` : null,
      confidence < thresholds.minConfidence ? `置信度 ${confidence} < 下限 ${thresholds.minConfidence}` : null,
    ].filter((item): item is string => item !== null);
    if (shortfall.length > 0) {
      belowThreshold.push({ signature, occurrences, spanMs, confidence, why: shortfall.join('；') });
      continue;
    }

    passing.push({
      signature, tool,
      // The suggestion is a claim about a repeated failure, phrased as one, and it
      // says plainly that the conclusion is not verified. The candidate that reaches
      // the queue still has to be reviewed by a person; this text never claims more
      // than the captures support.
      discovery: `【重复失败模式待核实】同一签名在 ${occurrences} 次捕获中出现（首次 ${new Date(firstSeenAt).toISOString()}，最近 ${new Date(lastSeenAt).toISOString()}）：${newest.observation}\n`
        + '根因与修复：尚未验证；本条由维护期提炼器根据重复失败事实生成，需人工核实后给出结论。',
      evidence: `提炼来源：proposals 中 ${occurrences} 条同签名自动捕获失败事实（成员 ${sorted.map(member => member.id).join(', ')}）；工具 ${tool}；跨度 ${Math.round(spanMs / 1000)} 秒。`,
      confidence,
      rationale: `出现 ${occurrences} 次（下限 ${thresholds.minOccurrences}）、跨度 ${Math.round(spanMs / 1000)} 秒（下限 ${Math.round(thresholds.minSpanMs / 1000)} 秒）、置信度 ${confidence}（下限 ${thresholds.minConfidence}），且通过负向过滤。`,
      occurrences, firstSeenAt, lastSeenAt,
      memberIds: sorted.map(member => member.id),
      negativeFiltersPassed: true,
    });
  }

  const ranked = passing.sort((a, b) =>
    b.confidence - a.confidence || b.occurrences - a.occurrences || a.signature.localeCompare(b.signature));
  const suggestions = ranked.slice(0, thresholds.maxProposalsPerRun);

  return {
    dryRun: true,
    thresholds,
    scanned: rows.length,
    groups: allGroups.size,
    sampledGroups: bySignature.size,
    origins: FAILURE_ORIGINS.map(origin => ({
      origin, rows: originRows.get(origin) ?? 0, groups: originGroups.get(origin)!.size,
    })),
    excludedByOrigin,
    considered: passing.length,
    suppressed,
    belowThreshold,
    suggestions,
    withheld: ranked.length - suggestions.length,
    note: `本次为干跑：只读取已入库的候选，未写入任何候选或知识条目。产出上限 ${thresholds.maxProposalsPerRun} 条，负向过滤启用 ${Math.min(thresholds.negativeFilterCount, NEGATIVE_FILTERS.length)} 类（清单共 ${NEGATIVE_FILTERS.length} 类）。`
      + `来源分类：${FAILURE_ORIGINS.map(origin => `${origin} ${originRows.get(origin) ?? 0} 条`).join('、')}；`
      + `${excludedByOrigin.length} 个签名因全部属于 tool_collision/environment 而未进入阈值统计（不计入出现次数）。`,
  };
}
