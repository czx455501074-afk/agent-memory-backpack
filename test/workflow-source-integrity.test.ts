import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import type { KnowledgeDraft, WorkflowDraft } from '../src/schema.js';

const skill: KnowledgeDraft = { id: 'source', kind: 'skill', title: 'Deploy', scope: {kind:'global'}, body: 'Read references/check.md before deployment.',
  leaves: [{path:'references/check.md',hash:'h',body:'Verify health endpoint and preserve rollback snapshot.'}] };
const flow: WorkflowDraft = { id:'flow',kind:'workflow',title:'Deploy',scope:{kind:'global'},overview:'Deployment procedure',triggers:['Deploy'],categories:[['Ops']],
  preconditions:['Snapshot exists'],stages:[{id:'run',title:'Deploy',instructions:'Read source and deploy',checks:['Health endpoint responds']}],
  completion:['Health verified'],recovery:'Restore snapshot' };

test('derived workflow expansion retains source body and reference leaves after legacy retirement', () => {
  const s = new Store(':memory:');
  try {
    s.import([skill]); s.structureSkill({skillId:'source',workflow:flow,derivedBy:'user',evidence:'Reviewed source'});
    const result = s.expand('p','flow','run');
    assert.match(result.source!.body,/references\/check/);
    assert.match(result.source!.leaves[0]!.body,/rollback snapshot/);
  } finally { s.close(); }
});
test('reviewed draft keeps source syncable and rejects execution after source version changes', () => {
  const s = new Store(':memory:');
  try {
    s.import([skill]);
    s.structureSkill({skillId:'source',workflow:flow,derivedBy:'agent',evidence:'Reviewed source',keepSource:true,expectedSkillRevision:1});
    assert.ok(s.allEntries().some(e=>e.id==='source'));
    s.import([{...skill,baseRevision:1,body:'Updated deployment requirements'}]);
    assert.equal(s.search('p','Deploy')[0]!.ready,false);
    assert.throws(()=>s.expand('p','flow','run'),/Source skill changed/);
    assert.throws(()=>s.structureSkill({skillId:'source',workflow:flow,derivedBy:'agent',evidence:'Old draft',keepSource:true,expectedSkillRevision:1}),/changed since draft/);
  } finally { s.close(); }
});
test('structure cannot widen source scope', () => {
  const s = new Store(':memory:');
  try {
    s.import([{...skill,scope:{kind:'task',projectId:'p',taskId:'t'}}]);
    assert.throws(()=>s.structureSkill({skillId:'source',workflow:flow,derivedBy:'agent',evidence:'e',keepSource:true}),/narrower scope/);
    assert.equal(s.allEntries().length,1);
  } finally { s.close(); }
});
