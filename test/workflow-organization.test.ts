import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { Store } from '../src/store.js';
import { createCoreServer } from '../src/server.js';
import { createMaintenanceWorker } from '../src/maintenance.js';
import { enqueueWorkflowDraft, readWorkflowDraft, listWorkflowDrafts, approveWorkflowDraft, processWorkflowDigest, processWorkflowDraft, reviseWorkflowDraft } from '../src/workflow-organization.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'amb-organization-'));
  const store = new Store(join(directory, 'knowledge.sqlite'));
  const fields: Record<string,string> = { title: 'Connection repair', overview: 'Restore local connection', 'triggers.0': 'When connection fails',
    'preconditions.0': 'Known local port', 'stages.0.title': 'Inspect listener', 'stages.0.instructions': 'Inspect local port listener',
    'stages.0.checks.0': 'Listener must exist', 'completion.0': 'Connection restored', recovery: 'Keep failed status if unavailable' };
  const skill = { id: 'skill:connection', kind: 'skill' as const, title: fields.title!, scope: { kind: 'project' as const, projectId: 'p' }, baseRevision: 0,
    body: Object.values(fields).join('\n'), leaves: [{ path: 'refs/ports.md', hash: 'original', body: 'Reference body retained.' }] };
  store.import([skill]);
  const raw = { workflow: { id: 'workflow:connection', kind: 'workflow', title: fields.title, overview: fields.overview, scope: skill.scope,
    provenance: 'agent', evidence: 'self-reported', triggers: [fields['triggers.0']], categories: [['Operations']], preconditions: [fields['preconditions.0']],
    stages: [{ id: 'inspect', title: fields['stages.0.title'], instructions: fields['stages.0.instructions'], checks: [fields['stages.0.checks.0']], dependencies: [] }],
    completion: [fields['completion.0']], recovery: fields.recovery },
    grounding: Object.entries(fields).map(([field,quote])=>({field,sourcePath:'SKILL.md',quote})), missing: [] as string[],
    digest:{summary:'Local connection repair',whenToUse:['Connection fails'],exclusions:[],aliases:['Connection troubleshooting'],versions:[]} };
  return { directory, store, skill, raw, close() { store.close(); const rel = relative(resolve(tmpdir()), resolve(directory)); assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel)); rmSync(directory,{recursive:true,force:true}); } };
}

test('real worker persists grounded draft; admin approval is idempotent and keeps reference source active', async () => {
  const f=fixture(); let calls=0;
  const model=createServer((_req,res)=>{calls++;res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(f.raw)}}]}));});
  model.listen(0,'127.0.0.1'); await once(model,'listening');
  const address=model.address(); assert.ok(address && typeof address!=='string');
  try {
    writeFileSync(join(f.directory,'model-review.json'),JSON.stringify({endpoint:`http://127.0.0.1:${address.port}/v1`,model:'fixture'}));
    const queued=enqueueWorkflowDraft(f.store,'p',f.skill.id);
    assert.equal(enqueueWorkflowDraft(f.store,'p',f.skill.id).id,queued.id);
    assert.equal(f.store.jobs.list().filter(job=>job.kind==='structure_skill_digest').length,1);
    const worker=createMaintenanceWorker(f.store,f.directory); await worker.tick();
    assert.equal(calls,1);
    await worker.tick();
    worker.stop();
    assert.equal(readWorkflowDraft(f.store,'p',queued.id).state,'ready_for_review');
    assert.equal(listWorkflowDrafts(f.store,'p')[0]!.state,'ready_for_review');
    assert.equal(f.store.scopedEntries('p').filter(entry=>entry.content.kind==='workflow').length,0);
    const first=approveWorkflowDraft(f.store,'p',queued.id), revision=f.store.revision;
    assert.equal(first.state,'approved');
    assert.equal(approveWorkflowDraft(f.store,'p',queued.id).duplicate,true); assert.equal(f.store.revision,revision);
    const expanded=f.store.expand('p','workflow:connection','inspect');
    assert.equal(expanded.source?.leaves[0]?.body,'Reference body retained.');
    assert.ok(f.store.scopedEntries('p').some(entry=>entry.id===f.skill.id));
    f.store.import([{...f.skill,baseRevision:1,body:f.skill.body+'\nChanged source'}]);
    assert.throws(()=>f.store.expand('p','workflow:connection','inspect'),/source|来源/i);
  } finally {await new Promise<void>(done=>model.close(()=>done())); f.close();}
});

