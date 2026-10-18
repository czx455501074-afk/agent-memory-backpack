import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DomainError, knowledgeSchema } from './schema.js';
import type { Store } from './store.js';
import { digestSchema, validateWorkflowDraft, workflowSourceHash } from './workflow-draft.js';
// The credential judgement is shared with the write path (see redact.ts): one definition, so
// an export and a write can never disagree about the same bytes.
import { CREDENTIAL_PATTERN, credentialRule, redactDeep, type RedactionFinding } from './redact.js';

export const BACKUP_FORMAT = 'agent-memory-backpack-backup-v1';
export const BACKUP_VERSION = 1;
export const BACKUP_MARKER = 'backup-manifest.json';
export interface BackupExportResult { directory: string; written: string[]; counts: Record<string, number>; skipped: Array<{ id: string; reason: string }>; redactions?: Array<{ where: string; rule: string }>; }
export interface BackupImportResult { imported: number; skipped: number; conflicts: Array<{ id: string; reason: string }>; wrote: boolean; }
type Row = Record<string, string | number | null>;
const tables = ['knowledge', 'revisions', 'workflow_search', 'supersessions', 'adoptions', 'tasks', 'proposals', 'events', 'meta'] as const;
// Review results are durable knowledge metadata. Execution queues and revision
// notifications belong to the originating machine and must not run on restore.
const optionalTables = ['model_reviews', 'workflow_drafts'] as const;
const reviewColumns = ['proposal_id', 'project_id', 'result', 'updated_at'];
const draftColumns = ['id', 'project_id', 'skill_id', 'source_hash', 'state', 'result', 'updated_at'];
const metaKeys = ['revision', 'scanRoots', 'rescanIntervalMs'];
const portableMeta = (key: string) => metaKeys.includes(key) || /^checkpoint:[a-f0-9]{64}$/.test(key);
const hasTable = (store: Store, table: string) => Boolean(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
function refuse(message: string): never { throw new DomainError('invalid_backup', message); }

/** Only data files travel; host configuration and credentials never do. */
function guard(directory: string): void {
  if (!existsSync(directory)) return;
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) refuse('Backup directory must be a plain directory');
  for (const name of readdirSync(directory)) {
    if (/^(core\.json|.*-client\.json|\.credentials.*|\.env.*)$|token|secret|credential|\.(sqlite.*|db|pem|key)$/i.test(name))
      refuse(`Credential-shaped file refused: ${name}`);
    const path = join(directory, name), info = lstatSync(path);
    if (info.isSymbolicLink()) refuse(`Symbolic link refused: ${name}`);
    if (info.isDirectory()) guard(path);
    else if (!info.isFile()) refuse(`Non-regular file refused: ${name}`);
  }
}
/**
 * Where a refusal came from, and which rule fired — never the matched text.
 *
 * The judgement itself lives in `redact.ts`, because the write path needs the same one: this
 * module only decides what to *do* about a hit (refuse, or rewrite when asked). Keeping two
 * copies is what would let the two paths disagree about the same bytes.
 */
type GuardFinding = RedactionFinding;

/** Refuse a located set of findings: first few by name, the rest by count. */
function refuseFindings(findings: GuardFinding[]): void {
  if (!findings.length) return;
  const shown = findings.slice(0, 8).map(item => `${item.where}〔${item.rule}〕`).join('；');
  const rest = findings.length > 8 ? `；另有 ${findings.length - 8} 处` : '';
  refuse(`Credential-shaped content refused：${findings.length} 处（${shown}${rest}）`
    + '。定位到的位置与规则如上，命中的值一律不回显；'
    + '要保留这份内容，用 backup --redact-credentials 导出（命中值会被替换，凭证形状的字节不进包），'
    + '或按定位改写该条内容后重试。');
}

function redactRow(row: Row, where: string): { value: Row; hits: GuardFinding[] } {
  const { value, findings } = redactDeep(row, where);
  return { value, hits: findings };
}

