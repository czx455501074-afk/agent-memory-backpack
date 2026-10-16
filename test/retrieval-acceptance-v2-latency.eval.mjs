import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { Store } from '../dist/src/store.js';
import { createCoreServer } from '../dist/src/server.js';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/retrieval-acceptance-v2.json',import.meta.url),'utf8'));
const original=JSON.parse(readFileSync(join(homedir(),'.agent-memory-backpack','model-review.json'),'utf8'));
const results=[];
for(const mode of ['actual-provider','mock-unavailable','mock-timeout']) {
  const dir=mkdtempSync(join(tmpdir(),'amb-latency-')),store=new Store(join(dir,'knowledge.sqlite'));
  let calls=0; const provider=createServer(async(req,res)=>{
    calls++;let body='';for await(const chunk of req)body+=chunk;
    if(mode==='mock-timeout')return;
    if(mode==='mock-unavailable'){res.writeHead(503);res.end();return;}
    try {const reply=await fetch(original.endpoint.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{'content-type':'application/json',...(original.apiKey?{authorization:`Bearer ${original.apiKey}`}:{})},body,signal:AbortSignal.timeout(5000)});res.writeHead(reply.status,{'content-type':'application/json'});res.end(await reply.text());}
    catch {res.writeHead(503);res.end();}
  });
  await new Promise(done=>provider.listen(0,'127.0.0.1',done));
  writeFileSync(join(dir,'model-review.json'),JSON.stringify({...original,endpoint:`http://127.0.0.1:${provider.address().port}/v1`,timeoutMs:4000}));
  store.import(fixture.documents.map(d=>({id:d.id,title:d.title,scope:{kind:'global'},baseRevision:0,...(d.kind==='skill'?{kind:'skill',body:`description: ${d.description}\n${d.body}`,leaves:[],needsStructure:true}:{kind:'memory',body:d.body.repeat(d.repeat??1)})})));
  const token='latency-isolated-credential-32-characters',core=createCoreServer(store,{protocolVersion:1,port:47631,clients:[{id:'codex',token,projectId:'p',role:'adapter'}]});
  await new Promise(done=>core.listen(0,'127.0.0.1',done));
  const post=async(path,query)=>{const start=performance.now();const response=await fetch(`http://127.0.0.1:${core.address().port}${path}`,{method:'POST',headers:{'content-type':'application/json','x-amb-protocol':'1',authorization:`Bearer ${token}`},body:JSON.stringify({projectId:'p',adapter:'codex',query})});const data=await response.json();return {ms:Math.round(performance.now()-start),ids:(data.knowledge??data.results??[]).map(e=>e.id),selection:data.retrieval?.selection??data.selection};};
  try {
    const samples=[];
    for(const item of fixture.cases.slice(0,3)) {
      const before=calls,first=await post('/v1/prepare',item.query),afterFirst=calls;
      const cached=[];for(let n=0;n<3;n++)cached.push(await post('/v1/knowledge/search-universal',item.query));
      samples.push({caseId:item.id,first,firstProviderCalls:afterFirst-before,cached,cachedProviderCalls:calls-afterFirst,equivalent:cached.every(x=>JSON.stringify(x.ids)===JSON.stringify(first.ids))});
    }
    const percentile=(xs,p)=>xs.sort((a,b)=>a-b)[Math.ceil(xs.length*p)-1];
    results.push({mode,samples,summary:{firstP50Ms:percentile(samples.map(x=>x.first.ms),.5),firstP95Ms:percentile(samples.map(x=>x.first.ms),.95),cacheP95Ms:percentile(samples.flatMap(x=>x.cached.map(c=>c.ms)),.95),providerCalls:calls,totalRequests:12,firstQueryProviderRatio:samples.reduce((a,x)=>a+x.firstProviderCalls,0)/3,cachedProviderCalls:samples.reduce((a,x)=>a+x.cachedProviderCalls,0),equivalent:samples.every(x=>x.equivalent)}});
  } finally {for(const server of [core,provider]){server.closeAllConnections();await new Promise(done=>server.close(done));}store.close();rmSync(dir,{recursive:true,force:true});}
}
writeFileSync('.local/retrieval-v2-latency.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results.map(x=>({mode:x.mode,...x.summary}))));