test('source revision change prevents draft approval; missing checks cannot be approved', async () => {
  const f=fixture(); const model=createServer((_req,res)=>res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(f.raw)}}]})));
  model.listen(0,'127.0.0.1'); await once(model,'listening'); const a=model.address(); assert.ok(a&&typeof a!=='string');
  try {
    const queued=enqueueWorkflowDraft(f.store,'p',f.skill.id);
    const config={endpoint:`http://127.0.0.1:${a.port}/v1`,model:'fixture'};
    await processWorkflowDraft(f.store,{id:queued.id,projectId:'p',skillId:f.skill.id},config);
    f.store.import([{...f.skill,baseRevision:1,body:f.skill.body+'\nnew source'}]);
    assert.equal(readWorkflowDraft(f.store,'p',queued.id).state,'stale');
    assert.throws(()=>approveWorkflowDraft(f.store,'p',queued.id),/Source changed/);
    const second=enqueueWorkflowDraft(f.store,'p',f.skill.id);
    f.raw.workflow.stages[0]!.checks=['Invented verification'];
    await processWorkflowDraft(f.store,{id:second.id,projectId:'p',skillId:f.skill.id},config);
    assert.equal(readWorkflowDraft(f.store,'p',second.id).state,'needs_evidence');
    assert.throws(()=>approveWorkflowDraft(f.store,'p',second.id),/unresolved/);
  } finally {await new Promise<void>(done=>model.close(()=>done())); f.close();}
});

test('draft cannot overwrite an unrelated existing workflow id', async () => {
  const f=fixture(); const model=createServer((_req,res)=>res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(f.raw)}}]})));
  model.listen(0,'127.0.0.1'); await once(model,'listening'); const a=model.address(); assert.ok(a&&typeof a!=='string');
  try {
    f.store.import([f.raw.workflow as Parameters<Store['import']>[0][number]]);
    const queued=enqueueWorkflowDraft(f.store,'p',f.skill.id);
    await processWorkflowDraft(f.store,{id:queued.id,projectId:'p',skillId:f.skill.id},{endpoint:`http://127.0.0.1:${a.port}/v1`,model:'fixture'});
    const revision=f.store.revision;
    assert.throws(()=>approveWorkflowDraft(f.store,'p',queued.id),/collides/); assert.equal(f.store.revision,revision);
  } finally {await new Promise<void>(done=>model.close(()=>done())); f.close();}
});

test('draft collision with another project is rejected even though scoped lookup cannot see it', async () => {
  const f=fixture(); const model=createServer((_req,res)=>res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(f.raw)}}]})));
  model.listen(0,'127.0.0.1'); await once(model,'listening'); const a=model.address(); assert.ok(a&&typeof a!=='string');
  try {
    f.store.import([{...f.raw.workflow,scope:{kind:'project',projectId:'other'}} as Parameters<Store['import']>[0][number]]);
    const queued=enqueueWorkflowDraft(f.store,'p',f.skill.id);
    await processWorkflowDraft(f.store,{id:queued.id,projectId:'p',skillId:f.skill.id},{endpoint:`http://127.0.0.1:${a.port}/v1`,model:'fixture'});
    assert.throws(()=>approveWorkflowDraft(f.store,'p',queued.id),/collides/);
    assert.equal(f.store.scopedEntries('other').filter(entry=>entry.id==='workflow:connection')[0]!.revision,1);
  } finally {await new Promise<void>(done=>model.close(()=>done())); f.close();}
});

test('workflow draft APIs reject adapter roles, missing credentials and cross-project access', async () => {
  const f=fixture(); const token='a'.repeat(64),admin='b'.repeat(64);
  const server=createCoreServer(f.store,{protocolVersion:1,port:47631,clients:[{id:'dsh',projectId:'p',role:'adapter',token},{id:'admin',projectId:'p',role:'admin',token:admin}]});
  server.listen(0,'127.0.0.1'); await once(server,'listening'); const a=server.address(); assert.ok(a&&typeof a!=='string');
  const request=(path:string,credential:string,projectId='p')=>fetch(`http://127.0.0.1:${a.port}/v1/workflow-drafts/${path}`,{
    method:'POST',headers:{authorization:`Bearer ${credential}`,'x-amb-protocol':'1','content-type':'application/json'},body:JSON.stringify({projectId,skillId:f.skill.id,id:'unknown'})});
  try {
    for(const path of ['list','get','generate','approve']) {
      assert.equal((await request(path,token)).status,403); assert.equal((await request(path,'bad')).status,401);
      assert.equal((await request(path,admin,'other')).status,403);
    }
    assert.equal((await request('list',admin)).status,200); assert.equal((await request('generate',admin)).status,200);
  } finally {await new Promise<void>(done=>server.close(()=>done())); f.close();}
});

