import { z } from 'zod';

export const identifier = z.string().min(1).max(120).regex(/^[\p{L}\p{N}_.:-]+$/u);
const shortText = z.string().trim().min(1).max(2000);
export const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }).strict(),
  z.object({ kind: z.literal('project'), projectId: identifier }).strict(),
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
const common = {
  id: identifier, title: shortText, scope: scopeSchema,
  baseRevision: z.number().int().nonnegative().default(0),
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
export const knowledgeSchema = z.union([workflowSchema, normSchema, skillSchema, memorySchema]);
export const seedSchema = z.object({ entries: z.array(knowledgeSchema).min(1).max(100) }).strict();
export type Knowledge = z.infer<typeof knowledgeSchema>;
export type Workflow = z.infer<typeof workflowSchema>;
export type SkillEntry = z.infer<typeof skillSchema>;
export type Scope = z.infer<typeof scopeSchema>;
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
