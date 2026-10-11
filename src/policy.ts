import { type KnowledgeDraft } from './schema.js';

/**
 * Which review tier a change falls into.
 *
 * The design gives a boundary table (§6.3) rather than a single rule, because
 * "how much review does this need" depends on what is being changed. Two properties
 * make it worth implementing rather than documenting:
 *
 *   - The table is *program*, not advice. It says an agent "may propose but must not
 *     self-approve", and a boundary that only exists in prose is one an adapter can
 *     step over by calling the right endpoint.
 *   - The tiers are ordered, so a caller can ask for the weakest tier that applies
 *     and the answer is decided here rather than at each call site. Three call sites
 *     each judging "is this low risk" is how a policy starts disagreeing with itself.
 *
 * The tiers, weakest first:
 *
 *   - `auto` — the change is verifiable and confined. Applied and recorded.
 *   - `review` — a proposal a human should see before it takes effect.
 *   - `user` — the design reserves it for the user: an inferred preference, a widening
 *     to global scope, a settlerule change, or a genuine conflict.
 *
 * "Auto" here means *this policy permits it*, not that this module performs it.
 * Nothing in this file writes: it answers a question, and the caller decides.
 */

export type ReviewTier = 'auto' | 'review' | 'user';

export interface ChangeFacts {
  /** What the change does to the library. */
  intent: 'fix-typo' | 'complete-source' | 'merge-duplicate' | 'replace-norm' | 'new-experience' | 'revise-conclusion' | 'infer-preference' | 'widen-scope' | 'edit-policy';
  /** Where the change came from. An agent's inference is not the user's statement. */
  provenance: 'user' | 'external' | 'agent';
  /** How well it is supported. */
  evidence: 'observed' | 'verifiable' | 'self-reported' | 'unverifiable';
  /** Whether the change reaches beyond the scope it was made in. */
  scopeChange?: { from: KnowledgeDraft['scope']; to: KnowledgeDraft['scope'] } | undefined;
  /** Whether the target entry has diverged since the change was based on it. */
  conflicts?: boolean;
}

export interface ReviewDecision {
  tier: ReviewTier;
  /** Why this tier, naming the design rule that decided it. */
  reason: string;
  /** What the caller must not do at this tier, stated so it cannot be misread. */
  constraint: string;
}

/** Widening: any change that ends up broader than it started. */
function widensScope(facts: ChangeFacts): boolean {
  const { from, to } = facts.scopeChange ?? {};
  if (!from || !to) return false;
  if (from.kind === 'global') return false;
  if (to.kind === 'global') return true;
  // project -> task is narrowing; task -> project is a widening even though both
  // name a project, because it now applies to work the change was not made for.
  if (from.kind === 'task' && to.kind === 'project') return true;
  return false;
}

/**
 * Decide the tier.
 *
 * The order of the checks is the policy: anything the design reserves for the user
 * is tested before the more permissive tiers, so a change cannot reach `auto` by
 * also being, say, a small edit. Rule changes and scope widening come first for that
 * reason — they are the two an agent is most able to make look innocuous.
 */
export function reviewDecision(facts: ChangeFacts): ReviewDecision {
  // The design is explicit: "修改分类/审核规则自身 — 初期建议用户批准；agent 可提出
  // 修改但不能自我批准". An agent editing the policy that governs it is not a change
  // any automatic tier can cover.
  if (facts.intent === 'edit-policy') {
    return {
      tier: 'user',
      reason: '修改审核规则自身：设计规定初期须用户批准，agent 只能提出',
      constraint: '不得由 agent 自行应用；即使用户要求，也必须留下变更记录',
    };
  }
  // "推断用户偏好、扩大到全局、重大冲突 — 严格候选流程，必要时用户决定."
  if (facts.intent === 'infer-preference') {
    return {
      tier: 'user',
      reason: '推断出的偏好：设计禁止把系统归纳当成用户的明确陈述',
      constraint: '推断不得写成用户说过；只有用户明确陈述才能进入规范',
    };
  }
  if (widensScope(facts)) {
    return {
      tier: 'user',
      reason: '把范围扩大到更广的作用域：设计要求"这一次"不被自动扩成全局',
      constraint: '扩大范围必须由用户明确决定，不能由 agent 顺带完成',
    };
  }
  if (facts.conflicts) {
    return {
      tier: 'user',
      reason: '与现有条目冲突：设计要求保留冲突并澄清，不能按"最后写入"解决',
      constraint: '不得静默覆盖；两份内容都要保留，等用户裁决',
    };
  }

  // "用户明确同范围替换一条规范 — 核实原话及目标后替换，保留历史并同步新版本."
  if (facts.intent === 'replace-norm') {
    // A user's own stated replacement still needs the original wording and target
    // verified, which is a review step, not an automatic one.
    return facts.provenance === 'user'
      ? { tier: 'review', reason: '用户要求替换规范：需核实原话与目标后替换，保留历史', constraint: '替换前须核对原话与目标条目；旧版本必须留在历史中' }
      : { tier: 'user', reason: '非用户来源试图替换规范：规范变更只能由用户授权', constraint: '不得由 agent 或外部内容替换规范' };
  }

  // "明确重复资料或内容 — 合并重复来源/拒绝重复保存；不顺带改变到期时间或范围."
  if (facts.intent === 'merge-duplicate' || facts.intent === 'fix-typo') {
    return {
      tier: 'auto',
      reason: facts.intent === 'merge-duplicate'
        ? '明确重复：合并来源或拒收，属可直接核验的处理'
        : '限定范围内的小幅整理：可核验，属可直接核验的处理',
      constraint: '不得顺带改变到期时间或作用范围；变更记录仍须保存',
    };
  }
  // "可核验的来源补全、限定范围内的小幅整理 — 可自动处理，仍保存变更记录."
  if (facts.intent === 'complete-source') {
    return facts.evidence === 'observed' || facts.evidence === 'verifiable'
      ? { tier: 'auto', reason: '来源补全且证据可核验：设计列为可自动处理，仍保存变更记录', constraint: '只补全来源，不改写结论；记录不得省略' }
      : { tier: 'review', reason: '来源补全但没有可核验证据：只能作为候选', constraint: '自述不足为证，不得直接生效' };
  }

  // "新经验、语义合并、修正旧结论 — 根据证据、影响和既定审核政策自动通过或保留候选."
  if (facts.evidence === 'observed' || facts.evidence === 'verifiable') {
    return {
      tier: 'review',
      reason: '有可核验证据的新经验或修正：可进入候选，由既定政策决定是否放行',
      constraint: '置信度只作辅助，不单独决定是否生效',
    };
  }
  return {
    tier: 'review',
    reason: '证据不足：设计规定"证据不足时不勉强写入正式知识"',
    constraint: '自述与无核验内容不得作为已验证证据；只能保留候选或要求补证',
  };
}

/**
 * Whether a caller may act on a decision without a human.
 *
 * One function so both adapters answer the same way. `review` is deliberately not
 * automatic: a proposal that a human should see is the tier's whole meaning.
 */
export function mayAutoApply(decision: ReviewDecision): boolean {
  return decision.tier === 'auto';
}
