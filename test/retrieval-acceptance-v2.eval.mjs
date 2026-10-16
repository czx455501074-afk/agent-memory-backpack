// Independent evaluation. Deliberately not a *.test file: live provider calls
// require --live, and quality failures must remain measurements, not hidden skips.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const fixtureVersion = process.argv.includes('--v3') ? 'v3' : 'v2';
const fixtureFile = new URL(`./fixtures/retrieval-acceptance-${fixtureVersion}.json`, import.meta.url);
const source = readFileSync(fixtureFile, 'utf8');
const hash = createHash('sha256').update(source).digest('hex');
if (hash !== ({v2:'a118cfca4a2d3cec0d3940db55984812b4f1342497b8a60b56636067f752734b',v3:'70d237c75c94840364e3a302c6858dad9c59021a579e2d4cb0904de50bdca894'})[fixtureVersion]) throw Error('Frozen fixture changed');
const fixture = JSON.parse(source);
const value = flag => { const i=process.argv.indexOf(flag); return i<0?undefined:process.argv[i+1]; };
const root = resolve(value('--runtime') ?? 'dist/src');
const { Store } = await import(pathToFileURL(join(root, 'store.js')).href);
const { createRetrievalService } = await import(pathToFileURL(join(root, 'retrieval-service.js')).href);
const { initializeWorkflowDrafts } = await import(pathToFileURL(join(root, 'workflow-organization.js')).href);
const { createCoreServer } = await import(pathToFileURL(join(root, 'server.js')).href);
const dir=mkdtempSync(join(tmpdir(),'amb-acceptance-v2-'));
const store=new Store(join(dir,'knowledge.sqlite'));
let server;
try {
  initializeWorkflowDrafts(store);
  store.import(fixture.documents.map(d=>({id:d.id,title:d.title,scope:{kind:'global'},baseRevision:0,
    ...(d.kind==='skill'?{kind:'skill',body:`---\nname: ${d.id}\ndescription: ${d.description}\n---\n${d.body}`,leaves:[],needsStructure:true}:
      {kind:'memory',body:d.body.repeat(d.repeat??1)})})));
  const live=process.argv.includes('--live');
  let model='none';
  if(live) { const config=JSON.parse(readFileSync(join(homedir(),'.agent-memory-backpack','model-review.json'),'utf8'));
    model=config.model;writeFileSync(join(dir,'model-review.json'),JSON.stringify(config)); }
  const route=value('--route')??'service';
  const select=createRetrievalService(store,dir), cases=[];
  let endpoint;
  const token='isolated-acceptance-credential-not-real-32';
  if(route!=='service') {server=createCoreServer(store,{protocolVersion:1,port:47631,clients:[{id:'codex',token,projectId:'acceptance-v2',role:'adapter'}]});
    await new Promise(done=>server.listen(0,'127.0.0.1',done));endpoint=`http://127.0.0.1:${server.address().port}`;}
  for(const c of fixture.cases) {
    const start=performance.now();let result,actual;
    if(route==='service') {result=await select('acceptance-v2',c.query);actual=result.selectedIds;}
    else { const response=await fetch(endpoint+(route==='prepare'?'/v1/prepare':'/v1/knowledge/search-universal'),{method:'POST',headers:{'content-type':'application/json','x-amb-protocol':'1',authorization:`Bearer ${token}`},body:JSON.stringify({projectId:'acceptance-v2',adapter:'codex',query:c.query})});
      if(!response.ok)throw Error(`HTTP ${response.status}`);const data=await response.json();result=data.selection??data.retrieval.selection;actual=(data.results??data.knowledge).map(x=>x.id);}
    const ms=Math.round(performance.now()-start);
    cases.push({id:c.id,dimension:c.dimension,actual,expected:c.relevant,mode:result.mode,reason:result.reason,ms,
      tp:actual.filter(x=>c.relevant.includes(x)).length,fp:actual.filter(x=>!c.relevant.includes(x)).length,
      fn:c.relevant.filter(x=>!actual.includes(x)).length,
      // Empty failure output cannot count as a correct semantic rejection.
      negativeRejected:!c.relevant.length&&!actual.length&&(result.mode!=='lexical_fallback'||(route!=='service'&&result.reason==='not_configured'))&&!/timeout|unavailable|busy/.test(result.reason??'')});
  }
  const sum=k=>cases.reduce((a,c)=>a+c[k],0),tp=sum('tp'),fp=sum('fp'),fn=sum('fn');
  const times=cases.map(c=>c.ms).sort((a,b)=>a-b), negatives=cases.filter(c=>!c.expected.length);
  const summary={at:new Date().toISOString(),fixtureSHA256:hash,runtime:root,route,corpus:'synthetic-new-holdout',provider:live?'actual-configured':'not-called',model,
    cases:cases.length,tp,fp,fn,precision:tp/(tp+fp||1),recall:tp/(tp+fn||1),negativeCases:negatives.length,
    negativeRejection:negatives.filter(c=>c.negativeRejected).length/(negatives.length||1),
    timeouts:cases.filter(c=>/timeout/.test(c.reason??'')).length,degraded:cases.filter(c=>c.mode==='lexical_fallback').length,
    p50Ms:times[Math.ceil(times.length*.5)-1],p95Ms:times[Math.ceil(times.length*.95)-1],
    thresholds:fixture.meta.thresholds};
  summary.accepted=summary.precision>=.9&&summary.recall>=.85&&summary.negativeRejection>=.95&&summary.timeouts/cases.length<=.05&&summary.p95Ms<=4500;
  const output=value('--output');if(output)writeFileSync(output,JSON.stringify({summary,cases},null,2));
  console.log(JSON.stringify(summary));
} finally {if(server){server.closeAllConnections();await new Promise(done=>server.close(done));}store.close();rmSync(dir,{recursive:true,force:true});}
