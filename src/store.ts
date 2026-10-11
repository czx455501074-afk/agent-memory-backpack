import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { DomainError, knowledgeSchema, workflowSchema, type Knowledge, type Workflow, type Scope } from './schema.js';

type Row = Record<string, unknown>;
type Entry = { id: string; revision: number; status: string; content: Knowledge };
export type TaskStatus = 'in_progress' | 'paused' | 'completed' | 'cancelled' | 'failed';
const DAY = 86400000;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const applicable = (scope: Scope, projectId: string) => scope.kind === 'global' || scope.projectId === projectId;
function searchable(value: string): string {
  // Unicode words plus CJK bigrams: deterministic Chinese recall without an external model.
  const words = value.toLowerCase().match(/[a-z0-9_-]+|[\p{Script=Han}]+/gu) ?? [];
  return words.flatMap(word => /\p{Script=Han}/u.test(word)
    ? (word.length === 1 ? [word] : Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)))
    : [word]).join(' ');
}

/** Single SQLite authority for the P0 fixture; not a semantic auto-promotion engine. */
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string, private readonly now: () => number = Date.now) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT OR IGNORE INTO meta VALUES ('revision',0);
      CREATE TABLE IF NOT EXISTS knowledge(id TEXT PRIMARY KEY, kind TEXT NOT NULL,
        head INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','retired')));
      CREATE TABLE IF NOT EXISTS revisions(id TEXT NOT NULL, revision INTEGER NOT NULL,
        content TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(id,revision),
        FOREIGN KEY(id) REFERENCES knowledge(id));
      CREATE VIRTUAL TABLE IF NOT EXISTS workflow_search USING fts5(id UNINDEXED, terms);
      CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY, principal TEXT NOT NULL,
        idem TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL,
        state TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        UNIQUE(principal,idem));
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, principal TEXT NOT NULL,
        event_id TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, UNIQUE(principal,event_id));
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
        title TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('in_progress','paused','completed','cancelled','failed')),
        summary TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
        knowledge_revision INTEGER NOT NULL, unfinished TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        completed_at INTEGER);
      CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id, updated_at DESC);
      -- Adoption ledger: records exactly which knowledge entries a discovery run
      -- promoted, so one undo can retract precisely that batch and nothing else.
      -- It never references host files; revoking touches only this database.
      CREATE TABLE IF NOT EXISTS adoptions(id TEXT PRIMARY KEY, source_path TEXT NOT NULL,
        kind TEXT NOT NULL, title TEXT NOT NULL, content_hash TEXT NOT NULL,
        knowledge_id TEXT NOT NULL, revision INTEGER NOT NULL, adopted_at INTEGER NOT NULL,
        revoked_at INTEGER);
      CREATE INDEX IF NOT EXISTS adoptions_batch ON adoptions(adopted_at DESC);
      -- Supersession ledger: why a later record replaced or supplemented an
      -- earlier one. Revisions themselves are immutable, so a superseded body is
      -- never destroyed; this table is what makes the chain auditable.
      CREATE TABLE IF NOT EXISTS supersessions(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        old_knowledge_id TEXT NOT NULL, old_revision INTEGER NOT NULL,
        new_knowledge_id TEXT NOT NULL, new_revision INTEGER NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('supersede','supplement')),
        reason TEXT NOT NULL, evidence TEXT NOT NULL,
        origin TEXT NOT NULL CHECK(origin IN ('rescan','agent','user')),
        replaced_local_edit INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS supersessions_new ON supersessions(new_knowledge_id);
      CREATE INDEX IF NOT EXISTS supersessions_old ON supersessions(old_knowledge_id);
      -- Rescan bookkeeping so adapters can decide whether a scan is due.
      INSERT OR IGNORE INTO meta VALUES ('lastRescanAt',0);
      INSERT OR IGNORE INTO meta VALUES ('rescanIntervalMs',86400000);
      INSERT OR IGNORE INTO meta VALUES ('scanRoots','');
    `);
    this.cleanup();
  }
  close() { this.db.close(); }
  get revision(): number { return Number(this.db.prepare("SELECT value FROM meta WHERE key='revision'").get()!.value); }
  private transaction<T>(body: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = body(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private head(id: string): Entry | undefined {
    const row = this.db.prepare(`SELECT k.id,k.head,k.status,r.content FROM knowledge k
      JOIN revisions r ON k.id=r.id AND k.head=r.revision WHERE k.id=?`).get(id);
    return row && this.decode(row);
  }
  private decode(row: Row): Entry {
    return { id: String(row.id), revision: Number(row.head), status: String(row.status), content: knowledgeSchema.parse(JSON.parse(String(row.content))) };
  }
  private current(): Entry[] {
    // Ordered by id so the same library always yields the same sequence. Without
    // it, SQLite returns rows in whatever order the plan produces, which made any
    // caller that takes the first N pick an arbitrary subset — adopted skills
    // appeared in the injected context in a different order run to run, and the
    // entries that happened to come first varied with the build of SQLite.
    return this.db.prepare(`SELECT k.id,k.head,k.status,r.content FROM knowledge k
      JOIN revisions r ON k.id=r.id AND k.head=r.revision WHERE k.status='active'
      ORDER BY k.id`).all().map(row => this.decode(row));
  }
  /** Admin-only offline import. Every update requires the observed per-item revision. */
  import(entries: Knowledge[]): number {
    const validated = entries.map(entry => knowledgeSchema.parse(entry));
    if (new Set(validated.map(x => x.id)).size !== validated.length)
      throw new DomainError('duplicate_id', 'Import contains duplicate IDs');
    return this.transaction(() => this.importInsideTransaction(validated));
  }
  /** Caller must already hold a transaction; shared with proposal approval. */
  private importInsideTransaction(validated: Knowledge[]): number {
    const next = new Map(this.current().map(x => [x.id, x]));
    for (const content of validated) {
      const previous = this.head(content.id);
      if ((previous?.revision ?? 0) !== content.baseRevision)
        throw new DomainError('revision_conflict', `Revision changed: ${content.id}`, 409);
      if (previous && previous.content.kind !== content.kind)
        throw new DomainError('kind_changed', 'Knowledge kind is immutable');
      next.set(content.id, { id: content.id, revision: content.baseRevision + 1, status: 'active', content });
    }
    // Only the newly written workflows must validate; changed children invalidate old parents on read.
    for (const content of validated) if (content.kind === 'workflow') this.validateDependencies(next.get(content.id)!, next, new Set());
    for (const content of validated) {
      const rev = content.baseRevision + 1;
      this.db.prepare(`INSERT INTO knowledge(id,kind,head,status) VALUES(?,?,?,'active')
        ON CONFLICT(id) DO UPDATE SET head=excluded.head,status='active'`).run(content.id, content.kind, rev);
      this.db.prepare('INSERT INTO revisions VALUES(?,?,?,?)').run(content.id, rev, JSON.stringify(content), this.now());
      this.db.prepare('DELETE FROM workflow_search WHERE id=?').run(content.id);
      // Workflows, skills and memories are all searchable. A workflow is indexed
      // whole; a skill is indexed together with its leaves so a search for a leaf
      // topic still finds the entry that owns it.
      if (content.kind !== 'norm') this.db.prepare('INSERT INTO workflow_search VALUES(?,?)').run(content.id, searchable(JSON.stringify(content)));
    }
    this.db.prepare("UPDATE meta SET value=value+1 WHERE key='revision'").run();
    return this.revision;
  }
  private validateDependencies(entry: Entry, all: Map<string, Entry>, ancestors: Set<string>): void {
    if (ancestors.has(entry.id)) throw new DomainError('dependency_cycle', `Workflow dependency cycle at ${entry.id}`, 409);
    if (entry.content.kind !== 'workflow') throw new DomainError('not_workflow', 'A workflow dependency must target a workflow', 409);
    const path = new Set(ancestors).add(entry.id);
    for (const stage of entry.content.stages) for (const dep of stage.dependencies) {
      if (dep.relationship === 'reference') continue;
      const child = all.get(dep.workflowId);
      if (!child || child.status !== 'active' || child.revision !== dep.revision)
        throw new DomainError('dependency_unavailable', `Required dependency ${dep.workflowId}@${dep.revision} is not current`, 409);
      const parentScope = entry.content.scope, childScope = child.content.scope;
      if (childScope.kind === 'project' && (parentScope.kind === 'global' || childScope.projectId !== parentScope.projectId))
        throw new DomainError('dependency_scope', 'Required workflow belongs to an incompatible scope', 409);
      this.validateDependencies(child, all, path);
    }
  }
  retire(id: string, baseRevision: number): void {
    this.transaction(() => {
      const result = this.db.prepare("UPDATE knowledge SET status='retired' WHERE id=? AND head=? AND status='active'").run(id, baseRevision);
      if (!result.changes) throw new DomainError('revision_conflict', 'Current knowledge revision not found', 409);
      this.db.prepare('DELETE FROM workflow_search WHERE id=?').run(id);
      this.db.prepare("UPDATE meta SET value=value+1 WHERE key='revision'").run();
    });
  }
  norms(projectId: string) {
    return this.current().filter(e => e.content.kind === 'norm' && applicable(e.content.scope, projectId)).map(e => ({ ...e.content, revision: e.revision }));
  }
  /**
   * Active entries visible to a project, in full Entry shape.
   *
   * `norms()` flattens an entry's content, which suits internal composition but
   * not callers that need the identity and status alongside it. This keeps the
   * scope filter while preserving the shape those callers already depend on.
   */
  scopedEntries(projectId: string) {
    return this.current().filter(e => applicable(e.content.scope, projectId));
  }
  search(projectId: string, query: string, limit = 8) {
    const entries = this.current(); const all = new Map(entries.map(x => [x.id, x]));
    const tokens = [...new Set(searchable(query).split(' ').filter(Boolean))].slice(0, 40);
    const ids = tokens.length ? this.db.prepare(`SELECT id FROM workflow_search WHERE workflow_search MATCH ? ORDER BY bm25(workflow_search)`).all(tokens.map(t => `"${t}"`).join(' OR ')).map(r => String(r.id)) : entries.map(e => e.id);
    return ids.map(id => all.get(id)).filter((e): e is Entry => !!e && e.content.kind === 'workflow' && applicable(e.content.scope, projectId)).slice(0, limit).map(e => {
      const c = e.content as Workflow;
      let ready = true, unavailable: string | undefined;
      try { this.validateDependencies(e, all, new Set()); } catch (error) { ready = false; unavailable = (error as Error).message; }
      return { id: e.id, revision: e.revision, title: c.title, overview: c.overview,
        preconditions: c.preconditions, stages: c.stages.map(s => ({ id: s.id, title: s.title, checks: s.checks })),
        completion: c.completion, recovery: c.recovery, categories: c.categories, ready, unavailable };
    });
  }
  expand(projectId: string, id: string, stageId: string) {
    const all = new Map(this.current().map(x => [x.id, x])); const entry = all.get(id);
    if (!entry || entry.content.kind !== 'workflow' || !applicable(entry.content.scope, projectId))
      throw new DomainError('not_found', 'Workflow is unavailable', 404);
    this.validateDependencies(entry, all, new Set());
    const stage = entry.content.stages.find(s => s.id === stageId);
    if (!stage) throw new DomainError('not_found', 'Stage is unavailable', 404);
    const expanded = new Set<string>();
    const resolve = (flow: Workflow): unknown[] => flow.stages.flatMap(s => s.dependencies.filter(d => d.relationship !== 'reference').flatMap(d => {
      if (expanded.has(d.workflowId)) return [];
      expanded.add(d.workflowId); const child = all.get(d.workflowId)!;
      return [{ id: child.id, revision: child.revision, workflow: child.content }, ...resolve(child.content as Workflow)];
    }));
    // Includes all required prerequisites of this stage and nested dependencies, never independent fragments.
    const stageFlow = { ...entry.content, stages: [stage] };
    return { workflowId: id, revision: entry.revision, title: entry.content.title, preconditions: entry.content.preconditions,
      stage, completion: entry.content.completion, recovery: entry.content.recovery, dependencies: resolve(stageFlow), ready: true };
  }
  /**
   * Search adopted skills and memories.
   *
   * These are kept out of `search()` because they have no stages or dependency
   * graph: a skill is a stored procedure awaiting structure, and a memory is a
   * background fact. Returning them in the workflow shape would imply structure
   * that has not been verified. `needsStructure` is surfaced so the caller can
   * tell a converted skill from a raw adopted document.
   *
   * Only a bounded excerpt is returned; full text is fetched by `readKnowledge`.
   * Inlining whole documents inflated a real prepare context to 26k-53k
   * characters against a 2k-4k token budget, so retrieval returns entry points
   * and expansion is explicit.
   */
  knowledge(projectId: string, query: string, limit = 5, excerptChars = 400) {
    const entries = this.current();
    const all = new Map(entries.map(x => [x.id, x]));
    const tokens = [...new Set(searchable(query).split(' ').filter(Boolean))].slice(0, 40);
    const candidates = tokens.length
      ? this.db.prepare('SELECT id FROM workflow_search WHERE workflow_search MATCH ? ORDER BY bm25(workflow_search)')
        .all(tokens.map(t => `"${t}"`).join(' OR ')).map(row => String(row.id))
      : entries.map(entry => entry.id);
    const result: Array<{
      id: string; revision: number; kind: 'skill' | 'memory'; title: string;
      excerpt: string; chars: number; leafCount: number; needsStructure: boolean;
    }> = [];
    for (const id of candidates) {
      const entry = all.get(id);
      if (!entry) continue;
      const content = entry.content;
      // Only adopted skills and memories belong here; norms are read through
      // norms() and workflows through search(), each with its own shape.
      if (content.kind !== 'skill' && content.kind !== 'memory') continue;
      if (!applicable(content.scope, projectId)) continue;
      const body = content.body;
      result.push({
        id: entry.id, revision: entry.revision, kind: content.kind, title: content.title,
        excerpt: body.length > excerptChars ? `${body.slice(0, excerptChars)}…` : body,
        chars: body.length,
        leafCount: content.kind === 'skill' ? content.leaves.length : 0,
        needsStructure: content.kind === 'skill' ? content.needsStructure : false,
      });
      if (result.length >= limit) break;
    }
    return result;
  }
  /**
   * Expand one adopted knowledge entry by ID.
   *
   * This is the on-demand step the prepare summary points at. A skill returns
   * its body plus leaves; a leaf body is included only when requested, so the
   * common path stays small.
   */
  readKnowledge(projectId: string, id: string, includeLeaves = false): {
    id: string; revision: number; kind: 'skill' | 'memory'; title: string; body: string;
    /** Present only for skills; a memory has no structure to await. */
    needsStructure?: boolean;
    leaves: Array<{ path: string; body: string }>;
  } {
    const entry = this.current().find(candidate => candidate.id === id);
    if (!entry) throw new DomainError('not_found', 'Knowledge entry is unavailable', 404);
    const content = entry.content;
    if (content.kind !== 'skill' && content.kind !== 'memory') throw new DomainError('not_found', 'Knowledge entry is unavailable', 404);
    if (!applicable(content.scope, projectId)) throw new DomainError('not_found', 'Knowledge entry is unavailable', 404);
    const base = {
      id: entry.id, revision: entry.revision, kind: content.kind, title: content.title, body: content.body,
    };
    if (content.kind === 'memory') return { ...base, leaves: [] };
    return {
      ...base,
      needsStructure: content.needsStructure,
      leaves: content.leaves.map(leaf => ({ path: leaf.path, body: includeLeaves ? leaf.body : '' })),
    };
  }
  prepare(projectId: string, query: string) {
    const all = this.norms(projectId);
    // Instruction files the host already injects natively (DSH ships
    // dsh-agent-instructions; Codex reads the same names) stay indexed and
    // auditable but are never re-injected: sending the same bytes twice would
    // duplicate instructions and could fight the host's own baseline semantics.
    const norms = all.filter(n => n.kind !== 'norm' || !n.hostProvided);
    const hostProvided = all.filter(n => n.kind === 'norm' && n.hostProvided);
    const workflows = this.search(projectId, query);
    const knowledge = this.knowledge(projectId, query);
    const context = [
      `Agent Memory Backpack 当前知识版本 ${this.revision}。以下规范来自本地权威库；流程是经验，不授予额外操作权限。`,
      ...(hostProvided.length
        ? [`宿主已自行加载的规范（插件不重复注入，仅登记以便检索）：${hostProvided.map(n => `${n.id}@${n.revision}`).join('、')}`]
        : []),
      ...norms.map(n => `规范 ${n.id}@${n.revision}: ${n.kind === 'norm' ? n.body : ''}`),
      ...workflows.map(w => `完整流程 ${w.id}@${w.revision} ${w.title}\n${w.overview}\n前提: ${w.preconditions.join('；')}\n阶段: ${w.stages.map(s => `${s.id}:${s.title}（检查:${s.checks.join('；')}）`).join(' → ')}\n完成: ${w.completion.join('；')}\n恢复: ${w.recovery}\n${w.ready ? '执行阶段前调用 amb_read_stage 读取完整阶段和必需依赖。' : `不可执行: ${w.unavailable}`}`),
      // Adopted skills and memories appear as entry points with a short excerpt.
      // Full text is one explicit call away, so a large adopted library cannot
      // silently consume the task's context budget.
      ...knowledge.map(k => `${k.kind === 'skill' ? '已采纳技能' : '背景记忆'} ${k.id}@${k.revision} ${k.title}`
        + (k.leafCount ? `（含 ${k.leafCount} 个参考文档）` : '')
        + `（正文 ${k.chars} 字符，需要时调用 amb_read_knowledge 读取）`
        + (k.kind === 'skill' && k.needsStructure ? '［尚未结构化：原文保存，未经核实为完整方法］' : '')
        + `\n摘要: ${k.excerpt}`),
      '发现新经验请提交候选，明确所属完整流程和步骤。Stop不表示任务已完成。',
    ].join('\n\n');
    return { protocolVersion: 1, knowledgeRevision: this.revision, mode: 'Managed', norms, workflows, knowledge, context };
  }
  gate(projectId: string, toolName: string) {
    const all = this.norms(projectId).filter(n => n.kind === 'norm');
    /**
     * Compare tool names in normalised form.
     *
     * An exact string comparison was trivially bypassable: a norm denying `Bash`
     * did not deny `bash`, `Bash ` or a name differing only in case, so the
     * prohibition looked enforced while the same call went through. Trimming and
     * case-folding closes the accidental forms; the deliberate aliases a host may
     * use (a shell reachable by several names) still need the host's own tool
     * table, which is why the decision stays scoped to names the user listed.
     */
    const normalise = (name: string) => name.trim().toLowerCase();
    const denied = new Set(all.flatMap(n => n.deniedTools.map(normalise)));
    const requested = normalise(toolName);
    // An empty or whitespace-only name cannot be matched meaningfully; it is
    // treated as ungovernable rather than silently allowed.
    const blocked = requested.length > 0 && denied.has(requested);
    return {
      decision: blocked ? 'deny' : 'allow',
      reason: blocked
        ? `当前规范禁止该工具: ${all.filter(n => n.deniedTools.map(normalise).includes(requested)).map(n => n.id).join(', ')}`
        : (requested.length === 0
          ? '工具名为空，无法核对；按未覆盖处理'
          : 'No matching explicit tool prohibition'),
      knowledgeRevision: this.revision,
      context: all.filter(n => !n.hostProvided).map(n => `当前规范 ${n.id}@${n.revision}: ${n.body}`).join('\n'),
    };
  }
  submit(principal: string, payload: { idempotencyKey: string; projectId: string; workflowId?: string; baseRevision?: number; discovery: string }) {
    if (payload.workflowId) {
      const entry = this.head(payload.workflowId);
      if (!entry || entry.status !== 'active' || entry.content.kind !== 'workflow' || !applicable(entry.content.scope, payload.projectId)) throw new DomainError('not_found', 'Target workflow is unavailable', 404);
      if (payload.baseRevision !== undefined && entry.revision !== payload.baseRevision)
        throw new DomainError('revision_conflict', `Expected baseRevision ${payload.baseRevision} but current is ${entry.revision}`, 409);
    }
    return this.transaction(() => {
      const fingerprint = digest(payload); const previous = this.db.prepare('SELECT id,fingerprint,state FROM proposals WHERE principal=? AND idem=?').get(principal, payload.idempotencyKey);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new DomainError('idempotency_conflict', 'Same idempotency key has different content', 409);
        return { id: previous.id, state: previous.state, duplicate: true };
      }
      const id = randomUUID();
      this.db.prepare('INSERT INTO proposals VALUES(?,?,?,?,?,?,?,?)').run(id, principal, payload.idempotencyKey, fingerprint, JSON.stringify(payload), 'pending', this.now(), this.now() + 30 * DAY);
      return { id, state: 'pending', duplicate: false };
    });
  }
  event(principal: string, payload: { eventId: string; [key: string]: unknown }) {
    return this.transaction(() => {
      const fingerprint = digest(payload); const old = this.db.prepare('SELECT id,fingerprint FROM events WHERE principal=? AND event_id=?').get(principal, payload.eventId);
      if (old) {
        if (old.fingerprint !== fingerprint) throw new DomainError('idempotency_conflict', 'Event key already has different content', 409);
        return { id: old.id, stored: true, duplicate: true };
      }
      const id = randomUUID();
      this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(id, principal, payload.eventId, fingerprint, JSON.stringify(payload), this.now(), this.now() + 30 * DAY);
      return { id, stored: true, duplicate: false };
    });
  }
  /**
   * List proposals for one project.
   *
   * Filtered by the project recorded in the proposal payload. An unfiltered list
   * meant one project's reviewer could read another project's candidates — the
   * same class of leak found in `/v1/norms`.
   */
  listProposals(projectId: string, state?: string) {
    let query = 'SELECT id,principal,idem,payload,state,created_at,expires_at FROM proposals WHERE 1=1';
    const params: string[] = [];
    // A proposal always records its project, so the filter is authoritative.
    query += " AND json_extract(payload, '$.projectId') = ?";
    params.push(projectId);
    if (state) {
      query += ' AND state=?';
      params.push(state);
    }
    query += ' ORDER BY created_at DESC';
    return this.db.prepare(query).all(...params).map(row => ({
      id: String(row.id),
      principal: String(row.principal),
      payload: row.payload ? JSON.parse(String(row.payload)) : null,
      state: String(row.state),
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
    }));
  }
  allEntries() { return this.current(); }
  /**
   * Promote a reviewed proposal.
   *
   * Promotion is never derived from the discovery text: a reviewer supplies the
   * full structured entry, and its own baseRevision still passes the import CAS.
   * The proposal state change and the new revision commit in one transaction.
   *
   * Two guards exist because the reviewer's entry was previously unconstrained:
   *
   *  - the entry cannot be wider than the proposal that triggered it. A proposal
   *    carries a project, so writing a `global` entry from it would silently make
   *    one project's insight apply to every project. That is the escalation the
   *    plan reserves for an explicit user decision, so it needs the caller to say
   *    so via `allowGlobalScope`.
   *  - when the proposal named a target workflow, the entry must be that entry.
   *    Otherwise an unrelated entry could be approved under its cover.
   */
  approveProposal(id: string, entry: Knowledge, options: { allowGlobalScope?: boolean } = {}): number {
    const validated = knowledgeSchema.parse(entry);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT state,payload FROM proposals WHERE id=?').get(id) as
        { state: string; payload: string } | undefined;
      if (!row || row.state !== 'pending') throw new DomainError('not_found', 'Proposal not found or not pending', 404);

      const payload = JSON.parse(row.payload || '{}') as { projectId?: string; workflowId?: string };
      const proposalProject = payload.projectId;
      const scope = validated.scope;

      if (proposalProject) {
        if (scope.kind === 'global') {
          // Only a *widening* to global needs an explicit decision. Revising an
          // entry that was already global is not an escalation, and demanding the
          // flag there would block ordinary revision work.
          const existing = this.head(validated.id);
          const wasGlobal = existing?.content.scope.kind === 'global';
          if (!wasGlobal && options.allowGlobalScope !== true) {
            throw new DomainError('scope_denied',
              'This proposal is project-scoped; promoting the entry to global would apply one project\'s knowledge everywhere. Pass allowGlobalScope to do that deliberately.', 403);
          }
        } else if (scope.projectId !== proposalProject) {
          throw new DomainError('scope_denied',
            'The approved entry is scoped to a different project than its proposal', 403);
        }
        if (payload.workflowId && validated.id !== payload.workflowId) {
          throw new DomainError('target_mismatch',
            `The proposal targets ${payload.workflowId} but the entry is ${validated.id}`, 409);
        }
      }

      const revision = this.importInsideTransaction([validated]);
      this.db.prepare("UPDATE proposals SET state='approved' WHERE id=?").run(id);
      return revision;
    });
  }
  rejectProposal(id: string): void {
    this.transaction(() => {
      const result = this.db.prepare("UPDATE proposals SET state='rejected' WHERE id=? AND state='pending'").run(id);
      if (!result.changes) throw new DomainError('not_found', 'Proposal not found or not pending', 404);
    });
  }
  /**
   * Task identity is a stable ID the caller owns; a task may span sessions and a
   * session may hold several tasks. Re-recording an existing ID only refreshes
   * state, so a retry never creates a duplicate diary entry.
   */
  recordTask(projectId: string, payload: { id: string; title: string; status: TaskStatus; summary?: string; notes?: string; unfinished?: string[] }) {
    return this.transaction(() => {
      // Scoped by project: an unscoped lookup let one project's credential
      // overwrite another project's task merely by reusing its id.
      const existing = this.db.prepare('SELECT id,status,project_id FROM tasks WHERE id=?').get(payload.id) as
        { id: string; status: string; project_id: string } | undefined;
      if (existing && existing.project_id !== projectId) {
        throw new DomainError('scope_denied', `Task ${payload.id} belongs to another project`, 403);
      }
      const now = this.now();
      const unfinished = JSON.stringify(payload.unfinished ?? []);
      if (existing) {
        // A task never silently moves out of a terminal state: a new status must come from an explicit call.
        this.db.prepare(`UPDATE tasks SET title=?,status=?,summary=?,notes=?,unfinished=?,knowledge_revision=?,updated_at=?,
          completed_at=CASE WHEN ? IN ('completed','cancelled','failed') THEN COALESCE(completed_at,?) ELSE NULL END
          WHERE id=? AND project_id=?`)
          .run(payload.title, payload.status, payload.summary ?? '', payload.notes ?? '', unfinished, this.revision, now,
            payload.status, now, payload.id, projectId);
        return { id: payload.id, status: payload.status, created: false };
      }
      this.db.prepare(`INSERT INTO tasks(id,project_id,title,status,summary,notes,knowledge_revision,unfinished,created_at,updated_at,completed_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(payload.id, projectId, payload.title, payload.status,
          payload.summary ?? '', payload.notes ?? '', this.revision, unfinished, now, now,
          ['completed', 'cancelled', 'failed'].includes(payload.status) ? now : null);
      return { id: payload.id, status: payload.status, created: true };
    });
  }
  tasks(projectId: string, status?: TaskStatus) {
    const query = status
      ? 'SELECT * FROM tasks WHERE project_id=? AND status=? ORDER BY updated_at DESC'
      : 'SELECT * FROM tasks WHERE project_id=? ORDER BY updated_at DESC';
    const rows = status ? this.db.prepare(query).all(projectId, status) : this.db.prepare(query).all(projectId);
    return rows.map(row => ({
      id: String(row.id), projectId: String(row.project_id), title: String(row.title),
      status: String(row.status) as TaskStatus, summary: String(row.summary), notes: String(row.notes),
      knowledgeRevision: Number(row.knowledge_revision),
      unfinished: JSON.parse(String(row.unfinished)) as string[],
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
      completedAt: row.completed_at === null ? null : Number(row.completed_at),
    }));
  }
  getTask(id: string, projectId: string) { return this.tasks(projectId).find(task => task.id === id); }
  /** Handoff carries what the other end needs and never implies process or credential transfer. */
  handoff(id: string, projectId: string) {
    const task = this.tasks(projectId).find(t => t.id === id);
    if (!task) throw new DomainError('not_found', 'Task is unavailable', 404);
    return {
      task, knowledgeRevision: this.revision,
      norms: this.norms(projectId),
      workflows: this.search(projectId, task.title).map(w => ({ id: w.id, revision: w.revision, title: w.title, ready: w.ready })),
      caveat: '接收端需重新确认文件与环境状态；本交接不迁移运行中的进程、凭据或工具权限。',
    };
  }
  /**
   * Promote a batch of discovered knowledge in one transaction.
   *
   * Each adopted entry keeps its source path and content hash in the ledger, so
   * the batch can be revoked precisely later. Adoption never touches the source
   * file: only this database changes.
   */
  adopt(entries: Array<{ source: { path: string; hash: string }; kind: string; title: string; knowledge: Knowledge }>): { adoptedAt: number; knowledgeRevision: number; count: number; skipped: Array<{ id: string; reason: string }> } {
    if (entries.length === 0) throw new DomainError('empty_batch', 'Adoption requires at least one entry', 400);
    const adoptedAt = this.now();
    return this.transaction(() => {
      /**
       * Decide per entry whether this is a repeat, a restore, or a first import.
       *
       * Adoption imports from an external source, so the caller cannot know the
       * internal revision. Two situations had been conflated:
       *
       *  - the same source content is already active: a repeat, skipped rather
       *    than failing the batch (one duplicate must not kill the whole import);
       *  - the entry exists but is retired: the user revoked it and is re-adopting,
       *    which restores it as a new revision. This used to fail with "Revision
       *    changed", leaving a command that reported it would adopt an entry and
       *    then refused to.
       */
      const skipped: Array<{ id: string; reason: string }> = [];
      const aligned: typeof entries = [];
      const ledger = this.adoptions();
      for (const entry of entries) {
        const existing = this.head(entry.knowledge.id);
        if (existing && existing.status === 'active') {
          const prior = ledger.find(record => record.sourcePath === entry.source.path);
          if (prior && prior.contentHash === entry.source.hash) {
            skipped.push({ id: entry.knowledge.id, reason: 'same source content is already active' });
            continue;
          }
        }
        const baseRevision = existing ? existing.revision : 0;
        aligned.push({ ...entry, knowledge: knowledgeSchema.parse({ ...entry.knowledge, baseRevision }) });
      }
      if (aligned.length === 0) {
        return { adoptedAt, knowledgeRevision: this.revision, count: 0, skipped };
      }
      // importInsideTransaction performs the CAS and dependency checks; the
      // caller must already hold a transaction, so nothing is half-written.
      const knowledgeRevision = this.importInsideTransaction(aligned.map(entry => entry.knowledge));
      for (const entry of aligned) {
        const revision = entry.knowledge.baseRevision + 1;
        // The ledger is append-only, so the row id includes the batch time: the
        // same source adopted twice (a revoke followed by a re-adopt) is two real
        // events and must not collide on a content-derived key.
        this.db.prepare(`INSERT INTO adoptions(id,source_path,kind,title,content_hash,knowledge_id,revision,adopted_at,revoked_at)
          VALUES(?,?,?,?,?,?,?,?,NULL)`).run(
          `adopt:${adoptedAt}:${entry.source.hash.slice(0, 16)}:${entry.knowledge.id}`, entry.source.path, entry.kind,
          entry.title, entry.source.hash, entry.knowledge.id, revision, adoptedAt);
      }
      return { adoptedAt, knowledgeRevision, count: aligned.length, skipped };
    });
  }
  /**
   * Refresh an already-adopted source whose file content changed.
   *
   * Newest wins: the incoming text becomes the active revision and the previous
   * one is retired with an auditable reason, but nothing is destroyed — every
   * revision stays in `revisions`, and the supersession row records which version
   * replaced which, on what basis, and whether a local edit was overwritten.
   *
   * A human edit made inside the plugin is preserved as history and explicitly
   * flagged, so "latest wins" never means "silently discard the user's work".
   */
  refreshAdoption(input: {
    sourcePath: string; kind: string; title: string;
    source: { hash: string }; knowledge: Knowledge;
    reason?: string; evidence?: string; origin?: 'rescan' | 'agent' | 'user';
  }): { knowledgeId: string; knowledgeRevision: number; knowledgeBaseRevision?: number; action: 'refreshed' | 'unchanged'; replacedLocalEdit: boolean } {
    const validated = knowledgeSchema.parse(input.knowledge);
    const record = this.adoptions()
      .find(candidate => candidate.sourcePath === input.sourcePath);
    if (!record) throw new DomainError('not_adopted', `Source was never adopted: ${input.sourcePath}`, 404);
    if (record.contentHash === input.source.hash) {
      return { knowledgeId: record.knowledgeId, knowledgeRevision: this.revision, action: 'unchanged', replacedLocalEdit: false };
    }
    const adoptedAt = this.now();
    return this.transaction(() => {
      const head = this.head(record.knowledgeId);
      if (!head) throw new DomainError('not_found', 'Adopted entry is unavailable', 404);
      // A retired entry must not be silently revived by a source refresh: it may
      // have been superseded or deliberately withdrawn, and bringing it back as
      // current would undo that decision without review.
      if (head.status !== 'active') {
        throw new DomainError('not_active', `Adopted entry ${record.knowledgeId} is ${head.status}; refusing to revive it by refresh`, 409);
      }
      // A revision beyond the one this batch created means someone edited it here.
      const replacedLocalEdit = head.revision !== record.revision;
      const kindChanged = head.content.kind !== validated.kind;
      if (kindChanged) throw new DomainError('kind_changed', 'A refresh must keep the adopted knowledge kind', 409);

      const incoming: Knowledge = { ...validated, id: head.content.id, baseRevision: head.revision } as Knowledge;
      const knowledgeRevision = this.importInsideTransaction([incoming]);

      this.db.prepare(`INSERT INTO supersessions(old_knowledge_id,old_revision,new_knowledge_id,new_revision,action,reason,evidence,origin,replaced_local_edit,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(record.knowledgeId, head.revision, record.knowledgeId, head.revision + 1,
          'supersede', input.reason ?? '来源内容已更新，以最新记录为准',
          input.evidence ?? `source:${input.sourcePath}@${input.source.hash}`,
          input.origin ?? 'rescan', replacedLocalEdit ? 1 : 0, adoptedAt);

      // The ledger row is superseded rather than updated, so a batch revoke can
      // still be reasoned about after a refresh.
      this.db.prepare('UPDATE adoptions SET revoked_at=? WHERE id=?').run(adoptedAt, record.id);
      this.db.prepare(`INSERT INTO adoptions(id,source_path,kind,title,content_hash,knowledge_id,revision,adopted_at,revoked_at)
        VALUES(?,?,?,?,?,?,?,?,NULL)`).run(
        `adopt:${adoptedAt}:${input.source.hash.slice(0, 16)}:${record.knowledgeId}`, input.sourcePath, input.kind,
        input.title, input.source.hash, record.knowledgeId, head.revision + 1, adoptedAt);
      return { knowledgeId: record.knowledgeId, knowledgeRevision, action: 'refreshed' as const, replacedLocalEdit };
    });
  }
  /**
   * Turn an adopted skill document into a real workflow.
   *
   * The caller supplies the authored structure: triggers, preconditions, ordered
   * stages, checks, completion and recovery. Nothing is derived from the
   * Markdown here, because a program cannot reliably read ordered steps and
   * completion criteria out of prose, and inventing them would present a
   * fabrication as a verified method.
   *
   * What this function guarantees instead is the bookkeeping: the source skill
   * must exist and be active, its revision is recorded on the new workflow, the
   * skill is retired in the same transaction, and the supersession ledger links
   * the two so the conversion stays traceable.
   */
  structureSkill(input: {
    skillId: string;
    workflow: Workflow;
    derivedBy: 'user' | 'agent';
    evidence: string;
    /** Scope the caller acts within; the skill and the new workflow must be visible to it. */
    projectId?: string;
  }): { workflowId: string; knowledgeRevision: number; retiredSkillRevision: number } {
    const evidence = input.evidence.trim().slice(0, 2000);
    if (!evidence) throw new DomainError('missing_evidence', 'Structuring a skill must cite what the structure is based on', 400);
    // Validate the authored structure on its own first. Assembling a placeholder
    // derivedFrom before the target is known would surface a schema complaint
    // about the placeholder instead of the real problem (unknown target, wrong
    // kind, already retired), which misleads the caller.
    const authored = workflowSchema.parse({ ...(input.workflow as Workflow & { derivedFrom?: unknown }), derivedFrom: undefined });
    return this.transaction(() => {
      const skill = this.head(input.skillId);
      if (!skill) throw new DomainError('not_found', `Skill ${input.skillId} is unavailable`, 404);
      if (skill.content.kind !== 'skill') throw new DomainError('not_skill', 'Only an adopted skill can be structured into a workflow', 409);
      if (skill.status !== 'active') throw new DomainError('not_active', `Skill ${input.skillId} is ${skill.status}`, 409);
      // The skill must belong to the caller's scope; otherwise one project could
      // convert and retire another project's knowledge.
      if (input.projectId && skill.content.scope.kind !== 'global'
        && skill.content.scope.projectId !== input.projectId) {
        throw new DomainError('not_found', `Skill ${input.skillId} is unavailable`, 404);
      }
      if (authored.id === input.skillId) throw new DomainError('id_conflict', 'The workflow needs its own id, distinct from the skill', 400);

      const existing = this.head(authored.id);
      if (existing && existing.content.kind !== 'workflow') throw new DomainError('kind_changed', 'A workflow id must not replace another kind', 409);
      const withSource = workflowSchema.parse({
        ...authored,
        baseRevision: existing?.revision ?? 0,
        derivedFrom: { skillId: input.skillId, skillRevision: skill.revision, derivedBy: input.derivedBy, evidence },
      });
      const knowledgeRevision = this.importInsideTransaction([withSource]);

      // Retire the raw skill in the same transaction: the workflow now carries
      // the method, and leaving both active would offer the same procedure twice
      // in two different shapes.
      const retired = this.db.prepare("UPDATE knowledge SET status='retired' WHERE id=? AND head=? AND status='active'")
        .run(input.skillId, skill.revision);
      if (retired.changes) this.db.prepare('DELETE FROM workflow_search WHERE id=?').run(input.skillId);

      const newRevision = (existing?.revision ?? 0) + 1;
      this.db.prepare(`INSERT INTO supersessions(old_knowledge_id,old_revision,new_knowledge_id,new_revision,action,reason,evidence,origin,replaced_local_edit,created_at)
        VALUES(?,?,?,?,?,?,?,?,0,?)`).run(input.skillId, skill.revision, authored.id, newRevision,
          'supersede', '技能已结构化为完整流程', evidence, input.derivedBy, this.now());
      this.db.prepare("UPDATE meta SET value=value+1 WHERE key='revision'").run();
      return { workflowId: authored.id, knowledgeRevision, retiredSkillRevision: skill.revision };
    });
  }
  /** Adopted skills still awaiting structure, newest first. */
  unstructuredSkills(limit = 50) {
    return this.current()
      .filter(entry => entry.content.kind === 'skill' && entry.content.needsStructure)
      .slice(0, limit)
      .map(entry => {
        const content = entry.content as Extract<Knowledge, { kind: 'skill' }>;
        return {
          id: entry.id, revision: entry.revision, title: content.title,
          leafCount: content.leaves.length, bodyChars: content.body.length,
          leafPaths: content.leaves.map(leaf => leaf.path),
        };
      });
  }
  /**
   * Ids of entries that exist but are retired.
   *
   * Lets a caller tell "this is new" from "this is being restored": after a revoke
   * the entry is still present with its history, so re-adopting it is a restore
   * and should be reported as one rather than as a fresh import.
   */
  retiredIds(): Set<string> {
    return new Set(this.db.prepare("SELECT id FROM knowledge WHERE status='retired'").all()
      .map(row => String(row.id)));
  }
  /** Adoption ledger, newest first. Reads only; never touches source files. */
  adoptions(includeRevoked = false) {
    const rows = includeRevoked
      ? this.db.prepare('SELECT * FROM adoptions ORDER BY adopted_at DESC, knowledge_id').all()
      : this.db.prepare('SELECT * FROM adoptions WHERE revoked_at IS NULL ORDER BY adopted_at DESC, knowledge_id').all();
    return rows.map(row => ({
      id: String(row.id), sourcePath: String(row.source_path), kind: String(row.kind),
      title: String(row.title), contentHash: String(row.content_hash),
      knowledgeId: String(row.knowledge_id), revision: Number(row.revision),
      adoptedAt: Number(row.adopted_at), revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    }));
  }
  /**
   * Revoke an adoption batch.
   *
   * Only entries whose current revision is still the one this batch created are
   * retired: if the user has since edited an adopted entry, that work is
   * preserved rather than silently discarded, and it is reported as skipped.
   * Source files are never touched.
   */
  revokeAdoption(adoptedAt: number): { retired: string[]; skipped: Array<{ knowledgeId: string; reason: string }> } {
    const batch = this.adoptions(true).filter(record => record.adoptedAt === adoptedAt && record.revokedAt === null);
    if (batch.length === 0) throw new DomainError('not_found', 'No active adoption batch with that timestamp', 404);
    return this.transaction(() => {
      const retired: string[] = [];
      const skipped: Array<{ knowledgeId: string; reason: string }> = [];
      const now = this.now();
      for (const record of batch) {
        const head = this.head(record.knowledgeId);
        if (!head || head.status !== 'active') {
          skipped.push({ knowledgeId: record.knowledgeId, reason: 'no longer active' });
        } else if (head.revision !== record.revision) {
          skipped.push({ knowledgeId: record.knowledgeId, reason: `edited since adoption (now revision ${head.revision}); preserved` });
        } else {
          this.db.prepare("UPDATE knowledge SET status='retired' WHERE id=? AND head=? AND status='active'").run(record.knowledgeId, record.revision);
          this.db.prepare('DELETE FROM workflow_search WHERE id=?').run(record.knowledgeId);
          retired.push(record.knowledgeId);
        }
        this.db.prepare('UPDATE adoptions SET revoked_at=? WHERE id=?').run(now, record.id);
      }
      if (retired.length) this.db.prepare("UPDATE meta SET value=value+1 WHERE key='revision'").run();
      return { retired, skipped };
    });
  }
  cleanup() {
    this.db.prepare("UPDATE proposals SET state='expired',payload='{}' WHERE expires_at<=? AND state='pending'").run(this.now());
    this.db.prepare('DELETE FROM events WHERE expires_at<=?').run(this.now());
  }
  /** Rescan cadence bookkeeping, read by adapters on session start. */
  rescanState() {
    return {
      lastRescanAt: Number(this.db.prepare("SELECT value FROM meta WHERE key='lastRescanAt'").get()!.value),
      intervalMs: Number(this.db.prepare("SELECT value FROM meta WHERE key='rescanIntervalMs'").get()!.value),
    };
  }
  markRescanned(at = this.now()) {
    this.db.prepare("UPDATE meta SET value=? WHERE key='lastRescanAt'").run(at);
    return this.rescanState();
  }
  setRescanInterval(ms: number) {
    if (!Number.isSafeInteger(ms) || ms < 60_000) throw new DomainError('invalid_interval', 'Rescan interval must be at least one minute', 400);
    this.db.prepare("UPDATE meta SET value=? WHERE key='rescanIntervalMs'").run(ms);
    return this.rescanState();
  }
  /** Roots a periodic rescan should walk; empty means "use the default roots". */
  scanRoots(): string[] {
    const raw = String(this.db.prepare("SELECT value FROM meta WHERE key='scanRoots'").get()!.value);
    return raw ? raw.split('\n').map(line => line.trim()).filter(Boolean) : [];
  }
  setScanRoots(roots: string[]) {
    this.db.prepare("UPDATE meta SET value=? WHERE key='scanRoots'").run(roots.map(root => root.trim()).filter(Boolean).join('\n'));
    return this.scanRoots();
  }
  /** True when the configured cadence has elapsed since the last scan. */
  rescanDue(at = this.now()): boolean {
    const { lastRescanAt, intervalMs } = this.rescanState();
    return at - lastRescanAt >= intervalMs;
  }
  /**
   * Record that one entry supersedes or supplements another.
   *
   * "Latest wins" is a precedence rule, not a delete: the earlier revision stays
   * in `revisions` forever, and this row is the only thing that says it was
   * replaced and on what basis. Both the replacement and the retirement happen in
   * one transaction so the library is never left half-switched.
   */
  supersede(input: {
    oldId: string; newId: string; action: 'supersede' | 'supplement';
    reason: string; evidence: string; origin: 'rescan' | 'agent' | 'user';
    /** Scope the caller is acting within; both entries must be visible to it. */
    projectId?: string;
  }): { oldRevision: number; newRevision: number; historyPreserved: true } {
    const reason = input.reason.trim().slice(0, 500);
    const evidence = input.evidence.trim().slice(0, 2000);
    if (!reason) throw new DomainError('missing_reason', 'A supersession must state why', 400);
    if (!evidence) throw new DomainError('missing_evidence', 'A supersession must cite evidence', 400);
    if (input.oldId === input.newId) throw new DomainError('self_supersession', 'An entry cannot supersede itself', 400);
    return this.transaction(() => {
      const oldEntry = this.head(input.oldId);
      const newEntry = this.head(input.newId);
      if (!oldEntry) throw new DomainError('not_found', `Superseded entry ${input.oldId} is unavailable`, 404);
      if (!newEntry) throw new DomainError('not_found', `Replacement entry ${input.newId} is unavailable`, 404);
      if (oldEntry.content.kind !== newEntry.content.kind)
        throw new DomainError('kind_changed', 'A replacement must keep the same knowledge kind', 409);
      // Both entries must be visible to the caller's scope. Without this a
      // credential for one project could retire another project's knowledge
      // merely by naming its id.
      if (input.projectId) {
        const visible = (entry: Entry) => entry.content.scope.kind === 'global'
          || entry.content.scope.projectId === input.projectId;
        if (!visible(oldEntry)) throw new DomainError('not_found', `Superseded entry ${input.oldId} is unavailable`, 404);
        if (!visible(newEntry)) throw new DomainError('not_found', `Replacement entry ${input.newId} is unavailable`, 404);
      }

      // Only a 'supersede' retires the earlier entry; a 'supplement' adds
      // alongside it, because a complement is not a contradiction.
      if (input.action === 'supersede') {
        const result = this.db.prepare("UPDATE knowledge SET status='retired' WHERE id=? AND head=? AND status='active'")
          .run(input.oldId, oldEntry.revision);
        if (!result.changes) throw new DomainError('not_active', `Superseded entry ${input.oldId} is not active`, 409);
        this.db.prepare('DELETE FROM workflow_search WHERE id=?').run(input.oldId);
      }
      this.db.prepare(`INSERT INTO supersessions(old_knowledge_id,old_revision,new_knowledge_id,new_revision,action,reason,evidence,origin,replaced_local_edit,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(input.oldId, oldEntry.revision, input.newId, newEntry.revision,
          input.action, reason, evidence, input.origin, 0, this.now());
      if (input.action === 'supersede') this.db.prepare("UPDATE meta SET value=value+1 WHERE key='revision'").run();
      return {
        action: input.action,
        oldRevision: oldEntry.revision, newRevision: newEntry.revision,
        historyPreserved: true as const,
      };
    });
  }
  /** Supersession ledger, newest first. Reads only. */
  supersessions(forId?: string) {
    const rows = forId
      ? this.db.prepare('SELECT * FROM supersessions WHERE old_knowledge_id=? OR new_knowledge_id=? ORDER BY created_at DESC, id DESC').all(forId, forId)
      : this.db.prepare('SELECT * FROM supersessions ORDER BY created_at DESC, id DESC').all();
    return rows.map(row => ({
      id: Number(row.id),
      oldKnowledgeId: String(row.old_knowledge_id), oldRevision: Number(row.old_revision),
      newKnowledgeId: String(row.new_knowledge_id), newRevision: Number(row.new_revision),
      action: String(row.action) as 'supersede' | 'supplement',
      reason: String(row.reason), evidence: String(row.evidence),
      origin: String(row.origin) as 'rescan' | 'agent' | 'user',
      replacedLocalEdit: Number(row.replaced_local_edit) === 1,
      createdAt: Number(row.created_at),
    }));
  }
  /**
   * Full lineage of one knowledge id: every supersession it took part in.
   *
   * Lets a reader answer "why is this the current version, and what did it
   * replace" without exposing retired bodies in normal retrieval.
   */
  history(id: string) {
    const entry = this.head(id) ?? this.decodeAny(id);
    const revisions = this.db.prepare('SELECT revision,created_at FROM revisions WHERE id=? ORDER BY revision').all(id)
      .map(row => ({ revision: Number(row.revision), createdAt: Number(row.created_at) }));
    const chain = this.supersessions(id);
    // An unknown id is reported as missing rather than as an empty lineage: a
    // 200 with no revisions would read as "this entry exists but has no history",
    // which is a different and misleading statement.
    if (!entry && revisions.length === 0 && chain.length === 0) {
      throw new DomainError('not_found', `Knowledge entry ${id} is unavailable`, 404);
    }
    return {
      id,
      current: entry ? { revision: entry.revision, status: entry.status, kind: entry.content.kind, title: entry.content.title } : null,
      // Every immutable revision stays readable, retired or not.
      revisions,
      chain,
    };
  }
  /** Head lookup that also sees retired entries, for history display only. */
  private decodeAny(id: string): Entry | undefined {
    const row = this.db.prepare(`SELECT k.id,k.head,k.status,r.content FROM knowledge k
      JOIN revisions r ON k.id=r.id AND k.head=r.revision WHERE k.id=?`).get(id);
    return row && this.decode(row);
  }
  stats() {
    this.cleanup();
    return { knowledgeRevision: this.revision, entries: this.current().length,
      pendingProposals: Number(this.db.prepare("SELECT count(*) AS n FROM proposals WHERE state='pending'").get()!.n),
      events: Number(this.db.prepare('SELECT count(*) AS n FROM events').get()!.n),
      tasks: Number(this.db.prepare('SELECT count(*) AS n FROM tasks').get()!.n),
      adoptions: Number(this.db.prepare('SELECT count(*) AS n FROM adoptions WHERE revoked_at IS NULL').get()!.n),
      supersessions: Number(this.db.prepare('SELECT count(*) AS n FROM supersessions').get()!.n),
      lastRescanAt: Number(this.db.prepare("SELECT value FROM meta WHERE key='lastRescanAt'").get()!.value) };
  }
}