test('draft and durable job enqueue roll back together on SQLite write failure',()=>{
  const f=fixture();
  try {
    f.store.db.exec("CREATE TRIGGER reject_structure_job BEFORE INSERT ON maintenance_jobs WHEN NEW.kind IN ('structure_skill','structure_skill_digest') BEGIN SELECT RAISE(FAIL,'fixture write failed'); END;");
    assert.throws(()=>enqueueWorkflowDraft(f.store,'p',f.skill.id),/fixture write failed/);
    assert.equal(listWorkflowDrafts(f.store,'p').length,0);
    assert.equal(f.store.jobs.list().filter(job=>job.kind==='structure_skill').length,0);
  }finally{f.close();}
});

test('verified digest persists before procedure extraction and survives procedure model failure',async t=>{
  const f=fixture();
  const digest={summary:'Connection lookup',whenToUse:['Connection fails'],exclusions:['Remote systems'],aliases:['port check'],versions:[]};
  const model=createServer((_req,res)=>res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(digest)}}]})));
  model.listen(0,'127.0.0.1');await once(model,'listening');const address=model.address();assert.ok(address&&typeof address!=='string');
  try{
    const queued=enqueueWorkflowDraft(f.store,'p',f.skill.id);
    const config={endpoint:`http://127.0.0.1:${address.port}/v1`,model:'fixture'};
    assert.equal((await processWorkflowDigest(f.store,{id:queued.id,projectId:'p',skillId:f.skill.id},config)).status,'ready');
    assert.deepEqual(readWorkflowDraft(f.store,'p',queued.id).result?.digest,digest);
    assert.equal((await processWorkflowDraft(f.store,{id:queued.id,projectId:'p',skillId:f.skill.id})).status,'awaiting_model');
    const read=readWorkflowDraft(f.store,'p',queued.id);
    assert.deepEqual(read.result?.digest,digest);
    assert.equal(read.digestStatus,'ready');assert.equal(read.workflowStatus,'awaiting_model');
    assert.equal(listWorkflowDrafts(f.store,'p')[0]!.digestStatus,'ready');
  }finally{await new Promise<void>(done=>model.close(()=>done()));f.close();}
});

test('explicit regenerate retries a completed draft; automatic reconciliation and approved drafts do not', async()=>{
  const f=fixture();
  const digest={summary:'Inspect local connection',whenToUse:['Connection fails'],exclusions:['Remote service'],aliases:['port'],versions:[]};
  const model=createServer((_req,res)=>res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({...f.raw,digest})}}]})));
  model.listen(0,'127.0.0.1'); await once(model,'listening'); const address=model.address(); assert.ok(address&&typeof address!=='string');
  try {
    writeFileSync(join(f.directory,'model-review.json'),JSON.stringify({endpoint:`http://127.0.0.1:${address.port}/v1`,model:'fixture'}));
    const queued=enqueueWorkflowDraft(f.store,'p',f.skill.id);
    const worker=createMaintenanceWorker(f.store,f.directory); await worker.tick(); await worker.tick();
    assert.equal(f.store.jobs.list().find(job=>job.kind==='structure_skill')!.status,'completed');
    enqueueWorkflowDraft(f.store,'p',f.skill.id);
    assert.equal(f.store.jobs.list().find(job=>job.kind==='structure_skill')!.status,'completed');
    assert.equal(enqueueWorkflowDraft(f.store,'p',f.skill.id,true).state,'pending');
    await worker.tick(); await worker.tick(); worker.stop();
    const {digest: omittedDigest,...manual}=f.raw;
    reviseWorkflowDraft(f.store,'p',queued.id,manual);
    assert.deepEqual(readWorkflowDraft(f.store,'p',queued.id).result?.digest,digest);
    approveWorkflowDraft(f.store,'p',queued.id);
    assert.equal(enqueueWorkflowDraft(f.store,'p',f.skill.id,true).state,'approved');
    assert.equal(f.store.jobs.list().find(job=>job.kind==='structure_skill')!.status,'completed');
  }finally{await new Promise<void>(done=>model.close(()=>done()));f.close();}
});

