import { DomainError } from './schema.js';

/**
 * Semantic analysis and similarity ranking module.
 *
 * Design §6.1 & §6.2 mandate:
 * 1. Semantic classification: distinguish norm, preference, memory, skill, material, journal;
 *    detect whether a submission contains multiple distinct categories requiring splitting.
 * 2. Scope classification: determine global, project, or task-scoped applicability.
 * 3. Relation classification: determine whether a candidate is new, duplicate, supplement,
 *    superseding an existing entry, or conflicting.
 * 4. Model & heuristic collaboration: Program provides determinism and authority constraints;
 *    semantic evaluation assists ranking and candidate triage without granting authority
 *    unconditionally. Under offline / model-unavailable situations, heuristic fallback operates
 *    reliably without hanging (Acceptance Case H13).
 */

export type ContentKindClassification = 'norm' | 'preference' | 'memory' | 'skill' | 'material' | 'journal';
export type ScopeClassification = 'global' | 'project' | 'task';
export type RelationClassification = 'new' | 'duplicate' | 'supplement' | 'supersede' | 'conflict' | 'low_value';
/** Who authored the text. Same vocabulary as `provenanceSchema` in `schema.ts`. */
export type ProvenanceClassification = 'user' | 'external' | 'agent';
/** How well the claim is supported. Same vocabulary as `evidenceLevelSchema` in `schema.ts`. */
export type EvidenceClassification = 'observed' | 'verifiable' | 'self-reported' | 'unverifiable';

/**
 * What the caller knows about the text beyond the text itself.
 *
 * Every field is optional, and the defaults describe a *submitted candidate* —
 * `agent` provenance with `self-reported` evidence — because that is what a
 * submission actually is: `Store.submit` computes its review tier from exactly
 * those two facts, never from anything the submitter asserts about itself.
 * A caller holding real external authority has to say so; silence never buys
 * authority, which is the whole point of the field being explicit.
 */
export interface ClassificationContext {
  provenance?: ProvenanceClassification;
  evidence?: EvidenceClassification;
  /** An external authority this text came from (a file name, a document title, a URL). */
  sourceRef?: string;
}

export interface SemanticAnalysis {
  kind: ContentKindClassification;
  scope: ScopeClassification;
  relation: RelationClassification;
  confidence: number;
  needsSplit: boolean;
  suggestedSplit?: Array<{ kind: ContentKindClassification; text: string }>;
  conflictingEntryId?: string;
  reasoning: string;
  /**
   * Whether this candidate may be adopted as it stands, without a person
   * restating its kind and scope.
   *
   * The heuristic is *not* the authority to promote; it only says whether the
   * candidate is safe to promote unattended. For `kind: 'norm'` the answer is
   * `false` unless the evidence is stronger than an agent's own account, the
   * provenance is external or the user's own, an authority reference is present,
   * and the text is not an episode report. A norm is the one kind that takes part
   * in gate decisions — it can deny a tool outright — so one click must not be
   * enough to create one out of an agent's recollection.
   */
  autoPromotable: boolean;
  /** Why `autoPromotable` is false — the sentence a reviewer is shown. Absent when it is true. */
  promotionBlockedReason?: string;
}

/**
 * Compute character n-gram cosine similarity between two strings in [0, 1].
 * Highly effective for Chinese bigrams and technical tokens without requiring heavy runtime models.
 */
