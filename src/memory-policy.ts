/** Deterministic retention guards, separate from the advisory semantic classifier. */
export interface MemoryContext {
  kind?: 'norm' | 'preference' | 'memory' | 'skill' | 'material' | 'journal';
  scope?: 'global' | 'project' | 'task';
  durability?: 'durable' | 'temporary';
  /** 工作类别：导航用，不参与判定；词表见 `domain-taxonomy.ts`。 */
  domain?: string;
  appliesWhen?: string[];
  invalidatedWhen?: string[];
}

export interface MemoryAssessment {
  value: 'reusable' | 'episodic' | 'noise' | 'uncertain';
  durability: 'durable' | 'temporary' | 'unknown';
  reasons: string[];
  appliesWhen: string[];
  invalidatedWhen: string[];
  requiresRevalidation: boolean;
  mixedContexts: boolean;
}

const CAPTURE = /自动捕获[^\n]{0,60}(?:失败|待核实)|失败事实（待核实）|根因与修复：尚未/;
const TRANSIENT = /(?:暂时|临时|目前|当前|本次|今天|刚才).{0,25}(?:不可用|失败|超时|限流|占用|故障|维护|断开|余额|额度)|(?:HTTP\s*)?(?:429|503)\b|ECONNRESET|ETIMEDOUT|rate.?limit|temporar(?:y|ily) unavailable/i;
const REUSABLE = /适用[：:]|适用条件[：:]|复现条件[：:]|判据[：:]|\b(?:applies when|reproducible when)\b/i;
const VERIFICATION = /证据[：:]|验证[：:]|回归测试|复测|\b(?:verified by|regression test)\b/i;

export function assessMemory(text: string, context: MemoryContext = {}): MemoryAssessment {
  const clean = text.trim();
  const reasons: string[] = [];
  const noise = /^(?:好[的吧]?|收到|明白[了]?|知道了|继续|谢谢|完成[了]?|已完成|测试[一下]*|ok(?:ay)?|done|thanks|test|无新发现|没有新发现|本次无可复用经验)+$/i.test(clean.replace(/[\s\p{P}\p{S}]/gu, ''))
    || clean.replace(/[\s\p{P}\p{S}]/gu, '').length === 0;
  const captured = CAPTURE.test(clean);
  const reusable = (REUSABLE.test(clean) || !!context.appliesWhen?.length)
    && VERIFICATION.test(clean);
  const temporary = captured || context.durability === 'temporary' || (TRANSIENT.test(clean) && !reusable);
  const datedEvents = clean.match(/^\[\d{4}-\d{2}-\d{2}[^\]]*\]/gm) ?? [];
  const taskHeadings = clean.match(/^#{1,4}\s+Task\s+\d+\b/gm) ?? [];
  const mixedContexts = datedEvents.length >= 2 || taskHeadings.length >= 2;
  const episodic = captured || mixedContexts || /^(?:任务日记|会话记录|工作日记|今日进展|\[\d{2}:\d{2}\])/m.test(clean);
  if (mixedContexts) reasons.push('包含多个带日期的事件或任务段落，应保留为历史日记并按事件整理，不能视为一条通用事实');
  if (noise) reasons.push('确认语、状态词或无信息文本，不进入长期知识');
  if (captured) reasons.push('自动捕获的是未核实事件，不能据此推出根因或永久绕行规则');
  if (temporary) reasons.push('存在短期状态或故障信号，需要失效时间和再次验证');
  if (reusable) reasons.push('提供了适用条件与验证线索；线索仍需核对，不等于插件已验证');
  return {
    value: noise ? 'noise' : captured ? 'episodic' : reusable ? 'reusable' : episodic ? 'episodic' : 'uncertain',
    // A declaration cannot erase a transient observation. A new verified conclusion is a new entry.
    durability: temporary ? 'temporary' : reusable || context.durability === 'durable' ? 'durable' : 'unknown',
    reasons,
    appliesWhen: context.appliesWhen ?? [],
    invalidatedWhen: context.invalidatedWhen ?? [],
    requiresRevalidation: temporary || !reusable,
    mixedContexts,
  };
}

export const TEMPORARY_MEMORY_TTL = 7 * 24 * 60 * 60 * 1000;

/** No deletion: expired entries remain in revisions and the management catalog. */
export function memoryIsLive(content: { validity?: { expiresAt: number } }, now: number): boolean {
  return !content.validity || content.validity.expiresAt > now;
}

/** An unresolved attribution or historical state is searchable evidence, not automatic advice. */
export function mayAutomaticallyRecall(content: { kind?: string; support?: { status: string; waiver?: unknown }; curation?: { role: string; scopeStatus: string; durability: string } }): boolean {
  // An entry nothing supports is not advice, whatever kind it claims to be. This used
  // to exempt every kind except `memory`, which meant an unsupported norm, skill or
  // journal was injected every turn while an unsupported memory was held back — the
  // one kind that had evidence discipline was the one with the least authority.
  if (content.support?.status === 'missing') return false;
  // A waiver lets a person keep the entry; it does not turn it into advice.
  if (content.support?.waiver) return false;
  return !content.curation || (content.curation.role !== 'source'
    && content.curation.scopeStatus === 'confirmed' && content.curation.durability === 'durable');
}
