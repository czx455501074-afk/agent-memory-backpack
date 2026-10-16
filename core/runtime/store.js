import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { DomainError, knowledgeSchema, proposalSchema, workflowSchema } from './schema.js';
import { reviewDecision } from './policy.js';
import { classifyCandidate } from './semantic.js';
import { DurableJobs } from './jobs.js';
import { MATERIAL_TTL_DAYS, expiryFrom, isLive, materialEntry, renew } from './material.js';
const DAY = 86400000;
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/**
 * Bounds on the persistent outbox.
 *
 * The design requires the offline queue to be a durable task, but a queue that
 * only ever grows is not a queue — it is an unbounded copy of the user's
 * information that no one looks at. Two independent caps are therefore enforced
 * (item count and total payload bytes), and a full outbox is reported as such
 * rather than silently dropping the newest item: a dropped candidate is lost
 * information, and the caller is the only one who can decide what to do instead.
 */
export const OUTBOX_MAX_ENTRIES = 500;
export const OUTBOX_MAX_BYTES = 4 * 1024 * 1024;
/**
 * How long an undelivered item waits before it is marked `abandoned`.
 *
 * Expiry abandons rather than deletes. Deleting a lapsed item would discard the
 * user's own words while they cannot see it happen, which is exactly the silent
 * information loss the design forbids; an abandoned row keeps the reason, the
 * attempt count and when the deadline passed, so a person can still inspect and
 * retry it deliberately.
 */
export const OUTBOX_TTL_MS = 7 * DAY;
/**
 * Attempts after which an undelivered item is given up on.
 *
 * The design (acceptance 20) forbids retrying forever, so the queue stops on its
 * own rather than waiting for someone to notice. The row stays as `abandoned`.
 */
export const OUTBOX_MAX_ATTEMPTS = 12;
/** Outbox rows that are no longer waiting to go out. */
const OUTBOX_TERMINAL = ['sent', 'abandoned'];
/**
 * Refusal text that identifies a permanent conflict when the structured error is gone.
 *
 * The decision below reads `DomainError.code`/`status` first, and only falls back to
 * these when the error crossed a boundary that dropped its identity (a re-thrown
 * string, a bridged call). The wording is the exact wording the store throws, so a
 * match means the same conflict and not a lookalike.
 */
const PERMANENT_REPLAY_MESSAGES = [
    /idempotency_conflict/i,
    // Covers all three throw sites of the conflict: "Event key already has different
    // content", "Same idempotency key has different content" and "Checkpoint key
    // already has different content".
    /has different content/i,
    /already queued as a different kind of item/i,
];
/**
 * Whether a replay failure will fail the same way however many times it is retried.
 *
 * `replayOutbox` re-sends a payload the store already holds, so its request is
 * frozen: a refusal of *that request* — any 4xx — is a property of the content, not
 * of the moment, and resending it can only produce the same refusal. The cost of
 * ignoring that was measurable in production: 984 rows (451 failed, 533 abandoned)
 * all carrying the same `idempotency_conflict`, retried 9,773 times between them and
 * delivering nothing, each attempt blocking a session's first step.
 *
 * A 5xx, a network fault or a full outbox (507) is the opposite case: the request was
 * fine and the world was not, so it stays retryable and keeps its backoff. The status
 * range rather than a list of the codes seen so far is deliberate: every 4xx is a
 * rejection of this exact request by construction, while a list would quietly send
 * the next code someone adds back into infinite retries.
 */
export function isPermanentReplayRefusal(error) {
    if (error instanceof DomainError) {
        // `idempotency_conflict` is called out by name because it is the one production
        // hit, and because its 409 is a fact about the content rather than the request
        // shape; the status range then covers every other business refusal (400
        // `invalid_request`, 403 `forbidden`/`scope_denied`, 404 `not_found`, and so on).
        return error.code === 'idempotency_conflict' || (error.status >= 400 && error.status < 500);
    }
    const message = error instanceof Error ? error.message : String(error);
    return PERMANENT_REPLAY_MESSAGES.some(pattern => pattern.test(message));
}
/**
 * Whether a scope applies to the caller's project and task.
 *
 * A task-scoped entry applies only to that task, and to nothing when the caller
 * has no task in hand. That is the whole point of the scope: "这一次用 Banana"
 * must not become a rule for every later task, and the only way to guarantee that
 * is to make it inapplicable when the task is unknown rather than when it differs.
 */
