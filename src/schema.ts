import { z } from 'zod';

export const identifier = z.string().min(1).max(120).regex(/^[\p{L}\p{N}_.:-]+$/u);
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
const common = {
  id: identifier, title: shortText, scope: scopeSchema,
  baseRevision: z.number().int().nonnegative().default(0),
  /** Browsing aids. Never used for authority, only for finding things. */
  labels: z.array(shortText).max(30).default([]),
  provenance: provenanceSchema.default('user'),
  evidence: evidenceLevelSchema.default('unverifiable'),
  /** Which hosts this applies to; empty means both. */
  platforms: z.array(z.enum(['dsh', 'codex'])).max(2).default([]),
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
  did: z.string().trim().min(1).max(2000),
  problems: z.string().trim().max(2000).default(''),
  /** Where this task's experience landed, if any: entry ids or file paths. */
  experienceLanded: z.array(shortText).max(30).default([]),
  outcome: z.enum(['success', 'failure', 'unverified']),
  unfinished: z.array(shortText).max(50).default([]),
}).strict();
/** Temporary material expires this long after it was saved. */
export const MATERIAL_TTL_DAYS = 90;
/**
 * Temporary material: a URL, its summary, and body only when needed.
 *
 * Expiry is stored rather than computed so a retention change does not silently
 * resurrect old material, and `renewalReason` exists because the design requires
 * an explicit renewal to say why — ordinary reading must not extend a lifetime.
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
export const proposalSchema = z.object({
  idempotencyKey: identifier, projectId: identifier, taskId: identifier.optional(),
  workflowId: identifier.optional(), baseRevision: z.number().int().positive().optional(),
  discovery: z.string().trim().min(1).max(12000),
}).strict();
export const eventSchema = z.object({
  eventId: identifier, adapter: z.enum(['codex', 'dsh']), projectId: identifier,
  taskId: identifier.optional(), sessionId: z.string().min(1).max(256).optional(), kind: z.string().min(1).max(100),
  summary: z.string().max(2000),
}).strict();
export const contextSchema = z.object({
  adapter: z.enum(['codex', 'dsh']).optional(), projectId: identifier,
  taskId: identifier.optional(), sessionId: z.string().min(1).max(256).optional(), query: z.string().max(4000).default(''),
}).strict();
export const gateSchema = z.object({
  adapter: z.enum(['codex', 'dsh']).optional(), projectId: identifier,
  taskId: identifier.optional(), sessionId: z.string().min(1).max(256).optional(), toolName: z.string().min(1).max(300),
  knowledgeRevision: z.number().int().nonnegative().optional(),
}).strict();
export const expandSchema = z.object({ projectId: identifier, workflowId: identifier, stageId: identifier }).strict();
export const taskStatus = z.enum(['in_progress', 'paused', 'completed', 'cancelled', 'failed']);
export const taskSchema = z.object({
  id: identifier, title: shortText, status: taskStatus,
  summary: z.string().trim().max(2000).default(''),
  notes: z.string().trim().max(4000).default(''),
  unfinished: z.array(shortText).max(50).default([]),
}).strict();

export class DomainError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
