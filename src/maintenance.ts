import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Store } from './store.js';
import { DurableJobs } from './jobs.js';
import { analyzeWithModel, modelReviewConfigSchema } from './model-review.js';
// 模型归纳版术语桥：自动进化顺带补规则覆盖不到的那些说法（见 term-bridge-model.ts）。
import { proposeBridge } from './term-bridge-model.js';
import { exportSkills } from './export-skills.js';
import { initializeWorkflowDrafts, processWorkflowDraft, processWorkflowDigest, enqueueWorkflowDraft } from './workflow-organization.js';
import { collect, proposalSourceFrom, refineThresholds, type RefineRun } from './refine.js';

export function initializeMaintenance(store: Store) {
  initializeWorkflowDrafts(store);
  const jobs = new DurableJobs(store.db);
  store.db.exec(`CREATE TABLE IF NOT EXISTS model_reviews(proposal_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, result TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS revision_notifications(revision INTEGER PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL);`);
  return jobs;
}
export function maintenanceStatus(store: Store, projectId: string) {
  const jobs = initializeMaintenance(store);
  return {
    jobs: jobs.list(200).filter(job => !job.payload.projectId || job.payload.projectId === projectId),
    reviews: store.db.prepare('SELECT proposal_id,result,updated_at FROM model_reviews WHERE project_id=? ORDER BY updated_at DESC LIMIT 50').all(projectId)
      .map(row => ({ proposalId: row.proposal_id, result: JSON.parse(String(row.result)), updatedAt: row.updated_at })),
    notifications: store.db.prepare('SELECT revision,created_at FROM revision_notifications ORDER BY revision DESC LIMIT 20').all(),
  };
}

/**
 * Read the queue and report what could be distilled from it. Never writes.
 *
 * Deliberately not wired into the worker's tick: the first version of this scheduler
 * exists to be read by a person and checked against the queue it read, and a dry run
 * that a scheduler calls on a timer is not a dry run. `dryRun` is therefore the only
 * mode implemented — there is no code path from here to `submit` or to `import`.
 */
export function refineStatus(store: Store, options: { projects?: string[]; now?: number } = {}): RefineRun {
  return collect({
    source: proposalSourceFrom(store.db as unknown as { prepare: (sql: string) => { all: (...params: unknown[]) => unknown[] } }, options.projects ?? []),
    meta: (key) => {
      const row = store.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: number } | undefined;
      return row === undefined ? undefined : Number(row.value);
    },
    now: options.now,
  });
}

/** The thresholds in force, for a caller that only wants to display them. */
export function refineThresholdsInUse(store: Store) {
  return refineThresholds((key) => {
    const row = store.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: number } | undefined;
    return row === undefined ? undefined : Number(row.value);
  });
}

