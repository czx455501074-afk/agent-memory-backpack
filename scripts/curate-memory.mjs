#!/usr/bin/env node
/** Compile reviewed offline plans, dry-run by default, then apply/rollback through Store. */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { prepareCuration } from '../dist/src/curation.js';
import { Store } from '../dist/src/store.js';
import { knowledgeSchema } from '../dist/src/schema.js';

const { values } = parseArgs({ options: {
  snapshot: {type:'string'}, plan: {type:'string',multiple:true}, output:{type:'string'}, prepared:{type:'string'},
  batch:{type:'string'}, db:{type:'string'}, yes:{type:'boolean',default:false}, rollback:{type:'string'},
}});
const dbPath=resolve(values.db??join(homedir(),'.agent-memory-backpack','knowledge.sqlite'));
const read=file=>JSON.parse(readFileSync(file,'utf8'));
const hash=text=>createHash('sha256').update(text).digest('hex');
try {
  if(values.snapshot){
    if(!values.batch||!values.plan?.length||!values.output)throw Error('Prepare needs --snapshot catalog.json --batch ID --plan FILE [--plan FILE] --output FILE');
    const snapshot=read(resolve(values.snapshot)), root=dirname(resolve(values.snapshot));
    const db=new DatabaseSync(dbPath,{readOnly:true});
    try{
      db.exec('BEGIN');
      const sources=snapshot.catalog.map(item=>{
        const row=db.prepare('SELECT content FROM revisions WHERE id=? AND revision=?').get(item.id,item.revision);
        if(!row||hash(row.content)!==item.hash)throw Error(`Snapshot source identity is unavailable: ${item.id}`);
        // Hydrate original skill leaves, deliberately omitted from agent reading bundles.
        return {...item,content:knowledgeSchema.parse(JSON.parse(row.content))};
      });
      const prepared=prepareCuration(values.batch,sources,values.plan.map(file=>read(resolve(file))),Date.parse(snapshot.createdAt));
      writeFileSync(resolve(values.output),JSON.stringify(prepared,null,2));
      console.log(JSON.stringify({prepared:resolve(values.output),readOnly:true,planHash:prepared.planHash,summary:prepared.summary,warnings:prepared.warnings},null,2));
      db.exec('COMMIT');
    }finally{db.close();}
  }else if(values.prepared){
    const prepared=read(resolve(values.prepared));
    const expected=hash(JSON.stringify({batchId:prepared.batchId,sources:prepared.sources,entries:prepared.entries}));
    if(expected!==prepared.planHash)throw Error('Prepared plan hash mismatch');
    if(values.yes){
      const store=new Store(dbPath);
      try{console.log(JSON.stringify({...store.applyCurationBatch(prepared),summary:prepared.summary},null,2));}finally{store.close();}
    }else{
      const db=new DatabaseSync(dbPath,{readOnly:true});
      try{
        const changed=prepared.sources.filter(source=>{
          const row=db.prepare('SELECT k.head,k.status,r.content FROM knowledge k JOIN revisions r ON k.id=r.id AND k.head=r.revision WHERE k.id=?').get(source.id);
          return !row||row.head!==source.revision||row.status!=='active'||hash(row.content)!==source.hash;
        }).map(source=>source.id);
        console.log(JSON.stringify({dryRun:true,batchId:prepared.batchId,summary:prepared.summary,changedSources:changed,note:'No writes. Back up the database and verify on a copy before --yes.'},null,2));
        if(changed.length)process.exitCode=1;
      }finally{db.close();}
    }
  }else if(values.rollback){
    if(!values.yes)throw Error('Rollback is a forward revision migration; use --rollback BATCH --yes after reviewing the receipt');
    const store=new Store(dbPath);try{console.log(JSON.stringify(store.rollbackCurationBatch(values.rollback),null,2));}finally{store.close();}
  }else throw Error('Choose --snapshot, --prepared or --rollback');
}catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