function guardContent(value: unknown, where: string, findings: GuardFinding[]): void {
  if (typeof value === 'string') {
    // Naming a file is not holding one. The file-level guard above already refuses
    // to put `core.json`, `*-client.json` or `.credentials*` into the archive, so by
    // the time content is checked the bytes are guaranteed absent; refusing a *mention*
    // on top of that blocked a real library whose own notes explain where the
    // credential lives - which is precisely the sentence a later reader needs.
    // A credential *value* is still refused by the check below.
    // Every match, not just the first. A body that mentions a placeholder early and a
    // credential-shaped value later was cleared on the strength of the placeholder, while
    // the redacting scan below — which walks all matches — rewrote that same body. Two
    // halves of one guard disagreeing about the same bytes is both a missed detection and
    // the reason a redacted archive failed to import: the rewrite invalidated a workflow
    // draft's binding to a revision the strict scan had called clean.
    for (const m of value.matchAll(new RegExp(CREDENTIAL_PATTERN.source, 'gi'))) {
      const rule = credentialRule(m as unknown as RegExpExecArray);
      if (rule) findings.push({ where, rule });
    }
    if (/^\s*[\[{]/.test(value)) { let parsed: unknown; try { parsed = JSON.parse(value); } catch { return; } guardContent(parsed, where, findings); }
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:token|api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|credentials?)$/i.test(key)) {
        findings.push({ where: `${where}.${key}`, rule: '凭据字段名' });
        continue;
      }
      guardContent(item, `${where}.${key}`, findings);
    }
  }
}
function rows(store: Store, table: string): Row[] {
  return store.db.prepare(`SELECT * FROM ${table}`).all() as Row[];
}
function load(directory: string): { data: Record<string, Row[]> } {
  guard(directory);
  try {
    const manifest = JSON.parse(readFileSync(join(directory, BACKUP_MARKER), 'utf8'));
    if (manifest.format !== BACKUP_FORMAT || manifest.version !== BACKUP_VERSION || !Number.isFinite(Date.parse(manifest.exportedAt))) refuse('Backup marker or version mismatch');
    const names = Object.keys(manifest.files);
    if (tables.some(table => !names.includes(`${table}.json`)) || names.some(name => ![...tables, ...optionalTables].some(table => name === `${table}.json`))) refuse('Backup file list mismatch');
    const data: Record<string, Row[]> = {};
    // Verify all bytes before interpreting rows or touching the destination.
    const texts = new Map<string, string>();
    for (const table of [...tables, ...optionalTables.filter(table => names.includes(`${table}.json`))]) {
      const name = `${table}.json`, text = readFileSync(join(directory, name), 'utf8');
      if (hash(text) !== manifest.files[name]) refuse(`Backup hash mismatch: ${name}`);
      texts.set(table, text);
    }
    for (const table of [...tables, ...optionalTables.filter(table => names.includes(`${table}.json`))]) {
      const value = JSON.parse(texts.get(table)!);
      if (!Array.isArray(value) || value.length !== manifest.counts[table]) refuse(`Backup count mismatch: ${table}`);
      // The same exemption the export side already makes, for the same reason: this table
      // is a derived, normalised projection of text whose authority travels in `revisions`.
      // Checking it here and not there made an archive that was written successfully fail
      // to import — a one-sided rule reads as "the package is corrupt" when the bytes are
      // exactly what the exporter produced.
      if (table !== 'workflow_search') {
        const findings: GuardFinding[] = [];
        guardContent(value, table, findings);
        refuseFindings(findings);
      }
      data[table] = value;
    }
    return { data };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    refuse(`Cannot read backup: ${(error as Error).message}`);
  }
}

