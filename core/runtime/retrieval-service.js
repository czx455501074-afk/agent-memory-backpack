import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { modelReviewConfigSchema } from './model-review.js';
import { selectRelevantKnowledge } from './semantic-retrieval.js';
import { buildRetrievalIndex, positiveRetrievalClauses } from './retrieval-index.js';
import { digestSchema } from './workflow-draft.js';
/** Server-local cache; contains only relevance decisions, never provider credentials. */
export function createRetrievalService(store, dataDir) {
    const cache = new Map();
    const indexes = new Map();
    const pending = new Map();
    return async (projectId, query) => {
        if (!query.trim())
            return { mode: 'model', selectedIds: [] };
        // A bare completion/status acknowledgement contains no new retrieval intent.
        if (/^(?:已|已经)(?:重启|重新启动|安装|更新|升级|保存|完成|恢复)(?:了)?\s*[a-z0-9_. -]{0,40}[。!！\s]*$/i.test(query.trim()))
            return { mode: 'model', selectedIds: [], reason: 'status_without_task' };
        if (!positiveRetrievalClauses(query).length)
            return { mode: 'index', selectedIds: [], reason: 'no_positive_task' };
        let config, stamp;
        try {
            const file = join(dataDir, 'model-review.json');
            stamp = statSync(file).mtimeMs;
            config = modelReviewConfigSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
        }
        catch {
            config = undefined;
            stamp = 0;
        }
        const revision = store.revision;
        const scoped = store.scopedEntries(projectId).filter(e => e.content.kind !== 'norm');
        const liveKey = scoped.map(e => `${e.id}@${e.revision}`).sort().join('|');
        const digests = new Map();
        for (const row of store.db.prepare("SELECT skill_id,result FROM workflow_drafts WHERE project_id=? AND result IS NOT NULL AND state!='stale' ORDER BY updated_at DESC").all(projectId)) {
            try {
                const result = JSON.parse(String(row.result)), skillId = String(row.skill_id);
                const parsed = digestSchema.safeParse(result.digest), revision = result.source?.revision;
                const identity = `${skillId}@${revision}`;
                if (parsed.success && result.source?.skillId === skillId && Number.isInteger(revision) && revision > 0 && !digests.has(identity))
                    digests.set(identity, { revision, digest: parsed.data });
            }
            catch { /* Invalid metadata never broadens recall. */ }
        }
        // Procedure queue/state changes do not invalidate relevance decisions.
        const indexStamp = createHash('sha256').update(JSON.stringify([...digests].filter(([identity]) => scoped.some(e => `${e.id}@${e.revision}` === identity)).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
        const key = createHash('sha256').update(JSON.stringify([projectId, query, revision, stamp, indexStamp, liveKey])).digest('hex');
        const hit = cache.get(key);
        if (hit && Date.now() - hit.at < 300000)
            return hit.result;
        if (pending.has(key))
            return pending.get(key);
        // Bound concurrent inference; tool hooks continue through the explicit fallback.
        const sourceKey = JSON.stringify([revision, indexStamp, liveKey]);
        let snapshot = indexes.get(projectId);
        if (snapshot?.key !== sourceKey) {
            const candidates = scoped.map(e => {
                const metadata = digests.get(`${e.id}@${e.revision}`);
                const digest = metadata?.revision === e.revision ? metadata.digest : undefined;
                const body = 'body' in e.content ? e.content.body : e.content.kind === 'journal' ? e.content.did : JSON.stringify(e.content);
                return { id: e.id, revision: e.revision, title: e.content.title, kind: e.content.kind,
                    body, ...(digest ? { retrievalDigest: { sourceRevision: e.revision, ...digest } } : {}) };
            });
            snapshot = { key: sourceKey, index: buildRetrievalIndex(candidates), candidates };
            indexes.set(projectId, snapshot);
            if (indexes.size > 32)
                indexes.delete(indexes.keys().next().value);
        }
        const exact = snapshot.index.exact(query);
        if (exact.length)
            return { mode: 'index', selectedIds: exact.slice(0, 5).map(e => e.id), reason: 'exact_id' };
        // A requested stale revision cannot be broadened into a different source.
        if (snapshot.candidates.some(e => query.includes(`${e.id}@`)))
            return { mode: 'index', selectedIds: [], reason: 'revision_mismatch' };
        const ranked = snapshot.index.rank(query);
        // The index already refuses stale, excluded, version-mismatched and
        // evidence-free rows, so the local answer is its ranking rather than only
        // the subset that reached strong evidence (requiring `strong` here made the
        // offline path abstain on nearly every real request). Among the survivors,
        // only entries near the best score are answers: a request about one skill
        // must not drag in every entry that happens to share a word with it.
        const best = ranked[0]?.score ?? 0;
        // Truncation is relative: an entry far below the best is a shared-word
        // neighbour, not an answer. The exception is a second topic that carries its
        // own strong evidence — a two-topic request must not be answered with only
        // its highest-scoring topic.
        const bestOfObjective = new Map();
        for (const hit of ranked)
            bestOfObjective.set(hit.objective, Math.max(bestOfObjective.get(hit.objective) ?? 0, hit.score));
        const localIds = ranked.filter(hit => hit.score >= best * .6
            || (hit.strong && hit.score === bestOfObjective.get(hit.objective) && hit.score >= best * .25))
            .slice(0, 3).map(hit => hit.candidate.id);
        const fallback = (reason) => ({ mode: 'index',
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
            selectedIds: reason === 'not_configured' || reason === 'model_timeout' || reason === 'busy' ? localIds : [], reason: `local_index:${reason}` });
        if (!config)
            return fallback('not_configured');
        if (pending.size >= 2)
            return fallback('busy');
        // Small catalogs preserve a model opportunity for wholly novel paraphrases.
        // Large libraries never send the full directory on the synchronous path.
        const shortlist = snapshot.candidates.length <= 12 ? snapshot.candidates : ranked.map(hit => hit.candidate);
        if (!shortlist.length)
            return fallback('no_candidate_evidence');
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
        const controller = new AbortController();
        let settled = false;
        const modelBudget = new Promise(resolve => {
            // `settled` is set before the abort on purpose: an abort-triggered rejection
            // is already queued when `abort()` returns, and that late handler must see
            // the budget verdict, not write itself into the cache.
            const timer = setTimeout(() => { settled = true; controller.abort(); resolve(fallback('model_timeout')); }, 2500);
            timer.unref();
        });
        const promise = Promise.race([
            selectRelevantKnowledge(query, shortlist, config, controller.signal).then(result => {
                // The budget answer is already on its way to the caller: a later arrival is
                // neither a better answer nor a cacheable one, and it must not replace the
                // verdict already returned.
                if (settled)
                    return fallback('model_timeout');
                if (store.revision !== revision || store.scopedEntries(projectId).filter(e => e.content.kind !== 'norm').map(e => `${e.id}@${e.revision}`).sort().join('|') !== liveKey)
                    return { mode: 'lexical_fallback', selectedIds: [], reason: 'knowledge_changed' };
                const resolved = result.mode === 'model' ? result : fallback(result.reason ?? 'unavailable');
                cache.set(key, { at: Date.now(), result: resolved });
                if (cache.size > 256)
                    cache.delete(cache.keys().next().value);
                return resolved;
            }),
            modelBudget,
        ]).finally(() => { settled = true; pending.delete(key); });
        pending.set(key, promise);
        return promise;
    };
}
