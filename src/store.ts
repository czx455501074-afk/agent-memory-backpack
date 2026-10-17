import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { DomainError, knowledgeSchema, proposalSchema, workflowSchema, type Knowledge, type KnowledgeDraft, type WorkflowDraft, type Workflow, type Scope } from './schema.js';
import { reviewDecision, type ReviewDecision } from './policy.js';
import { classifyCandidate, type SemanticAnalysis } from './semantic.js';
import { DurableJobs } from './jobs.js';
import { MATERIAL_TTL_DAYS, expiryFrom, isLive, materialEntry, renew, type MaterialInput } from './material.js';
import { positiveRetrievalClauses } from './retrieval-index.js';

type Row = Record<string, unknown>;
type Entry = { id: string; revision: number; status: string; content: Knowledge };
export type TaskStatus = 'in_progress' | 'paused' | 'completed' | 'cancelled' | 'failed';
const DAY = 86400000;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/**
 * Which version of the classifier produced a stored verdict.
 *
 * `payload.classification` is a snapshot taken when the candidate was submitted, and
 * the classifier has already changed once in a way that made most stored verdicts
 * wrong: 255 of 360 pending candidates still say `norm` while recomputing them with
 * the current classifier yields about 13. Without a version written next to the
 * snapshot there is no way to ask "which verdicts came from the current classifier",
 * so every improvement silently mixes old and new judgements — which is exactly what
 * happened, and what `reclassifyPending` now exists to repair.
 *
 * The constant must be bumped whenever `classifyCandidate`'s decisions change. It
 * lives here rather than beside the classifier because that file's shape is frozen for
 * this change; the note is the link between the two.
 */
export const CLASSIFIER_VERSION = 'semantic-2026-10-17';
/**
 * What a stored classification says about promoting a candidate unattended.
 *
 * One function, read by the server gate, the batch pre-check and the review pages, so
 * "may this be adopted without a person" has exactly one answer in the process. The
 * DSH adapter cannot import this file (it runs in another process against a core that
 * may be older), so it reads the same verdict from the server's response instead of
 * re-deriving it — see `classificationGate` on `/v1/proposals/get`.
 *
 * The load-bearing rule is the last branch: a snapshot with **no** `autoPromotable`
 * field is *not* an approval. Missing means "the verdict cannot speak for itself",
 * which is the state every stored candidate is in, and reading it as consent is how
 * 255 candidates classified `norm` by an older classifier could still be promoted in
 * one click.
 */
export interface ClassificationGate {
  /** True when a person has to acknowledge the verdict before the candidate is adopted. */
  required: boolean;
  /** The machine-readable reason a caller can branch on; null when nothing is required. */
  code: string | null;
  /** Why, in the sentence a reviewer is shown. Empty when nothing is required. */
  reason: string;
  /** What was read, so a client does not have to re-derive the verdict. */
  kind: string | null;
  scope: string | null;
  autoPromotable: boolean | null;
  classifierVersion: string | null;
}
export function classificationApprovalGate(classification: unknown): ClassificationGate {
  const record = classification && typeof classification === 'object' && !Array.isArray(classification)
    ? classification as Record<string, unknown> : null;
  const read = {
    kind: record && typeof record.kind === 'string' ? record.kind : null,
    scope: record && typeof record.scope === 'string' ? record.scope : null,
    autoPromotable: record && typeof record.autoPromotable === 'boolean' ? record.autoPromotable : null,
    classifierVersion: record && typeof record.classifierVersion === 'string' ? record.classifierVersion : null,
  };
  if (read.autoPromotable === true) return { required: false, code: null, reason: '', ...read };
  if (read.autoPromotable === false) {
    const reason = record && typeof record.promotionBlockedReason === 'string' && record.promotionBlockedReason
      ? record.promotionBlockedReason : '该候选被判定为不得自动升格，但快照里没有留下理由。';
    return { required: true, code: 'classification_confirmation_required', reason, ...read };
  }
  const reason = record
    ? '该候选的判定来自旧版本判定器（快照里没有 autoPromotable 字段），无法据此自动放行。'
    : '该候选没有分类判定，无法据此自动放行。';
  return { required: true, code: 'classification_confirmation_required', reason, ...read };
}
/**
 * Bounds on the persistent outbox.
 *
 * The design requires the offline queue to be a durable task, but a queue that
 * only ever grows is not a queue — it is an unbounded copy of the user's
 * information that no one looks at. Two independent caps are therefore enforced
 * (item count and total payload bytes), and a full outbox is reported as such
 * rather than silently dropping the newest item: a dropped candidate is lost
 * information, and the caller is the only one who can decide what to do instead.
 */
export const OUTBOX_MAX_ENTRIES = 500;
export const OUTBOX_MAX_BYTES = 4 * 1024 * 1024;
/**
 * How long an undelivered item waits before it is marked `abandoned`.
 *
 * Expiry abandons rather than deletes. Deleting a lapsed item would discard the
 * user's own words while they cannot see it happen, which is exactly the silent
 * information loss the design forbids; an abandoned row keeps the reason, the
 * attempt count and when the deadline passed, so a person can still inspect and
 * retry it deliberately.
 */
export const OUTBOX_TTL_MS = 7 * DAY;
/**
 * Attempts after which an undelivered item is given up on.
 *
 * The design (acceptance 20) forbids retrying forever, so the queue stops on its
 * own rather than waiting for someone to notice. The row stays as `abandoned`.
 */
export const OUTBOX_MAX_ATTEMPTS = 12;
/** Outbox rows that are no longer waiting to go out. */
const OUTBOX_TERMINAL = ['sent', 'abandoned'];
/**
 * Refusal text that identifies a permanent conflict when the structured error is gone.
 *
 * The decision below reads `DomainError.code`/`status` first, and only falls back to
 * these when the error crossed a boundary that dropped its identity (a re-thrown
 * string, a bridged call). The wording is the exact wording the store throws, so a
 * match means the same conflict and not a lookalike.
 */
const PERMANENT_REPLAY_MESSAGES = [
  /idempotency_conflict/i,
  // Covers all three throw sites of the conflict: "Event key already has different
  // content", "Same idempotency key has different content" and "Checkpoint key
  // already has different content".
  /has different content/i,
  /already queued as a different kind of item/i,
];
/**
 * Whether a replay failure will fail the same way however many times it is retried.
 *
 * `replayOutbox` re-sends a payload the store already holds, so its request is
 * frozen: a refusal of *that request* — any 4xx — is a property of the content, not
 * of the moment, and resending it can only produce the same refusal. The cost of
 * ignoring that was measurable in production: 984 rows (451 failed, 533 abandoned)
 * all carrying the same `idempotency_conflict`, retried 9,773 times between them and
 * delivering nothing, each attempt blocking a session's first step.
 *
 * A 5xx, a network fault or a full outbox (507) is the opposite case: the request was
 * fine and the world was not, so it stays retryable and keeps its backoff. The status
 * range rather than a list of the codes seen so far is deliberate: every 4xx is a
 * rejection of this exact request by construction, while a list would quietly send
 * the next code someone adds back into infinite retries.
 */
export function isPermanentReplayRefusal(error: unknown): boolean {
  if (error instanceof DomainError) {
    // `idempotency_conflict` is called out by name because it is the one production
    // hit, and because its 409 is a fact about the content rather than the request
    // shape; the status range then covers every other business refusal (400
    // `invalid_request`, 403 `forbidden`/`scope_denied`, 404 `not_found`, and so on).
    return error.code === 'idempotency_conflict' || (error.status >= 400 && error.status < 500);
  }
  const message = error instanceof Error ? error.message : String(error);
  return PERMANENT_REPLAY_MESSAGES.some(pattern => pattern.test(message));
}
/**
 * Whether a scope applies to the caller's project and task.
 *
 * A task-scoped entry applies only to that task, and to nothing when the caller
 * has no task in hand. That is the whole point of the scope: "这一次用 Banana"
 * must not become a rule for every later task, and the only way to guarantee that
 * is to make it inapplicable when the task is unknown rather than when it differs.
 */
const applicable = (scope: Scope, projectId: string, taskId?: string): boolean => {
  if (scope.kind === 'global') return true;
  if (scope.projectId !== projectId) return false;
  if (scope.kind === 'task') return taskId !== undefined && scope.taskId === taskId;
  return true;
};
function searchable(value: string): string {
  // Unicode words plus CJK bigrams: deterministic Chinese recall without an external model.
  const words = value.toLowerCase().match(/[a-z0-9_-]+|[\p{Script=Han}]+/gu) ?? [];
  return words.flatMap(word => /\p{Script=Han}/u.test(word)
    ? (word.length === 1 ? [word] : Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)))
    : [word]).join(' ');
}

/**
 * Query tokens, most specific first.
 *
 * A CJK bigram is a fragment, not a word: `重启` is produced by both "重启" and
 * "已重启", and it occurs inside unrelated prose often enough that matching on
 * any fragment alone returns a page of noise. Longer tokens are therefore listed
 * first so the caller can prefer the most specific match it can satisfy.
 */