/** Snapshot every authority table, including retired heads and immutable history. */
export function exportAll(store: Store, options: { directory: string; dryRun?: boolean; redactCredentials?: boolean }): BackupExportResult {
  const directory = resolve(options.directory);
  guard(directory);
  if (existsSync(directory)) load(directory);
  const data: Record<string, Row[]> = {}, skipped: BackupExportResult['skipped'] = [];
  store.db.exec('BEGIN');
  try {
    for (const table of tables) data[table] = rows(store, table).filter(row => table !== 'meta' || portableMeta(String(row.key)));
    for (const table of optionalTables) if (hasTable(store, table)) data[table] = rows(store, table);
    for (const row of rows(store, 'meta')) if (!portableMeta(String(row.key))) skipped.push({ id: `meta:${row.key}`, reason: 'Device-local bookkeeping is not portable' });
    const known = new Set<string>([...tables, ...optionalTables]);
    for (const row of store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
      const name = String(row.name);
      if (!known.has(name)) skipped.push({ id: name, reason: ['maintenance_jobs', 'revision_notifications', 'outbox'].includes(name) ? 'Device-local executable queues and notifications are not restored; current configuration reconciles fresh jobs' : name.startsWith('workflow_search_') || name === 'sqlite_sequence' ? 'SQLite internal state is regenerated from exported rows' : 'Unknown table is not supported by this backup version' });
    }
  } finally { store.db.exec('ROLLBACK'); }
  /**
   * Carry only the index rows the authority tables can still justify.
   *
   * The import side refuses a search row whose knowledge entry is retired or is a norm
   * (`Orphan search row`), and it is right to: the index is derived, so such a row asserts
   * a projection of something the package either does not carry as active or does not index
   * at all. The export side shipped all 906 rows of a real library anyway — 81 of them broke
   * that rule (7 norms, 74 retired entries) — so a package could be written successfully and
   * then fail to import, with the failure naming a row the user never created and cannot edit.
   * The rows are dropped here rather than tolerated on import, because the destination can
   * rebuild them from the authority tables and a one-sided rule is what made the pair
   * disagree in the first place.
   */
  if (data.workflow_search?.length) {
    const indexable = new Set(store.db.prepare("SELECT id FROM knowledge WHERE status='active' AND kind<>'norm'").all().map(row => String((row as { id: string }).id)));
    const kept = data.workflow_search.filter(row => indexable.has(String(row.id)));
    if (kept.length !== data.workflow_search.length) {
      skipped.push({ id: 'workflow_search', reason: `派生索引行 ${data.workflow_search.length - kept.length} 条没有对应的生效条目（已退役或不参与索引的规范），不随包迁移；目标库可由权威表重建索引` });
      data.workflow_search = kept;
    }
  }
  // The full-text index is derived from the rows above, and building it normalises
  // the text (lower-cased, punctuation stripped). That destroys exactly the shapes the
  // content guard looks for: a body that *describes* `-----BEGIN .*PRIVATE KEY-----`
  // is stored in the index as `-----begin private key-----`, which is
  // indistinguishable from a real header. The authoritative text is already checked
  // in `revisions`, so the index is skipped; refusing an export over a lossy
  // projection of text the user never wrote is a false positive with no security
  // value - and it was the single remaining blocker on a real library.
  // Every row reports its own location, and every hit is collected before anything is
  // refused: one failed run then enumerates the whole work list instead of its first item.
  const findings: GuardFinding[] = [];
  const redactions: GuardFinding[] = [];
  // Revisions the redacting pass rewrote, so anything bound to their bytes by hash can be
  // handled instead of shipping a package that fails its own integrity check on import.
  const rewrittenRevisions = new Set<string>();
  for (const [table, tableRows] of Object.entries(data)) {
    // The derived full-text table is skipped by the strict scan (see the note where it is
    // exported), but a redacting export still has to walk it: the index is a normalised
    // copy of the same bodies, so leaving it alone would put back a fragment of exactly the
    // value that was just removed from the authoritative text.
    if (table === 'workflow_search' && !options.redactCredentials) continue;
    const rowsOut: Row[] = [];
    for (const [index, row] of tableRows.entries()) {
      const id = row.id ?? row.key ?? row.proposal_id ?? '';
      const where = id === '' ? `${table}[${index}]` : `${table}:${id}`;
      if (options.redactCredentials) {
        const { value, hits } = redactRow(row, where);
        redactions.push(...hits);
        if (hits.length && table === 'revisions') rewrittenRevisions.add(`${String(row.id)}@${String(row.revision)}`);
        rowsOut.push(value as Row);
      } else {
        guardContent(row, where, findings);
        rowsOut.push(row);
      }
    }
    // The written bytes come from `data`, so a redacting export must replace the rows
    // here rather than only report them.
    if (options.redactCredentials) data[table] = rowsOut;
  }
  // A workflow draft is bound to its source revision by a hash of that revision's bytes.
  // Redacting those bytes makes the binding false, and the import path refuses a package
  // whose draft no longer matches its own source — correctly, since the draft was derived
  // from text that is no longer there. Rewriting the hash to fit would invent an approval
  // that never happened, so the draft is left out and the reason is recorded. It is not
  // lost: it stays on the machine it was created on, and the archive simply does not carry
  // a claim it can no longer support.
  if (options.redactCredentials && rewrittenRevisions.size && data.workflow_drafts?.length) {
    const kept: Row[] = [];
    for (const draft of data.workflow_drafts) {
      let bound: string | null = null;
      if (draft.result !== null && draft.result !== undefined) {
        try {
          const source = (JSON.parse(String(draft.result)) as { source?: { skillId?: unknown; revision?: unknown } }).source;
          if (source && source.skillId !== undefined && source.revision !== undefined)
            bound = `${String(source.skillId)}@${String(source.revision)}`;
        } catch { bound = null; }
      }
      if (bound && rewrittenRevisions.has(bound)) {
        skipped.push({ id: String(draft.id), reason: '草案绑定的来源正文含凭据形状的值，已按 --redact-credentials 改写，绑定不再成立；草案保留在源机器上，不随这个包迁移' });
        continue;
      }
      kept.push(draft);
    }
    data.workflow_drafts = kept;
  }
  // In the redacting mode nothing is refused: the strict path's objection is answered by
  // removing the bytes, which is what the objection was about. `findings` stays empty
  // there, and `redactions` records what was rewritten.
  if (!options.redactCredentials) refuseFindings(findings);
  const counts = Object.fromEntries(Object.keys(data).map(table => [table, data[table]!.length]));
  const files = Object.fromEntries(Object.keys(data).map(table => [`${table}.json`, json(data[table])]));
  const manifest = json({
    format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(),
    files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, hash(text)])), counts, skipped,
    // Redactions travel in the manifest so the package explains itself: a reader can see
    // that a value was removed, where, and under which rule — without the value.
    ...(redactions.length ? { redacted: redactions } : {}),
  });
  const written = [...Object.keys(files), BACKUP_MARKER].map(name => join(directory, name));
  if (!options.dryRun) {
    mkdirSync(directory, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text, 'utf8');
    writeFileSync(join(directory, BACKUP_MARKER), manifest, 'utf8');
  }
  return { directory, written, counts, skipped, ...(redactions.length ? { redactions } : {}) };
}

