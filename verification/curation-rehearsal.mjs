/** Real-data rehearsal, only on an explicit disposable copy. No live DB writes. */
import { DatabaseSync, backup } from 'node:sqlite';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { Store } from '../dist/src/store.js';
import { mayAutomaticallyRecall } from '../dist/src/memory-policy.js';

const { values } = parseArgs({ options: { source: { type: 'string' }, copy: { type: 'string' }, prepared: { type: 'string' }, output: { type: 'string' } } });
if (!values.source || !values.copy || !values.prepared || !values.output) throw Error('Needs --source BACKUP --copy NEWFILE --prepared FILE --output REPORT');
const sourcePath = resolve(values.source), copyPath = resolve(values.copy);
assert.notEqual(copyPath.toLowerCase(), resolve(join(homedir(), '.agent-memory-backpack', 'knowledge.sqlite')).toLowerCase());
assert.notEqual(copyPath.toLowerCase(), sourcePath.toLowerCase());
assert.equal(existsSync(copyPath), false, 'Rehearsal must create a fresh copy');
const source = new DatabaseSync(sourcePath, { readOnly: true });
await backup(source, copyPath); source.close();
const prepared = JSON.parse(readFileSync(resolve(values.prepared), 'utf8'));
const store = new Store(copyPath);
const normalized = content => { const { baseRevision, ...rest } = content; return rest; };
const protectedFields = content => { const { labels, aliases, keywords, curation, ...rest } = normalized(content); return rest; };
try {
  const before = store.allEntries(), originals = new Map(before.map(entry => [entry.id, entry]));
  const baselineSearch = store.searchUniversal('p0-workflow', '', undefined, 100000);
  const receipt = store.applyCurationBatch(prepared);
  assert.equal(receipt.duplicate, false);
  assert.equal(store.applyCurationBatch(prepared).duplicate, true);
  const after = store.allEntries(), current = new Map(after.map(entry => [entry.id, entry]));
  for (const original of before) {
    const updated = current.get(original.id);
    assert(updated, `Original missing: ${original.id}`);
    assert.deepEqual(protectedFields(updated.content), protectedFields(original.content), `Original body/authority/scope/leaves changed: ${original.id}`);
    if (original.content.kind === 'norm') assert.equal(updated.revision, original.revision, 'Norm must have no new revision');
  }
  const archive = after.filter(entry => entry.content.curation?.role === 'source');
  const records = after.filter(entry => entry.content.curation?.role === 'record');
  const collections = after.filter(entry => entry.content.curation?.role === 'collection');
  const visible = store.searchUniversal('p0-workflow', '', undefined, 100000);
  for (const entry of archive) {
    assert(!visible.some(hit => hit.id === entry.id), 'Archived original leaked into default search');
    const read = store.readKnowledge('p0-workflow', entry.id);
    assert.equal(read.curation.role, 'source');
    assert.equal(read.body, entry.content.body ?? entry.content.did);
  }
  for (const entry of records) {
    assert.equal(entry.content.provenance, 'agent');
    assert.notEqual(entry.content.evidence, 'observed');
    if (entry.content.curation.scopeStatus === 'unresolved' || entry.content.curation.durability !== 'durable') {
      assert.equal(mayAutomaticallyRecall(entry.content), false);
      assert.equal(store.prepare('p0-workflow', entry.content.title, { selectedIds: [entry.id], selectionSource: 'model' }).knowledge.length, 0);
    }
  }
  const memberIds = new Set(collections.flatMap(entry => entry.content.curation.members));
  const skills = before.filter(entry => entry.content.kind === 'skill');
  assert.equal(memberIds.size, skills.length);
  for (const skill of skills) assert(memberIds.has(skill.id));
  const navigation = collections.map(entry => ({ id: entry.id, title: entry.content.title, members: entry.content.curation.members.length }));
  const archivedSet = new Set(archive.map(entry => entry.id));
  const baselineArchivedChars = baselineSearch.filter(entry => archivedSet.has(entry.id)).reduce((sum, entry) => sum + entry.chars, 0);
  const afterRecordChars = records.reduce((sum, entry) => sum + (entry.content.body ?? entry.content.did).length, 0);
  const queries = ['zstd', '音色', 'H3', 'Cookie', 'ComfyUI', 'pnpm', '会话恢复'];
  const search = queries.map(query => {
    const hits = store.searchUniversal('p0-workflow', query, undefined, 200);
    assert(!hits.some(hit => archivedSet.has(hit.id)));
    return { query, hits: hits.length, top: hits.slice(0, 5).map(hit => ({ id: hit.id, title: hit.title })) };
  });
  const appliedRevision = store.revision;
  assert.equal(store.rollbackCurationBatch(prepared.batchId).state, 'rolled_back');
  assert.equal(store.rollbackCurationBatch(prepared.batchId).duplicate, true);
  const restored = new Map(store.allEntries().map(entry => [entry.id, entry]));
  for (const original of before) assert.deepEqual(normalized(restored.get(original.id).content), normalized(original.content), `Rollback lost original: ${original.id}`);
  for (const entry of prepared.entries.filter(entry => !originals.has(entry.id))) {
    assert.equal(store.db.prepare('SELECT status FROM knowledge WHERE id=?').get(entry.id).status, 'retired');
    assert(store.db.prepare('SELECT 1 FROM revisions WHERE id=?').get(entry.id), 'Rollback deleted evidence history');
  }
  const report = { checkedAt: new Date().toISOString(), batchId: prepared.batchId, receipt, integrity: store.db.prepare('PRAGMA integrity_check').get(),
    before: { active: before.length, searchResults: baselineSearch.length, replacedSourceChars: baselineArchivedChars },
    after: { active: after.length, searchResults: visible.length, archived: archive.length, records: records.length, collections: collections.length, recordChars: afterRecordChars, appliedRevision },
    preserved: { originals: before.length, skills: skills.length, norms: before.filter(entry => entry.content.kind === 'norm').length, uniqueNavigationMembers: memberIds.size },
    navigation, search, rollback: { restoredOriginals: before.length, derivedRetired: prepared.summary.records + prepared.summary.collections, historyPreserved: true },
    limits: ['Source attribution remains unresolved where evidence is missing.', 'Skill frontmatter was categorized; skill leaf semantics were not fully audited.', 'This checks structural invariants and representative retrieval, not measured long-term task success.'] };
  writeFileSync(resolve(values.output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: resolve(values.output), ...report.after, preserved: report.preserved, rollback: report.rollback }, null, 2));
} finally { store.close(); }
