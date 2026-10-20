#!/usr/bin/env node
/** Read-only inventory. Suggestions are evidence for review, never an automatic migration. */
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { assessMemory } from '../dist/src/memory-policy.js';
import { classifyCandidate } from '../dist/src/semantic.js';

const { values } = parseArgs({ options: { db: { type: 'string' }, samples: { type: 'string', default: '30' } } });
const db = new DatabaseSync(values.db ?? join(homedir(), '.agent-memory-backpack', 'knowledge.sqlite'), { readOnly: true });
const now = Date.now();
const report = { readOnly: true, checkedAt: new Date(now).toISOString(),
  active: { total: 0, kinds: {}, scopes: {}, expired: 0, temporaryWithoutExpiry: 0, compositeMemories: 0, noise: 0, globalJournals: 0 },
  pending: { total: 0, kinds: {}, scopes: {}, durability: {}, noise: 0, kindChanged: 0, scopeChanged: 0 },
  samples: [],
  note: 'Classification is advisory. No content, scope, expiry, proposal state or database schema was changed. Global journal attribution and mixed historical records require source-based review; do not guess their project from keywords.' };
const increment = (map, key) => { map[key] = (map[key] ?? 0) + 1; };
const add = item => { if (report.samples.length < Math.max(0, Number(values.samples) || 0)) report.samples.push(item); };
try {
  for (const row of db.prepare("SELECT k.id,r.content FROM knowledge k JOIN revisions r ON k.id=r.id AND k.head=r.revision WHERE k.status='active' ORDER BY k.id").all()) {
    const content = JSON.parse(String(row.content));
    const text = content.body ?? content.did ?? content.overview ?? content.summary ?? '';
    const assessment = assessMemory(text);
    report.active.total++;
    increment(report.active.kinds, content.kind); increment(report.active.scopes, content.scope.kind);
    if (content.validity?.expiresAt <= now) report.active.expired++;
    if (assessment.value === 'noise') report.active.noise++;
    if (content.kind === 'journal' && content.scope.kind === 'global') report.active.globalJournals++;
    if (content.kind === 'memory' && assessment.mixedContexts) {
      report.active.compositeMemories++;
      add({ id: row.id, location: 'active', kind: content.kind, finding: 'multi_event_history_stored_as_single_memory', reasons: assessment.reasons });
    }
    // Large journals are historical evidence, not single factual claims with one TTL.
    if (!assessment.mixedContexts && !['journal', 'skill', 'workflow', 'material', 'norm'].includes(content.kind) && assessment.durability === 'temporary' && !content.validity) {
      report.active.temporaryWithoutExpiry++;
      add({ id: row.id, location: 'active', kind: content.kind, scope: content.scope.kind, finding: 'temporary_claim_without_expiry', reasons: assessment.reasons });
    }
  }
  for (const row of db.prepare("SELECT id,payload FROM proposals WHERE state='pending' ORDER BY created_at").all()) {
    const payload = JSON.parse(String(row.payload));
    if (typeof payload.discovery !== 'string') continue;
    const next = classifyCandidate(payload.discovery, [], { taskId: payload.taskId, memoryContext: payload.memoryContext });
    report.pending.total++;
    increment(report.pending.kinds, next.kind); increment(report.pending.scopes, next.scope);
    increment(report.pending.durability, next.assessment?.durability ?? 'unknown');
    if (next.relation === 'low_value') report.pending.noise++;
    const old = payload.classification ?? {};
    if (old.kind !== next.kind) report.pending.kindChanged++;
    if (old.scope !== next.scope) report.pending.scopeChanged++;
    if (old.kind !== next.kind || old.scope !== next.scope) add({ id: row.id, location: 'pending',
      from: { kind: old.kind ?? null, scope: old.scope ?? null }, to: { kind: next.kind, scope: next.scope },
      durability: next.assessment?.durability ?? 'unknown' });
  }
  console.log(JSON.stringify(report, null, 2));
} finally { db.close(); }
