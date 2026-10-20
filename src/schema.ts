import { z } from 'zod';

// No Unicode property escapes. A tool schema that carries \p{...} makes strict
// upstreams (xAI/Grok) reject the whole request with invalid_client_tool_schema
// before any tool runs. A negated whitespace class keeps "no spaces" without
// leaving the ASCII class that JSON Schema actually understands.
export const identifier = z.string().min(1).max(120).regex(/^[^\s]+$/);
const shortText = z.string().trim().min(1).max(2000);
/**
 * Where an entry applies.
 *
 * A task scope exists because the design requires it: "这一次用 Banana" must apply
 * to the current task without being widened into a rule for every future task. A
 * project scope could not express that, so the only honest options were a narrower
 * scope or silently over-applying.
 */
export const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }).strict(),
  z.object({ kind: z.literal('project'), projectId: identifier }).strict(),
  z.object({ kind: z.literal('task'), projectId: identifier, taskId: identifier }).strict(),
]);
export const dependencySchema = z.object({
  workflowId: identifier, revision: z.number().int().positive(),
  relationship: z.enum(['prerequisite', 'substep', 'reference']),
}).strict();
export const stageSchema = z.object({
  id: identifier, title: shortText, instructions: z.string().trim().min(1).max(12000),
  checks: z.array(shortText).min(1).max(30),
  dependencies: z.array(dependencySchema).max(30).default([]),
}).strict();
/**
 * Who authored an entry.
 *
 * The design requires these identities to stay distinguishable: a normative
 * sentence on a web page is not the user's rule, and an agent's inference is not
 * the user's statement. Dropping the distinction is how imperative prose from a
 * fetched page becomes a rule the agent then obeys.
 */
export const provenanceSchema = z.enum(['user', 'external', 'agent']);
/**
 * How well a claim is supported.
 *
 * Ordered from strongest to weakest: something the plugin observed itself, a
 * checkable external artifact, an agent's own account, and nothing at all.
 * `self-reported` is the default for anything arriving as a claim, because an
 * agent saying "tests passed" must never be recorded as if it were verified.
 */
