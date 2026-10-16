import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRetrievalIndex } from '../src/retrieval-index.js';
import type { RetrievalCandidate } from '../src/semantic-retrieval.js';
const candidate = (id:string, title:string, body='', kind='skill'):RetrievalCandidate => ({id,title,body,kind,revision:2});

test('index resolves literal IDs and exact revisions without incidental number hits', () => {
  const index=buildRetrievalIndex([candidate('skill:recover', 'Recover'),candidate('skill:other','Other')]);
  assert.deepEqual(index.exact('read skill:recover@2').map(e=>e.id),['skill:recover']);
  assert.deepEqual(index.exact('read skill:recover@1'),[]);
  assert.deepEqual(index.exact('skill:recover-extra'),[]);
});
test('current revision digest aliases nominate paraphrases while stale digest cannot',()=>{
  const source=candidate('backup','Archive recovery');
  source.retrievalDigest={sourceRevision:2,summary:'Restore protected records',whenToUse:['找回误删记录'],aliases:['撤销误删'],exclusions:[],versions:[]};
  assert.equal(buildRetrievalIndex([source]).rank('撤销误删')[0]?.strong,true);
  source.retrievalDigest.sourceRevision=1;
  assert.deepEqual(buildRetrievalIndex([source]).rank('撤销误删'),[]);
});
test('explicit version and entirely negated task cannot nominate a local result',()=>{
  const source=candidate('v1','Widget v1 restore');
  assert.deepEqual(buildRetrievalIndex([source]).rank('Widget v2 restore'),[]);
  assert.deepEqual(buildRetrievalIndex([source]).rank('不要 Widget restore'),[]);
});
test('skill reference examples and scattered diary terms do not establish local purpose',()=>{
  const sources=[candidate('skill:noise','Cooking','SQLite backup restore example'),
    candidate('journal:noise','Daily activity',('SQLite work. '+ 'x'.repeat(600)+' backup restore. ').repeat(100),'journal')];
  assert.deepEqual(buildRetrievalIndex(sources).rank('SQLite backup restore'),[]);
});
test('shortlist is bounded and relevant purpose is retained among a large unrelated catalog',()=>{
  const sources=Array.from({length:220},(_,i)=>candidate(`s${i}`,`Cooking recipe ${i}`));
  sources.push(candidate('target','SQLite backup recovery'));
  const hits=buildRetrievalIndex(sources).rank('SQLite backup recovery');
  assert.equal(hits[0]?.candidate.id,'target'); assert.equal(hits[0]?.strong,true);assert(hits.length<=12);
});

test('calibration: factual memories and long journal error facts support local recall',()=>{
  const memory=candidate('memory:fact','Incident notes','Postgres restore failed with permission denied; grant schema ownership before restoring.','memory');
  const diary=candidate('journal:fact','Work log',('unrelated event\n').repeat(100)+'Deploy failed ECONNREFUSED when the upstream listener was absent. Start the listener.','journal');
  assert.equal(buildRetrievalIndex([memory]).rank('Postgres restore permission denied')[0]?.strong,true);
  assert.equal(buildRetrievalIndex([diary]).rank('ECONNREFUSED')[0]?.strong,true);
});
test('calibration: concept variants and separate positive objectives retain both candidates',()=>{
  const sources=[candidate('restore','Postgres recovery'),candidate('export','Export audit records')];
  const hits=buildRetrievalIndex(sources).rank('还原 Postgres，同时导出 audit records');
  assert.deepEqual(hits.filter(hit=>hit.strong).map(hit=>hit.candidate.id).sort(),['export','restore']);
});
test('calibration: confirmation, negation and incidental dispersed facts do not become strong',()=>{
  const source=candidate('note','Routine log','Postgres work\n'+ 'other activity '.repeat(100)+'permission denied on printer','journal');
  for(const query of ['好的','我已经重启了服务','不要恢复 Postgres','Postgres permission denied'])
    assert.deepEqual(buildRetrievalIndex([source]).rank(query).filter(hit=>hit.strong),[]);
});
