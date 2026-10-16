import { DomainError } from './schema.js';
import { generateSkillDigest, generateWorkflowDraft, isWorkflowDraftCurrent, validateWorkflowDraft, workflowSourceHash } from './workflow-draft.js';
export function initializeWorkflowDrafts(store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS workflow_drafts(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,skill_id TEXT NOT NULL,source_hash TEXT NOT NULL,state TEXT NOT NULL,result TEXT,updated_at INTEGER NOT NULL);`);
}
function sourceOf(store, projectId, skillId) {
    const entry = store.scopedEntries(projectId).find(e => e.id === skillId && e.content.kind === 'skill');
    if (!entry || entry.content.kind !== 'skill')
        throw new DomainError('not_found', 'Source skill unavailable', 404);
    return { skillId, skillRevision: entry.revision, skill: entry.content };
}
export function enqueueWorkflowDraft(store, projectId, skillId, regenerate = false) {
    initializeWorkflowDrafts(store);
    const source = sourceOf(store, projectId, skillId), hash = workflowSourceHash(source), id = `structure:${projectId}:${hash}`;
    // The visible candidate and its recoverable work must land together. A
    // savepoint also composes with callers already holding a SQLite transaction.
    store.db.exec('SAVEPOINT workflow_draft_enqueue');
    try {
        store.db.prepare("INSERT OR IGNORE INTO workflow_drafts VALUES(?,?,?,?,'pending',NULL,?)").run(id, projectId, skillId, hash, Date.now());
        const row = store.db.prepare('SELECT state,result FROM workflow_drafts WHERE id=?').get(id);
        const state = String(row.state), result = row.result ? JSON.parse(String(row.result)) : null;
        const hasDigest = Boolean(result?.digest);
        const jobKind = hasDigest ? 'structure_skill' : 'structure_skill_digest';
        const jobKey = hasDigest ? id : `digest:${id}`;
        const jobId = store.jobs.enqueue(jobKind, jobKey, { id, projectId, skillId, hash });
        if (regenerate && state !== 'approved' && store.jobs.requeue(jobId)) {
            if (result) {
                result.organization = { ...result.organization, [hasDigest ? 'workflow' : 'digest']: { status: 'pending', attempts: 0 } };
                store.db.prepare("UPDATE workflow_drafts SET state='pending',result=?,updated_at=? WHERE id=?").run(JSON.stringify(result), Date.now(), id);
            }
            else
                store.db.prepare("UPDATE workflow_drafts SET state='pending',updated_at=? WHERE id=?").run(Date.now(), id);
        }
        store.db.exec('RELEASE workflow_draft_enqueue');
    }
    catch (error) {
        store.db.exec('ROLLBACK TO workflow_draft_enqueue');
        store.db.exec('RELEASE workflow_draft_enqueue');
        throw error;
    }
    return { id, state: String(store.db.prepare('SELECT state FROM workflow_drafts WHERE id=?').get(id).state) };
}
export function listWorkflowDrafts(store, projectId) {
    initializeWorkflowDrafts(store);
    return store.db.prepare('SELECT id,skill_id,state,updated_at,result FROM workflow_drafts WHERE project_id=? ORDER BY updated_at DESC LIMIT 200').all(projectId)
        .map(row => {
        const result = row.result ? JSON.parse(String(row.result)) : null;
        let stale = false;
        try {
            if (result)
                stale = !isWorkflowDraftCurrent(result, sourceOf(store, projectId, String(row.skill_id)));
        }
        catch {
            stale = true;
        }
        const jobKind = result?.digest ? 'structure_skill' : 'structure_skill_digest', jobKey = result?.digest ? String(row.id) : `digest:${row.id}`;
        const job = store.db.prepare('SELECT status,attempts,error FROM maintenance_jobs WHERE idem=?').get(jobKey);
        const digestPart = result?.organization?.digest;
        return { id: row.id, skillId: row.skill_id, state: stale ? 'stale' : row.state, updatedAt: row.updated_at, title: result?.workflow?.title,
            missing: result?.missing ?? [], digest: stale ? undefined : result?.digest,
            digestStatus: stale ? 'stale' : digestPart?.status ?? (result?.digest ? 'ready' : job?.status === 'needs_action' ? 'needs_action' : job?.status === 'pending' || job?.status === 'running' ? 'pending' : 'pending'),
            digestAttempts: digestPart?.attempts ?? Number(job?.attempts ?? 0), digestError: digestPart?.reason ?? job?.error ?? undefined,
            workflowStatus: stale ? 'stale' : result?.organization?.workflow?.status ?? String(row.state), workflowAttempts: result?.organization?.workflow?.attempts ?? 0,
            workflowError: result?.organization?.workflow?.reason };
    });
}
export function readWorkflowDraft(store, projectId, id) {
    initializeWorkflowDrafts(store);
    const row = store.db.prepare('SELECT * FROM workflow_drafts WHERE id=? AND project_id=?').get(id, projectId);
    if (!row)
        throw new DomainError('not_found', 'Workflow draft unavailable', 404);
    const source = sourceOf(store, projectId, String(row.skill_id));
    const result = row.result ? JSON.parse(String(row.result)) : null;
    return { id, state: result && !isWorkflowDraftCurrent(result, source) ? 'stale' : String(row.state), result, source,
        digestStatus: result?.organization?.digest?.status ?? (result?.digest ? 'ready' : 'pending'),
        workflowStatus: result?.organization?.workflow?.status ?? String(row.state) };
}
export function reviseWorkflowDraft(store, projectId, id, raw) {
    const detail = readWorkflowDraft(store, projectId, id);
    if (detail.state === 'approved')
        throw new DomainError('already_reviewed', 'Generate a new draft to revise an approved workflow', 409);
    if (!detail.result || !isWorkflowDraftCurrent(detail.result, detail.source))
        throw new DomainError('revision_conflict', 'Source changed; regenerate the draft', 409);
    // Editing the procedural proposal does not discard source-bound retrieval metadata.
    const input = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? { ...raw, ...(!('digest' in raw) && detail.result.digest ? { digest: detail.result.digest } : {}) } : raw;
    const result = validateWorkflowDraft(detail.source, input);
    result.organization = { ...detail.result.organization, workflow: { status: result.status, attempts: detail.result.organization?.workflow?.attempts ?? 0 } };
    store.db.prepare('UPDATE workflow_drafts SET state=?,result=?,updated_at=? WHERE id=? AND project_id=?').run(result.status, JSON.stringify(result), Date.now(), id, projectId);
    return { state: result.status, missing: result.missing };
}
export async function processWorkflowDraft(store, payload, config, attempt = 1) {
    const id = String(payload.id), projectId = String(payload.projectId);
    const row = store.db.prepare('SELECT state,source_hash FROM workflow_drafts WHERE id=? AND project_id=?').get(id, projectId);
    if (!row || row.state === 'approved')
        return { status: 'skipped' };
    let source;
    try {
        source = sourceOf(store, projectId, String(payload.skillId));
    }
    catch {
        store.db.prepare("UPDATE workflow_drafts SET state='stale' WHERE id=?").run(id);
        return { status: 'stale' };
    }
    if (workflowSourceHash(source) !== row.source_hash) {
        store.db.prepare("UPDATE workflow_drafts SET state='stale' WHERE id=?").run(id);
        return { status: 'stale' };
    }
    const priorRow = store.db.prepare('SELECT result FROM workflow_drafts WHERE id=?').get(id);
    const prior = priorRow?.result ? JSON.parse(String(priorRow.result)) : null;
    const result = await generateWorkflowDraft(source, config, !prior?.digest);
    // Model I/O yields the event loop: a watched source may change while it runs.
    let current;
    try {
        current = sourceOf(store, projectId, String(payload.skillId));
    }
    catch {
        current = undefined;
    }
    if (!current || !isWorkflowDraftCurrent(result, current)) {
        store.db.prepare("UPDATE workflow_drafts SET state='stale',updated_at=? WHERE id=?").run(Date.now(), id);
        return { status: 'stale' };
    }
    if (prior?.digest)
        result.digest = prior.digest;
    result.organization = { ...prior?.organization, workflow: { status: result.status === 'awaiting_model' ? (attempt >= 5 ? 'needs_action' : 'awaiting_model') : result.status, attempts: attempt,
            ...(result.reason ? { reason: result.reason } : {}) } };
    if (result.digest && !prior?.digest)
        result.organization.digest = { status: 'ready', attempts: attempt };
    store.db.prepare('UPDATE workflow_drafts SET state=?,result=?,updated_at=? WHERE id=?').run(result.status, JSON.stringify(result), Date.now(), id);
    return { status: result.status };
}
export async function processWorkflowDigest(store, payload, config, attempt = 1) {
    const id = String(payload.id), projectId = String(payload.projectId);
    const row = store.db.prepare('SELECT state,result,source_hash FROM workflow_drafts WHERE id=? AND project_id=?').get(id, projectId);
    if (!row || row.state === 'approved')
        return { status: 'skipped' };
    let source;
    try {
        source = sourceOf(store, projectId, String(payload.skillId));
    }
    catch {
        store.db.prepare("UPDATE workflow_drafts SET state='stale' WHERE id=?").run(id);
        return { status: 'stale' };
    }
    if (workflowSourceHash(source) !== row.source_hash) {
        store.db.prepare("UPDATE workflow_drafts SET state='stale' WHERE id=?").run(id);
        return { status: 'stale' };
    }
    const prior = row.result ? JSON.parse(String(row.result)) : validateWorkflowDraft(source, { workflow: null, grounding: [], missing: [] });
    if (prior.digest) {
        store.jobs.enqueue('structure_skill', id, { id, projectId, skillId: source.skillId, hash: row.source_hash });
        return { status: 'ready', reused: true };
    }
    const generated = await generateSkillDigest(source, config);
    let current;
    try {
        current = sourceOf(store, projectId, String(payload.skillId));
    }
    catch {
        current = undefined;
    }
    if (!current || workflowSourceHash(current) !== row.source_hash) {
        store.db.prepare("UPDATE workflow_drafts SET state='stale',result=?,updated_at=? WHERE id=?").run(JSON.stringify(prior), Date.now(), id);
        return { status: 'stale' };
    }
    const maxAttempts = 3, part = generated.digest
        ? { status: 'ready', attempts: attempt }
        : { status: attempt >= maxAttempts ? 'needs_action' : 'awaiting_model', attempts: attempt, reason: generated.reason ?? 'invalid_response' };
    prior.organization = { ...prior.organization, digest: part };
    if (generated.digest)
        prior.digest = generated.digest;
    store.db.prepare('UPDATE workflow_drafts SET result=?,updated_at=? WHERE id=?').run(JSON.stringify(prior), Date.now(), id);
    if (generated.digest)
        store.jobs.enqueue('structure_skill', id, { id, projectId, skillId: source.skillId, hash: row.source_hash });
    else if (attempt >= maxAttempts)
        store.db.prepare("UPDATE workflow_drafts SET state='awaiting_model' WHERE id=?").run(id);
    return { status: part.status, reason: part.reason };
}
export function approveWorkflowDraft(store, projectId, id) {
    const detail = readWorkflowDraft(store, projectId, id);
    if (detail.state === 'approved')
        return { state: 'approved', workflowId: detail.result?.workflow?.id, duplicate: true };
    if (!detail.result || !isWorkflowDraftCurrent(detail.result, detail.source))
        throw new DomainError('revision_conflict', 'Source changed; regenerate the draft', 409);
    // Only the extracted response is accepted; metadata is not part of the model schema.
    const validated = validateWorkflowDraft(detail.source, { workflow: detail.result.workflow, grounding: detail.result.grounding, missing: detail.result.missing });
    if (validated.status !== 'ready_for_review' || !validated.workflow)
        throw new DomainError('needs_evidence', 'Draft has unresolved completeness or grounding issues', 409);
    const prior = store.scopedEntries(projectId).find(e => e.id === validated.workflow.id);
    const exists = store.db.prepare('SELECT id FROM knowledge WHERE id=?').get(validated.workflow.id);
    if ((exists && !prior) || (prior && (prior.content.kind !== 'workflow' || prior.content.derivedFrom?.skillId !== detail.source.skillId)))
        throw new DomainError('target_mismatch', 'Draft id collides with an unrelated existing entry', 409);
    let receipt;
    if (prior?.content.kind === 'workflow' && prior.content.derivedFrom?.skillId === detail.source.skillId && prior.content.derivedFrom.skillRevision === detail.source.skillRevision)
        receipt = { workflowId: prior.id, knowledgeRevision: store.revision };
    else
        receipt = store.structureSkill({ skillId: detail.source.skillId, expectedSkillRevision: detail.source.skillRevision, workflow: validated.workflow,
            derivedBy: 'agent', evidence: `Human reviewed grounded draft ${id}`, projectId, keepSource: true });
    store.db.prepare("UPDATE workflow_drafts SET state='approved',updated_at=? WHERE id=?").run(Date.now(), id);
    return { ...receipt, state: 'approved', duplicate: false };
}