export const evidenceLevelSchema = z.enum(['observed', 'verifiable', 'self-reported', 'unverifiable']);
export const memoryContextSchema = z.object({
  kind: z.enum(['norm', 'preference', 'memory', 'skill', 'material', 'journal']).optional(),
  scope: z.enum(['global', 'project', 'task']).optional(),
  durability: z.enum(['durable', 'temporary']).optional(),
  /**
   * 工作类别：这条讲的是哪摊事（受控词表见 `domain-taxonomy.ts`）。
   *
   * 与 kind/scope 正交：kind 说"是什么"，scope 说"管多大"，domain 说"属于哪类工作"。
   * 只服务检索与导航，不参与权限、门禁与采纳判定。校验放在写入路径（未知域拒收），
   * 不放在 schema 层，避免 schema 反过来依赖域词表。
   */
  domain: shortText.optional(),
  appliesWhen: z.array(shortText).max(20).optional(),
  invalidatedWhen: z.array(shortText).max(20).optional(),
}).strict();
export const validitySchema = z.object({
  expiresAt: z.number().int().positive(),
  reason: shortText,
  appliesWhen: z.array(shortText).max(20).default([]),
  invalidatedWhen: z.array(shortText).max(20).default([]),
}).strict();
export const evidenceReferenceSchema = z.object({
  kind: z.enum(['artifact', 'command', 'url', 'knowledge', 'event']),
  locator: z.string().trim().min(1).max(2000),
  snapshot: z.string().max(6000).optional(),
  /** Computed on the retained, sanitized snapshot, not proof that the claim is true. */
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  reportedHash: z.string().max(128).optional(),
  /**
   * The plugin filled this reference in from the session's own event stream instead of
   * the caller citing it. Recorded so a reader can tell an automatic capture from a
   * deliberate citation; attaching it never raises the evidence level.
   */
  autoCollected: z.boolean().optional(),
  revision: z.number().int().positive().optional(),
  observedAt: z.number().int().nonnegative().optional(),
  result: z.string().max(1000).optional(),
}).strict();
export const supportSchema = z.object({
  origin: z.object({ kind: z.enum(['proposal', 'checkpoint', 'source']), id: identifier, principal: identifier,
    projectId: identifier.optional(), taskId: identifier.optional(), sessionIds: z.array(z.string().min(1).max(256)).max(100),
    capturedAt: z.number().int().nonnegative(),
  }).strict(),
  summary: z.string().max(4000), references: z.array(evidenceReferenceSchema).max(110),
  supplements: z.array(z.object({ evidence: z.string().max(2000), at: z.number(), actor: z.string().max(200) }).strict()).max(100),
  status: z.enum(['missing', 'referenced', 'captured']), snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  /**
   * A person's explicit decision to promote a claim that cites nothing.
   *
   * It is recorded next to the evidence rather than in a decision log so a later
   * backup, export or revision cannot separate the claim from the reason it was let
   * in. A waived entry is readable and reviewable, but it is never auto-injected:
   * "a human accepted the risk once" is not the same as "this is supported".
   */
  waiver: z.object({ reason: shortText, actor: identifier, at: z.number().int().nonnegative() }).strict().optional(),
  predecessor: z.object({ id: identifier, revision: z.number().int().positive() }).strict().optional(),
}).strict();
export const curationSchema = z.object({
  batchId: identifier,
  role: z.enum(['record', 'source', 'collection']),
  scopeStatus: z.enum(['confirmed', 'unresolved']),
  durability: z.enum(['historical', 'durable', 'temporary', 'uncertain']),
  domain: shortText.optional(),
  sources: z.array(z.object({
    id: identifier, revision: z.number().int().positive(), hash: z.string().length(64),
    quote: z.string().max(1000).optional(),
  }).strict()).max(300).default([]),
  members: z.array(identifier).max(300).default([]),
  note: shortText.optional(),
}).strict();
const common = {
  id: identifier, title: shortText, scope: scopeSchema,
  /** Optional for compatibility; reading never renews a temporary claim. */
  validity: validitySchema.optional(),
  applicability: memoryContextSchema.optional(),
  /** Provenance and retrieval role, not a source of instruction authority. */
  curation: curationSchema.optional(),
  /** Evidence is retained outside prose and full-text indexes. A capture is not verification. */
  support: supportSchema.optional(),
  baseRevision: z.number().int().nonnegative().default(0),
  /** Browsing aids. Never used for authority, only for finding things. */
  labels: z.array(shortText).max(30).default([]),
  provenance: provenanceSchema.default('user'),
  evidence: evidenceLevelSchema.default('unverifiable'),
  /** Which hosts this applies to; empty means both. */
  platforms: z.array(z.enum(['dsh', 'codex'])).max(2).default([]),
  /**
   * 术语桥：让「用户怎么说」与「库里怎么写」对上。
   *
   * 实测的病：库里 173 条条目，173 条没有任何桥字段。用户说"我装插件之前存进去的那些
   * 技能和规范"，而那条的标题是别的词，于是检索 `matched=0`、agent 就"听不懂"——
   * 这不是模型笨，是**库里没有可对上的术语**。同义说法与白话说法全部落空。
   *
   * 两个字段都在 `common` 里，所以每种 kind 都带着它们；而 `searchable()` 索引的是整条
   * content 的 JSON，因此**它们自动进入全文索引**——检索侧一行都不用改，用户搜别名就能
   * 命中原条目，并且 `why.matched` 会显示是哪个词命中的（可解释）。
   *
   * `aliases` 是「同一种东西的别的叫法」（含用户的白话与中英对照），`keywords` 是
   * 「这条讲什么」的高权重术语。两者都只是**检索用**的辅助，不参与权限、门禁与判定——
   * 与 `labels` 同一条纪律：它们只用来找东西。
   */
  aliases: z.array(shortText).max(40).default([]),
  keywords: z.array(shortText).max(60).default([]),
};
/**
 * Provenance for a workflow that was structured from an adopted skill document.
 *
 * The stages here are authored, not inferred: a program cannot reliably derive
 * ordered steps, checks and completion criteria from Markdown, so recording who
 * did the structuring and which skill revision it came from keeps the claim
 * honest. A workflow without this field was authored directly.
 */