/** Merge without deleting local rows; immutable history must agree byte for byte. */
export function importAll(store: Store, options: { directory: string; dryRun?: boolean; onConflict?: 'skip' | 'fail' }): BackupImportResult {
  const { data } = load(resolve(options.directory));
  const apply = () => {
    const conflicts: BackupImportResult['conflicts'] = [], blocked = new Set<string>();
    const operations: Array<() => void> = [];
    let imported = 0, skipped = 0;
    const equal = (a: Row, b: Row) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
    const conflict = (id: string, reason: string) => { conflicts.push({ id, reason }); };
    // Reject unknown columns, duplicate primary keys and malformed knowledge first.
    const importedTables = [...tables, ...optionalTables.filter(table => data[table] !== undefined)];
    // Index the referenced tables once instead of scanning them per row. The scans below
    // were quadratic, and the draft check additionally re-parsed the same knowledge JSON
    // every time - with ~1900 revisions and ~150 drafts that is roughly 280k parses, which
    // turned a *preview* into minutes of CPU and left the service unresponsive.
    const proposalKeys = new Set((data.proposals ?? []).map(proposal => `${proposal.id}\u0000${proposal.project_id}`));
    const revisionKinds = new Map<string, string>();
    for (const revision of data.revisions ?? []) {
      // Malformed content is refused by the revisions pass below; here it simply has no kind.
      try {
        revisionKinds.set(String(revision.id), String(JSON.parse(String(revision.content)).kind));
      } catch {
        revisionKinds.set(String(revision.id), '');
      }
    }
    for (const table of importedTables) {
      const schema = table === 'model_reviews' || table === 'workflow_drafts'
        ? (table === 'model_reviews' ? reviewColumns : draftColumns).map(name => ({ name, type: name === 'updated_at' ? 'INTEGER' : 'TEXT', notnull: table === 'workflow_drafts' && name === 'result' ? 0 : 1, pk: name === (table === 'model_reviews' ? 'proposal_id' : 'id') ? 1 : 0 }))
        : store.db.prepare(`PRAGMA table_info(${table})`).all();
      const columns = schema.map(row => String(row.name)).sort();
      const seen = new Set<string>();
      const alternateKeys = new Set<string>();
      for (const row of data[table]!) {
        if (!row || typeof row !== 'object' || JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(columns) || Object.values(row).some(v => v !== null && typeof v !== 'string' && (typeof v !== 'number' || !Number.isSafeInteger(v)))) refuse(`Invalid row: ${table}`);
        for (const field of schema) {
          const value = row[String(field.name)];
          if (value === null && (field.notnull || field.pk)) refuse(`Null required column: ${table}.${field.name}`);
          if (value !== null && field.type === 'TEXT' && typeof value !== 'string') refuse(`Invalid text column: ${table}.${field.name}`);
          if (value !== null && field.type === 'INTEGER' && typeof value !== 'number' && table !== 'meta') refuse(`Invalid integer column: ${table}.${field.name}`);
        }
        const key = table === 'meta' ? row.key : table === 'model_reviews' ? row.proposal_id : table === 'revisions' ? `${row.id}:${row.revision}` : row.id;
        if (seen.has(String(key))) refuse(`Duplicate row: ${table}:${key}`);
        seen.add(String(key));
        if (table === 'proposals' || table === 'events') {
          const alternate = JSON.stringify([row.principal, row[table === 'events' ? 'event_id' : 'idem']]);
          if (alternateKeys.has(alternate)) refuse(`Duplicate idempotency key: ${table}`);
          alternateKeys.add(alternate);
        }
        if (table === 'revisions') {
          let parsed: unknown;
          try { parsed = JSON.parse(String(row.content)); } catch { refuse(`Invalid knowledge JSON: ${row.id}`); }
          const content = knowledgeSchema.safeParse(parsed);
          if (!content.success || content.data.id !== row.id || content.data.baseRevision + 1 !== row.revision) refuse(`Invalid knowledge revision: ${row.id}`);
        }
        if (table === 'meta' && !portableMeta(String(row.key))) refuse('Unsupported metadata key');
        if (table === 'model_reviews') {
          let result: unknown;
          try { result = JSON.parse(String(row.result)); } catch { refuse('Invalid model review JSON'); }
          if (!result || typeof result !== 'object' || Array.isArray(result)) refuse('Invalid model review result');
          if (!proposalKeys.has(`${row.proposal_id}\u0000${row.project_id}`)) refuse('Orphan model review');
        }
        if (table === 'workflow_drafts') {
          if (!['pending', 'ready_for_review', 'needs_evidence', 'awaiting_model', 'stale', 'approved'].includes(String(row.state))
            || !/^[a-f0-9]{64}$/.test(String(row.source_hash))) refuse('Invalid workflow draft state/source');
          if (revisionKinds.get(String(row.skill_id)) !== 'skill') refuse('Orphan workflow draft');
          if (row.result !== null) {
            let result: Record<string, unknown>;
            try { result = JSON.parse(String(row.result)); } catch { refuse('Invalid workflow draft JSON'); }
            if (!result || typeof result !== 'object' || Array.isArray(result) || result.authority !== 'advisory' || result.executable !== false
              || !['ready_for_review', 'needs_evidence', 'awaiting_model'].includes(String(result.status))
              || !Array.isArray(result.missing) || !Array.isArray(result.grounding) || !Array.isArray(result.references)) refuse('Invalid workflow draft result');
            if (result.digest !== undefined && !digestSchema.safeParse(result.digest).success) refuse('Invalid workflow draft digest');
            if (result.organization !== undefined && (!result.organization || typeof result.organization !== 'object' || Array.isArray(result.organization))) refuse('Invalid workflow organization status');
            const source = result.source as Record<string, unknown> | undefined;
            if (!source || source.skillId !== row.skill_id || source.hash !== row.source_hash || !Number.isSafeInteger(source.revision)) refuse('Invalid workflow draft source binding');
            const original = data.revisions!.find(revision => revision.id === row.skill_id && revision.revision === source.revision);
            if (!original) refuse('Missing workflow draft source revision');
            const skill = knowledgeSchema.parse(JSON.parse(String(original.content)));
            if (skill.kind !== 'skill') refuse('Invalid workflow draft source kind');
            const snapshot = {skillId:String(row.skill_id),skillRevision:Number(source.revision),skill};
            if (workflowSourceHash(snapshot) !== row.source_hash) refuse('Workflow draft source hash mismatch');
            const validated = validateWorkflowDraft(snapshot,{workflow:result.workflow,grounding:result.grounding,missing:result.missing});
            if ((row.state === 'ready_for_review' || row.state === 'approved') && validated.status !== 'ready_for_review') refuse('Ungrounded workflow draft');
            if (JSON.stringify(result.references) !== JSON.stringify(validated.references)) refuse('Workflow draft reference snapshot mismatch');
          } else if (['ready_for_review', 'approved'].includes(String(row.state))) refuse('Workflow draft result is required');
        }
        if (table === 'knowledge' && (!['active', 'retired'].includes(String(row.status)) || Number(row.head) < 1)) refuse('Invalid knowledge head');
        if (table === 'tasks' && !['in_progress', 'paused', 'completed', 'cancelled', 'failed'].includes(String(row.status))) refuse('Invalid task status');
        if (table === 'supersessions' && (!['supersede', 'supplement'].includes(String(row.action)) || !['rescan', 'agent', 'user'].includes(String(row.origin)))) refuse('Invalid supersession');
      }
    }
    if (metaKeys.some(key => !data.meta!.some(row => row.key === key)) || data.meta!.some(r => metaKeys.includes(String(r.key)) && r.key !== 'scanRoots' && (typeof r.value !== 'number' || r.value < 0))) refuse('Invalid or missing required metadata');
    for (const row of data.meta!.filter(row => String(row.key).startsWith('checkpoint:'))) {
      try { const value = JSON.parse(String(row.value)); if (!value || typeof value !== 'object' || Array.isArray(value)) refuse('Invalid checkpoint receipt'); }
      catch { refuse('Invalid checkpoint receipt'); }
    }
    for (const row of data.workflow_search!) if (!data.knowledge!.some(k => k.id === row.id && k.status === 'active' && k.kind !== 'norm')) refuse(`Orphan search row: ${row.id}`);
    for (const head of data.knowledge!) {
      if (!data.revisions!.some(r => r.id === head.id && r.revision === head.head && JSON.parse(String(r.content)).kind === head.kind)) refuse(`Missing head revision: ${head.id}`);
      const local = store.db.prepare('SELECT * FROM knowledge WHERE id=?').get(head.id!) as Row | undefined;
      const divergent = data.revisions!.some(r => {
        if (r.id !== head.id) return false;
        const previous = store.db.prepare('SELECT * FROM revisions WHERE id=? AND revision=?').get(r.id!, r.revision!) as Row | undefined;
        return previous && !equal(previous, r);
      });
      if (local && (Number(local.head) > Number(head.head) || local.kind !== head.kind || divergent || (local.head === head.head && !equal(local, head)))) {
        blocked.add(String(head.id)); conflict(String(head.id), 'Local knowledge is newer or divergent');
      }
    }
    for (const revision of data.revisions!) if (!data.knowledge!.some(k => k.id === revision.id && Number(k.head) >= Number(revision.revision))) refuse(`Orphan revision: ${revision.id}`);
    for (const table of importedTables) for (const row of data[table]!) {
      if ((['knowledge', 'revisions', 'workflow_search'].includes(table) && blocked.has(String(row.id))) || (table === 'adoptions' && blocked.has(String(row.knowledge_id))) || (table === 'supersessions' && (blocked.has(String(row.old_knowledge_id)) || blocked.has(String(row.new_knowledge_id))))) { skipped++; continue; }
      const localRows = hasTable(store, table) ? rows(store, table) : [];
      if (localRows.some(local => table === 'supersessions' ? equal({ ...local, id: null }, { ...row, id: null }) : equal(local, row))) { skipped++; continue; }
      if (table === 'meta') {
        const local = localRows.find(r => r.key === row.key);
        if (String(row.key).startsWith('checkpoint:') && local) {
          conflict(`meta:${row.key}`, 'Local checkpoint receipt differs'); skipped++; continue;
        }
        if (row.key === 'revision') {
          const next = Math.max(Number(local?.value ?? 0), Number(row.value));
          if (next === local?.value) { skipped++; continue; }
          row.value = next;
        } else if (metaKeys.includes(String(row.key)) && Number(localRows.find(r => r.key === 'revision')?.value ?? 0) !== 0) {
          conflict(`meta:${row.key}`, 'Local settings preserved'); skipped++; continue;
        }
        operations.push(() => { store.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(row.key!, row.value!); });
        continue;
      }
      const sameKey = localRows.find(local => table === 'model_reviews' ? local.proposal_id === row.proposal_id : table === 'revisions' ? local.id === row.id && local.revision === row.revision : local.id === row.id);
      const alternateKey = ['events', 'proposals'].includes(table) && localRows.some(local => local.principal === row.principal && local[table === 'events' ? 'event_id' : 'idem'] === row[table === 'events' ? 'event_id' : 'idem']);
      if ((sameKey && !['knowledge', 'workflow_search', 'supersessions'].includes(table)) || alternateKey) { conflict(`${table}:${row.id}`, 'Local ledger row differs'); skipped++; continue; }
      const columns = Object.keys(row).filter(c => !(table === 'supersessions' && sameKey && c === 'id'));
      operations.push(() => {
        if (table === 'model_reviews') store.db.exec('CREATE TABLE IF NOT EXISTS model_reviews(proposal_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, result TEXT NOT NULL, updated_at INTEGER NOT NULL)');
        if (table === 'workflow_drafts') store.db.exec('CREATE TABLE IF NOT EXISTS workflow_drafts(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,skill_id TEXT NOT NULL,source_hash TEXT NOT NULL,state TEXT NOT NULL,result TEXT,updated_at INTEGER NOT NULL)');
        if (table === 'knowledge' && sameKey) {
          store.db.prepare('UPDATE knowledge SET head=?,status=? WHERE id=?').run(row.head!, row.status!, row.id!);
          return;
        }
        if (sameKey && table === 'workflow_search') store.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(row.id!);
        store.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(c => row[c]!));
      });
      if (table === 'knowledge') imported++;
    }
    if (conflicts.length && options.onConflict === 'fail') throw new DomainError('backup_conflict', `Backup conflicts: ${conflicts.map(c => c.id).join(', ')}`, 409);
    if (!options.dryRun) for (const operation of operations) operation();
    return { imported, skipped, conflicts, wrote: !options.dryRun && operations.length > 0 };
  };
  if (options.dryRun) return apply();
  store.db.exec('BEGIN IMMEDIATE');
  const result = (() => {
    try { const applied = apply(); store.db.exec('COMMIT'); return applied; }
    catch (error) { store.db.exec('ROLLBACK'); if (error instanceof DomainError) throw error; throw new DomainError('invalid_backup', `Backup import failed: ${(error as Error).message}`); }
  })();
  // The design (§8) requires the expiry check to run on restore, so a lapsed page
  // cannot be brought back to life by importing an old archive. It runs after the
  // rows have landed — checking before would inspect a database that does not yet
  // hold the material it is judging — and after that transaction commits, because
  // the purge opens its own transaction and SQLite will not nest one inside another.
  store.purgeExpiredMaterial();
  return result;
}
