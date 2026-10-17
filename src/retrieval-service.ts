import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Store } from './store.js';
import { modelReviewConfigSchema } from './model-review.js';
import { selectRelevantKnowledge } from './semantic-retrieval.js';
import { buildRetrievalIndex, positiveRetrievalClauses } from './retrieval-index.js';
import { digestSchema } from './workflow-draft.js';

/**
 * The selection, with the path that produced it.
 *
 * `source` is deliberately absent: which path decided is already fully determined
 * by `mode` and `reason` (`model` = the provider chose, `index` with a
 * `local_index:` reason = the local ranking did, `exact_id` = a literal id), and a
 * second field carrying the same fact would be one more thing to keep in step.
 * `selectionSource()` derives it for the receipt.
 */
/**
 * How long the model gets before the local ranking carries the decision.
 *
 * Exported so the test proving that an exhausted budget aborts the abandoned request can wait
 * for the real number instead of a copy of it. That test held a hardcoded 3200ms against a
 * 2500ms budget; raising the budget made the assertion fail while the behaviour it checks
 * stayed correct - a test reporting a change of constant as if it were a defect.
 *
 * The value is measured rather than chosen: across 12 related queries the model answered with
 * a median of 2101ms and a slowest of 2787ms, while every request that timed out landed at
 * 2871-2875ms - just past a 2500ms budget once the surrounding work is counted. 3500 covers
 * the observed tail and stays inside the adapter's 5s abort.
 */
export const MODEL_BUDGET_MS = 3500;

export type RetrievalSelection = { mode: 'model' | 'index' | 'lexical_fallback';
  selectedIds: string[]; reason?: string };
/** Which path produced `selection`, read off the fields that already state it. */
export function selectionSource(selection: Pick<RetrievalSelection, 'mode' | 'reason'>)
  : 'model' | 'index' | 'local_index' | undefined {
  if(selection.mode==='model')return 'model';
  if((selection.reason??'').startsWith('local_index:'))return 'local_index';
  if(selection.mode==='index')return 'index';
  return undefined;
}

