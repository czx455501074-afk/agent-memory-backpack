import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DomainError, knowledgeSchema } from './schema.js';
import { digestSchema, validateWorkflowDraft, workflowSourceHash } from './workflow-draft.js';
export const BACKUP_FORMAT = 'agent-memory-backpack-backup-v1';
export const BACKUP_VERSION = 1;
export const BACKUP_MARKER = 'backup-manifest.json';
const tables = ['knowledge', 'revisions', 'workflow_search', 'supersessions', 'adoptions', 'tasks', 'proposals', 'events', 'meta'];
// Review results are durable knowledge metadata. Execution queues and revision
// notifications belong to the originating machine and must not run on restore.
const optionalTables = ['model_reviews', 'workflow_drafts'];
const reviewColumns = ['proposal_id', 'project_id', 'result', 'updated_at'];
const draftColumns = ['id', 'project_id', 'skill_id', 'source_hash', 'state', 'result', 'updated_at'];
const metaKeys = ['revision', 'scanRoots', 'rescanIntervalMs'];
const portableMeta = (key) => metaKeys.includes(key) || /^checkpoint:[a-f0-9]{64}$/.test(key);
const hasTable = (store, table) => Boolean(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => JSON.stringify(value, null, 2) + '\n';
function refuse(message) { throw new DomainError('invalid_backup', message); }
/** Only data files travel; host configuration and credentials never do. */
function guard(directory) {
    if (!existsSync(directory))
        return;
    if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())
        refuse('Backup directory must be a plain directory');
    for (const name of readdirSync(directory)) {
        if (/^(core\.json|.*-client\.json|\.credentials.*|\.env.*)$|token|secret|credential|\.(sqlite.*|db|pem|key)$/i.test(name))
            refuse(`Credential-shaped file refused: ${name}`);
        const path = join(directory, name), info = lstatSync(path);
        if (info.isSymbolicLink())
            refuse(`Symbolic link refused: ${name}`);
        if (info.isDirectory())
            guard(path);
        else if (!info.isFile())
            refuse(`Non-regular file refused: ${name}`);
    }
}
function guardContent(value) {
    if (typeof value === 'string') {
        if (/(?:^|[\\/\s"'])(?:core\.json|[^\\/\s"']*-client\.json|\.credentials[^\\/\s"']*|[^\\/\s"']*\.sqlite(?:-wal|-shm)?)(?:$|[\s"'])/i.test(value))
            refuse('Credential-shaped file reference refused');
        if (/\b(?:sk-[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9]{20,}|Bearer\s+[a-zA-Z0-9._-]+)|-----BEGIN .*PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)\s*["']?\s*[:=]\s*["']?[^\s"',}]+/i.test(value))
            refuse('Credential-shaped content refused');
        if (/^\s*[\[{]/.test(value)) {
            let parsed;
            try {
                parsed = JSON.parse(value);
            }
            catch {
                return;
            }
            guardContent(parsed);
        }
    }
    else if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
            if (/^(?:token|api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|credentials?)$/i.test(key))
                refuse('Credential-shaped field refused');
            guardContent(item);
        }
    }
}
function rows(store, table) {
    return store.db.prepare(`SELECT * FROM ${table}`).all();
}
function load(directory) {
    guard(directory);
    try {
        const manifest = JSON.parse(readFileSync(join(directory, BACKUP_MARKER), 'utf8'));
        if (manifest.format !== BACKUP_FORMAT || manifest.version !== BACKUP_VERSION || !Number.isFinite(Date.parse(manifest.exportedAt)))
            refuse('Backup marker or version mismatch');
        const names = Object.keys(manifest.files);
        if (tables.some(table => !names.includes(`${table}.json`)) || names.some(name => ![...tables, ...optionalTables].some(table => name === `${table}.json`)))
            refuse('Backup file list mismatch');
        const data = {};
        // Verify all bytes before interpreting rows or touching the destination.
        const texts = new Map();
        for (const table of [...tables, ...optionalTables.filter(table => names.includes(`${table}.json`))]) {
            const name = `${table}.json`, text = readFileSync(join(directory, name), 'utf8');
            if (hash(text) !== manifest.files[name])
                refuse(`Backup hash mismatch: ${name}`);
            texts.set(table, text);
        }
        for (const table of [...tables, ...optionalTables.filter(table => names.includes(`${table}.json`))]) {
            const value = JSON.parse(texts.get(table));
            if (!Array.isArray(value) || value.length !== manifest.counts[table])
                refuse(`Backup count mismatch: ${table}`);
            guardContent(value);
            data[table] = value;
        }
        return { data };
    }
    catch (error) {
        if (error instanceof DomainError)
            throw error;
        refuse(`Cannot read backup: ${error.message}`);
    }
}
/** Snapshot every authority table, including retired heads and immutable history. */
export function exportAll(store, options) {
    const directory = resolve(options.directory);
    guard(directory);
    if (existsSync(directory))
        load(directory);
    const data = {}, skipped = [];
    store.db.exec('BEGIN');
    try {
        for (const table of tables)
            data[table] = rows(store, table).filter(row => table !== 'meta' || portableMeta(String(row.key)));
        for (const table of optionalTables)
            if (hasTable(store, table))
                data[table] = rows(store, table);
        for (const row of rows(store, 'meta'))
            if (!portableMeta(String(row.key)))
                skipped.push({ id: `meta:${row.key}`, reason: 'Device-local bookkeeping is not portable' });
        const known = new Set([...tables, ...optionalTables]);
        for (const row of store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
            const name = String(row.name);
            if (!known.has(name))
                skipped.push({ id: name, reason: ['maintenance_jobs', 'revision_notifications', 'outbox'].includes(name) ? 'Device-local executable queues and notifications are not restored; current configuration reconciles fresh jobs' : name.startsWith('workflow_search_') || name === 'sqlite_sequence' ? 'SQLite internal state is regenerated from exported rows' : 'Unknown table is not supported by this backup version' });
        }
    }
    finally {
        store.db.exec('ROLLBACK');
    }
    guardContent(data);
    const counts = Object.fromEntries(Object.keys(data).map(table => [table, data[table].length]));
    const files = Object.fromEntries(Object.keys(data).map(table => [`${table}.json`, json(data[table])]));
    const manifest = json({ format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, hash(text)])), counts, skipped });
    const written = [...Object.keys(files), BACKUP_MARKER].map(name => join(directory, name));
    if (!options.dryRun) {
        mkdirSync(directory, { recursive: true });
        for (const [name, text] of Object.entries(files))
            writeFileSync(join(directory, name), text, 'utf8');
        writeFileSync(join(directory, BACKUP_MARKER), manifest, 'utf8');
    }
    return { directory, written, counts, skipped };
}
/** Merge without deleting local rows; immutable history must agree byte for byte. */
export function importAll(store, options) {
    const { data } = load(resolve(options.directory));
    const apply = () => {
        const conflicts = [], blocked = new Set();
        const operations = [];
        let imported = 0, skipped = 0;
        const equal = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
        const conflict = (id, reason) => { conflicts.push({ id, reason }); };
        // Reject unknown columns, duplicate primary keys and malformed knowledge first.
        const importedTables = [...tables, ...optionalTables.filter(table => data[table] !== undefined)];
        for (const table of importedTables) {
            const schema = table === 'model_reviews' || table === 'workflow_drafts'
                ? (table === 'model_reviews' ? reviewColumns : draftColumns).map(name => ({ name, type: name === 'updated_at' ? 'INTEGER' : 'TEXT', notnull: table === 'workflow_drafts' && name === 'result' ? 0 : 1, pk: name === (table === 'model_reviews' ? 'proposal_id' : 'id') ? 1 : 0 }))
                : store.db.prepare(`PRAGMA table_info(${table})`).all();
            const columns = schema.map(row => String(row.name)).sort();
            const seen = new Set();
            const alternateKeys = new Set();
            for (const row of data[table]) {
                if (!row || typeof row !== 'object' || JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(columns) || Object.values(row).some(v => v !== null && typeof v !== 'string' && (typeof v !== 'number' || !Number.isSafeInteger(v))))
                    refuse(`Invalid row: ${table}`);
                for (const field of schema) {
                    const value = row[String(field.name)];
                    if (value === null && (field.notnull || field.pk))
                        refuse(`Null required column: ${table}.${field.name}`);
                    if (value !== null && field.type === 'TEXT' && typeof value !== 'string')
                        refuse(`Invalid text column: ${table}.${field.name}`);
                    if (value !== null && field.type === 'INTEGER' && typeof value !== 'number' && table !== 'meta')
                        refuse(`Invalid integer column: ${table}.${field.name}`);
                }
                const key = table === 'meta' ? row.key : table === 'model_reviews' ? row.proposal_id : table === 'revisions' ? `${row.id}:${row.revision}` : row.id;
                if (seen.has(String(key)))
                    refuse(`Duplicate row: ${table}:${key}`);
                seen.add(String(key));
                if (table === 'proposals' || table === 'events') {
                    const alternate = JSON.stringify([row.principal, row[table === 'events' ? 'event_id' : 'idem']]);
                    if (alternateKeys.has(alternate))
                        refuse(`Duplicate idempotency key: ${table}`);
                    alternateKeys.add(alternate);
                }
                if (table === 'revisions') {
                    let parsed;
                    try {
                        parsed = JSON.parse(String(row.content));
                    }
                    catch {
                        refuse(`Invalid knowledge JSON: ${row.id}`);
                    }
                    const content = knowledgeSchema.safeParse(parsed);
                    if (!content.success || content.data.id !== row.id || content.data.baseRevision + 1 !== row.revision)
                        refuse(`Invalid knowledge revision: ${row.id}`);
                }
                if (table === 'meta' && !portableMeta(String(row.key)))
                    refuse('Unsupported metadata key');
                if (table === 'model_reviews') {
                    let result;
                    try {
                        result = JSON.parse(String(row.result));
                    }
                    catch {
                        refuse('Invalid model review JSON');
                    }
                    if (!result || typeof result !== 'object' || Array.isArray(result))
                        refuse('Invalid model review result');
                    if (!data.proposals.some(proposal => proposal.id === row.proposal_id && proposal.project_id === row.project_id))
                        refuse('Orphan model review');
                }
                if (table === 'workflow_drafts') {
                    if (!['pending', 'ready_for_review', 'needs_evidence', 'awaiting_model', 'stale', 'approved'].includes(String(row.state))
                        || !/^[a-f0-9]{64}$/.test(String(row.source_hash)))
                        refuse('Invalid workflow draft state/source');
                    if (!data.revisions.some(revision => revision.id === row.skill_id && JSON.parse(String(revision.content)).kind === 'skill'))
                        refuse('Orphan workflow draft');
                    if (row.result !== null) {
                        let result;
                        try {
                            result = JSON.parse(String(row.result));
                        }
                        catch {
                            refuse('Invalid workflow draft JSON');
                        }
                        if (!result || typeof result !== 'object' || Array.isArray(result) || result.authority !== 'advisory' || result.executable !== false
                            || !['ready_for_review', 'needs_evidence', 'awaiting_model'].includes(String(result.status))
                            || !Array.isArray(result.missing) || !Array.isArray(result.grounding) || !Array.isArray(result.references))
                            refuse('Invalid workflow draft result');
                        if (result.digest !== undefined && !digestSchema.safeParse(result.digest).success)
                            refuse('Invalid workflow draft digest');
                        if (result.organization !== undefined && (!result.organization || typeof result.organization !== 'object' || Array.isArray(result.organization)))
                            refuse('Invalid workflow organization status');
                        const source = result.source;
                        if (!source || source.skillId !== row.skill_id || source.hash !== row.source_hash || !Number.isSafeInteger(source.revision))
                            refuse('Invalid workflow draft source binding');
                        const original = data.revisions.find(revision => revision.id === row.skill_id && revision.revision === source.revision);
                        if (!original)
                            refuse('Missing workflow draft source revision');
                        const skill = knowledgeSchema.parse(JSON.parse(String(original.content)));
                        if (skill.kind !== 'skill')
                            refuse('Invalid workflow draft source kind');
                        const snapshot = { skillId: String(row.skill_id), skillRevision: Number(source.revision), skill };
                        if (workflowSourceHash(snapshot) !== row.source_hash)
                            refuse('Workflow draft source hash mismatch');
                        const validated = validateWorkflowDraft(snapshot, { workflow: result.workflow, grounding: result.grounding, missing: result.missing });
                        if ((row.state === 'ready_for_review' || row.state === 'approved') && validated.status !== 'ready_for_review')
                            refuse('Ungrounded workflow draft');
                        if (JSON.stringify(result.references) !== JSON.stringify(validated.references))
                            refuse('Workflow draft reference snapshot mismatch');
                    }
                    else if (['ready_for_review', 'approved'].includes(String(row.state)))
                        refuse('Workflow draft result is required');
                }
                if (table === 'knowledge' && (!['active', 'retired'].includes(String(row.status)) || Number(row.head) < 1))
                    refuse('Invalid knowledge head');
                if (table === 'tasks' && !['in_progress', 'paused', 'completed', 'cancelled', 'failed'].includes(String(row.status)))
                    refuse('Invalid task status');
                if (table === 'supersessions' && (!['supersede', 'supplement'].includes(String(row.action)) || !['rescan', 'agent', 'user'].includes(String(row.origin))))
                    refuse('Invalid supersession');
            }
        }
        if (metaKeys.some(key => !data.meta.some(row => row.key === key)) || data.meta.some(r => metaKeys.includes(String(r.key)) && r.key !== 'scanRoots' && (typeof r.value !== 'number' || r.value < 0)))
            refuse('Invalid or missing required metadata');
        for (const row of data.meta.filter(row => String(row.key).startsWith('checkpoint:'))) {
            try {
                const value = JSON.parse(String(row.value));
                if (!value || typeof value !== 'object' || Array.isArray(value))
                    refuse('Invalid checkpoint receipt');
            }
            catch {
                refuse('Invalid checkpoint receipt');
            }
        }
        for (const row of data.workflow_search)
            if (!data.knowledge.some(k => k.id === row.id && k.status === 'active' && k.kind !== 'norm'))
                refuse(`Orphan search row: ${row.id}`);
        for (const head of data.knowledge) {
            if (!data.revisions.some(r => r.id === head.id && r.revision === head.head && JSON.parse(String(r.content)).kind === head.kind))
                refuse(`Missing head revision: ${head.id}`);
            const local = store.db.prepare('SELECT * FROM knowledge WHERE id=?').get(head.id);
            const divergent = data.revisions.some(r => {
                if (r.id !== head.id)
                    return false;
                const previous = store.db.prepare('SELECT * FROM revisions WHERE id=? AND revision=?').get(r.id, r.revision);
                return previous && !equal(previous, r);
            });
            if (local && (Number(local.head) > Number(head.head) || local.kind !== head.kind || divergent || (local.head === head.head && !equal(local, head)))) {
                blocked.add(String(head.id));
                conflict(String(head.id), 'Local knowledge is newer or divergent');
            }
        }
        for (const revision of data.revisions)
            if (!data.knowledge.some(k => k.id === revision.id && Number(k.head) >= Number(revision.revision)))
                refuse(`Orphan revision: ${revision.id}`);
        for (const table of importedTables)
            for (const row of data[table]) {
                if ((['knowledge', 'revisions', 'workflow_search'].includes(table) && blocked.has(String(row.id))) || (table === 'adoptions' && blocked.has(String(row.knowledge_id))) || (table === 'supersessions' && (blocked.has(String(row.old_knowledge_id)) || blocked.has(String(row.new_knowledge_id))))) {
                    skipped++;
                    continue;
                }
                const localRows = hasTable(store, table) ? rows(store, table) : [];
                if (localRows.some(local => table === 'supersessions' ? equal({ ...local, id: null }, { ...row, id: null }) : equal(local, row))) {
                    skipped++;
                    continue;
                }
                if (table === 'meta') {
                    const local = localRows.find(r => r.key === row.key);
                    if (String(row.key).startsWith('checkpoint:') && local) {
                        conflict(`meta:${row.key}`, 'Local checkpoint receipt differs');
                        skipped++;
                        continue;
                    }
                    if (row.key === 'revision') {
                        const next = Math.max(Number(local?.value ?? 0), Number(row.value));
                        if (next === local?.value) {
                            skipped++;
                            continue;
                        }
                        row.value = next;
                    }
                    else if (metaKeys.includes(String(row.key)) && Number(localRows.find(r => r.key === 'revision')?.value ?? 0) !== 0) {
                        conflict(`meta:${row.key}`, 'Local settings preserved');
                        skipped++;
                        continue;
                    }
                    operations.push(() => { store.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(row.key, row.value); });
                    continue;
                }
                const sameKey = localRows.find(local => table === 'model_reviews' ? local.proposal_id === row.proposal_id : table === 'revisions' ? local.id === row.id && local.revision === row.revision : local.id === row.id);
                const alternateKey = ['events', 'proposals'].includes(table) && localRows.some(local => local.principal === row.principal && local[table === 'events' ? 'event_id' : 'idem'] === row[table === 'events' ? 'event_id' : 'idem']);
                if ((sameKey && !['knowledge', 'workflow_search', 'supersessions'].includes(table)) || alternateKey) {
                    conflict(`${table}:${row.id}`, 'Local ledger row differs');
                    skipped++;
                    continue;
                }
                const columns = Object.keys(row).filter(c => !(table === 'supersessions' && sameKey && c === 'id'));
                operations.push(() => {
                    if (table === 'model_reviews')
                        store.db.exec('CREATE TABLE IF NOT EXISTS model_reviews(proposal_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, result TEXT NOT NULL, updated_at INTEGER NOT NULL)');
                    if (table === 'workflow_drafts')
                        store.db.exec('CREATE TABLE IF NOT EXISTS workflow_drafts(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,skill_id TEXT NOT NULL,source_hash TEXT NOT NULL,state TEXT NOT NULL,result TEXT,updated_at INTEGER NOT NULL)');
                    if (table === 'knowledge' && sameKey) {
                        store.db.prepare('UPDATE knowledge SET head=?,status=? WHERE id=?').run(row.head, row.status, row.id);
                        return;
                    }
                    if (sameKey && table === 'workflow_search')
                        store.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(row.id);
                    store.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(c => row[c]));
                });
                if (table === 'knowledge')
                    imported++;
            }
        if (conflicts.length && options.onConflict === 'fail')
            throw new DomainError('backup_conflict', `Backup conflicts: ${conflicts.map(c => c.id).join(', ')}`, 409);
        if (!options.dryRun)
            for (const operation of operations)
                operation();
        return { imported, skipped, conflicts, wrote: !options.dryRun && operations.length > 0 };
    };
    if (options.dryRun)
        return apply();
    store.db.exec('BEGIN IMMEDIATE');
    const result = (() => {
        try {
            const applied = apply();
            store.db.exec('COMMIT');
            return applied;
        }
        catch (error) {
            store.db.exec('ROLLBACK');
            if (error instanceof DomainError)
                throw error;
            throw new DomainError('invalid_backup', `Backup import failed: ${error.message}`);
        }
    })();
    // The design (§8) requires the expiry check to run on restore, so a lapsed page
    // cannot be brought back to life by importing an old archive. It runs after the
    // rows have landed — checking before would inspect a database that does not yet
    // hold the material it is judging — and after that transaction commits, because
    // the purge opens its own transaction and SQLite will not nest one inside another.
    store.purgeExpiredMaterial();
    return result;
}
