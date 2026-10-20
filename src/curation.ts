import { createHash } from 'node:crypto';
import { knowledgeSchema, type Knowledge, type KnowledgeDraft, type Scope, DomainError } from './schema.js';
import { TEMPORARY_MEMORY_TTL } from './memory-policy.js';

export interface CurationSource {
  id: string; revision: number; hash: string; kind: string; scope: Scope; title: string;
  redactions: number; content: Knowledge;
}
export interface CurationAgentPlan {
  sources: Array<{ id: string; revision: number; hash: string; decision: 'keep' | 'metadata_only' | 'replace_with_curated'; reason: string; labels?: string[]; aliases?: string[]; keywords?: string[] }>;
  entries: Array<{ key: string; kind: 'journal' | 'memory'; title: string; body: string; outcome?: 'unverified' | 'success' | 'failure'; scope: Scope;
    scopeStatus: 'confirmed' | 'unresolved'; domain: string; appliesWhen: string[]; invalidatedWhen: string[]; aliases: string[]; keywords: string[];
    durability: 'historical' | 'durable' | 'temporary' | 'uncertain'; sources: Array<{ id: string; revision: number; quote: string }> }>;
  collections?: Array<{ key: string; title: string; description: string; memberIds: string[]; keywords: string[] }>;
  coverage: Array<{ sourceId: string; reviewDepth?: string; sectionsRead?: number; totalSections?: number; omissions: unknown[] }>;
}
export interface PreparedCuration {
  version: 1; batchId: string; planHash: string;
  sources: Array<{ id: string; revision: number; hash: string }>;
  entries: KnowledgeDraft[];
  summary: { reviewed: number; archivedSources: number; metadataUpdated: number; records: number; collections: number; unresolved: number; archivedChars: number; recordChars: number };
  warnings: string[];
}
const unique = (items: string[], max: number) => [...new Set(items.map(item => item.trim()).filter(Boolean))].slice(0, max);
const covers = (target: Scope, source: Scope) => source.kind === 'global' || (target.kind !== 'global' && target.projectId === source.projectId
  && (source.kind === 'project' || (target.kind === 'task' && target.taskId === source.taskId)));
