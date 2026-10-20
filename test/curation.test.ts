import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.js';
import { prepareCuration, type CurationAgentPlan, type CurationSource } from '../src/curation.js';
import { mayAutomaticallyRecall } from '../src/memory-policy.js';
import { knowledgeSchema } from '../src/schema.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const isCode = (code:string) => (error:unknown) => (error as {code:string}).code===code;
function fixture() {
  const store=new Store(':memory:',()=>1_000_000);
  store.import([{id:'old',kind:'memory',title:'混合历史',scope:{kind:'global'},body:'[2026-09-27] 接口曾经超时。\n[2026-09-28] 接口复测恢复，不能认定永久不可用。'}]);
  const row=store.db.prepare('SELECT content FROM revisions WHERE id=? AND revision=1').get('old')!;
  const content=knowledgeSchema.parse(JSON.parse(String(row.content)));
  const source:CurationSource={id:'old',revision:1,hash:hash(String(row.content)),kind:'memory',title:'混合历史',scope:{kind:'global'},redactions:0,content};
  const plan:CurationAgentPlan={sources:[{id:'old',revision:1,hash:source.hash,decision:'replace_with_curated',reason:'按恢复时间线整理'}],
    entries:[{key:'outage',kind:'journal',title:'接口恢复历史',body:'9月27日观察到超时，9月28日已复测恢复；该记录不能决定当前接口状态。',scope:{kind:'global'},scopeStatus:'unresolved',domain:'systems',appliesWhen:['核对历史排障'],invalidatedWhen:['用于当前可用性判断时需重测'],aliases:['接口超时恢复'],keywords:['接口','超时','恢复'],durability:'historical',sources:[{id:'old',revision:1,quote:'接口复测恢复，不能认定永久不可用。'}]}],
    coverage:[{sourceId:'old',sectionsRead:2,totalSections:2,omissions:[]}]};
  return {store,source,plan};
}

test('curation archives prose out of default retrieval, preserves exact sources, and never injects unresolved history',()=>{
  const f=fixture();try{
    const prepared=prepareCuration('fixture',[f.source],[f.plan],1_000_000);
    const result=f.store.applyCurationBatch(prepared);
    assert.equal(result.changed,2);
    const record=prepared.entries.find(entry=>entry.curation?.role==='record')!;
    assert.equal(f.store.searchUniversal('p','接口').some(entry=>entry.id==='old'),false);
    assert.equal(f.store.searchUniversal('p','接口',undefined,100,undefined,true).some(entry=>entry.id==='old'),true);
    const original=f.store.readKnowledge('p','old');
    assert.equal(original.body,'body' in f.source.content?f.source.content.body:'');
    assert.equal(original.curation?.role,'source');
    assert.equal(f.store.readKnowledge('p',record.id).curation?.sources[0]?.hash,f.source.hash);
    assert.equal(mayAutomaticallyRecall(record),false);
    assert.equal(f.store.prepare('p','接口恢复历史',{selectedIds:[record.id],selectionSource:'model'}).knowledge.length,0,'model-selected ids cannot bypass unresolved attribution');
    assert.equal(f.store.applyCurationBatch(prepared).duplicate,true);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM revisions WHERE id=?').get('old')?.n,2);
    assert.equal(f.store.rollbackCurationBatch('fixture').state,'rolled_back');
    assert.equal(f.store.searchUniversal('p','接口').some(entry=>entry.id==='old'),true);
    assert.equal(f.store.searchUniversal('p').some(entry=>entry.id===record.id),false);
    assert.equal(f.store.db.prepare('SELECT status FROM knowledge WHERE id=?').get(record.id)?.status,'retired');
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM revisions WHERE id=?').get(record.id)?.n,1,'rollback preserves derived history');
    assert.equal(f.store.rollbackCurationBatch('fixture').duplicate,true);
    assert.throws(()=>f.store.applyCurationBatch(prepared),isCode('curation_conflict'));
  }finally{f.store.close();}
});