/** Server-local cache; contains only relevance decisions, never provider credentials. */
export function createRetrievalService(store: Store, dataDir: string) {
  const cache=new Map<string,{at:number;result:RetrievalSelection}>();
  const indexes=new Map<string,{key:string;index:ReturnType<typeof buildRetrievalIndex>;candidates:Parameters<typeof buildRetrievalIndex>[0]}>();
  const pending=new Map<string,Promise<RetrievalSelection>>();
  return async (projectId:string,query:string):Promise<RetrievalSelection> => {
    if(!query.trim())return {mode:'model' as const,selectedIds:[]};
    // A bare completion/status acknowledgement contains no new retrieval intent.
    if(/^(?:已|已经)(?:重启|重新启动|安装|更新|升级|保存|完成|恢复)(?:了)?\s*[a-z0-9_. -]{0,40}[。!！\s]*$/i.test(query.trim()))
      return {mode:'model' as const,selectedIds:[],reason:'status_without_task'};
    if(!positiveRetrievalClauses(query).length)return {mode:'index' as const,selectedIds:[],reason:'no_positive_task'};
    let config,stamp;
    try { const file=join(dataDir,'model-review.json');stamp=statSync(file).mtimeMs;config=modelReviewConfigSchema.parse(JSON.parse(readFileSync(file,'utf8'))); }
    catch { config=undefined;stamp=0; }
    const revision=store.revision;
    /**
     * Rules are candidates like every other entry.
     *
     * They used to be filtered out here, on the grounds that `norms()` already
     * injects them in full and a retrieved copy would duplicate that context. The
     * duplicate would have to be produced by the injection side, and it is not:
     * `prepare()` reads rules only through `norms()` (`store.ts:1094`), while the
     * retrieved entries are built by `knowledge()`, which returns nothing but
     * skill/memory/preference/journal and skips every other kind (`store.ts:774`).
     * Passing a rule id in `selectedIds` therefore adds it to neither `workflows`
     * nor `knowledge` - asserted in `test/norm-searchable.test.ts:104`. Filtering
     * here instead made the one kind that states rules the only kind that automatic
     * retrieval and the model selector could never see, while the full-text path
     * could return them: two answers to the same question inside one task.
     */
    const scoped=store.scopedEntries(projectId);
    const liveKey=scoped.map(e=>`${e.id}@${e.revision}`).sort().join('|');
    const digests=new Map<string,{revision:number;digest:{summary:string;whenToUse:string[];exclusions:string[];aliases:string[];versions:string[]}}>();
    for(const row of store.db.prepare("SELECT skill_id,result FROM workflow_drafts WHERE project_id=? AND result IS NOT NULL AND state!='stale' ORDER BY updated_at DESC").all(projectId)) {
      try {
        const result=JSON.parse(String(row.result)), skillId=String(row.skill_id);
        const parsed=digestSchema.safeParse(result.digest), revision=result.source?.revision;
        const identity=`${skillId}@${revision}`;
        if(parsed.success && result.source?.skillId===skillId && Number.isInteger(revision) && revision>0 && !digests.has(identity))
          digests.set(identity,{revision,digest:parsed.data});
      }catch{/* Invalid metadata never broadens recall. */}
    }
    // Procedure queue/state changes do not invalidate relevance decisions.
    const indexStamp=createHash('sha256').update(JSON.stringify([...digests].filter(([identity])=>scoped.some(e=>`${e.id}@${e.revision}`===identity)).sort(([a],[b])=>a.localeCompare(b)))).digest('hex');
    const key=createHash('sha256').update(JSON.stringify([projectId,query,revision,stamp,indexStamp,liveKey])).digest('hex');
    const hit=cache.get(key);if(hit&&Date.now()-hit.at<300000)return hit.result;
    if(pending.has(key))return pending.get(key)!;
    // Bound concurrent inference; tool hooks continue through the explicit fallback.
    const sourceKey=JSON.stringify([revision,indexStamp,liveKey]);
    let snapshot=indexes.get(projectId);
    if(snapshot?.key!==sourceKey) {
    const candidates=scoped.map(e=>{
      const metadata=digests.get(`${e.id}@${e.revision}`);const digest=metadata?.revision===e.revision?metadata.digest:undefined;
      const body='body' in e.content?e.content.body:e.content.kind==='journal'?e.content.did:JSON.stringify(e.content);
      return {id:e.id,revision:e.revision,title:e.content.title,kind:e.content.kind,
        body,...(digest?{retrievalDigest:{sourceRevision:e.revision,...digest}}:{})};
    });
    snapshot={key:sourceKey,index:buildRetrievalIndex(candidates),candidates};
    indexes.set(projectId,snapshot);
    if(indexes.size>32)indexes.delete(indexes.keys().next().value!);
    }
    const exact=snapshot.index.exact(query);
    if(exact.length)return {mode:'index' as const,selectedIds:exact.slice(0,5).map(e=>e.id),reason:'exact_id'};
    // A requested stale revision cannot be broadened into a different source.
    if(snapshot.candidates.some(e=>query.includes(`${e.id}@`)))return {mode:'index' as const,selectedIds:[],reason:'revision_mismatch'};
    const ranked=snapshot.index.rank(query);
    // The index already refuses stale, excluded, version-mismatched and
    // evidence-free rows, so the local answer is its ranking rather than only
    // the subset that reached strong evidence (requiring `strong` here made the
    // offline path abstain on nearly every real request). Among the survivors,
    // only entries near the best score are answers: a request about one skill
    // must not drag in every entry that happens to share a word with it.
    const best=ranked[0]?.score??0;
    // Truncation is relative: an entry far below the best is a shared-word
    // neighbour, not an answer. The exception is a second topic that carries its
    // own strong evidence — a two-topic request must not be answered with only
    // its highest-scoring topic.
    const bestOfObjective=new Map<number,number>();
    for(const hit of ranked) bestOfObjective.set(hit.objective,Math.max(bestOfObjective.get(hit.objective)??0,hit.score));
    // An absolute floor, not only a relative one.
    //
    // Truncation here was purely relative (`score >= best * 0.6`), and the index returns
    // score 0 for an entry with no matching evidence at all. When nothing matched, `best`
    // was 0, every entry satisfied `>= 0`, and the top three were handed back as hits. That
    // is how a query about braised pork selected the "story outline" and "external channel"
    // skills - scored 100/99/98 with `matched: []` and `coverage: 0` - and injected them.
    // The relative threshold answers "how far below the best may I go"; this answers "is
    // there a best at all". Without it, a degraded selection is indistinguishable from a
    // confident one to the agent that receives it.
    const localIds=best<=0?[]:ranked.filter(hit=>hit.score>=best*.6
      ||(hit.strong&&hit.score===bestOfObjective.get(hit.objective)&&hit.score>=best*.25))
      .slice(0,3).map(hit=>hit.candidate.id);
    const fallback=(reason:string)=>({mode:'index' as const,
      // A configured model that fails outright must not be silently replaced by a
      // lexical guess: only the unconfigured path is *defined* as deterministic
      // local retrieval. Availability and relevance are different claims, and the
      // caller is told which one it got.
      //
      // A timeout is not a refusal, and neither is being queued, so both are
      // handled differently from a failure on purpose. `localIds` is the local
      // index's own ranking, computed before the model was asked, so returning it
      // is not a guess standing in for a decision the model declined to make — it
      // is the deterministic result that was already in hand.
      //
      // Leaving these two empty cost the caller every useful hit. Measured against
      // the live library: a query that came back empty this way had ten local
      // matches, and under five concurrent requests three returned empty through
      // `busy` while the other two returned three hits each once `model_timeout`
      // was allowed to fall back. The reason string still carries the cause
      // (`model_timeout`, `busy`, `not_configured`), so a caller can always tell a
      // degraded local answer from a configured-model one.
      //
      // `model_abstained` belongs on this list for the same reason and not on the
      // other side of the line: an unavailable provider is an availability answer
      // (the caller is told the model could not speak), while a model that answered
      // "nothing is relevant" has still left the local ranking in hand. Returning it
      // is not a guess standing in for the model's judgement - the judgement was
      // "none" - and without this the injection path received an empty selection and
      // silently lost every hit the index had found.
      selectedIds:reason==='not_configured'||reason==='model_timeout'||reason==='busy'||reason==='model_abstained'?localIds:[],
      reason:`local_index:${reason}`});
    if(!config)return fallback('not_configured');
    if(pending.size>=2)return fallback('busy');
    // Small catalogs preserve a model opportunity for wholly novel paraphrases.
    // Large libraries never send the full directory on the synchronous path.
    const shortlist=snapshot.candidates.length<=12?snapshot.candidates:ranked.map(hit=>hit.candidate);
    if(!shortlist.length)return fallback('no_candidate_evidence');
    // The calling adapter aborts at 5s, while the configured model is allowed to
    // run far longer. Because /v1/prepare awaits this whole path, letting the
    // caller time out first does not merely lose the selection: the entire
    // prepare fails and norm injection goes down with it. A model that is only
    // slow is therefore treated as unavailable — the caller gets a degraded
    // receipt inside its own budget instead of a timeout it cannot tell apart
    // from an outage.
    // The budget must actually cancel the request it stopped waiting for. Racing a
    // timer against the provider without aborting left the abandoned fetch running;
    // when it failed on its own ~4s later, its rejection still ran the handler
    // below, which cached `local_index:timeout` with an empty selection — so the
    // same query answered `local_index:model_timeout` with hits first and
    // `local_index:timeout` with none on its second call. `settled` is the guard:
    // only a result produced inside the budget, before any abort, may be cached.
    const controller=new AbortController();
    let settled=false;
    const modelBudget=new Promise<RetrievalSelection>(resolve=>{
      // `settled` is set before the abort on purpose: an abort-triggered rejection
      // is already queued when `abort()` returns, and that late handler must see
      // the budget verdict, not write itself into the cache.
      //
      // 3500 rather than 2500, because the old budget sat inside the model's latency tail
      // instead of beyond it. Measured over 12 related queries
      // (verification/r5/selection-noise-rate.mjs): the model answered with a median of 2101ms
      // and a slowest of 2787ms, while the four requests that timed out came in at
      // 2871-2875ms - tens of milliseconds past a line that lands at ~2870ms once the
      // surrounding work is counted. Cutting a third of the answers means choosing the weaker
      // local fallback for them, and that fallback is precisely the path that needed an
      // evidence floor. 3500 covers the observed tail and still fits inside the adapter's 5s
      // abort, with ~370ms of surrounding work to spare.
      // 3500 rather than 2500: the old budget sat inside the model's latency tail instead of
      // beyond it. See MODEL_BUDGET_MS above for the measurement that set the value.
      const timer=setTimeout(()=>{settled=true;controller.abort();resolve(fallback('model_timeout'));},MODEL_BUDGET_MS);
      timer.unref();
    });
    const promise=Promise.race([
      selectRelevantKnowledge(query,shortlist,config,controller.signal).then(result=>{
        // The budget answer is already on its way to the caller: a later arrival is
        // neither a better answer nor a cacheable one, and it must not replace the
        // verdict already returned.
        if(settled)return fallback('model_timeout');
        if(store.revision!==revision || store.scopedEntries(projectId).map(e=>`${e.id}@${e.revision}`).sort().join('|')!==liveKey)return {mode:'lexical_fallback' as const,selectedIds:[],reason:'knowledge_changed'};
        // A model that answered "nothing applies" has given a relevance verdict the
        // caller must not lose the local ranking over; an unavailable or aborted
        // provider keeps its own reason so the two stay distinguishable.
        const resolved=result.mode==='model'&&result.selectedIds.length
          ?result
          :fallback(result.mode==='model'?'model_abstained':result.reason??'unavailable');
        cache.set(key,{at:Date.now(),result:resolved});if(cache.size>256)cache.delete(cache.keys().next().value!);
        return resolved;
      }),
      modelBudget,
    ]).finally(()=>{settled=true;pending.delete(key);});
    pending.set(key,promise);return promise;
  };
}
