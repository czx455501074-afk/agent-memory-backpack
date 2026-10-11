import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { DomainError, knowledgeSchema, workflowSchema, type Knowledge, type KnowledgeDraft, type WorkflowDraft, type Workflow, type Scope } from './schema.js';
import { MATERIAL_TTL_DAYS, isLive, materialEntry, renew, type MaterialInput } from './material.js';

type Row = Record<string, unknown>;
type Entry = { id: string; revision: number; status: string; content: Knowledge };
export type TaskStatus = 'in_progress' | 'paused' | 'completed' | 'cancelled' | 'failed';
const DAY = 86400000;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/**
 * Whether a scope applies to the caller's project and task.
 *
 * A task-scoped entry applies only to that task, and to nothing when the caller
 * has no task in hand. That is the whole point of the scope: "这一次用 Banana"
 * must not become a rule for every later task, and the only way to guarantee that
 * is to make it inapplicable when the task is unknown rather than when it differs.
 */
const applicable = (scope: Scope, projectId: string, taskId?: string): boolean => {
  if (scope.kind === 'global') return true;
  if (scope.projectId !== projectId) return false;
  if (scope.kind === 'task') return taskId !== undefined && scope.taskId === taskId;
  return true;
};
function searchable(value: string): string {
  // Unicode words plus CJK bigrams: deterministic Chinese recall without an external model.
  const words = value.toLowerCase().match(/[a-z0-9_-]+|[\p{Script=Han}]+/gu) ?? [];
  return words.flatMap(word => /\p{Script=Han}/u.test(word)
    ? (word.length === 1 ? [word] : Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)))
    : [word]).join(' ');
}

/**
 * Query tokens, most specific first.
 *
 * A CJK bigram is a fragment, not a word: `重启` is produced by both "重启" and
 * "已重启", and it occurs inside unrelated prose often enough that matching on
 * any fragment alone returns a page of noise. Longer tokens are therefore listed
 * first so the caller can prefer the most specific match it can satisfy.
 */