export const derivedFromSchema = z.object({
  skillId: identifier, skillRevision: z.number().int().positive(),
  derivedBy: z.enum(['user', 'agent']),
  evidence: z.string().trim().min(1).max(2000),
}).strict();
export const workflowSchema = z.object({
  ...common, kind: z.literal('workflow'), overview: shortText,
  triggers: z.array(shortText).min(1).max(20),
  categories: z.array(z.array(shortText).min(1).max(6)).min(1).max(10),
  tags: z.array(shortText).max(30).default([]),
  preconditions: z.array(shortText).min(1).max(30),
  stages: z.array(stageSchema).min(1).max(40),
  completion: z.array(shortText).min(1).max(30),
  recovery: shortText,
  isEntryPoint: z.boolean().default(false),
  derivedFrom: derivedFromSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.stages.map(x => x.id)).size !== value.stages.length)
    ctx.addIssue({ code: 'custom', message: 'Stage IDs must be unique' });
});
export const normSchema = z.object({
  ...common, kind: z.literal('norm'), body: z.string().trim().min(1).max(12000),
  deniedTools: z.array(z.string().min(1).max(200)).max(100).default([]),
  /**
   * True when the host already loads this text natively.
   *
   * DSH ships `@deepseek-ai/dsh-agent-instructions`, which walks for
   * `AGENTS.md`/`CLAUDE.md` and injects them itself. Re-injecting the same bytes
   * through prepare would duplicate instructions and risk fighting the host's
   * own baseline-replacement semantics, so these entries stay indexed and
   * auditable but are never re-injected.
   */
  hostProvided: z.boolean().default(false),
}).strict();
/**
 * Maximum length of a single knowledge body, in characters.
 *
 * Exported because the scan layer must apply the same limit: two independent
 * numbers had drifted apart (the scanner allowed 1 MB by size while the schema
 * allowed 60000 by character), so a document could pass discovery and then be
 * rejected at import — failing the whole batch with one unhelpful message.
 */
export const MAX_BODY_CHARS = 60_000;

/**
 * An adopted skill document from a user's existing agent.
 *
 * A skill's full workflow structure (triggers, preconditions, ordered stages,
 * completion and recovery) cannot be derived reliably from Markdown, so it is
 * stored as `skill` with its body and reference leaves intact rather than being
 * fabricated into a workflow. `needsStructure` marks entries still awaiting an
 * explicit conversion, which keeps them out of workflow retrieval until a human
 * or model supplies the real structure.
 */
export const skillSchema = z.object({
  ...common, kind: z.literal('skill'),
  body: z.string().trim().min(1).max(MAX_BODY_CHARS),
  leaves: z.array(z.object({
    path: z.string().min(1).max(500), hash: z.string().min(1).max(128),
    body: z.string().max(MAX_BODY_CHARS).default(''),
  }).strict()).max(200).default([]),
  needsStructure: z.boolean().default(true),
}).strict();
/**
 * An adopted memory document: durable background facts about a project or
 * environment. Kept distinct from `norm` so a remembered fact is never
 * presented as a requirement the agent must obey.
 */
export const memorySchema = z.object({
  ...common, kind: z.literal('memory'),
  body: z.string().trim().min(1).max(MAX_BODY_CHARS),
}).strict();
/**
 * A user working preference.
 *
 * `stated` separates what the user actually said from what the system inferred.
 * The design forbids the two from being equal in force: an inference may not be
 * promoted to a global hard constraint, so a global inferred preference is
 * rejected outright rather than stored and relied on.
 */
