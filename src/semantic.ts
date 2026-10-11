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

export interface SemanticAnalysis {
  kind: ContentKindClassification;
  scope: ScopeClassification;
  relation: RelationClassification;
  confidence: number;
  needsSplit: boolean;
  suggestedSplit?: Array<{ kind: ContentKindClassification; text: string }>;
  conflictingEntryId?: string;
  reasoning: string;
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
 * Check if the text expresses imperative normative constraints.
 */
function isNormative(text: string): boolean {
  return /(?:禁止|严禁|不得|必须|务必|规范|硬性要求|绝不|强制要求)/.test(text);
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
  existingEntries: Array<{ id: string; title: string; body: string; kind: string }> = []
): SemanticAnalysis {
  const trimmed = text.trim();
  if (trimmed.length < 5) {
    return {
      kind: 'memory',
      scope: 'project',
      relation: 'low_value',
      confidence: 0.9,
      needsSplit: false,
      reasoning: '内容过短，无显著知识复用价值',
    };
  }

  // 1. Kind classification & multi-kind split detection
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

  return {
    kind,
    scope,
    relation,
    confidence: Math.min(0.95, 0.6 + bestSim * 0.35),
    needsSplit,
    suggestedSplit,
    conflictingEntryId,
    reasoning: `语义判定：类型=${kind}，作用域=${scope}，关系=${relation}${conflictingEntryId ? ` (关联=${conflictingEntryId})` : ''}`,
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