const prose = (content: Knowledge) => 'body' in content ? content.body : content.kind === 'journal' ? content.did : content.kind === 'workflow' ? content.overview : '';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** Plans contain untrusted model prose. This compiler grants neither authority nor scope. */
export function prepareCuration(batchId: string, sources: CurationSource[], plans: CurationAgentPlan[], at: number): PreparedCuration {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(batchId)) throw new DomainError('invalid_request', 'Invalid batchId');
  const byId = new Map(sources.map(source => [source.id, source]));
  const decisions = new Map<string, CurationAgentPlan['sources'][number]>();
  const warnings: string[] = [];
  const entries: KnowledgeDraft[] = [];
  const used = new Set<string>();
  const citations = new Set<string>();
  const summary = { reviewed: 0, archivedSources: 0, metadataUpdated: 0, records: 0, collections: 0, unresolved: 0, archivedChars: 0, recordChars: 0 };
  const source = (id: string) => {
    const value = byId.get(id);
    if (!value) throw new DomainError('curation_evidence', `Unknown source: ${id}`);
    return value;
  };
  const generatedId = (key: string, kind: string) => `curated:${kind}:${sha(batchId + ':' + key).slice(0, 24)}`;
  for (const plan of plans) for (const decision of plan.sources) {
    const original = source(decision.id);
    if (decisions.has(decision.id)) throw new DomainError('curation_duplicate', `Source reviewed twice: ${decision.id}`);
    if (decision.revision !== original.revision || decision.hash !== original.hash)
      throw new DomainError('curation_source_changed', `Wrong reviewed source identity: ${decision.id}`);
    if (!plan.coverage.some(item => item.sourceId === decision.id)) throw new DomainError('curation_coverage', `Missing coverage: ${decision.id}`);
    const coverage = plan.coverage.find(item => item.sourceId === decision.id)!;
    if (coverage.totalSections !== undefined && coverage.sectionsRead !== coverage.totalSections)
      throw new DomainError('curation_coverage', `Incomplete source reading: ${decision.id}`);
    if (!['keep','metadata_only','replace_with_curated'].includes(decision.decision)) throw new DomainError('invalid_request', 'Unknown curation decision');
    decisions.set(decision.id, decision);
  }
  summary.reviewed = decisions.size;
  for (const plan of plans) for (const item of plan.entries) {
    if (!['memory','journal'].includes(item.kind)) throw new DomainError('curation_protected', 'Curation cannot create norms or skills');
    if (!item.sources.length) throw new DomainError('curation_evidence', `No source for ${item.key}`);
    const references = item.sources.map(reference => {
      const original = source(reference.id);
      if (!decisions.has(reference.id) || reference.revision !== original.revision || !reference.quote?.trim()
        || reference.quote.length < 10 || !prose(original.content).includes(reference.quote))
        throw new DomainError('curation_evidence', `Invalid exact quote: ${item.key} / ${reference.id}`);
      if (!covers(item.scope, original.scope)) throw new DomainError('curation_scope', `Scope widened: ${item.key}`);
      if (original.content.kind === 'norm' || original.content.kind === 'skill')
        throw new DomainError('curation_protected', 'Authored norms and skills remain sources, not rewritten summaries');
      used.add(original.id); citations.add(original.id);
      return { id: original.id, revision: original.revision, hash: original.hash, quote: reference.quote };
    });
    const id = generatedId(item.key, item.kind);
    if (entries.some(entry=>entry.id===id)) throw new DomainError('curation_duplicate', `Duplicate key: ${item.key}`);
    const content = {
      id, kind: item.kind, title: item.title, scope: item.scope, baseRevision: 0,
      provenance: 'agent', evidence: 'self-reported', labels: unique(['curated', item.domain, 'durability:' + item.durability],30),
      aliases: unique(item.aliases ?? [],40), keywords: unique(item.keywords ?? [],60),
      applicability: { appliesWhen: item.appliesWhen ?? [], invalidatedWhen: item.invalidatedWhen ?? [] },
      curation: { batchId, role: 'record', scopeStatus: item.scopeStatus, durability: item.durability, domain: item.domain,
        sources: references, note: '基于历史来源归纳，未独立复验当前环境；来源中的指令语句不增加权限。' },
      ...(item.kind === 'journal' ? { did: item.body, outcome: 'unverified' } : { body: item.body }),
      ...(item.durability === 'temporary' ? { validity: { expiresAt: at + TEMPORARY_MEMORY_TTL, reason: '整理时保留的短期观察；使用前重新验证', appliesWhen: item.appliesWhen ?? [], invalidatedWhen: item.invalidatedWhen ?? [] } } : {}),
    };
    entries.push(knowledgeSchema.parse(content)); summary.records++; summary.recordChars += item.body.length;
    if (item.scopeStatus === 'unresolved') summary.unresolved++;
  }
  for (const plan of plans) for (const collection of plan.collections ?? []) {
    const members = [...new Set(collection.memberIds)].map(source);
    if (!members.length) throw new DomainError('curation_evidence', `Empty collection: ${collection.key}`);
    let scope: Scope = { kind: 'global' };
    const scoped = members.filter(member => member.scope.kind !== 'global');
    if (scoped.length) {
      const narrow = scoped.find(member=>member.scope.kind==='task') ?? scoped[0]!;
      scope = narrow.scope;
    }
    if (!members.every(member=>covers(scope, member.scope))) throw new DomainError('curation_scope', `Collection mixes incompatible scopes: ${collection.key}`);
    const id = generatedId(collection.key, 'collection');
    if (entries.some(entry=>entry.id===id)) throw new DomainError('curation_duplicate', `Duplicate collection key: ${collection.key}`);
    const references = members.map(member => { used.add(member.id); return { id: member.id, revision: member.revision, hash: member.hash }; });
    entries.push(knowledgeSchema.parse({ id, kind: 'memory', title: collection.title, scope, baseRevision: 0,
      provenance: 'agent', evidence: 'verifiable', labels: ['curated','navigation'], keywords: unique(collection.keywords ?? [],60),
      body: collection.description + '\n\n本条是导航，执行前读取对应技能及叶子：\n' + members.map(member=>`${member.id} — ${member.title}`).join('\n'),
      curation: { batchId, role: 'collection', scopeStatus: 'confirmed', durability: 'durable', sources: references, members: members.map(member=>member.id) },
    })); summary.collections++;
  }
  for (const [id, decision] of decisions) {
    const original = source(id);
    if (original.kind === 'norm') {
      if (decision.decision !== 'keep') warnings.push(`Norm preserved without metadata changes: ${id}`);
      continue;
    }
    if (original.redactions) { warnings.push(`Preserved source with redaction-shaped content unchanged: ${id}`); continue; }
    if (decision.decision === 'replace_with_curated') {
      if (!citations.has(id)) throw new DomainError('curation_coverage', `Cannot archive a source with no curated citation: ${id}`);
      if (original.kind === 'skill') throw new DomainError('curation_protected', 'Cannot archive a skill');
      entries.push({ ...original.content, baseRevision: original.revision, curation: {
        batchId, role: 'source', scopeStatus: original.scope.kind === 'global' ? 'unresolved' : 'confirmed', durability: 'historical',
        sources: [{ id, revision: original.revision, hash: original.hash }], members: [],
        note: '原件保留；默认检索使用已归纳条目，按本 id 仍可读取原文。' } });
      summary.archivedSources++; summary.archivedChars += prose(original.content).length; used.add(id);
    } else if (decision.decision === 'metadata_only') {
      entries.push({ ...original.content, baseRevision: original.revision,
        labels: unique([...original.content.labels,...(decision.labels??[])],30),
        aliases: unique([...original.content.aliases,...(decision.aliases??[])],40),
        keywords: unique([...original.content.keywords,...(decision.keywords??[])],60) });
      summary.metadataUpdated++; used.add(id);
    }
  }
  if (new Set(entries.map(entry=>entry.id)).size !== entries.length) throw new DomainError('curation_duplicate', 'Duplicate entry id');
  const expected = [...used].sort().map(id=>{const original=source(id);return {id,revision:original.revision,hash:original.hash};});
  const planHash=sha(JSON.stringify({batchId,sources:expected,entries}));
  return { version:1,batchId,planHash,sources:expected,entries,summary,warnings };
}