export const preferenceSchema = z.object({
  ...common, kind: z.literal('preference'),
  body: z.string().trim().min(1).max(12000),
  stated: z.boolean().default(true),
}).strict().superRefine((value, ctx) => {
  if (!value.stated && value.scope.kind === 'global') {
    ctx.addIssue({ code: 'custom', message: 'An inferred preference cannot be a global rule; scope it to a project or state it explicitly' });
  }
});
/**
 * A short record of what one task actually did.
 *
 * Not an instruction: a diary says what happened, and must never be read as a rule
 * to follow. `outcome` has three values rather than two because the design
 * requires success, failure and unverified to stay distinct — collapsing
 * "unverified" into "success" is exactly the overclaim this project is built to
 * avoid.
 */
export const journalSchema = z.object({
  ...common, kind: z.literal('journal'),
  /**
   * The task this diary belongs to, when it has one.
   *
   * Optional because two things are journals: a diary the plugin generates for a
   * task, and a dated note the user wrote themselves. The second has no task id,
   * and refusing to store it — or filing it as something else — would mean the
   * user's own daily record never arrives.
   */
  taskId: identifier.optional(),
  did: z.string().min(1).max(1000000),
  problems: z.string().max(1000000).default(''),
  /** Where this task's experience landed, if any: entry ids or file paths. */
  experienceLanded: z.array(shortText).max(30).default([]),
  outcome: z.enum(['success', 'failure', 'unverified']),
  unfinished: z.array(shortText).max(50).default([]),
}).strict();
/**
 * Temporary material: a URL, its summary, and body only when needed.
 * Expiry is stored rather than computed so a retention change does not silently
 * resurrect old material, and `renewalReason` exists because the design requires
 * an explicit renewal to say why — ordinary reading must not extend a lifetime.
 *
 * `expiresAt` defaults to 0, and 0 means *no lifetime* — an entry that is already
 * lapsed. That default is what the store's own write path must never fall through
 * to: `materialEntry` always computes a real 90-day date (design §8), so a
 * submission through `saveMaterial` is fine either way. But an entry arriving
 * through an import path that parses a document directly — `cli seed`, a backup
 * replay — never passes through `materialEntry`, and a missing field then became a
 * stored 0. The result was material that expired the instant it was written: the
 * next `cleanup()` purged it and the seed reported success, so the user was told
 * an entry had been imported that they could never read.
 *
 * Making 0 mean "lapsed" is deliberate and must stay: an explicit 0 is the only
 * way to express "already expired", which `materialSchema` also accepts as
 * written. The fix for the seed case therefore belongs at the import boundary,
 * where a store write can tell "the caller wrote no lifetime" from "the caller
 * deliberately asked for none" — and can say so in its report.
 */
export const materialSchema = z.object({
  ...common, kind: z.literal('material'),
  url: z.string().trim().min(1).max(2000),
  /** Content fingerprint, so the same page saved twice is recognised. */
  fingerprint: z.string().min(1).max(128),
  summary: z.string().trim().min(1).max(2000),
  body: z.string().max(MAX_BODY_CHARS).default(''),
  savedAt: z.number().int().nonnegative().default(0),
  expiresAt: z.number().int().nonnegative().default(0),
  taskId: identifier.optional(),
  renewalReason: z.string().trim().max(500).optional(),
}).strict();
export const knowledgeSchema = z.union([
  workflowSchema, normSchema, skillSchema, memorySchema, preferenceSchema, journalSchema, materialSchema,
]);
export const seedSchema = z.object({ entries: z.array(knowledgeSchema).min(1).max(100) }).strict();
export type Knowledge = z.infer<typeof knowledgeSchema>;
/**
 * A knowledge entry as a caller writes it, before defaults are applied.
 *
 * Metadata such as labels, provenance, evidence level and platform applicability
 * has a sensible default, so a caller that does not care about it should not have
 * to write it out. The store parses every entry it accepts, which fills those in,
 * so what reaches the database is always complete. Without this split, adding a
 * defaulted field would force every construction site in the project to restate it.
 */