export function characterSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const bigrams = (s: string) => {
    const map = new Map<string, number>();
    const clean = s.toLowerCase().replace(/\s+/g, '');
    for (let i = 0; i < clean.length - 1; i += 1) {
      const bg = clean.slice(i, i + 2);
      map.set(bg, (map.get(bg) ?? 0) + 1);
    }
    return map;
  };
  const bgA = bigrams(a), bgB = bigrams(b);
  if (bgA.size === 0 || bgB.size === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (const v of bgA.values()) normA += v * v;
  for (const v of bgB.values()) normB += v * v;
  for (const [k, vA] of bgA.entries()) {
    const vB = bgB.get(k);
    if (vB) dot += vA * vB;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * The words that carry an obligation rather than describe one.
 *
 * `规范` is deliberately absent. It is a noun — a document *about* rules — and
 * matching it meant that any text merely mentioning a rule ("分类规范"、"本项目
 * 规范如下") was read as if it *were* one, with no obligation anywhere in it.
 */
const DEONTIC_ANCHOR = /(?:禁止|严禁|不得|必须|务必|绝不|强制要求|硬性要求)/;

/**
 * An anchor counts only when it governs a predicate.
 *
 * "必须带 x-amb-protocol: 1 请求头" is an instruction: the anchor is immediately
 * followed by an action and its object. "这是因为必须满足某些条件" is a clause
 * inside an explanation, and the old keyword test could not tell the two apart —
 * which is exactly how 193 of 295 real candidates became `norm`.
 *
 * The requirement is structural, not lexical: the anchor must be adjacent to a
 * non-empty content fragment. A text that mentions a constraint word and then
 * stops, or trails into punctuation, is describing something, not instructing.
 *
 * The fragment may contain spaces — "必须带 x-amb-protocol: 1 请求头" is one
 * instruction, and a pattern that stopped at the first space would have rejected
 * it. What it may not do is be *empty*: the lookahead demands one real character
 * (Han, latin, digit or path punctuation) before the rest is allowed to be
 * anything at all.
 */
const IMPERATIVE_CLAUSE = /(?:禁止|严禁|不得|必须|务必|绝不|强制要求|硬性要求)\s*(?:再|直接|始终|一律|同时|只|都|先|立即)?\s*(?=[\p{Script=Han}A-Za-z0-9`<>:/._-])[\p{Script=Han}A-Za-z0-9`<>:/._-][\p{Script=Han}A-Za-z0-9`<>:/._\s-]{0,24}/u;

/**
 * Markers that a passage reports an episode instead of stating a standing rule.
 *
 * These are decisive on their own: a date, a reproduction, an observed failure, a
 * root cause, or the "auto-captured, unverified" preamble the harness writes —
 * none of them can appear in a rule that was handed down from outside. They exist
 * because experience writes almost always contain "必须/不得" *about* something
 * that happened, and the classifier must weigh the episode, not the modal verb.
 */
const NARRATIVE_MARKER = /(?:\d{4}-\d{2}-\d{2}|\d{4}\s*年\s*\d{1,2}\s*月|实测|踩坑|踩过的坑|复现|复跑|跑通|报错|日志显示|我遇到|原来|本次|这次|上次|当时|后来|全程|自动捕获|待核实|尚未验证|失败事实|本记录|本文件|本文|根因|复盘|教训|结论是|真实案例|真实排障|实例[：:]|本例)/;

/**
 * Weaker episode signals, which only count in combination.
 *
 * A single "发现" or "排查" is ordinary prose — "若发现问题必须上报" is a rule.
 * Two *different* signals together ("排查…发现…", "观察…结论…") describe a
 * session, and a session is not a rule. Requiring a pair keeps the rule from
 * misfiring on one incidental word, which is the failure mode that produced the
 * original defect in the opposite direction.
 */
const NARRATIVE_WEAK = /(?:发现|观察|结论|总结|注意点|排查|步骤|记录)/g;

/**
 * The passage opens by naming itself a write-up rather than a constraint.
 *
 * Only the opening title band is inspected: "…经验/…教训/…法：" in a heading is
 * how a human labels an episode, while the same words appearing later in a real
 * rule ("按流程执行") carry no such claim. Charitable in the safe direction —
 * a mis-typed episode costs a manual confirmation, a mis-typed rule costs a gate.
 */
const TITLE_METHOD_MARKER = /(?:经验|复盘|总结|教训|方法|技巧|操作指南|排查过程|闭环法|法[：:]|流程[：:]|步骤[：:]|判据[：:]|记录[：:])/;

/** An authority the text itself cites, which an agent's own account never has. */
const SOURCE_REFERENCE = /(?:AGENTS\.md|CLAUDE\.md|https?:\/\/|来源[：:]|依据[：:]|官方文档|标准原文|RFC\s?\d+)/i;

/** Distinct weak markers in one passage, per `NARRATIVE_WEAK`. */
function weakNarrativeSignals(text: string): number {
  return new Set(text.match(NARRATIVE_WEAK) ?? []).size;
}

/**
 * Whether the text reports what happened, rather than stating what must hold.
 *
 * This is the second condition the kind classifier needs. A keyword says a word
 * is present; only the shape of the passage says whether the text *is* a rule.
 */
function isNarrativeExperience(text: string): boolean {
  if (NARRATIVE_MARKER.test(text)) return true;
  if (weakNarrativeSignals(text) >= 2) return true;
  return TITLE_METHOD_MARKER.test(text.slice(0, 48));
}

/**
 * Check if the text expresses imperative normative constraints.
 *
 * Two conditions must hold together: an obligation word that actually governs a
 * clause, and a passage that is not itself an episode report. Either one alone is
 * what the defect was made of: the keyword test admitted everything, and a
 * structure test alone would still promote "本次实测必须在 X 上加 Y" — true about
 * one session, meaningless as a rule for the next one.
 */
function isNormative(text: string): boolean {
  if (!DEONTIC_ANCHOR.test(text)) return false;
  if (!IMPERATIVE_CLAUSE.test(text)) return false;
  return !isNarrativeExperience(text);
}

/**
 * Whether a candidate may be adopted unattended, and why not when it may not.
 *
 * The rule the project needs is narrower than "the classifier said norm": a norm
 * participates in gate decisions, so it may only be created automatically when the
 * *source* is authoritative and the claim is checkable. An agent's own submission
 * (`provenance: agent`, `evidence: self-reported`) never qualifies, however
 * confidently phrased — that is the whole reason `Store.submit` computes its tier
 * from those two facts rather than from the submitter's assertion.
 *
 * Non-norm kinds stay promotable: adopting an experience as an experience is
 * exactly what one click is for. The two structural exceptions are scope `global`
 * (widening one project's knowledge to every project is a decision the store
 * itself requires an explicit flag for) and a norm that is nonetheless an episode
 * report (already excluded from `kind`, kept here so the reason is stated rather
 * than silently missing).
 */
function promotionVerdict(
  kind: ContentKindClassification,
  scope: ScopeClassification,
  text: string,
  context: ClassificationContext,
  narrative: boolean,
): { autoPromotable: boolean; promotionBlockedReason?: string } {
  const provenance = context.provenance ?? 'agent';
  const evidence = context.evidence ?? 'self-reported';
  if (kind !== 'norm') {
    return scope === 'global'
      ? { autoPromotable: false, promotionBlockedReason: '作用域为 global：把单个项目的知识推广到所有项目需要人工确认' }
      : { autoPromotable: true };
  }
  if (narrative) {
    return { autoPromotable: false, promotionBlockedReason: '文本是经历叙述，不能升格为硬规范（应作为 skill/memory 采纳或人工重写为约束）' };
  }
  if (provenance === 'agent') {
    return { autoPromotable: false, promotionBlockedReason: 'provenance=agent：插件自身的推断不足以升格为参与门禁判定的硬规范，需人工显式确认' };
  }
  if (evidence === 'self-reported' || evidence === 'unverifiable') {
    return { autoPromotable: false, promotionBlockedReason: `evidence=${evidence}：证据等级不足，需人工显式确认类别与作用域` };
  }
  if (!context.sourceRef && !SOURCE_REFERENCE.test(text)) {
    return { autoPromotable: false, promotionBlockedReason: '缺少权威来源引用（AGENTS.md 一类文件、文档标题或 URL），无法核对该约束的出处' };
  }
  if (scope === 'global') {
    return { autoPromotable: false, promotionBlockedReason: '作用域为 global：把单个项目的约束推广到所有项目需要人工确认' };
  }
  return { autoPromotable: true };
}

/**
 * Check if the text expresses user/environmental preference.
 */
function isPreference(text: string): boolean {
  return /(?:偏好|倾向|习惯|喜好|更喜欢|默认采用|优先使用|风格要求)/.test(text);
}

/**
 * Check if the text is external reference material.
 */
function isMaterial(text: string): boolean {
  return /(?:https?:\/\/|参考资料|外部文档|网页摘录|接口文档|参考链接)/i.test(text);
}

/**
 * Check if the text describes a multi-stage procedural workflow.
 */
function isProcedural(text: string): boolean {
  return /(?:步骤\s*[1-9一二三四]|第一步|首先.*然后|操作指南|流程规范|阶段\s*[1-9])/.test(text);
}

/**
 * Classify a candidate's kind, scope, relation, and check for multi-kind splitting.
 */
export function classifyCandidate(
  text: string,
  existingEntries: Array<{ id: string; title: string; body: string; kind: string }> = [],
  context: ClassificationContext = {},
): SemanticAnalysis {
  const trimmed = text.trim();
  if (trimmed.length < 5) {
    const shortVerdict = promotionVerdict('memory', 'project', trimmed, context, false);
    return {
      kind: 'memory',
      scope: 'project',
      relation: 'low_value',
      confidence: 0.9,
      needsSplit: false,
      autoPromotable: shortVerdict.autoPromotable,
      promotionBlockedReason: shortVerdict.promotionBlockedReason,
      reasoning: '内容过短，无显著知识复用价值',
    };
  }

  // 1. Kind classification & multi-kind split detection
  // `hasNorm` is the *effective* verdict: an obligation word that governs nothing,
  // or that sits inside an episode report, is not treated as a norm anywhere — not
  // for the kind, and not for the split suggestion either. Suggesting a split into
  // a "规范要求部分" that the text does not contain is worse than saying nothing.
  const narrative = isNarrativeExperience(trimmed);
  const hasNorm = isNormative(trimmed);
  const hasPref = isPreference(trimmed);
  const hasMat = isMaterial(trimmed);
  const hasProc = isProcedural(trimmed);

  let kind: ContentKindClassification = 'memory';
  let needsSplit = false;
  let suggestedSplit: Array<{ kind: ContentKindClassification; text: string }> | undefined;

  const countTypes = [hasNorm, hasPref, hasMat, hasProc].filter(Boolean).length;
  if (countTypes >= 2) {
    needsSplit = true;
    suggestedSplit = [];
    if (hasNorm) suggestedSplit.push({ kind: 'norm', text: '规范要求部分' });
    if (hasPref) suggestedSplit.push({ kind: 'preference', text: '习惯偏好部分' });
    if (hasProc) suggestedSplit.push({ kind: 'skill', text: '操作流程部分' });
    if (hasMat) suggestedSplit.push({ kind: 'material', text: '外部资料部分' });
  }

  /**
   * `norm` keeps the highest precedence, and that precedence is the reason the
   * verdict above had to become structural: with a keyword test, one "必须" in an
   * experience write-up outranked every other signal in the passage. Now the word
   * only outranks the others when it is doing normative work.
   *
   * An episode with no reusable procedure lands in `memory` — the honest answer
   * for "this happened once"; an episode that *is* a procedure is caught earlier
   * by `hasProc` and becomes a `skill`.
   */
  if (hasNorm) kind = 'norm';
  else if (hasPref) kind = 'preference';
  else if (hasMat) kind = 'material';
  else if (hasProc) kind = 'skill';
  else kind = 'memory';

  // 2. Scope classification
  let scope: ScopeClassification = 'project';
  if (/(?:这一次|仅限本任务|当前任务|临时使用|一次性|本次会话)/.test(trimmed)) {
    scope = 'task';
  } else if (/(?:全局|通用|所有项目|全平台|跨项目|任何时候)/.test(trimmed)) {
    scope = 'global';
  }

  // 3. Relation analysis against existing knowledge
  let relation: RelationClassification = 'new';
  let conflictingEntryId: string | undefined;
  let bestSim = 0;
  let matchedEntry: { id: string; title: string; body: string; kind: string } | undefined;

  for (const entry of existingEntries) {
    const simBody = characterSimilarity(trimmed, `${entry.title} ${entry.body}`);
    const simTitle = characterSimilarity(trimmed, entry.title);
    const cleanTitle = entry.title.replace(/\s+/g, '');
    let titleHits = 0;
    const totalBigrams = Math.max(1, cleanTitle.length - 1);
    for (let i = 0; i < cleanTitle.length - 1; i += 1) {
      if (trimmed.includes(cleanTitle.slice(i, i + 2))) titleHits += 1;
    }
    const titleHitRatio = titleHits / totalBigrams;
    const sim = Math.max(simBody, simTitle, titleHitRatio * 0.6);
    if (sim > bestSim) {
      bestSim = sim;
      matchedEntry = entry;
    }
  }

  if (bestSim > 0.80) {
    relation = 'duplicate';
    conflictingEntryId = matchedEntry?.id;
  } else if (bestSim > 0.20 && matchedEntry) {
    // Check for contradiction vs supplementation
    const hasNegation = /(?:推翻|废除|不再使用|改用|替换|修正错误|旧结论错误|不是因为)/.test(trimmed);
    if (hasNegation) {
      relation = 'supersede';
      conflictingEntryId = matchedEntry.id;
    } else if (bestSim > 0.30) {
      relation = 'supplement';
      conflictingEntryId = matchedEntry.id;
    }
  }

  const verdict = promotionVerdict(kind, scope, trimmed, context, narrative);
  return {
    kind,
    scope,
    relation,
    confidence: Math.min(0.95, 0.6 + bestSim * 0.35),
    needsSplit,
    suggestedSplit,
    conflictingEntryId,
    autoPromotable: verdict.autoPromotable,
    promotionBlockedReason: verdict.promotionBlockedReason,
    reasoning: `语义判定：类型=${kind}，作用域=${scope}，关系=${relation}${conflictingEntryId ? ` (关联=${conflictingEntryId})` : ''}`
      + (verdict.autoPromotable ? '；可自动升格' : `；不可自动升格：${verdict.promotionBlockedReason ?? '未说明'}`),
  };
}

/**
 * Multi-factor hybrid ranking score for B2 requirement:
 * Combines token coverage, semantic similarity, evidence level weight, and revision conditions.
 */
export function calculateHybridScore(factors: {
  coverage: number;
  semanticSim: number;
  evidence: 'observed' | 'verified' | 'artifact' | 'self-reported' | 'unverifiable';
  revision: number;
}): number {
  const evidenceWeights: Record<string, number> = {
    verified: 1.0,
    observed: 0.9,
    artifact: 0.85,
    'self-reported': 0.65,
    unverifiable: 0.5,
  };
  const evWeight = evidenceWeights[factors.evidence] ?? 0.5;
  // Coverage is the strongest gate (0.5), semantic similarity refines (0.3), evidence weights trustworthiness (0.15), recency (0.05)
  return factors.coverage * 0.5 + factors.semanticSim * 0.3 + evWeight * 0.15 + Math.min(factors.revision, 10) * 0.005;
}