function queryTokens(query: string): string[] {
  return [...new Set(searchable(query).split(' ').filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .slice(0, 40);
}

/**
 * Ids matching a query, ranked by how much of the query they cover.
 *
 * Two wrong answers came before this one, and both are kept in the record because
 * the same mistake is easy to make twice:
 *
 *   - Joining every token with OR accepted a single shared fragment. Measured on a
 *     real library, "已重启" matched 22 entries and "导出数据" matched 48, most of
 *     them unrelated, and those entries were then injected into the conversation.
 *   - Requiring every token (AND) is worse, because CJK bigrams *overlap*:
 *     "修复核心自动启动" yields 修复/复核/核心/心自/自动/动启/启动, and no document
 *     contains all seven. Long queries matched nothing at all.
 *
 * Coverage is therefore measured, not required — and it is measured by asking
 * FTS5, one query per fragment. Counting matches against the stored text directly
 * does not work: the index holds the tokenizer's output, not the original string,
 * so a check like `text.includes(fragment)` scores every row zero and silently
 * empties the result set.
 *
 * A third case was investigated and deliberately not "fixed": conversational
 * filler ("继续", "好的") still matches. Filtering by how common a fragment is was
 * tried and reverted, because the measurement says it cannot work here — on a real
 * library "短剧" occurs in 27.8% of documents and "这个" in 29.6%, so a frequency
 * threshold that removes the filler also removes the domain vocabulary. Silently
 * dropping a user's core subject is worse than returning a loose match, and the
 * coverage ranking above already puts the best candidates first. Left as a known
 * limitation rather than a guess dressed up as a fix.
 */
/**
 * One match, with the reason it matched.
 *
 * The reason is carried out of the matcher rather than recomputed by callers: the
 * design requires every retrieved item to be able to say *why it was retrieved*, and
 * a second implementation of that answer would eventually disagree with the one
 * that actually selected the row.
 */
interface Match { id: string; coverage: number; matched: string[] }

// These are linguistic/action words, not domain terms. Removing them only for
// automatic recall prevents a shared procedure template from becoming a topic.
// Explicit full-text search deliberately retains every query token.
const recallStopWords = new Set(['实现', '功能', '主动', '调用', '参考', '使用', '需要', '执行', '任务', '验收',
  '进行', '完成', '工作', '现在', '已经', '继续', '确认', '这些', '这个', '怎么', '如何', '是否',
  '可以', '帮我', '我们', '一下', '之后', '之前', '所有', '相关', '处理', '检查']);

function automaticRelevance(content: Knowledge, query: string): { score: number; matched: string[]; coverage: number } {
  if (query.trim().replace(/@\d+$/, '') === content.id) return { score: 100, matched: [content.id], coverage: 1 };
  // Strip whole filler phrases before bigram tokenization; filtering afterwards
  // leaves artificial cross-boundary fragments (检查功能 -> 查功).
  // Only the parts of a request that ask for something are searchable.
  //
  // The index and the retrieval service already make this decision (`positiveRetrievalClauses`),
  // but this matcher took the whole string: "不要查询 Docker Compose，解释量子自旋" kept
  // "Docker Compose" as a topic and returned the compose entries it had just been told to skip,
  // and "这次不做 PostgreSQL 备份，只讨论花卉浇水" returned the backup entry. The blind fixture
  // scored that as five of seven should-have-abstained cases answering anyway. Reusing the same
  // clause splitter keeps one definition of "what is this request asking for" rather than two
  // that drift apart.
  const clauses = positiveRetrievalClauses(query);
  if (!clauses.length) return { score: 0, matched: [], coverage: 0 };
  const substantive = clauses.join(' ').toLowerCase().replace(new RegExp([...recallStopWords].join('|'), 'gu'), ' ');
  const tokens = queryTokens(substantive);
  if (!tokens.length) return { score: 0, matched: [], coverage: 0 };
  const description = content.kind === 'skill' ? /^description:\s*(.+)$/m.exec(content.body)?.[1] ?? '' : '';
  const primary = `${content.title} ${description} ${content.kind === 'workflow' ? `${content.overview} ${content.triggers.join(' ')}` : ''}`.toLowerCase();
  const body = 'body' in content ? content.body : content.kind === 'journal' ? `${content.did}\n${content.problems}` : '';
  const match = (text: string) => tokens.filter(token => text.includes(token));
  const weight = (token: string) => /^[a-z0-9_-]{3,}$/.test(token) ? 2 : 1;
  const total = tokens.reduce((sum, token) => sum + weight(token), 0);
  const coverage = (hits: string[]) => hits.reduce((sum, token) => sum + weight(token), 0) / total;
  const primaryHits = match(primary);
  const primaryCoverage = coverage(primaryHits);
  // A single broad word in a long request is not a reliable topic. A named
  // technology or several advertised-purpose fragments is stronger evidence.
  const primaryAccepted = primaryCoverage >= 0.25 && (primaryHits.length >= 2
    || primaryHits.some(token => /^[a-z0-9_-]{3,}$/.test(token)) || primaryCoverage >= 0.3);
  let bestHits: string[] = [];
  // Skills advertise their applicability in title/description. Their references
  // remain explicitly searchable, but do not broaden automatic applicability.
  if (content.kind !== 'skill') {
    // A whole daily log can match every query word in unrelated entries. Demand
    // local co-occurrence, keeping fixed windows even when a source has no lines.
    for (const paragraph of body.toLowerCase().split(/\n|[。！？]/u)) {
      for (let offset = 0; offset < paragraph.length; offset += 240) {
        const hits = match(paragraph.slice(offset, offset + 480));
        if (coverage(hits) > coverage(bestHits)) bestHits = hits;
      }
    }
  }
  const bodyCoverage = coverage(bestHits);
  const broadShortQuery = tokens.every(token => /\p{Script=Han}/u.test(token))
    && substantive.replace(/\s/g, '').length <= 3;
  const bodyAccepted = !(broadShortQuery && body.length > 1000) && bodyCoverage >= 0.5 && (bestHits.length >= 2
    || bestHits.some(token => /^[a-z0-9_-]{4,}$/.test(token)) || (tokens.length === 1 && body.length <= 1000));
  if (!primaryAccepted && !bodyAccepted) return { score: 0, matched: [], coverage: 0 };
  const hits = [...new Set([...primaryHits, ...bestHits])];
  return { score: (primaryAccepted ? 3 * primaryCoverage : 0) + (bodyAccepted ? bodyCoverage : 0),
    matched: hits, coverage: coverage(hits) };
}

function matchAll(db: DatabaseSync, tokens: string[], floor = 0.5): Match[] {
  if (!tokens.length) return [];
  const hitsFor = (token: string): Set<string> => {
    try {
      return new Set(db.prepare('SELECT id FROM workflow_search WHERE workflow_search MATCH ?')
        .all(`"${token}"`).map(row => String((row as { id: string }).id)));
    } catch { return new Set(); }
  };

  const perToken = tokens.map(hitsFor);
  // Rows that match at least one fragment, in the order the widest query returned
  // them. bm25 already orders that by relevance, which breaks coverage ties.
  const ranked = db.prepare('SELECT id FROM workflow_search WHERE workflow_search MATCH ? ORDER BY bm25(workflow_search)')
    .all(tokens.map(token => `"${token}"`).join(' OR ')).map(row => String((row as { id: string }).id));

  const matchedFor = (id: string) => tokens.filter((_token, index) => perToken[index]!.has(id));

  // A single fragment carries no coverage signal: whether it appears is the only
  // question, its commonness has already been judged, and bm25 ordered the answer.
  if (tokens.length === 1) return ranked.map(id => ({ id, coverage: 1, matched: matchedFor(id) }));

  const covered = new Map<string, number>();
  for (const id of ranked) {
    let count = 0;
    for (const hits of perToken) if (hits.has(id)) count += 1;
    covered.set(id, count / tokens.length);
  }
  /**
   * The floor is relative to the best row, with no absolute minimum.
   *
   * An absolute floor of one half was tried and removed: a query of several
   * fragments where only one is real — "导出设备", where "设备" appears in nothing —
   * scored the correct entry at one third and discarded it. The user asked about
   * exporting, and got silence because they added a word the library does not know.
   * Anchoring to the best row instead means the strongest available matches come
   * back and the weaker ones are pruned relative to them, which is what ranking is
   * for. The single genuine risk — a common fragment matching widely — is
   * constrained by `limit`, and by the fact that coverage ordering puts rows
   * matching more of the query first.
   */
  const best = Math.max(...covered.values());
  const threshold = best * floor;
  return ranked.filter(id => (covered.get(id) ?? 0) >= threshold)
    .sort((a, b) => (covered.get(b) ?? 0) - (covered.get(a) ?? 0))
    .map(id => ({ id, coverage: covered.get(id) ?? 0, matched: matchedFor(id) }));
}

/** Just the ids, for callers that do not report a reason. */
function matchIds(db: DatabaseSync, tokens: string[], floor = 0.5): string[] {
  return matchAll(db, tokens, floor).map(match => match.id);
}

/**
 * The identity that makes repeated failures one fact instead of many.
 *
 * The adapter stores one candidate per failed tool call, and its idempotency key
 * includes the session id, so the same error recurring in a new session is a *new*
 * row by construction. The measured result was 98 auto-captured rows in three days
 * in which 43 signatures accounted for all of them — `edit::replacefilew eio` twelve
 * times, `pwsh::exit_code=1` fourteen times — with nothing in the queue able to tell
 * "the same failure seen twice" from "two things that happened".
 *
 * This is that missing identity, derived from the stored text alone: the tool name
 * plus the observation with the volatile parts (session id, absolute paths, uuids,
 * long hex, numbers of three digits or more) replaced by placeholders. Two rows share
 * a signature only when a reader would call them the same failure.
 *
 * Null means "not an auto-captured failure" — a human submission, which is never
 * aggregated. The marker and the field layout are read from the text rather than from
 * a new column so the rows already in a library are covered without a migration, and
 * so a payload whose shape changes degrades to "not aggregated" rather than to a
 * wrong merge.
 */
export interface FailureSignature {
  /** `tool::normalised observation`, the grouping key. */
  signature: string;
  /** The tool as the adapter recorded it. */
  tool: string;
  /** The observation text before normalisation, for display. */
  observation: string;
  /** The adapter's own statement that the host gave it no usable error body. */
  insufficient: boolean;
}

export function autoFailureSignature(discovery: string): FailureSignature | null {
  if (typeof discovery !== 'string' || !discovery.includes('【自动捕获的失败事实')) return null;
  const tool = /工具：([^。\n]+)/.exec(discovery)?.[1]?.trim() ?? '';
  const observation = /观察：([\s\S]*?)(?:\n信息不足：|\n根因与修复：|$)/.exec(discovery)?.[1]?.trim() ?? '';
  const normalised = observation
    // The session id is the field that made these rows distinct in the first place,
    // so it is the first thing removed: `会话 3f8c...` and `会话 91ab...` are the same
    // failure, not two.
    .replace(/会话\s+\S+/g, '«session»')
    .replace(/[A-Za-z]:\\[^\s"'`]+/g, '«path»')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '«id»')
    .replace(/\b[0-9a-f]{16,}\b/gi, '«hash»')
    // Bare numbers are kept below three digits so `exit_code=1` stays itself while a
    // byte offset, a port and a length all collapse to the same placeholder.
    .replace(/\d{3,}/g, '«n»')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return {
    signature: `${tool.toLowerCase()}::${normalised.slice(0, 200)}`,
    tool,
    observation,
    insufficient: discovery.includes('信息不足：'),
  };
}

/**
 * Where a stored candidate says it belongs, and whether the library could confirm it.
 *
 * One function, because two read paths used to answer this differently: a row written
 * with no `attribution` object was reported as `resolved: true` by `listProposals`
 * and as `resolved: false` by `getProposal`. Both readings are wrong in the same way
 * — the record says nothing, so neither "located" nor "known unlocatable" is a fact
 * about it. The queue then ranked that candidate as though a person had placed it in
 * a flow, and the detail page said the opposite about the same row.
 *
 * Three cases, kept apart because they need different sentences:
 *
 *  - the record carries a verdict: reported verbatim, and `described` is true;
 *  - the record carries a workflow id but no verdict: the claim is kept, the verdict
 *    is false, and the reviewer is told the id was not found;
 *  - the record carries nothing: false, with no claim to report.
 *
 * `resolved` is false in the last two cases and never invented as true. Nothing here
 * refuses, filters or downgrades a candidate: attribution is what the queue *shows*,
 * not a gate a candidate has to pass. A library with no workflows yet (the state this
 * was found in: 349 of 349 queued candidates unattributed, 0 workflow entries) must
 * still review and adopt everything that is queued.
 */
export function resolveAttribution(
  payload: Record<string, unknown> | null | undefined,
): { workflowId: string | null; stageId: string | null; resolved: boolean; described: boolean; reason: string | null } {
  const recorded = payload?.['attribution'];
  if (recorded && typeof recorded === 'object') {
    const verdict = recorded as { workflowId?: unknown; stageId?: unknown; resolved?: unknown };
    const workflowId = typeof verdict.workflowId === 'string' ? verdict.workflowId : null;
    const stageId = typeof verdict.stageId === 'string' ? verdict.stageId : null;
    const resolved = verdict.resolved === true;
    return {
      workflowId, stageId, resolved, described: true,
      reason: resolved ? null : workflowId
        ? `候选声明的流程 ${workflowId} 不存在或不可见，未归属，采纳不依赖它`
        : '候选未标注归属流程，未归属，采纳不依赖它',
    };
  }
  const workflowId = typeof payload?.['workflowId'] === 'string' ? payload['workflowId'] as string : null;
  return {
    workflowId, stageId: null, resolved: false, described: false,
    reason: workflowId
      ? `候选声明的流程 ${workflowId} 不存在或不可见，未归属，采纳不依赖它`
      : '候选未标注归属流程，未归属，采纳不依赖它',
  };
}

/**
 * The three fields the review surfaces have always returned, unchanged.
 *
 * `attribution` is a shape other code already asserts against field-for-field, and its
 * callers predate the two additions below. So this returns exactly what `resolved`,
 * `stageId` and `workflowId` were, and the explanation travels beside it rather than
 * inside it — an added field in a pinned object is a behaviour change for every
 * consumer, which is not what "the candidate is unattributed" should cost.
 */
export function attributionFields(
  payload: Record<string, unknown> | null | undefined,
): { workflowId: string | null; stageId: string | null; resolved: boolean } {
  const { workflowId, stageId, resolved } = resolveAttribution(payload);
  return { workflowId, stageId, resolved };
}

/** How loudly a candidate asks for a reviewer's first minutes. */
export type QueueBand = 'critical' | 'high' | 'normal' | 'low';

export interface PriorityVerdict {
  band: QueueBand;
  /** Band weight plus the smaller signals; only ever compared within one project. */
  score: number;
  /** Why this band, in the reviewer's language, one sentence per signal. */
  reasons: string[];
}

/**
 * Order the queued candidates by what a person should look at first.
 *
 * The queue is 300 rows deep and four days old, so the only useful question the list
 * can answer is "which few are worth my time". Four signals are available and none is
 * sufficient alone, so they are combined into one band with the reasons kept beside it
 * — a rank a reviewer cannot argue with is a rank they will not trust.
 *
 * Auto-captured failures rank last even when they carry `important: true`. That flag
 * is set by the submission path's own regex, and its effect on these rows was measured:
 * all 14 such rows were flagged because their text contains `ReplaceFileW` or similar
 * words the rule reads as "conflict/supersede", not because anyone decided anything.
 * Letting that decide the order would put machine noise at the top of a human queue.
 */
export function proposalPriority(input: {
  important: boolean; relation: string; needsSplit: boolean; confidence: number;
  hasEvidence: boolean; attributed: boolean; autoFailure: boolean;
}): PriorityVerdict {
  const band: QueueBand = input.autoFailure
    ? 'low'
    : input.important
      ? 'critical'
      : ['conflict', 'supersede'].includes(input.relation) || input.needsSplit
        ? 'high'
        : 'normal';
  const reasons: string[] = [];
  if (input.autoFailure) {
    reasons.push('自动捕获的工具失败事实：无人工证据、未归属流程');
    if (input.important) reasons.push('它的 important 标记来自失败文本里的 replace/重要 等词，不是人工裁决');
  } else if (input.important) reasons.push('提交时被判定为需人工裁决的冲突，等待期内不会自动过期');
  else if (input.needsSplit) reasons.push('正文混写了多种知识类型，需要拆分后再采纳');
  else if (['conflict', 'supersede'].includes(input.relation)) reasons.push(`与已有知识的关系是 ${input.relation}，采纳前要核对冲突`);
  else if (input.hasEvidence) reasons.push('提交者附带了可核对证据');
  else if (input.attributed) reasons.push('候选已归属到具体流程与步骤');
  // The last line used to read "未附证据" and left the missing attribution to be
  // inferred; a reviewer reading the queue could not tell whether a candidate had no
  // flow because none was named or because the named one was not found. Both are
  // adopted the same way, so naming which one it is changes the work a person does,
  // not whether the candidate moves.
  else reasons.push('人工提交的可复用经验，未附证据；未归属流程，采纳不依赖它');
  const weight: Record<QueueBand, number> = { critical: 4000, high: 3000, normal: 2000, low: 1000 };
  const score = weight[band] + Math.round(Math.max(0, Math.min(1, input.confidence)) * 100)
    + (input.hasEvidence ? 50 : 0) + (input.attributed ? 30 : 0);
  return { band, score, reasons };
}

/** Single SQLite authority for the P0 fixture; not a semantic auto-promotion engine. */
export class Store {
  readonly db: DatabaseSync;
  readonly jobs: DurableJobs;
  constructor(readonly path: string, private readonly now: () => number = Date.now) {
    this.db = new DatabaseSync(path);
    this.jobs = new DurableJobs(this.db, this.now);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT OR IGNORE INTO meta VALUES ('revision',0);
      CREATE TABLE IF NOT EXISTS knowledge(id TEXT PRIMARY KEY, kind TEXT NOT NULL,
        head INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','retired')));
      CREATE TABLE IF NOT EXISTS revisions(id TEXT NOT NULL, revision INTEGER NOT NULL,
        content TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(id,revision),
        FOREIGN KEY(id) REFERENCES knowledge(id));
      CREATE VIRTUAL TABLE IF NOT EXISTS workflow_search USING fts5(id UNINDEXED, terms);
      CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY, principal TEXT NOT NULL,
        idem TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL,
        state TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        -- The owning project is its own column rather than being read out of the
        -- payload. The payload is cleared when a rejected proposal's retention
        -- lapses, and a scope filter that depended on it made the record vanish from
        -- its own project exactly when the design says it should remain readable as
        -- a record of what was proposed.
        project_id TEXT NOT NULL DEFAULT '',
        UNIQUE(principal,idem));
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, principal TEXT NOT NULL,
        event_id TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, UNIQUE(principal,event_id));
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
        title TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('in_progress','paused','completed','cancelled','failed')),
        summary TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
        knowledge_revision INTEGER NOT NULL, unfinished TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        -- Added when the task record grew to the design's field list. Declared here
        -- so a fresh database has them, and added by migration below so an existing
        -- one does too: a column that only exists on new installs is a bug that
        -- surfaces months later on the one machine that matters.
        session_ids TEXT NOT NULL DEFAULT '[]',
        related_experiences TEXT NOT NULL DEFAULT '[]',
        related_proposals TEXT NOT NULL DEFAULT '[]',
        files TEXT NOT NULL DEFAULT '[]',
        verified TEXT NOT NULL DEFAULT '',
        -- How well the verified text is supported. Stored beside the claim so the
        -- diary can tell a caller's assertion from something the plugin observed;
        -- see generateJournal for why a non-empty string is not evidence by itself.
        evidence TEXT NOT NULL DEFAULT 'self-reported',
        -- The observed digest/size of each file this task touched, so a receiving
        -- end in another checkout can compare against its own copy (acceptance 16).
        -- A path alone cannot answer "has this file changed since", which is why
        -- the files list alone could not support the difference display the design
        -- asks for (acceptance 16).
        file_states TEXT NOT NULL DEFAULT '[]',
        started_at INTEGER);
      CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id, updated_at DESC);
      -- Adoption ledger: records exactly which knowledge entries a discovery run
      -- promoted, so one undo can retract precisely that batch and nothing else.
      -- It never references host files; revoking touches only this database.
      CREATE TABLE IF NOT EXISTS adoptions(id TEXT PRIMARY KEY, source_path TEXT NOT NULL,
        kind TEXT NOT NULL, title TEXT NOT NULL, content_hash TEXT NOT NULL,
        knowledge_id TEXT NOT NULL, revision INTEGER NOT NULL, adopted_at INTEGER NOT NULL,
        revoked_at INTEGER);
      CREATE INDEX IF NOT EXISTS adoptions_batch ON adoptions(adopted_at DESC);
      -- Supersession ledger: why a later record replaced or supplemented an
      -- earlier one. Revisions themselves are immutable, so a superseded body is
      -- never destroyed; this table is what makes the chain auditable.
      CREATE TABLE IF NOT EXISTS supersessions(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        old_knowledge_id TEXT NOT NULL, old_revision INTEGER NOT NULL,
        new_knowledge_id TEXT NOT NULL, new_revision INTEGER NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('supersede','supplement')),
        reason TEXT NOT NULL, evidence TEXT NOT NULL,
        origin TEXT NOT NULL CHECK(origin IN ('rescan','agent','user')),
        replaced_local_edit INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS supersessions_new ON supersessions(new_knowledge_id);
      CREATE INDEX IF NOT EXISTS supersessions_old ON supersessions(old_knowledge_id);
      -- A cleanup that has not succeeded yet. The design requires the persistent
      -- purge to be retryable and to leave a queryable record of failure; a pass
      -- that threw its error away would be indistinguishable from one with nothing
      -- to do, and a lapsed body would sit in the revisions table forever.
      CREATE TABLE IF NOT EXISTS material_purge_failures(
        id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL,
        message TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 1,
        failed_at INTEGER NOT NULL);
      -- Outbound work that has not been delivered yet: a candidate submission or an
      -- event capture that failed when it was produced. The design (§6.4) requires
      -- such work to be persistent and recoverable, so it lives here rather than in
      -- adapter memory, and the complete request body is stored verbatim so a replay
      -- is the *same* request — which is what lets the existing idempotency keys
      -- recognise a retry that actually landed instead of writing it twice.
      --
      -- The status column distinguishes waiting from finished: a row is never
      -- deleted on delivery, and a lapsed row is marked 'abandoned' rather than
      -- removed, so "we gave up on this" stays visible instead of quietly becoming
      -- nothing.
      CREATE TABLE IF NOT EXISTS outbox(
        id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('candidate','event')),
        idem TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL,
        project_id TEXT NOT NULL, principal TEXT NOT NULL,
        created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL, last_error TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK(status IN ('pending','sent','failed','abandoned')),
        expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(principal,idem));
      CREATE INDEX IF NOT EXISTS outbox_ready ON outbox(project_id,status,next_attempt_at);
      -- Rescan bookkeeping so adapters can decide whether a scan is due.
      INSERT OR IGNORE INTO meta VALUES ('lastRescanAt',0);
      INSERT OR IGNORE INTO meta VALUES ('rescanIntervalMs',86400000);
      INSERT OR IGNORE INTO meta VALUES ('scanRoots','');
    `);
    this.migrate();
    this.cleanup();
  }
  /**
   * Bring an existing database up to the current column set.
   *
   * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so a
   * column added after the first release reaches new installs only. Reading the
   * table's actual columns and adding what is missing is what keeps an existing
   * library working — the alternative is a migration that silently applies to
   * everyone except the users who already had data.
   *
   * Additive only: a column is never dropped or rewritten here, because the data in
   * it is the user's and this code cannot know what a later version expects.
   */
  private migrate(): void {
    const additions: Array<[string, string]> = [
      ['tasks', 'session_ids TEXT NOT NULL DEFAULT \'[]\''],
      ['tasks', 'related_experiences TEXT NOT NULL DEFAULT \'[]\''],
      ['tasks', 'related_proposals TEXT NOT NULL DEFAULT \'[]\''],
      ['tasks', 'files TEXT NOT NULL DEFAULT \'[]\''],
      ['tasks', 'verified TEXT NOT NULL DEFAULT \'\''],
      ['tasks', 'evidence TEXT NOT NULL DEFAULT \'self-reported\''],
      ['tasks', 'file_states TEXT NOT NULL DEFAULT \'[]\''],
      ['tasks', 'started_at INTEGER'],
      ['proposals', 'project_id TEXT NOT NULL DEFAULT \'\''],
    ];
    for (const [table, definition] of additions) {
      const column = definition.split(' ')[0]!;
      const existing = this.db.prepare(`PRAGMA table_info(${table})`).all().map(row => String((row as { name: string }).name));
      if (existing.includes(column)) continue;
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    }
    // Backfill from the payload for rows written before the column existed. A row
    // whose payload was already cleared cannot be attributed and is left empty
    // rather than guessed at; it stays reachable by id.
    this.db.exec(`UPDATE proposals SET project_id = COALESCE(json_extract(payload, '$.projectId'), '')
      WHERE project_id = '' AND payload <> '{}'`);
    // Backfill the full-text index for anything active that has no row in it.
    //
    // Norms used to be excluded from that index, so every rule written before the
    // change has no row and stays unsearchable until something rewrites it - which
    // for a rule may be never. This is a no-op on a library that is already
    // consistent, so it needs no version flag to stay correct: read what the index
    // covers, index the difference. The id set is read once rather than joined
    // against the FTS virtual table, whose join behaviour is not worth depending on.
    const indexed = new Set(this.db.prepare('SELECT id FROM workflow_search').all()
      .map(row => String((row as { id: string }).id)));
    const heads = this.db.prepare(`SELECT k.id AS id, r.content AS content FROM knowledge k
      JOIN revisions r ON r.id = k.id AND r.revision = k.head
      WHERE k.status = 'active'`).all();
    for (const row of heads) {
      const id = String((row as { id: string }).id);
      if (indexed.has(id)) continue;
      this.db.prepare('INSERT INTO workflow_search VALUES(?,?)')
        .run(id, searchable(String((row as { content: string }).content)));
    }
  }
  close() { this.db.close(); }
  get revision(): number { return Number(this.db.prepare("SELECT value FROM meta WHERE key='revision'").get()!.value); }
  private transactionDepth = 0;
  private transaction<T>(body: () => T): T {
    const depth = this.transactionDepth++;
    const name = `amb_nested_${depth}`;
    try {
      this.db.exec(depth ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE');
      try {
        const result = body();
        this.db.exec(depth ? `RELEASE SAVEPOINT ${name}` : 'COMMIT');
        return result;
      } catch (error) {
        this.db.exec(depth ? `ROLLBACK TO SAVEPOINT ${name}` : 'ROLLBACK');
        if (depth) this.db.exec(`RELEASE SAVEPOINT ${name}`);
        throw error;
      }
    } finally { this.transactionDepth--; }
  }
  private head(id: string): Entry | undefined {
    const row = this.db.prepare(`SELECT k.id,k.head,k.status,r.content FROM knowledge k
      JOIN revisions r ON k.id=r.id AND k.head=r.revision WHERE k.id=?`).get(id);
    return row && this.decode(row);
  }
  private decode(row: Row): Entry {
    return { id: String(row.id), revision: Number(row.head), status: String(row.status), content: knowledgeSchema.parse(JSON.parse(String(row.content))) };
  }
  private current(): Entry[] {
    // Ordered by id so the same library always yields the same sequence. Without
    // it, SQLite returns rows in whatever order the plan produces, which made any
    // caller that takes the first N pick an arbitrary subset — adopted skills
    // appeared in the injected context in a different order run to run, and the
    // entries that happened to come first varied with the build of SQLite.
    return this.db.prepare(`SELECT k.id,k.head,k.status,r.content FROM knowledge k
      JOIN revisions r ON k.id=r.id AND k.head=r.revision WHERE k.status='active'
      ORDER BY k.id`).all().map(row => this.decode(row));
  }
  /**
   * Active entries of one kind.
   *
   * `current()` parses every active entry, and for the gate path that dominated the
   * call: with 5,000 entries, 98.8% of the time went into decoding entries the
   * caller then discarded, because a gate call only ever reads norms. The `kind`
   * column is already indexed by the same table, so asking the database for the one
   * kind needed is a strict improvement with no change in semantics — the same rows
   * are returned, only fewer of them are parsed.
   *
   * The `ORDER BY id` is kept for the same reason as in `current()`: a stable order
   * means the same library always yields the same sequence, which matters to callers
   * that take the first N.
   */
  private currentOfKind(kinds: string[]): Entry[] {
    if (kinds.length === 0) return [];
    const placeholders = kinds.map(() => '?').join(',');
    return this.db.prepare(`SELECT k.id,k.head,k.status,r.content FROM knowledge k
      JOIN revisions r ON k.id=r.id AND k.head=r.revision
      WHERE k.status='active' AND k.kind IN (${placeholders})
      ORDER BY k.id`).all(...kinds).map(row => this.decode(row));
  }
  /**
   * Read one entry by id regardless of status, then refuse it unless the caller's
   * scope may see it.
   *
   * Every review and lifecycle method that takes an object id goes through here:
   * nothing about the HTTP layer's envelope check looks at the *object* named in
   * the body, so a credential for one project could otherwise approve, reject,
   * retire or read another project's entry simply by naming its id. A global entry
   * is visible to every project, which is the one deliberate exception.
   */
  private requireVisible(id: string, projectId: string): Entry {
    const entry = this.head(id) ?? this.decodeAny(id);
    if (!entry) throw new DomainError('not_found', `Knowledge entry ${id} is unavailable`, 404);
    const scope = entry.content.scope;
    if (scope.kind !== 'global' && scope.projectId !== projectId) {
      throw new DomainError('not_found', `Knowledge entry ${id} is unavailable`, 404);
    }
    return entry;
  }
  /** Admin-only offline import. Every update requires the observed per-item revision. */
  import(entries: KnowledgeDraft[]): number {
    return this.importWithReport(entries).knowledgeRevision;
  }
  /**
   * Import entries and report what became of each, rather than only that it worked.
   *
   * `import()` alone answered with a revision, which read as "everything arrived".
   * For temporary material that can be false the moment it lands: the schema's own
   * `expiresAt` default is 0, which means *already lapsed*, so an entry written by
   * the offline seed path — which parses a document directly and never passes
   * through `materialEntry` — was stored expired, purged by the next `cleanup()`,
   * and still reported as an import success. The user was told a runbook had been
   * imported and could never read it.
   *
   * Two things are therefore done at this boundary, which is the only place that
   * can tell "the caller stated no lifetime" from "the caller asked for none":
   *
   *   - A material entry that states no `expiresAt` (or a non-positive one) gets the
   *     design's own retention (§8: 90 days, `MATERIAL_TTL_DAYS`) computed from its
   *     `savedAt`. This matches what `saveMaterial` already produces, so the two
   *     write paths stop disagreeing about the same kind of entry.
   *   - Any entry that is nonetheless not readable after the write — an explicit
   *     past expiry, however it got there — is named in `result.unusable`. Only
   *     material can be born expired, so it is the only kind checked.
   *
   * An explicit future expiry is left exactly as the caller wrote it: expiry is
   * stored rather than computed so a later retention change cannot retroactively
   * move an entry that was saved under an older policy.
   */
  importWithReport(entries: KnowledgeDraft[]): {
    knowledgeRevision: number;
    imported: number;
    /**
     * Entries written but not readable afterwards, each with the reason. Named
     * rather than counted so the caller can act on the specific one — the seed
     * path prints these, which is what makes "imported but already expired"
     * visible instead of a silent success.
     */
    unusable: Array<{ id: string; kind: Knowledge['kind']; reason: string }>;
  } {
    const now = this.now();
    const validated = entries.map(entry => this.withImportDefaults(entry, now));
    if (new Set(validated.map(x => x.id)).size !== validated.length)
      throw new DomainError('duplicate_id', 'Import contains duplicate IDs');
    const knowledgeRevision = this.transaction(() => this.importInsideTransaction(validated));
    const unusable = validated
      .filter((entry): entry is Extract<Knowledge, { kind: 'material' }> =>
        entry.kind === 'material' && !isLive(entry.expiresAt, now))
      .map(entry => ({
        id: entry.id, kind: entry.kind as Knowledge['kind'],
        reason: entry.expiresAt <= 0
          ? '未声明有效期，且有效期解析为 0（即已过期），导入后不可读'
          : `已过期（expiresAt=${entry.expiresAt}，早于当前时间 ${now}），导入后不可读`,
      }));
    return { knowledgeRevision, imported: validated.length, unusable };
  }
  /**
   * Apply the defaults an import boundary owes an entry, before validation.
   *
   * Kept separate from `materialEntry` because that helper *builds* a new entry
   * while this one *repairs* a parsed document, and folding them together would
   * force the build path to re-validate text it just composed.
   */
  private withImportDefaults(entry: KnowledgeDraft, now: number): Knowledge {
    const parsed = knowledgeSchema.parse(entry) as Knowledge;
    if (parsed.kind !== 'material') return parsed;
    if (parsed.expiresAt > 0) return parsed;
    // `savedAt` is 0 when the caller stated none, which would put the expiry in
    // 1970 and leave the entry expired anyway; the write time is the honest basis
    // for an entry whose own date is unknown.
    const savedAt = parsed.savedAt > 0 ? parsed.savedAt : now;
    return { ...parsed, savedAt, expiresAt: expiryFrom(savedAt) };
  }
  /** Caller must already hold a transaction; shared with proposal approval. */
  private importInsideTransaction(validated: Knowledge[]): number {
    const next = new Map(this.current().map(x => [x.id, x]));
    for (const content of validated) {
      const previous = this.head(content.id);
      if ((previous?.revision ?? 0) !== content.baseRevision)
        throw new DomainError('revision_conflict', `Revision changed: ${content.id}`, 409);
      if (previous && previous.content.kind !== content.kind)
        throw new DomainError('kind_changed', 'Knowledge kind is immutable');
      next.set(content.id, { id: content.id, revision: content.baseRevision + 1, status: 'active', content });
    }
    // Only the newly written workflows must validate; changed children invalidate old parents on read.
    for (const content of validated) if (content.kind === 'workflow') this.validateDependencies(next.get(content.id)!, next, new Set());
    for (const content of validated) {
      const rev = content.baseRevision + 1;
      this.db.prepare(`INSERT INTO knowledge(id,kind,head,status) VALUES(?,?,?,'active')
        ON CONFLICT(id) DO UPDATE SET head=excluded.head,status='active'`).run(content.id, content.kind, rev);
      this.db.prepare('INSERT INTO revisions VALUES(?,?,?,?)').run(content.id, rev, JSON.stringify(content), this.now());
      this.db.prepare('DELETE FROM workflow_search WHERE id=?').run(content.id);
      // Workflows, skills and memories are all searchable. A workflow is indexed
      // whole; a skill is indexed together with its leaves so a search for a leaf
      // topic still finds the entry that owns it.
      //
      // Norms are indexed too. They used to be skipped here, which made the one kind
      // that states rules the only kind a search could never return: `searchUniversal`
      // promises "all knowledge kinds", and a rule the agent cannot find is a rule it
      // breaks silently. Injection still reads norms through `norms()`, so indexing
      // them adds reach without duplicating what gets injected.
      this.db.prepare('INSERT INTO workflow_search VALUES(?,?)').run(content.id, searchable(JSON.stringify(content)));
    }
    this.db.prepare("UPDATE meta SET value=value+1 WHERE key='revision'").run();
    this.jobs.enqueue('notify', `revision:${this.revision}`, { revision: this.revision });
    return this.revision;
  }
  private validateDependencies(entry: Entry, all: Map<string, Entry>, ancestors: Set<string>): void {
    if (ancestors.has(entry.id)) throw new DomainError('dependency_cycle', `Workflow dependency cycle at ${entry.id}`, 409);
    if (entry.content.kind !== 'workflow') throw new DomainError('not_workflow', 'A workflow dependency must target a workflow', 409);
    this.workflowSource(entry.content);
    const path = new Set(ancestors).add(entry.id);
    for (const stage of entry.content.stages) for (const dep of stage.dependencies) {
      if (dep.relationship === 'reference') continue;
      const child = all.get(dep.workflowId);
      if (!child || child.status !== 'active' || child.revision !== dep.revision)
        throw new DomainError('dependency_unavailable', `Required dependency ${dep.workflowId}@${dep.revision} is not current`, 409);
      const parentScope = entry.content.scope, childScope = child.content.scope;
      if (childScope.kind === 'project' && (parentScope.kind === 'global' || childScope.projectId !== parentScope.projectId))
        throw new DomainError('dependency_scope', 'Required workflow belongs to an incompatible scope', 409);
      this.validateDependencies(child, all, path);
    }
  }
  /** A derived procedure is pinned to its source, including all reference leaves. */
  private workflowSource(flow: Workflow) {
    if (!flow.derivedFrom) return undefined;
    const source = this.head(flow.derivedFrom.skillId);
    if (!source || source.content.kind !== 'skill' || source.revision !== flow.derivedFrom.skillRevision)
      throw new DomainError('source_changed', 'Source skill changed or is unavailable; review the derived workflow again', 409);
    const a = flow.scope, b = source.content.scope;
    if (b.kind !== 'global' && (a.kind === 'global' || a.projectId !== b.projectId
      || (b.kind === 'task' && (a.kind !== 'task' || a.taskId !== b.taskId))))
      throw new DomainError('dependency_scope', 'Source skill belongs to a narrower scope', 409);
    return { id: source.id, revision: source.revision, body: source.content.body,
      leaves: source.content.leaves.map(leaf => ({ ...leaf })) };
  }
  retire(id: string, baseRevision: number): void {
    this.transaction(() => {
      const result = this.db.prepare("UPDATE knowledge SET status='retired' WHERE id=? AND head=? AND status='active'").run(id, baseRevision);
      if (!result.changes) throw new DomainError('revision_conflict', 'Current knowledge revision not found', 409);
      this.db.prepare('DELETE FROM workflow_search WHERE id=?').run(id);
      this.db.prepare("UPDATE meta SET value=value+1 WHERE key='revision'").run();
    this.jobs.enqueue('notify', `revision:${this.revision}`, { revision: this.revision });
    });
  }
  norms(projectId: string, options?: { taskId?: string; platform?: 'dsh' | 'codex' }) {
    // Reads norms only. Going through `current()` here meant a gate call parsed the
    // whole active library — 98.8% of its cost at 5,000 entries — to then discard
    // everything that was not a norm. The TTL gate that `liveEntries()` applies is
    // irrelevant to norms (expiry is a property of material alone), so the narrowed
    // read is equivalent and returns exactly the same rows.
    return this.currentOfKind(['norm'])
      .filter(e => e.content.kind === 'norm' && applicable(e.content.scope, projectId, options?.taskId))
      // Platform applicability is a real dimension of a norm, not documentation:
      // a rule the user marked `codex-only` must not be injected into DSH, and an
      // empty list means both hosts.
      .filter(e => !options?.platform || e.content.platforms.length === 0
        || e.content.platforms.includes(options.platform))
      .map(e => ({ ...e.content, revision: e.revision }));
  }
  /**
   * Active entries visible to a project, in full Entry shape.
   *
   * `norms()` flattens an entry's content, which suits internal composition but
   * not callers that need the identity and status alongside it. This keeps the
   * scope filter while preserving the shape those callers already depend on.
   */
  scopedEntries(projectId: string) {
    return this.liveEntries().filter(e => applicable(e.content.scope, projectId));
  }
  search(projectId: string, query: string, limit = 8) {
    const entries = this.liveEntries(); const all = new Map(entries.map(x => [x.id, x]));
    const tokens = queryTokens(query);
    // With no query this lists every workflow. That is what a browsing caller
    // wants — the console's workflow panel shows the catalog before anything is
    // typed. Injection is a different question, and `prepare()` decides it: an
    // empty query there means there is no basis for selection, so nothing is
    // injected rather than an arbitrary slice.
    const matches = tokens.length ? matchAll(this.db, tokens) : [];
    const ids = tokens.length ? matches.map(match => match.id) : entries.map(e => e.id);
    const reasonFor = new Map(matches.map(match => [match.id, match]));
    return ids.map(id => all.get(id)).filter((e): e is Entry => !!e && e.content.kind === 'workflow' && applicable(e.content.scope, projectId)).slice(0, limit).map(e => {
      const c = e.content as Workflow;
      let ready = true, unavailable: string | undefined;
      try { this.validateDependencies(e, all, new Set()); } catch (error) { ready = false; unavailable = (error as Error).message; }
      return { id: e.id, revision: e.revision, title: c.title, overview: c.overview,
        preconditions: c.preconditions, stages: c.stages.map(s => ({ id: s.id, title: s.title, checks: s.checks })),
        completion: c.completion, recovery: c.recovery, categories: c.categories, ready, unavailable,
        // Same reason as `knowledge()`: an entry must be able to say why it appeared.
        why: reasonFor.has(e.id) ? { matched: reasonFor.get(e.id)!.matched, coverage: reasonFor.get(e.id)!.coverage } : null };
    });
  }
  expand(projectId: string, id: string, stageId: string) {
    const all = new Map(this.liveEntries().map(x => [x.id, x])); const entry = all.get(id);
    if (!entry || entry.content.kind !== 'workflow' || !applicable(entry.content.scope, projectId))
      throw new DomainError('not_found', 'Workflow is unavailable', 404);
    this.validateDependencies(entry, all, new Set());
    const stage = entry.content.stages.find(s => s.id === stageId);
    if (!stage) throw new DomainError('not_found', 'Stage is unavailable', 404);
    const expanded = new Set<string>();
    const resolve = (flow: Workflow): unknown[] => flow.stages.flatMap(s => s.dependencies.filter(d => d.relationship !== 'reference').flatMap(d => {
      if (expanded.has(d.workflowId)) return [];
      expanded.add(d.workflowId); const child = all.get(d.workflowId)!;
      return [{ id: child.id, revision: child.revision, workflow: child.content, source: this.workflowSource(child.content as Workflow) }, ...resolve(child.content as Workflow)];
    }));
    // Includes all required prerequisites of this stage and nested dependencies, never independent fragments.
    const stageFlow = { ...entry.content, stages: [stage] };
    return { workflowId: id, revision: entry.revision, title: entry.content.title, preconditions: entry.content.preconditions,
      stage, completion: entry.content.completion, recovery: entry.content.recovery, dependencies: resolve(stageFlow),
      source: this.workflowSource(entry.content), ready: true };
  }
  /**
   * Search adopted skills and memories.
   *
   * These are kept out of `search()` because they have no stages or dependency
   * graph: a skill is a stored procedure awaiting structure, and a memory is a
   * background fact. Returning them in the workflow shape would imply structure
   * that has not been verified. `needsStructure` is surfaced so the caller can
   * tell a converted skill from a raw adopted document.
   *
   * Only a bounded excerpt is returned; full text is fetched by `readKnowledge`.
   * Inlining whole documents inflated a real prepare context to 26k-53k
   * characters against a 2k-4k token budget, so retrieval returns entry points
   * and expansion is explicit.
   */
  knowledge(projectId: string, query: string, limit = 5, excerptChars = 400, relevanceFloor = 0.5) {
    const entries = this.liveEntries();
    const all = new Map(entries.map(x => [x.id, x]));
    const tokens = queryTokens(query);
    // With no query, list the catalog in a stable order — a browsing caller (the
    // console, or a user asking what is in the library) wants exactly that.
    //
    // Injection is decided elsewhere: `prepare()` skips this call entirely when
    // the query is empty, because an arbitrary slice of the library appearing in
    // every session is how an unrelated project opened with five media skills.
    const matches = tokens.length ? matchAll(this.db, tokens, relevanceFloor) : [];
    const ids = tokens.length ? matches.map(match => match.id) : entries.map(entry => entry.id);
    const reasonFor = new Map(matches.map(match => [match.id, match]));
    const result: Array<{
      id: string; revision: number; kind: 'skill' | 'memory' | 'preference' | 'journal';
      title: string; excerpt: string; chars: number; leafCount: number; needsStructure: boolean;
      /** Set for preferences, so a reader can tell a stated habit from an inferred one. */
      stated?: boolean;
      /** Set for journals, so success, failure and unverified stay distinguishable. */
      outcome?: 'success' | 'failure' | 'unverified';
      provenance: string;
      /** Why this entry was retrieved: which query fragments matched, and how much. */
      why: { matched: string[]; coverage: number } | null;
    }> = [];
    for (const id of ids) {
      const entry = all.get(id);
      if (!entry) continue;
      const content = entry.content;
      // Norms are read through `norms()` and workflows through `search()`, each
      // with its own shape. Temporary material is deliberately absent: it is only
      // valid until it expires, and its lifecycle is handled separately.
      //
      // Narrowed by kind rather than by an `includes` check, because only this form
      // tells the type system which fields exist — a journal has no `body`, it has
      // what the task did.
      if (content.kind !== 'skill' && content.kind !== 'memory'
        && content.kind !== 'preference' && content.kind !== 'journal') continue;
      if (!applicable(content.scope, projectId)) continue;
      const body = content.kind === 'journal' ? content.did : content.body;
      result.push({
        id: entry.id, revision: entry.revision, kind: content.kind, title: content.title,
        excerpt: body.length > excerptChars ? `${body.slice(0, excerptChars)}…` : body,
        chars: body.length,
        leafCount: content.kind === 'skill' ? content.leaves.length : 0,
        needsStructure: content.kind === 'skill' ? content.needsStructure : false,
        stated: content.kind === 'preference' ? content.stated : undefined,
        outcome: content.kind === 'journal' ? content.outcome : undefined,
        provenance: content.provenance,
        // The design requires each retrieved entry to be able to say why it was
        // retrieved. `null` when the caller asked for the catalog rather than
        // searched, which is an honest answer: nothing selected it.
        why: reasonFor.has(id) ? { matched: reasonFor.get(id)!.matched, coverage: reasonFor.get(id)!.coverage } : null,
      });
      if (result.length >= limit) break;
    }
    return result;
  }
  /** Automatic selection has absolute evidence thresholds; explicit search does not. */
  private automaticMatches(projectId: string, query: string) {
    return new Map(this.liveEntries().filter(entry => applicable(entry.content.scope, projectId))
      .map(entry => [entry.id, automaticRelevance(entry.content, query)] as const)
      .filter(([, reason]) => reason.score > 0));
  }
  autoRecall(projectId: string, query: string, kindFilter?: string, limit = 3) {
    if (!query.trim()) return [];
    const matches = this.automaticMatches(projectId, query);
    return this.searchUniversal(projectId, '', kindFilter, Number.MAX_SAFE_INTEGER)
      .filter(entry => matches.has(entry.id))
      .sort((a, b) => matches.get(b.id)!.score - matches.get(a.id)!.score)
      .slice(0, limit).map(entry => ({ ...entry, why: { id: entry.id, ...matches.get(entry.id)! } }));
  }
  /**
   * Universal search across all knowledge kinds: norm, preference, memory, skill, journal, workflow, material.
   * Allows manual filtering by kind and full-text keyword retrieval.
   */
  searchUniversal(projectId: string, query = '', kindFilter?: string, limit = 100) {
    const entries = this.liveEntries();
    const tokens = queryTokens(query);
    const matches = tokens.length ? matchAll(this.db, tokens, 0.3) : [];
    const reasonFor = new Map(matches.map(m => [m.id, m]));
    const matchedIds = new Set(matches.map(m => m.id));

    let candidates = entries.filter(e => applicable(e.content.scope, projectId));
    if (kindFilter && kindFilter !== 'all') {
      candidates = candidates.filter(e => e.content.kind === kindFilter);
    }

    if (tokens.length) {
      candidates = candidates.filter(e => {
        if (matchedIds.has(e.id)) return true;
        const text = `${e.id} ${e.content.title} ${'body' in e.content ? e.content.body : ''}`.toLowerCase();
        return tokens.some(t => text.includes(t.toLowerCase()));
      });
      candidates.sort((a, b) => {
        const scoreA = reasonFor.get(a.id)?.coverage ?? 0;
        const scoreB = reasonFor.get(b.id)?.coverage ?? 0;
        return scoreB - scoreA;
      });
    }

    return candidates.slice(0, limit).map(entry => {
      const c = entry.content as Record<string, unknown>;
      const body = typeof c.body === 'string' ? c.body : (typeof c.overview === 'string' ? c.overview : (typeof c.did === 'string' ? c.did : (typeof c.summary === 'string' ? c.summary : '')));
      return {
        id: entry.id,
        revision: entry.revision,
        // The lifecycle column, passed through unchanged. Callers that group or badge
        // entries need it next to the entry rather than a second lookup: the panel's
        // category view prints it on every row. It is the core's own `knowledge.status`
        // value, never inferred from anything else.
        status: entry.status,
        kind: entry.content.kind,
        title: entry.content.title,
        scope: entry.content.scope,
        provenance: entry.content.provenance,
        evidence: entry.content.evidence,
        excerpt: body.length > 300 ? `${body.slice(0, 300)}…` : body,
        chars: body.length,
        why: reasonFor.get(entry.id) ?? null,
      };
    });
  }

  /**
   * Resolve a caller-supplied knowledge id.
   *
   * Two shapes arrive here and both are legitimate:
   *
   *   - A bare id, which the console and the CLI use.
   *   - `id@revision`, which is *not* a convenience form but the only form the
   *     model ever sees. Every handle in the injected context is written that way
   *     (`规范 ${id}@${revision}`, `已采纳技能 ${id}@${revision}`), because the
   *     revision is what tells the reader which version it was shown. A model that
   *     reads such a handle and is asked to expand it copies the whole token — so
   *     an exact `candidate.id === id` match failed for every entry the summary
   *     itself had just advertised, which is why `get` (bare id, 200) and `read`
   *     (`id@rev`, 404) disagreed about the same entry.
   *
   * A named revision is treated as a *requirement*, not a hint: if it does not
   * match the current one the answer is 409 naming the current revision, never a
   * silent downgrade to the newest text (which would hand back content the caller
   * did not ask for) and never a 404 (which claims the entry does not exist when
   * it does, and is the misleading message this whole defect was made of).
   */
  private resolveKnowledgeId(id: string): { id: string; requestedRevision?: number } {
    const trimmed = id.trim();
    // `identifier` ids may contain `.`, `:`, `-` and `_`, so only a trailing
    // `@<digits>` is a revision. A non-numeric suffix stays part of the id, which
    // keeps ids that legitimately contain `@`-like text from being mis-split.
    const match = /^(.*)@(\d+)$/.exec(trimmed);
    if (!match) return { id: trimmed };
    return { id: match[1]!, requestedRevision: Number(match[2]) };
  }
  /**
   * Resolve an id, apply the scope rule, and honour a requested revision.
   *
   * Shared by `getKnowledge` and `readKnowledge` so the two can never disagree
   * about the same input — the acceptance criterion is literally that get and
   * read reach the same conclusion, and two copies of this logic would drift.
   *
   * `includeExpired` is the one deliberate difference between them: `get` is the
   * console's raw view of a record and may show material that has lapsed, while
   * `read` is a retrieval path and must apply the expiry gate. (`liveEntries()`
   * is where that gate lives; see its comment.)
   */
  private resolveVisible(id: string, projectId: string, options: { includeExpired?: boolean } = {}): Entry {
    const { id: bareId, requestedRevision } = this.resolveKnowledgeId(id);
    const entry = this.liveEntries().find(candidate => candidate.id === bareId);
    if (!entry || !applicable(entry.content.scope, projectId)) {
      throw new DomainError('not_found', `Knowledge entry ${bareId} is unavailable`, 404);
    }
    if (!options.includeExpired && entry.content.kind === 'material' && !isLive(entry.content.expiresAt, this.now())) {
      throw new DomainError('not_found', `Knowledge entry ${bareId} is unavailable`, 404);
    }
    if (requestedRevision !== undefined && requestedRevision !== entry.revision) {
      // 409, not 404: the entry exists and the caller named a real version of it,
      // so "not found" would be false. The current revision is stated so the
      // caller can retry with a handle that works instead of guessing.
      throw new DomainError('revision_conflict',
        `Knowledge entry ${bareId} is at revision ${entry.revision}, not ${requestedRevision}`, 409);
    }
    return entry;
  }
  /**
   * Get single raw knowledge entry by ID regardless of kind.
   *
   * Accepts the `id@revision` handle as well as a bare id, so a caller that
   * copied either form from the injected context reaches the same answer.
   */
  getKnowledge(projectId: string, id: string) {
    // Raw view: expired material stays visible here, as it did before, so the
    // console can still show what lapsed and when.
    return this.resolveVisible(id, projectId, { includeExpired: true });
  }

  /**
   * Expand one knowledge entry by ID.
   *
   * This is the on-demand step the prepare summary points at, so it must be able
   * to serve *every* kind that summary advertises. It previously accepted only
   * `skill` and `memory` and refused the rest with "Knowledge entry is
   * unavailable" — which was wrong twice over: the entry was neither missing nor
   * invisible, and the message sent the reader looking for a problem that did not
   * exist. `getKnowledge` served all kinds, so the two paths contradicted each
   * other about the same id.
   *
   * The reading shape is now chosen per kind rather than by refusing kinds: a
   * skill returns its body plus leaves, everything else returns its prose — a
   * journal's prose is what it *did*, because it has no `body` field — and the
   * kind-specific extras (`needsStructure`, `outcome`, `stated`, material's
   * `url`/`expiresAt`) travel alongside so a reader can tell what they are
   * holding. `relations` stays for every kind: it is the answer to "does a
   * companion entry exist", which is exactly as relevant for a norm as for a
   * skill.
   */
  readKnowledge(projectId: string, id: string, includeLeaves = false): {
    id: string; revision: number; kind: Knowledge['kind']; title: string; body: string;
    /** Present only for skills; a memory has no structure to await. */
    needsStructure?: boolean;
    /** Where a workflow's prose lives, since a workflow has no `body` field. */
    overview?: string;
    /** Material's own fields, so a reader knows the source and when it lapses. */
    url?: string; savedAt?: number; expiresAt?: number;
    /** Set for preferences and journals, so an inference is not read as a statement. */
    stated?: boolean; outcome?: 'success' | 'failure' | 'unverified';
    leaves: Array<{ path: string; body: string }>;
    /**
     * How this entry relates to others: what it replaced or supplemented, and what
     * replaced or supplemented it. Surfaced here because the relation was only
     * visible in the ledger, so a reader of a supplement could not tell that a
     * companion entry existed at all.
     */
    relations: Array<{ direction: 'replaced' | 'supplemented' | 'replaced-by' | 'supplemented-by'; id: string; revision: number; reason: string }>;
  } {
    // Retrieval path: the expiry gate applies, so lapsed material is not served.
    const entry = this.resolveVisible(id, projectId);
    const content = entry.content;
    const relations = this.supersessions(entry.id, projectId).map(link => ({
      direction: (link.oldKnowledgeId === entry.id
        ? (link.action === 'supersede' ? 'replaced' : 'supplemented')
        : (link.action === 'supersede' ? 'replaced-by' : 'supplemented-by')) as 'replaced' | 'supplemented' | 'replaced-by' | 'supplemented-by',
      id: link.oldKnowledgeId === entry.id ? link.newKnowledgeId : link.oldKnowledgeId,
      revision: link.oldKnowledgeId === entry.id ? link.newRevision : link.oldRevision,
      reason: link.reason,
    }));
    /**
     * `body` has to mean "the prose of this entry", and which field that is
     * depends on the kind: only a skill or memory carries `body` literally, while
     * a journal records `did`, a workflow `overview`, and a norm, preference or
     * material each carry `body` under a different schema. All of them are prose
     * a reader asked for; returning an empty string for half the library is the
     * failure that made "read supports every kind" true only on paper.
     */
    const proseOf = (entryContent: Knowledge): string => {
      switch (entryContent.kind) {
        case 'skill':
        case 'memory':
        case 'norm':
        case 'preference':
        case 'material': return entryContent.body;
        case 'journal': return entryContent.did;
        case 'workflow': return entryContent.overview;
      }
    };
    const base = {
      id: entry.id, revision: entry.revision, kind: content.kind, title: content.title,
      body: proseOf(content), relations,
    };
    switch (content.kind) {
      case 'skill':
        return {
          ...base,
          needsStructure: content.needsStructure,
          leaves: content.leaves.map(leaf => ({ path: leaf.path, body: includeLeaves ? leaf.body : '' })),
        };
      case 'material':
        // No leaves, so the "include" flag has nothing to expand; the expiry is
        // returned so a caller can see how long the entry has left rather than
        // inferring it from the retention default.
        return { ...base, url: content.url, savedAt: content.savedAt, expiresAt: content.expiresAt, leaves: [] };
      case 'preference':
        return { ...base, stated: content.stated, leaves: [] };
      case 'journal':
        return { ...base, outcome: content.outcome, leaves: [] };
      case 'workflow':
        return { ...base, overview: content.overview, leaves: [] };
      default:
        // norm and memory: both are plain prose with no extra dimension to report.
        return { ...base, leaves: [] };
    }
  }
  /**
   * Character budget for the norms injected into one context.
   *
   * A configured ceiling rather than a silent truncation: the design (§10, acceptance
   * 7) requires a budget with an explicit activation split and a visible report of
   * what was left out. Forty legitimate norms of ~12,000 characters produced a
   * 480,000-character prepare and the same again on every gate call, which is both a
   * context-budget failure and a duplicate-injection failure. Nothing here drops a
   * *prohibition*: the decision list is always returned whole, and only the prose
   * injected into the model is bounded.
   */
  readonly normBudgetChars: number = 12_000;
  /**
   * Split a norm set into what fits the budget and what does not.
   *
   * Shared by `prepare` and `gate` rather than written twice, because the two paths
   * must agree on the ceiling: the audit's F23 was a 480,000-character context that
   * the budget fixed for `prepare` while `gate` kept sending it whole. The second
   * call site was the one that fires before *every* tool call, so leaving it
   * unbudgeted kept most of the cost the fix was meant to remove.
   *
   * Two rules are load-bearing and must survive any change here:
   *
   *   - An entry that states a tool prohibition is always included, however large.
   *     A budget that hid a prohibition would silently weaken enforcement, which is
   *     the one thing the design says it must never do (§10).
   *   - An excluded entry is reported with its id, size and reason, never dropped:
   *     the design requires the over-budget state to be visible (acceptance 7).
   */
  private splitByBudget(norms: Array<{ id: string; revision: number; kind: string; body: string; deniedTools: string[] }>) {
    // Prohibitions first, so a large normative body can never crowd out a rule that
    // a gate actually enforces.
    const ordered = [...norms].sort((a, b) =>
      Number(b.kind === 'norm' && b.deniedTools.length > 0) - Number(a.kind === 'norm' && a.deniedTools.length > 0));
    const injected: typeof ordered = [];
    const omitted: Array<{ id: string; kind: string; chars: number; reason: string }> = [];
    let used = 0;
    for (const norm of ordered) {
      const text = norm.kind === 'norm' ? norm.body : '';
      const cost = text.length + 80;
      if ((norm.kind === 'norm' && norm.deniedTools.length > 0) || used + cost <= this.normBudgetChars) {
        injected.push(norm);
        used += cost;
      } else {
        omitted.push({ id: norm.id, kind: norm.kind, chars: text.length, reason: '超出规范上下文预算，按配置省略；该规范的约束仍由 gate 判定' });
      }
    }
    return { injected, omitted, used };
  }
  /** The sentence that makes an over-budget context self-explaining. */
  private budgetNote(omitted: Array<{ id: string }>): string[] {
    return omitted.length
      ? [`规范上下文预算 ${this.normBudgetChars} 字符：本条上下文省略 ${omitted.length} 条规范（${omitted.map(o => o.id).join('、')}）；省略不改变它们的约束判定，需要时按 id 展开读取。`]
      : [];
  }
  /**
   * What this project already did, newest first, as one line per diary entry.
   *
   * The diary has been written at every checkpoint since this project began, and nothing ever
   * read it back on the way *in*: `prepare` recalled entries related to the query, and "what
   * have we already built" is never related to the query. The measured consequence is exact -
   * after a few rounds I reported that this project had no desktop shell, while `desktop-tauri/`
   * had been in the tree the whole time with a built installer, a tray implementation and an
   * autostart module. The information existed and was one call away; no path led there.
   *
   * Project scoping lives inside the content JSON (`scope.projectId`), not in a column, so the
   * filter happens after parsing. Reading `head` rather than a revision column keeps this
   * aligned with whatever the current version is.
   */
  recentProgress(projectId: string, limit = 3): string[] {
    const rows = this.db.prepare(
      `SELECT k.id AS id, k.head AS head, r.content AS content, r.created_at AS at
         FROM knowledge k JOIN revisions r ON r.id = k.id AND r.revision = k.head
        WHERE k.kind = 'journal' AND k.status = 'active'
        ORDER BY r.created_at DESC LIMIT ?`).all(limit * 4) as { id: string; head: number; content: string; at: number }[];
    const out: string[] = [];
    for (const row of rows) {
      let content: Record<string, unknown> = {};
      try { content = JSON.parse(String(row.content)) as Record<string, unknown>; } catch { continue; }
      const scope = content.scope as { kind?: string; projectId?: string } | undefined;
      if (scope?.kind !== 'project' || scope.projectId !== projectId) continue;
      const title = String(content.title ?? content.did ?? '（无标题）').replace(/\s+/g, ' ').slice(0, 90);
      const outcome = String(content.outcome ?? 'unverified');
      out.push(`${row.id}@${row.head} ${title}（结果：${outcome}；全文用 amb_read_knowledge 读取）`);
      if (out.length >= limit) break;
    }
    return out;
  }

  prepare(projectId: string, query: string, options?: { sessionId?: string; taskId?: string; platform?: 'dsh' | 'codex'; knownRevision?: number; selectedIds?: string[]; selectionSource?: 'model' | 'index' | 'local_index'; noRetrievalIntent?: boolean }) {
    if (options?.sessionId) {
      try {
        const querySnippet = query ? query.split('\n')[0]?.slice(0, 50) : '';
        this.startTaskForSession(projectId, options.sessionId, querySnippet || '会话工作任务');
      } catch {
        // Task association failure must never break retrieval
      }
    }
    const all = this.norms(projectId, { taskId: options?.taskId, platform: options?.platform });
    // Instruction files the host already injects natively (DSH ships
    // dsh-agent-instructions; Codex reads the same names) stay indexed and
    // auditable but are never re-injected: sending the same bytes twice would
    // duplicate instructions and could fight the host's own baseline semantics.
    const norms = all.filter(n => n.kind !== 'norm' || !n.hostProvided);
    const hostProvided = all.filter(n => n.kind === 'norm' && n.hostProvided);
    // Budget the normative prose. Everything that fits is injected; what does not is
    // reported by id and reason rather than silently dropped, and every entry that
    // states a tool prohibition is promoted to the front so a budget can never hide
    // the rule a gate would enforce.
    const { injected, omitted } = this.splitByBudget(norms.map(norm => ({
      id: norm.id, revision: norm.revision, kind: norm.kind,
      body: norm.kind === 'norm' ? norm.body : '', deniedTools: norm.kind === 'norm' ? norm.deniedTools : [],
    })));
    const injectedIds = new Set(injected.map(item => item.id));
    const emitted = norms.filter(norm => injectedIds.has(norm.id));
    // No query means no basis for selection, so nothing is injected. Both helpers
    // fall back to listing the whole catalog, which is right for a caller that
    // asked to browse and wrong here: an arbitrary slice appearing in every
    // session is how a project unrelated to any of them opened with five media
    // skills. Norms are unaffected — they are the standing rules and apply
    // whether or not anything was asked.
    // What the request asks about, kept separate from what it merely mentions.
    //
    // `tokens` reports every word the query contained, and `noIntent` already covers a purely
    // negative request on its own. But a request can exclude one subject while asking about
    // another - 不要查询召回预算，解释一下光合作用 - and then the intent is real, so `noIntent`
    // does not fire and `gaps` was computed from the whole string. It reported 召回 and 预算 as
    // coverage gaps, which asserts the library cannot cover the very subject the request had
    // explicitly excluded. The clause splitter is the one the index and the matcher use, so the
    // gap baseline is now drawn from the words that were actually searched for.
    const askedClauses = positiveRetrievalClauses(query);
    // Strip the filler phrases before tokenising, exactly as `automaticRelevance` does above and
    // for the reason its comment gives: cutting them after tokenisation leaves artificial
    // cross-boundary fragments (检查功能 -> 查功), and `gaps` asserts that the library has no
    // such fragment. Taking the clauses raw meant reporting 算怎 and 么设 as coverage gaps for
    // "召回预算怎么设置" - fragments produced by cutting through 怎么, which no entry could ever
    // contain, because every entry was tokenised the same way.
    const gapTokens = queryTokens(askedClauses.join(' ').toLowerCase()
      .replace(new RegExp([...recallStopWords].join('|'), 'gu'), ' '));
    const hasQuery = queryTokens(query).length > 0;
    const retrievalTokens = queryTokens(query);
    /**
     * Local evidence for every entry, plus what the caller's selection adds.
     *
     * `selectedIds` decides which entries are candidates and in what order. It does
     * not decide what the local evidence is, and it used to: clearing `matched` here
     * made every prepare that arrived through the server report `matchedTokens: []`
     * with the entire query listed as `gaps` - a receipt asserting that a query
     * matched nothing at the moment it matched. That is worse than no receipt, since
     * a reader who is told a real hit was a gap learns to distrust every later one.
     * The hit words are therefore recomputed from the entry itself and only the
     * score and ordering come from the caller. `source` records which path chose the
     * entry, so a model decision stays distinguishable from a local ranking.
     */
    const automaticMatches: Map<string, { score: number; matched: string[]; coverage: number; source?: string }> =
      this.automaticMatches(projectId, query);
    if(options?.selectedIds) {
      const byId = new Map(this.liveEntries().map(entry => [entry.id, entry] as const));
      const ranked = options.selectedIds.map((id,index) => {
        const entry = byId.get(id);
        const local = entry ? automaticRelevance(entry.content, query) : { score: 0, matched: [], coverage: 0 };
        return [id, { score: 100 - index, matched: local.matched, coverage: local.coverage,
          source: options.selectionSource ?? (local.score > 0 ? 'index' : 'explicit') }] as const;
      })
      /**
       * A local fallback has to carry local evidence.
       *
       * When the model times out or abstains, the caller's `selectedIds` is the local index's
       * own ranking - and the index scores from a looser evidence chain than the one above
       * (clause terms, purpose hits, fact windows) while this function matches query tokens
       * against title, description and body. The two disagree, and the disagreement reaches
       * the agent as an injected entry with nothing connecting it to the request.
       *
       * Measured on the live library (verification/r5/selection-noise-rate.mjs): eight queries
       * sharing nothing with the library injected entries four times, and every one of those
       * four carried an empty strict match; four related queries injected zero unevidenced
       * entries. Both groups injected at the same rate, so the rate alone would not have shown
       * it - the zero-evidence count is what separates them.
       *
       * A model's choice is left alone on purpose. Semantic relevance is exactly what a model
       * can see and this matcher cannot, so requiring a literal token match here would throw
       * away the one path that works.
       */
      .filter(([, value]) => value.source === 'model' || value.matched.length > 0 || value.coverage > 0);
      automaticMatches.clear();
      for(const [id,value] of ranked) automaticMatches.set(id,value);
    }
    const rankAutomatic = <T extends { id: string }>(entries: T[], limit: number) => entries
      .filter(entry => automaticMatches.has(entry.id))
      .sort((a, b) => automaticMatches.get(b.id)!.score - automaticMatches.get(a.id)!.score)
      .slice(0, limit).map(entry => ({ ...entry, why: automaticMatches.get(entry.id)! }));
    const workflows = hasQuery ? rankAutomatic(this.search(projectId, '', Number.MAX_SAFE_INTEGER), 8) : [];
    // Automatic injection uses the entry's advertised purpose, not matches buried
    // in dozens of reference documents or shared procedure boilerplate. Explicit
    // universal search and knowledge() still index the full source and leaves.
    const knowledge = hasQuery ? rankAutomatic(this.knowledge(projectId, '', Number.MAX_SAFE_INTEGER, 400), 5) : [];
    /**
     * The record of what this retrieval did, and what it could not find.
     *
     * The design requires the knowledge version, the retrieval reason and the known
     * gaps to be recorded so a missed recall can be investigated afterwards. Without
     * it the only available explanation for "it did not find that" is a guess, and
     * the query that found nothing leaves no trace at all — which is exactly the case
     * worth investigating, since a term matching nothing may mean missing coverage
     * rather than an unanswerable question.
     *
     * A gap is a query fragment that matched no entry. It is reported as a possible
     * coverage gap, not asserted as one: a term can legitimately be absent because
     * the library has no such knowledge, or because nothing needed adopting.
     */
    const matchedTokens = new Set<string>();
    for (const item of [...workflows, ...knowledge]) for (const token of item.why?.matched ?? []) matchedTokens.add(token);
    // An entry selected outside `workflows`/`knowledge` — a rule, which is injected
    // through `norms()` rather than as a retrieved item — still matched this query.
    // Counting its hit words as gaps would tell the reader the library has no such
    // knowledge at the moment it was selected from it.
    for (const id of options?.selectedIds ?? []) for (const token of automaticMatches.get(id)?.matched ?? []) matchedTokens.add(token);
    /**
     * A query that was never worth searching is not a search that found nothing.
     *
     * `gaps` means "no entry matched this fragment", and it is read that way by a
     * person investigating a missed recall. When the caller had no retrieval intent at
     * all — an empty query, a status acknowledgement, a purely negative request —
     * nothing was searched, so listing every fragment as a coverage gap reports a
     * search result that never happened and inflates the very signal this report
     * exists to carry. The two facts are therefore stated apart: the tokens are still
     * recorded and the `note` says the query was not searched, while a real search that
     * came back empty still lists its fragments as gaps.
     *
     * Nothing is added to the receipt's shape. The flag changes what `gaps` and `note`
     * say on this branch and nowhere else, so a caller that compares whole receipts —
     * the retrieval-service tests compare selection objects field by field — keeps the
     * contract it already had.
     */
    const noIntent = options?.noRetrievalIntent === true;
    /**
     * Completeness, stated rather than left to be inferred.
     *
     * An agent handed three entries cannot tell whether the library holds three or three
     * hundred, and the two cases call for opposite behaviour: with three it has what exists,
     * with three hundred it has a sample and should search before concluding anything. Measured
     * on a real library - 619 visible entries - a single query surfaced 3, and that 0.5% sample
     * arrived with exactly the same confidence as a complete answer would have.
     *
     * `considered` is what this project can see at all, `shown` is what this receipt carries,
     * and `hint` names which situation the caller is in. The fields are additive on purpose: a
     * caller that compares receipts field by field still finds everything it expected.
     */
    const considered = this.scopedEntries(projectId).length;
    const shownCount = workflows.length + knowledge.length;
    // Rounding a 1-of-584 sample to "0%" reads as "nothing was given", which is the opposite of
    // what happened. Say "under 1%" instead: the point of the number is to convey that this is a
    // sample, and 0% conveys the wrong kind of small.
    const sharePct = considered > 0 ? shownCount / considered * 100 : 0;
    const shareText = sharePct < 1 ? '不足 1%' : Math.round(sharePct) + '%';
    const retrieval = {
      query,
      tokens: retrievalTokens,
      matchedTokens: [...matchedTokens],
      gaps: noIntent ? [] : gapTokens.filter(token => !matchedTokens.has(token)),
      considered,
      shown: shownCount,
      hint: noIntent
        ? '本次未做检索。'
        : shownCount === 0
          ? '库内 ' + considered + ' 条可见条目中没有本次要的内容；这不代表库内没有相近主题，换个说法再检索可能命中。'
          : shownCount >= considered
            ? '库内 ' + considered + ' 条可见条目已全部列出。'
            : '库内 ' + considered + ' 条可见条目，本次给出 ' + shownCount + ' 条（' + shareText + '）。这是抽样而非全集：若这些不足以回答，用 amb_search_universal 按具体关键词再检索，或对命中的条目用 amb_read_knowledge 读全文。',
      selected: [
        ...workflows.map(w => ({ id: w.id, revision: w.revision, kind: 'workflow' as const, why: w.why })),
        ...knowledge.map(k => ({ id: k.id, revision: k.revision, kind: k.kind, why: k.why })),
      ],
      note: noIntent
        ? '本次没有检索意图（空查询、状态汇报或否定式请求），未做选择，因此不报告覆盖缺口；这不等于库中一定没有这些片段。'
        : '这是本次检索的理由与未命中片段，供日后排查漏检；未命中不等于库中一定该有。',
    };
    const continuation = this.recentProgress(projectId, 3);
    const context = [
      `Agent Memory Backpack 当前知识版本 ${this.revision}。以下规范来自本地权威库；流程是经验，不授予额外操作权限。`,
      // Continuity travels first and unconditionally. Everything else here is about what the
      // library knows; this is about what *this project already did*, which is the one thing a
      // fresh context cannot reconstruct from the repository alone. It sits before the norms
      // because forgetting it has already cost real work: a desktop shell that existed, built,
      // with an installer, was reported as missing.
      ...(continuation.length
        ? ['本项目此前的进展（来自日记。动手前先对照，避免重复已完成的工作或推翻既有决定）：', ...continuation]
        : []),
      ...(hostProvided.length
        ? [`宿主已自行加载的规范（插件不重复注入，仅登记以便检索）：${hostProvided.map(n => `${n.id}@${n.revision}`).join('、')}`]
        : []),
      ...emitted.map(n => `规范 ${n.id}@${n.revision}: ${n.kind === 'norm' ? n.body : ''}`),
      ...this.budgetNote(omitted),
      // A workflow used to travel in full: every stage, every check, the completion and the
      // recovery conditions. That contradicted the next line but one, which tells the agent to
      // call amb_read_stage before executing a stage - the detail was being sent anyway, so the
      // pointer was decoration. It is the same shape as adopted skills, which already travel as
      // an entry point plus an excerpt for exactly this reason, and a workflow with many stages
      // could silently consume the task's budget. What stays is what "is there a workflow for
      // this, how does it start, and when is it done" needs; the per-stage checks and the
      // recovery steps are one call away, and recovery is only needed once something failed.
      ...workflows.map(w => `完整流程 ${w.id}@${w.revision} ${w.title}\n${w.overview}\n前提: ${w.preconditions.join('；')}\n阶段: ${w.stages.map(s => `${s.id}:${s.title}`).join(' → ')}\n完成: ${w.completion.join('；')}\n${w.ready ? `执行阶段前调用 amb_read_stage 读取该阶段的检查项与必需依赖（共 ${w.stages.length} 个阶段；失败时的恢复步骤也在其中）。` : `不可执行: ${w.unavailable}`}`),
      // Adopted skills and memories appear as entry points with a short excerpt.
      // Full text is one explicit call away, so a large adopted library cannot
      // silently consume the task's context budget.
      ...knowledge.map(k => `${k.kind === 'skill' ? '已采纳技能' : '背景记忆'} ${k.id}@${k.revision} ${k.title}`
        + (k.leafCount ? `（含 ${k.leafCount} 个参考文档）` : '')
        + `（正文 ${k.chars} 字符，需要时调用 amb_read_knowledge 读取）`
        + (k.kind === 'skill' && k.needsStructure ? '［尚未结构化：原文保存，未经核实为完整方法］' : '')
        + `\n摘要: ${k.excerpt}`),
      '【AMB 双向记忆】Codex/DSH 各项目会话共用此库。任务开始或遇到新错误，用 `amb_search_universal` 按任务/错误签名检索知识、经验与日记，再用 `amb_read_knowledge` 读相关正文并核对适用条件。\n'
      + '验证根因或新方案后用 `amb_submit_experience` 提交候选，附流程/步骤、修复和证据。pending=待审；queued_local=仅本机排队，均未采纳。自动捕获的失败事实待核实，不是规范。Stop不表示任务完成。',
    ].join('\n\n');
    // A caller that already received this revision gets a pointer instead of the
    // whole normative text again. The gate hook runs before every tool call, so
    // without this the same ~12,000 characters are re-sent dozens of times in one
    // task; the design asks for same-version reuse (§5.2) and forbids weakening a
    // rule, so the decision list still travels in full and only the prose repeats.
    const unchanged = options?.knownRevision !== undefined && options.knownRevision === this.revision;
    /**
     * Continuity is exempt from the same-version shortcut.
     *
     * The shortcut exists because re-sending 12,000 characters of unchanged norms on every turn
     * is waste. Progress is not in that category: it changes as soon as anything is done, it is
     * a handful of lines, and dropping it when the knowledge revision happens to be stable is
     * exactly how "what did we already build" goes missing again. So it is appended to both
     * branches, and also exposed as its own field so a caller can show it without the prose.
     */
    const continuationBlock = continuation.length
      ? ['本项目此前的进展（来自日记。动手前先对照，避免重复已完成的工作或推翻既有决定）：', ...continuation]
      : [];
    return {
      protocolVersion: 1, knowledgeRevision: this.revision, mode: 'Managed', norms, workflows, knowledge,
      continuation,
      context: unchanged
        ? [`Agent Memory Backpack 当前知识版本 ${this.revision}（与上次注入相同，规范正文未重复发送）。`, ...continuationBlock].join('\n')
        : context,
      contextUnchanged: unchanged,
      budget: {
        limitChars: this.normBudgetChars,
        usedChars: injected.reduce((total, item) => total + (item.kind === 'norm' ? item.body.length : 0) + 80, 0),
        injected: injected.map(n => ({ id: n.id, revision: n.revision, kind: n.kind })),
        omitted,
      },
      retrieval,
    };
  }
  gate(projectId: string, toolName: string, options?: { taskId?: string; platform?: 'dsh' | 'codex'; knownRevision?: number }) {
    const all = this.norms(projectId, { taskId: options?.taskId, platform: options?.platform }).filter(n => n.kind === 'norm');
    /**
     * Compare tool names in normalised form.
     *
     * An exact string comparison was trivially bypassable: a norm denying `Bash`
     * did not deny `bash`, `Bash ` or a name differing only in case, so the
     * prohibition looked enforced while the same call went through. Trimming and
     * case-folding closes the accidental forms; the deliberate aliases a host may
     * use (a shell reachable by several names) still need the host's own tool
     * table, which is why the decision stays scoped to names the user listed.
     */
    const normalise = (name: string) => name.trim().toLowerCase();
    const denied = new Set(all.flatMap(n => n.deniedTools.map(normalise)));
    const requested = normalise(toolName);
    // An empty or whitespace-only name cannot be matched meaningfully; it is
    // treated as ungovernable rather than silently allowed.
    const blocked = requested.length > 0 && denied.has(requested);
    // Same-version reuse: a gate hook fires before every tool call, so re-sending
    // the whole normative prose each time is pure duplicate context. The decision
    // and the deny list are always complete — a cache can never widen a permission.
    const unchanged = options?.knownRevision !== undefined && options.knownRevision === this.revision;
    /**
     * The same ceiling as `prepare`, and for the same reason.
     *
     * This path fires before *every* tool call, so leaving it unbudgeted kept the
     * larger half of the cost F23 was raised about: with forty near-maximum norms it
     * re-sent ~476,000 characters on the first call of each session, and the 90%
     * reduction previously measured came entirely from the same-revision suppression
     * rather than from any bound. Without `knownRevision` — a fresh session, or any
     * revision change — the full text went out.
     *
     * The decision and `deniedTools` remain complete regardless: only the prose
     * injected into the model is bounded, and a norm stating a prohibition is always
     * included.
     */
    const { injected, omitted } = this.splitByBudget(all.filter(n => !n.hostProvided).map(n => ({
      id: n.id, revision: n.revision, kind: n.kind, body: n.body, deniedTools: n.deniedTools,
    })));
    const context = [
      ...injected.map(n => `当前规范 ${n.id}@${n.revision}: ${n.body}`),
      ...this.budgetNote(omitted),
    ].join('\n');
    return {
      decision: blocked ? 'deny' : 'allow',
      reason: blocked
        ? `当前规范禁止该工具: ${all.filter(n => n.deniedTools.map(normalise).includes(requested)).map(n => n.id).join(', ')}`
        : (requested.length === 0
          ? '工具名为空，无法核对；按未覆盖处理'
          : 'No matching explicit tool prohibition'),
      knowledgeRevision: this.revision,
      context: unchanged ? '' : context,
      contextUnchanged: unchanged,
      budget: {
        limitChars: this.normBudgetChars,
        usedChars: injected.reduce((total, item) => total + item.body.length + 80, 0),
        injected: injected.map(n => ({ id: n.id, revision: n.revision, kind: n.kind })),
        omitted,
      },
      // The effective prohibition list, so an adapter can keep enforcing policy
      // while the core is down. Not a new disclosure: the norm bodies above are
      // already sent, and the deny list is a field inside them.
      deniedTools: [...denied],
    };
  }
  /**
   * The entries a candidate is classified against.
   *
   * Extracted so the submission path and the backfill compare a candidate against
   * exactly the same library. The backfill must produce the verdict the submission
   * path would produce *now*; a second filter written on the other side is precisely
   * how two classifiers drift apart, and this project has already paid for that once.
   */
  private classificationCandidates(projectId: string): Array<{ id: string; title: string; body: string; kind: string }> {
    return this.liveEntries()
      .filter(entry => entry.content.kind !== 'material' && applicable(entry.content.scope, projectId))
      .map(entry => ({
        id: entry.id, title: entry.content.title, kind: entry.content.kind,
        body: 'body' in entry.content ? String(entry.content.body) : '',
      }));
  }
  /**
   * Classify one candidate text and stamp the snapshot with where the verdict came from.
   *
   * The two added fields are what make the backfill idempotent and auditable:
   * `classifierVersion` says which classifier produced this verdict, and `textDigest`
   * says which text it was produced from — a candidate whose text changed after
   * submission was never classified as it now reads. A stored verdict carrying both,
   * matching the current constant and the current text, is already current and is
   * reported as skipped rather than rewritten.
   */
  private classifyForStorage(text: string, projectId: string): SemanticAnalysis & { classifierVersion: string; textDigest: string } {
    return {
      ...classifyCandidate(text, this.classificationCandidates(projectId)),
      classifierVersion: CLASSIFIER_VERSION,
      textDigest: digest(text.trim()),
    };
  }
  /**
   * Record a candidate for review.
   *
   * The return type is stated rather than inferred: the two branches (retry, new)
   * previously widened to a union the callers could not narrow, and a hand-written
   * annotation on the internal query then broke the whole method's inference. Naming
   * the receipt here keeps both branches in one shape for callers while leaving the
   * internals unannotated.
   */
  submit(principal: string, payload: { idempotencyKey: string; projectId: string; taskId?: string; workflowId?: string; stageId?: string; baseRevision?: number; discovery: string; evidence?: string }): {
    id: string; state: string; duplicate: boolean; duplicateOf?: string;
    /**
     * Present for a new submission; omitted on the retry branch.
     *
     * The retry receipt's shape is pinned by `test/store.test.ts` with `deepEqual`,
     * so it must carry exactly `{ id, state, duplicate }`. The type therefore marks
     * this optional rather than forcing both branches into one shape — the reviewer
     * tier for an existing record is readable from `listProposals`, where it is
     * stored.
     */
    review?: ReviewDecision;
    /**
     * Present only when the submitted workflow could not be resolved and the
     * candidate was therefore kept unattributed. The retry branch and the
     * ordinary new-submission branch omit it, which is what keeps the retry
     * receipt's `{ id, state, duplicate }` shape intact for `deepEqual`.
     */
    attribution?: { workflowId: string | null; stageId: string | null; resolved: boolean };
    /** Human-facing explanation of an unattributed save; absent when resolved. */
    note?: string;
  } {
    /**
     * Which review tier this candidate falls into, decided here rather than at each
     * call site.
     *
     * A submitted candidate is always an agent's own account, so its evidence is
     * `self-reported` and its provenance `agent` — the two facts the design's boundary
     * table keys on. That is why the tier is computed from what the submission
     * actually is rather than from anything the submitter asserts about it: a caller
     * that could declare its own change auto-applicable would not be governed by the
     * table at all.
     */
    const decision = reviewDecision({
      intent: 'new-experience',
      provenance: 'agent',
      evidence: 'self-reported',
    });
    return this.transaction(() => {
      const fingerprint = digest(payload);
      /**
       * An idempotent retry is answered before any freshness check runs.
       *
       * The order matters and used to be wrong. `idempotencyKey` exists so that a
       * retry is *not* a new submission, but the workflow/base-revision validation
       * ran first: when the workflow moved on while the candidate waited, the retry
       * was refused with `revision_conflict` even though the candidate was already
       * stored. The caller then had no way to learn the receipt it was owed, and the
       * candidate sat in the queue looking like a failure. Principal + key identify
       * the record; a differing body under the same key is still an idempotency
       * conflict, which is a different fact from a retry and keeps its 409.
       *
       * The receipt deliberately omits `review`, unlike the first-submission
       * branch, and the shape must stay exactly as it is: `test/store.test.ts`
       * compares this object with `deepEqual`, so an extra field fails that
       * assertion at runtime. The tier lives on the stored record and is read back
       * through `listProposals`, which is where a caller that needs it looks.
       */
      const previous = this.db.prepare('SELECT id,fingerprint,state FROM proposals WHERE principal=? AND idem=?')
        .get(principal, payload.idempotencyKey) as { id: string; fingerprint: string; state: string } | undefined;
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new DomainError('idempotency_conflict', 'Same idempotency key has different content', 409);
        return { id: previous.id, state: previous.state, duplicate: true };
      }
      /**
       * The payload is validated here, not only at the HTTP edge.
       *
       * The HTTP path parses the body with `proposalSchema`, so a bad submission
       * from an adapter never reaches this method. The outbox replay path calls
       * `submit()` directly — `enqueue()` stores the request body as an opaque blob
       * by design, because it must be able to keep a payload it cannot yet interpret
       * — and therefore arrived unvalidated. The gap was observable: an empty
       * `discovery` was stored as a candidate, and a payload missing the field
       * entirely failed with a raw `TypeError` from `.trim()` instead of a domain
       * error naming the field. A reviewer's queue is the wrong place to discover
       * that a candidate has no text.
       *
       * So both entry points now accept the same set, and an invalid payload is a
       * 400 with the offending field named — the same shape the HTTP edge produces,
       * which is what lets an adapter treat it as a permanent rejection rather than
       * a retryable transport fault.
       */
      const shape = proposalSchema.safeParse(payload);
      if (!shape.success) {
        const field = shape.error.issues[0]?.path.join('.') || 'payload';
        throw new DomainError('invalid_request', `Candidate payload is invalid at field "${field}"`, 400);
      }
      // Normalised through the schema's own trimming, so the exact-text duplicate
      // rule below compares what the schema said it stored rather than the raw
      // argument, and so the stored record carries the declared shape.
      const submission = shape.data;
      if (submission.taskId && !this.getTask(submission.taskId, submission.projectId))
        throw new DomainError('not_found', 'Task is unavailable', 404);
      if (submission.stageId !== undefined && submission.workflowId === undefined) {
        // A stage cannot be located without its workflow: "step 3" is meaningless
        // until it is "step 3 of this process", and storing it alone would create the
        // unattached fragment the workflow requirement exists to prevent.
        throw new DomainError('invalid_request', 'stageId requires workflowId', 400);
      }
      /**
       * Workflow attribution is recorded, not enforced by discarding the candidate.
       *
       * An unknown workflow id used to abort the submission with 404, and the
       * candidate was never stored. That inverted the priority the design sets:
       * a candidate is the user's own recorded experience, and losing it is the
       * one outcome the project forbids. The measured consequence was 21 failed
       * tool calls whose text existed nowhere afterwards — the model had filled in
       * a workflow id for a library with no workflows, and a validation detail
       * about *where* the experience belongs destroyed the experience itself.
       *
       * So an unresolvable id is kept and marked: `attribution.resolved` is false
       * and `stageId` is null, because a step cannot belong to a workflow that is
       * not there. Nothing is guessed — the submitted id is preserved verbatim so
       * a reviewer can see what was claimed and correct it, and the caller is told
       * plainly that the workflow was not found.
       *
       * `resolved` answers "is this candidate *located* in the flow", and it is
       * true only when a workflow was named *and* found (and, when a step was
       * named, that the step belongs to it). A candidate that names nothing at all
       * has no location, so it is `false` — which is exactly the state this flag
       * exists to distinguish from a real attribution. Reporting `true` there
       * would have made the flag worse than absent: the queue would have shown an
       * unattached candidate as a located one.
       *
       * What is *not* relaxed: once a workflow does resolve, its `baseRevision`
       * and `stageId` are checked exactly as before. Those answer "is this the
       * version I observed, and does this step exist", which are real integrity
       * questions; a missing workflow answers only "the library cannot confirm
       * this yet", which is not a reason to throw the text away.
       */
      // False unless a candidate is genuinely located: a workflow must have been
      // named and found, and a named step must belong to it.
      let workflowResolved = false;
      if (payload.workflowId) {
        const entry = this.head(payload.workflowId);
        if (!entry || entry.status !== 'active' || entry.content.kind !== 'workflow' || !applicable(entry.content.scope, payload.projectId)) {
          workflowResolved = false;
        } else {
          // A workflow that was found and a step that checks out is a real
          // location; the baseRevision and stage checks below can still refuse the
          // submission outright, in which case nothing is stored at all.
          workflowResolved = true;
          if (payload.baseRevision !== undefined && entry.revision !== payload.baseRevision)
            throw new DomainError('revision_conflict', `Expected baseRevision ${payload.baseRevision} but current is ${entry.revision}`, 409);
          /**
           * A stage id is checked against the workflow it claims to belong to.
           *
           * The check answers "does this step exist" and nothing more. Whether the
           * experience really belongs to that step is a semantic judgement this layer
           * deliberately does not make; accepting an unknown id, though, would let a
           * candidate point at a step that does not exist and be reviewed as though it
           * did.
           */
          if (payload.stageId !== undefined && !entry.content.stages.some(stage => stage.id === payload.stageId)) {
            throw new DomainError('not_found', `Workflow ${payload.workflowId} has no stage ${payload.stageId}`, 404);
          }
        }
      }
      const id = randomUUID();
      /**
       * A heuristic classification, attached so the reviewer sees what the program
       * inferred about the candidate: which kind it looks like, how wide it seems to
       * be, and whether it appears to conflict with something already stored.
       *
       * It is advisory only — it never decides a tier or promotes anything — but
       * without it in the record the review queue showed raw text with no analysis
       * at all, and a genuine conflict looked identical to a routine addition.
       */
      const classification = this.classifyForStorage(payload.discovery, payload.projectId);
      /**
       * An identical candidate already waiting is a duplicate, not a new discovery.
       *
       * The audit's EV-CE-02: two submissions with the same text under different
       * idempotency keys both entered the queue as `relation: 'new'`, and approving
       * both stored the same entry twice. Idempotency is per (principal, key), so it
       * cannot see this — and `classifyCandidate` only compares against *existing
       * knowledge*, never against the other candidates already in the queue, so the
       * two never met.
       *
       * Textual identity is a program's job, not a model's: the design's §6.3 table
       * puts "明确重复资料或内容 — 合并重复来源/拒绝重复保存" in the automatic tier.
       * So this is decided deterministically, on exact text, and recorded as
       * `duplicateOf` rather than silently dropped — the second submission is
       * answered with the id of the one already waiting, which is what a retrying
       * caller needs to hear.
       *
       * Deliberately exact rather than fuzzy: an approximately-similar candidate may
       * be a genuine refinement, and merging those is the semantic judgement the
       * design keeps for review (`classifyCandidate` reports `duplicate` for high
       * similarity against existing entries, which stays advisory).
       */
      const discoveryDigest = digest(payload.discovery.trim());
      const pendingTwin = this.db.prepare(
        "SELECT id,payload FROM proposals WHERE project_id=? AND state IN ('pending','needs_evidence') ORDER BY created_at",
      ).all(payload.projectId).find(row => {
        try {
          const stored = JSON.parse(String((row as { payload: string }).payload)) as { discovery?: string };
          return typeof stored.discovery === 'string' && digest(stored.discovery.trim()) === discoveryDigest;
        } catch { return false; }
      }) as { id: string } | undefined;
      /**
       * Whether this candidate is a serious normative conflict.
       *
       * §6.3 keeps such a candidate in the queue for a person to rule on, and the
       * ordinary pending deadline must not clear its text or mark it expired. The
       * classifier only recognises Chinese negation, so an explicit subject check is
       * added here: a submission that says it conflicts with, replaces, or widens a
       * rule is held — better to keep one extra candidate for review than to drop the
       * one a human was meant to decide.
       *
       * The check reads the three subjects the design actually means — a conflict with
       * stored knowledge, a supersession of an earlier conclusion, a request for a
       * human ruling — and nothing else. It used to match bare substrings, so the
       * exemption covered machine text. Measured read-only on the live library
       * (2026-10-17): the queue held 334 pending rows, 97 of them `important` — 95 of
       * 331 in the same day's earlier sample, 56 of those carrying no Chinese trigger
       * word at all. The words responsible were `replace` (24 rows, mostly the tool name
       * `ReplaceFileW`), `global` (6, as in a scope spelled in English), `conflict` /
       * `important` / `supersede` inside technical identifiers such as
       * `idempotency_conflict`, and `rule`. Replaying the narrowed rules over the same
       * 334 rows drops 35 of those exemptions and grants none. Each false positive was a
       * row that could never lapse, which is how a thirty-day archive stops being one.
       *
       * Two consequences are deliberate. The English side is word-bounded and narrowed,
       * so `ReplaceFileW`, a path like `src/replace.ts` and the verb "replace" in an
       * ordinary sentence are none of them a conflict — only `conflict(s)`,
       * `contradict*` and `supersede*` are. And `替换` counts only when it names what
       * it replaces: "把变量替换成新值" is an operation, while "用新做法替换旧的判断"
       * is a supersession of stored knowledge and still waits for a person.
       */
      const text = payload.discovery;
      const seriousZh = /(冲突|矛盾|取代|待裁决|裁决)/.test(text);
      const seriousReplacement = /替换[^。；！？\n]{0,12}(?:旧|原有|原来|先前|之前|既有|已有|结论|规范|经验|做法|方案|流程|判断)/.test(text);
      const seriousEn = /\b(?:conflicts?|conflicting|contradicts?|contradicted|contradiction|supersedes?|superseded|supersession)\b/i.test(text);
      const serious = seriousZh || seriousReplacement || seriousEn;
      const conflict = serious
        || ['conflict', 'supersede', 'duplicate'].includes(classification.relation)
        || classification.needsSplit;
      const record = {
        ...payload,
        review: { tier: decision.tier, reason: decision.reason, constraint: decision.constraint },
        classification,
        /**
         * Where this candidate claims to belong, with the program's own verdict.
         *
         * Written into the stored payload rather than only the receipt, because the
         * reviewer reads it from the queue: `attribution.resolved: false` is what
         * tells them the workflow id was not found and the claim is unverified,
         * instead of the id silently looking as authoritative as a resolved one.
         * `stageId` is forced to null when the workflow is unresolved — a step
         * cannot belong to a workflow the library cannot locate, and keeping the
         * caller's stage here would re-introduce exactly the unattached fragment
         * the workflow requirement exists to prevent.
         */
        attribution: {
          workflowId: payload.workflowId ?? null,
          stageId: workflowResolved ? (payload.stageId ?? null) : null,
          // True only when this candidate is genuinely located in the flow: a
          // workflow was named and found, and a named step belongs to it. An
          // unattached candidate is `false`, which is the state the reviewer needs
          // to be able to recognise.
          resolved: workflowResolved,
        },
        // Held for a decision rather than lapsing on the ordinary deadline; see
        // `expireProposals` for why that matters.
        important: conflict,
      };
      /**
       * An exact-text twin is answered, not stored again.
       *
       * Returning the existing id keeps the queue free of literal duplicates while
       * telling the caller precisely what happened — the same shape a retry gets, so
       * a submission that was merely re-sent under a new key is not mistaken for a
       * second discovery. `duplicateOf` names the candidate already waiting so a
       * reviewer can see the two were the same text.
       */
      if (pendingTwin) {
        return { id: pendingTwin.id, state: 'pending', duplicate: true, duplicateOf: pendingTwin.id, review: decision };
      }
      this.db.prepare('INSERT INTO proposals(id,principal,idem,fingerprint,payload,state,created_at,expires_at,project_id) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, principal, payload.idempotencyKey, fingerprint, JSON.stringify(record), 'pending', this.now(),
          conflict ? Number.MAX_SAFE_INTEGER : this.now() + 30 * DAY, payload.projectId);
      this.jobs.enqueue('model_review', `proposal:${id}`, { proposalId: id, projectId: payload.projectId });
      if (payload.taskId) {
        const task = this.getTask(payload.taskId, payload.projectId)!;
        this.recordTask(payload.projectId, { id: task.id, title: task.title, status: task.status,
          relatedProposals: [...new Set([...task.relatedProposals, id])] });
      }
      /**
       * The receipt says the same thing the record does.
       *
       * A caller that only reads the response must not conclude the attribution was
       * accepted just because the submission was: `note` names the unknown workflow
       * and states that the candidate was kept unattributed and needs a person to
       * confirm where it belongs.
       */
      return {
        id, state: 'pending', duplicate: false, review: decision,
        ...(workflowResolved ? {} : {
          attribution: { workflowId: payload.workflowId ?? null, stageId: null, resolved: false as const },
          /**
           * Two different phenomena, two different sentences.
           *
           * A named-but-unresolved workflow and a submission that named none at all
           * both end up unattributed, but they are not the same fact and must not
           * share one sentence: saying "workflow undefined does not exist" invents a
           * flow that was never claimed, and leaks an internal value into text a
           * person reads.
           */
          note: payload.workflowId
            ? `workflow ${payload.workflowId} 不存在或不可见，候选已按未归属保存，请人工确认它应归属哪个流程/步骤。`
            : '本条候选未标注归属流程，已按未归属保存，请人工确认它应归属哪个流程/步骤。',
        }),
      };
    });
  }
  /**
   * Record one event against a task.
   *
   * A task id arriving from a caller is not trusted: without a binding check an
   * event could name another project's task, and the diary and export for that task
   * — which read the event stream — would then carry the other project's text into
   * a fact the receiving end treats as its own. The event is therefore refused
   * unless the task exists in the caller's project.
   */
  event(principal: string, payload: { eventId: string; projectId?: string; taskId?: string; [key: string]: unknown }): { id: unknown; stored: boolean; duplicate: boolean; [key: string]: unknown } {
    const taskId = typeof payload.taskId === 'string' ? payload.taskId : undefined;
    const projectId = typeof payload.projectId === 'string' ? payload.projectId : undefined;
    if (taskId && projectId) {
      // A task id that exists under another project is refused: its diary and
      // export read the event stream, so an accepted event would carry one
      // project's text into another project's "facts". An id that names no task at
      // all is stored but binds to nothing — it leaks nothing and refusing it would
      // only turn a harmless race into a hard failure.
      const owner = this.db.prepare('SELECT project_id FROM tasks WHERE id=?').get(taskId) as { project_id: string } | undefined;
      if (owner && String(owner.project_id) !== projectId) {
        throw new DomainError('scope_denied', `Task ${taskId} belongs to another project`, 403);
      }
    }
    return this.transaction(() => {
      const fingerprint = digest(payload); const old = this.db.prepare('SELECT id,fingerprint FROM events WHERE principal=? AND event_id=?').get(principal, payload.eventId);
      if (old) {
        if (old.fingerprint !== fingerprint) throw new DomainError('idempotency_conflict', 'Event key already has different content', 409);
        return { id: old.id, stored: true, ...this.reflectionReceipt(principal, payload.eventId), duplicate: true };
      }
      const id = randomUUID();
      this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(id, principal, payload.eventId, fingerprint, JSON.stringify(payload), this.now(), this.now() + 30 * DAY);
      const reflection = projectId && typeof payload.sessionId === 'string'
        && ['turn_stopped', 'turn_ended', 'turn/end'].includes(String(payload.kind))
        ? this.checkpointTask(principal, { projectId, sessionId: payload.sessionId,
          taskId, idempotencyKey: payload.eventId, status: 'paused' }) : {};
      return { id, stored: true, duplicate: false, ...reflection };
    });
  }
  /**
   * List proposals for one project.
   *
   * Filtered by the project recorded in the proposal payload. An unfiltered list
   * meant one project's reviewer could read another project's candidates — the
   * same class of leak found in `/v1/norms`.
   */
  listProposals(projectId: string, state?: string) {
    let query = 'SELECT id,principal,idem,payload,state,created_at,expires_at FROM proposals WHERE 1=1';
    const params: string[] = [];
    // The scope filter reads the dedicated column, not the payload. Reading the
    // payload meant a row whose payload had been cleared vanished from its own
    // project's list — the opposite of keeping it as a readable record.
    query += ' AND project_id = ?';
    params.push(projectId);
    if (state) {
      query += ' AND state=?';
      params.push(state);
    }
    query += ' ORDER BY created_at DESC';
    return this.db.prepare(query).all(...params).map(row => {
      // Left un-annotated on purpose: the stored payload is free-form JSON that
      // callers already read field by field, and narrowing it here would be a
      // type-only change with no effect on what is stored or returned.
      const payload = row.payload ? JSON.parse(String(row.payload)) : null;
      return {
        id: String(row.id),
        principal: String(row.principal),
        payload,
        state: String(row.state),
        createdAt: Number(row.created_at),
        expiresAt: Number(row.expires_at),
        /**
         * The candidate's own text, surfaced as a plain field.
         *
         * F09 was raised because a reviewer had to read the raw `payload` object
         * to see what the candidate actually said, and a review surface that only
         * showed the id could not answer "what would I be approving?". It is the
         * same text already stored in the payload, lifted out so list and detail
         * cannot disagree.
         */
        discovery: payload && typeof (payload as { discovery?: unknown }).discovery === 'string'
          ? String((payload as { discovery: string }).discovery)
          : null,
        /** The review decision recorded on the row, when one was made. */
        decision: payload && typeof (payload as { decision?: unknown }).decision === 'object'
          ? (payload as { decision?: unknown }).decision as Record<string, unknown>
          : null,
        /**
         * Where this candidate says it belongs, surfaced as its own field.
         *
         * The workflow requirement is that a reviewer can see which process and
         * which step a new experience is meant to change; reading it out of the
         * free-form payload made every consumer re-derive it, and a cleared
         * payload would have hidden the attribution along with the text. It is
         * derived here so listing and detail views cannot disagree about it.
         *
         * `resolved` is the program's verdict rather than the submitter's claim:
         * it is false when the named workflow could not be found, which is what
         * tells a reviewer that the workflow id and the step are *assertions*
         * needing confirmation instead of facts. It reads a missing verdict as
         * false rather than as true — a row that names no location is not a
         * located one — and leaves the row itself untouched, because an
         * unattributed candidate is reviewed and adopted exactly like any other.
         * Older rows that carry no attribution at all are handled by the same
         * rule: `resolveAttribution` reports nothing recorded, not a location.
         */
        attribution: payload ? attributionFields(payload) : null,
      };
    });
  }
  /**
   * The review queue as a person can act on it, derived read-only from the rows.
   *
   * `listProposals` answers "what is queued" and is unchanged: it returns one record
   * per stored row, newest first, and every existing caller (the console, the CLI,
   * the adapter's admin path) keeps reading exactly that. What it could not answer is
   * the question the queue was failing on — 301 pending rows in which 98 auto-captured
   * failures are 43 signatures repeated, all shown as equals beside 203 experiences
   * somebody actually wrote.
   *
   * So this method reads the same rows and derives a second view of them:
   *
   *  - rows sharing an auto-failure signature become ONE entry carrying `occurrences`,
   *    `firstSeenAt`, `lastSeenAt` and sample references to the underlying records;
   *  - entries are ordered by `proposalPriority`, so a human conflict outranks a
   *    routine submission, which outranks machine noise;
   *  - the low-value group is reported in `groups['failure-facts']` even when the
   *    caller asked only for actionable items, with its counts and a preview — folded,
   *    never dropped silently.
   *
   * Why derived rather than a stored aggregation: the rows must not change for this
   * to be reversible, and they do not — nothing here writes. A materialised group
   * would need a migration and a write path on a table a reviewer is deciding on
   * concurrently, and its failure mode (a group pointing at a row that no longer
   * holds what the group summarised) is exactly the kind of drift the underlying
   * records are there to prevent. The cost of deriving is one pass over the project's
   * rows, which this method already pays to read them.
   *
   * Every member stays reachable: `memberIds` lists all of them, `samples` carries the
   * most recent few with their ids, and each id still answers to `getProposal` and to
   * `listProposals` — the aggregate is a lens, not a replacement.
   */
  queueProposals(projectId: string, options: {
    /** Defaults to `pending`: the review queue proper. */
    state?: string;
    /** Which slice to return; the other slice is still reported in `groups`. */
    include?: 'actionable' | 'failure-facts' | 'all';
    /** How many member records an aggregate carries inline. */
    sampleLimit?: number;
    /** Cap on returned items; `totals` still reports the whole queue. */
    limit?: number;
  } = {}) {
    const state = options.state ?? 'pending';
    const include = options.include ?? 'actionable';
    const sampleLimit = Math.max(1, Math.min(20, Math.trunc(options.sampleLimit ?? 3)));
    const limit = options.limit === undefined ? undefined : Math.max(1, Math.trunc(options.limit));
    // Read in the same projection the flat view uses, so the two views cannot
    // disagree about what a row says.
    const rows = this.listProposals(projectId, state);
    interface Member {
      /**
       * `candidate` here; the folded group beside it is `aggregate`.
       *
       * The group always carried its `kind` while a plain candidate carried nothing at
       * all, so a caller branching on this field (the adapter panel does) read a plain
       * candidate as `undefined` and could not tell the two shapes apart. Naming it
       * fixes that; the field that says "this candidate is unattributed" is
       * `attribution.described`/`reason` below, which is additive.
       */
      kind: 'candidate';
      id: string; state: string; createdAt: number; expiresAt: number;
      discovery: string; priority: PriorityVerdict;
      attribution: { workflowId: string | null; stageId: string | null; resolved: boolean; described: boolean; reason: string | null };
      important: boolean; relation: string; confidence: number;
    }
    const actionable: Member[] = [];
    const bySignature = new Map<string, { tool: string; members: Member[] }>();
    for (const row of rows) {
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      const classification = (payload.classification ?? {}) as Record<string, unknown>;
      const relation = typeof classification.relation === 'string' ? classification.relation : 'unknown';
      const confidence = typeof classification.confidence === 'number' ? classification.confidence : 0;
      const needsSplit = classification.needsSplit === true;
      const discovery = typeof row.discovery === 'string' ? row.discovery : '';
      // Read through the shared resolver rather than trusting the list projection's
      // field: the projection is a presentation of the same payload, and a queue that
      // ranked on a different reading than it displayed is how the two views drifted
      // apart in the first place.
      const attribution = resolveAttribution(payload);
      const attributed = attribution.resolved;
      const hasEvidence = typeof payload.evidence === 'string' && payload.evidence.trim().length > 0;
      const signature = autoFailureSignature(discovery);
      const priority = proposalPriority({
        important: payload.important === true, relation, needsSplit, confidence,
        hasEvidence, attributed, autoFailure: signature !== null,
      });
      const member: Member = {
        kind: 'candidate',
        id: row.id, state: row.state, createdAt: Number(row.createdAt), expiresAt: Number(row.expiresAt),
        discovery, priority,
        attribution,
        important: payload.important === true, relation, confidence,
      };
      if (!signature) { actionable.push(member); continue; }
      const bucket = bySignature.get(signature.signature);
      if (bucket) bucket.members.push(member);
      else bySignature.set(signature.signature, { tool: signature.tool, members: [member] });
    }
    /**
     * Newest first inside a group, with the id as the tie-break.
     *
     * Two rows written in the same millisecond would otherwise order by whatever the
     * storage engine returned, which is how a "most recent" sample becomes unstable
     * between two identical calls.
     */
    const byRecency = (a: Member, b: Member) => b.createdAt - a.createdAt || a.id.localeCompare(b.id);
    for (const bucket of bySignature.values()) bucket.members.sort(byRecency);
    const aggregates = [...bySignature.entries()].map(([signature, bucket]) => {
      const members = bucket.members;
      const newest = members[0]!;
      const oldest = members[members.length - 1]!;
      // The group inherits the strongest reason any of its members had; for these rows
      // that is uniformly "low", which is the point of grouping them.
      const best = members.reduce((acc, item) => (item.priority.score > acc.priority.score ? item : acc), newest);
      return {
        id: newest.id,
        kind: 'aggregate' as const,
        state: newest.state,
        signature,
        tool: bucket.tool,
        occurrences: members.length,
        firstSeenAt: oldest.createdAt,
        lastSeenAt: newest.createdAt,
        createdAt: newest.createdAt,
        expiresAt: newest.expiresAt,
        discovery: newest.discovery,
        important: newest.important,
        relation: newest.relation,
        confidence: newest.confidence,
        attribution: newest.attribution,
        priority: {
          ...best.priority,
          reasons: [...best.priority.reasons, `同一签名出现 ${members.length} 次，这里取最近一条为代表`],
        },
        memberIds: members.map(item => item.id),
        sampleIds: members.slice(0, sampleLimit).map(item => item.id),
        samples: members.slice(0, sampleLimit).map(item => ({
          id: item.id, createdAt: item.createdAt,
          discovery: item.discovery.length > 240 ? `${item.discovery.slice(0, 240)}…` : item.discovery,
        })),
        aggregation: {
          rule: 'tool + normalised observation', signature, occurrences: members.length,
          sampleLimit, membersQueryable: true,
        },
      };
    });
    const byPriority = (a: { priority: PriorityVerdict; createdAt: number; id: string }, b: { priority: PriorityVerdict; createdAt: number; id: string }) =>
      b.priority.score - a.priority.score || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
    const rankedActionable = [...actionable].sort(byPriority);
    // Repeated failures first: twelve sightings of one error is a stronger reason to
    // look than one sighting of another, and the queue is where that ordering belongs.
    const rankedAggregates = [...aggregates].sort((a, b) =>
      b.occurrences - a.occurrences || b.lastSeenAt - a.lastSeenAt || a.signature.localeCompare(b.signature));
    const failureMembers = rankedAggregates.reduce((sum, group) => sum + group.occurrences, 0);
    const chosen = include === 'actionable'
      ? rankedActionable
      : include === 'failure-facts'
        ? rankedAggregates
        : [...rankedActionable, ...rankedAggregates];
    const items = limit === undefined ? chosen : chosen.slice(0, limit);
    return {
      projectId, state, include,
      ordering: '人工裁决(important) > 冲突/取代/需拆分 > 人工提交 > 自动捕获的失败事实聚合组；组内按出现次数与最近时间',
      items,
      totals: {
        inState: rows.length,
        returned: items.length,
        actionable: rankedActionable.length,
        failureFacts: failureMembers,
        failureSignatures: rankedAggregates.length,
        /** Rows that the aggregate view represents as one entry. */
        collapsed: failureMembers - rankedAggregates.length,
      },
      groups: {
        actionable: { count: rankedActionable.length },
        'failure-facts': {
          count: rankedAggregates.length,
          occurrences: failureMembers,
          collapsedDuplicates: failureMembers - rankedAggregates.length,
          /** What is in the folded group, so it can be judged without expanding it. */
          preview: rankedAggregates.slice(0, 5).map(group => ({
            signature: group.signature, tool: group.tool, occurrences: group.occurrences,
            lastSeenAt: group.lastSeenAt, sampleId: group.id,
          })),
        },
      },
      membersQueryable: true,
      /**
       * The same sentence the receipt and the list give, so a reviewer reading only
       * the queue learns that the candidate is unattributed *and* that this is not a
       * reason to wait: adoption and archiving do not depend on it.
       */
      note: '聚合是只读派生视图：底层 proposals 一条未删、状态未改，成员 id 见 memberIds，用 /v1/proposals/get 或按 state 过滤的列表可逐条取回。'
        + ' 归属（attribution）是展示与排序的增强项：未归属候选照常出现在队列里、照常可采纳与归档，采纳与归档都不要求先补归属。',
    };
  }
  /**
   * One proposal, with the information a reviewer needs to decide it.
   *
   * F01's root cause was that the review page had no way to name the target of an
   * approval. The page knew only the candidate's UUID, but the core refuses to
   * promote a workflow-bearing candidate unless the entry it writes is that very
   * workflow (`target_mismatch`), so approving from the queue could not work.
   *
   * This returns the resolved target — the workflow id and the revision the
   * candidate was submitted against — plus, when the target exists, the workflow
   * entry itself, so the reviewer sees the version they are about to change rather
   * than editing it blind. `target.available` is the program's verdict, not the
   * submitter's claim.
   */
  getProposal(id: string, projectId: string) {
    const row = this.db.prepare('SELECT id,principal,payload,state,created_at,expires_at,project_id FROM proposals WHERE id=?').get(id) as
      { id: string; principal: string; payload: string | null; state: string; created_at: number; expires_at: number; project_id: string } | undefined;
    if (!row) throw new DomainError('not_found', `Proposal ${id} is unavailable`, 404);
    if (row.project_id !== projectId) throw new DomainError('scope_denied', `Proposal ${id} belongs to another project`, 403);
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(row.payload || '{}') as Record<string, unknown>; } catch { /* cleared or torn row */ }
    const workflowId = typeof payload.workflowId === 'string' ? payload.workflowId : null;
    const baseRevision = typeof payload.baseRevision === 'number' ? payload.baseRevision : null;
    // Only a workflow entry that is visible to this project and still current can be
    // the object of an approval; anything else is reported as unavailable so the
    // reviewer is told to re-locate the candidate instead of being handed a target
    // the core would refuse.
    let target: { workflowId: string; baseRevision: number | null; currentRevision: number | null; entry: Knowledge | null; available: boolean; reason: string } = {
      workflowId: workflowId ?? '', baseRevision, currentRevision: null, entry: null, available: false,
      reason: workflowId ? '目标流程不存在或已不可见' : '本条候选未标注目标流程',
    };
    if (workflowId) {
      const head = this.head(workflowId);
      if (head && head.status === 'active' && head.content.kind === 'workflow' && applicable(head.content.scope, projectId)) {
        target = { workflowId, baseRevision, currentRevision: head.revision, entry: head.content as Knowledge, available: true, reason: '目标流程当前可见' };
      }
    }
    // One verdict for both read paths. This method used to answer `resolved: false`
    // for a row that named a workflow without a stored verdict, while the list view
    // answered `true` for the same row: two pages describing one candidate
    // differently, which is what makes a reviewer stop trusting either.
    const attribution = attributionFields(payload);
    return {
      id: row.id, principal: row.principal, state: row.state,
      createdAt: row.created_at, expiresAt: row.expires_at,
      payload,
      discovery: typeof payload.discovery === 'string' ? payload.discovery : '',
      attribution,
      review: (payload.review as Record<string, unknown> | undefined) ?? null,
      decision: (payload.decision as Record<string, unknown> | undefined) ?? null,
      target,
    };
  }
  /**
   * Return an archived, rejected or expired proposal to the review queue.
   *
   * The design keeps these rows as readable records rather than destroying them,
   * so a reviewer who set one aside must be able to bring it back. Only a
   * decision-free state is reopenable: an `approved` proposal already changed the
   * library, and reopening it would fork the decision history, so it is refused.
   */
  reopenProposal(id: string, options: { actor?: string; projectId?: string } = {}): { state: string; dueAt: number } {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT state,payload,project_id FROM proposals WHERE id=?').get(id) as
        { state: string; payload: string; project_id: string } | undefined;
      if (!row) throw new DomainError('not_found', `Proposal ${id} is unavailable`, 404);
      if (options.projectId !== undefined && row.project_id !== options.projectId)
        throw new DomainError('scope_denied', `Proposal ${id} belongs to another project`, 403);
      if (!['archived', 'rejected', 'expired'].includes(row.state))
        throw new DomainError('not_found', `Proposal ${id} is not reopenable (state ${row.state})`, 404);
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(row.payload || '{}') as Record<string, unknown>; } catch { /* cleared payload */ }
      if (payload.discovery === undefined)
        throw new DomainError('not_found', `Proposal ${id} has no retained content to reopen`, 404);
      const dueAt = this.now() + 30 * DAY;
      payload.reopened = [...(Array.isArray(payload.reopened) ? payload.reopened as unknown[] : []),
        { at: this.now(), actor: options.actor ?? 'unattributed' }];
      this.db.prepare("UPDATE proposals SET state='pending', expires_at=?, payload=? WHERE id=?")
        .run(dueAt, JSON.stringify(payload), id);
      return { state: 'pending', dueAt };
    });
  }
  /**
   * Queue an outbound item that could not be delivered.
   *
   * Called when a candidate submission or an event capture fails for a transport
   * reason. The design requires the work to survive the process, so the whole
   * request body is stored here and the eventual replay is byte-for-byte the same
   * submission.
   *
   * Two properties are deliberate:
   *
   *  - Enqueueing the same (principal, idempotency key) twice coalesces instead of
   *    stacking. An adapter that retries the enqueue after its own crash must not
   *    multiply one undelivered candidate into several, and if the item had already
   *    been delivered it is reported as such rather than re-queued.
   *  - A full outbox throws instead of evicting. Dropping the oldest item to make
   *    room would destroy a user's candidate to store a newer one, silently; the
   *    caller still holds the item it was trying to enqueue, so refusing is the one
   *    outcome that loses nothing.
   */
  enqueue(principal: string, input: { kind: 'candidate' | 'event'; projectId: string; idempotencyKey: string; payload: Record<string, unknown>; error?: string; attempts?: number }) {
    const now = this.now();
    const payload = JSON.stringify(input.payload ?? {});
    const bytes = Buffer.byteLength(payload, 'utf8');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT id,kind,status,fingerprint,attempts FROM outbox WHERE principal=? AND idem=?')
        .get(principal, input.idempotencyKey) as { id: string; kind: string; status: string; fingerprint: string; attempts: number } | undefined;
      if (existing) {
        if (existing.kind !== input.kind)
          throw new DomainError('idempotency_conflict', 'This idempotency key is already queued as a different kind of item', 409);
        if (OUTBOX_TERMINAL.includes(existing.status))
          return { id: existing.id, status: existing.status, duplicate: true, attempts: Number(existing.attempts) };
        this.db.prepare('UPDATE outbox SET payload=?, last_error=?, updated_at=? WHERE id=?')
          .run(payload, input.error ?? '', now, existing.id);
        return { id: existing.id, status: existing.status, duplicate: true, attempts: Number(existing.attempts) };
      }
      const totals = this.db.prepare("SELECT count(*) AS n, COALESCE(sum(length(payload)),0) AS bytes FROM outbox WHERE status IN ('pending','failed')")
        .get() as { n: number; bytes: number };
      if (Number(totals.n) >= OUTBOX_MAX_ENTRIES)
        throw new DomainError('outbox_full', `Outbox already holds ${totals.n} undelivered items; deliver or purge some before queueing more`, 507);
      if (Number(totals.bytes) + bytes > OUTBOX_MAX_BYTES)
        throw new DomainError('outbox_full', `Outbox would exceed its ${OUTBOX_MAX_BYTES}-byte capacity; deliver or purge some items first`, 507);
      const id = randomUUID();
      this.db.prepare(`INSERT INTO outbox(id,kind,idem,fingerprint,payload,project_id,principal,created_at,attempts,next_attempt_at,last_error,status,expires_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`)
        .run(id, input.kind, input.idempotencyKey, digest(input.payload ?? {}), payload, input.projectId, principal,
          now, Math.max(0, input.attempts ?? 0), now, input.error ?? '', now + OUTBOX_TTL_MS, now);
      return { id, status: 'pending', duplicate: false, attempts: Math.max(0, input.attempts ?? 0) };
    });
  }
  /**
   * Attempt to replay queued items, returning a per-item outcome.
   *
   * The replay deliberately routes through the same `submit`/`event` entry points
   * as a first attempt rather than inserting rows directly. That is what makes the
   * original idempotency keys do their job: an item that actually reached the core
   * before the transport error is recognised as a duplicate and does not become a
   * second candidate. The fake clock and backoff come from the same `now()` the
   * rest of the store uses, so a retry window is testable without sleeping.
   *
   * Success means the item is resolved (stored or duplicate). Failure is split by
   * whether retrying can change the answer: a permanent refusal of this exact request
   * (4xx) is abandoned on the spot, while a transport or capacity fault schedules the
   * next attempt with an exponential backoff capped at one hour, and a lapsed item is
   * abandoned rather than retried again. `limit` bounds one call, so a caller whose
   * session start must stay responsive can ask for a smaller batch than the default
   * rather than waiting for fifty items to be attempted.
   */
  replayOutbox(options: { projectId?: string; limit?: number; force?: boolean } = {}): { attempted: number; delivered: Array<{ id: string; kind: string; result: string }>; failed: Array<{ id: string; kind: string; attempts: number; error: string }>; abandoned: string[] } {
    const now = this.now();
    const attempted: Array<{ id: string; kind: string; result: string }> = [];
    const failed: Array<{ id: string; kind: string; attempts: number; error: string }> = [];
    const abandoned: string[] = [];
    const rows = this.db.prepare(`SELECT id,kind,idem,payload,project_id,principal,attempts,expires_at FROM outbox
      WHERE status IN ('pending','failed') AND (? OR next_attempt_at<=?) AND (? IS NULL OR project_id=?)
      ORDER BY created_at LIMIT ?`)
      .all(options.force ? 1 : 0, now, options.projectId ?? null, options.projectId ?? null, options.limit ?? 50) as Row[];
    for (const row of rows) {
      const id = String(row.id), kind = String(row.kind);
      // Expiry is evaluated before a replay, not after: an item past its deadline
      // was already given up on, and re-sending it would put week-old work into the
      // library while nobody is watching.
      if (Number(row.expires_at) <= now) {
        this.db.prepare("UPDATE outbox SET status='abandoned', last_error=?, updated_at=? WHERE id=?")
          .run('Deadline passed before the item could be delivered', now, id);
        abandoned.push(id);
        continue;
      }
      const attempts = Number(row.attempts) + 1;
      try {
        const payload = JSON.parse(String(row.payload)) as Record<string, unknown>;
        const result = kind === 'candidate'
          ? this.submit(String(row.principal), payload as never)
          : this.event(String(row.principal), payload as never);
        this.db.prepare("UPDATE outbox SET status='sent', attempts=?, last_error='', updated_at=? WHERE id=?")
          .run(attempts, now, id);
        attempted.push({ id, kind, result: 'sent' });
        void result;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'replay failed';
        if (isPermanentReplayRefusal(error)) {
          // A refusal of this exact request is not a transient fault, so the attempt
          // budget and the backoff clock are the wrong tools here: the next attempt is
          // a guaranteed repeat of this one. Spending them anyway is what produced the
          // production zombie rows, so the item is closed now instead. `last_error`
          // still carries what was refused, which is what a person needs to decide
          // whether the payload itself should be fixed and re-queued.
          this.db.prepare("UPDATE outbox SET status='abandoned', attempts=?, last_error=?, updated_at=? WHERE id=?")
            .run(attempts, `Permanent refusal: ${message}`, now, id);
          abandoned.push(id);
        } else if (attempts >= OUTBOX_MAX_ATTEMPTS) {
          this.db.prepare("UPDATE outbox SET status='abandoned', attempts=?, last_error=?, updated_at=? WHERE id=?")
            .run(attempts, message, now, id);
          abandoned.push(id);
        } else {
          // Exponential backoff from one minute, capped at an hour: a core that is
          // briefly down is retried soon, and a core that is gone for a day does not
          // wake the adapter every few seconds.
          const backoff = Math.min(60 * 60000, 60000 * 2 ** (attempts - 1));
          this.db.prepare("UPDATE outbox SET status='failed', attempts=?, last_error=?, next_attempt_at=?, updated_at=? WHERE id=?")
            .run(attempts, message, now + backoff, now, id);
          failed.push({ id, kind, attempts, error: message });
        }
      }
    }
    return { attempted: attempted.length + failed.length + abandoned.length, delivered: attempted, failed, abandoned };
  }
  /**
   * The queue state a user or adapter can act on: how many items still owe a
   * delivery, why the failing ones fail, how often they were tried, and when the
   * next attempt is due. Read-only, and scoped to one project so a queue is not
   * itself a way to enumerate another project's undelivered text.
   */
  outboxStatus(projectId?: string, limit = 200) {
    const now = this.now();
    this.abandonDueOutbox(now);
    const where = projectId === undefined ? '' : ' AND project_id=?';
    const params = projectId === undefined ? [] : [projectId];
    const counts = this.db.prepare(`SELECT status, count(*) AS n FROM outbox WHERE 1=1${where} GROUP BY status`).all(...params as string[])
      .map(row => ({ status: String(row.status), count: Number(row.n) }));
    const total = (status: string) => counts.find(c => c.status === status)?.count ?? 0;
    const items = this.db.prepare(`SELECT id,kind,idem,project_id,principal,created_at,attempts,next_attempt_at,last_error,status,expires_at
      FROM outbox WHERE status IN ('pending','failed')${where} ORDER BY next_attempt_at, created_at LIMIT ?`).all(...params as string[], limit)
      .map(row => ({
        id: String(row.id), kind: String(row.kind), idempotencyKey: String(row.idem),
        projectId: String(row.project_id), principal: String(row.principal),
        createdAt: Number(row.created_at), attempts: Number(row.attempts),
        nextAttemptAt: Number(row.next_attempt_at), lastError: String(row.last_error) || null,
        status: String(row.status), expiresAt: Number(row.expires_at),
      }));
    return {
      pending: total('pending'), failed: total('failed'), sent: total('sent'), abandoned: total('abandoned'),
      due: items.filter(item => item.nextAttemptAt <= now).length,
      capacity: { maxEntries: OUTBOX_MAX_ENTRIES, maxBytes: OUTBOX_MAX_BYTES, ttlMs: OUTBOX_TTL_MS },
      items,
    };
  }
  /**
   * Administrative removal.
   *
   * The design asks for a purge, but a purge that could delete an undelivered
   * candidate outright would be the silent-loss path the queue exists to prevent,
   * so the default only clears items that are already resolved or given up on and
   * reports what a full purge would have destroyed. `includePending` is the
   * caller saying it understands that, and still returns the discarded items so
   * the decision is visible in the response rather than implied by a count.
   */
  purgeOutbox(options: { projectId?: string; includePending?: boolean } = {}): { removed: number; discarded: Array<{ id: string; kind: string; status: string }> } {
    const where = options.projectId === undefined ? '' : ' AND project_id=?';
    const params = options.projectId === undefined ? [] : [options.projectId];
    const scope = options.includePending ? '' : " AND status IN ('sent','abandoned')";
    const rows = this.db.prepare(`SELECT id,kind,status FROM outbox WHERE 1=1${where}${scope}`).all(...params as string[]);
    const discarded = rows.map(row => ({ id: String(row.id), kind: String(row.kind), status: String(row.status) }));
    if (discarded.length) {
      const ids = rows.map(row => String(row.id));
      this.db.prepare(`DELETE FROM outbox WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    }
    return { removed: discarded.length, discarded };
  }
  /**
   * Abandon items whose deadline passed, without delivering them.
   *
   * Called on status reads and on cleanup so the queue cannot contain an item that
   * looks deliverable but is past its deadline. Marked, never deleted: "we held
   * this for a week and gave up" is a fact the user is entitled to see.
   */
  private abandonDueOutbox(now: number): number {
    const result = this.db.prepare("UPDATE outbox SET status='abandoned', last_error=?, updated_at=? WHERE status IN ('pending','failed') AND expires_at<=?")
      .run('Deadline passed before the item could be delivered', now, now);
    return Number(result.changes);
  }
  allEntries() { return this.current(); }
  /**
   * The library as it stood at one moment.
   *
   * Every revision is kept together with its `created_at`, so the data needed to answer
   * "what did this say back then" has always been in the library - only the query was
   * missing. Without it that question could only be answered by walking one entry's
   * history at a time.
   *
   * For each entry this returns the newest revision whose timestamp is at or before the
   * given moment. An entry whose *first* revision came later is absent from the result,
   * which is the honest answer rather than an omission: it had not been written yet.
   *
   * The comparison is inclusive, so passing a revision's own timestamp includes it.
   */
  asOf(at: number): Entry[] {
    return this.db.prepare(`SELECT k.id,r.revision AS head,'active' AS status,r.content
      FROM knowledge k JOIN revisions r ON k.id=r.id
      WHERE r.created_at<=? AND r.revision=(
        SELECT MAX(r2.revision) FROM revisions r2 WHERE r2.id=k.id AND r2.created_at<=?)
      ORDER BY k.id`).all(at, at).map(row => this.decode(row));
  }
  /**
   * Promote a reviewed proposal.
   *
   * Promotion is never derived from the discovery text: a reviewer supplies the
   * full structured entry, and its own baseRevision still passes the import CAS.
   * The proposal state change and the new revision commit in one transaction.
   *
   * Two guards exist because the reviewer's entry was previously unconstrained:
   *
   *  - the entry cannot be wider than the proposal that triggered it. A proposal
   *    carries a project, so writing a `global` entry from it would silently make
   *    one project's insight apply to every project. That is the escalation the
   *    plan reserves for an explicit user decision, so it needs the caller to say
   *    so via `allowGlobalScope`.
   *  - when the proposal named a target workflow, the entry must be that entry.
   *    Otherwise an unrelated entry could be approved under its cover.
   *
   * A third guard, added later, is the classification gate in the body below:
   * `allowGlobalScope` widens one project's knowledge, while a candidate whose stored
   * verdict cannot promote itself must not be adopted on a bare click at all — from any
   * entry point, which is why it is enforced here and not in a client.
   */
  approveProposal(id: string, entry: KnowledgeDraft, options: { allowGlobalScope?: boolean; actor?: string; projectId?: string; classificationAcknowledged?: boolean } = {}): number {
    const validated = knowledgeSchema.parse(entry);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT state,payload,project_id FROM proposals WHERE id=?').get(id) as
        { state: string; payload: string; project_id: string } | undefined;
      if (!row || row.state !== 'pending') throw new DomainError('not_found', 'Proposal not found or not pending', 404);
      // The outer credential check looked at the envelope's projectId, never at the
      // *proposal* being approved. Without this a credential for one project could
      // act on another project's candidate merely by naming its id.
      if (options.projectId !== undefined && row.project_id !== options.projectId)
        throw new DomainError('scope_denied', `Proposal ${id} belongs to another project`, 403);

      const payload = JSON.parse(row.payload || '{}') as { projectId?: string; workflowId?: string; baseRevision?: number; classification?: unknown };
      /**
       * The review gate, enforced where the write happens.
       *
       * It used to live in one client (the DSH adapter's `autoPromotable === false`
       * test), which meant the web page approved anything, the batch endpoint approved
       * N at once, and a candidate whose snapshot predated the field was promoted by a
       * single click — so the rule "an experience is not promoted into a rule by one
       * click" held for new candidates and for one door only, while 255 stored
       * candidates classified `norm` fell straight through.
       *
       * A verdict that says `autoPromotable: true` keeps the ordinary path. Anything
       * else — an explicit `false`, or a snapshot that cannot answer at all — needs the
       * request to say, explicitly, that a person acknowledged the kind and the scope.
       * `classificationAcknowledged` is therefore optional in the request (no caller
       * breaks) and load-bearing here: its absence is a refusal, never a pass, because
       * "the program has no opinion" is a reason to ask a person, not a reason to
       * proceed.
       */
      const gate = classificationApprovalGate(payload.classification);
      if (gate.required && options.classificationAcknowledged !== true) {
        throw new DomainError('classification_confirmation_required',
          `该候选不能在没有人工确认的情况下采纳：${gate.reason}`
          + '请人工核对类别与作用域；确认后在请求体里带上 classificationAcknowledged: true 重试。', 409);
      }
      const proposalProject = payload.projectId;
      const scope = validated.scope;

      // Re-compare the base the proposal was submitted against with the entry's
      // current revision. The import CAS below only checks the *reviewer's* claimed
      // baseRevision, so a reviewer who quietly bumps that number could approve a
      // proposal made against a version that no longer exists, with no record that
      // a re-comparison happened. The design (§6.4, acceptance 5) requires the
      // stale proposal to be refused and kept for a fresh comparison instead.
      if (payload.workflowId !== undefined && payload.baseRevision !== undefined) {
        const target = this.head(payload.workflowId);
        if (target && target.revision !== payload.baseRevision) {
          throw new DomainError('revision_conflict',
            `Proposal was based on ${payload.workflowId}@${payload.baseRevision} but the entry is now at ${target.revision}; re-compare before approving`, 409);
        }
      }

      if (proposalProject) {
        if (scope.kind === 'global') {
          // Only a *widening* to global needs an explicit decision. Revising an
          // entry that was already global is not an escalation, and demanding the
          // flag there would block ordinary revision work. A foreign target is not
          // a revision of the proposal's own entry, so it always needs the flag —
          // otherwise touching another project's global entry looked like routine
          // work while changing what every project reads.
          const existing = this.head(validated.id);
          const wasGlobal = existing?.content.scope.kind === 'global';
          const foreignTarget = existing !== undefined && !wasGlobal
            && (existing.content.scope.kind !== 'global' && existing.content.scope.projectId !== proposalProject);
          if ((!wasGlobal || foreignTarget) && options.allowGlobalScope !== true) {
            throw new DomainError('scope_denied',
              'This proposal is project-scoped; promoting the entry to global would apply one project\'s knowledge everywhere. Pass allowGlobalScope to do that deliberately.', 403);
          }
        } else if (scope.projectId !== proposalProject) {
          throw new DomainError('scope_denied',
            'The approved entry is scoped to a different project than its proposal', 403);
        }
        if (payload.workflowId && validated.id !== payload.workflowId) {
          throw new DomainError('target_mismatch',
            `The proposal targets ${payload.workflowId} but the entry is ${validated.id}`, 409);
        }
      }

      const revision = this.importInsideTransaction([validated]);
      // The audit trail the design requires: who decided, when, and on what basis.
      // It lives in the payload so a cleared payload cannot erase the decision, and
      // the state change commits with it.
      this.writeDecision(id, row.payload, { action: 'approved', state: 'approved', actor: options.actor, at: this.now(), note: 'Entry promoted and effective' });
      return revision;
    });
  }
  /**
   * Record a review decision inside the proposal payload, and move the row's state.
   *
   * A missing actor is stored as an explicit "unattributed" rather than omitted, so
   * a reader cannot mistake an old row for one that was properly attributed.
   */
  private writeDecision(id: string, rawPayload: string, decision: { action: string; state: string; actor?: string; at: number; reason?: string; note?: string }): void {
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(rawPayload || '{}') as Record<string, unknown>; } catch { /* keep empty */ }
    payload.decision = {
      action: decision.action,
      actor: decision.actor ?? 'unattributed',
      at: decision.at,
      ...(decision.reason ? { reason: decision.reason } : {}),
      ...(decision.note ? { note: decision.note } : {}),
    };
    this.db.prepare('UPDATE proposals SET state=?, payload=? WHERE id=?').run(decision.state, JSON.stringify(payload), id);
  }
  /**
   * Reject a proposal, keeping it readable for ninety days.
   *
   * The design gives a rejected proposal a retention period rather than keeping the
   * text forever. The state stays afterwards, so the fact that something was
   * proposed and refused survives; only the content lapses. That distinction matters
   * for an audit: "a claim was made and rejected on this date" remains true and
   * checkable long after the claim's text has been cleared.
   *
   * The reason and the operator are recorded (design §6.2, P2.2): a refusal without
   * a reason cannot be told apart from neglect, and the submitter is told why.
   */
  rejectProposal(id: string, options: { reason?: string; actor?: string; projectId?: string } = {}): void {
    this.transaction(() => {
      const row = this.db.prepare('SELECT payload,project_id FROM proposals WHERE id=?').get(id) as { payload: string; project_id: string } | undefined;
      if (!row) throw new DomainError('not_found', 'Proposal not found or not pending', 404);
      if (options.projectId !== undefined && row.project_id !== options.projectId)
        throw new DomainError('scope_denied', `Proposal ${id} belongs to another project`, 403);
      const result = this.db.prepare("UPDATE proposals SET state='rejected', expires_at=? WHERE id=? AND state='pending'")
        .run(this.now() + 90 * DAY, id);
      if (!result.changes) throw new DomainError('not_found', 'Proposal not found or not pending', 404);
      this.writeDecision(id, row.payload, { action: 'rejected', state: 'rejected', actor: options.actor, at: this.now(), reason: options.reason });
    });
  }
  /**
   * Mark a proposal as needing more evidence.
   *
   * The design requires this fourth outcome beside approve and reject. It exists
   * because the honest answer to a plausible but unsupported claim is neither: the
   * claim may be true, so rejecting it loses information, and approving it would
   * record an unverified statement as knowledge. The deadline comes from the design
   * (thirty days), after which the proposal is archived rather than silently living
   * on in the queue.
   */
  requestEvidence(id: string, reason: string, options: { actor?: string; projectId?: string } = {}): { state: string; dueAt: number } {
    const text = reason.trim();
    if (!text) throw new DomainError('invalid_request', 'A request for evidence must say what is missing', 400);
    return this.transaction(() => {
      const dueAt = this.now() + 30 * DAY;
      // The reason is stored in the payload so a later reader can see what was asked
      // for; without it the item comes back with no explanation of why it was held.
      const row = this.db.prepare('SELECT payload,project_id FROM proposals WHERE id=?').get(id) as { payload: string; project_id: string } | undefined;
      if (!row) throw new DomainError('not_found', 'Proposal is unavailable', 404);
      if (options.projectId !== undefined && row.project_id !== options.projectId)
        throw new DomainError('scope_denied', `Proposal ${id} belongs to another project`, 403);
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(row.payload) as Record<string, unknown>; } catch { /* keep empty */ }
      payload.evidenceRequest = { reason: text.slice(0, 500), requestedAt: this.now(), dueAt, actor: options.actor ?? 'unattributed' };
      const result = this.db.prepare("UPDATE proposals SET state='needs_evidence', expires_at=?, payload=? WHERE id=? AND state='pending'")
        .run(dueAt, JSON.stringify(payload), id);
      if (!result.changes) throw new DomainError('not_found', 'Proposal not found or not pending', 404);
      return { state: 'needs_evidence', dueAt };
    });
  }
  /**
   * Return a proposal held for evidence to the review queue.
   *
   * The design (E13) requires new evidence to trigger a re-review rather than
   * leaving the item stranded in `needs_evidence` until it is archived. The new
   * evidence is recorded, the state returns to `pending`, and a fresh thirty-day
   * window starts; repeated holds are counted so a proposal cannot loop forever
   * without the count being visible.
   */
  supplementEvidence(id: string, evidence: string, options: { actor?: string; projectId?: string } = {}): { state: string; dueAt: number; holds: number } {
    const text = evidence.trim();
    if (!text) throw new DomainError('invalid_request', 'New evidence must be described', 400);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT state,payload,project_id FROM proposals WHERE id=?').get(id) as
        { state: string; payload: string; project_id: string } | undefined;
      if (!row) throw new DomainError('not_found', 'Proposal is unavailable', 404);
      if (options.projectId !== undefined && row.project_id !== options.projectId)
        throw new DomainError('scope_denied', `Proposal ${id} belongs to another project`, 403);
      if (row.state !== 'needs_evidence') throw new DomainError('not_found', 'Proposal is not awaiting evidence', 404);
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(row.payload || '{}') as Record<string, unknown>; } catch { /* keep empty */ }
      const prior = Array.isArray(payload.supplements) ? payload.supplements as unknown[] : [];
      payload.supplements = [...prior, { evidence: text.slice(0, 2000), at: this.now(), actor: options.actor ?? 'unattributed' }];
      const dueAt = this.now() + 30 * DAY;
      const supplements = payload.supplements as unknown[];
      this.db.prepare("UPDATE proposals SET state='pending', expires_at=?, payload=? WHERE id=?")
        .run(dueAt, JSON.stringify(payload), id);
      return { state: 'pending', dueAt, holds: supplements.length };
    });
  }
  /**
   * Which of these candidates cannot be approved without an explicit acknowledgement.
   *
   * Read-only, and it answers with the same function the write path enforces, so a
   * batch entry point can tell a person "N of these need your confirmation" *before*
   * anything is written, and cannot disagree with what the write would refuse. Ids that
   * do not exist, or that belong to another project, are not reported here: the write
   * path already refuses those with their own error, and inventing a second verdict for
   * them would only shadow it.
   */
  classificationGateFor(projectId: string, ids: string[]): Array<{ id: string; gate: ClassificationGate }> {
    const required: Array<{ id: string; gate: ClassificationGate }> = [];
    for (const id of ids) {
      const row = this.db.prepare('SELECT payload,project_id FROM proposals WHERE id=?').get(id) as
        { payload: string | null; project_id: string } | undefined;
      if (!row || row.project_id !== projectId) continue;
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(row.payload || '{}') as Record<string, unknown>; } catch { /* an unreadable row cannot speak for itself, so it needs confirmation */ }
      const gate = classificationApprovalGate(payload.classification);
      if (gate.required) required.push({ id, gate });
    }
    return required;
  }
  /**
   * Backfill the stored classification of the candidates still waiting for review.
   *
   * `payload.classification` is a snapshot from submission time, and nothing recomputed
   * it after the classifier was fixed: 255 of 360 pending candidates still said `norm`
   * while the current classifier answers about 13. Both numbers were true — one was
   * "what a recomputation would say", the other "what the user sees" — and only the
   * second one decides what happens in the review queue.
   *
   * The recomputation calls the same `classifyCandidate` the submission path calls, over
   * the same library slice (`classificationCandidates`), and stamps the result with
   * `CLASSIFIER_VERSION` and a digest of the text it was computed from. Three
   * consequences are deliberate:
   *
   *  - **dry run is the default.** The report is a before/after distribution plus the
   *    first few changed rows; `apply: true` is what writes.
   *  - **idempotent.** A snapshot whose version and text digest are current is skipped
   *    and counted, so re-running reports "everything skipped" instead of rewriting.
   *  - **only the verdict moves.** Rows that are not `pending` are not read at all, and
   *    for the rows that are, only `classification` is replaced — `state`, `discovery`,
   *    the review decision and the attribution are untouched, and the replaced snapshot
   *    is kept under `classificationPrevious` so the change stays auditable. An adopted
   *    entry is never a candidate and is therefore never in scope.
   */
  reclassifyPending(projectId: string, options: { apply?: boolean; limit?: number } = {}): {
    projectId: string; applied: boolean; classifierVersion: string;
    scanned: number; skipped: number; changed: number; unreadable: number;
    before: Record<string, number>; after: Record<string, number>;
    beforeAutoPromotable: Record<string, number>; afterAutoPromotable: Record<string, number>;
    changes: Array<{ id: string; from: string; to: string; autoPromotableBefore: boolean | null; autoPromotableAfter: boolean | null; reason: string }>;
    note: string;
  } {
    const rows = this.db.prepare("SELECT id,payload FROM proposals WHERE project_id=? AND state='pending' ORDER BY created_at")
      .all(projectId) as Array<{ id: string; payload: string | null }>;
    const limit = options.limit === undefined ? 20 : Math.max(0, options.limit);
    const before: Record<string, number> = {};
    const after: Record<string, number> = {};
    const beforeAuto: Record<string, number> = {};
    const afterAuto: Record<string, number> = {};
    const changes: Array<{ id: string; from: string; to: string; autoPromotableBefore: boolean | null; autoPromotableAfter: boolean | null; reason: string }> = [];
    const count = (bag: Record<string, number>, key: string) => { bag[key] = (bag[key] ?? 0) + 1; };
    const autoKey = (value: boolean | null | undefined) => value === true ? 'true' : value === false ? 'false' : 'missing';
    let skipped = 0;
    let changed = 0;
    let unreadable = 0;
    const writes: Array<{ id: string; payload: string }> = [];

    for (const row of rows) {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(row.payload || '{}') as Record<string, unknown>; } catch { payload = {}; }
      const stored = payload.classification && typeof payload.classification === 'object' && !Array.isArray(payload.classification)
        ? payload.classification as Record<string, unknown> : null;
      const storedKind = stored && typeof stored.kind === 'string' ? stored.kind : 'none';
      const storedAuto = stored && typeof stored.autoPromotable === 'boolean' ? stored.autoPromotable : null;
      count(before, storedKind);
      count(beforeAuto, autoKey(storedAuto));

      const text = typeof payload.discovery === 'string' ? payload.discovery : '';
      if (text.trim() === '') {
        // Without text there is nothing to classify; the row is reported, not rewritten.
        unreadable += 1;
        count(after, storedKind);
        count(afterAuto, autoKey(storedAuto));
        continue;
      }
      const upToDate = stored !== null
        && stored.classifierVersion === CLASSIFIER_VERSION
        && stored.textDigest === digest(text.trim());
      if (upToDate) {
        skipped += 1;
        count(after, storedKind);
        count(afterAuto, autoKey(storedAuto));
        continue;
      }

      const next = this.classifyForStorage(text, projectId);
      const nextKind = typeof next.kind === 'string' ? next.kind : 'none';
      const nextAuto = typeof next.autoPromotable === 'boolean' ? next.autoPromotable : null;
      count(after, nextKind);
      count(afterAuto, autoKey(nextAuto));
      changed += 1;
      if (nextKind !== storedKind || nextAuto !== storedAuto) {
        changes.push({
          id: row.id, from: storedKind, to: nextKind,
          autoPromotableBefore: storedAuto, autoPromotableAfter: nextAuto,
          reason: typeof next.promotionBlockedReason === 'string' ? next.promotionBlockedReason
            : (nextAuto === true ? '可自动升格' : '判定器未给出可自动升格'),
        });
      }
      if (options.apply === true) {
        writes.push({
          id: row.id,
          payload: JSON.stringify({
            ...payload,
            classification: next,
            /**
             * The replaced snapshot, kept rather than dropped.
             *
             * This is the field that makes the backfill reviewable after the fact: a
             * reader can see that a verdict changed, which classifier produced the old
             * one (usually none — that is the whole reason the row was stale) and when.
             * Nothing else in the payload is touched.
             */
            classificationPrevious: {
              ...(stored ?? {}),
              classifierVersion: stored && typeof stored.classifierVersion === 'string' ? stored.classifierVersion : null,
              replacedAt: this.now(),
            },
          }),
        });
      }
    }

    if (writes.length) {
      this.transaction(() => {
        const update = this.db.prepare('UPDATE proposals SET payload=? WHERE id=? AND state=\'pending\'');
        for (const write of writes) update.run(write.payload, write.id);
      });
    }

    return {
      projectId, applied: options.apply === true, classifierVersion: CLASSIFIER_VERSION,
      scanned: rows.length, skipped, changed, unreadable,
      before, after, beforeAutoPromotable: beforeAuto, afterAutoPromotable: afterAuto,
      changes: changes.slice(0, limit),
      note: options.apply === true
        ? `已回填 ${writes.length} 条候选的分类判定（state/discovery 与已采纳条目均未改动）；`
          + '重跑本命令应报"全部跳过"。'
        : `预演：只读取与计算，未写入任何一行。共扫描 ${rows.length} 条待审，其中 ${changed} 条判定会变化、${skipped} 条已是当前判定器版本。`
          + '确认分布无误后加 --yes（或 apply: true）才会写入。',
    };
  }
  /**
   * Apply one decision to many proposals.
   *
   * The design asks for batch operations so a user is not interrupted per candidate.
   * Each proposal is handled on its own so one failure cannot strand the rest, and
   * the outcome is reported per id rather than as a single count — a batch that says
   * "5 approved" while two were refused for a stale base revision teaches the user
   * nothing about which two.
   */
  reviewBatch(projectId: string, input: {
    action: 'approve' | 'reject' | 'archive' | 'request-evidence';
    ids: string[];
    /** Required for approve: the reviewer-supplied entry for each id. */
    entries?: Record<string, KnowledgeDraft>;
    /** Required for request-evidence. */
    reason?: string;
    allowGlobalScope?: boolean;
    /**
     * Whether the reviewer acknowledged the classification of every candidate in this
     * batch that needs it.
     *
     * One flag for the batch, but not one verdict: each id is still gated on its own
     * stored classification, so a batch that mixes an ordinary candidate with one whose
     * verdict cannot promote itself reports the second as failed instead of smuggling
     * it through on the first one's merits.
     */
    classificationAcknowledged?: boolean;
  }): { applied: string[]; failed: Array<{ id: string; message: string }> } {
    const applied: string[] = [];
    const failed: Array<{ id: string; message: string }> = [];
    for (const id of input.ids) {
      try {
        // Every id is checked against the project before anything is written: a batch
        // is exactly where an id from another project would otherwise slip through,
        // since the caller supplies them as a list. Read from the column so a cleared
        // payload cannot make a foreign row look unattributable and slip past.
        const row = this.db.prepare('SELECT project_id FROM proposals WHERE id=?').get(id) as { project_id: string } | undefined;
        if (!row) throw new DomainError('not_found', 'Proposal is unavailable', 404);
        if (row.project_id !== projectId) throw new DomainError('scope_denied', `Proposal ${id} belongs to another project`, 403);

        if (input.action === 'reject') this.rejectProposal(id, { projectId });
        else if (input.action === 'archive') this.archiveProposal(id, { projectId });
        else if (input.action === 'request-evidence') this.requestEvidence(id, input.reason ?? '', { projectId });
        else {
          const entry = input.entries?.[id];
          if (!entry) throw new DomainError('invalid_request', `No entry supplied for ${id}`, 400);
          this.approveProposal(id, entry, { allowGlobalScope: input.allowGlobalScope, projectId, classificationAcknowledged: input.classificationAcknowledged });
        }
        applied.push(id);
      } catch (error) {
        failed.push({ id, message: error instanceof Error ? error.message : 'failed' });
      }
    }
    return { applied, failed };
  }
  /**
   * Take a proposal out of the queue without deciding it.
   *
   * Distinct from rejecting: the claim is not judged false, it is set aside so the
   * queue reflects what someone intends to act on. The row is kept, because the
   * design requires rejected and archived items to remain readable rather than
   * disappearing when they leave the working list.
   */
  archiveProposal(id: string, options: { projectId?: string } = {}): void {
    this.transaction(() => {
      const row = this.db.prepare('SELECT project_id FROM proposals WHERE id=?').get(id) as { project_id: string } | undefined;
      if (!row) throw new DomainError('not_found', 'Proposal not found or not reviewable', 404);
      if (options.projectId !== undefined && row.project_id !== options.projectId)
        throw new DomainError('scope_denied', `Proposal ${id} belongs to another project`, 403);
      const result = this.db.prepare("UPDATE proposals SET state='archived' WHERE id=? AND state IN ('pending','needs_evidence')").run(id);
      if (!result.changes) throw new DomainError('not_found', 'Proposal not found or not reviewable', 404);
    });
  }
  /**
   * Expire proposals whose deadline has passed.
   *
   * Two deadlines with different meanings, which is why they are handled together
   * here rather than as one sweep:
   *
   *   - a pending proposal that was never reviewed lapses after its window;
   *   - a needs_evidence proposal is archived when the request goes unanswered,
   *     which is what the design means by a thirty-day automatic archive.
   *
   * Neither is deleted. The design requires the record to survive so a later reader
   * can see what was proposed and that it was never resolved.
   *
   * An *important* conflict is exempt from the ordinary pending deadline. §6.3 says
   * a serious normative conflict stays in the queue for a decision and the waiting
   * period does not pick a side, so letting the same thirty days clear its text and
   * mark it `expired` silently dropped the one candidate a human was meant to rule
   * on. Such a proposal carries `important: true` and a non-lapsing deadline; it is
   * only ever resolved by an explicit decision.
   */
  expireProposals(): { expired: string[]; archived: string[]; clearedRejected: string[] } {
    const now = this.now();
    return this.transaction(() => {
      const expired = this.db.prepare("SELECT id FROM proposals WHERE state='pending' AND expires_at<=? AND payload NOT LIKE '%\"important\":true%'")
        .all(now).map(row => String((row as { id: string }).id));
      this.db.prepare("UPDATE proposals SET state='expired', payload='{}' WHERE state='pending' AND expires_at<=? AND payload NOT LIKE '%\"important\":true%'").run(now);
      const archived = this.db.prepare("SELECT id FROM proposals WHERE state='needs_evidence' AND expires_at<=? AND payload NOT LIKE '%\"important\":true%'")
        .all(now).map(row => String((row as { id: string }).id));
      this.db.prepare("UPDATE proposals SET state='archived' WHERE state='needs_evidence' AND expires_at<=? AND payload NOT LIKE '%\"important\":true%'").run(now);
      // A rejected proposal's text lapses after its ninety days; the state remains,
      // so the record still says a claim was made and refused.
      const clearedRejected = this.db.prepare("SELECT id FROM proposals WHERE state='rejected' AND expires_at<=? AND payload<>'{}'")
        .all(now).map(row => String((row as { id: string }).id));
      this.db.prepare("UPDATE proposals SET payload='{}' WHERE state='rejected' AND expires_at<=?").run(now);
      return { expired, archived, clearedRejected };
    });
  }
  /**
   * How long a task may record nothing before the core stops calling it live.
   *
   * A session ends and its task stays `in_progress` forever, because nothing in
   * the store ever read the passage of time: the only status writes came from a
   * caller, so a session that simply stopped left a live-looking task behind. A
   * real library showed the shape of that — 51 `in_progress` and 80 `paused`
   * against 12 `completed`, i.e. the task list had stopped describing work and
   * was accumulating it.
   *
   * Twelve hours is the threshold because it is longer than any ordinary break
   * one session takes (a night, a long meeting, a build) and shorter than the
   * spans that actually piled up: measured against this machine's library, every
   * stalled task was already more than twelve hours old, so the rule converges
   * the abandoned ones without touching the 6 that were still within the hour.
   * Erring short would mislabel live work, and the cost of erring long is only
   * that the list stays untidy a while longer — so the idle threshold is the
   * conservative side of the trade.
   */
  taskIdleConvergeMs(): number {
    return this.taskConvergenceThreshold('taskIdleConvergeMs', TASK_IDLE_CONVERGE_MS);
  }
  /**
   * How long an ended task waits before its own diary is filed under it.
   *
   * The task scope is the "this time only" layer, and it had no data: 0 task-scoped
   * entries in a real library against 143 tasks, because the core's own diary is
   * written at project scope and no other core path ever emitted that scope. Two
   * days after the last activity is long enough that the archive is not competing
   * with a session that is merely paused overnight, and short enough that reading
   * "what did that session leave behind" works on the same day the task dies.
   */
  taskArchiveAfterMs(): number {
    return this.taskConvergenceThreshold('taskArchiveAfterMs', TASK_ARCHIVE_AFTER_MS);
  }
  private taskConvergenceThreshold(key: string, fallback: number): number {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: number } | undefined;
    const value = row ? Number(row.value) : Number.NaN;
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  }
  /** Both thresholds at once, so a caller reports the values it actually applied. */
  taskConvergence(): { idleMs: number; archiveAfterMs: number } {
    return { idleMs: this.taskIdleConvergeMs(), archiveAfterMs: this.taskArchiveAfterMs() };
  }
  setTaskConvergence(input: { idleMs?: number; archiveAfterMs?: number }) {
    const current = this.taskConvergence();
    const idleMs = input.idleMs ?? current.idleMs;
    const archiveAfterMs = input.archiveAfterMs ?? current.archiveAfterMs;
    if (!Number.isSafeInteger(idleMs) || idleMs < 60_000)
      throw new DomainError('invalid_interval', 'Task idle threshold must be at least one minute', 400);
    // Archiving before the task has been declared idle would file a diary for work
    // that is still being recorded, so the two are ordered rather than independent.
    if (!Number.isSafeInteger(archiveAfterMs) || archiveAfterMs < idleMs)
      throw new DomainError('invalid_interval', 'Archive delay must not be shorter than the idle threshold', 400);
    if (input.idleMs !== undefined) this.db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run('taskIdleConvergeMs', idleMs);
    if (input.archiveAfterMs !== undefined) this.db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run('taskArchiveAfterMs', archiveAfterMs);
    return this.taskConvergence();
  }
  /**
   * Task identity is a stable ID the caller owns; a task may span sessions and a
   * session may hold several tasks. Re-recording an existing ID only refreshes
   * state, so a retry never creates a duplicate diary entry.
   */
  /**
   * Record or update a task.
   *
   * Fields are merged rather than replaced when a call omits them: a call that only
   * updates the status must not erase the links an earlier call established. The
   * previous version overwrote every column with the caller's defaults, so a status
   * ping silently dropped the notes and unfinished list.
   */
  recordTask(projectId: string, payload: {
    id: string; title: string; status: TaskStatus;
    summary?: string; notes?: string; unfinished?: string[];
    sessionIds?: string[]; relatedExperiences?: string[]; relatedProposals?: string[];
    files?: string[]; verified?: string; evidence?: 'observed' | 'verifiable' | 'self-reported' | 'unverifiable';
    /** Observed state per file, so a later checkout can compare (acceptance 16). */
    fileStates?: Array<{ path: string; digest?: string; size?: number; observedAt?: number }>;
    startedAt?: number;
  }) {
    return this.transaction(() => {
      // Scoped by project: an unscoped lookup let one project's credential
      // overwrite another project's task merely by reusing its id.
      const existing = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(payload.id) as Row | undefined;
      if (existing && String(existing.project_id) !== projectId) {
        throw new DomainError('scope_denied', `Task ${payload.id} belongs to another project`, 403);
      }
      const now = this.now();
      // An explicit value wins; otherwise keep what is stored; otherwise start empty.
      const keep = <T>(given: T | undefined, column: string, parse: (raw: string) => T, fallback: T): T => {
        if (given !== undefined) return given;
        if (existing) return parse(String(existing[column]));
        return fallback;
      };
      const jsonList = (raw: string) => { try { return JSON.parse(raw) as string[]; } catch { return []; } };
      const sessionIds = keep(payload.sessionIds, 'session_ids', jsonList, []);
      const relatedExperiences = keep(payload.relatedExperiences, 'related_experiences', jsonList, []);
      const relatedProposals = keep(payload.relatedProposals, 'related_proposals', jsonList, []);
      const files = keep(payload.files, 'files', jsonList, []);
      const fileStates = keep(payload.fileStates, 'file_states', jsonList, [] as unknown[]);
      const verified = keep(payload.verified, 'verified', (raw) => raw, '');
      const evidenceLevel = keep(payload.evidence, 'evidence', (raw) => raw, 'self-reported');
      const startedAt = payload.startedAt ?? (existing ? (existing.started_at === null ? undefined : Number(existing.started_at)) : now);
      const terminal = ['completed', 'cancelled', 'failed'].includes(payload.status);

      if (existing) {
        // A task never silently moves out of a terminal state. `prepare()` calls
        // `startTaskForSession`, which used to record `in_progress` on whatever id
        // the session already owned — so one ordinary retrieval silently reopened a
        // completed task, cleared its completion time and left its old verification
        // text sitting on what now read as live work. Acceptance 11 says Stop,
        // cancel, pause and failure must not become completion, and symmetrically a
        // terminal state must not be undone by a read-path call. A genuine new
        // round of work gets a new task rather than rewriting the closed one.
        const wasTerminal = ['completed', 'cancelled', 'failed'].includes(String(existing.status));
        const openingOnly = payload.status === 'in_progress'
          && (payload.summary === undefined) && (payload.notes === undefined)
          && (payload.verified === undefined) && (payload.unfinished === undefined)
          && (payload.relatedExperiences === undefined) && (payload.relatedProposals === undefined)
          && (payload.files === undefined);
        if (wasTerminal && openingOnly) {
          return { id: payload.id, status: String(existing.status), created: false, unchanged: true };
        }
        this.db.prepare(`UPDATE tasks SET title=?,status=?,summary=?,notes=?,unfinished=?,session_ids=?,
          related_experiences=?,related_proposals=?,files=?,file_states=?,verified=?,evidence=?,started_at=?,
          knowledge_revision=?,updated_at=?,
          completed_at=CASE WHEN ? IN ('completed','cancelled','failed') THEN COALESCE(completed_at,?) ELSE NULL END
          WHERE id=? AND project_id=?`)
          .run(payload.title, payload.status,
            keep(payload.summary, 'summary', (raw) => raw, ''), keep(payload.notes, 'notes', (raw) => raw, ''),
            JSON.stringify(keep(payload.unfinished, 'unfinished', jsonList, [])),
            JSON.stringify(sessionIds), JSON.stringify(relatedExperiences), JSON.stringify(relatedProposals),
            JSON.stringify(files), JSON.stringify(fileStates), verified, evidenceLevel, startedAt ?? now,
            this.revision, now, payload.status, now, payload.id, projectId);
        return { id: payload.id, status: payload.status, created: false };
      }
      this.db.prepare(`INSERT INTO tasks(id,project_id,title,status,summary,notes,knowledge_revision,
        unfinished,session_ids,related_experiences,related_proposals,files,file_states,verified,evidence,started_at,
        created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(payload.id, projectId, payload.title, payload.status,
          payload.summary ?? '', payload.notes ?? '', this.revision,
          JSON.stringify(payload.unfinished ?? []), JSON.stringify(sessionIds),
          JSON.stringify(relatedExperiences), JSON.stringify(relatedProposals), JSON.stringify(files),
          JSON.stringify(fileStates), verified, evidenceLevel, startedAt ?? now, now, now, terminal ? now : null);
      return { id: payload.id, status: payload.status, created: true };
    });
  }
  tasks(projectId: string, status?: TaskStatus) {
    const query = status
      ? 'SELECT * FROM tasks WHERE project_id=? AND status=? ORDER BY updated_at DESC'
      : 'SELECT * FROM tasks WHERE project_id=? ORDER BY updated_at DESC';
    const rows = status ? this.db.prepare(query).all(projectId, status) : this.db.prepare(query).all(projectId);
    const list = (raw: unknown) => { try { return JSON.parse(String(raw)) as string[]; } catch { return []; } };
    /** File states are objects, not strings, so they need their own parse. */
    const stateList = (raw: unknown): Array<{ path: string; digest?: string; size?: number; observedAt?: number }> => {
      try {
        const parsed = JSON.parse(String(raw)) as unknown;
        return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'object' && typeof (item as { path?: unknown }).path === 'string') as Array<{ path: string; digest?: string; size?: number; observedAt?: number }> : [];
      } catch { return []; }
    };
    return rows.map(row => ({
      id: String(row.id), projectId: String(row.project_id), title: String(row.title),
      status: String(row.status) as TaskStatus, summary: String(row.summary), notes: String(row.notes),
      knowledgeRevision: Number(row.knowledge_revision),
      unfinished: list(row.unfinished),
      sessionIds: list(row.session_ids), relatedExperiences: list(row.related_experiences),
      relatedProposals: list(row.related_proposals), files: list(row.files),
      fileStates: stateList(row.file_states),
      verified: String(row.verified ?? ''),
      evidence: String(row.evidence ?? 'self-reported') as 'observed' | 'verifiable' | 'self-reported' | 'unverifiable',
      startedAt: row.started_at === null || row.started_at === undefined ? null : Number(row.started_at),
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
      completedAt: row.completed_at === null ? null : Number(row.completed_at),
    }));
  }
  getTask(id: string, projectId: string) { return this.tasks(projectId).find(task => task.id === id); }
  /**
   * Find the active task a session is working on.
   *
   * The design requires a task to be associable across sessions, and forbids using a
   * window title as the identity. Looking the session up in `session_ids` is what
   * makes "one task, several sessions" work: a later session sees the task a former
   * one started rather than opening a new one each time.
   */
  taskForSession(projectId: string, sessionId: string) {
    return this.tasks(projectId).find(task =>
      task.sessionIds.includes(sessionId)
      && (task.status === 'in_progress' || task.status === 'paused'));
  }
  /**
   * Associate a session with a task, creating the task if this is its first session.
   *
   * Called when a session begins work. Without it the design's automatic recording
   * has nothing to record against: every session would start a fresh task and the
   * cross-session link would never exist.
   *
   * The deterministic id is per (project, session), so a session that finished a
   * task and then starts new work collides with the closed one. Reusing it would
   * silently reopen a terminal task, so a new task with a distinct id is created
   * instead — the closed one keeps its status and its completion time, which is
   * what acceptance 11 requires.
   */
  startTaskForSession(projectId: string, sessionId: string, title: string) {
    const existing = this.taskForSession(projectId, sessionId);
    if (existing) {
      if (!existing.sessionIds.includes(sessionId)) {
        this.recordTask(projectId, {
          id: existing.id, title: existing.title, status: existing.status,
          sessionIds: [...existing.sessionIds, sessionId],
        });
      }
      return { id: existing.id, created: false };
    }
    // A session with no task gets one, named from the session so the diary has a
    // subject rather than an opaque id.
    const base = `task-${createHash('sha256').update(`${projectId}\n${sessionId}`).digest('hex').slice(0, 16)}`;
    const prior = this.getTask(base, projectId);
    if (prior) {
      if (['completed', 'cancelled', 'failed'].includes(prior.status)) {
        // The session already closed this task. A fresh round of work is a new task
        // rather than a rewrite of the closed record.
        const reopened = this.tasks(projectId).filter(task => task.id.startsWith(`${base}-r`));
        const id = `${base}-r${reopened.length + 1}`;
        this.recordTask(projectId, {
          id, title: title.slice(0, 200) || prior.title, status: 'in_progress',
          sessionIds: [sessionId], startedAt: this.now(),
        });
        return { id, created: true };
      }
      this.recordTask(projectId, {
        id: base, title: prior.title, status: 'in_progress',
        sessionIds: [...new Set([...prior.sessionIds, sessionId])],
      });
      return { id: base, created: false };
    }
    this.recordTask(projectId, {
      id: base, title: title.slice(0, 200) || '未命名任务', status: 'in_progress',
      sessionIds: [sessionId], startedAt: this.now(),
    });
    return { id: base, created: true };
  }
  private reflectionReceipt(principal: string, key: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(`checkpoint:${digest([principal, key])}`);
    return row ? JSON.parse(String(row.value)) : {};
  }
  /** Persist a task checkpoint and its factual journal in the same transaction. */
  checkpointTask(principal: string, input: {
    projectId: string; sessionId?: string; taskId?: string; title?: string; idempotencyKey?: string;
    status?: TaskStatus; summary?: string; notes?: string; unfinished?: string[];
    verified?: string; evidence?: 'observed' | 'verifiable' | 'self-reported' | 'unverifiable';
    files?: string[]; relatedExperiences?: string[]; relatedProposals?: string[];
  }): Record<string, unknown> {
    return this.transaction(() => {
      const fingerprint = digest(input);
      const prior = input.idempotencyKey ? this.reflectionReceipt(principal, input.idempotencyKey) : {};
      if (prior.journalId) {
        if (prior.fingerprint !== fingerprint) throw new DomainError('idempotency_conflict', 'Checkpoint key already has different content', 409);
        return { ...prior, duplicate: true };
      }
      if (!input.taskId && !input.sessionId) throw new DomainError('invalid_task', 'taskId or sessionId is required');
      let task = input.taskId ? this.getTask(input.taskId, input.projectId)
        : this.taskForSession(input.projectId, input.sessionId!)
          ?? this.tasks(input.projectId).filter(task => task.sessionIds.includes(input.sessionId!)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (input.taskId && !task) throw new DomainError('not_found', 'Task is unavailable', 404);
      if (!task) {
        const started = this.startTaskForSession(input.projectId, input.sessionId!, input.title || '会话工作任务');
        task = this.getTask(started.id, input.projectId)!;
      }
      // A host stop is not a completion claim and cannot reopen a closed task.
      const terminal = ['completed', 'failed', 'cancelled'].includes(task.status);
      const status = terminal && (!input.status || input.status === 'paused') ? task.status : (input.status ?? 'paused');
      if (input.status === 'completed' && (!input.verified?.trim() || !['observed', 'verifiable'].includes(input.evidence ?? '')))
        throw new DomainError('verification_required', 'Completed checkpoints require verified text and verifiable evidence');
      this.recordTask(input.projectId, { ...input, id: task.id, title: input.title ?? task.title, status,
        sessionIds: input.sessionId ? [...new Set([...task.sessionIds, input.sessionId])] : task.sessionIds });
      const journal = this.writeJournal(task.id, input.projectId);
      const receipt = { stored: true, taskId: task.id, ...journal, duplicate: false, fingerprint };
      if (input.idempotencyKey) this.db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)')
        .run(`checkpoint:${digest([principal, input.idempotencyKey])}`, JSON.stringify(receipt));
      return receipt;
    });
  }
  /** Inspect this task's actual event stream, submissions and durable journal. */
  taskActivity(projectId: string, input: { taskId?: string; sessionId?: string }) {
    const task = input.taskId ? this.getTask(input.taskId, projectId)
      : input.sessionId ? this.taskForSession(projectId, input.sessionId)
        ?? this.tasks(projectId).filter(task => task.sessionIds.includes(input.sessionId!)).sort((a, b) => b.updatedAt - a.updatedAt)[0] : undefined;
    if (input.taskId && !task) throw new DomainError('not_found', 'Task is unavailable', 404);
    const events = this.db.prepare('SELECT id,payload,created_at FROM events ORDER BY created_at DESC').all()
      .map(row => ({ id: String(row.id), at: Number(row.created_at), ...JSON.parse(String(row.payload)) }))
      .filter(event => event.projectId === projectId && (input.taskId ? event.taskId === input.taskId
        : input.sessionId ? event.sessionId === input.sessionId : false)).slice(0, 100);
    const proposals = this.listProposals(projectId).filter(proposal => task
      && (proposal.payload?.taskId === task.id || task.relatedProposals.includes(proposal.id)))
      .map(proposal => ({ id: proposal.id, state: proposal.state, createdAt: proposal.createdAt }));
    // The project-scoped diary only. Once a session ends, its diary is filed again at
    // task scope (below), and without this filter `find` would return whichever id
    // sorts first — the same content reported twice under two different scopes, or
    // the wrong one depending on how the task happened to be named.
    const entry = task ? this.current().find(entry => entry.content.kind === 'journal'
      && entry.content.taskId === task.id && entry.content.scope.kind !== 'task') : undefined;
    return { task: task ?? null, events, proposals,
      journal: entry ? { id: entry.id, revision: entry.revision, outcome: entry.content.kind === 'journal' ? entry.content.outcome : 'unverified' } : null,
      // The one place a task-scoped entry can be read. Retrieval refuses task scope
      // when the caller has no task in hand — that refusal is the scope's point — and
      // `getKnowledge`/`readKnowledge` go through the same rule, so without this the
      // archive would exist and be unreachable. It is the state the task scope was
      // already in before it had a write path.
      taskScoped: task ? this.taskScopedEntries(projectId, task.id) : [],
      convergence: this.taskConvergence(),
      knowledgeRevision: this.revision };
  }
  /**
   * The convergence rule: what happens to a task whose session has ended.
   *
   * Deterministic and explainable, because the alternative — a task that stays
   * `in_progress` forever — hides what actually happened. Two transitions, in
   * order, decided only by recorded time and status:
   *
   *   - `in_progress` with nothing recorded for `idleMs` becomes `paused`, and the
   *     reason the core acted is written into the task's own notes. Paused and not
   *     completed: a session that stopped is not a session that finished, and
   *     completion is only ever asserted with verified text plus a checkable
   *     evidence level, which a clock cannot supply.
   *   - anything with no activity for `archiveAfterMs` has its diary filed under
   *     the task scope, so "this time only" has data and the task's facts outlive
   *     the session. Archiving changes no status and deletes nothing.
   *
   * Terminal tasks are never rewritten: the rule that keeps a read path from
   * reopening a closed task keeps the clock from doing it too. `dryRun` answers
   * "what would change" without changing it, which is what makes the rule safe to
   * apply to a library nobody has backed up.
   */
  convergeTasks(projectId?: string, options: { now?: number; dryRun?: boolean } = {}) {
    const at = options.now ?? this.now();
    const thresholds = this.taskConvergence();
    // An unscoped call is the core's own timer, which serves every project; a
    // scoped one is a credential acting inside its own project, as the envelope
    // requires. Reading the project list from the table keeps the two identical in
    // what they decide, so one project's rule cannot differ from another's.
    const projects = projectId !== undefined ? [projectId]
      : [...new Set(this.db.prepare('SELECT DISTINCT project_id FROM tasks').all()
        .map(row => String((row as { project_id: string }).project_id)))];
    const converged: Array<{ taskId: string; projectId: string; from: TaskStatus; to: TaskStatus; idleMs: number; lastActivityAt: number; reason: string }> = [];
    const archived: Array<{ taskId: string; projectId: string; knowledgeId: string; revision: number; replaced: boolean; unchanged: boolean }> = [];
    const kept: Array<{ taskId: string; projectId: string; status: TaskStatus; idleMs: number; reason: string }> = [];
    for (const owner of projects) {
      for (const task of this.tasks(owner)) {
        const idleMs = at - task.updatedAt;
        if (['completed', 'cancelled', 'failed'].includes(task.status)) {
          kept.push({ taskId: task.id, projectId: owner, status: task.status, idleMs, reason: '终态任务不由时间规则改写' });
          continue;
        }
        const converges = task.status === 'in_progress' && idleMs >= thresholds.idleMs;
        const archives = idleMs >= thresholds.archiveAfterMs;
        if (!converges && !archives) {
          // Name the threshold that was not reached, and name it per status. The
          // previous single sentence ("still within the active window") was read by a
          // reviewer as "within 12 hours" for a task idle for 42 hours: the number was
          // right, but which window it referred to was not, and a receipt that can be
          // misread is a receipt that gets acted on wrongly.
          kept.push({ taskId: task.id, projectId: owner, status: task.status, idleMs,
            reason: task.status === 'in_progress'
              ? `距上次记录 ${Math.round(idleMs / 60000)} 分钟，未到 ${Math.round(thresholds.idleMs / 60000)} 分钟收敛阈值`
              : `距上次记录 ${Math.round(idleMs / 60000)} 分钟，状态已是 ${task.status}，未到 ${Math.round(thresholds.archiveAfterMs / 3600000)} 小时归档阈值` });
          continue;
        }
        if (converges) {
          const reason = `距上次记录已 ${(idleMs / 3600_000).toFixed(1)} 小时（阈值 ${(thresholds.idleMs / 3600_000).toFixed(1)} 小时），`
            + '会话已结束且没有新的进展记录：按会话收敛规则置为 paused。'
            + '这不是完成，也没有核实任何结果；继续这项工作时用同一 sessionId 即可找回该任务。';
          if (!options.dryRun) this.recordTask(owner, {
            id: task.id, title: task.title, status: 'paused',
            notes: appendTaskNote(task.notes, `[自动收敛 ${new Date(at).toISOString()}] ${reason}`),
          });
          converged.push({ taskId: task.id, projectId: owner, from: 'in_progress', to: 'paused',
            idleMs, lastActivityAt: task.updatedAt, reason });
        }
        if (archives) {
          // Judged on the activity before this pass: convergence refreshes
          // `updated_at`, but rewriting a status is bookkeeping, not progress.
          const filed = options.dryRun
            ? { knowledgeId: taskArchiveId(task.id), revision: 0, replaced: false, unchanged: false }
            : this.archiveTaskScope(owner, task.id, { at });
          archived.push({ taskId: task.id, projectId: owner, ...filed });
        }
      }
    }
    return { at, thresholds, dryRun: Boolean(options.dryRun), converged, archived, kept };
  }
  /**
   * File a task's diary under its own task scope.
   *
   * This is the write path the task scope never had. A candidate can carry it — the
   * adapter's classifier may say `scope: task`, and approval keeps the task id — but
   * no core path ever produced one, which is why a real library held 143 tasks and
   * 0 task-scoped entries. The diary is the honest subject: it is what the task
   * actually recorded, it already exists at project scope, and filing it under the
   * task is what makes "what did this session leave behind" answerable without
   * widening a one-time note into a rule for all later work.
   *
   * Idempotent by construction: the entry id is derived from the task, and a call
   * whose content has not moved writes nothing and reports `unchanged: true`. A call
   * whose content *has* moved (a later checkpoint added facts) writes a new revision
   * of the same entry, which is a revision rather than a duplicate.
   */
  archiveTaskScope(projectId: string, taskId: string, options: { at?: number } = {}) {
    const at = options.at ?? this.now();
    return this.transaction(() => {
      const task = this.getTask(taskId, projectId);
      if (!task) throw new DomainError('not_found', 'Task is unavailable', 404);
      const id = taskArchiveId(taskId);
      // `verification` is a diagnostic the generated journal returns to a caller
      // inspecting it, not a field of the journal schema, so it is dropped here for
      // the same reason `writeJournal` drops it.
      const { verification: _verification, ...generated } = this.generateJournal(taskId, projectId);
      const content = knowledgeSchema.parse({
        ...generated, id,
        title: `${generated.title}（本会话）`.slice(0, 200),
        scope: { kind: 'task', projectId, taskId },
        baseRevision: 0,
        // The task's own remarks, without the lines the core wrote about converging
        // and archiving it: see `stripConvergenceNotes`.
        problems: stripConvergenceNotes(generated.problems),
        did: `${generated.did}\n\n[本会话作用域] 本条归档到任务 ${taskId}，只在该任务内适用；`
          + '要让它对项目以后的工作也生效，需要显式提升为项目条目——那是扩大适用范围，必须由人决定。',
      });
      const existing = this.head(id);
      if (existing && stableContent(existing.content) === stableContent(content))
        return { taskId, projectId, knowledgeId: id, revision: existing.revision, scope: content.scope, replaced: false, unchanged: true, archivedAt: at };
      const revision = this.import([{ ...content, baseRevision: existing?.revision ?? 0 }]);
      // The task record says the archive happened. An archive invisible from the
      // task it came from is indistinguishable from a task that was dropped.
      const marker = `[会话归档] ${id}`;
      if (!task.notes.includes(marker))
        this.recordTask(projectId, {
          id: taskId, title: task.title, status: task.status,
          notes: appendTaskNote(task.notes, `${marker} r${revision}：本会话事实已归档为 task 作用域条目`
            + '（不是完成，也未核实结果；长期有效的内容需显式提升为项目条目）。'),
        });
      return { taskId, projectId, knowledgeId: id, revision, scope: content.scope, replaced: Boolean(existing), unchanged: false, archivedAt: at };
    });
  }
  /**
   * Task-scoped entries that belong to one task, with their text.
   *
   * Retrieval refuses task scope when the caller has no task in hand — that refusal
   * is the scope's whole point — and `getKnowledge`/`readKnowledge` apply the same
   * rule, so the task view is the only place a reader can reach the content. It
   * therefore carries an excerpt of the entry's own prose rather than just its
   * title: a list of names a reader cannot open is not "readable", it is the same
   * unreachable state the scope was in before it had a write path.
   */
  taskScopedEntries(projectId: string, taskId: string) {
    return this.current()
      .filter(entry => entry.content.scope.kind === 'task'
        && entry.content.scope.projectId === projectId && entry.content.scope.taskId === taskId)
      .map(entry => {
        const content = entry.content as { did?: string; problems?: string; outcome?: string };
        const excerpt = (value: string | undefined) => {
          const text = value ?? '';
          return text.length > 400 ? `${text.slice(0, 400)}…` : text;
        };
        return {
          id: entry.id, revision: entry.revision, status: entry.status, kind: entry.content.kind,
          title: entry.content.title, scope: entry.content.scope, evidence: entry.content.evidence,
          outcome: content.outcome ?? null,
          excerpt: excerpt(content.did),
          problems: excerpt(content.problems),
          promotable: true as const,
        };
      });
  }
  /**
   * Promote one task-scoped entry to project scope.
   *
   * A widening, so it is the human's decision rather than a timer's: the policy
   * module already classifies task → project as the `user` tier, and this path asks
   * it instead of deciding for itself. The earlier revision is kept, so what was
   * originally recorded at the narrower scope stays readable afterwards.
   */
  promoteTaskScope(projectId: string, knowledgeId: string) {
    return this.transaction(() => {
      const entry = this.head(knowledgeId);
      const scope = entry?.content.scope;
      if (!entry || !scope || scope.kind !== 'task' || scope.projectId !== projectId)
        throw new DomainError('not_found', `Task-scoped entry ${knowledgeId} is unavailable`, 404);
      const decision = reviewDecision({
        intent: 'widen-scope', provenance: 'user', evidence: entry.content.evidence,
        scopeChange: { from: scope, to: { kind: 'project', projectId } },
      });
      if (decision.tier !== 'user')
        throw new DomainError('invalid_widening', 'task 作用域只能按"扩大范围"的规则提升', 400);
      const revision = this.import([{ ...entry.content, scope: { kind: 'project', projectId }, baseRevision: entry.revision }]);
      return { knowledgeId, revision, from: scope, to: { kind: 'project', projectId }, widening: true as const,
        reason: decision.reason, constraint: decision.constraint };
    });
  }
  /**
   * Generate the diary for a task.
   *
   * Built from what the task actually recorded — its own facts and its event
   * stream — not from a model's summary of the conversation. The design requires
   * the diary to be "based on facts" and to distinguish success, failure and
   * unverified; a generated narrative would blur exactly those distinctions.
   */
  generateJournal(taskId: string, projectId: string) {
    const task = this.getTask(taskId, projectId);
    if (!task) throw new DomainError('not_found', 'Task is unavailable', 404);
    // The event stream is filtered by project as well as task id: an event that
    // named this task from another project must not become a "fact" in this
    // project's diary. The write path refuses such an event, and this filter is
    // the second line of defence for rows written before that check existed.
    const events = this.db.prepare('SELECT payload, created_at FROM events ORDER BY created_at').all()
      .map(row => { try { return JSON.parse(String(row.payload)) as { taskId?: string; sessionId?: string; kind?: string; projectId?: string; summary?: string }; } catch { return {}; } })
      .filter(payload => (payload.taskId === taskId || (!payload.taskId && payload.sessionId && task.sessionIds.includes(payload.sessionId)))
        && (payload.projectId === undefined || payload.projectId === projectId));
    const stops = events.filter(event => event.kind === 'turn_stopped').length;
    const did = task.summary
      || `任务「${task.title}」共记录 ${events.length} 个事件${stops ? `，其中 ${stops} 次中断` : ''}。`;
    /**
     * The outcome may only rest on a checkable fact.
     *
     * `task.verified` is a string the caller supplied — an agent saying "I ran the
     * tests and they passed". Treating any non-empty string as success marked an
     * unverified claim as observed evidence (design §6.2, acceptance 4). So a bare
     * free-text claim never carries a diary to `success`: the text is preserved and
     * labelled as the self-report it is.
     *
     * What may carry it is a *deliberate* statement of basis, in either of the two
     * forms the design names — the caller recording an evidence level of
     * `observed` (the plugin's own record) or `verifiable` (a checkable artefact),
     * or the plugin having separately recorded a `verified` event. Either is a
     * distinct assertion rather than prose; the two are accepted together because
     * requiring both made `verifiable` alone unable to ever reach `success`, which
     * would leave the field unable to describe the case it exists for.
     */
    const verifiedEvents = events.filter(event => event.kind === 'verified' && (event as { evidence?: string }).evidence === 'observed').length;
    const checkable = task.evidence === 'observed' || task.evidence === 'verifiable' || verifiedEvents > 0;
    const outcome: 'success' | 'failure' | 'unverified' =
      task.status === 'completed' ? (checkable ? 'success' : 'unverified')
      : task.status === 'failed' ? 'failure'
      : 'unverified';
    return {
      id: `journal-${task.id}`,
      kind: 'journal' as const,
      title: `任务日记：${task.title}`.slice(0, 200),
      scope: { kind: 'project' as const, projectId },
      baseRevision: 0,
      labels: [] as string[],
      // The plugin wrote this from its own records, so `agent` provenance is the
      // accurate label: it is not something the user said, and calling it theirs
      // would lend the diary an authority it does not have.
      provenance: 'agent' as const,
      // The diary is a record, not a verification: `self-reported` is the honest
      // level, because nothing here was independently checked by the plugin.
      evidence: 'self-reported' as const,
      platforms: [] as Array<'dsh' | 'codex'>,
      taskId: task.id,
      did,
      problems: task.notes,
      experienceLanded: task.relatedExperiences,
      outcome,
      /**
       * The decision inputs, kept beside the claim so a reader can see why the
       * outcome is what it is: the caller's own words, the number of events that
       * actually bound to this task, and whether any of them was a verifiable one.
       */
      verification: {
        selfReported: task.verified ? true : false,
        claim: task.verified || null,
        events: events.length,
        verifiedEvents,
        basis: verifiedEvents > 0 ? 'observed-event' : 'none',
      },
      unfinished: task.unfinished,
    };
  }
  /** Record the journal as knowledge, so it survives the task record. */
  writeJournal(taskId: string, projectId: string) {
    const journal = this.generateJournal(taskId, projectId);
    const existing = this.current().find(entry => entry.content.kind === 'journal'
      && (entry.content as { taskId?: string }).taskId === taskId);
    // `verification` is diagnostic detail returned to a caller inspecting the
    // generated journal; it is not part of the journal entry schema, so it is
    // dropped before the entry is stored.
    const { verification: _verification, ...entry } = journal;
    const withRevision = existing
      ? { ...entry, baseRevision: existing.revision }
      : entry;
    const revision = this.import([withRevision]);
    return { journalId: journal.id, revision, replaced: Boolean(existing), outcome: journal.outcome };
  }
  /**
   * Handoff carries what the other end needs and never implies process or credential transfer.
   *
   * The design lists goal, constraints, decisions, progress, unfinished work, file
   * references, verification results, the knowledge version and a suggested next
   * step. `files` is included because the design requires the receiving end to
   * re-check the environment — naming the files is what makes that check possible,
   * and the caveat states that the check has not been performed here.
   */
  handoff(id: string, projectId: string) {
    const task = this.tasks(projectId).find(t => t.id === id);
    if (!task) throw new DomainError('not_found', 'Task is unavailable', 404);
    // The next step is derived from what the task itself left open, not invented.
    const nextStep = task.unfinished.length
      ? `继续处理未完成项：${task.unfinished[0]}`
      : task.status === 'completed'
        ? '任务已完成；如需延展，请从相关经验或流程入口重新开始。'
        : '任务仍在进行中；先核对下面的文件与环境状态，再继续。';
    return {
      task, knowledgeRevision: this.revision,
      norms: this.norms(projectId),
      workflows: this.search(projectId, task.title).map(w => ({ id: w.id, revision: w.revision, title: w.title, ready: w.ready })),
      /** Files the receiving end must re-check; naming them is the point. */
      files: task.files,
      /**
       * The recorded state of those files, for the receiving end to compare against.
       *
       * Acceptance 16 requires that continuing in a different checkout shows how the
       * files differ instead of assuming the sender's edits are already present. The
       * core cannot do that comparison — it never sees the receiving end's disk — so
       * it hands over what was *recorded* and says so. `compare` is provided as a
       * helper the receiving end can call with its own observed digests, and it
       * reports `unknown` rather than `unchanged` for any file whose state was never
       * recorded: "we did not look" and "it has not changed" are different answers,
       * and conflating them is how a stale checkout gets mistaken for a current one.
       */
      fileStates: task.fileStates,
      compare: {
        note: '把接收端自己算出的摘要传进来，即可得到每个文件的差异；未记录过状态的文件一律返回 unknown，不假定未变。',
        // Counted against the full file list, not just the states: a path named in
        // `files` with no recorded state is the case that most needs to be visible,
        // and counting only within `fileStates` would report zero gaps while a
        // receiving end silently has nothing to compare against.
        recorded: task.files.filter(path => task.fileStates.some(state => state.path === path && state.digest !== undefined)).length,
        unrecorded: task.files.filter(path => !task.fileStates.some(state => state.path === path && state.digest !== undefined)).length,
      },
      /** What was verified, and whether anything was verified at all. */
      verification: { verified: task.verified || null, taskStatus: task.status },
      suggestion: nextStep,
      caveat: '接收端需重新确认文件与环境状态；本交接不迁移运行中的进程、凭据或工具权限。'
        + ' 上面的 files 只是需要核对的清单，不代表已经核对过；fileStates 是发送端记录的状态，'
        + '必须与接收端自己的状态比较后才知是否一致。',
    };
  }
  /**
   * Compare a receiving end's observed file digests against what a task recorded.
   *
   * Kept on the store rather than the HTTP layer so the three-way distinction is
   * enforced in one place: `same` (recorded and equal), `different` (recorded and
   * not equal), and `unknown` (nothing was recorded for that path, or the receiving
   * end did not supply a digest). A two-valued answer would force `unknown` to be
   * reported as one of the others, and it is exactly the case the acceptance case
   * warns about — assuming another checkout already has the change.
   */
  compareFileStates(taskId: string, projectId: string, observed: Array<{ path: string; digest?: string; size?: number }>): {
    results: Array<{ path: string; status: 'same' | 'different' | 'unknown'; recordedDigest?: string; observedDigest?: string; detail: string }>;
    summary: { same: number; different: number; unknown: number };
  } {
    const task = this.tasks(projectId).find(t => t.id === taskId);
    if (!task) throw new DomainError('not_found', 'Task is unavailable', 404);
    const recorded = new Map(task.fileStates.map(state => [state.path, state]));
    // Every path either side knows about is reported, so a file the receiving end
    // has but the task does not (or vice versa) cannot be dropped silently.
    const paths = [...new Set([...recorded.keys(), ...observed.map(item => item.path)])].sort();
    const observedByPath = new Map(observed.map(item => [item.path, item]));
    const results = paths.map(path => {
      const was = recorded.get(path);
      const now = observedByPath.get(path);
      if (!was || was.digest === undefined) {
        return { path, status: 'unknown' as const, ...(was?.digest ? { recordedDigest: was.digest } : {}), ...(now?.digest ? { observedDigest: now.digest } : {}), detail: '发送端未记录该文件的状态，不能判断是否变化' };
      }
      if (!now || now.digest === undefined) {
        return { path, status: 'unknown' as const, recordedDigest: was.digest, detail: '接收端未提供该文件的摘要，不能判断是否变化' };
      }
      const same = was.digest === now.digest;
      return {
        path, status: same ? ('same' as const) : ('different' as const),
        recordedDigest: was.digest, observedDigest: now.digest,
        detail: same ? '与发送端记录一致' : '与发送端记录不一致：本地内容可能落后或已被改动',
      };
    });
    const summary = {
      same: results.filter(r => r.status === 'same').length,
      different: results.filter(r => r.status === 'different').length,
      unknown: results.filter(r => r.status === 'unknown').length,
    };
    return { results, summary };
  }
  /**
   * Export a task as readable Markdown, and as the full record for backup.
   *
   * Two shapes for two purposes, as the design specifies: the Markdown is for a
   * person reading what happened, the JSON is for moving the data. The Markdown
   * deliberately states the outcome rather than implying it — an unverified task
   * must not read like a successful one.
   */
  exportTask(id: string, projectId: string) {
    const task = this.tasks(projectId).find(t => t.id === id);
    if (!task) throw new DomainError('not_found', 'Task is unavailable', 404);
    const events = this.db.prepare('SELECT payload, created_at FROM events ORDER BY created_at').all()
      .map(row => {
        let payload: Record<string, unknown> = {};
        try { payload = JSON.parse(String(row.payload)) as Record<string, unknown>; } catch { /* torn row */ }
        return { created_at: Number(row.created_at), taskId: payload.taskId, projectId: payload.projectId, kind: payload.kind, summary: payload.summary };
      })
      // Filtered by project as well as task: an event recorded under another project
      // for this task id must not appear in the export a reader treats as fact.
      .filter(event => event.taskId === id && (event.projectId === undefined || event.projectId === projectId));
    const stamp = (value: number | null) => value === null ? '—' : new Date(value).toISOString().replace('T', ' ').slice(0, 16);
    // Label the time system in the document itself: the export is UTC while the
    // management page shows local time with an offset, and F09 found a reader could
    // not tell which was which when correlating the two timelines.
    const UTC_NOTE = '本文件时间均为 UTC，格式 YYYY-MM-DD HH:MM。';
    const outcomeLabel = { success: '完成（有验证依据）', failure: '失败', unverified: '未验证' } as const;
    // Same rule as the diary: the free-text `verified` cannot be the basis for a
    // success claim. Only a level the plugin can stand behind does.
    const verified = task.evidence === 'observed' || task.evidence === 'verifiable';
    const outcome = task.status === 'completed' ? (verified ? 'success' : 'unverified')
      : task.status === 'failed' ? 'failure' : 'unverified';

    const markdown = [
      `# 任务记录：${task.title}`, '',
      `**任务 ID**：${task.id}  `,
      `**项目**：${projectId}  `,
      `**时间**：${stamp(task.startedAt ?? task.createdAt)} ~ ${stamp(task.completedAt)}  `,
      `**状态**：${outcomeLabel[outcome]}（${task.status}）  `,
      `**知识版本**：${task.knowledgeRevision}  `,
      `**时区**：${UTC_NOTE}`, '',
      '## 摘要', task.summary || '（无）', '',
      '## 进展',
      ...(events.length
        ? events.map(event => `- ${stamp(event.created_at)} ${String(event.kind ?? '事件')}${event.summary ? `：${String(event.summary)}` : ''}`)
        : ['- （无事件记录）']), '',
      '## 关联知识',
      ...(task.relatedExperiences.length ? task.relatedExperiences.map(id => `- 经验：${id}`) : ['- 经验：（无）']),
      ...(task.relatedProposals.length ? task.relatedProposals.map(id => `- 提案：${id}`) : ['- 提案：（无）']), '',
      '## 验证',
      task.verified
        ? `${task.verified}（证据等级：${task.evidence}${verified ? '' : '，未达可核验等级，按未验证记录'}）`
        : '未提供验证依据（按未验证记录）', '',
      '## 未解决项',
      ...(task.unfinished.length ? task.unfinished.map(item => `- [ ] ${item}`) : ['- （无）']), '',
      '## 需要核对的文件',
      ...(task.files.length ? task.files.map(file => `- ${file}`) : ['- （无）']), '',
      '## 备注', task.notes || '（无）', '',
      '---', '',
      // Stated in the document itself, because the file outlives the session that
      // produced it and a reader has no other way to know.
      '> 本记录由任务的事实数据生成，不是行为指令。日记正文与临时资料采用不同的保留策略。',
    ].join('\n');

    return {
      task,
      markdown,
      json: { task, events, exportedAt: this.now(), knowledgeRevision: this.revision },
    };
  }
  /**
   * Promote a batch of discovered knowledge in one transaction.
   *
   * Each adopted entry keeps its source path and content hash in the ledger, so
   * the batch can be revoked precisely later. Adoption never touches the source
   * file: only this database changes.
   */
  adopt(entries: Array<{ source: { path: string; hash: string }; kind: string; title: string; knowledge: KnowledgeDraft }>): { adoptedAt: number; knowledgeRevision: number; count: number; skipped: Array<{ id: string; reason: string }> } {
    if (entries.length === 0) throw new DomainError('empty_batch', 'Adoption requires at least one entry', 400);
    const adoptedAt = this.now();
    return this.transaction(() => {
      /**
       * Decide per entry whether this is a repeat, a restore, or a first import.
       *
       * Adoption imports from an external source, so the caller cannot know the
       * internal revision. Two situations had been conflated:
       *
       *  - the same source content is already active: a repeat, skipped rather
       *    than failing the batch (one duplicate must not kill the whole import);
       *  - the entry exists but is retired: the user revoked it and is re-adopting,
       *    which restores it as a new revision. This used to fail with "Revision
       *    changed", leaving a command that reported it would adopt an entry and
       *    then refused to.
       */
      const skipped: Array<{ id: string; reason: string }> = [];
      const aligned: typeof entries = [];
      const ledger = this.adoptions();
      for (const entry of entries) {
        const existing = this.head(entry.knowledge.id);
        if (existing && existing.status === 'active') {
          const prior = ledger.find(record => record.sourcePath === entry.source.path);
          if (prior && prior.contentHash === entry.source.hash) {
            skipped.push({ id: entry.knowledge.id, reason: 'same source content is already active' });
            continue;
          }
        }
        const baseRevision = existing ? existing.revision : 0;
        aligned.push({ ...entry, knowledge: knowledgeSchema.parse({ ...entry.knowledge, baseRevision }) });
      }
      if (aligned.length === 0) {
        return { adoptedAt, knowledgeRevision: this.revision, count: 0, skipped };
      }
      // importInsideTransaction performs the CAS and dependency checks; the
      // caller must already hold a transaction, so nothing is half-written.
      const knowledgeRevision = this.importInsideTransaction(aligned.map(entry => knowledgeSchema.parse(entry.knowledge)));
      for (const entry of aligned) {
        // Parsed above, so the defaulted fields are present; read back through the
        // same schema rather than trusting the draft's optional one.
        const revision = knowledgeSchema.parse(entry.knowledge).baseRevision + 1;
        // The ledger is append-only, so the row id includes the batch time: the
        // same source adopted twice (a revoke followed by a re-adopt) is two real
        // events and must not collide on a content-derived key.
        this.db.prepare(`INSERT INTO adoptions(id,source_path,kind,title,content_hash,knowledge_id,revision,adopted_at,revoked_at)
          VALUES(?,?,?,?,?,?,?,?,NULL)`).run(
          `adopt:${adoptedAt}:${entry.source.hash.slice(0, 16)}:${entry.knowledge.id}`, entry.source.path, entry.kind,
          entry.title, entry.source.hash, entry.knowledge.id, revision, adoptedAt);
      }
      return { adoptedAt, knowledgeRevision, count: aligned.length, skipped };
    });
  }
  /**
   * Refresh an already-adopted source whose file content changed.
   *
   * Newest wins: the incoming text becomes the active revision and the previous
   * one is retired with an auditable reason, but nothing is destroyed — every
   * revision stays in `revisions`, and the supersession row records which version
   * replaced which, on what basis, and whether a local edit was overwritten.
   *
   * A human edit made inside the plugin is preserved as history and explicitly
   * flagged, so "latest wins" never means "silently discard the user's work".
   */
  refreshAdoption(input: {
    sourcePath: string; kind: string; title: string;
    source: { hash: string }; knowledge: Knowledge;
    reason?: string; evidence?: string; origin?: 'rescan' | 'agent' | 'user';
  }): { knowledgeId: string; knowledgeRevision: number; knowledgeBaseRevision?: number; action: 'refreshed' | 'unchanged'; replacedLocalEdit: boolean } {
    const validated = knowledgeSchema.parse(input.knowledge);
    const record = this.adoptions()
      .find(candidate => candidate.sourcePath === input.sourcePath);
    if (!record) throw new DomainError('not_adopted', `Source was never adopted: ${input.sourcePath}`, 404);
    if (record.contentHash === input.source.hash) {
      return { knowledgeId: record.knowledgeId, knowledgeRevision: this.revision, action: 'unchanged', replacedLocalEdit: false };
    }
    const adoptedAt = this.now();
    return this.transaction(() => {
      const head = this.head(record.knowledgeId);
      if (!head) throw new DomainError('not_found', 'Adopted entry is unavailable', 404);
      // A retired entry must not be silently revived by a source refresh: it may
      // have been superseded or deliberately withdrawn, and bringing it back as
      // current would undo that decision without review.
      if (head.status !== 'active') {
        throw new DomainError('not_active', `Adopted entry ${record.knowledgeId} is ${head.status}; refusing to revive it by refresh`, 409);
      }
      // A revision beyond the one this batch created means someone edited it here.
      const replacedLocalEdit = head.revision !== record.revision;
      const kindChanged = head.content.kind !== validated.kind;
      if (kindChanged) throw new DomainError('kind_changed', 'A refresh must keep the adopted knowledge kind', 409);

      const incoming: Knowledge = { ...validated, id: head.content.id, baseRevision: head.revision } as Knowledge;
      const knowledgeRevision = this.importInsideTransaction([incoming]);

      this.db.prepare(`INSERT INTO supersessions(old_knowledge_id,old_revision,new_knowledge_id,new_revision,action,reason,evidence,origin,replaced_local_edit,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(record.knowledgeId, head.revision, record.knowledgeId, head.revision + 1,
          'supersede', input.reason ?? '来源内容已更新，以最新记录为准',
          input.evidence ?? `source:${input.sourcePath}@${input.source.hash}`,
          input.origin ?? 'rescan', replacedLocalEdit ? 1 : 0, adoptedAt);

      // The ledger row is superseded rather than updated, so a batch revoke can
      // still be reasoned about after a refresh.
      this.db.prepare('UPDATE adoptions SET revoked_at=? WHERE id=?').run(adoptedAt, record.id);
      this.db.prepare(`INSERT INTO adoptions(id,source_path,kind,title,content_hash,knowledge_id,revision,adopted_at,revoked_at)
        VALUES(?,?,?,?,?,?,?,?,NULL)`).run(
        `adopt:${adoptedAt}:${input.source.hash.slice(0, 16)}:${record.knowledgeId}`, input.sourcePath, input.kind,
        input.title, input.source.hash, record.knowledgeId, head.revision + 1, adoptedAt);
      return { knowledgeId: record.knowledgeId, knowledgeRevision, action: 'refreshed' as const, replacedLocalEdit };
    });
  }
  /**
   * Turn an adopted skill document into a real workflow.
   *
   * The caller supplies the authored structure: triggers, preconditions, ordered
   * stages, checks, completion and recovery. Nothing is derived from the
   * Markdown here, because a program cannot reliably read ordered steps and
   * completion criteria out of prose, and inventing them would present a
   * fabrication as a verified method.
   *
   * What this function guarantees instead is the bookkeeping: the source skill
   * must exist and be active, its revision is recorded on the new workflow, the
   * skill is retired in the same transaction, and the supersession ledger links
   * the two so the conversion stays traceable.
   */
  structureSkill(input: {
    skillId: string;
    /** A draft: the store parses it, so a caller need not restate defaulted fields. */
    workflow: WorkflowDraft;
    derivedBy: 'user' | 'agent';
    evidence: string;
    /** Scope the caller acts within; the skill and the new workflow must be visible to it. */
    projectId?: string;
    /** Keep the watched source active so later source edits invalidate this procedure. */
    keepSource?: boolean;
    expectedSkillRevision?: number;
  }): { workflowId: string; knowledgeRevision: number; retiredSkillRevision: number } {
    const evidence = input.evidence.trim().slice(0, 2000);
    if (!evidence) throw new DomainError('missing_evidence', 'Structuring a skill must cite what the structure is based on', 400);
    // Validate the authored structure on its own first. Assembling a placeholder
    // derivedFrom before the target is known would surface a schema complaint
    // about the placeholder instead of the real problem (unknown target, wrong
    // kind, already retired), which misleads the caller.
    const authored = workflowSchema.parse({ ...(input.workflow as Workflow & { derivedFrom?: unknown }), derivedFrom: undefined });
    return this.transaction(() => {
      const skill = this.head(input.skillId);
      if (!skill) throw new DomainError('not_found', `Skill ${input.skillId} is unavailable`, 404);
      if (skill.content.kind !== 'skill') throw new DomainError('not_skill', 'Only an adopted skill can be structured into a workflow', 409);
      if (skill.status !== 'active') throw new DomainError('not_active', `Skill ${input.skillId} is ${skill.status}`, 409);
      if (input.expectedSkillRevision !== undefined && skill.revision !== input.expectedSkillRevision)
        throw new DomainError('revision_conflict', 'Source skill changed since draft generation', 409);
      // The skill must belong to the caller's scope; otherwise one project could
      // convert and retire another project's knowledge.
      if (input.projectId && skill.content.scope.kind !== 'global'
        && skill.content.scope.projectId !== input.projectId) {
        throw new DomainError('not_found', `Skill ${input.skillId} is unavailable`, 404);
      }
      if (authored.id === input.skillId) throw new DomainError('id_conflict', 'The workflow needs its own id, distinct from the skill', 400);

      const existing = this.head(authored.id);
      if (existing && existing.content.kind !== 'workflow') throw new DomainError('kind_changed', 'A workflow id must not replace another kind', 409);
      if(existing && input.projectId && !applicable(existing.content.scope,input.projectId))
        throw new DomainError('not_found','Target workflow is unavailable in this project',404);
      const withSource = workflowSchema.parse({
        ...authored,
        baseRevision: existing?.revision ?? 0,
        derivedFrom: { skillId: input.skillId, skillRevision: skill.revision, derivedBy: input.derivedBy, evidence },
      });
      const knowledgeRevision = this.importInsideTransaction([withSource]);

      // Retire the raw skill in the same transaction: the workflow now carries
      // the method, and leaving both active would offer the same procedure twice
      // in two different shapes.
      const retired = !input.keepSource && this.db.prepare("UPDATE knowledge SET status='retired' WHERE id=? AND head=? AND status='active'")
        .run(input.skillId, skill.revision);
      if (retired && retired.changes) this.db.prepare('DELETE FROM workflow_search WHERE id=?').run(input.skillId);

      const newRevision = (existing?.revision ?? 0) + 1;
      this.db.prepare(`INSERT INTO supersessions(old_knowledge_id,old_revision,new_knowledge_id,new_revision,action,reason,evidence,origin,replaced_local_edit,created_at)
        VALUES(?,?,?,?,?,?,?,?,0,?)`).run(input.skillId, skill.revision, authored.id, newRevision,
          input.keepSource ? 'supplement' : 'supersede', '技能已结构化为完整流程', evidence, input.derivedBy, this.now());
      this.db.prepare("UPDATE meta SET value=value+1 WHERE key='revision'").run();
    this.jobs.enqueue('notify', `revision:${this.revision}`, { revision: this.revision });
      return { workflowId: authored.id, knowledgeRevision, retiredSkillRevision: skill.revision };
    });
  }
  /**
   * Adopted skills still awaiting structure, newest first.
   *
   * `projectId` narrows the list to what one caller may see; omitting it is the
   * unscoped administrative view the CLI asks for. The HTTP endpoint always passes
   * the credential's project, because that is where the isolation boundary is.
   */
  unstructuredSkills(projectId?: string, limit = 50) {
    return this.liveEntries()
      .filter(entry => entry.content.kind === 'skill' && entry.content.needsStructure
        && (projectId === undefined || applicable(entry.content.scope, projectId)))
      .slice(0, limit)
      .map(entry => {
        const content = entry.content as Extract<Knowledge, { kind: 'skill' }>;
        return {
          id: entry.id, revision: entry.revision, title: content.title,
          leafCount: content.leaves.length, bodyChars: content.body.length,
          leafPaths: content.leaves.map(leaf => leaf.path),
        };
      });
  }
  /**
   * Ids of entries that exist but are retired.
   *
   * Lets a caller tell "this is new" from "this is being restored": after a revoke
   * the entry is still present with its history, so re-adopting it is a restore
   * and should be reported as one rather than as a fresh import.
   */
  retiredIds(): Set<string> {
    return new Set(this.db.prepare("SELECT id FROM knowledge WHERE status='retired'").all()
      .map(row => String(row.id)));
  }
  /** Adoption ledger, newest first. Reads only; never touches source files. */
  adoptions(includeRevoked = false) {
    const rows = includeRevoked
      ? this.db.prepare('SELECT * FROM adoptions ORDER BY adopted_at DESC, knowledge_id').all()
      : this.db.prepare('SELECT * FROM adoptions WHERE revoked_at IS NULL ORDER BY adopted_at DESC, knowledge_id').all();
    return rows.map(row => ({
      id: String(row.id), sourcePath: String(row.source_path), kind: String(row.kind),
      title: String(row.title), contentHash: String(row.content_hash),
      knowledgeId: String(row.knowledge_id), revision: Number(row.revision),
      adoptedAt: Number(row.adopted_at), revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    }));
  }
  /**
   * Revoke an adoption batch.
   *
   * Only entries whose current revision is still the one this batch created are
   * retired: if the user has since edited an adopted entry, that work is
   * preserved rather than silently discarded, and it is reported as skipped.
   * Source files are never touched.
   */
  revokeAdoption(adoptedAt: number): { retired: string[]; skipped: Array<{ knowledgeId: string; reason: string }> } {
    const batch = this.adoptions(true).filter(record => record.adoptedAt === adoptedAt && record.revokedAt === null);
    if (batch.length === 0) throw new DomainError('not_found', 'No active adoption batch with that timestamp', 404);
    return this.transaction(() => {
      const retired: string[] = [];
      const skipped: Array<{ knowledgeId: string; reason: string }> = [];
      const now = this.now();
      for (const record of batch) {
        const head = this.head(record.knowledgeId);
        if (!head || head.status !== 'active') {
          skipped.push({ knowledgeId: record.knowledgeId, reason: 'no longer active' });
        } else if (head.revision !== record.revision) {
          skipped.push({ knowledgeId: record.knowledgeId, reason: `edited since adoption (now revision ${head.revision}); preserved` });
        } else {
          this.db.prepare("UPDATE knowledge SET status='retired' WHERE id=? AND head=? AND status='active'").run(record.knowledgeId, record.revision);
          this.db.prepare('DELETE FROM workflow_search WHERE id=?').run(record.knowledgeId);
          retired.push(record.knowledgeId);
        }
        this.db.prepare('UPDATE adoptions SET revoked_at=? WHERE id=?').run(now, record.id);
      }
      if (retired.length) this.db.prepare("UPDATE meta SET value=value+1 WHERE key='revision'").run();
    this.jobs.enqueue('notify', `revision:${this.revision}`, { revision: this.revision });
      return { retired, skipped };
    });
  }
  /**
   * Remove what has lapsed. Called on every request and on a timer.
   *
   * Two of the three removals are ordinary housekeeping. The third is the design's
   * second layer for temporary material: bodies, summaries and index rows are
   * deleted once the expiry passes. The first layer — refusing to *return* expired
   * material — lives in `liveMaterial()` and runs on every read, so a lapsed item
   * cannot be served even while this job is failing or has never run.
   *
   * The removal is per item rather than in bulk so one failure cannot strand the
   * rest, and each is recorded: a cleanup that silently did nothing is
   * indistinguishable from one that had nothing to do.
   */
  cleanup() {
    // Proposal deadlines are handled by `expireProposals`, which distinguishes a
    // lapsed pending item from an unanswered evidence request; both keep their rows.
    const now = this.now();
    this.expireProposals();
    this.db.prepare('DELETE FROM events WHERE expires_at<=?').run(now);
    // A lapsed outbox item stops being retryable here rather than at the next
    // attempt, so a status read never reports work that is already past its
    // deadline as merely "waiting".
    this.abandonDueOutbox(now);
    this.purgeExpiredMaterial();
  }
  /**
   * The one read-time expiry gate.
   *
   * Every read path — the universal catalog, a single get, the dedicated material
   * list, history, export — filters through here, so a lapsed item is invisible
   * even while the persistent purge is failing or has never run. Putting the rule
   * in one place is the point: a per-entry check at each call site is how one of
   * them eventually forgets, and the entry that is forgotten is the one the user
   * most needed gone.
   */
  private liveEntries(): Entry[] {
    const now = this.now();
    return this.current().filter(entry =>
      entry.content.kind !== 'material' || isLive(entry.content.expiresAt, now));
  }
  /**
   * Purge lapsed temporary material, returning what was removed.
   *
   * Separated from `cleanup()` so a caller can retry it alone, and so a test can
   * assert the purge without waiting for the other housekeeping.
   *
   * The removal is a real delete, not a retirement. The design's second layer says
   * bodies, summaries, index rows and cached fragments are removed, and the earlier
   * implementation only flipped the head to `retired` — which left the body in the
   * `revisions` table and in every backup taken afterwards. History for norms,
   * skills and memories is immutable on purpose; temporary material has an explicit
   * expiry that overrides that default.
   *
   * One item is handled per transaction so a failure is isolated to it, and every
   * failure is recorded in `material_purge_failures` — a cleanup that silently did
   * nothing is indistinguishable from one that had nothing to do, which is exactly
   * how a lapsed body survives.
   *
   * The two steps inside that transaction are ordered the way the design describes
   * them: first leave the live set through the normal retirement transition, then
   * remove the payload it was guarding. `purged` therefore means both happened —
   * a row is only ever reported as purged when the body, summary and index rows are
   * actually gone. Any step that fails leaves the item in `failed` and untouched.
   */
  purgeExpiredMaterial(): { purged: string[]; failed: Array<{ id: string; message: string }> } {
    const now = this.now();
    const purged: string[] = [];
    const failed: Array<{ id: string; message: string }> = [];
    for (const entry of this.current()) {
      const content = entry.content;
      if (content.kind !== 'material') continue;
      if (isLive(content.expiresAt, now)) continue;
      try {
        this.transaction(() => {
          // Re-read inside the transaction: the row may have been renewed since the
          // scan, and a renewal is a deliberate decision the purge must not undo.
          const head = this.head(entry.id);
          if (!head) return;
          if (head.content.kind !== 'material' || isLive((head.content as { expiresAt: number }).expiresAt, now)) return;
          // Step 1: leave the effective library. Inlined rather than calling
          // `retire()` because that opens its own transaction, and a failure here
          // must abort the deletion below in the same unit of work.
          const retired = this.db.prepare("UPDATE knowledge SET status='retired' WHERE id=? AND head=? AND status='active'")
            .run(entry.id, head.revision);
          if (!retired.changes) throw new DomainError('revision_conflict', 'Current knowledge revision not found', 409);
          // Step 2: really remove the payload. History is immutable for norms,
          // skills and memories; temporary material has an explicit expiry that
          // overrides that default, so its revisions — and the head row that points
          // at them — go too. Leaving the head behind would export a knowledge row
          // with no revision, which makes a backup unimportable ("Missing head
          // revision"), so the two are removed together.
          this.db.prepare('DELETE FROM workflow_search WHERE id=?').run(entry.id);
          this.db.prepare('DELETE FROM revisions WHERE id=?').run(entry.id);
          this.db.prepare('DELETE FROM knowledge WHERE id=?').run(entry.id);
          this.db.prepare('DELETE FROM material_purge_failures WHERE id=?').run(entry.id);
          // A minimal ledger row keeps "this page existed and lapsed" answerable
          // without retaining the body or the summary the design removes. It is a
          // destructive lifecycle event rather than a data row, so it is left alone
          // by the backup credential scan.
          const ledger = this.db.prepare("SELECT count(*) AS n FROM supersessions WHERE old_knowledge_id=? OR new_knowledge_id=?").get(entry.id, entry.id) as { n: number };
          if (Number(ledger.n) === 0) {
            this.db.prepare(`INSERT INTO supersessions(old_knowledge_id,old_revision,new_knowledge_id,new_revision,action,reason,evidence,origin,replaced_local_edit,created_at)
              VALUES(?,?,?,?,?,?,?,?,0,?)`).run(entry.id, head.revision, entry.id, head.revision,
              'supplement', '临时资料到期清理：正文、摘要与索引已删除', 'material expiry', 'user', now);
          }
          this.db.prepare("UPDATE meta SET value=value+1 WHERE key='revision'").run();
    this.jobs.enqueue('notify', `revision:${this.revision}`, { revision: this.revision });
        });
        purged.push(entry.id);
      } catch (error) {
        // Collected, not thrown: one item that will not delete must not stop the
        // pass, and the caller needs to know which ones to retry. The item is left
        // wholly untouched, so the retry starts from the same state.
        const message = error instanceof Error ? error.message : 'purge failed';
        failed.push({ id: entry.id, message });
        try {
          this.db.prepare(`INSERT INTO material_purge_failures(id,expires_at,message,attempts,failed_at) VALUES(?,?,?,1,?)
            ON CONFLICT(id) DO UPDATE SET message=excluded.message, attempts=attempts+1, failed_at=excluded.failed_at`)
            .run(entry.id, (content as { expiresAt: number }).expiresAt, message, now);
        } catch { /* the failure log must never break the purge it describes */ }
      }
    }
    return { purged, failed };
  }
  /**
   * Material whose persistent cleanup has failed, so the failure is visible and
   * retryable rather than implied. Read-only.
   */
  purgeFailures() {
    return this.db.prepare('SELECT id,expires_at,message,attempts,failed_at FROM material_purge_failures ORDER BY failed_at').all()
      .map(row => ({
        id: String(row.id), expiresAt: Number(row.expires_at),
        message: String(row.message), attempts: Number(row.attempts), failedAt: Number(row.failed_at),
      }));
  }
  /**
   * Save temporary material, recognising a repeat of the same page.
   *
   * A duplicate is skipped rather than stored twice, and — importantly — skipping
   * does **not** extend the original's expiry. The design is explicit that saving
   * the same page again is not a decision to keep it longer.
   *
   * Duplicate detection is scoped to the caller's project: two projects that read
   * the same URL are two separate records, and letting one project's save return
   * the other's id would turn the dedup optimisation into a cross-project probe.
   */
  saveMaterial(input: MaterialInput): { id: string; duplicate: boolean; expiresAt: number } {
    const now = this.now();
    const entry = materialEntry(input, now);
    const scope = entry.scope;
    const owner = scope.kind === 'global' ? '' : scope.projectId;
    const existing = this.liveEntries().find(candidate =>
      candidate.content.kind === 'material' && candidate.content.fingerprint === entry.fingerprint
      && applicable(candidate.content.scope, owner));
    if (existing) {
      return { id: existing.id, duplicate: true, expiresAt: (existing.content as { expiresAt: number }).expiresAt };
    }
    this.import([entry]);
    return { id: entry.id, duplicate: false, expiresAt: entry.expiresAt };
  }
  /**
   * Renew material deliberately, with a reason.
   *
   * The design requires the reason: reading must not extend a lifetime, so the one
   * path that does has to record why. A lapsed item can be renewed (a user may
   * decide a page is worth keeping after all) but an already-purged one cannot,
   * because its body is gone — claiming otherwise would return an empty page.
   *
   * `projectId` is the caller's scope. A credential for one project must not be
   * able to move another project's expiry merely by naming its id.
   */
  renewMaterial(id: string, reason: string, projectId?: string): { expiresAt: number; renewalReason: string } {
    const entry = this.current().find(candidate => candidate.id === id);
    if (!entry || entry.content.kind !== 'material') throw new DomainError('not_found', 'Material is unavailable', 404);
    const content = entry.content;
    if (projectId !== undefined && !applicable(content.scope, projectId)) {
      throw new DomainError('not_found', 'Material is unavailable', 404);
    }
    const renewed = renew({ expiresAt: content.expiresAt, savedAt: content.savedAt }, reason, this.now());
    this.import([{ ...content, baseRevision: entry.revision, ...renewed }]);
    return { expiresAt: renewed.expiresAt, renewalReason: renewed.renewalReason };
  }
  /** Live material only, newest first. Expired items are never returned. */
  liveMaterial(projectId?: string, limit = 50) {
    const now = this.now();
    return this.current()
      .filter(entry => entry.content.kind === 'material' && isLive(entry.content.expiresAt, now)
        && (projectId === undefined || applicable(entry.content.scope, projectId)))
      .sort((a, b) => (b.content as { savedAt: number }).savedAt - (a.content as { savedAt: number }).savedAt)
      .slice(0, limit)
      .map(entry => {
        const content = entry.content as Extract<Knowledge, { kind: 'material' }>;
        return {
          id: entry.id, revision: entry.revision, title: content.title, url: content.url,
          summary: content.summary, savedAt: content.savedAt, expiresAt: content.expiresAt,
          taskId: content.taskId ?? null, provenance: content.provenance,
          renewalReason: content.renewalReason ?? null,
        };
      });
  }
  /** Counts for the management interface, so retention is visible rather than implied. */
  materialStats() {
    const now = this.now();
    const all = this.current().filter(entry => entry.content.kind === 'material');
    const live = all.filter(entry => isLive((entry.content as { expiresAt: number }).expiresAt, now));
    return {
      live: live.length, expired: all.length - live.length, total: all.length,
      ttlDays: MATERIAL_TTL_DAYS,
      nextExpiry: live.length
        ? Math.min(...live.map(entry => (entry.content as { expiresAt: number }).expiresAt))
        : null,
    };
  }
  /** Rescan cadence bookkeeping, read by adapters on session start. */
  rescanState() {
    return {
      lastRescanAt: Number(this.db.prepare("SELECT value FROM meta WHERE key='lastRescanAt'").get()!.value),
      intervalMs: Number(this.db.prepare("SELECT value FROM meta WHERE key='rescanIntervalMs'").get()!.value),
    };
  }
  markRescanned(at = this.now()) {
    this.db.prepare("UPDATE meta SET value=? WHERE key='lastRescanAt'").run(at);
    return this.rescanState();
  }
  setRescanInterval(ms: number) {
    if (!Number.isSafeInteger(ms) || ms < 60_000) throw new DomainError('invalid_interval', 'Rescan interval must be at least one minute', 400);
    this.db.prepare("UPDATE meta SET value=? WHERE key='rescanIntervalMs'").run(ms);
    return this.rescanState();
  }
  /** Roots a periodic rescan should walk; empty means "use the default roots". */
  scanRoots(): string[] {
    const raw = String(this.db.prepare("SELECT value FROM meta WHERE key='scanRoots'").get()!.value);
    return raw ? raw.split('\n').map(line => line.trim()).filter(Boolean) : [];
  }
  setScanRoots(roots: string[]) {
    this.db.prepare("UPDATE meta SET value=? WHERE key='scanRoots'").run(roots.map(root => root.trim()).filter(Boolean).join('\n'));
    return this.scanRoots();
  }
  /** True when the configured cadence has elapsed since the last scan. */
  rescanDue(at = this.now()): boolean {
    const { lastRescanAt, intervalMs } = this.rescanState();
    return at - lastRescanAt >= intervalMs;
  }
  /**
   * Record that one entry supersedes or supplements another.
   *
   * "Latest wins" is a precedence rule, not a delete: the earlier revision stays
   * in `revisions` forever, and this row is the only thing that says it was
   * replaced and on what basis. Both the replacement and the retirement happen in
   * one transaction so the library is never left half-switched.
   */
  supersede(input: {
    oldId: string; newId: string; action: 'supersede' | 'supplement';
    reason: string; evidence: string; origin: 'rescan' | 'agent' | 'user';
    /** Scope the caller is acting within; both entries must be visible to it. */
    projectId?: string;
  }): { oldRevision: number; newRevision: number; historyPreserved: true } {
    const reason = input.reason.trim().slice(0, 500);
    const evidence = input.evidence.trim().slice(0, 2000);
    if (!reason) throw new DomainError('missing_reason', 'A supersession must state why', 400);
    if (!evidence) throw new DomainError('missing_evidence', 'A supersession must cite evidence', 400);
    if (input.oldId === input.newId) throw new DomainError('self_supersession', 'An entry cannot supersede itself', 400);
    return this.transaction(() => {
      const oldEntry = this.head(input.oldId);
      const newEntry = this.head(input.newId);
      if (!oldEntry) throw new DomainError('not_found', `Superseded entry ${input.oldId} is unavailable`, 404);
      if (!newEntry) throw new DomainError('not_found', `Replacement entry ${input.newId} is unavailable`, 404);
      // The replacement must be usable. Retiring the old entry in favour of an entry
      // that is itself retired produced a chain with no effective conclusion: the
      // receipt said success while both ends sat outside the live library, which is
      // the opposite of what a supersession is for.
      if (newEntry.status !== 'active')
        throw new DomainError('not_active', `Replacement entry ${input.newId} is ${newEntry.status}; a replacement must be active`, 409);
      if (oldEntry.content.kind !== newEntry.content.kind)
        throw new DomainError('kind_changed', 'A replacement must keep the same knowledge kind', 409);
      // Both entries must be visible to the caller's scope. Without this a
      // credential for one project could retire another project's knowledge
      // merely by naming its id.
      if (input.projectId) {
        const visible = (entry: Entry) => entry.content.scope.kind === 'global'
          || entry.content.scope.projectId === input.projectId;
        if (!visible(oldEntry)) throw new DomainError('not_found', `Superseded entry ${input.oldId} is unavailable`, 404);
        if (!visible(newEntry)) throw new DomainError('not_found', `Replacement entry ${input.newId} is unavailable`, 404);
      }

      // Only a 'supersede' retires the earlier entry; a 'supplement' adds
      // alongside it, because a complement is not a contradiction.
      if (input.action === 'supersede') {
        const result = this.db.prepare("UPDATE knowledge SET status='retired' WHERE id=? AND head=? AND status='active'")
          .run(input.oldId, oldEntry.revision);
        if (!result.changes) throw new DomainError('not_active', `Superseded entry ${input.oldId} is not active`, 409);
        this.db.prepare('DELETE FROM workflow_search WHERE id=?').run(input.oldId);
      }
      this.db.prepare(`INSERT INTO supersessions(old_knowledge_id,old_revision,new_knowledge_id,new_revision,action,reason,evidence,origin,replaced_local_edit,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(input.oldId, oldEntry.revision, input.newId, newEntry.revision,
          input.action, reason, evidence, input.origin, 0, this.now());
      // A supplement is a real relation, so it advances the knowledge version. It
      // used to write the ledger row and nothing else, which meant a reader could
      // not tell that the two entries were related — the relation existed only in a
      // table the normal read path never consults.
      this.db.prepare("UPDATE meta SET value=value+1 WHERE key='revision'").run();
    this.jobs.enqueue('notify', `revision:${this.revision}`, { revision: this.revision });
      return {
        action: input.action,
        oldRevision: oldEntry.revision, newRevision: newEntry.revision,
        historyPreserved: true as const,
      };
    });
  }
  /**
   * Supersession ledger, newest first. Reads only.
   *
   * `projectId` narrows the answer to links whose either end the caller may see.
   * The recent-history panel is the leak that mattered: an unscoped ledger handed
   * one project another project's titles and the *reason* and *evidence* text a
   * replacement was made on, which is exactly the material an entry is scoped to
   * protect. Omitting the argument is the unscoped administrative view.
   */
  supersessions(forId?: string, projectId?: string) {
    const rows = forId
      ? this.db.prepare('SELECT * FROM supersessions WHERE old_knowledge_id=? OR new_knowledge_id=? ORDER BY created_at DESC, id DESC').all(forId, forId)
      : this.db.prepare('SELECT * FROM supersessions ORDER BY created_at DESC, id DESC').all();
    const visible = (id: string): boolean => {
      if (projectId === undefined) return true;
      const entry = this.head(id) ?? this.decodeAny(id);
      // A purged material id has no entry left; its lifecycle ledger row is
      // attributed to whichever project the caller's own list is about only when
      // the id is genuinely unknown. Rather than guess, it is hidden.
      if (!entry) return false;
      return entry.content.scope.kind === 'global' || entry.content.scope.projectId === projectId;
    };
    return rows.filter(row => visible(String(row.old_knowledge_id)) || visible(String(row.new_knowledge_id)))
      .map(row => ({
      id: Number(row.id),
      oldKnowledgeId: String(row.old_knowledge_id), oldRevision: Number(row.old_revision),
      newKnowledgeId: String(row.new_knowledge_id), newRevision: Number(row.new_revision),
      action: String(row.action) as 'supersede' | 'supplement',
      reason: String(row.reason), evidence: String(row.evidence),
      origin: String(row.origin) as 'rescan' | 'agent' | 'user',
      replacedLocalEdit: Number(row.replaced_local_edit) === 1,
      createdAt: Number(row.created_at),
    }));
  }
  /**
   * Full lineage of one knowledge id: every supersession it took part in.
   *
   * Lets a reader answer "why is this the current version, and what did it
   * replace" without exposing retired bodies in normal retrieval.
   *
   * The revision list is behind `requireVisible` when a project is named: the
   * history endpoint is read by both projects, and without the check one project's
   * credential could enumerate another project's entry by id — the same class of
   * leak as the unscoped recent-history list.
   */
  history(id: string, projectId?: string) {
    // `decodeAny` deliberately sees retired entries too: history must not vanish
    // when an entry leaves the effective library. Visibility is decided by scope,
    // not by status, which is why the check uses the same reference-entry helper
    // the review methods do rather than the live set.
    const entry = projectId === undefined
      ? (this.head(id) ?? this.decodeAny(id))
      : (() => { try { return this.requireVisible(id, projectId); } catch { return undefined; } })();
    const revisions = this.db.prepare('SELECT revision,created_at FROM revisions WHERE id=? ORDER BY revision').all(id)
      .map(row => ({ revision: Number(row.revision), createdAt: Number(row.created_at) }));
    const chain = this.supersessions(id, projectId);
    // An unknown id is reported as missing rather than as an empty lineage: a
    // 200 with no revisions would read as "this entry exists but has no history",
    // which is a different and misleading statement. A known-but-foreign id is
    // reported the same way, because "it exists but is not yours" is not something
    // a caller should be able to distinguish.
    if (!entry) {
      throw new DomainError('not_found', `Knowledge entry ${id} is unavailable`, 404);
    }
    return {
      id,
      current: { revision: entry.revision, status: entry.status, kind: entry.content.kind, title: entry.content.title },
      // Every immutable revision stays readable, retired or not.
      revisions,
      chain,
      /**
       * Where a reader can fetch an old revision's prose.
       *
       * F09: the history view listed revisions but the only fetch path refused a
       * non-current `@revision` with 409, so a reader could see that v1 existed
       * and never see what it said. The dedicated route below reads history — it
       * does not weaken the current-version guard on `read`/`get`, which still
       * refuse a stale handle — and this field tells the page where that is.
       */
      revisionReadHint: '历史修订正文通过 /v1/knowledge/history/read 只读查阅（不得作为当前版本使用）。',
    };
  }
  /**
   * Read one historical revision of an entry, read-only.
   *
   * The revision guard on the retrieval path exists so a caller cannot act on a
   * version that is no longer current; it is not a reason for the human's history
   * page to be blind. This method is deliberately separate: it answers "what did
   * v1 say" without ever returning a handle a caller could confuse with the
   * current one, and it applies the same scope rule as `history` so one project
   * cannot read another's past.
   */
  readRevision(id: string, revision: number, projectId: string) {
    const { id: bareId } = this.resolveKnowledgeId(id);
    const row = this.db.prepare('SELECT content FROM revisions WHERE id=? AND revision=?').get(bareId, revision) as { content: string } | undefined;
    if (!row) throw new DomainError('not_found', `Revision ${bareId}@${revision} does not exist`, 404);
    let content: Knowledge;
    try { content = JSON.parse(String(row.content)) as Knowledge; } catch { throw new DomainError('internal_error', `Revision ${bareId}@${revision} is unreadable`, 500); }
    if (!applicable(content.scope, projectId)) {
      throw new DomainError('not_found', `Knowledge entry ${bareId} is unavailable`, 404);
    }
    const head = this.head(bareId);
    const proseOf = (value: Knowledge): string => {
      switch (value.kind) {
        case 'skill':
        case 'memory':
        case 'norm':
        case 'preference':
        case 'material': return value.body;
        case 'journal': return value.did;
        case 'workflow': return value.overview;
      }
    };
    return {
      id: bareId, revision,
      isCurrent: head?.revision === revision,
      currentRevision: head?.revision ?? null,
      currentStatus: head?.status ?? null,
      kind: content.kind, title: content.title,
      body: proseOf(content),
      scope: content.scope,
      provenance: content.provenance,
      evidence: content.evidence,
      createdAt: Number((this.db.prepare('SELECT created_at FROM revisions WHERE id=? AND revision=?').get(bareId, revision) as { created_at: number }).created_at),
      note: '这是历史修订的只读视图；如需以旧版为准，请先提交候选并按审阅流程更新。',
    };
  }
  /** Head lookup that also sees retired entries, for history display only. */
  private decodeAny(id: string): Entry | undefined {
    const row = this.db.prepare(`SELECT k.id,k.head,k.status,r.content FROM knowledge k
      JOIN revisions r ON k.id=r.id AND k.head=r.revision WHERE k.id=?`).get(id);
    return row && this.decode(row);
  }
  stats() {
    this.cleanup();
    // Undelivered work is part of the library's state, so it belongs in the same
    // summary as entries and candidates: an operator asking "is anything stuck?"
    // should not have to know a second endpoint to find out.
    const outbox = Object.fromEntries(this.db.prepare("SELECT status, count(*) AS n FROM outbox WHERE status IN ('pending','failed','abandoned') GROUP BY status")
      .all().map(row => [String(row.status), Number(row.n)]));
    return { knowledgeRevision: this.revision, entries: this.current().length,
      pendingProposals: Number(this.db.prepare("SELECT count(*) AS n FROM proposals WHERE state='pending'").get()!.n),
      events: Number(this.db.prepare('SELECT count(*) AS n FROM events').get()!.n),
      tasks: Number(this.db.prepare('SELECT count(*) AS n FROM tasks').get()!.n),
      adoptions: Number(this.db.prepare('SELECT count(*) AS n FROM adoptions WHERE revoked_at IS NULL').get()!.n),
      supersessions: Number(this.db.prepare('SELECT count(*) AS n FROM supersessions').get()!.n),
      outbox: { pending: Number(outbox.pending ?? 0), failed: Number(outbox.failed ?? 0), abandoned: Number(outbox.abandoned ?? 0) },
      lastRescanAt: Number(this.db.prepare("SELECT value FROM meta WHERE key='lastRescanAt'").get()!.value) };
  }
}

/**
 * Task convergence defaults, overridable per library through `meta`.
 *
 * They live outside the class because they are policy numbers a test and an
 * operator both need to name, and inside the same file as the rule that uses them
 * so the two cannot drift apart. The values are argued where they are applied:
 * see `taskIdleConvergeMs` and `taskArchiveAfterMs`.
 */
export const TASK_IDLE_CONVERGE_MS = 12 * 3600_000;
export const TASK_ARCHIVE_AFTER_MS = 48 * 3600_000;
/**
 * How long the task record's `notes` may grow before the oldest lines are dropped.
 *
 * The column is free text a person reads, and convergence appends a line every
 * time it acts. Trimming from the front keeps the newest explanation — which is
 * the one a reader needs — and the archive marker near the tail, so the idempotency
 * check that looks for it cannot be defeated by the trim itself.
 */
const TASK_NOTES_LIMIT = 4000;
/** Append one line to a task's notes, keeping the most recent text. */
function appendTaskNote(current: string, line: string): string {
  const next = current ? `${current}\n${line}` : line;
  return next.length <= TASK_NOTES_LIMIT ? next : next.slice(next.length - TASK_NOTES_LIMIT);
}
/**
 * The bookkeeping lines convergence writes into a task's notes, and the filter that
 * keeps them out of the archived diary.
 *
 * They are the core's record of what it did to the task, not something the session
 * said. Leaving them in would be more than untidy: the archive decides whether to
 * write by comparing the diary it would produce against the stored entry, and a
 * diary that quotes the archive marker differs from itself on every pass — the
 * archive would rewrite its own revision forever instead of being idempotent.
 */
const CONVERGENCE_NOTE_MARKERS = ['[自动收敛 ', '[会话归档] '];
function stripConvergenceNotes(notes: string): string {
  return notes.split('\n')
    .filter(line => !CONVERGENCE_NOTE_MARKERS.some(marker => line.startsWith(marker)))
    .join('\n').trim();
}
/**
 * The id of the task-scoped diary for one task.
 *
 * Named after the task so the entry can be found without a lookup table, and
 * hashed when the name would exceed the identifier limit: two long task ids can
 * share a 120-character prefix, and silently colliding there would file one task's
 * diary under another's id.
 */
export function taskArchiveId(taskId: string): string {
  const named = `journal-task-${taskId}`;
  return named.length <= 120 ? named : `journal-task-${createHash('sha256').update(taskId).digest('hex').slice(0, 16)}`;
}
/**
 * A comparable form of an entry's content: key order and `baseRevision` removed.
 *
 * Convergence runs on a timer, so "did anything change since the last run" has to
 * be answered without writing. Comparing the serialised content directly would
 * answer "changed" for two identical entries whose keys were stored in a different
 * order, and counting `baseRevision` would make every archive look new.
 */
function stableContent(value: unknown): string {
  return JSON.stringify(value, (_key, inner) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>)
        .filter(([key]) => key !== 'baseRevision')
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner);
}