/** One idempotent worker shared by CLI and other actual core entry paths. */
export function createMaintenanceWorker(store: Store, dataDir: string, projectIds: string[] = []) {  const jobs = initializeMaintenance(store);
  let busy = false;
  let stopped = false;
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      // Expiration is authoritative even when a worker is invoked without HTTP.
      store.cleanup();
      // Backfill imported skills and re-organize changed sources without blocking imports.
      // The tick already decoded this entry; handing it to the draft enqueue
      // keeps one scoped read per project instead of one full decode per skill.
      for(const projectId of new Set(projectIds)) for(const entry of store.scopedEntries(projectId))
        if(entry.content.kind==='skill' && entry.content.needsStructure) enqueueWorkflowDraft(store,projectId,entry.id,false,entry);
      // Existing pending proposals predate this worker. Reconcile by stable ids.
      for (const row of store.db.prepare("SELECT id,project_id,payload FROM proposals WHERE state IN ('pending','needs_evidence')").all()) {
        const inputHash = createHash('sha256').update(String(row.payload)).digest('hex');
        const previous = store.db.prepare('SELECT result FROM model_reviews WHERE proposal_id=?').get(String(row.id));
        const changed = previous && JSON.parse(String(previous.result)).inputHash !== inputHash;
        jobs.enqueue('model_review', `proposal:${row.id}${changed ? ':' + inputHash : ''}`, { proposalId: row.id, projectId: row.project_id });
      }
      jobs.enqueue('notify', `revision:${store.revision}`, { revision: store.revision });
      /**
       * Evolution runs on a six-hour window, and only as far as consolidation.
       *
       * It reads the whole candidate table, so running it on every tick would be work whose
       * input had not changed; the window is part of the idempotency key, which means a core
       * that restarts every minute still runs it at most once per window. The window is
       * derived from the clock rather than from a stored "last run", so no state can drift.
       *
       * `promote` is deliberately absent: distilling and relating candidates is observation,
       * while promoting them files proposals a person then has to review. The first is safe
       * to automate, the second is somebody's decision — that boundary is the whole reason
       * the eight-entry `FORBIDDEN_AUTOMATIC` list exists.
       */
      const evolveWindow = Math.floor(Date.now() / (6 * 3_600_000));
      for (const projectId of new Set(projectIds)) {
        jobs.enqueue('evolve', `evolve:${projectId}:${evolveWindow}`, { projectId });
      }
      const exportConfigFile = join(dataDir, 'maintenance.json');
      if (existsSync(exportConfigFile)) {
        try {
          const cfg = z.object({ exportDirectory: z.string().min(1).optional() }).strict().parse(JSON.parse(readFileSync(exportConfigFile, 'utf8')));
          if (cfg.exportDirectory) jobs.enqueue('export', `export:${cfg.exportDirectory}:${store.revision}`, { directory: cfg.exportDirectory, revision: store.revision });
        } catch { /* Invalid optional configuration cannot stop knowledge reads or queued work. */ }
      }
      await jobs.run({
        async structure_skill_digest(job) {
          let config;
          try { config = modelReviewConfigSchema.parse(JSON.parse(readFileSync(join(dataDir, 'model-review.json'), 'utf8'))); } catch { /* Explicit awaiting_model below. */ }
          const result=await processWorkflowDigest(store,job.payload,config,job.attempts);
          if(result.status==='awaiting_model'||result.status==='needs_action') jobs.retry(job,String(result.reason??'awaiting_model'),3);
          return result;
        },
        async structure_skill(job) {
          const saved=store.db.prepare('SELECT result FROM workflow_drafts WHERE id=?').get(String(job.payload.id));
          const draft=saved?.result?JSON.parse(String(saved.result)) as {digest?:unknown}:null;
          if(!draft?.digest) {
            // Upgrade legacy queued workflow-only jobs into the digest-first
            // path before any new model request can combine both responsibilities.
            enqueueWorkflowDraft(store,String(job.payload.projectId),String(job.payload.skillId));
            return {status:'awaiting_digest'};
          }
          let config;
          try { config = modelReviewConfigSchema.parse(JSON.parse(readFileSync(join(dataDir, 'model-review.json'), 'utf8'))); } catch { /* Explicit awaiting_model below. */ }
          const result = await processWorkflowDraft(store, job.payload, config,job.attempts);
          if(result.status==='awaiting_model') jobs.retry(job,'awaiting_model',5);
          return result;
        },
        async model_review(job) {
          const proposalId = String(job.payload.proposalId);
          const row = store.db.prepare('SELECT payload,project_id,state FROM proposals WHERE id=?').get(proposalId);
          if (!row || !['pending', 'needs_evidence'].includes(String(row.state))) return { skipped: true };
          const payload = JSON.parse(String(row.payload || '{}')) as { discovery?: string };
          const configFile = join(dataDir, 'model-review.json');
          let config;
          if (existsSync(configFile)) {
            try { config = modelReviewConfigSchema.parse(JSON.parse(readFileSync(configFile, 'utf8'))); }
            catch { /* Mark unavailable below, without persisting credentials or raw parse errors. */ }
          }
          const relevant = store.searchUniversal(String(row.project_id), payload.discovery ?? '', undefined, 8);
          const entries = relevant.map(hit => {
            const head = store.allEntries().find(entry => entry.id === hit.id)!;
            const c = head.content;
            return { id: hit.id, title: c.title, kind: c.kind, body: 'body' in c ? String(c.body) : JSON.stringify(c) };
          });
          const result = await analyzeWithModel(payload.discovery ?? '', entries, config);
          store.db.prepare(`INSERT INTO model_reviews(proposal_id,project_id,result,updated_at) VALUES(?,?,?,?)
            ON CONFLICT(proposal_id) DO UPDATE SET result=excluded.result,updated_at=excluded.updated_at`)
            .run(proposalId, String(row.project_id), JSON.stringify({ ...result, inputHash: createHash('sha256').update(String(row.payload)).digest('hex') }), Date.now());
          if (result.status === 'awaiting_model') { jobs.retry(job, 'awaiting_model'); return { awaitingModel: true }; }
          return result;
        },
        export(job) {
          // The exporter only writes its own marked tree and hash-compares existing files.
          return { ...exportSkills(store, { directory: String(job.payload.directory), dryRun: false }), actualRevision: store.revision };
        },
        notify(job) {
          store.db.prepare('INSERT OR IGNORE INTO revision_notifications(revision,payload,created_at) VALUES(?,?,?)')
            .run(Number(job.payload.revision), JSON.stringify(job.payload), Date.now());
          return { revision: job.payload.revision, availableForPolling: true };
        },
        /**
         * 自动进化顺带补**模型桥**。
         *
         * 规则桥在建索引时就算好了（见 store.ts 的 withBridge），这一步只补规则覆盖不到的那些
         * 说法：项目内部黑话、旧称、某个人的习惯叫法 —— 那些要读过条目、又见过用户怎么说话的
         * 一方才补得出来。
         *
         * 三条与别处一致的纪律：**未配置就跳过、不假装跑过**；**失败不写坏数据**（模型返回
         * 不合形状时 proposeBridge 自己降级）；**桥存独立表、不写回条目**（不造新修订）。
         *
         * 由 `evolve` 作业在跑完后触发，所以它跟着自动进化的节奏走，不需要人记得手动跑。
         */
        async term_bridge(job) {
          const configFile = join(dataDir, 'model-review.json');
          let config;
          if (existsSync(configFile)) {
            try { config = modelReviewConfigSchema.parse(JSON.parse(readFileSync(configFile, 'utf8'))); }
            catch { /* 下面按未配置处理，不落任何凭据或解析细节 */ }
          }
          if (!config) return { skipped: true, reason: 'not_configured' };
          const pending = store.pendingBridgeEntries(Number(job.payload.limit ?? 10));
          let saved = 0; let failed = 0;
          for (const entry of pending) {
            const proposal = await proposeBridge({ title: entry.title, body: entry.body, kind: entry.kind, config });
            if (proposal.source !== 'model') { failed++; continue; }
            saved += store.saveBridge([{
              id: entry.id, revision: entry.revision, model: proposal.model ?? '',
              aliases: proposal.aliases, keywords: proposal.keywords, summary: proposal.summary,
            }]);
          }
          // 只在真写了东西时重建：没有新桥时重建索引是纯浪费（万级条目下约 2.4 秒）。
          if (saved) store.rebuildSearchIndex();
          return { saved, failed, pending: pending.length, model: config.model };
        },
        evolve(job) {
          // Stage one and two only. Promotion is not called here on purpose: it files
          // proposals, which is a decision, and this worker runs unattended.
          const projectId = String(job.payload.projectId);
          const distilled = store.runEvolution({ projectId, dryRun: false });
          const consolidated = store.consolidateEvolution({ projectId, dryRun: false });
          // 归纳之后顺带补模型桥：新条目一落地就带规则桥，模型桥在这里跟上。
          // 未配置模型时那个作业会自己跳过，所以这里不必先判断配置。
          jobs.enqueue('term_bridge', `term_bridge:${projectId}:${store.revision}`, { limit: 10 });
          return {
            scanned: distilled.scanned,
            candidates: distilled.candidates.length,
            links: consolidated.linked,
            stale: consolidated.stale.length,
            knowledgeUnchanged: store.revision === distilled.knowledgeRevision,
          };
        },
      }, 2);
    } finally { busy = false; }
  };
  return { tick, stop() { stopped = true; }, jobs };
}