export type KnowledgeDraft = z.input<typeof knowledgeSchema>;
export type Workflow = z.infer<typeof workflowSchema>;
export type WorkflowDraft = z.input<typeof workflowSchema>;
export type SkillEntry = z.infer<typeof skillSchema>;
export type Scope = z.infer<typeof scopeSchema>;
export type Provenance = z.infer<typeof provenanceSchema>;
export type EvidenceLevel = z.infer<typeof evidenceLevelSchema>;
/**
 * A candidate experience an agent proposes.
 *
 * `stageId` says which step of `workflowId` the experience belongs to. The
 * workflow-integrity requirement is that a new experience is located *inside* a
 * complete workflow rather than becoming a floating fragment, and a workflow id
 * alone cannot express that: "this belongs to the upgrade process" and "this
 * belongs to the backup step of the upgrade process" are different claims, and
 * only the second one can be reviewed against the step it will change. Nothing
 * here infers the stage from the text — that needs a model service — so the field
 * records what the submitter asserts and is validated for existence (see
 * `Store.submit`), not for semantic fit.
 */
export const proposalSchema = z.object({
  idempotencyKey: identifier, projectId: identifier, taskId: identifier.optional(),
  sessionId: z.string().min(1).max(256).optional(),
  workflowId: identifier.optional(), stageId: identifier.optional(),
  baseRevision: z.number().int().positive().optional(),
  discovery: z.string().trim().min(1).max(12000),
  evidence: z.string().trim().max(4000).optional(),
  evidenceRefs: z.array(evidenceReferenceSchema).max(10).optional(),
  /** Agent declarations aid triage; they grant no authority or wider scope. */
  memoryContext: memoryContextSchema.optional(),
  /**
   * 插件在提交时自行推导的分类结果（kind/scope/domain）。
   *
   * 与 `memoryContext` 分开存放：后者是调用方的**声明**，参与"是不是同一条提交"的判定；
   * 前者是插件的**推断**，不参与去重（否则同一段文字会因为插件开始推断而被当成新提交），
   * 只在条目被采纳、调用方没给声明时补位。
   */
  autoClassification: memoryContextSchema.optional(),
}).strict();
export const eventSchema = z.object({
  eventId: identifier, adapter: z.enum(['codex', 'dsh']), projectId: identifier,
  taskId: identifier.optional(), sessionId: z.string().min(1).max(256).optional(), kind: z.string().min(1).max(100),
  summary: z.string().max(2000),
}).strict();
/**
 * One queued outbound item: a candidate submission or an event capture that could
 * not be delivered when it was produced.
 *
 * Persistent rather than in-process because the design (§6.4) says background work
 * must be recoverable: a candidate an agent produced while the core was down has
 * to survive a desktop restart. The whole request body is kept verbatim, and the
 * replay goes through the same idempotent path as the original attempt, so an item
 * that actually landed before the failure is recognised as a duplicate instead of
 * being written a second time.
 */