function queryTokens(query: string): string[] {
  return [...new Set(searchable(query).split(' ').filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .slice(0, 40);
}

/**
 * Ids matching a query, ranked by how much of the query they cover.
 *
 * Two wrong answers came before this one, and both are kept in the record because
 * the same mistake is easy to make twice:
 *
 *   - Joining every token with OR accepted a single shared fragment. Measured on a
 *     real library, "已重启" matched 22 entries and "导出数据" matched 48, most of
 *     them unrelated, and those entries were then injected into the conversation.
 *   - Requiring every token (AND) is worse, because CJK bigrams *overlap*:
 *     "修复核心自动启动" yields 修复/复核/核心/心自/自动/动启/启动, and no document
 *     contains all seven. Long queries matched nothing at all.
 *
 * Coverage is therefore measured, not required — and it is measured by asking
 * FTS5, one query per fragment. Counting matches against the stored text directly
 * does not work: the index holds the tokenizer's output, not the original string,
 * so a check like `text.includes(fragment)` scores every row zero and silently
 * empties the result set.
 *
 * A third case was investigated and deliberately not "fixed": conversational
 * filler ("继续", "好的") still matches. Filtering by how common a fragment is was
 * tried and reverted, because the measurement says it cannot work here — on a real
 * library "短剧" occurs in 27.8% of documents and "这个" in 29.6%, so a frequency
 * threshold that removes the filler also removes the domain vocabulary. Silently
 * dropping a user's core subject is worse than returning a loose match, and the
 * coverage ranking above already puts the best candidates first. Left as a known
 * limitation rather than a guess dressed up as a fix.
 */
/**
 * One match, with the reason it matched.
 *
 * The reason is carried out of the matcher rather than recomputed by callers: the
 * design requires every retrieved item to be able to say *why it was retrieved*, and
 * a second implementation of that answer would eventually disagree with the one
 * that actually selected the row.
 */
interface Match { id: string; coverage: number; matched: string[] }

function matchAll(db: DatabaseSync, tokens: string[], floor = 0.5): Match[] {
  if (!tokens.length) return [];
  const hitsFor = (token: string): Set<string> => {
    try {
      return new Set(db.prepare('SELECT id FROM workflow_search WHERE workflow_search MATCH ?')
        .all(`"${token}"`).map(row => String((row as { id: string }).id)));
    } catch { return new Set(); }
  };

  const perToken = tokens.map(hitsFor);
  // Rows that match at least one fragment, in the order the widest query returned
  // them. bm25 already orders that by relevance, which breaks coverage ties.
  const ranked = db.prepare('SELECT id FROM workflow_search WHERE workflow_search MATCH ? ORDER BY bm25(workflow_search)')
    .all(tokens.map(token => `"${token}"`).join(' OR ')).map(row => String((row as { id: string }).id));

  const matchedFor = (id: string) => tokens.filter((_token, index) => perToken[index]!.has(id));

  // A single fragment carries no coverage signal: whether it appears is the only
  // question, its commonness has already been judged, and bm25 ordered the answer.
  if (tokens.length === 1) return ranked.map(id => ({ id, coverage: 1, matched: matchedFor(id) }));

  const covered = new Map<string, number>();
  for (const id of ranked) {
    let count = 0;
    for (const hits of perToken) if (hits.has(id)) count += 1;
    covered.set(id, count / tokens.length);
  }
  /**
   * The floor is relative to the best row, with no absolute minimum.
   *
   * An absolute floor of one half was tried and removed: a query of several
   * fragments where only one is real — "导出设备", where "设备" appears in nothing —
   * scored the correct entry at one third and discarded it. The user asked about
   * exporting, and got silence because they added a word the library does not know.
   * Anchoring to the best row instead means the strongest available matches come
   * back and the weaker ones are pruned relative to them, which is what ranking is
   * for. The single genuine risk — a common fragment matching widely — is
   * constrained by `limit`, and by the fact that coverage ordering puts rows
   * matching more of the query first.
   */
  const best = Math.max(...covered.values());
  const threshold = best * floor;
  return ranked.filter(id => (covered.get(id) ?? 0) >= threshold)
    .sort((a, b) => (covered.get(b) ?? 0) - (covered.get(a) ?? 0))
    .map(id => ({ id, coverage: covered.get(id) ?? 0, matched: matchedFor(id) }));
}

/** Just the ids, for callers that do not report a reason. */
function matchIds(db: DatabaseSync, tokens: string[], floor = 0.5): string[] {
  return matchAll(db, tokens, floor).map(match => match.id);
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
        -- The owning project is its own column rather than being read out of the
        -- payload. The payload is cleared when a rejected proposal's retention
        -- lapses, and a scope filter that depended on it made the record vanish from
        -- its own project exactly when the design says it should remain readable as
        -- a record of what was proposed.
        project_id TEXT NOT NULL DEFAULT '',
        UNIQUE(principal,idem));
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, principal TEXT NOT NULL,
        event_id TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, UNIQUE(principal,event_id));
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
        title TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('in_progress','paused','completed','cancelled','failed')),
        summary TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
        knowledge_revision INTEGER NOT NULL, unfinished TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        -- Added when the task record grew to the design's field list. Declared here
        -- so a fresh database has them, and added by migration below so an existing
        -- one does too: a column that only exists on new installs is a bug that
        -- surfaces months later on the one machine that matters.
        session_ids TEXT NOT NULL DEFAULT '[]',
        related_experiences TEXT NOT NULL DEFAULT '[]',
        related_proposals TEXT NOT NULL DEFAULT '[]',
        files TEXT NOT NULL DEFAULT '[]',
        verified TEXT NOT NULL DEFAULT '',
        started_at INTEGER);
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
    this.migrate();
    this.cleanup();
  }
  /**
   * Bring an existing database up to the current column set.
   *
   * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so a
   * column added after the first release reaches new installs only. Reading the
   * table's actual columns and adding what is missing is what keeps an existing
   * library working — the alternative is a migration that silently applies to
   * everyone except the users who already had data.
   *
   * Additive only: a column is never dropped or rewritten here, because the data in
   * it is the user's and this code cannot know what a later version expects.
   */
  private migrate(): void {
    const additions: Array<[string, string]> = [
      ['tasks', 'session_ids TEXT NOT NULL DEFAULT \'[]\''],
      ['tasks', 'related_experiences TEXT NOT NULL DEFAULT \'[]\''],
      ['tasks', 'related_proposals TEXT NOT NULL DEFAULT \'[]\''],
      ['tasks', 'files TEXT NOT NULL DEFAULT \'[]\''],
      ['tasks', 'verified TEXT NOT NULL DEFAULT \'\''],
      ['tasks', 'started_at INTEGER'],
      ['proposals', 'project_id TEXT NOT NULL DEFAULT \'\''],
    ];
    for (const [table, definition] of additions) {
      const column = definition.split(' ')[0]!;
      const existing = this.db.prepare(`PRAGMA table_info(${table})`).all().map(row => String((row as { name: string }).name));
      if (existing.includes(column)) continue;
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    }
    // Backfill from the payload for rows written before the column existed. A row
    // whose payload was already cleared cannot be attributed and is left empty
    // rather than guessed at; it stays reachable by id.
    this.db.exec(`UPDATE proposals SET project_id = COALESCE(json_extract(payload, '$.projectId'), '')
      WHERE project_id = '' AND payload <> '{}'`);
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
  import(entries: KnowledgeDraft[]): number {
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
    const tokens = queryTokens(query);
    // With no query this lists every workflow. That is what a browsing caller
    // wants — the console's workflow panel shows the catalog before anything is
    // typed. Injection is a different question, and `prepare()` decides it: an
    // empty query there means there is no basis for selection, so nothing is
    // injected rather than an arbitrary slice.
    const matches = tokens.length ? matchAll(this.db, tokens) : [];
    const ids = tokens.length ? matches.map(match => match.id) : entries.map(e => e.id);
    const reasonFor = new Map(matches.map(match => [match.id, match]));
    return ids.map(id => all.get(id)).filter((e): e is Entry => !!e && e.content.kind === 'workflow' && applicable(e.content.scope, projectId)).slice(0, limit).map(e => {
      const c = e.content as Workflow;
      let ready = true, unavailable: string | undefined;
      try { this.validateDependencies(e, all, new Set()); } catch (error) { ready = false; unavailable = (error as Error).message; }
      return { id: e.id, revision: e.revision, title: c.title, overview: c.overview,
        preconditions: c.preconditions, stages: c.stages.map(s => ({ id: s.id, title: s.title, checks: s.checks })),
        completion: c.completion, recovery: c.recovery, categories: c.categories, ready, unavailable,
        // Same reason as `knowledge()`: an entry must be able to say why it appeared.
        why: reasonFor.has(e.id) ? { matched: reasonFor.get(e.id)!.matched, coverage: reasonFor.get(e.id)!.coverage } : null };
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
    const tokens = queryTokens(query);
    // With no query, list the catalog in a stable order — a browsing caller (the
    // console, or a user asking what is in the library) wants exactly that.
    //
    // Injection is decided elsewhere: `prepare()` skips this call entirely when
    // the query is empty, because an arbitrary slice of the library appearing in
    // every session is how an unrelated project opened with five media skills.
    const matches = tokens.length ? matchAll(this.db, tokens) : [];
    const ids = tokens.length ? matches.map(match => match.id) : entries.map(entry => entry.id);
    const reasonFor = new Map(matches.map(match => [match.id, match]));
    const result: Array<{
      id: string; revision: number; kind: 'skill' | 'memory' | 'preference' | 'journal';
      title: string; excerpt: string; chars: number; leafCount: number; needsStructure: boolean;
      /** Set for preferences, so a reader can tell a stated habit from an inferred one. */
      stated?: boolean;
      /** Set for journals, so success, failure and unverified stay distinguishable. */
      outcome?: 'success' | 'failure' | 'unverified';
      provenance: string;
      /** Why this entry was retrieved: which query fragments matched, and how much. */
      why: { matched: string[]; coverage: number } | null;
    }> = [];
    for (const id of ids) {
      const entry = all.get(id);
      if (!entry) continue;
      const content = entry.content;
      // Norms are read through `norms()` and workflows through `search()`, each
      // with its own shape. Temporary material is deliberately absent: it is only
      // valid until it expires, and its lifecycle is handled separately.
      //
      // Narrowed by kind rather than by an `includes` check, because only this form
      // tells the type system which fields exist — a journal has no `body`, it has
      // what the task did.
      if (content.kind !== 'skill' && content.kind !== 'memory'
        && content.kind !== 'preference' && content.kind !== 'journal') continue;
      if (!applicable(content.scope, projectId)) continue;
      const body = content.kind === 'journal' ? content.did : content.body;
      result.push({
        id: entry.id, revision: entry.revision, kind: content.kind, title: content.title,
        excerpt: body.length > excerptChars ? `${body.slice(0, excerptChars)}…` : body,
        chars: body.length,
        leafCount: content.kind === 'skill' ? content.leaves.length : 0,
        needsStructure: content.kind === 'skill' ? content.needsStructure : false,
        stated: content.kind === 'preference' ? content.stated : undefined,
        outcome: content.kind === 'journal' ? content.outcome : undefined,
        provenance: content.provenance,
        // The design requires each retrieved entry to be able to say why it was
        // retrieved. `null` when the caller asked for the catalog rather than
        // searched, which is an honest answer: nothing selected it.
        why: reasonFor.has(id) ? { matched: reasonFor.get(id)!.matched, coverage: reasonFor.get(id)!.coverage } : null,
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
    // No query means no basis for selection, so nothing is injected. Both helpers
    // fall back to listing the whole catalog, which is right for a caller that
    // asked to browse and wrong here: an arbitrary slice appearing in every
    // session is how a project unrelated to any of them opened with five media
    // skills. Norms are unaffected — they are the standing rules and apply
    // whether or not anything was asked.
    const hasQuery = queryTokens(query).length > 0;
    const retrievalTokens = queryTokens(query);
    const workflows = hasQuery ? this.search(projectId, query) : [];
    const knowledge = hasQuery ? this.knowledge(projectId, query) : [];
    /**
     * The record of what this retrieval did, and what it could not find.
     *
     * The design requires the knowledge version, the retrieval reason and the known
     * gaps to be recorded so a missed recall can be investigated afterwards. Without
     * it the only available explanation for "it did not find that" is a guess, and
     * the query that found nothing leaves no trace at all — which is exactly the case
     * worth investigating, since a term matching nothing may mean missing coverage
     * rather than an unanswerable question.
     *
     * A gap is a query fragment that matched no entry. It is reported as a possible
     * coverage gap, not asserted as one: a term can legitimately be absent because
     * the library has no such knowledge, or because nothing needed adopting.
     */
    const matchedTokens = new Set<string>();
    for (const item of [...workflows, ...knowledge]) for (const token of item.why?.matched ?? []) matchedTokens.add(token);
    const retrieval = {
      query,
      tokens: retrievalTokens,
      matchedTokens: [...matchedTokens],
      gaps: retrievalTokens.filter(token => !matchedTokens.has(token)),
      selected: [
        ...workflows.map(w => ({ id: w.id, kind: 'workflow' as const, why: w.why })),
        ...knowledge.map(k => ({ id: k.id, kind: k.kind, why: k.why })),
      ],
      note: '这是本次检索的理由与未命中片段，供日后排查漏检；未命中不等于库中一定该有。',
    };
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
    return { protocolVersion: 1, knowledgeRevision: this.revision, mode: 'Managed', norms, workflows, knowledge, context, retrieval };
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
      // The effective prohibition list, so an adapter can keep enforcing policy
      // while the core is down. Not a new disclosure: the norm bodies above are
      // already sent, and the deny list is a field inside them.
      deniedTools: [...denied],
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
      this.db.prepare('INSERT INTO proposals(id,principal,idem,fingerprint,payload,state,created_at,expires_at,project_id) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, principal, payload.idempotencyKey, fingerprint, JSON.stringify(payload), 'pending', this.now(), this.now() + 30 * DAY, payload.projectId);
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
    // The scope filter reads the dedicated column, not the payload. Reading the
    // payload meant a row whose payload had been cleared vanished from its own
    // project's list — the opposite of keeping it as a readable record.
    query += ' AND project_id = ?';
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
  approveProposal(id: string, entry: KnowledgeDraft, options: { allowGlobalScope?: boolean } = {}): number {
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
  /**
   * Reject a proposal, keeping it readable for ninety days.
   *
   * The design gives a rejected proposal a retention period rather than keeping the
   * text forever. The state stays afterwards, so the fact that something was
   * proposed and refused survives; only the content lapses. That distinction matters
   * for an audit: "a claim was made and rejected on this date" remains true and
   * checkable long after the claim's text has been cleared.
   */
  rejectProposal(id: string): void {
    this.transaction(() => {
      const result = this.db.prepare("UPDATE proposals SET state='rejected', expires_at=? WHERE id=? AND state='pending'")
        .run(this.now() + 90 * DAY, id);
      if (!result.changes) throw new DomainError('not_found', 'Proposal not found or not pending', 404);
    });
  }
  /**
   * Mark a proposal as needing more evidence.
   *
   * The design requires this fourth outcome beside approve and reject. It exists
   * because the honest answer to a plausible but unsupported claim is neither: the
   * claim may be true, so rejecting it loses information, and approving it would
   * record an unverified statement as knowledge. The deadline comes from the design
   * (thirty days), after which the proposal is archived rather than silently living
   * on in the queue.
   */
  requestEvidence(id: string, reason: string): { state: string; dueAt: number } {
    const text = reason.trim();
    if (!text) throw new DomainError('invalid_request', 'A request for evidence must say what is missing', 400);
    return this.transaction(() => {
      const dueAt = this.now() + 30 * DAY;
      // The reason is stored in the payload so a later reader can see what was asked
      // for; without it the item comes back with no explanation of why it was held.
      const row = this.db.prepare('SELECT payload FROM proposals WHERE id=?').get(id) as { payload: string } | undefined;
      if (!row) throw new DomainError('not_found', 'Proposal is unavailable', 404);
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(row.payload) as Record<string, unknown>; } catch { /* keep empty */ }
      payload.evidenceRequest = { reason: text.slice(0, 500), requestedAt: this.now(), dueAt };
      const result = this.db.prepare("UPDATE proposals SET state='needs_evidence', expires_at=?, payload=? WHERE id=? AND state='pending'")
        .run(dueAt, JSON.stringify(payload), id);
      if (!result.changes) throw new DomainError('not_found', 'Proposal not found or not pending', 404);
      return { state: 'needs_evidence', dueAt };
    });
  }
  /**
   * Apply one decision to many proposals.
   *
   * The design asks for batch operations so a user is not interrupted per candidate.
   * Each proposal is handled on its own so one failure cannot strand the rest, and
   * the outcome is reported per id rather than as a single count — a batch that says
   * "5 approved" while two were refused for a stale base revision teaches the user
   * nothing about which two.
   */
  reviewBatch(projectId: string, input: {
    action: 'approve' | 'reject' | 'archive' | 'request-evidence';
    ids: string[];
    /** Required for approve: the reviewer-supplied entry for each id. */
    entries?: Record<string, KnowledgeDraft>;
    /** Required for request-evidence. */
    reason?: string;
    allowGlobalScope?: boolean;
  }): { applied: string[]; failed: Array<{ id: string; message: string }> } {
    const applied: string[] = [];
    const failed: Array<{ id: string; message: string }> = [];
    for (const id of input.ids) {
      try {
        // Every id is checked against the project before anything is written: a batch
        // is exactly where an id from another project would otherwise slip through,
        // since the caller supplies them as a list. Read from the column so a cleared
        // payload cannot make a foreign row look unattributable and slip past.
        const row = this.db.prepare('SELECT project_id FROM proposals WHERE id=?').get(id) as { project_id: string } | undefined;
        if (!row) throw new DomainError('not_found', 'Proposal is unavailable', 404);
        if (row.project_id !== projectId) throw new DomainError('scope_denied', `Proposal ${id} belongs to another project`, 403);

        if (input.action === 'reject') this.rejectProposal(id);
        else if (input.action === 'archive') this.archiveProposal(id);
        else if (input.action === 'request-evidence') this.requestEvidence(id, input.reason ?? '');
        else {
          const entry = input.entries?.[id];
          if (!entry) throw new DomainError('invalid_request', `No entry supplied for ${id}`, 400);
          this.approveProposal(id, entry, { allowGlobalScope: input.allowGlobalScope });
        }
        applied.push(id);
      } catch (error) {
        failed.push({ id, message: error instanceof Error ? error.message : 'failed' });
      }
    }
    return { applied, failed };
  }
  /**
   * Take a proposal out of the queue without deciding it.
   *
   * Distinct from rejecting: the claim is not judged false, it is set aside so the
   * queue reflects what someone intends to act on. The row is kept, because the
   * design requires rejected and archived items to remain readable rather than
   * disappearing when they leave the working list.
   */
  archiveProposal(id: string): void {
    this.transaction(() => {
      const result = this.db.prepare("UPDATE proposals SET state='archived' WHERE id=? AND state IN ('pending','needs_evidence')").run(id);
      if (!result.changes) throw new DomainError('not_found', 'Proposal not found or not reviewable', 404);
    });
  }
  /**
   * Expire proposals whose deadline has passed.
   *
   * Two deadlines with different meanings, which is why they are handled together
   * here rather than as one sweep:
   *
   *   - a pending proposal that was never reviewed lapses after its window;
   *   - a needs_evidence proposal is archived when the request goes unanswered,
   *     which is what the design means by a thirty-day automatic archive.
   *
   * Neither is deleted. The design requires the record to survive so a later reader
   * can see what was proposed and that it was never resolved.
   */
  expireProposals(): { expired: string[]; archived: string[]; clearedRejected: string[] } {
    const now = this.now();
    return this.transaction(() => {
      const expired = this.db.prepare("SELECT id FROM proposals WHERE state='pending' AND expires_at<=?")
        .all(now).map(row => String((row as { id: string }).id));
      this.db.prepare("UPDATE proposals SET state='expired', payload='{}' WHERE state='pending' AND expires_at<=?").run(now);
      const archived = this.db.prepare("SELECT id FROM proposals WHERE state='needs_evidence' AND expires_at<=?")
        .all(now).map(row => String((row as { id: string }).id));
      this.db.prepare("UPDATE proposals SET state='archived' WHERE state='needs_evidence' AND expires_at<=?").run(now);
      // A rejected proposal's text lapses after its ninety days; the state remains,
      // so the record still says a claim was made and refused.
      const clearedRejected = this.db.prepare("SELECT id FROM proposals WHERE state='rejected' AND expires_at<=? AND payload<>'{}'")
        .all(now).map(row => String((row as { id: string }).id));
      this.db.prepare("UPDATE proposals SET payload='{}' WHERE state='rejected' AND expires_at<=?").run(now);
      return { expired, archived, clearedRejected };
    });
  }
  /**
   * Task identity is a stable ID the caller owns; a task may span sessions and a
   * session may hold several tasks. Re-recording an existing ID only refreshes
   * state, so a retry never creates a duplicate diary entry.
   */
  /**
   * Record or update a task.
   *
   * Fields are merged rather than replaced when a call omits them: a call that only
   * updates the status must not erase the links an earlier call established. The
   * previous version overwrote every column with the caller's defaults, so a status
   * ping silently dropped the notes and unfinished list.
   */
  recordTask(projectId: string, payload: {
    id: string; title: string; status: TaskStatus;
    summary?: string; notes?: string; unfinished?: string[];
    sessionIds?: string[]; relatedExperiences?: string[]; relatedProposals?: string[];
    files?: string[]; verified?: string; startedAt?: number;
  }) {
    return this.transaction(() => {
      // Scoped by project: an unscoped lookup let one project's credential
      // overwrite another project's task merely by reusing its id.
      const existing = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(payload.id) as Row | undefined;
      if (existing && String(existing.project_id) !== projectId) {
        throw new DomainError('scope_denied', `Task ${payload.id} belongs to another project`, 403);
      }
      const now = this.now();
      // An explicit value wins; otherwise keep what is stored; otherwise start empty.
      const keep = <T>(given: T | undefined, column: string, parse: (raw: string) => T, fallback: T): T => {
        if (given !== undefined) return given;
        if (existing) return parse(String(existing[column]));
        return fallback;
      };
      const jsonList = (raw: string) => { try { return JSON.parse(raw) as string[]; } catch { return []; } };
      const sessionIds = keep(payload.sessionIds, 'session_ids', jsonList, []);
      const relatedExperiences = keep(payload.relatedExperiences, 'related_experiences', jsonList, []);
      const relatedProposals = keep(payload.relatedProposals, 'related_proposals', jsonList, []);
      const files = keep(payload.files, 'files', jsonList, []);
      const verified = keep(payload.verified, 'verified', (raw) => raw, '');
      const startedAt = payload.startedAt ?? (existing ? (existing.started_at === null ? undefined : Number(existing.started_at)) : now);
      const terminal = ['completed', 'cancelled', 'failed'].includes(payload.status);

      if (existing) {
        // A task never silently moves out of a terminal state: a new status must come from an explicit call.
        this.db.prepare(`UPDATE tasks SET title=?,status=?,summary=?,notes=?,unfinished=?,session_ids=?,
          related_experiences=?,related_proposals=?,files=?,verified=?,started_at=?,
          knowledge_revision=?,updated_at=?,
          completed_at=CASE WHEN ? IN ('completed','cancelled','failed') THEN COALESCE(completed_at,?) ELSE NULL END
          WHERE id=? AND project_id=?`)
          .run(payload.title, payload.status,
            keep(payload.summary, 'summary', (raw) => raw, ''), keep(payload.notes, 'notes', (raw) => raw, ''),
            JSON.stringify(keep(payload.unfinished, 'unfinished', jsonList, [])),
            JSON.stringify(sessionIds), JSON.stringify(relatedExperiences), JSON.stringify(relatedProposals),
            JSON.stringify(files), verified, startedAt ?? now,
            this.revision, now, payload.status, now, payload.id, projectId);
        return { id: payload.id, status: payload.status, created: false };
      }
      this.db.prepare(`INSERT INTO tasks(id,project_id,title,status,summary,notes,knowledge_revision,
        unfinished,session_ids,related_experiences,related_proposals,files,verified,started_at,
        created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(payload.id, projectId, payload.title, payload.status,
          payload.summary ?? '', payload.notes ?? '', this.revision,
          JSON.stringify(payload.unfinished ?? []), JSON.stringify(sessionIds),
          JSON.stringify(relatedExperiences), JSON.stringify(relatedProposals), JSON.stringify(files),
          verified, startedAt ?? now, now, now, terminal ? now : null);
      return { id: payload.id, status: payload.status, created: true };
    });
  }
  tasks(projectId: string, status?: TaskStatus) {
    const query = status
      ? 'SELECT * FROM tasks WHERE project_id=? AND status=? ORDER BY updated_at DESC'
      : 'SELECT * FROM tasks WHERE project_id=? ORDER BY updated_at DESC';
    const rows = status ? this.db.prepare(query).all(projectId, status) : this.db.prepare(query).all(projectId);
    const list = (raw: unknown) => { try { return JSON.parse(String(raw)) as string[]; } catch { return []; } };
    return rows.map(row => ({
      id: String(row.id), projectId: String(row.project_id), title: String(row.title),
      status: String(row.status) as TaskStatus, summary: String(row.summary), notes: String(row.notes),
      knowledgeRevision: Number(row.knowledge_revision),
      unfinished: list(row.unfinished),
      sessionIds: list(row.session_ids), relatedExperiences: list(row.related_experiences),
      relatedProposals: list(row.related_proposals), files: list(row.files),
      verified: String(row.verified ?? ''),
      startedAt: row.started_at === null || row.started_at === undefined ? null : Number(row.started_at),
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
      completedAt: row.completed_at === null ? null : Number(row.completed_at),
    }));
  }
  getTask(id: string, projectId: string) { return this.tasks(projectId).find(task => task.id === id); }
  /**
   * Find the active task a session is working on.
   *
   * The design requires a task to be associable across sessions, and forbids using a
   * window title as the identity. Looking the session up in `session_ids` is what
   * makes "one task, several sessions" work: a later session sees the task a former
   * one started rather than opening a new one each time.
   */
  taskForSession(projectId: string, sessionId: string) {
    return this.tasks(projectId).find(task =>
      task.sessionIds.includes(sessionId)
      && (task.status === 'in_progress' || task.status === 'paused'));
  }
  /**
   * Associate a session with a task, creating the task if this is its first session.
   *
   * Called when a session begins work. Without it the design's automatic recording
   * has nothing to record against: every session would start a fresh task and the
   * cross-session link would never exist.
   */
  startTaskForSession(projectId: string, sessionId: string, title: string) {
    const existing = this.taskForSession(projectId, sessionId);
    if (existing) {
      if (!existing.sessionIds.includes(sessionId)) {
        this.recordTask(projectId, {
          id: existing.id, title: existing.title, status: existing.status,
          sessionIds: [...existing.sessionIds, sessionId],
        });
      }
      return { id: existing.id, created: false };
    }
    // A session with no task gets one, named from the session so the diary has a
    // subject rather than an opaque id.
    const id = `task-${createHash('sha256').update(`${projectId}\n${sessionId}`).digest('hex').slice(0, 16)}`;
    const prior = this.getTask(id, projectId);
    if (prior) {
      this.recordTask(projectId, {
        id, title: prior.title, status: 'in_progress',
        sessionIds: [...new Set([...prior.sessionIds, sessionId])],
      });
      return { id, created: false };
    }
    this.recordTask(projectId, {
      id, title: title.slice(0, 200) || '未命名任务', status: 'in_progress',
      sessionIds: [sessionId], startedAt: this.now(),
    });
    return { id, created: true };
  }
  /**
   * Generate the diary for a task.
   *
   * Built from what the task actually recorded — its own facts and its event
   * stream — not from a model's summary of the conversation. The design requires
   * the diary to be "based on facts" and to distinguish success, failure and
   * unverified; a generated narrative would blur exactly those distinctions.
   */
  generateJournal(taskId: string, projectId: string) {
    const task = this.getTask(taskId, projectId);
    if (!task) throw new DomainError('not_found', 'Task is unavailable', 404);
    const events = this.db.prepare('SELECT payload, created_at FROM events ORDER BY created_at').all()
      .map(row => { try { return JSON.parse(String(row.payload)) as { taskId?: string; kind?: string; summary?: string }; } catch { return {}; } })
      .filter(payload => payload.taskId === taskId);
    const stops = events.filter(event => event.kind === 'turn_stopped').length;
    const did = task.summary
      || `任务「${task.title}」共记录 ${events.length} 个事件${stops ? `，其中 ${stops} 次中断` : ''}。`;
    const outcome: 'success' | 'failure' | 'unverified' =
      task.status === 'completed' ? (task.verified ? 'success' : 'unverified')
      : task.status === 'failed' ? 'failure'
      : 'unverified';
    return {
      id: `journal-${task.id}`,
      kind: 'journal' as const,
      title: `任务日记：${task.title}`.slice(0, 200),
      scope: { kind: 'project' as const, projectId },
      baseRevision: 0,
      labels: [] as string[],
      // The plugin wrote this from its own records, so `agent` provenance is the
      // accurate label: it is not something the user said, and calling it theirs
      // would lend the diary an authority it does not have.
      provenance: 'agent' as const,
      evidence: 'observed' as const,
      platforms: [] as Array<'dsh' | 'codex'>,
      taskId: task.id,
      did: did.slice(0, 2000),
      problems: task.notes.slice(0, 2000),
      experienceLanded: task.relatedExperiences,
      outcome,
      unfinished: task.unfinished,
    };
  }
  /** Record the journal as knowledge, so it survives the task record. */
  writeJournal(taskId: string, projectId: string) {
    const journal = this.generateJournal(taskId, projectId);
    const existing = this.current().find(entry => entry.content.kind === 'journal'
      && (entry.content as { taskId?: string }).taskId === taskId);
    const withRevision = existing
      ? { ...journal, baseRevision: existing.revision }
      : journal;
    const revision = this.import([withRevision]);
    return { journalId: journal.id, revision, replaced: Boolean(existing), outcome: journal.outcome };
  }
  /**
   * Handoff carries what the other end needs and never implies process or credential transfer.
   *
   * The design lists goal, constraints, decisions, progress, unfinished work, file
   * references, verification results, the knowledge version and a suggested next
   * step. `files` is included because the design requires the receiving end to
   * re-check the environment — naming the files is what makes that check possible,
   * and the caveat states that the check has not been performed here.
   */
  handoff(id: string, projectId: string) {
    const task = this.tasks(projectId).find(t => t.id === id);
    if (!task) throw new DomainError('not_found', 'Task is unavailable', 404);
    // The next step is derived from what the task itself left open, not invented.
    const nextStep = task.unfinished.length
      ? `继续处理未完成项：${task.unfinished[0]}`
      : task.status === 'completed'
        ? '任务已完成；如需延展，请从相关经验或流程入口重新开始。'
        : '任务仍在进行中；先核对下面的文件与环境状态，再继续。';
    return {
      task, knowledgeRevision: this.revision,
      norms: this.norms(projectId),
      workflows: this.search(projectId, task.title).map(w => ({ id: w.id, revision: w.revision, title: w.title, ready: w.ready })),
      /** Files the receiving end must re-check; naming them is the point. */
      files: task.files,
      /** What was verified, and whether anything was verified at all. */
      verification: { verified: task.verified || null, taskStatus: task.status },
      suggestion: nextStep,
      caveat: '接收端需重新确认文件与环境状态；本交接不迁移运行中的进程、凭据或工具权限。'
        + ' 上面的 files 只是需要核对的清单，不代表已经核对过。',
    };
  }
  /**
   * Export a task as readable Markdown, and as the full record for backup.
   *
   * Two shapes for two purposes, as the design specifies: the Markdown is for a
   * person reading what happened, the JSON is for moving the data. The Markdown
   * deliberately states the outcome rather than implying it — an unverified task
   * must not read like a successful one.
   */
  exportTask(id: string, projectId: string) {
    const task = this.tasks(projectId).find(t => t.id === id);
    if (!task) throw new DomainError('not_found', 'Task is unavailable', 404);
    const events = this.db.prepare('SELECT payload, created_at FROM events ORDER BY created_at').all()
      .map(row => {
        let payload: Record<string, unknown> = {};
        try { payload = JSON.parse(String(row.payload)) as Record<string, unknown>; } catch { /* torn row */ }
        return { created_at: Number(row.created_at), taskId: payload.taskId, kind: payload.kind, summary: payload.summary };
      })
      .filter(event => event.taskId === id);
    const stamp = (value: number | null) => value === null ? '—' : new Date(value).toISOString().replace('T', ' ').slice(0, 16);
    const outcomeLabel = { success: '完成（有验证依据）', failure: '失败', unverified: '未验证' } as const;
    const outcome = task.status === 'completed' ? (task.verified ? 'success' : 'unverified')
      : task.status === 'failed' ? 'failure' : 'unverified';

    const markdown = [
      `# 任务记录：${task.title}`, '',
      `**任务 ID**：${task.id}  `,
      `**项目**：${projectId}  `,
      `**时间**：${stamp(task.startedAt ?? task.createdAt)} ~ ${stamp(task.completedAt)}  `,
      `**状态**：${outcomeLabel[outcome]}（${task.status}）  `,
      `**知识版本**：${task.knowledgeRevision}`, '',
      '## 摘要', task.summary || '（无）', '',
      '## 进展',
      ...(events.length
        ? events.map(event => `- ${stamp(event.created_at)} ${String(event.kind ?? '事件')}${event.summary ? `：${String(event.summary)}` : ''}`)
        : ['- （无事件记录）']), '',
      '## 关联知识',
      ...(task.relatedExperiences.length ? task.relatedExperiences.map(id => `- 经验：${id}`) : ['- 经验：（无）']),
      ...(task.relatedProposals.length ? task.relatedProposals.map(id => `- 提案：${id}`) : ['- 提案：（无）']), '',
      '## 验证',
      task.verified ? task.verified : '未提供验证依据（按未验证记录）', '',
      '## 未解决项',
      ...(task.unfinished.length ? task.unfinished.map(item => `- [ ] ${item}`) : ['- （无）']), '',
      '## 需要核对的文件',
      ...(task.files.length ? task.files.map(file => `- ${file}`) : ['- （无）']), '',
      '## 备注', task.notes || '（无）', '',
      '---', '',
      // Stated in the document itself, because the file outlives the session that
      // produced it and a reader has no other way to know.
      '> 本记录由任务的事实数据生成，不是行为指令。日记正文与临时资料采用不同的保留策略。',
    ].join('\n');

    return {
      task,
      markdown,
      json: { task, events, exportedAt: this.now(), knowledgeRevision: this.revision },
    };
  }
  /**
   * Promote a batch of discovered knowledge in one transaction.
   *
   * Each adopted entry keeps its source path and content hash in the ledger, so
   * the batch can be revoked precisely later. Adoption never touches the source
   * file: only this database changes.
   */
  adopt(entries: Array<{ source: { path: string; hash: string }; kind: string; title: string; knowledge: KnowledgeDraft }>): { adoptedAt: number; knowledgeRevision: number; count: number; skipped: Array<{ id: string; reason: string }> } {
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
      const knowledgeRevision = this.importInsideTransaction(aligned.map(entry => knowledgeSchema.parse(entry.knowledge)));
      for (const entry of aligned) {
        // Parsed above, so the defaulted fields are present; read back through the
        // same schema rather than trusting the draft's optional one.
        const revision = knowledgeSchema.parse(entry.knowledge).baseRevision + 1;
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
    /** A draft: the store parses it, so a caller need not restate defaulted fields. */
    workflow: WorkflowDraft;
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
  /**
   * Remove what has lapsed. Called on every request and on a timer.
   *
   * Two of the three removals are ordinary housekeeping. The third is the design's
   * second layer for temporary material: bodies, summaries and index rows are
   * deleted once the expiry passes. The first layer — refusing to *return* expired
   * material — lives in `liveMaterial()` and runs on every read, so a lapsed item
   * cannot be served even while this job is failing or has never run.
   *
   * The removal is per item rather than in bulk so one failure cannot strand the
   * rest, and each is recorded: a cleanup that silently did nothing is
   * indistinguishable from one that had nothing to do.
   */
  cleanup() {
    // Proposal deadlines are handled by `expireProposals`, which distinguishes a
    // lapsed pending item from an unanswered evidence request; both keep their rows.
    this.expireProposals();
    this.db.prepare('DELETE FROM events WHERE expires_at<=?').run(this.now());
    this.purgeExpiredMaterial();
  }
  /**
   * Purge lapsed temporary material, returning what was removed.
   *
   * Separated from `cleanup()` so a caller can retry it alone, and so a test can
   * assert the purge without waiting for the other housekeeping. Each item is
   * retired through the normal revision path, which keeps the fact that it existed
   * in history while removing it from every live surface.
   */
  purgeExpiredMaterial(): { purged: string[]; failed: Array<{ id: string; message: string }> } {
    const now = this.now();
    const purged: string[] = [];
    const failed: Array<{ id: string; message: string }> = [];
    for (const entry of this.current()) {
      const content = entry.content;
      if (content.kind !== 'material') continue;
      if (isLive(content.expiresAt, now)) continue;
      try {
        this.retire(entry.id, entry.revision);
        purged.push(entry.id);
      } catch (error) {
        // Collected, not thrown: one item that will not retire must not stop the
        // pass, and the caller needs to know which ones to retry.
        failed.push({ id: entry.id, message: error instanceof Error ? error.message : 'purge failed' });
      }
    }
    return { purged, failed };
  }
  /**
   * Save temporary material, recognising a repeat of the same page.
   *
   * A duplicate is skipped rather than stored twice, and — importantly — skipping
   * does **not** extend the original's expiry. The design is explicit that saving
   * the same page again is not a decision to keep it longer.
   */
  saveMaterial(input: MaterialInput): { id: string; duplicate: boolean; expiresAt: number } {
    const now = this.now();
    const entry = materialEntry(input, now);
    const existing = this.current().find(candidate =>
      candidate.content.kind === 'material' && candidate.content.fingerprint === entry.fingerprint);
    if (existing) {
      return { id: existing.id, duplicate: true, expiresAt: (existing.content as { expiresAt: number }).expiresAt };
    }
    this.import([entry]);
    return { id: entry.id, duplicate: false, expiresAt: entry.expiresAt };
  }
  /**
   * Renew material deliberately, with a reason.
   *
   * The design requires the reason: reading must not extend a lifetime, so the one
   * path that does has to record why. A lapsed item can be renewed (a user may
   * decide a page is worth keeping after all) but an already-purged one cannot,
   * because its body is gone — claiming otherwise would return an empty page.
   */
  renewMaterial(id: string, reason: string): { expiresAt: number; renewalReason: string } {
    const entry = this.current().find(candidate => candidate.id === id);
    if (!entry || entry.content.kind !== 'material') throw new DomainError('not_found', 'Material is unavailable', 404);
    const content = entry.content;
    const renewed = renew({ expiresAt: content.expiresAt, savedAt: content.savedAt }, reason, this.now());
    this.import([{ ...content, baseRevision: entry.revision, ...renewed }]);
    return { expiresAt: renewed.expiresAt, renewalReason: renewed.renewalReason };
  }
  /** Live material only, newest first. Expired items are never returned. */
  liveMaterial(limit = 50) {
    const now = this.now();
    return this.current()
      .filter(entry => entry.content.kind === 'material' && isLive(entry.content.expiresAt, now))
      .sort((a, b) => (b.content as { savedAt: number }).savedAt - (a.content as { savedAt: number }).savedAt)
      .slice(0, limit)
      .map(entry => {
        const content = entry.content as Extract<Knowledge, { kind: 'material' }>;
        return {
          id: entry.id, revision: entry.revision, title: content.title, url: content.url,
          summary: content.summary, savedAt: content.savedAt, expiresAt: content.expiresAt,
          taskId: content.taskId ?? null, provenance: content.provenance,
          renewalReason: content.renewalReason ?? null,
        };
      });
  }
  /** Counts for the management interface, so retention is visible rather than implied. */
  materialStats() {
    const now = this.now();
    const all = this.current().filter(entry => entry.content.kind === 'material');
    const live = all.filter(entry => isLive((entry.content as { expiresAt: number }).expiresAt, now));
    return {
      live: live.length, expired: all.length - live.length, total: all.length,
      ttlDays: MATERIAL_TTL_DAYS,
      nextExpiry: live.length
        ? Math.min(...live.map(entry => (entry.content as { expiresAt: number }).expiresAt))
        : null,
    };
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