test('source CAS, quote validation, kind and scope guards reject all-or-nothing',()=>{
  const f=fixture();try{
    const badQuote=structuredClone(f.plan);badQuote.entries[0]!.sources[0]!.quote='从未出现在原始来源的观察';
    assert.throws(()=>prepareCuration('badquote',[f.source],[badQuote],0),isCode('curation_evidence'));
    const noCoverage=structuredClone(f.plan);noCoverage.coverage[0]!.sectionsRead=1;
    assert.throws(()=>prepareCuration('partial',[f.source],[noCoverage],0),isCode('curation_coverage'));
    const prepared=prepareCuration('cas',[f.source],[f.plan],0);
    f.store.import([{...f.source.content,baseRevision:1,title:'另一会话已修改'}]);
    const revision=f.store.revision;
    assert.throws(()=>f.store.applyCurationBatch(prepared),isCode('curation_source_changed'));
    assert.equal(f.store.revision,revision);
    assert.equal(f.store.allEntries().length,1);
  }finally{f.store.close();}
});

test('curation cannot rewrite authored prose, norms, skill leaves or claim observed evidence',()=>{
  const f=fixture();try{
    const prepared=prepareCuration('guard',[f.source],[f.plan],0);
    const source=prepared.entries.find(entry=>entry.id==='old')!;
    (source as {body:string}).body='替换原文';
    assert.throws(()=>f.store.applyCurationBatch(prepared),isCode('curation_protected'));
    assert.equal(f.store.allEntries().length,1);
    const corrected=prepareCuration('guard2',[f.source],[f.plan],0);
    corrected.entries.find(entry=>entry.curation?.role==='record')!.evidence='observed';
    assert.throws(()=>f.store.applyCurationBatch(corrected),isCode('curation_protected'));
    const protectedNorm=knowledgeSchema.parse({id:'rule',kind:'norm',title:'规则',scope:{kind:'global'},body:'禁止泄漏凭据'});
    f.store.import([protectedNorm]);
    const row=f.store.db.prepare('SELECT content FROM revisions WHERE id=?').get('rule')!;
    assert.throws(()=>f.store.applyCurationBatch({batchId:'norm',planHash:'a'.repeat(64),sources:[{id:'rule',revision:1,hash:hash(String(row.content))}],entries:[{...protectedNorm,baseRevision:1,labels:['modified']}]}),isCode('curation_protected'));
  }finally{f.store.close();}
});

test('a collection preserves skill bodies and leaves while exposing a navigable member list',()=>{
  const store=new Store(':memory:');try{
    store.import([{id:'skill',kind:'skill',title:'恢复方法',scope:{kind:'project',projectId:'p'},body:'完整技能原文',leaves:[{path:'checks.md',hash:'x',body:'叶子原文'}]}]);
    const row=store.db.prepare('SELECT content FROM revisions WHERE id=?').get('skill')!;
    const source:CurationSource={id:'skill',revision:1,hash:hash(String(row.content)),kind:'skill',scope:{kind:'project',projectId:'p'},title:'恢复方法',redactions:0,content:knowledgeSchema.parse(JSON.parse(String(row.content)))};
    const plan:CurationAgentPlan={sources:[{id:'skill',revision:1,hash:source.hash,decision:'metadata_only',reason:'增加导航',keywords:['恢复','回滚']}],entries:[],collections:[{key:'recovery',title:'恢复与备份',description:'按任务选取完整技能',memberIds:['skill'],keywords:['恢复']}],coverage:[{sourceId:'skill',reviewDepth:'frontmatter',omissions:[]}]};
    const prepared=prepareCuration('navigation',[source],[plan],0);store.applyCurationBatch(prepared);
    assert.equal(store.readKnowledge('p','skill',true).leaves[0]?.body,'叶子原文');
    const collection=store.searchUniversal('p','恢复').find(entry=>entry.curation?.role==='collection')!;
    assert.deepEqual(collection.curation?.members,['skill']);
    assert.equal(store.searchUniversal('other','恢复').length,0);
    store.import([{...source.content,baseRevision:2,title:'用户后来修改'}]);
    assert.throws(()=>store.rollbackCurationBatch('navigation'),isCode('curation_rollback_conflict'));
    assert.equal(store.readKnowledge('p','skill').title,'用户后来修改');
  }finally{store.close();}
});