export const outboxEntrySchema = z.object({
  kind: z.enum(['candidate', 'event']),
  idempotencyKey: identifier,
  projectId: identifier,
  payload: z.record(z.string(), z.unknown()),
  /** Why the last attempt failed, so the queue is answerable rather than opaque. */
  error: z.string().max(2000).optional(),
  attempts: z.number().int().nonnegative().optional(),
}).strict();
export const contextSchema = z.object({
  adapter: z.enum(['codex', 'dsh']).optional(), projectId: identifier,
  taskId: identifier.optional(), sessionId: z.string().min(1).max(256).optional(), query: z.string().max(4000).default(''),
  /**
   * The revision the caller already holds, for the same-version pointer on the
   * *prepare* path.
   *
   * `gateSchema` has carried this since the decision list was fixed, and `store.prepare`
   * has read `knownRevision` for just as long, but no caller could send it here: the
   * schema rejected the field, so every turn re-injected the whole normative text
   * (594 characters on this machine, linear in the number of norms). Optional and
   * `.strict()` is kept intact, so an unknown field is still a 400.
   */
  knowledgeRevision: z.number().int().nonnegative().optional(),
}).strict();
export const gateSchema = z.object({
  adapter: z.enum(['codex', 'dsh']).optional(), projectId: identifier,
  taskId: identifier.optional(), sessionId: z.string().min(1).max(256).optional(), toolName: z.string().min(1).max(300),
  knowledgeRevision: z.number().int().nonnegative().optional(),
}).strict();
export const expandSchema = z.object({ projectId: identifier, workflowId: identifier, stageId: identifier }).strict();
export const taskStatus = z.enum(['in_progress', 'paused', 'completed', 'cancelled', 'failed']);
/**
 * A task record.
 *
 * The design lists the fields a task must carry, and the original implementation
 * had about half of them: no start or completion time, no links to the experience
 * or proposals the task produced, and no knowledge version. Without `sessionIds`
 * the design's "one task spans several sessions, one session may hold several
 * tasks" cannot be expressed at all, which is why it is a list rather than a
 * single id.
 */
export const taskSchema = z.object({
  id: identifier, title: shortText, status: taskStatus,
  summary: z.string().trim().max(2000).default(''),
  notes: z.string().trim().max(4000).default(''),
  unfinished: z.array(shortText).max(50).default([]),
  /** Sessions this task ran in. A task outlives any one of them. */
  sessionIds: z.array(z.string().min(1).max(256)).max(50).default([]),
  /** Knowledge entries this task produced or changed. */
  relatedExperiences: z.array(identifier).max(100).default([]),
  /** Proposals submitted during this task, whether or not approved. */
  relatedProposals: z.array(identifier).max(100).default([]),
  /** Files the next session should check before continuing. */
  files: z.array(shortText).max(100).default([]),
  /**
   * The observed state of each file when the task last recorded it.
   *
   * Acceptance 16 requires that continuing in a *different checkout* shows how the
   * files differ rather than assuming the other end's edits are already present. A
   * bare path cannot do that — `files` only says "look at this", which is why the
   * handoff could not previously answer the question the design asks. Recording a
   * digest (and size) per path makes the comparison possible on the receiving end
   * without reading the sender's filesystem: the receiving end hashes its own copy
   * and compares.
   *
   * Deliberately not a boolean "changed" flag computed here: the core never sees the
   * receiving end's disk, so only a *recorded* state plus a receiving-side
   * comparison is honest. Nothing infers that a file is unchanged just because a
   * path matches.
   */
  fileStates: z.array(z.object({
    path: z.string().trim().min(1).max(1000),
    /** Content digest when known; absent means "state not recorded". */
    digest: z.string().trim().min(1).max(128).optional(),
    size: z.number().int().nonnegative().optional(),
    /** When this state was observed, so staleness is visible. */
    observedAt: z.number().int().nonnegative().optional(),
  }).strict()).max(200).default([]),
  /** What was verified, and how. Kept separate from `summary`, which is prose. */
  verified: z.string().trim().max(2000).default(''),
  /**
   * How well `verified` is actually supported.
   *
   * `verified` is free text the caller supplies, so on its own it cannot be
   * evidence — an agent writing "tests passed" is a self-report, not an
   * observation. This field is what lets the diary distinguish the two, and it
   * defaults to the weakest level so an adapter that says nothing never upgrades a
   * claim. Only `observed` or `verifiable` may carry a task to `success`.
   */
  evidence: evidenceLevelSchema.default('self-reported'),
  startedAt: z.number().int().nonnegative().optional(),
}).strict();

export class DomainError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
