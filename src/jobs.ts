import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

/**
 * 作业类型。**新增一种就必须加进这个联合类型**：`enqueue` 一个未登记的类型不会被拒绝，
 * 而是静默丢失 —— 这次加 `term_bridge` 时是 TypeScript 先挡住的
 * （`Argument of type '"term_bridge"' is not assignable to parameter of type 'JobKind'`）。
 */
export type JobKind = 'model_review' | 'export' | 'notify' | 'structure_skill_digest' | 'structure_skill' | 'evolve' | 'term_bridge';
export interface Job { id: string; kind: JobKind; key: string; payload: Record<string, unknown>; status: string; attempts: number; nextAt: number; error: string | null }

/** Uses the authority connection: enqueue inside the caller's transaction for atomic commits. */
export class DurableJobs {
  constructor(private db: DatabaseSync, private now: () => number = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS maintenance_jobs(
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, idem TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
      lease_until INTEGER NOT NULL DEFAULT 0, error TEXT, result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS maintenance_jobs_due ON maintenance_jobs(status,next_at);`);
  }
  enqueue(kind: JobKind, key: string, payload: Record<string, unknown>): string {
    const at = this.now();
    this.db.prepare(`INSERT OR IGNORE INTO maintenance_jobs(id,kind,idem,payload,status,next_at,created_at,updated_at)
      VALUES(?,?,?,?,'pending',?,?,?)`).run(randomUUID(), kind, key, JSON.stringify(payload), at, at, at);
    return String(this.db.prepare('SELECT id FROM maintenance_jobs WHERE idem=?').get(key)!.id);
  }
  list(limit = 50): Job[] {
    return this.db.prepare('SELECT * FROM maintenance_jobs ORDER BY created_at DESC LIMIT ?').all(Math.max(1, Math.min(200, limit))).map(row => this.decode(row));
  }
  private decode(row: Record<string, unknown>): Job {
    return { id: String(row.id), kind: row.kind as JobKind, key: String(row.idem), payload: JSON.parse(String(row.payload)), status: String(row.status), attempts: Number(row.attempts), nextAt: Number(row.next_at), error: row.error === null ? null : String(row.error) };
  }
  /** A lease lets interrupted work resume; handlers must be idempotent by job key. */
  claim(): Job | undefined {
    const at = this.now();
    const row = this.db.prepare(`UPDATE maintenance_jobs SET status='running', attempts=attempts+1, lease_until=?, updated_at=?
      WHERE id=(SELECT id FROM maintenance_jobs WHERE (status='pending' AND next_at<=?) OR (status='running' AND lease_until<=?)
      ORDER BY CASE kind WHEN 'notify' THEN 0 WHEN 'model_review' THEN 1 ELSE 2 END,created_at LIMIT 1) RETURNING *`).get(at + 90000, at, at, at);
    return row ? this.decode(row) : undefined;
  }
  /**
   * Extend the lease on a job this worker still holds.
   *
   * The lease is 90 seconds, and `model_review` calls an external model that can take
   * longer. Without renewal the next tick sees `status='running' AND lease_until<=now`,
   * treats the job as abandoned, and claims it again — so the same review runs twice and
   * both runs write a result. The `attempts` guard means a worker can only renew the
   * generation it was actually given.
   */
  heartbeat(id: string, attempts: number, ms = 90_000): boolean {
    return this.db.prepare("UPDATE maintenance_jobs SET lease_until=?, updated_at=? WHERE id=? AND status='running' AND attempts=?")
      .run(this.now() + ms, this.now(), id, attempts).changes > 0;
  }
  /**
   * `attempts` is the generation this worker claimed. Passing it makes the write
   * conditional: if the lease expired and another worker re-claimed the job, the stale
   * worker's finish/retry updates zero rows instead of overwriting the live run's state.
   */
  finish(id: string, result: unknown, attempts?: number) {
    const at = this.now();
    const guard = attempts === undefined ? '' : ' AND attempts=?';
    const params = attempts === undefined ? [JSON.stringify(result ?? null), at, id] : [JSON.stringify(result ?? null), at, id, attempts];
    this.db.prepare(`UPDATE maintenance_jobs SET status='completed',result=?,error=NULL,lease_until=0,updated_at=? WHERE id=? AND status='running'${guard}`).run(...params as never[]);
  }
  retry(job: Job, reason: string, maxAttempts = 12) {
    // Store stable codes only, never provider responses or exception text containing credentials.
    const error = /^[a-z_]{1,60}$/.test(reason) ? reason : 'handler_failed';
    const state = job.attempts >= maxAttempts ? 'needs_action' : 'pending';
    this.db.prepare("UPDATE maintenance_jobs SET status=?,next_at=?,lease_until=0,error=?,updated_at=? WHERE id=? AND status='running' AND attempts=?")
      .run(state, this.now() + Math.min(3600000, 1000 * 2 ** Math.min(job.attempts, 12)), error, this.now(), job.id, job.attempts);
  }
  /**
   * Drop completed jobs that are old enough to stop being useful for diagnosis.
   *
   * Nothing ever removed them: the real library held 3,664 rows, every one in a terminal
   * state, growing by roughly one row per notification and per model review. `needs_action`
   * is deliberately kept — those are the rows a person still has to look at — and a small
   * recent window of completions stays so "did last night's pass run?" is still answerable.
   */
  purgeCompleted(olderThanMs: number, keep = 200): number {
    const cutoff = this.now() - olderThanMs;
    const survivors = new Set((this.db.prepare(
      "SELECT id FROM maintenance_jobs WHERE status='completed' ORDER BY updated_at DESC LIMIT ?").all(keep) as Array<{ id: string }>)
      .map(row => String(row.id)));
    const rows = this.db.prepare("SELECT id FROM maintenance_jobs WHERE status='completed' AND updated_at<=?")
      .all(cutoff).map(row => String((row as { id: string }).id)).filter(id => !survivors.has(id));
    if (rows.length === 0) return 0;
    this.db.prepare(`DELETE FROM maintenance_jobs WHERE id IN (${rows.map(() => '?').join(',')})`).run(...rows);
    return rows.length;
  }
  requeue(id: string) {
    return this.db.prepare("UPDATE maintenance_jobs SET status='pending',attempts=0,next_at=?,lease_until=0,error=NULL,updated_at=? WHERE id=? AND status!='running'").run(this.now(), this.now(), id).changes > 0;
  }
  async run(handlers: Partial<Record<JobKind, (job: Job) => Promise<unknown> | unknown>>, max = 10) {
    for (let i = 0; i < max; i++) {
      const job = this.claim();
      if (!job) break;
      const handler = handlers[job.kind];
      if (!handler) { this.retry(job, 'handler_unavailable'); continue; }
      // Renew while the handler runs. Renewal is half the lease, so a slow model call keeps
      // the job instead of having it re-claimed mid-flight by the next tick.
      const renew = setInterval(() => this.heartbeat(job.id, job.attempts), 30_000);
      renew.unref?.();
      try { this.finish(job.id, await handler(job), job.attempts); }
      catch { this.retry(job, 'handler_failed'); }
      finally { clearInterval(renew); }
    }
  }
}