const applicable = (scope, projectId, taskId) => {
    if (scope.kind === 'global')
        return true;
    if (scope.projectId !== projectId)
        return false;
    if (scope.kind === 'task')
        return taskId !== undefined && scope.taskId === taskId;
    return true;
};
function searchable(value) {
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
function queryTokens(query) {
    return [...new Set(searchable(query).split(' ').filter(Boolean))]
        .sort((a, b) => b.length - a.length)
        .slice(0, 40);
}
// These are linguistic/action words, not domain terms. Removing them only for
// automatic recall prevents a shared procedure template from becoming a topic.
// Explicit full-text search deliberately retains every query token.
const recallStopWords = new Set(['实现', '功能', '主动', '调用', '参考', '使用', '需要', '执行', '任务', '验收',
    '进行', '完成', '工作', '现在', '已经', '继续', '确认', '这些', '这个', '怎么', '如何', '是否',
    '可以', '帮我', '我们', '一下', '之后', '之前', '所有', '相关', '处理', '检查']);
function automaticRelevance(content, query) {
    if (query.trim().replace(/@\d+$/, '') === content.id)
        return { score: 100, matched: [content.id], coverage: 1 };
    // Strip whole filler phrases before bigram tokenization; filtering afterwards
    // leaves artificial cross-boundary fragments (检查功能 -> 查功).
    const substantive = query.toLowerCase().replace(new RegExp([...recallStopWords].join('|'), 'gu'), ' ');
    const tokens = queryTokens(substantive);
    if (!tokens.length)
        return { score: 0, matched: [], coverage: 0 };
    const description = content.kind === 'skill' ? /^description:\s*(.+)$/m.exec(content.body)?.[1] ?? '' : '';
    const primary = `${content.title} ${description} ${content.kind === 'workflow' ? `${content.overview} ${content.triggers.join(' ')}` : ''}`.toLowerCase();
    const body = 'body' in content ? content.body : content.kind === 'journal' ? `${content.did}\n${content.problems}` : '';
    const match = (text) => tokens.filter(token => text.includes(token));
    const weight = (token) => /^[a-z0-9_-]{3,}$/.test(token) ? 2 : 1;
    const total = tokens.reduce((sum, token) => sum + weight(token), 0);
    const coverage = (hits) => hits.reduce((sum, token) => sum + weight(token), 0) / total;
    const primaryHits = match(primary);
    const primaryCoverage = coverage(primaryHits);
    // A single broad word in a long request is not a reliable topic. A named
    // technology or several advertised-purpose fragments is stronger evidence.
    const primaryAccepted = primaryCoverage >= 0.25 && (primaryHits.length >= 2
        || primaryHits.some(token => /^[a-z0-9_-]{3,}$/.test(token)) || primaryCoverage >= 0.3);
    let bestHits = [];
    // Skills advertise their applicability in title/description. Their references
    // remain explicitly searchable, but do not broaden automatic applicability.
    if (content.kind !== 'skill') {
        // A whole daily log can match every query word in unrelated entries. Demand
        // local co-occurrence, keeping fixed windows even when a source has no lines.
        for (const paragraph of body.toLowerCase().split(/\n|[。！？]/u)) {
            for (let offset = 0; offset < paragraph.length; offset += 240) {
                const hits = match(paragraph.slice(offset, offset + 480));
                if (coverage(hits) > coverage(bestHits))
                    bestHits = hits;
            }
        }
    }
    const bodyCoverage = coverage(bestHits);
    const broadShortQuery = tokens.every(token => /\p{Script=Han}/u.test(token))
        && substantive.replace(/\s/g, '').length <= 3;
    const bodyAccepted = !(broadShortQuery && body.length > 1000) && bodyCoverage >= 0.5 && (bestHits.length >= 2
        || bestHits.some(token => /^[a-z0-9_-]{4,}$/.test(token)) || (tokens.length === 1 && body.length <= 1000));
    if (!primaryAccepted && !bodyAccepted)
        return { score: 0, matched: [], coverage: 0 };
    const hits = [...new Set([...primaryHits, ...bestHits])];
    return { score: (primaryAccepted ? 3 * primaryCoverage : 0) + (bodyAccepted ? bodyCoverage : 0),
        matched: hits, coverage: coverage(hits) };
}
function matchAll(db, tokens, floor = 0.5) {
    if (!tokens.length)
        return [];
    const hitsFor = (token) => {
        try {
            return new Set(db.prepare('SELECT id FROM workflow_search WHERE workflow_search MATCH ?')
                .all(`"${token}"`).map(row => String(row.id)));
        }
        catch {
            return new Set();
        }
    };
    const perToken = tokens.map(hitsFor);
    // Rows that match at least one fragment, in the order the widest query returned
    // them. bm25 already orders that by relevance, which breaks coverage ties.
    const ranked = db.prepare('SELECT id FROM workflow_search WHERE workflow_search MATCH ? ORDER BY bm25(workflow_search)')
        .all(tokens.map(token => `"${token}"`).join(' OR ')).map(row => String(row.id));
    const matchedFor = (id) => tokens.filter((_token, index) => perToken[index].has(id));
    // A single fragment carries no coverage signal: whether it appears is the only
    // question, its commonness has already been judged, and bm25 ordered the answer.
    if (tokens.length === 1)
        return ranked.map(id => ({ id, coverage: 1, matched: matchedFor(id) }));
    const covered = new Map();
    for (const id of ranked) {
        let count = 0;
        for (const hits of perToken)
            if (hits.has(id))
                count += 1;
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
function matchIds(db, tokens, floor = 0.5) {
    return matchAll(db, tokens, floor).map(match => match.id);
}
/** Single SQLite authority for the P0 fixture; not a semantic auto-promotion engine. */
export class Store {
    path;
    now;
    db;
    jobs;
    constructor(path, now = Date.now) {
        this.path = path;
        this.now = now;
        this.db = new DatabaseSync(path);
        this.jobs = new DurableJobs(this.db, this.now);
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
        -- How well the verified text is supported. Stored beside the claim so the
        -- diary can tell a caller's assertion from something the plugin observed;
        -- see generateJournal for why a non-empty string is not evidence by itself.
        evidence TEXT NOT NULL DEFAULT 'self-reported',
        -- The observed digest/size of each file this task touched, so a receiving
        -- end in another checkout can compare against its own copy (acceptance 16).
        -- A path alone cannot answer "has this file changed since", which is why
        -- the files list alone could not support the difference display the design
        -- asks for (acceptance 16).
        file_states TEXT NOT NULL DEFAULT '[]',
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
      -- A cleanup that has not succeeded yet. The design requires the persistent
      -- purge to be retryable and to leave a queryable record of failure; a pass
      -- that threw its error away would be indistinguishable from one with nothing
      -- to do, and a lapsed body would sit in the revisions table forever.
      CREATE TABLE IF NOT EXISTS material_purge_failures(
        id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL,
        message TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 1,
        failed_at INTEGER NOT NULL);
      -- Outbound work that has not been delivered yet: a candidate submission or an
      -- event capture that failed when it was produced. The design (§6.4) requires
      -- such work to be persistent and recoverable, so it lives here rather than in
      -- adapter memory, and the complete request body is stored verbatim so a replay
      -- is the *same* request — which is what lets the existing idempotency keys
      -- recognise a retry that actually landed instead of writing it twice.
      --
      -- The status column distinguishes waiting from finished: a row is never
      -- deleted on delivery, and a lapsed row is marked 'abandoned' rather than
      -- removed, so "we gave up on this" stays visible instead of quietly becoming
      -- nothing.
      CREATE TABLE IF NOT EXISTS outbox(
        id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('candidate','event')),
        idem TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL,
        project_id TEXT NOT NULL, principal TEXT NOT NULL,
        created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL, last_error TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK(status IN ('pending','sent','failed','abandoned')),
        expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(principal,idem));
      CREATE INDEX IF NOT EXISTS outbox_ready ON outbox(project_id,status,next_attempt_at);
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
    migrate() {
        const additions = [
            ['tasks', 'session_ids TEXT NOT NULL DEFAULT \'[]\''],
            ['tasks', 'related_experiences TEXT NOT NULL DEFAULT \'[]\''],
            ['tasks', 'related_proposals TEXT NOT NULL DEFAULT \'[]\''],
            ['tasks', 'files TEXT NOT NULL DEFAULT \'[]\''],
            ['tasks', 'verified TEXT NOT NULL DEFAULT \'\''],
            ['tasks', 'evidence TEXT NOT NULL DEFAULT \'self-reported\''],
            ['tasks', 'file_states TEXT NOT NULL DEFAULT \'[]\''],
            ['tasks', 'started_at INTEGER'],
            ['proposals', 'project_id TEXT NOT NULL DEFAULT \'\''],
        ];
        for (const [table, definition] of additions) {
            const column = definition.split(' ')[0];
            const existing = this.db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name));
            if (existing.includes(column))
                continue;
            this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
        }
        // Backfill from the payload for rows written before the column existed. A row
        // whose payload was already cleared cannot be attributed and is left empty
        // rather than guessed at; it stays reachable by id.
        this.db.exec(`UPDATE proposals SET project_id = COALESCE(json_extract(payload, '$.projectId'), '')
      WHERE project_id = '' AND payload <> '{}'`);
    }
    close() { this.db.close(); }
    get revision() { return Number(this.db.prepare("SELECT value FROM meta WHERE key='revision'").get().value); }
    transactionDepth = 0;
    transaction(body) {
        const depth = this.transactionDepth++;
        const name = `amb_nested_${depth}`;
        try {
            this.db.exec(depth ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE');
            try {
                const result = body();
                this.db.exec(depth ? `RELEASE SAVEPOINT ${name}` : 'COMMIT');
                return result;
            }
            catch (error) {
                this.db.exec(depth ? `ROLLBACK TO SAVEPOINT ${name}` : 'ROLLBACK');
                if (depth)
                    this.db.exec(`RELEASE SAVEPOINT ${name}`);
                throw error;
            }
        }
        finally {
            this.transactionDepth--;
        }
    }
    head(id) {
        const row = this.db.prepare(`SELECT k.id,k.head,k.status,r.content FROM knowledge k
      JOIN revisions r ON k.id=r.id AND k.head=r.revision WHERE k.id=?`).get(id);
        return row && this.decode(row);
    }
    decode(row) {
        return { id: String(row.id), revision: Number(row.head), status: String(row.status), content: knowledgeSchema.parse(JSON.parse(String(row.content))) };
    }
    current() {
        // Ordered by id so the same library always yields the same sequence. Without
        // it, SQLite returns rows in whatever order the plan produces, which made any
        // caller that takes the first N pick an arbitrary subset — adopted skills
        // appeared in the injected context in a different order run to run, and the
        // entries that happened to come first varied with the build of SQLite.
        return this.db.prepare(`SELECT k.id,k.head,k.status,r.content FROM knowledge k
      JOIN revisions r ON k.id=r.id AND k.head=r.revision WHERE k.status='active'
      ORDER BY k.id`).all().map(row => this.decode(row));
    }
    /**
     * Active entries of one kind.
     *
     * `current()` parses every active entry, and for the gate path that dominated the
     * call: with 5,000 entries, 98.8% of the time went into decoding entries the
     * caller then discarded, because a gate call only ever reads norms. The `kind`
     * column is already indexed by the same table, so asking the database for the one
     * kind needed is a strict improvement with no change in semantics — the same rows
     * are returned, only fewer of them are parsed.
     *
     * The `ORDER BY id` is kept for the same reason as in `current()`: a stable order
     * means the same library always yields the same sequence, which matters to callers
     * that take the first N.
     */
    currentOfKind(kinds) {
        if (kinds.length === 0)
            return [];
        const placeholders = kinds.map(() => '?').join(',');
        return this.db.prepare(`SELECT k.id,k.head,k.status,r.content FROM knowledge k
      JOIN revisions r ON k.id=r.id AND k.head=r.revision
      WHERE k.status='active' AND k.kind IN (${placeholders})
      ORDER BY k.id`).all(...kinds).map(row => this.decode(row));
    }
    /**
     * Read one entry by id regardless of status, then refuse it unless the caller's
     * scope may see it.
     *
     * Every review and lifecycle method that takes an object id goes through here:
     * nothing about the HTTP layer's envelope check looks at the *object* named in
     * the body, so a credential for one project could otherwise approve, reject,
     * retire or read another project's entry simply by naming its id. A global entry
     * is visible to every project, which is the one deliberate exception.
     */
    requireVisible(id, projectId) {
        const entry = this.head(id) ?? this.decodeAny(id);
        if (!entry)
            throw new DomainError('not_found', `Knowledge entry ${id} is unavailable`, 404);
        const scope = entry.content.scope;
        if (scope.kind !== 'global' && scope.projectId !== projectId) {
            throw new DomainError('not_found', `Knowledge entry ${id} is unavailable`, 404);
        }
        return entry;
    }
    /** Admin-only offline import. Every update requires the observed per-item revision. */
    import(entries) {
        return this.importWithReport(entries).knowledgeRevision;
    }
    /**
     * Import entries and report what became of each, rather than only that it worked.
     *
     * `import()` alone answered with a revision, which read as "everything arrived".
     * For temporary material that can be false the moment it lands: the schema's own
     * `expiresAt` default is 0, which means *already lapsed*, so an entry written by
     * the offline seed path — which parses a document directly and never passes
     * through `materialEntry` — was stored expired, purged by the next `cleanup()`,
     * and still reported as an import success. The user was told a runbook had been
     * imported and could never read it.
     *
     * Two things are therefore done at this boundary, which is the only place that
     * can tell "the caller stated no lifetime" from "the caller asked for none":
     *
     *   - A material entry that states no `expiresAt` (or a non-positive one) gets the
     *     design's own retention (§8: 90 days, `MATERIAL_TTL_DAYS`) computed from its
     *     `savedAt`. This matches what `saveMaterial` already produces, so the two
     *     write paths stop disagreeing about the same kind of entry.
     *   - Any entry that is nonetheless not readable after the write — an explicit
     *     past expiry, however it got there — is named in `result.unusable`. Only
     *     material can be born expired, so it is the only kind checked.
     *
     * An explicit future expiry is left exactly as the caller wrote it: expiry is
     * stored rather than computed so a later retention change cannot retroactively
     * move an entry that was saved under an older policy.
     */
    importWithReport(entries) {
        const now = this.now();
        const validated = entries.map(entry => this.withImportDefaults(entry, now));
        if (new Set(validated.map(x => x.id)).size !== validated.length)
            throw new DomainError('duplicate_id', 'Import contains duplicate IDs');
        const knowledgeRevision = this.transaction(() => this.importInsideTransaction(validated));
        const unusable = validated
            .filter((entry) => entry.kind === 'material' && !isLive(entry.expiresAt, now))
            .map(entry => ({
            id: entry.id, kind: entry.kind,
            reason: entry.expiresAt <= 0
                ? '未声明有效期，且有效期解析为 0（即已过期），导入后不可读'
                : `已过期（expiresAt=${entry.expiresAt}，早于当前时间 ${now}），导入后不可读`,
        }));
        return { knowledgeRevision, imported: validated.length, unusable };
    }
    /**
     * Apply the defaults an import boundary owes an entry, before validation.
     *
     * Kept separate from `materialEntry` because that helper *builds* a new entry
     * while this one *repairs* a parsed document, and folding them together would
     * force the build path to re-validate text it just composed.
     */
    withImportDefaults(entry, now) {
        const parsed = knowledgeSchema.parse(entry);
        if (parsed.kind !== 'material')
            return parsed;
        if (parsed.expiresAt > 0)
            return parsed;
        // `savedAt` is 0 when the caller stated none, which would put the expiry in
        // 1970 and leave the entry expired anyway; the write time is the honest basis
        // for an entry whose own date is unknown.
        const savedAt = parsed.savedAt > 0 ? parsed.savedAt : now;
        return { ...parsed, savedAt, expiresAt: expiryFrom(savedAt) };
    }
    /** Caller must already hold a transaction; shared with proposal approval. */
    importInsideTransaction(validated) {
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
        for (const content of validated)
            if (content.kind === 'workflow')
                this.validateDependencies(next.get(content.id), next, new Set());
        for (const content of validated) {
            const rev = content.baseRevision + 1;
            this.db.prepare(`INSERT INTO knowledge(id,kind,head,status) VALUES(?,?,?,'active')
        ON CONFLICT(id) DO UPDATE SET head=excluded.head,status='active'`).run(content.id, content.kind, rev);
            this.db.prepare('INSERT INTO revisions VALUES(?,?,?,?)').run(content.id, rev, JSON.stringify(content), this.now());
            this.db.prepare('DELETE FROM workflow_search WHERE id=?').run(content.id);
            // Workflows, skills and memories are all searchable. A workflow is indexed
            // whole; a skill is indexed together with its leaves so a search for a leaf
            // topic still finds the entry that owns it.
            if (content.kind !== 'norm')
                this.db.prepare('INSERT INTO workflow_search VALUES(?,?)').run(content.id, searchable(JSON.stringify(content)));
        }
        this.db.prepare("UPDATE meta SET value=value+1 WHERE key='revision'").run();
        this.jobs.enqueue('notify', `revision:${this.revision}`, { revision: this.revision });
        return this.revision;
    }
    validateDependencies(entry, all, ancestors) {
        if (ancestors.has(entry.id))
            throw new DomainError('dependency_cycle', `Workflow dependency cycle at ${entry.id}`, 409);
        if (entry.content.kind !== 'workflow')
            throw new DomainError('not_workflow', 'A workflow dependency must target a workflow', 409);
        this.workflowSource(entry.content);
        const path = new Set(ancestors).add(entry.id);
        for (const stage of entry.content.stages)
            for (const dep of stage.dependencies) {
                if (dep.relationship === 'reference')
                    continue;
                const child = all.get(dep.workflowId);
                if (!child || child.status !== 'active' || child.revision !== dep.revision)
                    throw new DomainError('dependency_unavailable', `Required dependency ${dep.workflowId}@${dep.revision} is not current`, 409);
                const parentScope = entry.content.scope, childScope = child.content.scope;
                if (childScope.kind === 'project' && (parentScope.kind === 'global' || childScope.projectId !== parentScope.projectId))
                    throw new DomainError('dependency_scope', 'Required workflow belongs to an incompatible scope', 409);
                this.validateDependencies(child, all, path);
            }
    }
    /** A derived procedure is pinned to its source, including all reference leaves. */
    workflowSource(flow) {
        if (!flow.derivedFrom)
            return undefined;
        const source = this.head(flow.derivedFrom.skillId);
        if (!source || source.content.kind !== 'skill' || source.revision !== flow.derivedFrom.skillRevision)
            throw new DomainError('source_changed', 'Source skill changed or is unavailable; review the derived workflow again', 409);
        const a = flow.scope, b = source.content.scope;
        if (b.kind !== 'global' && (a.kind === 'global' || a.projectId !== b.projectId
            || (b.kind === 'task' && (a.kind !== 'task' || a.taskId !== b.taskId))))
            throw new DomainError('dependency_scope', 'Source skill belongs to a narrower scope', 409);
        return { id: source.id, revision: source.revision, body: source.content.body,
            leaves: source.content.leaves.map(leaf => ({ ...leaf })) };
    }
    retire(id, baseRevision) {
        this.transaction(() => {
            const result = this.db.prepare("UPDATE knowledge SET status='retired' WHERE id=? AND head=? AND status='active'").run(id, baseRevision);
            if (!result.changes)
                throw new DomainError('revision_conflict', 'Current knowledge revision not found', 409);
            this.db.prepare('DELETE FROM workflow_search WHERE id=?').run(id);
            this.db.prepare("UPDATE meta SET value=value+1 WHERE key='revision'").run();
            this.jobs.enqueue('notify', `revision:${this.revision}`, { revision: this.revision });
        });
    }
    norms(projectId, options) {
        // Reads norms only. Going through `current()` here meant a gate call parsed the
        // whole active library — 98.8% of its cost at 5,000 entries — to then discard
        // everything that was not a norm. The TTL gate that `liveEntries()` applies is
        // irrelevant to norms (expiry is a property of material alone), so the narrowed
        // read is equivalent and returns exactly the same rows.
        return this.currentOfKind(['norm'])
            .filter(e => e.content.kind === 'norm' && applicable(e.content.scope, projectId, options?.taskId))
            // Platform applicability is a real dimension of a norm, not documentation:
            // a rule the user marked `codex-only` must not be injected into DSH, and an
            // empty list means both hosts.
            .filter(e => !options?.platform || e.content.platforms.length === 0
            || e.content.platforms.includes(options.platform))
            .map(e => ({ ...e.content, revision: e.revision }));
    }
    /**
     * Active entries visible to a project, in full Entry shape.
     *
     * `norms()` flattens an entry's content, which suits internal composition but
     * not callers that need the identity and status alongside it. This keeps the
     * scope filter while preserving the shape those callers already depend on.
     */
    scopedEntries(projectId) {
        return this.liveEntries().filter(e => applicable(e.content.scope, projectId));
    }
    search(projectId, query, limit = 8) {
        const entries = this.liveEntries();
        const all = new Map(entries.map(x => [x.id, x]));
        const tokens = queryTokens(query);
        // With no query this lists every workflow. That is what a browsing caller
        // wants — the console's workflow panel shows the catalog before anything is
        // typed. Injection is a different question, and `prepare()` decides it: an
        // empty query there means there is no basis for selection, so nothing is
        // injected rather than an arbitrary slice.
        const matches = tokens.length ? matchAll(this.db, tokens) : [];
        const ids = tokens.length ? matches.map(match => match.id) : entries.map(e => e.id);
        const reasonFor = new Map(matches.map(match => [match.id, match]));
        return ids.map(id => all.get(id)).filter((e) => !!e && e.content.kind === 'workflow' && applicable(e.content.scope, projectId)).slice(0, limit).map(e => {
            const c = e.content;
            let ready = true, unavailable;
            try {
                this.validateDependencies(e, all, new Set());
            }
            catch (error) {
                ready = false;
                unavailable = error.message;
            }
            return { id: e.id, revision: e.revision, title: c.title, overview: c.overview,
                preconditions: c.preconditions, stages: c.stages.map(s => ({ id: s.id, title: s.title, checks: s.checks })),
                completion: c.completion, recovery: c.recovery, categories: c.categories, ready, unavailable,
                // Same reason as `knowledge()`: an entry must be able to say why it appeared.
                why: reasonFor.has(e.id) ? { matched: reasonFor.get(e.id).matched, coverage: reasonFor.get(e.id).coverage } : null };
        });
    }
    expand(projectId, id, stageId) {
        const all = new Map(this.liveEntries().map(x => [x.id, x]));
        const entry = all.get(id);
        if (!entry || entry.content.kind !== 'workflow' || !applicable(entry.content.scope, projectId))
            throw new DomainError('not_found', 'Workflow is unavailable', 404);
        this.validateDependencies(entry, all, new Set());
        const stage = entry.content.stages.find(s => s.id === stageId);
        if (!stage)
            throw new DomainError('not_found', 'Stage is unavailable', 404);
        const expanded = new Set();
        const resolve = (flow) => flow.stages.flatMap(s => s.dependencies.filter(d => d.relationship !== 'reference').flatMap(d => {
            if (expanded.has(d.workflowId))
                return [];
            expanded.add(d.workflowId);
            const child = all.get(d.workflowId);
            return [{ id: child.id, revision: child.revision, workflow: child.content, source: this.workflowSource(child.content) }, ...resolve(child.content)];
        }));
        // Includes all required prerequisites of this stage and nested dependencies, never independent fragments.
        const stageFlow = { ...entry.content, stages: [stage] };
        return { workflowId: id, revision: entry.revision, title: entry.content.title, preconditions: entry.content.preconditions,
            stage, completion: entry.content.completion, recovery: entry.content.recovery, dependencies: resolve(stageFlow),
            source: this.workflowSource(entry.content), ready: true };
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
    knowledge(projectId, query, limit = 5, excerptChars = 400, relevanceFloor = 0.5) {
        const entries = this.liveEntries();
        const all = new Map(entries.map(x => [x.id, x]));
        const tokens = queryTokens(query);
        // With no query, list the catalog in a stable order — a browsing caller (the
        // console, or a user asking what is in the library) wants exactly that.
        //
        // Injection is decided elsewhere: `prepare()` skips this call entirely when
        // the query is empty, because an arbitrary slice of the library appearing in
        // every session is how an unrelated project opened with five media skills.
        const matches = tokens.length ? matchAll(this.db, tokens, relevanceFloor) : [];
        const ids = tokens.length ? matches.map(match => match.id) : entries.map(entry => entry.id);
        const reasonFor = new Map(matches.map(match => [match.id, match]));
        const result = [];
        for (const id of ids) {
            const entry = all.get(id);
            if (!entry)
                continue;
            const content = entry.content;
            // Norms are read through `norms()` and workflows through `search()`, each
            // with its own shape. Temporary material is deliberately absent: it is only
            // valid until it expires, and its lifecycle is handled separately.
            //
            // Narrowed by kind rather than by an `includes` check, because only this form
            // tells the type system which fields exist — a journal has no `body`, it has
            // what the task did.
            if (content.kind !== 'skill' && content.kind !== 'memory'
                && content.kind !== 'preference' && content.kind !== 'journal')
                continue;
            if (!applicable(content.scope, projectId))
                continue;
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
                why: reasonFor.has(id) ? { matched: reasonFor.get(id).matched, coverage: reasonFor.get(id).coverage } : null,
            });
            if (result.length >= limit)
                break;
        }
        return result;
    }
    /** Automatic selection has absolute evidence thresholds; explicit search does not. */
    automaticMatches(projectId, query) {
        return new Map(this.liveEntries().filter(entry => applicable(entry.content.scope, projectId))
            .map(entry => [entry.id, automaticRelevance(entry.content, query)])
            .filter(([, reason]) => reason.score > 0));
    }
    autoRecall(projectId, query, kindFilter, limit = 3) {
        if (!query.trim())
            return [];
        const matches = this.automaticMatches(projectId, query);
        return this.searchUniversal(projectId, '', kindFilter, Number.MAX_SAFE_INTEGER)
            .filter(entry => matches.has(entry.id))
            .sort((a, b) => matches.get(b.id).score - matches.get(a.id).score)
            .slice(0, limit).map(entry => ({ ...entry, why: { id: entry.id, ...matches.get(entry.id) } }));
    }
    /**
     * Universal search across all knowledge kinds: norm, preference, memory, skill, journal, workflow, material.
     * Allows manual filtering by kind and full-text keyword retrieval.
     */
    searchUniversal(projectId, query = '', kindFilter, limit = 100) {
        const entries = this.liveEntries();
        const tokens = queryTokens(query);
        const matches = tokens.length ? matchAll(this.db, tokens, 0.3) : [];
        const reasonFor = new Map(matches.map(m => [m.id, m]));
        const matchedIds = new Set(matches.map(m => m.id));
        let candidates = entries.filter(e => applicable(e.content.scope, projectId));
        if (kindFilter && kindFilter !== 'all') {
            candidates = candidates.filter(e => e.content.kind === kindFilter);
        }
        if (tokens.length) {
            candidates = candidates.filter(e => {
                if (matchedIds.has(e.id))
                    return true;
                const text = `${e.id} ${e.content.title} ${'body' in e.content ? e.content.body : ''}`.toLowerCase();
                return tokens.some(t => text.includes(t.toLowerCase()));
            });
            candidates.sort((a, b) => {
                const scoreA = reasonFor.get(a.id)?.coverage ?? 0;
                const scoreB = reasonFor.get(b.id)?.coverage ?? 0;
                return scoreB - scoreA;
            });
        }
        return candidates.slice(0, limit).map(entry => {
            const c = entry.content;
            const body = typeof c.body === 'string' ? c.body : (typeof c.overview === 'string' ? c.overview : (typeof c.did === 'string' ? c.did : (typeof c.summary === 'string' ? c.summary : '')));
            return {
                id: entry.id,
                revision: entry.revision,
                kind: entry.content.kind,
                title: entry.content.title,
                scope: entry.content.scope,
                provenance: entry.content.provenance,
                evidence: entry.content.evidence,
                excerpt: body.length > 300 ? `${body.slice(0, 300)}…` : body,
                chars: body.length,
                why: reasonFor.get(entry.id) ?? null,
            };
        });
    }
    /**
     * Resolve a caller-supplied knowledge id.
     *
     * Two shapes arrive here and both are legitimate:
     *
     *   - A bare id, which the console and the CLI use.
     *   - `id@revision`, which is *not* a convenience form but the only form the
     *     model ever sees. Every handle in the injected context is written that way
     *     (`规范 ${id}@${revision}`, `已采纳技能 ${id}@${revision}`), because the
     *     revision is what tells the reader which version it was shown. A model that
     *     reads such a handle and is asked to expand it copies the whole token — so
     *     an exact `candidate.id === id` match failed for every entry the summary
     *     itself had just advertised, which is why `get` (bare id, 200) and `read`
     *     (`id@rev`, 404) disagreed about the same entry.
     *
     * A named revision is treated as a *requirement*, not a hint: if it does not
     * match the current one the answer is 409 naming the current revision, never a
     * silent downgrade to the newest text (which would hand back content the caller
     * did not ask for) and never a 404 (which claims the entry does not exist when
     * it does, and is the misleading message this whole defect was made of).
     */
    resolveKnowledgeId(id) {
        const trimmed = id.trim();
        // `identifier` ids may contain `.`, `:`, `-` and `_`, so only a trailing
        // `@<digits>` is a revision. A non-numeric suffix stays part of the id, which
        // keeps ids that legitimately contain `@`-like text from being mis-split.
        const match = /^(.*)@(\d+)$/.exec(trimmed);
        if (!match)
            return { id: trimmed };
        return { id: match[1], requestedRevision: Number(match[2]) };
    }
    /**
     * Resolve an id, apply the scope rule, and honour a requested revision.
     *
     * Shared by `getKnowledge` and `readKnowledge` so the two can never disagree
     * about the same input — the acceptance criterion is literally that get and
     * read reach the same conclusion, and two copies of this logic would drift.
     *
     * `includeExpired` is the one deliberate difference between them: `get` is the
     * console's raw view of a record and may show material that has lapsed, while
     * `read` is a retrieval path and must apply the expiry gate. (`liveEntries()`
     * is where that gate lives; see its comment.)
     */
    resolveVisible(id, projectId, options = {}) {
        const { id: bareId, requestedRevision } = this.resolveKnowledgeId(id);
        const entry = this.liveEntries().find(candidate => candidate.id === bareId);
        if (!entry || !applicable(entry.content.scope, projectId)) {
            throw new DomainError('not_found', `Knowledge entry ${bareId} is unavailable`, 404);
        }
        if (!options.includeExpired && entry.content.kind === 'material' && !isLive(entry.content.expiresAt, this.now())) {
            throw new DomainError('not_found', `Knowledge entry ${bareId} is unavailable`, 404);
        }
        if (requestedRevision !== undefined && requestedRevision !== entry.revision) {
            // 409, not 404: the entry exists and the caller named a real version of it,
            // so "not found" would be false. The current revision is stated so the
            // caller can retry with a handle that works instead of guessing.
            throw new DomainError('revision_conflict', `Knowledge entry ${bareId} is at revision ${entry.revision}, not ${requestedRevision}`, 409);
        }
        return entry;
    }
    /**
     * Get single raw knowledge entry by ID regardless of kind.
     *
     * Accepts the `id@revision` handle as well as a bare id, so a caller that
     * copied either form from the injected context reaches the same answer.
     */
    getKnowledge(projectId, id) {
        // Raw view: expired material stays visible here, as it did before, so the
        // console can still show what lapsed and when.
        return this.resolveVisible(id, projectId, { includeExpired: true });
    }
    /**
     * Expand one knowledge entry by ID.
     *
     * This is the on-demand step the prepare summary points at, so it must be able
     * to serve *every* kind that summary advertises. It previously accepted only
     * `skill` and `memory` and refused the rest with "Knowledge entry is
     * unavailable" — which was wrong twice over: the entry was neither missing nor
     * invisible, and the message sent the reader looking for a problem that did not
     * exist. `getKnowledge` served all kinds, so the two paths contradicted each
     * other about the same id.
     *
     * The reading shape is now chosen per kind rather than by refusing kinds: a
     * skill returns its body plus leaves, everything else returns its prose — a
     * journal's prose is what it *did*, because it has no `body` field — and the
     * kind-specific extras (`needsStructure`, `outcome`, `stated`, material's
     * `url`/`expiresAt`) travel alongside so a reader can tell what they are
     * holding. `relations` stays for every kind: it is the answer to "does a
     * companion entry exist", which is exactly as relevant for a norm as for a
     * skill.
     */
    readKnowledge(projectId, id, includeLeaves = false) {
        // Retrieval path: the expiry gate applies, so lapsed material is not served.
        const entry = this.resolveVisible(id, projectId);
        const content = entry.content;
        const relations = this.supersessions(entry.id, projectId).map(link => ({
            direction: (link.oldKnowledgeId === entry.id
                ? (link.action === 'supersede' ? 'replaced' : 'supplemented')
                : (link.action === 'supersede' ? 'replaced-by' : 'supplemented-by')),
            id: link.oldKnowledgeId === entry.id ? link.newKnowledgeId : link.oldKnowledgeId,
            revision: link.oldKnowledgeId === entry.id ? link.newRevision : link.oldRevision,
            reason: link.reason,
        }));
        /**
         * `body` has to mean "the prose of this entry", and which field that is
         * depends on the kind: only a skill or memory carries `body` literally, while
         * a journal records `did`, a workflow `overview`, and a norm, preference or
         * material each carry `body` under a different schema. All of them are prose
         * a reader asked for; returning an empty string for half the library is the
         * failure that made "read supports every kind" true only on paper.
         */
        const proseOf = (entryContent) => {
            switch (entryContent.kind) {
                case 'skill':
                case 'memory':
                case 'norm':
                case 'preference':
                case 'material': return entryContent.body;
                case 'journal': return entryContent.did;
                case 'workflow': return entryContent.overview;
            }
        };
        const base = {
            id: entry.id, revision: entry.revision, kind: content.kind, title: content.title,
            body: proseOf(content), relations,
        };
        switch (content.kind) {
            case 'skill':
                return {
                    ...base,
                    needsStructure: content.needsStructure,
                    leaves: content.leaves.map(leaf => ({ path: leaf.path, body: includeLeaves ? leaf.body : '' })),
                };
            case 'material':
                // No leaves, so the "include" flag has nothing to expand; the expiry is
                // returned so a caller can see how long the entry has left rather than
                // inferring it from the retention default.
                return { ...base, url: content.url, savedAt: content.savedAt, expiresAt: content.expiresAt, leaves: [] };
            case 'preference':
                return { ...base, stated: content.stated, leaves: [] };
            case 'journal':
                return { ...base, outcome: content.outcome, leaves: [] };
            case 'workflow':
                return { ...base, overview: content.overview, leaves: [] };
            default:
                // norm and memory: both are plain prose with no extra dimension to report.
                return { ...base, leaves: [] };
        }
    }
    /**
     * Character budget for the norms injected into one context.
     *
     * A configured ceiling rather than a silent truncation: the design (§10, acceptance
     * 7) requires a budget with an explicit activation split and a visible report of
     * what was left out. Forty legitimate norms of ~12,000 characters produced a
     * 480,000-character prepare and the same again on every gate call, which is both a
     * context-budget failure and a duplicate-injection failure. Nothing here drops a
     * *prohibition*: the decision list is always returned whole, and only the prose
     * injected into the model is bounded.
     */
    normBudgetChars = 12_000;
    /**
     * Split a norm set into what fits the budget and what does not.
     *
     * Shared by `prepare` and `gate` rather than written twice, because the two paths
     * must agree on the ceiling: the audit's F23 was a 480,000-character context that
     * the budget fixed for `prepare` while `gate` kept sending it whole. The second
     * call site was the one that fires before *every* tool call, so leaving it
     * unbudgeted kept most of the cost the fix was meant to remove.
     *
     * Two rules are load-bearing and must survive any change here:
     *
     *   - An entry that states a tool prohibition is always included, however large.
     *     A budget that hid a prohibition would silently weaken enforcement, which is
     *     the one thing the design says it must never do (§10).
     *   - An excluded entry is reported with its id, size and reason, never dropped:
     *     the design requires the over-budget state to be visible (acceptance 7).
     */
    splitByBudget(norms) {
        // Prohibitions first, so a large normative body can never crowd out a rule that
        // a gate actually enforces.
        const ordered = [...norms].sort((a, b) => Number(b.kind === 'norm' && b.deniedTools.length > 0) - Number(a.kind === 'norm' && a.deniedTools.length > 0));
        const injected = [];
        const omitted = [];
        let used = 0;
        for (const norm of ordered) {
            const text = norm.kind === 'norm' ? norm.body : '';
            const cost = text.length + 80;
            if ((norm.kind === 'norm' && norm.deniedTools.length > 0) || used + cost <= this.normBudgetChars) {
                injected.push(norm);
                used += cost;
            }
            else {
                omitted.push({ id: norm.id, kind: norm.kind, chars: text.length, reason: '超出规范上下文预算，按配置省略；该规范的约束仍由 gate 判定' });
            }
        }
        return { injected, omitted, used };
    }
    /** The sentence that makes an over-budget context self-explaining. */
    budgetNote(omitted) {
        return omitted.length
            ? [`规范上下文预算 ${this.normBudgetChars} 字符：本条上下文省略 ${omitted.length} 条规范（${omitted.map(o => o.id).join('、')}）；省略不改变它们的约束判定，需要时按 id 展开读取。`]
            : [];
    }
    prepare(projectId, query, options) {
        if (options?.sessionId) {
            try {
                const querySnippet = query ? query.split('\n')[0]?.slice(0, 50) : '';
                this.startTaskForSession(projectId, options.sessionId, querySnippet || '会话工作任务');
            }
            catch {
                // Task association failure must never break retrieval
            }
        }
        const all = this.norms(projectId, { taskId: options?.taskId, platform: options?.platform });
        // Instruction files the host already injects natively (DSH ships
        // dsh-agent-instructions; Codex reads the same names) stay indexed and
        // auditable but are never re-injected: sending the same bytes twice would
        // duplicate instructions and could fight the host's own baseline semantics.
        const norms = all.filter(n => n.kind !== 'norm' || !n.hostProvided);
        const hostProvided = all.filter(n => n.kind === 'norm' && n.hostProvided);
        // Budget the normative prose. Everything that fits is injected; what does not is
        // reported by id and reason rather than silently dropped, and every entry that
        // states a tool prohibition is promoted to the front so a budget can never hide
        // the rule a gate would enforce.
        const { injected, omitted } = this.splitByBudget(norms.map(norm => ({
            id: norm.id, revision: norm.revision, kind: norm.kind,
            body: norm.kind === 'norm' ? norm.body : '', deniedTools: norm.kind === 'norm' ? norm.deniedTools : [],
        })));
        const injectedIds = new Set(injected.map(item => item.id));
        const emitted = norms.filter(norm => injectedIds.has(norm.id));
        // No query means no basis for selection, so nothing is injected. Both helpers
        // fall back to listing the whole catalog, which is right for a caller that
        // asked to browse and wrong here: an arbitrary slice appearing in every
        // session is how a project unrelated to any of them opened with five media
        // skills. Norms are unaffected — they are the standing rules and apply
        // whether or not anything was asked.
        const hasQuery = queryTokens(query).length > 0;
        const retrievalTokens = queryTokens(query);
        const automaticMatches = this.automaticMatches(projectId, query);
        if (options?.selectedIds) {
            automaticMatches.clear();
            options.selectedIds.forEach((id, index) => automaticMatches.set(id, { score: 100 - index, matched: [], coverage: 0 }));
        }
        const rankAutomatic = (entries, limit) => entries
            .filter(entry => automaticMatches.has(entry.id))
            .sort((a, b) => automaticMatches.get(b.id).score - automaticMatches.get(a.id).score)
            .slice(0, limit).map(entry => ({ ...entry, why: automaticMatches.get(entry.id) }));
        const workflows = hasQuery ? rankAutomatic(this.search(projectId, '', Number.MAX_SAFE_INTEGER), 8) : [];
        // Automatic injection uses the entry's advertised purpose, not matches buried
        // in dozens of reference documents or shared procedure boilerplate. Explicit
        // universal search and knowledge() still index the full source and leaves.
        const knowledge = hasQuery ? rankAutomatic(this.knowledge(projectId, '', Number.MAX_SAFE_INTEGER, 400), 5) : [];
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
        const matchedTokens = new Set();
        for (const item of [...workflows, ...knowledge])
            for (const token of item.why?.matched ?? [])
                matchedTokens.add(token);
        const retrieval = {
            query,
            tokens: retrievalTokens,
            matchedTokens: [...matchedTokens],
            gaps: retrievalTokens.filter(token => !matchedTokens.has(token)),
            selected: [
                ...workflows.map(w => ({ id: w.id, kind: 'workflow', why: w.why })),
                ...knowledge.map(k => ({ id: k.id, kind: k.kind, why: k.why })),
            ],
            note: '这是本次检索的理由与未命中片段，供日后排查漏检；未命中不等于库中一定该有。',
        };
        const context = [
            `Agent Memory Backpack 当前知识版本 ${this.revision}。以下规范来自本地权威库；流程是经验，不授予额外操作权限。`,
            ...(hostProvided.length
                ? [`宿主已自行加载的规范（插件不重复注入，仅登记以便检索）：${hostProvided.map(n => `${n.id}@${n.revision}`).join('、')}`]
                : []),
            ...emitted.map(n => `规范 ${n.id}@${n.revision}: ${n.kind === 'norm' ? n.body : ''}`),
            ...this.budgetNote(omitted),
            ...workflows.map(w => `完整流程 ${w.id}@${w.revision} ${w.title}\n${w.overview}\n前提: ${w.preconditions.join('；')}\n阶段: ${w.stages.map(s => `${s.id}:${s.title}（检查:${s.checks.join('；')}）`).join(' → ')}\n完成: ${w.completion.join('；')}\n恢复: ${w.recovery}\n${w.ready ? '执行阶段前调用 amb_read_stage 读取完整阶段和必需依赖。' : `不可执行: ${w.unavailable}`}`),
            // Adopted skills and memories appear as entry points with a short excerpt.
            // Full text is one explicit call away, so a large adopted library cannot
            // silently consume the task's context budget.
            ...knowledge.map(k => `${k.kind === 'skill' ? '已采纳技能' : '背景记忆'} ${k.id}@${k.revision} ${k.title}`
                + (k.leafCount ? `（含 ${k.leafCount} 个参考文档）` : '')
                + `（正文 ${k.chars} 字符，需要时调用 amb_read_knowledge 读取）`
                + (k.kind === 'skill' && k.needsStructure ? '［尚未结构化：原文保存，未经核实为完整方法］' : '')
                + `\n摘要: ${k.excerpt}`),
            '【AMB 双向记忆】Codex/DSH 各项目会话共用此库。任务开始或遇到新错误，用 `amb_search_universal` 按任务/错误签名检索知识、经验与日记，再用 `amb_read_knowledge` 读相关正文并核对适用条件。\n'
                + '验证根因或新方案后用 `amb_submit_experience` 提交候选，附流程/步骤、修复和证据。pending=待审；queued_local=仅本机排队，均未采纳。自动捕获的失败事实待核实，不是规范。Stop不表示任务完成。',
        ].join('\n\n');
        // A caller that already received this revision gets a pointer instead of the
        // whole normative text again. The gate hook runs before every tool call, so
        // without this the same ~12,000 characters are re-sent dozens of times in one
        // task; the design asks for same-version reuse (§5.2) and forbids weakening a
        // rule, so the decision list still travels in full and only the prose repeats.
        const unchanged = options?.knownRevision !== undefined && options.knownRevision === this.revision;
        return {
            protocolVersion: 1, knowledgeRevision: this.revision, mode: 'Managed', norms, workflows, knowledge,
            context: unchanged
                ? `Agent Memory Backpack 当前知识版本 ${this.revision}（与上次注入相同，规范正文未重复发送）。`
                : context,
            contextUnchanged: unchanged,
            budget: {
                limitChars: this.normBudgetChars,
                usedChars: injected.reduce((total, item) => total + (item.kind === 'norm' ? item.body.length : 0) + 80, 0),
                injected: injected.map(n => ({ id: n.id, revision: n.revision, kind: n.kind })),
                omitted,
            },
            retrieval,
        };
    }
    gate(projectId, toolName, options) {
        const all = this.norms(projectId, { taskId: options?.taskId, platform: options?.platform }).filter(n => n.kind === 'norm');
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
        const normalise = (name) => name.trim().toLowerCase();
        const denied = new Set(all.flatMap(n => n.deniedTools.map(normalise)));
        const requested = normalise(toolName);
        // An empty or whitespace-only name cannot be matched meaningfully; it is
        // treated as ungovernable rather than silently allowed.
        const blocked = requested.length > 0 && denied.has(requested);
        // Same-version reuse: a gate hook fires before every tool call, so re-sending
        // the whole normative prose each time is pure duplicate context. The decision
        // and the deny list are always complete — a cache can never widen a permission.
        const unchanged = options?.knownRevision !== undefined && options.knownRevision === this.revision;
        /**
         * The same ceiling as `prepare`, and for the same reason.
         *
         * This path fires before *every* tool call, so leaving it unbudgeted kept the
         * larger half of the cost F23 was raised about: with forty near-maximum norms it
         * re-sent ~476,000 characters on the first call of each session, and the 90%
         * reduction previously measured came entirely from the same-revision suppression
         * rather than from any bound. Without `knownRevision` — a fresh session, or any
         * revision change — the full text went out.
         *
         * The decision and `deniedTools` remain complete regardless: only the prose
         * injected into the model is bounded, and a norm stating a prohibition is always
         * included.
         */
        const { injected, omitted } = this.splitByBudget(all.filter(n => !n.hostProvided).map(n => ({
            id: n.id, revision: n.revision, kind: n.kind, body: n.body, deniedTools: n.deniedTools,
        })));
        const context = [
            ...injected.map(n => `当前规范 ${n.id}@${n.revision}: ${n.body}`),
            ...this.budgetNote(omitted),
        ].join('\n');
        return {
            decision: blocked ? 'deny' : 'allow',
            reason: blocked
                ? `当前规范禁止该工具: ${all.filter(n => n.deniedTools.map(normalise).includes(requested)).map(n => n.id).join(', ')}`
                : (requested.length === 0
                    ? '工具名为空，无法核对；按未覆盖处理'
                    : 'No matching explicit tool prohibition'),
            knowledgeRevision: this.revision,
            context: unchanged ? '' : context,
            contextUnchanged: unchanged,
            budget: {
                limitChars: this.normBudgetChars,
                usedChars: injected.reduce((total, item) => total + item.body.length + 80, 0),
                injected: injected.map(n => ({ id: n.id, revision: n.revision, kind: n.kind })),
                omitted,
            },
            // The effective prohibition list, so an adapter can keep enforcing policy
            // while the core is down. Not a new disclosure: the norm bodies above are
            // already sent, and the deny list is a field inside them.
            deniedTools: [...denied],
        };
    }
    /**
     * Record a candidate for review.
     *
     * The return type is stated rather than inferred: the two branches (retry, new)
     * previously widened to a union the callers could not narrow, and a hand-written
     * annotation on the internal query then broke the whole method's inference. Naming
     * the receipt here keeps both branches in one shape for callers while leaving the
     * internals unannotated.
     */
    submit(principal, payload) {
        /**
         * Which review tier this candidate falls into, decided here rather than at each
         * call site.
         *
         * A submitted candidate is always an agent's own account, so its evidence is
         * `self-reported` and its provenance `agent` — the two facts the design's boundary
         * table keys on. That is why the tier is computed from what the submission
         * actually is rather than from anything the submitter asserts about it: a caller
         * that could declare its own change auto-applicable would not be governed by the
         * table at all.
         */
        const decision = reviewDecision({
            intent: 'new-experience',
            provenance: 'agent',
            evidence: 'self-reported',
        });
        return this.transaction(() => {
            const fingerprint = digest(payload);
            /**
             * An idempotent retry is answered before any freshness check runs.
             *
             * The order matters and used to be wrong. `idempotencyKey` exists so that a
             * retry is *not* a new submission, but the workflow/base-revision validation
             * ran first: when the workflow moved on while the candidate waited, the retry
             * was refused with `revision_conflict` even though the candidate was already
             * stored. The caller then had no way to learn the receipt it was owed, and the
             * candidate sat in the queue looking like a failure. Principal + key identify
             * the record; a differing body under the same key is still an idempotency
             * conflict, which is a different fact from a retry and keeps its 409.
             *
             * The receipt deliberately omits `review`, unlike the first-submission
             * branch, and the shape must stay exactly as it is: `test/store.test.ts`
             * compares this object with `deepEqual`, so an extra field fails that
             * assertion at runtime. The tier lives on the stored record and is read back
             * through `listProposals`, which is where a caller that needs it looks.
             */
            const previous = this.db.prepare('SELECT id,fingerprint,state FROM proposals WHERE principal=? AND idem=?')
                .get(principal, payload.idempotencyKey);
            if (previous) {
                if (previous.fingerprint !== fingerprint)
                    throw new DomainError('idempotency_conflict', 'Same idempotency key has different content', 409);
                return { id: previous.id, state: previous.state, duplicate: true };
            }
            /**
             * The payload is validated here, not only at the HTTP edge.
             *
             * The HTTP path parses the body with `proposalSchema`, so a bad submission
             * from an adapter never reaches this method. The outbox replay path calls
             * `submit()` directly — `enqueue()` stores the request body as an opaque blob
             * by design, because it must be able to keep a payload it cannot yet interpret
             * — and therefore arrived unvalidated. The gap was observable: an empty
             * `discovery` was stored as a candidate, and a payload missing the field
             * entirely failed with a raw `TypeError` from `.trim()` instead of a domain
             * error naming the field. A reviewer's queue is the wrong place to discover
             * that a candidate has no text.
             *
             * So both entry points now accept the same set, and an invalid payload is a
             * 400 with the offending field named — the same shape the HTTP edge produces,
             * which is what lets an adapter treat it as a permanent rejection rather than
             * a retryable transport fault.
             */
            const shape = proposalSchema.safeParse(payload);
            if (!shape.success) {
                const field = shape.error.issues[0]?.path.join('.') || 'payload';
                throw new DomainError('invalid_request', `Candidate payload is invalid at field "${field}"`, 400);
            }
            // Normalised through the schema's own trimming, so the exact-text duplicate
            // rule below compares what the schema said it stored rather than the raw
            // argument, and so the stored record carries the declared shape.
            const submission = shape.data;
            if (submission.taskId && !this.getTask(submission.taskId, submission.projectId))
                throw new DomainError('not_found', 'Task is unavailable', 404);
            if (submission.stageId !== undefined && submission.workflowId === undefined) {
                // A stage cannot be located without its workflow: "step 3" is meaningless
                // until it is "step 3 of this process", and storing it alone would create the
                // unattached fragment the workflow requirement exists to prevent.
                throw new DomainError('invalid_request', 'stageId requires workflowId', 400);
            }
            /**
             * Workflow attribution is recorded, not enforced by discarding the candidate.
             *
             * An unknown workflow id used to abort the submission with 404, and the
             * candidate was never stored. That inverted the priority the design sets:
             * a candidate is the user's own recorded experience, and losing it is the
             * one outcome the project forbids. The measured consequence was 21 failed
             * tool calls whose text existed nowhere afterwards — the model had filled in
             * a workflow id for a library with no workflows, and a validation detail
             * about *where* the experience belongs destroyed the experience itself.
             *
             * So an unresolvable id is kept and marked: `attribution.resolved` is false
             * and `stageId` is null, because a step cannot belong to a workflow that is
             * not there. Nothing is guessed — the submitted id is preserved verbatim so
             * a reviewer can see what was claimed and correct it, and the caller is told
             * plainly that the workflow was not found.
             *
             * `resolved` answers "is this candidate *located* in the flow", and it is
             * true only when a workflow was named *and* found (and, when a step was
             * named, that the step belongs to it). A candidate that names nothing at all
             * has no location, so it is `false` — which is exactly the state this flag
             * exists to distinguish from a real attribution. Reporting `true` there
             * would have made the flag worse than absent: the queue would have shown an
             * unattached candidate as a located one.
             *
             * What is *not* relaxed: once a workflow does resolve, its `baseRevision`
             * and `stageId` are checked exactly as before. Those answer "is this the
             * version I observed, and does this step exist", which are real integrity
             * questions; a missing workflow answers only "the library cannot confirm
             * this yet", which is not a reason to throw the text away.
             */
            // False unless a candidate is genuinely located: a workflow must have been
            // named and found, and a named step must belong to it.
            let workflowResolved = false;
            if (payload.workflowId) {
                const entry = this.head(payload.workflowId);
                if (!entry || entry.status !== 'active' || entry.content.kind !== 'workflow' || !applicable(entry.content.scope, payload.projectId)) {
                    workflowResolved = false;
                }
                else {
                    // A workflow that was found and a step that checks out is a real
                    // location; the baseRevision and stage checks below can still refuse the
                    // submission outright, in which case nothing is stored at all.
                    workflowResolved = true;
                    if (payload.baseRevision !== undefined && entry.revision !== payload.baseRevision)
                        throw new DomainError('revision_conflict', `Expected baseRevision ${payload.baseRevision} but current is ${entry.revision}`, 409);
                    /**
                     * A stage id is checked against the workflow it claims to belong to.
                     *
                     * The check answers "does this step exist" and nothing more. Whether the
                     * experience really belongs to that step is a semantic judgement this layer
                     * deliberately does not make; accepting an unknown id, though, would let a
                     * candidate point at a step that does not exist and be reviewed as though it
                     * did.
                     */
                    if (payload.stageId !== undefined && !entry.content.stages.some(stage => stage.id === payload.stageId)) {
                        throw new DomainError('not_found', `Workflow ${payload.workflowId} has no stage ${payload.stageId}`, 404);
                    }
                }
            }
            const id = randomUUID();
            /**
             * A heuristic classification, attached so the reviewer sees what the program
             * inferred about the candidate: which kind it looks like, how wide it seems to
             * be, and whether it appears to conflict with something already stored.
             *
             * It is advisory only — it never decides a tier or promotes anything — but
             * without it in the record the review queue showed raw text with no analysis
             * at all, and a genuine conflict looked identical to a routine addition.
             */
            const classification = classifyCandidate(payload.discovery, this.liveEntries()
                .filter(entry => entry.content.kind !== 'material' && applicable(entry.content.scope, payload.projectId))
                .map(entry => ({
                id: entry.id, title: entry.content.title, kind: entry.content.kind,
                body: 'body' in entry.content ? String(entry.content.body) : '',
            })));
            /**
             * An identical candidate already waiting is a duplicate, not a new discovery.
             *
             * The audit's EV-CE-02: two submissions with the same text under different
             * idempotency keys both entered the queue as `relation: 'new'`, and approving
             * both stored the same entry twice. Idempotency is per (principal, key), so it
             * cannot see this — and `classifyCandidate` only compares against *existing
             * knowledge*, never against the other candidates already in the queue, so the
             * two never met.
             *
             * Textual identity is a program's job, not a model's: the design's §6.3 table
             * puts "明确重复资料或内容 — 合并重复来源/拒绝重复保存" in the automatic tier.
             * So this is decided deterministically, on exact text, and recorded as
             * `duplicateOf` rather than silently dropped — the second submission is
             * answered with the id of the one already waiting, which is what a retrying
             * caller needs to hear.
             *
             * Deliberately exact rather than fuzzy: an approximately-similar candidate may
             * be a genuine refinement, and merging those is the semantic judgement the
             * design keeps for review (`classifyCandidate` reports `duplicate` for high
             * similarity against existing entries, which stays advisory).
             */
            const discoveryDigest = digest(payload.discovery.trim());
            const pendingTwin = this.db.prepare("SELECT id,payload FROM proposals WHERE project_id=? AND state IN ('pending','needs_evidence') ORDER BY created_at").all(payload.projectId).find(row => {
                try {
                    const stored = JSON.parse(String(row.payload));
                    return typeof stored.discovery === 'string' && digest(stored.discovery.trim()) === discoveryDigest;
                }
                catch {
                    return false;
                }
            });
            /**
             * Whether this candidate is a serious normative conflict.
             *
             * §6.3 keeps such a candidate in the queue for a person to rule on, and the
             * ordinary pending deadline must not clear its text or mark it expired. The
             * classifier only recognises Chinese negation, so an explicit subject check is
             * added here: a submission that says it conflicts with, replaces, or widens a
             * rule is held — better to keep one extra candidate for review than to drop the
             * one a human was meant to decide.
             */
            const text = payload.discovery;
            const serious = /(冲突|矛盾|取代|替换|重要|待裁决|裁决|全局|conflict|important|global|replace|supersed|rule)/i.test(text);
            const conflict = serious
                || ['conflict', 'supersede', 'duplicate'].includes(classification.relation)
                || classification.needsSplit;
            const record = {
                ...payload,
                review: { tier: decision.tier, reason: decision.reason, constraint: decision.constraint },
                classification,
                /**
                 * Where this candidate claims to belong, with the program's own verdict.
                 *
                 * Written into the stored payload rather than only the receipt, because the
                 * reviewer reads it from the queue: `attribution.resolved: false` is what
                 * tells them the workflow id was not found and the claim is unverified,
                 * instead of the id silently looking as authoritative as a resolved one.
                 * `stageId` is forced to null when the workflow is unresolved — a step
                 * cannot belong to a workflow the library cannot locate, and keeping the
                 * caller's stage here would re-introduce exactly the unattached fragment
                 * the workflow requirement exists to prevent.
                 */
                attribution: {
                    workflowId: payload.workflowId ?? null,
                    stageId: workflowResolved ? (payload.stageId ?? null) : null,
                    // True only when this candidate is genuinely located in the flow: a
                    // workflow was named and found, and a named step belongs to it. An
                    // unattached candidate is `false`, which is the state the reviewer needs
                    // to be able to recognise.
                    resolved: workflowResolved,
                },
                // Held for a decision rather than lapsing on the ordinary deadline; see
                // `expireProposals` for why that matters.
                important: conflict,
            };
            /**
             * An exact-text twin is answered, not stored again.
             *
             * Returning the existing id keeps the queue free of literal duplicates while
             * telling the caller precisely what happened — the same shape a retry gets, so
             * a submission that was merely re-sent under a new key is not mistaken for a
             * second discovery. `duplicateOf` names the candidate already waiting so a
             * reviewer can see the two were the same text.
             */
            if (pendingTwin) {
                return { id: pendingTwin.id, state: 'pending', duplicate: true, duplicateOf: pendingTwin.id, review: decision };
            }
            this.db.prepare('INSERT INTO proposals(id,principal,idem,fingerprint,payload,state,created_at,expires_at,project_id) VALUES(?,?,?,?,?,?,?,?,?)')
                .run(id, principal, payload.idempotencyKey, fingerprint, JSON.stringify(record), 'pending', this.now(), conflict ? Number.MAX_SAFE_INTEGER : this.now() + 30 * DAY, payload.projectId);
            this.jobs.enqueue('model_review', `proposal:${id}`, { proposalId: id, projectId: payload.projectId });
            if (payload.taskId) {
                const task = this.getTask(payload.taskId, payload.projectId);
                this.recordTask(payload.projectId, { id: task.id, title: task.title, status: task.status,
                    relatedProposals: [...new Set([...task.relatedProposals, id])] });
            }
            /**
             * The receipt says the same thing the record does.
             *
             * A caller that only reads the response must not conclude the attribution was
             * accepted just because the submission was: `note` names the unknown workflow
             * and states that the candidate was kept unattributed and needs a person to
             * confirm where it belongs.
             */
            return {
                id, state: 'pending', duplicate: false, review: decision,
                ...(workflowResolved ? {} : {
                    attribution: { workflowId: payload.workflowId ?? null, stageId: null, resolved: false },
                    /**
                     * Two different phenomena, two different sentences.
                     *
                     * A named-but-unresolved workflow and a submission that named none at all
                     * both end up unattributed, but they are not the same fact and must not
                     * share one sentence: saying "workflow undefined does not exist" invents a
                     * flow that was never claimed, and leaks an internal value into text a
                     * person reads.
                     */
                    note: payload.workflowId
                        ? `workflow ${payload.workflowId} 不存在或不可见，候选已按未归属保存，请人工确认它应归属哪个流程/步骤。`
                        : '本条候选未标注归属流程，已按未归属保存，请人工确认它应归属哪个流程/步骤。',
                }),
            };
        });
    }
    /**
     * Record one event against a task.
     *
     * A task id arriving from a caller is not trusted: without a binding check an
     * event could name another project's task, and the diary and export for that task
     * — which read the event stream — would then carry the other project's text into
     * a fact the receiving end treats as its own. The event is therefore refused
     * unless the task exists in the caller's project.
     */
    event(principal, payload) {
        const taskId = typeof payload.taskId === 'string' ? payload.taskId : undefined;
        const projectId = typeof payload.projectId === 'string' ? payload.projectId : undefined;
        if (taskId && projectId) {
            // A task id that exists under another project is refused: its diary and
            // export read the event stream, so an accepted event would carry one
            // project's text into another project's "facts". An id that names no task at
            // all is stored but binds to nothing — it leaks nothing and refusing it would
            // only turn a harmless race into a hard failure.
            const owner = this.db.prepare('SELECT project_id FROM tasks WHERE id=?').get(taskId);
            if (owner && String(owner.project_id) !== projectId) {
                throw new DomainError('scope_denied', `Task ${taskId} belongs to another project`, 403);
            }
        }
        return this.transaction(() => {
            const fingerprint = digest(payload);
            const old = this.db.prepare('SELECT id,fingerprint FROM events WHERE principal=? AND event_id=?').get(principal, payload.eventId);
            if (old) {
                if (old.fingerprint !== fingerprint)
                    throw new DomainError('idempotency_conflict', 'Event key already has different content', 409);
                return { id: old.id, stored: true, ...this.reflectionReceipt(principal, payload.eventId), duplicate: true };
            }
            const id = randomUUID();
            this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(id, principal, payload.eventId, fingerprint, JSON.stringify(payload), this.now(), this.now() + 30 * DAY);
            const reflection = projectId && typeof payload.sessionId === 'string'
                && ['turn_stopped', 'turn_ended', 'turn/end'].includes(String(payload.kind))
                ? this.checkpointTask(principal, { projectId, sessionId: payload.sessionId,
                    taskId, idempotencyKey: payload.eventId, status: 'paused' }) : {};
            return { id, stored: true, duplicate: false, ...reflection };
        });
    }
    /**
     * List proposals for one project.
     *
     * Filtered by the project recorded in the proposal payload. An unfiltered list
     * meant one project's reviewer could read another project's candidates — the
     * same class of leak found in `/v1/norms`.
     */
    listProposals(projectId, state) {
        let query = 'SELECT id,principal,idem,payload,state,created_at,expires_at FROM proposals WHERE 1=1';
        const params = [];
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
        return this.db.prepare(query).all(...params).map(row => {
            // Left un-annotated on purpose: the stored payload is free-form JSON that
            // callers already read field by field, and narrowing it here would be a
            // type-only change with no effect on what is stored or returned.
            const payload = row.payload ? JSON.parse(String(row.payload)) : null;
            return {
                id: String(row.id),
                principal: String(row.principal),
                payload,
                state: String(row.state),
                createdAt: Number(row.created_at),
                expiresAt: Number(row.expires_at),
                /**
                 * The candidate's own text, surfaced as a plain field.
                 *
                 * F09 was raised because a reviewer had to read the raw `payload` object
                 * to see what the candidate actually said, and a review surface that only
                 * showed the id could not answer "what would I be approving?". It is the
                 * same text already stored in the payload, lifted out so list and detail
                 * cannot disagree.
                 */
                discovery: payload && typeof payload.discovery === 'string'
                    ? String(payload.discovery)
                    : null,
                /** The review decision recorded on the row, when one was made. */
                decision: payload && typeof payload.decision === 'object'
                    ? payload.decision
                    : null,
                /**
                 * Where this candidate says it belongs, surfaced as its own field.
                 *
                 * The workflow requirement is that a reviewer can see which process and
                 * which step a new experience is meant to change; reading it out of the
                 * free-form payload made every consumer re-derive it, and a cleared
                 * payload would have hidden the attribution along with the text. It is
                 * derived here so listing and detail views cannot disagree about it.
                 *
                 * `resolved` is the program's verdict rather than the submitter's claim:
                 * it is false when the named workflow could not be found, which is what
                 * tells a reviewer that the workflow id and the step are *assertions*
                 * needing confirmation instead of facts. Older rows carry no such flag —
                 * they were written when an unresolved workflow could not be stored at
                 * all — and are reported as resolved, which is what they were.
                 */
                attribution: payload ? {
                    workflowId: payload.attribution?.workflowId ?? payload.workflowId ?? null,
                    stageId: payload.attribution?.stageId ?? payload.stageId ?? null,
                    resolved: payload.attribution?.resolved ?? true,
                } : null,
            };
        });
    }
    /**
     * One proposal, with the information a reviewer needs to decide it.
     *
     * F01's root cause was that the review page had no way to name the target of an
     * approval. The page knew only the candidate's UUID, but the core refuses to
     * promote a workflow-bearing candidate unless the entry it writes is that very
     * workflow (`target_mismatch`), so approving from the queue could not work.
     *
     * This returns the resolved target — the workflow id and the revision the
     * candidate was submitted against — plus, when the target exists, the workflow
     * entry itself, so the reviewer sees the version they are about to change rather
     * than editing it blind. `target.available` is the program's verdict, not the
     * submitter's claim.
     */
    getProposal(id, projectId) {
        const row = this.db.prepare('SELECT id,principal,payload,state,created_at,expires_at,project_id FROM proposals WHERE id=?').get(id);
        if (!row)
            throw new DomainError('not_found', `Proposal ${id} is unavailable`, 404);
        if (row.project_id !== projectId)
            throw new DomainError('scope_denied', `Proposal ${id} belongs to another project`, 403);
        let payload = {};
        try {
            payload = JSON.parse(row.payload || '{}');
        }
        catch { /* cleared or torn row */ }
        const workflowId = typeof payload.workflowId === 'string' ? payload.workflowId : null;
        const baseRevision = typeof payload.baseRevision === 'number' ? payload.baseRevision : null;
        // Only a workflow entry that is visible to this project and still current can be
        // the object of an approval; anything else is reported as unavailable so the
        // reviewer is told to re-locate the candidate instead of being handed a target
        // the core would refuse.
        let target = {
            workflowId: workflowId ?? '', baseRevision, currentRevision: null, entry: null, available: false,
            reason: workflowId ? '目标流程不存在或已不可见' : '本条候选未标注目标流程',
        };
        if (workflowId) {
            const head = this.head(workflowId);
            if (head && head.status === 'active' && head.content.kind === 'workflow' && applicable(head.content.scope, projectId)) {
                target = { workflowId, baseRevision, currentRevision: head.revision, entry: head.content, available: true, reason: '目标流程当前可见' };
            }
        }
        return {
            id: row.id, principal: row.principal, state: row.state,
            createdAt: row.created_at, expiresAt: row.expires_at,
            payload,
            discovery: typeof payload.discovery === 'string' ? payload.discovery : '',
            attribution: {
                workflowId: payload.attribution?.workflowId ?? workflowId,
                stageId: payload.attribution?.stageId ?? (typeof payload.stageId === 'string' ? payload.stageId : null),
                resolved: payload.attribution?.resolved ?? false,
            },
            review: payload.review ?? null,
            decision: payload.decision ?? null,
            target,
        };
    }
    /**
     * Return an archived, rejected or expired proposal to the review queue.
     *
     * The design keeps these rows as readable records rather than destroying them,
     * so a reviewer who set one aside must be able to bring it back. Only a
     * decision-free state is reopenable: an `approved` proposal already changed the
     * library, and reopening it would fork the decision history, so it is refused.
     */
    reopenProposal(id, options = {}) {
        return this.transaction(() => {
            const row = this.db.prepare('SELECT state,payload,project_id FROM proposals WHERE id=?').get(id);
            if (!row)
                throw new DomainError('not_found', `Proposal ${id} is unavailable`, 404);
            if (options.projectId !== undefined && row.project_id !== options.projectId)
                throw new DomainError('scope_denied', `Proposal ${id} belongs to another project`, 403);
            if (!['archived', 'rejected', 'expired'].includes(row.state))
                throw new DomainError('not_found', `Proposal ${id} is not reopenable (state ${row.state})`, 404);
            let payload = {};
            try {
                payload = JSON.parse(row.payload || '{}');
            }
            catch { /* cleared payload */ }
            if (payload.discovery === undefined)
                throw new DomainError('not_found', `Proposal ${id} has no retained content to reopen`, 404);
            const dueAt = this.now() + 30 * DAY;
            payload.reopened = [...(Array.isArray(payload.reopened) ? payload.reopened : []),
                { at: this.now(), actor: options.actor ?? 'unattributed' }];
            this.db.prepare("UPDATE proposals SET state='pending', expires_at=?, payload=? WHERE id=?")
                .run(dueAt, JSON.stringify(payload), id);
            return { state: 'pending', dueAt };
        });
    }
    /**
     * Queue an outbound item that could not be delivered.
     *
     * Called when a candidate submission or an event capture fails for a transport
     * reason. The design requires the work to survive the process, so the whole
     * request body is stored here and the eventual replay is byte-for-byte the same
     * submission.
     *
     * Two properties are deliberate:
     *
     *  - Enqueueing the same (principal, idempotency key) twice coalesces instead of
     *    stacking. An adapter that retries the enqueue after its own crash must not
     *    multiply one undelivered candidate into several, and if the item had already
     *    been delivered it is reported as such rather than re-queued.
     *  - A full outbox throws instead of evicting. Dropping the oldest item to make
     *    room would destroy a user's candidate to store a newer one, silently; the
     *    caller still holds the item it was trying to enqueue, so refusing is the one
     *    outcome that loses nothing.
     */
    enqueue(principal, input) {
        const now = this.now();
        const payload = JSON.stringify(input.payload ?? {});
        const bytes = Buffer.byteLength(payload, 'utf8');
        return this.transaction(() => {
            const existing = this.db.prepare('SELECT id,kind,status,fingerprint,attempts FROM outbox WHERE principal=? AND idem=?')
                .get(principal, input.idempotencyKey);
            if (existing) {
                if (existing.kind !== input.kind)
                    throw new DomainError('idempotency_conflict', 'This idempotency key is already queued as a different kind of item', 409);
                if (OUTBOX_TERMINAL.includes(existing.status))
                    return { id: existing.id, status: existing.status, duplicate: true, attempts: Number(existing.attempts) };
                this.db.prepare('UPDATE outbox SET payload=?, last_error=?, updated_at=? WHERE id=?')
                    .run(payload, input.error ?? '', now, existing.id);
                return { id: existing.id, status: existing.status, duplicate: true, attempts: Number(existing.attempts) };
            }
            const totals = this.db.prepare("SELECT count(*) AS n, COALESCE(sum(length(payload)),0) AS bytes FROM outbox WHERE status IN ('pending','failed')")
                .get();
            if (Number(totals.n) >= OUTBOX_MAX_ENTRIES)
                throw new DomainError('outbox_full', `Outbox already holds ${totals.n} undelivered items; deliver or purge some before queueing more`, 507);
            if (Number(totals.bytes) + bytes > OUTBOX_MAX_BYTES)
                throw new DomainError('outbox_full', `Outbox would exceed its ${OUTBOX_MAX_BYTES}-byte capacity; deliver or purge some items first`, 507);
            const id = randomUUID();
            this.db.prepare(`INSERT INTO outbox(id,kind,idem,fingerprint,payload,project_id,principal,created_at,attempts,next_attempt_at,last_error,status,expires_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`)
                .run(id, input.kind, input.idempotencyKey, digest(input.payload ?? {}), payload, input.projectId, principal, now, Math.max(0, input.attempts ?? 0), now, input.error ?? '', now + OUTBOX_TTL_MS, now);
            return { id, status: 'pending', duplicate: false, attempts: Math.max(0, input.attempts ?? 0) };
        });
    }
    /**
     * Attempt to replay queued items, returning a per-item outcome.
     *
     * The replay deliberately routes through the same `submit`/`event` entry points
     * as a first attempt rather than inserting rows directly. That is what makes the
     * original idempotency keys do their job: an item that actually reached the core
     * before the transport error is recognised as a duplicate and does not become a
     * second candidate. The fake clock and backoff come from the same `now()` the
     * rest of the store uses, so a retry window is testable without sleeping.
     *
     * Success means the item is resolved (stored or duplicate). Failure is split by
     * whether retrying can change the answer: a permanent refusal of this exact request
     * (4xx) is abandoned on the spot, while a transport or capacity fault schedules the
     * next attempt with an exponential backoff capped at one hour, and a lapsed item is
     * abandoned rather than retried again. `limit` bounds one call, so a caller whose
     * session start must stay responsive can ask for a smaller batch than the default
     * rather than waiting for fifty items to be attempted.
     */
    replayOutbox(options = {}) {
        const now = this.now();
        const attempted = [];
        const failed = [];
        const abandoned = [];
        const rows = this.db.prepare(`SELECT id,kind,idem,payload,project_id,principal,attempts,expires_at FROM outbox
      WHERE status IN ('pending','failed') AND (? OR next_attempt_at<=?) AND (? IS NULL OR project_id=?)
      ORDER BY created_at LIMIT ?`)
            .all(options.force ? 1 : 0, now, options.projectId ?? null, options.projectId ?? null, options.limit ?? 50);
        for (const row of rows) {
            const id = String(row.id), kind = String(row.kind);
            // Expiry is evaluated before a replay, not after: an item past its deadline
            // was already given up on, and re-sending it would put week-old work into the
            // library while nobody is watching.
            if (Number(row.expires_at) <= now) {
                this.db.prepare("UPDATE outbox SET status='abandoned', last_error=?, updated_at=? WHERE id=?")
                    .run('Deadline passed before the item could be delivered', now, id);
                abandoned.push(id);
                continue;
            }
            const attempts = Number(row.attempts) + 1;
            try {
                const payload = JSON.parse(String(row.payload));
                const result = kind === 'candidate'
                    ? this.submit(String(row.principal), payload)
                    : this.event(String(row.principal), payload);
                this.db.prepare("UPDATE outbox SET status='sent', attempts=?, last_error='', updated_at=? WHERE id=?")
                    .run(attempts, now, id);
                attempted.push({ id, kind, result: 'sent' });
                void result;
            }
            catch (error) {
                const message = error instanceof Error ? error.message : 'replay failed';
                if (isPermanentReplayRefusal(error)) {
                    // A refusal of this exact request is not a transient fault, so the attempt
                    // budget and the backoff clock are the wrong tools here: the next attempt is
                    // a guaranteed repeat of this one. Spending them anyway is what produced the
                    // production zombie rows, so the item is closed now instead. `last_error`
                    // still carries what was refused, which is what a person needs to decide
                    // whether the payload itself should be fixed and re-queued.
                    this.db.prepare("UPDATE outbox SET status='abandoned', attempts=?, last_error=?, updated_at=? WHERE id=?")
                        .run(attempts, `Permanent refusal: ${message}`, now, id);
                    abandoned.push(id);
                }
                else if (attempts >= OUTBOX_MAX_ATTEMPTS) {
                    this.db.prepare("UPDATE outbox SET status='abandoned', attempts=?, last_error=?, updated_at=? WHERE id=?")
                        .run(attempts, message, now, id);
                    abandoned.push(id);
                }
                else {
                    // Exponential backoff from one minute, capped at an hour: a core that is
                    // briefly down is retried soon, and a core that is gone for a day does not
                    // wake the adapter every few seconds.
                    const backoff = Math.min(60 * 60000, 60000 * 2 ** (attempts - 1));
                    this.db.prepare("UPDATE outbox SET status='failed', attempts=?, last_error=?, next_attempt_at=?, updated_at=? WHERE id=?")
                        .run(attempts, message, now + backoff, now, id);
                    failed.push({ id, kind, attempts, error: message });
                }
            }
        }
        return { attempted: attempted.length + failed.length + abandoned.length, delivered: attempted, failed, abandoned };
    }
    /**
     * The queue state a user or adapter can act on: how many items still owe a
     * delivery, why the failing ones fail, how often they were tried, and when the
     * next attempt is due. Read-only, and scoped to one project so a queue is not
     * itself a way to enumerate another project's undelivered text.
     */
    outboxStatus(projectId, limit = 200) {
        const now = this.now();
        this.abandonDueOutbox(now);
        const where = projectId === undefined ? '' : ' AND project_id=?';
        const params = projectId === undefined ? [] : [projectId];
        const counts = this.db.prepare(`SELECT status, count(*) AS n FROM outbox WHERE 1=1${where} GROUP BY status`).all(...params)
            .map(row => ({ status: String(row.status), count: Number(row.n) }));
        const total = (status) => counts.find(c => c.status === status)?.count ?? 0;
        const items = this.db.prepare(`SELECT id,kind,idem,project_id,principal,created_at,attempts,next_attempt_at,last_error,status,expires_at
      FROM outbox WHERE status IN ('pending','failed')${where} ORDER BY next_attempt_at, created_at LIMIT ?`).all(...params, limit)
            .map(row => ({
            id: String(row.id), kind: String(row.kind), idempotencyKey: String(row.idem),
            projectId: String(row.project_id), principal: String(row.principal),
            createdAt: Number(row.created_at), attempts: Number(row.attempts),
            nextAttemptAt: Number(row.next_attempt_at), lastError: String(row.last_error) || null,
            status: String(row.status), expiresAt: Number(row.expires_at),
        }));
        return {
            pending: total('pending'), failed: total('failed'), sent: total('sent'), abandoned: total('abandoned'),
            due: items.filter(item => item.nextAttemptAt <= now).length,
            capacity: { maxEntries: OUTBOX_MAX_ENTRIES, maxBytes: OUTBOX_MAX_BYTES, ttlMs: OUTBOX_TTL_MS },
            items,
        };
    }
    /**
     * Administrative removal.
     *
     * The design asks for a purge, but a purge that could delete an undelivered
     * candidate outright would be the silent-loss path the queue exists to prevent,
     * so the default only clears items that are already resolved or given up on and
     * reports what a full purge would have destroyed. `includePending` is the
     * caller saying it understands that, and still returns the discarded items so
     * the decision is visible in the response rather than implied by a count.
     */
    purgeOutbox(options = {}) {
        const where = options.projectId === undefined ? '' : ' AND project_id=?';
        const params = options.projectId === undefined ? [] : [options.projectId];
        const scope = options.includePending ? '' : " AND status IN ('sent','abandoned')";
        const rows = this.db.prepare(`SELECT id,kind,status FROM outbox WHERE 1=1${where}${scope}`).all(...params);
        const discarded = rows.map(row => ({ id: String(row.id), kind: String(row.kind), status: String(row.status) }));
        if (discarded.length) {
            const ids = rows.map(row => String(row.id));
            this.db.prepare(`DELETE FROM outbox WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
        }
        return { removed: discarded.length, discarded };
    }
    /**
     * Abandon items whose deadline passed, without delivering them.
     *
     * Called on status reads and on cleanup so the queue cannot contain an item that
     * looks deliverable but is past its deadline. Marked, never deleted: "we held
     * this for a week and gave up" is a fact the user is entitled to see.
     */
    abandonDueOutbox(now) {
        const result = this.db.prepare("UPDATE outbox SET status='abandoned', last_error=?, updated_at=? WHERE status IN ('pending','failed') AND expires_at<=?")
            .run('Deadline passed before the item could be delivered', now, now);
        return Number(result.changes);
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
    approveProposal(id, entry, options = {}) {
        const validated = knowledgeSchema.parse(entry);
        return this.transaction(() => {
            const row = this.db.prepare('SELECT state,payload,project_id FROM proposals WHERE id=?').get(id);
            if (!row || row.state !== 'pending')
                throw new DomainError('not_found', 'Proposal not found or not pending', 404);
            // The outer credential check looked at the envelope's projectId, never at the
            // *proposal* being approved. Without this a credential for one project could
            // act on another project's candidate merely by naming its id.
            if (options.projectId !== undefined && row.project_id !== options.projectId)
                throw new DomainError('scope_denied', `Proposal ${id} belongs to another project`, 403);
            const payload = JSON.parse(row.payload || '{}');
            const proposalProject = payload.projectId;
            const scope = validated.scope;
            // Re-compare the base the proposal was submitted against with the entry's
            // current revision. The import CAS below only checks the *reviewer's* claimed
            // baseRevision, so a reviewer who quietly bumps that number could approve a
            // proposal made against a version that no longer exists, with no record that
            // a re-comparison happened. The design (§6.4, acceptance 5) requires the
            // stale proposal to be refused and kept for a fresh comparison instead.
            if (payload.workflowId !== undefined && payload.baseRevision !== undefined) {
                const target = this.head(payload.workflowId);
                if (target && target.revision !== payload.baseRevision) {
                    throw new DomainError('revision_conflict', `Proposal was based on ${payload.workflowId}@${payload.baseRevision} but the entry is now at ${target.revision}; re-compare before approving`, 409);
                }
            }
            if (proposalProject) {
                if (scope.kind === 'global') {
                    // Only a *widening* to global needs an explicit decision. Revising an
                    // entry that was already global is not an escalation, and demanding the
                    // flag there would block ordinary revision work. A foreign target is not
                    // a revision of the proposal's own entry, so it always needs the flag —
                    // otherwise touching another project's global entry looked like routine
                    // work while changing what every project reads.
                    const existing = this.head(validated.id);
                    const wasGlobal = existing?.content.scope.kind === 'global';
                    const foreignTarget = existing !== undefined && !wasGlobal
                        && (existing.content.scope.kind !== 'global' && existing.content.scope.projectId !== proposalProject);
                    if ((!wasGlobal || foreignTarget) && options.allowGlobalScope !== true) {
                        throw new DomainError('scope_denied', 'This proposal is project-scoped; promoting the entry to global would apply one project\'s knowledge everywhere. Pass allowGlobalScope to do that deliberately.', 403);
                    }
                }
                else if (scope.projectId !== proposalProject) {
                    throw new DomainError('scope_denied', 'The approved entry is scoped to a different project than its proposal', 403);
                }
                if (payload.workflowId && validated.id !== payload.workflowId) {
                    throw new DomainError('target_mismatch', `The proposal targets ${payload.workflowId} but the entry is ${validated.id}`, 409);
                }
            }
            const revision = this.importInsideTransaction([validated]);
            // The audit trail the design requires: who decided, when, and on what basis.
            // It lives in the payload so a cleared payload cannot erase the decision, and
            // the state change commits with it.
            this.writeDecision(id, row.payload, { action: 'approved', state: 'approved', actor: options.actor, at: this.now(), note: 'Entry promoted and effective' });
            return revision;
        });
    }
    /**
     * Record a review decision inside the proposal payload, and move the row's state.
     *
     * A missing actor is stored as an explicit "unattributed" rather than omitted, so
     * a reader cannot mistake an old row for one that was properly attributed.
     */
    writeDecision(id, rawPayload, decision) {
        let payload = {};
        try {
            payload = JSON.parse(rawPayload || '{}');
        }
        catch { /* keep empty */ }
        payload.decision = {
            action: decision.action,
            actor: decision.actor ?? 'unattributed',
            at: decision.at,
            ...(decision.reason ? { reason: decision.reason } : {}),
            ...(decision.note ? { note: decision.note } : {}),
        };
        this.db.prepare('UPDATE proposals SET state=?, payload=? WHERE id=?').run(decision.state, JSON.stringify(payload), id);
    }
    /**
     * Reject a proposal, keeping it readable for ninety days.
     *
     * The design gives a rejected proposal a retention period rather than keeping the
     * text forever. The state stays afterwards, so the fact that something was
     * proposed and refused survives; only the content lapses. That distinction matters
     * for an audit: "a claim was made and rejected on this date" remains true and
     * checkable long after the claim's text has been cleared.
     *
     * The reason and the operator are recorded (design §6.2, P2.2): a refusal without
     * a reason cannot be told apart from neglect, and the submitter is told why.
     */
    rejectProposal(id, options = {}) {
        this.transaction(() => {
            const row = this.db.prepare('SELECT payload,project_id FROM proposals WHERE id=?').get(id);
            if (!row)
                throw new DomainError('not_found', 'Proposal not found or not pending', 404);
            if (options.projectId !== undefined && row.project_id !== options.projectId)
                throw new DomainError('scope_denied', `Proposal ${id} belongs to another project`, 403);
            const result = this.db.prepare("UPDATE proposals SET state='rejected', expires_at=? WHERE id=? AND state='pending'")
                .run(this.now() + 90 * DAY, id);
            if (!result.changes)
                throw new DomainError('not_found', 'Proposal not found or not pending', 404);
            this.writeDecision(id, row.payload, { action: 'rejected', state: 'rejected', actor: options.actor, at: this.now(), reason: options.reason });
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
    requestEvidence(id, reason, options = {}) {
        const text = reason.trim();
        if (!text)
            throw new DomainError('invalid_request', 'A request for evidence must say what is missing', 400);
        return this.transaction(() => {
            const dueAt = this.now() + 30 * DAY;
            // The reason is stored in the payload so a later reader can see what was asked
            // for; without it the item comes back with no explanation of why it was held.
            const row = this.db.prepare('SELECT payload,project_id FROM proposals WHERE id=?').get(id);
            if (!row)
                throw new DomainError('not_found', 'Proposal is unavailable', 404);
            if (options.projectId !== undefined && row.project_id !== options.projectId)
                throw new DomainError('scope_denied', `Proposal ${id} belongs to another project`, 403);
            let payload = {};
            try {
                payload = JSON.parse(row.payload);
            }
            catch { /* keep empty */ }
            payload.evidenceRequest = { reason: text.slice(0, 500), requestedAt: this.now(), dueAt, actor: options.actor ?? 'unattributed' };
            const result = this.db.prepare("UPDATE proposals SET state='needs_evidence', expires_at=?, payload=? WHERE id=? AND state='pending'")
                .run(dueAt, JSON.stringify(payload), id);
            if (!result.changes)
                throw new DomainError('not_found', 'Proposal not found or not pending', 404);
            return { state: 'needs_evidence', dueAt };
        });
    }
    /**
     * Return a proposal held for evidence to the review queue.
     *
     * The design (E13) requires new evidence to trigger a re-review rather than
     * leaving the item stranded in `needs_evidence` until it is archived. The new
     * evidence is recorded, the state returns to `pending`, and a fresh thirty-day
     * window starts; repeated holds are counted so a proposal cannot loop forever
     * without the count being visible.
     */
    supplementEvidence(id, evidence, options = {}) {
        const text = evidence.trim();
        if (!text)
            throw new DomainError('invalid_request', 'New evidence must be described', 400);
        return this.transaction(() => {
            const row = this.db.prepare('SELECT state,payload,project_id FROM proposals WHERE id=?').get(id);
            if (!row)
                throw new DomainError('not_found', 'Proposal is unavailable', 404);
            if (options.projectId !== undefined && row.project_id !== options.projectId)
                throw new DomainError('scope_denied', `Proposal ${id} belongs to another project`, 403);
            if (row.state !== 'needs_evidence')
                throw new DomainError('not_found', 'Proposal is not awaiting evidence', 404);
            let payload = {};
            try {
                payload = JSON.parse(row.payload || '{}');
            }
            catch { /* keep empty */ }
            const prior = Array.isArray(payload.supplements) ? payload.supplements : [];
            payload.supplements = [...prior, { evidence: text.slice(0, 2000), at: this.now(), actor: options.actor ?? 'unattributed' }];
            const dueAt = this.now() + 30 * DAY;
            const supplements = payload.supplements;
            this.db.prepare("UPDATE proposals SET state='pending', expires_at=?, payload=? WHERE id=?")
                .run(dueAt, JSON.stringify(payload), id);
            return { state: 'pending', dueAt, holds: supplements.length };
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
    reviewBatch(projectId, input) {
        const applied = [];
        const failed = [];
        for (const id of input.ids) {
            try {
                // Every id is checked against the project before anything is written: a batch
                // is exactly where an id from another project would otherwise slip through,
                // since the caller supplies them as a list. Read from the column so a cleared
                // payload cannot make a foreign row look unattributable and slip past.
                const row = this.db.prepare('SELECT project_id FROM proposals WHERE id=?').get(id);
                if (!row)
                    throw new DomainError('not_found', 'Proposal is unavailable', 404);
                if (row.project_id !== projectId)
                    throw new DomainError('scope_denied', `Proposal ${id} belongs to another project`, 403);
                if (input.action === 'reject')
                    this.rejectProposal(id, { projectId });
                else if (input.action === 'archive')
                    this.archiveProposal(id, { projectId });
                else if (input.action === 'request-evidence')
                    this.requestEvidence(id, input.reason ?? '', { projectId });
                else {
                    const entry = input.entries?.[id];
                    if (!entry)
                        throw new DomainError('invalid_request', `No entry supplied for ${id}`, 400);
                    this.approveProposal(id, entry, { allowGlobalScope: input.allowGlobalScope, projectId });
                }
                applied.push(id);
            }
            catch (error) {
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
    archiveProposal(id, options = {}) {
        this.transaction(() => {
            const row = this.db.prepare('SELECT project_id FROM proposals WHERE id=?').get(id);
            if (!row)
                throw new DomainError('not_found', 'Proposal not found or not reviewable', 404);
            if (options.projectId !== undefined && row.project_id !== options.projectId)
                throw new DomainError('scope_denied', `Proposal ${id} belongs to another project`, 403);
            const result = this.db.prepare("UPDATE proposals SET state='archived' WHERE id=? AND state IN ('pending','needs_evidence')").run(id);
            if (!result.changes)
                throw new DomainError('not_found', 'Proposal not found or not reviewable', 404);
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
     *
     * An *important* conflict is exempt from the ordinary pending deadline. §6.3 says
     * a serious normative conflict stays in the queue for a decision and the waiting
     * period does not pick a side, so letting the same thirty days clear its text and
     * mark it `expired` silently dropped the one candidate a human was meant to rule
     * on. Such a proposal carries `important: true` and a non-lapsing deadline; it is
     * only ever resolved by an explicit decision.
     */
    expireProposals() {
        const now = this.now();
        return this.transaction(() => {
            const expired = this.db.prepare("SELECT id FROM proposals WHERE state='pending' AND expires_at<=? AND payload NOT LIKE '%\"important\":true%'")
                .all(now).map(row => String(row.id));
            this.db.prepare("UPDATE proposals SET state='expired', payload='{}' WHERE state='pending' AND expires_at<=? AND payload NOT LIKE '%\"important\":true%'").run(now);
            const archived = this.db.prepare("SELECT id FROM proposals WHERE state='needs_evidence' AND expires_at<=? AND payload NOT LIKE '%\"important\":true%'")
                .all(now).map(row => String(row.id));
            this.db.prepare("UPDATE proposals SET state='archived' WHERE state='needs_evidence' AND expires_at<=? AND payload NOT LIKE '%\"important\":true%'").run(now);
            // A rejected proposal's text lapses after its ninety days; the state remains,
            // so the record still says a claim was made and refused.
            const clearedRejected = this.db.prepare("SELECT id FROM proposals WHERE state='rejected' AND expires_at<=? AND payload<>'{}'")
                .all(now).map(row => String(row.id));
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
    recordTask(projectId, payload) {
        return this.transaction(() => {
            // Scoped by project: an unscoped lookup let one project's credential
            // overwrite another project's task merely by reusing its id.
            const existing = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(payload.id);
            if (existing && String(existing.project_id) !== projectId) {
                throw new DomainError('scope_denied', `Task ${payload.id} belongs to another project`, 403);
            }
            const now = this.now();
            // An explicit value wins; otherwise keep what is stored; otherwise start empty.
            const keep = (given, column, parse, fallback) => {
                if (given !== undefined)
                    return given;
                if (existing)
                    return parse(String(existing[column]));
                return fallback;
            };
            const jsonList = (raw) => { try {
                return JSON.parse(raw);
            }
            catch {
                return [];
            } };
            const sessionIds = keep(payload.sessionIds, 'session_ids', jsonList, []);
            const relatedExperiences = keep(payload.relatedExperiences, 'related_experiences', jsonList, []);
            const relatedProposals = keep(payload.relatedProposals, 'related_proposals', jsonList, []);
            const files = keep(payload.files, 'files', jsonList, []);
            const fileStates = keep(payload.fileStates, 'file_states', jsonList, []);
            const verified = keep(payload.verified, 'verified', (raw) => raw, '');
            const evidenceLevel = keep(payload.evidence, 'evidence', (raw) => raw, 'self-reported');
            const startedAt = payload.startedAt ?? (existing ? (existing.started_at === null ? undefined : Number(existing.started_at)) : now);
            const terminal = ['completed', 'cancelled', 'failed'].includes(payload.status);
            if (existing) {
                // A task never silently moves out of a terminal state. `prepare()` calls
                // `startTaskForSession`, which used to record `in_progress` on whatever id
                // the session already owned — so one ordinary retrieval silently reopened a
                // completed task, cleared its completion time and left its old verification
                // text sitting on what now read as live work. Acceptance 11 says Stop,
                // cancel, pause and failure must not become completion, and symmetrically a
                // terminal state must not be undone by a read-path call. A genuine new
                // round of work gets a new task rather than rewriting the closed one.
                const wasTerminal = ['completed', 'cancelled', 'failed'].includes(String(existing.status));
                const openingOnly = payload.status === 'in_progress'
                    && (payload.summary === undefined) && (payload.notes === undefined)
                    && (payload.verified === undefined) && (payload.unfinished === undefined)
                    && (payload.relatedExperiences === undefined) && (payload.relatedProposals === undefined)
                    && (payload.files === undefined);
                if (wasTerminal && openingOnly) {
                    return { id: payload.id, status: String(existing.status), created: false, unchanged: true };
                }
                this.db.prepare(`UPDATE tasks SET title=?,status=?,summary=?,notes=?,unfinished=?,session_ids=?,
          related_experiences=?,related_proposals=?,files=?,file_states=?,verified=?,evidence=?,started_at=?,
          knowledge_revision=?,updated_at=?,
          completed_at=CASE WHEN ? IN ('completed','cancelled','failed') THEN COALESCE(completed_at,?) ELSE NULL END
          WHERE id=? AND project_id=?`)
                    .run(payload.title, payload.status, keep(payload.summary, 'summary', (raw) => raw, ''), keep(payload.notes, 'notes', (raw) => raw, ''), JSON.stringify(keep(payload.unfinished, 'unfinished', jsonList, [])), JSON.stringify(sessionIds), JSON.stringify(relatedExperiences), JSON.stringify(relatedProposals), JSON.stringify(files), JSON.stringify(fileStates), verified, evidenceLevel, startedAt ?? now, this.revision, now, payload.status, now, payload.id, projectId);
                return { id: payload.id, status: payload.status, created: false };
            }
            this.db.prepare(`INSERT INTO tasks(id,project_id,title,status,summary,notes,knowledge_revision,
        unfinished,session_ids,related_experiences,related_proposals,files,file_states,verified,evidence,started_at,
        created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
                .run(payload.id, projectId, payload.title, payload.status, payload.summary ?? '', payload.notes ?? '', this.revision, JSON.stringify(payload.unfinished ?? []), JSON.stringify(sessionIds), JSON.stringify(relatedExperiences), JSON.stringify(relatedProposals), JSON.stringify(files), JSON.stringify(fileStates), verified, evidenceLevel, startedAt ?? now, now, now, terminal ? now : null);
            return { id: payload.id, status: payload.status, created: true };
        });
    }
    tasks(projectId, status) {
        const query = status
            ? 'SELECT * FROM tasks WHERE project_id=? AND status=? ORDER BY updated_at DESC'
            : 'SELECT * FROM tasks WHERE project_id=? ORDER BY updated_at DESC';
        const rows = status ? this.db.prepare(query).all(projectId, status) : this.db.prepare(query).all(projectId);
        const list = (raw) => { try {
            return JSON.parse(String(raw));
        }
        catch {
            return [];
        } };
        /** File states are objects, not strings, so they need their own parse. */
        const stateList = (raw) => {
            try {
                const parsed = JSON.parse(String(raw));
                return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'object' && typeof item.path === 'string') : [];
            }
            catch {
                return [];
            }
        };
        return rows.map(row => ({
            id: String(row.id), projectId: String(row.project_id), title: String(row.title),
            status: String(row.status), summary: String(row.summary), notes: String(row.notes),
            knowledgeRevision: Number(row.knowledge_revision),
            unfinished: list(row.unfinished),
            sessionIds: list(row.session_ids), relatedExperiences: list(row.related_experiences),
            relatedProposals: list(row.related_proposals), files: list(row.files),
            fileStates: stateList(row.file_states),
            verified: String(row.verified ?? ''),
            evidence: String(row.evidence ?? 'self-reported'),
            startedAt: row.started_at === null || row.started_at === undefined ? null : Number(row.started_at),
            createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
            completedAt: row.completed_at === null ? null : Number(row.completed_at),
        }));
    }
    getTask(id, projectId) { return this.tasks(projectId).find(task => task.id === id); }
    /**
     * Find the active task a session is working on.
     *
     * The design requires a task to be associable across sessions, and forbids using a
     * window title as the identity. Looking the session up in `session_ids` is what
     * makes "one task, several sessions" work: a later session sees the task a former
     * one started rather than opening a new one each time.
     */
    taskForSession(projectId, sessionId) {
        return this.tasks(projectId).find(task => task.sessionIds.includes(sessionId)
            && (task.status === 'in_progress' || task.status === 'paused'));
    }
    /**
     * Associate a session with a task, creating the task if this is its first session.
     *
     * Called when a session begins work. Without it the design's automatic recording
     * has nothing to record against: every session would start a fresh task and the
     * cross-session link would never exist.
     *
     * The deterministic id is per (project, session), so a session that finished a
     * task and then starts new work collides with the closed one. Reusing it would
     * silently reopen a terminal task, so a new task with a distinct id is created
     * instead — the closed one keeps its status and its completion time, which is
     * what acceptance 11 requires.
     */
    startTaskForSession(projectId, sessionId, title) {
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
        const base = `task-${createHash('sha256').update(`${projectId}\n${sessionId}`).digest('hex').slice(0, 16)}`;
        const prior = this.getTask(base, projectId);
        if (prior) {
            if (['completed', 'cancelled', 'failed'].includes(prior.status)) {
                // The session already closed this task. A fresh round of work is a new task
                // rather than a rewrite of the closed record.
                const reopened = this.tasks(projectId).filter(task => task.id.startsWith(`${base}-r`));
                const id = `${base}-r${reopened.length + 1}`;
                this.recordTask(projectId, {
                    id, title: title.slice(0, 200) || prior.title, status: 'in_progress',
                    sessionIds: [sessionId], startedAt: this.now(),
                });
                return { id, created: true };
            }
            this.recordTask(projectId, {
                id: base, title: prior.title, status: 'in_progress',
                sessionIds: [...new Set([...prior.sessionIds, sessionId])],
            });
            return { id: base, created: false };
        }
        this.recordTask(projectId, {
            id: base, title: title.slice(0, 200) || '未命名任务', status: 'in_progress',
            sessionIds: [sessionId], startedAt: this.now(),
        });
        return { id: base, created: true };
    }
    reflectionReceipt(principal, key) {
        const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(`checkpoint:${digest([principal, key])}`);
        return row ? JSON.parse(String(row.value)) : {};
    }
    /** Persist a task checkpoint and its factual journal in the same transaction. */
    checkpointTask(principal, input) {
        return this.transaction(() => {
            const fingerprint = digest(input);
            const prior = input.idempotencyKey ? this.reflectionReceipt(principal, input.idempotencyKey) : {};
            if (prior.journalId) {
                if (prior.fingerprint !== fingerprint)
                    throw new DomainError('idempotency_conflict', 'Checkpoint key already has different content', 409);
                return { ...prior, duplicate: true };
            }
            if (!input.taskId && !input.sessionId)
                throw new DomainError('invalid_task', 'taskId or sessionId is required');
            let task = input.taskId ? this.getTask(input.taskId, input.projectId)
                : this.taskForSession(input.projectId, input.sessionId)
                    ?? this.tasks(input.projectId).filter(task => task.sessionIds.includes(input.sessionId)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
            if (input.taskId && !task)
                throw new DomainError('not_found', 'Task is unavailable', 404);
            if (!task) {
                const started = this.startTaskForSession(input.projectId, input.sessionId, input.title || '会话工作任务');
                task = this.getTask(started.id, input.projectId);
            }
            // A host stop is not a completion claim and cannot reopen a closed task.
            const terminal = ['completed', 'failed', 'cancelled'].includes(task.status);
            const status = terminal && (!input.status || input.status === 'paused') ? task.status : (input.status ?? 'paused');
            if (input.status === 'completed' && (!input.verified?.trim() || !['observed', 'verifiable'].includes(input.evidence ?? '')))
                throw new DomainError('verification_required', 'Completed checkpoints require verified text and verifiable evidence');
            this.recordTask(input.projectId, { ...input, id: task.id, title: input.title ?? task.title, status,
                sessionIds: input.sessionId ? [...new Set([...task.sessionIds, input.sessionId])] : task.sessionIds });
            const journal = this.writeJournal(task.id, input.projectId);
            const receipt = { stored: true, taskId: task.id, ...journal, duplicate: false, fingerprint };
            if (input.idempotencyKey)
                this.db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)')
                    .run(`checkpoint:${digest([principal, input.idempotencyKey])}`, JSON.stringify(receipt));
            return receipt;
        });
    }
    /** Inspect this task's actual event stream, submissions and durable journal. */
    taskActivity(projectId, input) {
        const task = input.taskId ? this.getTask(input.taskId, projectId)
            : input.sessionId ? this.taskForSession(projectId, input.sessionId)
                ?? this.tasks(projectId).filter(task => task.sessionIds.includes(input.sessionId)).sort((a, b) => b.updatedAt - a.updatedAt)[0] : undefined;
        if (input.taskId && !task)
            throw new DomainError('not_found', 'Task is unavailable', 404);
        const events = this.db.prepare('SELECT id,payload,created_at FROM events ORDER BY created_at DESC').all()
            .map(row => ({ id: String(row.id), at: Number(row.created_at), ...JSON.parse(String(row.payload)) }))
            .filter(event => event.projectId === projectId && (input.taskId ? event.taskId === input.taskId
            : input.sessionId ? event.sessionId === input.sessionId : false)).slice(0, 100);
        const proposals = this.listProposals(projectId).filter(proposal => task
            && (proposal.payload?.taskId === task.id || task.relatedProposals.includes(proposal.id)))
            .map(proposal => ({ id: proposal.id, state: proposal.state, createdAt: proposal.createdAt }));
        const entry = task ? this.current().find(entry => entry.content.kind === 'journal' && entry.content.taskId === task.id) : undefined;
        return { task: task ?? null, events, proposals,
            journal: entry ? { id: entry.id, revision: entry.revision, outcome: entry.content.kind === 'journal' ? entry.content.outcome : 'unverified' } : null,
            knowledgeRevision: this.revision };
    }
    /**
     * Generate the diary for a task.
     *
     * Built from what the task actually recorded — its own facts and its event
     * stream — not from a model's summary of the conversation. The design requires
     * the diary to be "based on facts" and to distinguish success, failure and
     * unverified; a generated narrative would blur exactly those distinctions.
     */
    generateJournal(taskId, projectId) {
        const task = this.getTask(taskId, projectId);
        if (!task)
            throw new DomainError('not_found', 'Task is unavailable', 404);
        // The event stream is filtered by project as well as task id: an event that
        // named this task from another project must not become a "fact" in this
        // project's diary. The write path refuses such an event, and this filter is
        // the second line of defence for rows written before that check existed.
        const events = this.db.prepare('SELECT payload, created_at FROM events ORDER BY created_at').all()
            .map(row => { try {
            return JSON.parse(String(row.payload));
        }
        catch {
            return {};
        } })
            .filter(payload => (payload.taskId === taskId || (!payload.taskId && payload.sessionId && task.sessionIds.includes(payload.sessionId)))
            && (payload.projectId === undefined || payload.projectId === projectId));
        const stops = events.filter(event => event.kind === 'turn_stopped').length;
        const did = task.summary
            || `任务「${task.title}」共记录 ${events.length} 个事件${stops ? `，其中 ${stops} 次中断` : ''}。`;
        /**
         * The outcome may only rest on a checkable fact.
         *
         * `task.verified` is a string the caller supplied — an agent saying "I ran the
         * tests and they passed". Treating any non-empty string as success marked an
         * unverified claim as observed evidence (design §6.2, acceptance 4). So a bare
         * free-text claim never carries a diary to `success`: the text is preserved and
         * labelled as the self-report it is.
         *
         * What may carry it is a *deliberate* statement of basis, in either of the two
         * forms the design names — the caller recording an evidence level of
         * `observed` (the plugin's own record) or `verifiable` (a checkable artefact),
         * or the plugin having separately recorded a `verified` event. Either is a
         * distinct assertion rather than prose; the two are accepted together because
         * requiring both made `verifiable` alone unable to ever reach `success`, which
         * would leave the field unable to describe the case it exists for.
         */
        const verifiedEvents = events.filter(event => event.kind === 'verified' && event.evidence === 'observed').length;
        const checkable = task.evidence === 'observed' || task.evidence === 'verifiable' || verifiedEvents > 0;
        const outcome = task.status === 'completed' ? (checkable ? 'success' : 'unverified')
            : task.status === 'failed' ? 'failure'
                : 'unverified';
        return {
            id: `journal-${task.id}`,
            kind: 'journal',
            title: `任务日记：${task.title}`.slice(0, 200),
            scope: { kind: 'project', projectId },
            baseRevision: 0,
            labels: [],
            // The plugin wrote this from its own records, so `agent` provenance is the
            // accurate label: it is not something the user said, and calling it theirs
            // would lend the diary an authority it does not have.
            provenance: 'agent',
            // The diary is a record, not a verification: `self-reported` is the honest
            // level, because nothing here was independently checked by the plugin.
            evidence: 'self-reported',
            platforms: [],
            taskId: task.id,
            did,
            problems: task.notes,
            experienceLanded: task.relatedExperiences,
            outcome,
            /**
             * The decision inputs, kept beside the claim so a reader can see why the
             * outcome is what it is: the caller's own words, the number of events that
             * actually bound to this task, and whether any of them was a verifiable one.
             */
            verification: {
                selfReported: task.verified ? true : false,
                claim: task.verified || null,
                events: events.length,
                verifiedEvents,
                basis: verifiedEvents > 0 ? 'observed-event' : 'none',
            },
            unfinished: task.unfinished,
        };
    }
    /** Record the journal as knowledge, so it survives the task record. */
    writeJournal(taskId, projectId) {
        const journal = this.generateJournal(taskId, projectId);
        const existing = this.current().find(entry => entry.content.kind === 'journal'
            && entry.content.taskId === taskId);
        // `verification` is diagnostic detail returned to a caller inspecting the
        // generated journal; it is not part of the journal entry schema, so it is
        // dropped before the entry is stored.
        const { verification: _verification, ...entry } = journal;
        const withRevision = existing
            ? { ...entry, baseRevision: existing.revision }
            : entry;
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
    handoff(id, projectId) {
        const task = this.tasks(projectId).find(t => t.id === id);
        if (!task)
            throw new DomainError('not_found', 'Task is unavailable', 404);
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
            /**
             * The recorded state of those files, for the receiving end to compare against.
             *
             * Acceptance 16 requires that continuing in a different checkout shows how the
             * files differ instead of assuming the sender's edits are already present. The
             * core cannot do that comparison — it never sees the receiving end's disk — so
             * it hands over what was *recorded* and says so. `compare` is provided as a
             * helper the receiving end can call with its own observed digests, and it
             * reports `unknown` rather than `unchanged` for any file whose state was never
             * recorded: "we did not look" and "it has not changed" are different answers,
             * and conflating them is how a stale checkout gets mistaken for a current one.
             */
            fileStates: task.fileStates,
            compare: {
                note: '把接收端自己算出的摘要传进来，即可得到每个文件的差异；未记录过状态的文件一律返回 unknown，不假定未变。',
                // Counted against the full file list, not just the states: a path named in
                // `files` with no recorded state is the case that most needs to be visible,
                // and counting only within `fileStates` would report zero gaps while a
                // receiving end silently has nothing to compare against.
                recorded: task.files.filter(path => task.fileStates.some(state => state.path === path && state.digest !== undefined)).length,
                unrecorded: task.files.filter(path => !task.fileStates.some(state => state.path === path && state.digest !== undefined)).length,
            },
            /** What was verified, and whether anything was verified at all. */
            verification: { verified: task.verified || null, taskStatus: task.status },
            suggestion: nextStep,
            caveat: '接收端需重新确认文件与环境状态；本交接不迁移运行中的进程、凭据或工具权限。'
                + ' 上面的 files 只是需要核对的清单，不代表已经核对过；fileStates 是发送端记录的状态，'
                + '必须与接收端自己的状态比较后才知是否一致。',
        };
    }
    /**
     * Compare a receiving end's observed file digests against what a task recorded.
     *
     * Kept on the store rather than the HTTP layer so the three-way distinction is
     * enforced in one place: `same` (recorded and equal), `different` (recorded and
     * not equal), and `unknown` (nothing was recorded for that path, or the receiving
     * end did not supply a digest). A two-valued answer would force `unknown` to be
     * reported as one of the others, and it is exactly the case the acceptance case
     * warns about — assuming another checkout already has the change.
     */
    compareFileStates(taskId, projectId, observed) {
        const task = this.tasks(projectId).find(t => t.id === taskId);
        if (!task)
            throw new DomainError('not_found', 'Task is unavailable', 404);
        const recorded = new Map(task.fileStates.map(state => [state.path, state]));
        // Every path either side knows about is reported, so a file the receiving end
        // has but the task does not (or vice versa) cannot be dropped silently.
        const paths = [...new Set([...recorded.keys(), ...observed.map(item => item.path)])].sort();
        const observedByPath = new Map(observed.map(item => [item.path, item]));
        const results = paths.map(path => {
            const was = recorded.get(path);
            const now = observedByPath.get(path);
            if (!was || was.digest === undefined) {
                return { path, status: 'unknown', ...(was?.digest ? { recordedDigest: was.digest } : {}), ...(now?.digest ? { observedDigest: now.digest } : {}), detail: '发送端未记录该文件的状态，不能判断是否变化' };
            }
            if (!now || now.digest === undefined) {
                return { path, status: 'unknown', recordedDigest: was.digest, detail: '接收端未提供该文件的摘要，不能判断是否变化' };
            }
            const same = was.digest === now.digest;
            return {
                path, status: same ? 'same' : 'different',
                recordedDigest: was.digest, observedDigest: now.digest,
                detail: same ? '与发送端记录一致' : '与发送端记录不一致：本地内容可能落后或已被改动',
            };
        });
        const summary = {
            same: results.filter(r => r.status === 'same').length,
            different: results.filter(r => r.status === 'different').length,
            unknown: results.filter(r => r.status === 'unknown').length,
        };
        return { results, summary };
    }
    /**
     * Export a task as readable Markdown, and as the full record for backup.
     *
     * Two shapes for two purposes, as the design specifies: the Markdown is for a
     * person reading what happened, the JSON is for moving the data. The Markdown
     * deliberately states the outcome rather than implying it — an unverified task
     * must not read like a successful one.
     */
    exportTask(id, projectId) {
        const task = this.tasks(projectId).find(t => t.id === id);
        if (!task)
            throw new DomainError('not_found', 'Task is unavailable', 404);
        const events = this.db.prepare('SELECT payload, created_at FROM events ORDER BY created_at').all()
            .map(row => {
            let payload = {};
            try {
                payload = JSON.parse(String(row.payload));
            }
            catch { /* torn row */ }
            return { created_at: Number(row.created_at), taskId: payload.taskId, projectId: payload.projectId, kind: payload.kind, summary: payload.summary };
        })
            // Filtered by project as well as task: an event recorded under another project
            // for this task id must not appear in the export a reader treats as fact.
            .filter(event => event.taskId === id && (event.projectId === undefined || event.projectId === projectId));
        const stamp = (value) => value === null ? '—' : new Date(value).toISOString().replace('T', ' ').slice(0, 16);
        // Label the time system in the document itself: the export is UTC while the
        // management page shows local time with an offset, and F09 found a reader could
        // not tell which was which when correlating the two timelines.
        const UTC_NOTE = '本文件时间均为 UTC，格式 YYYY-MM-DD HH:MM。';
        const outcomeLabel = { success: '完成（有验证依据）', failure: '失败', unverified: '未验证' };
        // Same rule as the diary: the free-text `verified` cannot be the basis for a
        // success claim. Only a level the plugin can stand behind does.
        const verified = task.evidence === 'observed' || task.evidence === 'verifiable';
        const outcome = task.status === 'completed' ? (verified ? 'success' : 'unverified')
            : task.status === 'failed' ? 'failure' : 'unverified';
        const markdown = [
            `# 任务记录：${task.title}`, '',
            `**任务 ID**：${task.id}  `,
            `**项目**：${projectId}  `,
            `**时间**：${stamp(task.startedAt ?? task.createdAt)} ~ ${stamp(task.completedAt)}  `,
            `**状态**：${outcomeLabel[outcome]}（${task.status}）  `,
            `**知识版本**：${task.knowledgeRevision}  `,
            `**时区**：${UTC_NOTE}`, '',
            '## 摘要', task.summary || '（无）', '',
            '## 进展',
            ...(events.length
                ? events.map(event => `- ${stamp(event.created_at)} ${String(event.kind ?? '事件')}${event.summary ? `：${String(event.summary)}` : ''}`)
                : ['- （无事件记录）']), '',
            '## 关联知识',
            ...(task.relatedExperiences.length ? task.relatedExperiences.map(id => `- 经验：${id}`) : ['- 经验：（无）']),
            ...(task.relatedProposals.length ? task.relatedProposals.map(id => `- 提案：${id}`) : ['- 提案：（无）']), '',
            '## 验证',
            task.verified
                ? `${task.verified}（证据等级：${task.evidence}${verified ? '' : '，未达可核验等级，按未验证记录'}）`
                : '未提供验证依据（按未验证记录）', '',
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
    adopt(entries) {
        if (entries.length === 0)
            throw new DomainError('empty_batch', 'Adoption requires at least one entry', 400);
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
            const skipped = [];
            const aligned = [];
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
          VALUES(?,?,?,?,?,?,?,?,NULL)`).run(`adopt:${adoptedAt}:${entry.source.hash.slice(0, 16)}:${entry.knowledge.id}`, entry.source.path, entry.kind, entry.title, entry.source.hash, entry.knowledge.id, revision, adoptedAt);
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
    refreshAdoption(input) {
        const validated = knowledgeSchema.parse(input.knowledge);
        const record = this.adoptions()
            .find(candidate => candidate.sourcePath === input.sourcePath);
        if (!record)
            throw new DomainError('not_adopted', `Source was never adopted: ${input.sourcePath}`, 404);
        if (record.contentHash === input.source.hash) {
            return { knowledgeId: record.knowledgeId, knowledgeRevision: this.revision, action: 'unchanged', replacedLocalEdit: false };
        }
        const adoptedAt = this.now();
        return this.transaction(() => {
            const head = this.head(record.knowledgeId);
            if (!head)
                throw new DomainError('not_found', 'Adopted entry is unavailable', 404);
            // A retired entry must not be silently revived by a source refresh: it may
            // have been superseded or deliberately withdrawn, and bringing it back as
            // current would undo that decision without review.
            if (head.status !== 'active') {
                throw new DomainError('not_active', `Adopted entry ${record.knowledgeId} is ${head.status}; refusing to revive it by refresh`, 409);
            }
            // A revision beyond the one this batch created means someone edited it here.
            const replacedLocalEdit = head.revision !== record.revision;
            const kindChanged = head.content.kind !== validated.kind;
            if (kindChanged)
                throw new DomainError('kind_changed', 'A refresh must keep the adopted knowledge kind', 409);
            const incoming = { ...validated, id: head.content.id, baseRevision: head.revision };
            const knowledgeRevision = this.importInsideTransaction([incoming]);
            this.db.prepare(`INSERT INTO supersessions(old_knowledge_id,old_revision,new_knowledge_id,new_revision,action,reason,evidence,origin,replaced_local_edit,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(record.knowledgeId, head.revision, record.knowledgeId, head.revision + 1, 'supersede', input.reason ?? '来源内容已更新，以最新记录为准', input.evidence ?? `source:${input.sourcePath}@${input.source.hash}`, input.origin ?? 'rescan', replacedLocalEdit ? 1 : 0, adoptedAt);
            // The ledger row is superseded rather than updated, so a batch revoke can
            // still be reasoned about after a refresh.
            this.db.prepare('UPDATE adoptions SET revoked_at=? WHERE id=?').run(adoptedAt, record.id);
            this.db.prepare(`INSERT INTO adoptions(id,source_path,kind,title,content_hash,knowledge_id,revision,adopted_at,revoked_at)
        VALUES(?,?,?,?,?,?,?,?,NULL)`).run(`adopt:${adoptedAt}:${input.source.hash.slice(0, 16)}:${record.knowledgeId}`, input.sourcePath, input.kind, input.title, input.source.hash, record.knowledgeId, head.revision + 1, adoptedAt);
            return { knowledgeId: record.knowledgeId, knowledgeRevision, action: 'refreshed', replacedLocalEdit };
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
    structureSkill(input) {
        const evidence = input.evidence.trim().slice(0, 2000);
        if (!evidence)
            throw new DomainError('missing_evidence', 'Structuring a skill must cite what the structure is based on', 400);
        // Validate the authored structure on its own first. Assembling a placeholder
        // derivedFrom before the target is known would surface a schema complaint
        // about the placeholder instead of the real problem (unknown target, wrong
        // kind, already retired), which misleads the caller.
        const authored = workflowSchema.parse({ ...input.workflow, derivedFrom: undefined });
        return this.transaction(() => {
            const skill = this.head(input.skillId);
            if (!skill)
                throw new DomainError('not_found', `Skill ${input.skillId} is unavailable`, 404);
            if (skill.content.kind !== 'skill')
                throw new DomainError('not_skill', 'Only an adopted skill can be structured into a workflow', 409);
            if (skill.status !== 'active')
                throw new DomainError('not_active', `Skill ${input.skillId} is ${skill.status}`, 409);
            if (input.expectedSkillRevision !== undefined && skill.revision !== input.expectedSkillRevision)
                throw new DomainError('revision_conflict', 'Source skill changed since draft generation', 409);
            // The skill must belong to the caller's scope; otherwise one project could
            // convert and retire another project's knowledge.
            if (input.projectId && skill.content.scope.kind !== 'global'
                && skill.content.scope.projectId !== input.projectId) {
                throw new DomainError('not_found', `Skill ${input.skillId} is unavailable`, 404);
            }
            if (authored.id === input.skillId)
                throw new DomainError('id_conflict', 'The workflow needs its own id, distinct from the skill', 400);
            const existing = this.head(authored.id);
            if (existing && existing.content.kind !== 'workflow')
                throw new DomainError('kind_changed', 'A workflow id must not replace another kind', 409);
            if (existing && input.projectId && !applicable(existing.content.scope, input.projectId))
                throw new DomainError('not_found', 'Target workflow is unavailable in this project', 404);
            const withSource = workflowSchema.parse({
                ...authored,
                baseRevision: existing?.revision ?? 0,
                derivedFrom: { skillId: input.skillId, skillRevision: skill.revision, derivedBy: input.derivedBy, evidence },
            });
            const knowledgeRevision = this.importInsideTransaction([withSource]);
            // Retire the raw skill in the same transaction: the workflow now carries
            // the method, and leaving both active would offer the same procedure twice
            // in two different shapes.
            const retired = !input.keepSource && this.db.prepare("UPDATE knowledge SET status='retired' WHERE id=? AND head=? AND status='active'")
                .run(input.skillId, skill.revision);
            if (retired && retired.changes)
                this.db.prepare('DELETE FROM workflow_search WHERE id=?').run(input.skillId);
            const newRevision = (existing?.revision ?? 0) + 1;
            this.db.prepare(`INSERT INTO supersessions(old_knowledge_id,old_revision,new_knowledge_id,new_revision,action,reason,evidence,origin,replaced_local_edit,created_at)
        VALUES(?,?,?,?,?,?,?,?,0,?)`).run(input.skillId, skill.revision, authored.id, newRevision, input.keepSource ? 'supplement' : 'supersede', '技能已结构化为完整流程', evidence, input.derivedBy, this.now());
            this.db.prepare("UPDATE meta SET value=value+1 WHERE key='revision'").run();
            this.jobs.enqueue('notify', `revision:${this.revision}`, { revision: this.revision });
            return { workflowId: authored.id, knowledgeRevision, retiredSkillRevision: skill.revision };
        });
    }
    /**
     * Adopted skills still awaiting structure, newest first.
     *
     * `projectId` narrows the list to what one caller may see; omitting it is the
     * unscoped administrative view the CLI asks for. The HTTP endpoint always passes
     * the credential's project, because that is where the isolation boundary is.
     */
    unstructuredSkills(projectId, limit = 50) {
        return this.liveEntries()
            .filter(entry => entry.content.kind === 'skill' && entry.content.needsStructure
            && (projectId === undefined || applicable(entry.content.scope, projectId)))
            .slice(0, limit)
            .map(entry => {
            const content = entry.content;
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
    retiredIds() {
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
    revokeAdoption(adoptedAt) {
        const batch = this.adoptions(true).filter(record => record.adoptedAt === adoptedAt && record.revokedAt === null);
        if (batch.length === 0)
            throw new DomainError('not_found', 'No active adoption batch with that timestamp', 404);
        return this.transaction(() => {
            const retired = [];
            const skipped = [];
            const now = this.now();
            for (const record of batch) {
                const head = this.head(record.knowledgeId);
                if (!head || head.status !== 'active') {
                    skipped.push({ knowledgeId: record.knowledgeId, reason: 'no longer active' });
                }
                else if (head.revision !== record.revision) {
                    skipped.push({ knowledgeId: record.knowledgeId, reason: `edited since adoption (now revision ${head.revision}); preserved` });
                }
                else {
                    this.db.prepare("UPDATE knowledge SET status='retired' WHERE id=? AND head=? AND status='active'").run(record.knowledgeId, record.revision);
                    this.db.prepare('DELETE FROM workflow_search WHERE id=?').run(record.knowledgeId);
                    retired.push(record.knowledgeId);
                }
                this.db.prepare('UPDATE adoptions SET revoked_at=? WHERE id=?').run(now, record.id);
            }
            if (retired.length)
                this.db.prepare("UPDATE meta SET value=value+1 WHERE key='revision'").run();
            this.jobs.enqueue('notify', `revision:${this.revision}`, { revision: this.revision });
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
        const now = this.now();
        this.expireProposals();
        this.db.prepare('DELETE FROM events WHERE expires_at<=?').run(now);
        // A lapsed outbox item stops being retryable here rather than at the next
        // attempt, so a status read never reports work that is already past its
        // deadline as merely "waiting".
        this.abandonDueOutbox(now);
        this.purgeExpiredMaterial();
    }
    /**
     * The one read-time expiry gate.
     *
     * Every read path — the universal catalog, a single get, the dedicated material
     * list, history, export — filters through here, so a lapsed item is invisible
     * even while the persistent purge is failing or has never run. Putting the rule
     * in one place is the point: a per-entry check at each call site is how one of
     * them eventually forgets, and the entry that is forgotten is the one the user
     * most needed gone.
     */
    liveEntries() {
        const now = this.now();
        return this.current().filter(entry => entry.content.kind !== 'material' || isLive(entry.content.expiresAt, now));
    }
    /**
     * Purge lapsed temporary material, returning what was removed.
     *
     * Separated from `cleanup()` so a caller can retry it alone, and so a test can
     * assert the purge without waiting for the other housekeeping.
     *
     * The removal is a real delete, not a retirement. The design's second layer says
     * bodies, summaries, index rows and cached fragments are removed, and the earlier
     * implementation only flipped the head to `retired` — which left the body in the
     * `revisions` table and in every backup taken afterwards. History for norms,
     * skills and memories is immutable on purpose; temporary material has an explicit
     * expiry that overrides that default.
     *
     * One item is handled per transaction so a failure is isolated to it, and every
     * failure is recorded in `material_purge_failures` — a cleanup that silently did
     * nothing is indistinguishable from one that had nothing to do, which is exactly
     * how a lapsed body survives.
     *
     * The two steps inside that transaction are ordered the way the design describes
     * them: first leave the live set through the normal retirement transition, then
     * remove the payload it was guarding. `purged` therefore means both happened —
     * a row is only ever reported as purged when the body, summary and index rows are
     * actually gone. Any step that fails leaves the item in `failed` and untouched.
     */
    purgeExpiredMaterial() {
        const now = this.now();
        const purged = [];
        const failed = [];
        for (const entry of this.current()) {
            const content = entry.content;
            if (content.kind !== 'material')
                continue;
            if (isLive(content.expiresAt, now))
                continue;
            try {
                this.transaction(() => {
                    // Re-read inside the transaction: the row may have been renewed since the
                    // scan, and a renewal is a deliberate decision the purge must not undo.
                    const head = this.head(entry.id);
                    if (!head)
                        return;
                    if (head.content.kind !== 'material' || isLive(head.content.expiresAt, now))
                        return;
                    // Step 1: leave the effective library. Inlined rather than calling
                    // `retire()` because that opens its own transaction, and a failure here
                    // must abort the deletion below in the same unit of work.
                    const retired = this.db.prepare("UPDATE knowledge SET status='retired' WHERE id=? AND head=? AND status='active'")
                        .run(entry.id, head.revision);
                    if (!retired.changes)
                        throw new DomainError('revision_conflict', 'Current knowledge revision not found', 409);
                    // Step 2: really remove the payload. History is immutable for norms,
                    // skills and memories; temporary material has an explicit expiry that
                    // overrides that default, so its revisions — and the head row that points
                    // at them — go too. Leaving the head behind would export a knowledge row
                    // with no revision, which makes a backup unimportable ("Missing head
                    // revision"), so the two are removed together.
                    this.db.prepare('DELETE FROM workflow_search WHERE id=?').run(entry.id);
                    this.db.prepare('DELETE FROM revisions WHERE id=?').run(entry.id);
                    this.db.prepare('DELETE FROM knowledge WHERE id=?').run(entry.id);
                    this.db.prepare('DELETE FROM material_purge_failures WHERE id=?').run(entry.id);
                    // A minimal ledger row keeps "this page existed and lapsed" answerable
                    // without retaining the body or the summary the design removes. It is a
                    // destructive lifecycle event rather than a data row, so it is left alone
                    // by the backup credential scan.
                    const ledger = this.db.prepare("SELECT count(*) AS n FROM supersessions WHERE old_knowledge_id=? OR new_knowledge_id=?").get(entry.id, entry.id);
                    if (Number(ledger.n) === 0) {
                        this.db.prepare(`INSERT INTO supersessions(old_knowledge_id,old_revision,new_knowledge_id,new_revision,action,reason,evidence,origin,replaced_local_edit,created_at)
              VALUES(?,?,?,?,?,?,?,?,0,?)`).run(entry.id, head.revision, entry.id, head.revision, 'supplement', '临时资料到期清理：正文、摘要与索引已删除', 'material expiry', 'user', now);
                    }
                    this.db.prepare("UPDATE meta SET value=value+1 WHERE key='revision'").run();
                    this.jobs.enqueue('notify', `revision:${this.revision}`, { revision: this.revision });
                });
                purged.push(entry.id);
            }
            catch (error) {
                // Collected, not thrown: one item that will not delete must not stop the
                // pass, and the caller needs to know which ones to retry. The item is left
                // wholly untouched, so the retry starts from the same state.
                const message = error instanceof Error ? error.message : 'purge failed';
                failed.push({ id: entry.id, message });
                try {
                    this.db.prepare(`INSERT INTO material_purge_failures(id,expires_at,message,attempts,failed_at) VALUES(?,?,?,1,?)
            ON CONFLICT(id) DO UPDATE SET message=excluded.message, attempts=attempts+1, failed_at=excluded.failed_at`)
                        .run(entry.id, content.expiresAt, message, now);
                }
                catch { /* the failure log must never break the purge it describes */ }
            }
        }
        return { purged, failed };
    }
    /**
     * Material whose persistent cleanup has failed, so the failure is visible and
     * retryable rather than implied. Read-only.
     */
    purgeFailures() {
        return this.db.prepare('SELECT id,expires_at,message,attempts,failed_at FROM material_purge_failures ORDER BY failed_at').all()
            .map(row => ({
            id: String(row.id), expiresAt: Number(row.expires_at),
            message: String(row.message), attempts: Number(row.attempts), failedAt: Number(row.failed_at),
        }));
    }
    /**
     * Save temporary material, recognising a repeat of the same page.
     *
     * A duplicate is skipped rather than stored twice, and — importantly — skipping
     * does **not** extend the original's expiry. The design is explicit that saving
     * the same page again is not a decision to keep it longer.
     *
     * Duplicate detection is scoped to the caller's project: two projects that read
     * the same URL are two separate records, and letting one project's save return
     * the other's id would turn the dedup optimisation into a cross-project probe.
     */
    saveMaterial(input) {
        const now = this.now();
        const entry = materialEntry(input, now);
        const scope = entry.scope;
        const owner = scope.kind === 'global' ? '' : scope.projectId;
        const existing = this.liveEntries().find(candidate => candidate.content.kind === 'material' && candidate.content.fingerprint === entry.fingerprint
            && applicable(candidate.content.scope, owner));
        if (existing) {
            return { id: existing.id, duplicate: true, expiresAt: existing.content.expiresAt };
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
     *
     * `projectId` is the caller's scope. A credential for one project must not be
     * able to move another project's expiry merely by naming its id.
     */
    renewMaterial(id, reason, projectId) {
        const entry = this.current().find(candidate => candidate.id === id);
        if (!entry || entry.content.kind !== 'material')
            throw new DomainError('not_found', 'Material is unavailable', 404);
        const content = entry.content;
        if (projectId !== undefined && !applicable(content.scope, projectId)) {
            throw new DomainError('not_found', 'Material is unavailable', 404);
        }
        const renewed = renew({ expiresAt: content.expiresAt, savedAt: content.savedAt }, reason, this.now());
        this.import([{ ...content, baseRevision: entry.revision, ...renewed }]);
        return { expiresAt: renewed.expiresAt, renewalReason: renewed.renewalReason };
    }
    /** Live material only, newest first. Expired items are never returned. */
    liveMaterial(projectId, limit = 50) {
        const now = this.now();
        return this.current()
            .filter(entry => entry.content.kind === 'material' && isLive(entry.content.expiresAt, now)
            && (projectId === undefined || applicable(entry.content.scope, projectId)))
            .sort((a, b) => b.content.savedAt - a.content.savedAt)
            .slice(0, limit)
            .map(entry => {
            const content = entry.content;
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
        const live = all.filter(entry => isLive(entry.content.expiresAt, now));
        return {
            live: live.length, expired: all.length - live.length, total: all.length,
            ttlDays: MATERIAL_TTL_DAYS,
            nextExpiry: live.length
                ? Math.min(...live.map(entry => entry.content.expiresAt))
                : null,
        };
    }
    /** Rescan cadence bookkeeping, read by adapters on session start. */
    rescanState() {
        return {
            lastRescanAt: Number(this.db.prepare("SELECT value FROM meta WHERE key='lastRescanAt'").get().value),
            intervalMs: Number(this.db.prepare("SELECT value FROM meta WHERE key='rescanIntervalMs'").get().value),
        };
    }
    markRescanned(at = this.now()) {
        this.db.prepare("UPDATE meta SET value=? WHERE key='lastRescanAt'").run(at);
        return this.rescanState();
    }
    setRescanInterval(ms) {
        if (!Number.isSafeInteger(ms) || ms < 60_000)
            throw new DomainError('invalid_interval', 'Rescan interval must be at least one minute', 400);
        this.db.prepare("UPDATE meta SET value=? WHERE key='rescanIntervalMs'").run(ms);
        return this.rescanState();
    }
    /** Roots a periodic rescan should walk; empty means "use the default roots". */
    scanRoots() {
        const raw = String(this.db.prepare("SELECT value FROM meta WHERE key='scanRoots'").get().value);
        return raw ? raw.split('\n').map(line => line.trim()).filter(Boolean) : [];
    }
    setScanRoots(roots) {
        this.db.prepare("UPDATE meta SET value=? WHERE key='scanRoots'").run(roots.map(root => root.trim()).filter(Boolean).join('\n'));
        return this.scanRoots();
    }
    /** True when the configured cadence has elapsed since the last scan. */
    rescanDue(at = this.now()) {
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
    supersede(input) {
        const reason = input.reason.trim().slice(0, 500);
        const evidence = input.evidence.trim().slice(0, 2000);
        if (!reason)
            throw new DomainError('missing_reason', 'A supersession must state why', 400);
        if (!evidence)
            throw new DomainError('missing_evidence', 'A supersession must cite evidence', 400);
        if (input.oldId === input.newId)
            throw new DomainError('self_supersession', 'An entry cannot supersede itself', 400);
        return this.transaction(() => {
            const oldEntry = this.head(input.oldId);
            const newEntry = this.head(input.newId);
            if (!oldEntry)
                throw new DomainError('not_found', `Superseded entry ${input.oldId} is unavailable`, 404);
            if (!newEntry)
                throw new DomainError('not_found', `Replacement entry ${input.newId} is unavailable`, 404);
            // The replacement must be usable. Retiring the old entry in favour of an entry
            // that is itself retired produced a chain with no effective conclusion: the
            // receipt said success while both ends sat outside the live library, which is
            // the opposite of what a supersession is for.
            if (newEntry.status !== 'active')
                throw new DomainError('not_active', `Replacement entry ${input.newId} is ${newEntry.status}; a replacement must be active`, 409);
            if (oldEntry.content.kind !== newEntry.content.kind)
                throw new DomainError('kind_changed', 'A replacement must keep the same knowledge kind', 409);
            // Both entries must be visible to the caller's scope. Without this a
            // credential for one project could retire another project's knowledge
            // merely by naming its id.
            if (input.projectId) {
                const visible = (entry) => entry.content.scope.kind === 'global'
                    || entry.content.scope.projectId === input.projectId;
                if (!visible(oldEntry))
                    throw new DomainError('not_found', `Superseded entry ${input.oldId} is unavailable`, 404);
                if (!visible(newEntry))
                    throw new DomainError('not_found', `Replacement entry ${input.newId} is unavailable`, 404);
            }
            // Only a 'supersede' retires the earlier entry; a 'supplement' adds
            // alongside it, because a complement is not a contradiction.
            if (input.action === 'supersede') {
                const result = this.db.prepare("UPDATE knowledge SET status='retired' WHERE id=? AND head=? AND status='active'")
                    .run(input.oldId, oldEntry.revision);
                if (!result.changes)
                    throw new DomainError('not_active', `Superseded entry ${input.oldId} is not active`, 409);
                this.db.prepare('DELETE FROM workflow_search WHERE id=?').run(input.oldId);
            }
            this.db.prepare(`INSERT INTO supersessions(old_knowledge_id,old_revision,new_knowledge_id,new_revision,action,reason,evidence,origin,replaced_local_edit,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(input.oldId, oldEntry.revision, input.newId, newEntry.revision, input.action, reason, evidence, input.origin, 0, this.now());
            // A supplement is a real relation, so it advances the knowledge version. It
            // used to write the ledger row and nothing else, which meant a reader could
            // not tell that the two entries were related — the relation existed only in a
            // table the normal read path never consults.
            this.db.prepare("UPDATE meta SET value=value+1 WHERE key='revision'").run();
            this.jobs.enqueue('notify', `revision:${this.revision}`, { revision: this.revision });
            return {
                action: input.action,
                oldRevision: oldEntry.revision, newRevision: newEntry.revision,
                historyPreserved: true,
            };
        });
    }
    /**
     * Supersession ledger, newest first. Reads only.
     *
     * `projectId` narrows the answer to links whose either end the caller may see.
     * The recent-history panel is the leak that mattered: an unscoped ledger handed
     * one project another project's titles and the *reason* and *evidence* text a
     * replacement was made on, which is exactly the material an entry is scoped to
     * protect. Omitting the argument is the unscoped administrative view.
     */
    supersessions(forId, projectId) {
        const rows = forId
            ? this.db.prepare('SELECT * FROM supersessions WHERE old_knowledge_id=? OR new_knowledge_id=? ORDER BY created_at DESC, id DESC').all(forId, forId)
            : this.db.prepare('SELECT * FROM supersessions ORDER BY created_at DESC, id DESC').all();
        const visible = (id) => {
            if (projectId === undefined)
                return true;
            const entry = this.head(id) ?? this.decodeAny(id);
            // A purged material id has no entry left; its lifecycle ledger row is
            // attributed to whichever project the caller's own list is about only when
            // the id is genuinely unknown. Rather than guess, it is hidden.
            if (!entry)
                return false;
            return entry.content.scope.kind === 'global' || entry.content.scope.projectId === projectId;
        };
        return rows.filter(row => visible(String(row.old_knowledge_id)) || visible(String(row.new_knowledge_id)))
            .map(row => ({
            id: Number(row.id),
            oldKnowledgeId: String(row.old_knowledge_id), oldRevision: Number(row.old_revision),
            newKnowledgeId: String(row.new_knowledge_id), newRevision: Number(row.new_revision),
            action: String(row.action),
            reason: String(row.reason), evidence: String(row.evidence),
            origin: String(row.origin),
            replacedLocalEdit: Number(row.replaced_local_edit) === 1,
            createdAt: Number(row.created_at),
        }));
    }
    /**
     * Full lineage of one knowledge id: every supersession it took part in.
     *
     * Lets a reader answer "why is this the current version, and what did it
     * replace" without exposing retired bodies in normal retrieval.
     *
     * The revision list is behind `requireVisible` when a project is named: the
     * history endpoint is read by both projects, and without the check one project's
     * credential could enumerate another project's entry by id — the same class of
     * leak as the unscoped recent-history list.
     */
    history(id, projectId) {
        // `decodeAny` deliberately sees retired entries too: history must not vanish
        // when an entry leaves the effective library. Visibility is decided by scope,
        // not by status, which is why the check uses the same reference-entry helper
        // the review methods do rather than the live set.
        const entry = projectId === undefined
            ? (this.head(id) ?? this.decodeAny(id))
            : (() => { try {
                return this.requireVisible(id, projectId);
            }
            catch {
                return undefined;
            } })();
        const revisions = this.db.prepare('SELECT revision,created_at FROM revisions WHERE id=? ORDER BY revision').all(id)
            .map(row => ({ revision: Number(row.revision), createdAt: Number(row.created_at) }));
        const chain = this.supersessions(id, projectId);
        // An unknown id is reported as missing rather than as an empty lineage: a
        // 200 with no revisions would read as "this entry exists but has no history",
        // which is a different and misleading statement. A known-but-foreign id is
        // reported the same way, because "it exists but is not yours" is not something
        // a caller should be able to distinguish.
        if (!entry) {
            throw new DomainError('not_found', `Knowledge entry ${id} is unavailable`, 404);
        }
        return {
            id,
            current: { revision: entry.revision, status: entry.status, kind: entry.content.kind, title: entry.content.title },
            // Every immutable revision stays readable, retired or not.
            revisions,
            chain,
            /**
             * Where a reader can fetch an old revision's prose.
             *
             * F09: the history view listed revisions but the only fetch path refused a
             * non-current `@revision` with 409, so a reader could see that v1 existed
             * and never see what it said. The dedicated route below reads history — it
             * does not weaken the current-version guard on `read`/`get`, which still
             * refuse a stale handle — and this field tells the page where that is.
             */
            revisionReadHint: '历史修订正文通过 /v1/knowledge/history/read 只读查阅（不得作为当前版本使用）。',
        };
    }
    /**
     * Read one historical revision of an entry, read-only.
     *
     * The revision guard on the retrieval path exists so a caller cannot act on a
     * version that is no longer current; it is not a reason for the human's history
     * page to be blind. This method is deliberately separate: it answers "what did
     * v1 say" without ever returning a handle a caller could confuse with the
     * current one, and it applies the same scope rule as `history` so one project
     * cannot read another's past.
     */
    readRevision(id, revision, projectId) {
        const { id: bareId } = this.resolveKnowledgeId(id);
        const row = this.db.prepare('SELECT content FROM revisions WHERE id=? AND revision=?').get(bareId, revision);
        if (!row)
            throw new DomainError('not_found', `Revision ${bareId}@${revision} does not exist`, 404);
        let content;
        try {
            content = JSON.parse(String(row.content));
        }
        catch {
            throw new DomainError('internal_error', `Revision ${bareId}@${revision} is unreadable`, 500);
        }
        if (!applicable(content.scope, projectId)) {
            throw new DomainError('not_found', `Knowledge entry ${bareId} is unavailable`, 404);
        }
        const head = this.head(bareId);
        const proseOf = (value) => {
            switch (value.kind) {
                case 'skill':
                case 'memory':
                case 'norm':
                case 'preference':
                case 'material': return value.body;
                case 'journal': return value.did;
                case 'workflow': return value.overview;
            }
        };
        return {
            id: bareId, revision,
            isCurrent: head?.revision === revision,
            currentRevision: head?.revision ?? null,
            currentStatus: head?.status ?? null,
            kind: content.kind, title: content.title,
            body: proseOf(content),
            scope: content.scope,
            provenance: content.provenance,
            evidence: content.evidence,
            createdAt: Number(this.db.prepare('SELECT created_at FROM revisions WHERE id=? AND revision=?').get(bareId, revision).created_at),
            note: '这是历史修订的只读视图；如需以旧版为准，请先提交候选并按审阅流程更新。',
        };
    }
    /** Head lookup that also sees retired entries, for history display only. */
    decodeAny(id) {
        const row = this.db.prepare(`SELECT k.id,k.head,k.status,r.content FROM knowledge k
      JOIN revisions r ON k.id=r.id AND k.head=r.revision WHERE k.id=?`).get(id);
        return row && this.decode(row);
    }
    stats() {
        this.cleanup();
        // Undelivered work is part of the library's state, so it belongs in the same
        // summary as entries and candidates: an operator asking "is anything stuck?"
        // should not have to know a second endpoint to find out.
        const outbox = Object.fromEntries(this.db.prepare("SELECT status, count(*) AS n FROM outbox WHERE status IN ('pending','failed','abandoned') GROUP BY status")
            .all().map(row => [String(row.status), Number(row.n)]));
        return { knowledgeRevision: this.revision, entries: this.current().length,
            pendingProposals: Number(this.db.prepare("SELECT count(*) AS n FROM proposals WHERE state='pending'").get().n),
            events: Number(this.db.prepare('SELECT count(*) AS n FROM events').get().n),
            tasks: Number(this.db.prepare('SELECT count(*) AS n FROM tasks').get().n),
            adoptions: Number(this.db.prepare('SELECT count(*) AS n FROM adoptions WHERE revoked_at IS NULL').get().n),
            supersessions: Number(this.db.prepare('SELECT count(*) AS n FROM supersessions').get().n),
            outbox: { pending: Number(outbox.pending ?? 0), failed: Number(outbox.failed ?? 0), abandoned: Number(outbox.abandoned ?? 0) },
            lastRescanAt: Number(this.db.prepare("SELECT value FROM meta WHERE key='lastRescanAt'").get().value) };
    }
}
