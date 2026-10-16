import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.js';
import { exportAll, importAll, BACKUP_MARKER } from '../src/backup.js';
import { enqueueWorkflowDraft, processWorkflowDraft } from '../src/workflow-organization.js';

function setup() {
  const directory=mkdtempSync(join(tmpdir(),'amb-backup-drafts-')),source=new Store(join(directory,'source.sqlite')),target=new Store(join(directory,'target.sqlite'));
  source.import([{id:'skill:one',kind:'skill',title:'One',scope:{kind:'project',projectId:'p'},body:'Incomplete source material.',leaves:[{path:'refs/one.md',hash:'source',body:'Useful reference.'}]}]);
  return {directory,source,target,close(){source.close();target.close();const rel=relative(resolve(tmpdir()),resolve(directory));assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));rmSync(directory,{recursive:true,force:true});}};
}

test('workflow drafts round trip as optional data without restoring executable jobs, including dry run',async()=>{
  const f=setup();
  try {
    const draft=enqueueWorkflowDraft(f.source,'p','skill:one');
    await processWorkflowDraft(f.source,{id:draft.id,projectId:'p',skillId:'skill:one'});
    const directory=join(f.directory,'backup'); exportAll(f.source,{directory});
    const manifest=JSON.parse(readFileSync(join(directory,BACKUP_MARKER),'utf8'));
    assert.equal(manifest.counts.workflow_drafts,1);assert.equal(manifest.files['maintenance_jobs.json'],undefined);
    importAll(f.target,{directory,dryRun:true});
    assert.equal(f.target.db.prepare("SELECT name FROM sqlite_master WHERE name='workflow_drafts'").get(),undefined);
    importAll(f.target,{directory});
    assert.deepEqual(f.target.db.prepare('SELECT * FROM workflow_drafts').all(),f.source.db.prepare('SELECT * FROM workflow_drafts').all());
    assert.equal(f.target.jobs.list().length,0); assert.equal(importAll(f.target,{directory}).wrote,false);
  }finally{f.close();}
});

test('older v1 backups without workflow drafts remain importable',()=>{
  const f=setup();
  try {
    const directory=join(f.directory,'old');exportAll(f.source,{directory});
    const manifest=JSON.parse(readFileSync(join(directory,BACKUP_MARKER),'utf8'));
    assert.equal(manifest.files['workflow_drafts.json'],undefined);
    assert.equal(importAll(f.target,{directory}).imported,1);
  }finally{f.close();}
});

test('workflow draft restore rejects unknown columns and forged source binding before any write',async()=>{
  const f=setup();
  try {
    const draft=enqueueWorkflowDraft(f.source,'p','skill:one');
    await processWorkflowDraft(f.source,{id:draft.id,projectId:'p',skillId:'skill:one'});
    const directory=join(f.directory,'backup');exportAll(f.source,{directory});
    const draftFile=join(directory,'workflow_drafts.json'),markerFile=join(directory,BACKUP_MARKER);
    const original=JSON.parse(readFileSync(draftFile,'utf8'));
    function replace(rows:unknown[]) {
      const text=JSON.stringify(rows);writeFileSync(draftFile,text);
      const marker=JSON.parse(readFileSync(markerFile,'utf8'));marker.files['workflow_drafts.json']=createHash('sha256').update(text).digest('hex');writeFileSync(markerFile,JSON.stringify(marker));
    }
    replace([{...original[0],executable_command:'do something'}]);
    assert.throws(()=>importAll(f.target,{directory}),/Invalid row/);
    replace([{...original[0],result:JSON.stringify({...JSON.parse(original[0].result),source:{skillId:'skill:one',revision:1,hash:'b'.repeat(64)}})}]);
    assert.throws(()=>importAll(f.target,{directory}),/source binding/);
    assert.equal(f.target.allEntries().length,0);assert.equal(f.target.jobs.list().length,0);
  }finally{f.close();}
});
