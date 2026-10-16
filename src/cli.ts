#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { tmpdir } from 'node:os';
import { Store } from './store.js';
import { seedSchema, workflowSchema, type Knowledge } from './schema.js';
import { coreSchema, clientSchema, defaultDataDir } from './config.js';
import { spawn, spawnSync } from 'node:child_process';
import { createCoreServer } from './server.js';
import { defaultScanRoots, diff, discover, rescanDiff, summarize, summarizeRescan } from './discovery.js';
// candidateToKnowledge lives with the rescan policy so the CLI and the running
// core convert discovered text identically; two copies would drift.
import { applyRescan, candidateToKnowledge as toKnowledge } from './rescan.js';
import { doctor, summarizeDoctor } from './doctor.js';
import { Logger, LOG_LEVEL_ORDER, type LogLevel } from './log.js';
import {
  acquireLock, inspectLock, loginStartupStatus, probeHealth, recoverStale,
  registerLoginStartup, releaseLock, startDetached, stopFromLock, unregisterLoginStartup,
} from './service.js';
import { exportSkills } from './export-skills.js';
import { defaultArchiveName, exportArchive, importArchive, inspectArchive } from './archive.js';
import { createMaintenanceWorker } from './maintenance.js';

/**
 * Command help.
 *
 * Kept as one place so the text cannot drift from the option list. `--help` and
 * `-h` are handled before parseArgs, because parseArgs throws on an option it
 * does not know and a stack trace is a poor answer to a help request.
 */
const USAGE = [
  'Commands:',
  '  discover [--roots PATH,...]              scan for existing knowledge (read-only)',
  '  adopt [--yes | --revoke TIMESTAMP]       adopt discovered knowledge, or undo a batch',
  '  rescan [--roots PATH,...] [--yes]        compare sources against the ledger',
  '  supersede --old ID --new ID --reason TEXT --evidence TEXT [--action supersede|supplement]',
  '  history --id ID                          revision lineage of one entry',
  '  structure --skill ID --input FILE --evidence TEXT [--derived-by user|agent]',
  '  unstructured                             skills awaiting structure',
  '  backup --file FILE [--yes] [--overwrite]  pack all data into one portable .ambpack file',
  '  restore --file FILE [--yes] [--json]     inspect, then merge an .ambpack archive',
  '  export --dir DIR [--yes] [--kinds a,b]   write plain SKILL.md files',
  '  ui [--open]                              print the core-served management UI address',
  '  service [status|start|stop|recover|enable-startup|disable-startup]',
  '                                           resident core: single instance, health, login startup',
  '  doctor [--offline] [--json]              self-check; never prints credentials',
  '  logs [--source plugin] [--all-sources] [--level LVL] [--event NAME] [--json]',
  '  init [--project ID] [--port N] [--project-root PATH]',
  '  serve [--roots PATH,...] [--rescan-interval MS]',
  '  seed --input FILE | retire --id ID --revision N | status',
  '',
  'Global: --data-dir DIR (default: ~/.agent-memory-backpack)',
].join('\n');

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

// `parseArgs` infers a precise shape from the option table; keep it rather than
// widening to a loose record, so a misspelled `values.x` stays a compile error.
const parsed = (() => {
  try {
    return parseArgs({ allowPositionals: true, options: {
      'data-dir': { type: 'string' }, project: { type: 'string', default: 'p0-workflow' },
      'project-root': { type: 'string' },
      port: { type: 'string', default: '47631' }, input: { type: 'string' },
      id: { type: 'string' }, revision: { type: 'string' }, roots: { type: 'string' },
      yes: { type: 'boolean', default: false }, revoke: { type: 'string' },
      old: { type: 'string' }, 'new': { type: 'string' }, action: { type: 'string' },
      reason: { type: 'string' }, evidence: { type: 'string' }, 'rescan-interval': { type: 'string' },
      skill: { type: 'string' }, 'derived-by': { type: 'string' },
      offline: { type: 'boolean', default: false }, json: { type: 'boolean', default: false },
      limit: { type: 'string' }, level: { type: 'string' }, event: { type: 'string' },
      all: { type: 'boolean', default: false }, 'dsh-runtime-version': { type: 'string' },
      dir: { type: 'string' }, kinds: { type: 'string' },
      file: { type: 'string' }, overwrite: { type: 'boolean', default: false },
      open: { type: 'boolean', default: false },
      source: { type: 'string' }, 'all-sources': { type: 'boolean', default: false },
      'admin-dir': { type: 'string' },
    } } as const);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Invalid arguments: ${message}\n\n${USAGE}`);
    process.exit(1);
  }
})();
const { values, positionals } = parsed;
const command = positionals[0]; const dir = resolve(values['data-dir'] ?? defaultDataDir());
/** Repository root, derived from this file's own location rather than the cwd. */
/**
 * Repository root, derived from where this file actually is.
 *
 * Source runs from `src/` and the build runs from `dist/src/`, so one level up is
 * the repository in the first case and the build directory in the second. Probing
 * for the package manifest is what keeps this correct in both layouts; assuming
 * one produced `dist/dist/src/cli.js` and a "run npm run build" error on a tree
 * that was already built.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = existsSync(join(here, '..', 'package.json')) ? resolve(here, '..') : resolve(here, '..', '..');
/**
 * Candidate core entries, most trustworthy first.
 *
 * The entry used to be assembled from `root` on the assumption that a build
 * keeps `dist/src/cli.js`. It does not: `scripts/package.mjs` copies `dist/src`
 * to `core/runtime`, so inside an installed artifact the only real entry is
 * `runtime/cli.js` beside this file. `enable-startup` therefore wrote a logon
 * command naming a file that does not exist, and the failure surfaced only at
 * the next logon — silently, with nothing in any log to connect it to the
 * command that created it.
 *
 * The file this process was actually started with is the one fact that cannot
 * drift from the deployed layout, so it leads. The known layouts follow, and
 * `AMB_CORE_ENTRY` lets an operator that wraps the CLI name the entry — checked
 * for existence like every other candidate rather than trusted.
 */
function coreEntryCandidates(): Array<{ path: string; source: string }> {
  const override = (process.env.AMB_CORE_ENTRY ?? '').trim();
  // An explicitly named entry is a requirement, not a hint: falling back to an
  // auto-detected file would install logon startup for a different script than
  // the one the operator named, which is the same "nothing starts and no log
  // says why" failure in a new shape.
  if (override) return [{ path: resolve(override), source: 'AMB_CORE_ENTRY' }];
  const invoked = (process.argv[1] ?? '').trim();
  return [
    ...(/\.(?:js|cjs|mjs)$/i.test(invoked) ? [{ path: resolve(invoked), source: '运行本进程时使用的入口' }] : []),
    { path: join(root, 'runtime', 'cli.js'), source: '打包时间入口（core/runtime/cli.js）' },
    { path: join(root, 'dist', 'src', 'cli.js'), source: '仓库构建入口（dist/src/cli.js）' },
  ];
}
/** The first candidate that exists, plus every candidate for a failure message. */
function resolveCoreEntry(): { entry?: { path: string; source: string }; candidates: Array<{ path: string; source: string }> } {
  const candidates = coreEntryCandidates();
  return { entry: candidates.find(candidate => existsSync(candidate.path)), candidates };
}
/** What to tell a caller for whom no entry could be resolved, or none was named. */
function coreEntryHint(candidates: Array<{ path: string; source: string }>): string {
  return '未找到核心入口。已检查：'
    + candidates.map(candidate => `${candidate.path}（${candidate.source}）`).join('、')
    + '。先运行 npm run build，或用 AMB_CORE_ENTRY 指向真实的 cli.js。';
}
/**
 * Bounded outbound ACL entries, by SID so the answer does not depend on the
 * display language.
 *
 * The core's own SIDs rather than the `Administrators`/`SYSTEM` names, because
 * the same check must hold on a Chinese Windows where those names are localised.
 * The granted set is left deliberately wider than one account: a machine being
 * maintained by an administrator must not lock them out of the credentials they
 * are responsible for.
 */
const BROAD_ACL_ENTRIES = ['AC', 'WD', 'AU', 'BU', 'IU', 'SU'];
const SDDL_ACE_PATTERN = /\(([^)]*)\)/g;

/** ACEs in an SDDL string, each as its field array, so flags can be inspected. */
function sddlAces(sddl: string): string[][] {
  return [...sddl.matchAll(SDDL_ACE_PATTERN)].map(match => match[1]!.split(';'));
}

/**
 * An equivalence class for "the same SID got the same rights".
 *
 * Access masks are written in their symbolic form, so the comparison normalises
 * only whitespace and case and must not be taught to understand every flag. What
 * matters here is whether *anything* a bounded entry allows is also allowed to a
 * broad SID; a mask it cannot parse compares unequal and is reported rather than
 * silently treated as safe.
 */
function aceKey(ace: string[]): { sid: string; rights: string } {
  return { sid: (ace[5] ?? '').toUpperCase(), rights: (ace[2] ?? '').replace(/\s+/g, '').toUpperCase() };
}

/**
 * Read a file's ACL as SDDL, through `icacls /save`.
 *
 * Chosen over parsing `icacls <path>` output because that output is localised:
 * on a Chinese Windows the success line and even the SID names are bytes this
 * process cannot match against an English pattern — a trap this project has
 * already been bitten by once, in `service.ts`'s startup query. `/save` writes
 * SDDL (`D:PAI(A;;FA;;;SY)...`), which is ASCII and language-independent, and
 * the file is read back as UTF-16LE, which is the encoding the tool writes.
 *
 * Returns the raw SDDL, or a reason it could not be read. Never throws: a
 * verification step must not be able to abort the credential write it follows.
 */
function readAclSddl(target: string): { sddl?: string; error?: string } {
  const dir = mkdtempSync(join(tmpdir(), 'amb-acl-'));
  try {
    // `/save` requires a *file* path, and writes only the ACEs it was given a
    // file for. Handing it the directory — the obvious-looking call — returns
    // exit 87 ("Successfully processed 0 files") without writing anything, which
    // is how this verification silently failed for every credential.
    const aclFile = join(dir, 'acl.txt');
    const result = spawnSync('icacls', [target, '/save', aclFile], { encoding: 'utf8', windowsHide: true });
    if (result.error) return { error: result.error.message };
    if (result.status !== 0) return { error: `icacls /save 退出 ${result.status}` };
    if (!existsSync(aclFile)) return { error: 'icacls /save 未写出 ACL 文件' };
    // UTF-16LE (with BOM): reading it as latin1 shows `c r e d . j s o n`, which
    // is why the encoding is decoded explicitly rather than assumed.
    const text = new TextDecoder('utf-16le').decode(readFileSync(aclFile));
    // Line 1 is the saved file's name, line 2 the SDDL.
    const sddl = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)[1];
    return sddl ? { sddl } : { error: 'ACL 文件不含 SDDL 行' };
  } catch (error) {
    return { error: error instanceof Error ? error.message : '读取 ACL 失败' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Whether the credential file still hands any rights to classes wider than the user.
 *
 * `Authenticated Users`, `Users` and friends are the finding: a credential file
 * under a directory that grants them inherits them, so any other account on the
 * machine can read the token. The comparison is per (SID, rights) against the
 * bounded entries this code just granted, so a *removed* broad discretionary ACE
 * is required for the check to pass — merely having added the owner is not
 * enough, which is what makes this a check rather than a formality.
 */
function broadAclEntries(sddl: string): string[] {
  const bounded = new Set(sddlAces(sddl)
    .filter(ace => (ace[5] ?? '').toUpperCase() === currentUserSid() || ace[5]!.toUpperCase() === 'S-1-5-18')
    .map(ace => `${aceKey(ace).sid}:${aceKey(ace).rights}`));
  return sddlAces(sddl)
    .filter(ace => BROAD_ACL_ENTRIES.includes((ace[5] ?? '').toUpperCase()))
    .filter(ace => !bounded.has(`${aceKey(ace).sid}:${aceKey(ace).rights}`))
    .map(ace => `${ace[5]}:${ace[2]}`);
}

/** The current user's SID, or '' when it cannot be determined. */
function currentUserSid(): string {
  // `whoami /user` prints the SID beside the account name; the SID itself is the
  // only token that is machine-readable on every locale.
  const result = spawnSync('whoami', ['/user'], { encoding: 'utf8', windowsHide: true });
  return /S-\d+(?:-\d+)+/.exec(result.stdout ?? '')?.[0] ?? '';
}

/**
 * Restrict a credential file to the accounts that need it.
 *
 * Windows does not enforce a POSIX mode, so `writeFileSync(..., { mode: 0o600 })`
 * does nothing there and the file simply inherits the directory's ACL. Under a
 * data directory inside the user's profile that inheritance happens to be
 * acceptable; under a directory that grants `Authenticated Users:(M)` and
 * `Users:(RX)` — any drive root, or an explicitly chosen `--data-dir` — the
 * credential was readable by every account on the machine.
 *
 * Two steps, and the order is what makes it a fix rather than a hope: remove
 * inherited entries and grant only this user (plus the two system accounts), then
 * *read the ACL back* and report whether any broad entry survived. A silent
 * failure here is the worst outcome, because the file looks written and is
 * readable; so the caller is given the finding and the CLI exits non-zero on it.
 */
function restrictCredentialAcl(target: string): { ok: boolean; detail: string } {
  if (process.platform !== 'win32') {
    // POSIX: the mode passed at creation is what applies, and it was already set
    // to owner-only. Nothing to read back through this mechanism.
    return { ok: true, detail: '非 Windows：凭据以 0600 创建，由文件模式约束。' };
  }
  const userSid = currentUserSid();
  if (!userSid) return { ok: false, detail: `无法确定当前用户 SID，未收紧 ${target} 的 ACL。` };
  const grants = [
    `*${userSid}:(F)`,   // the owner who reads the credential
    '*S-1-5-18:(F)',     // SYSTEM, whose access the design's baseline keeps
    '*S-1-5-32-544:(F)', // Administrators, so a machine can still be maintained
  ];
  const applied = spawnSync('icacls', [target, '/inheritance:r', ...grants.flatMap(grant => ['/grant:r', grant])],
    { encoding: 'utf8', windowsHide: true });
  if (applied.error) return { ok: false, detail: `icacls 无法执行：${applied.error.message}` };
  if (applied.status !== 0) return { ok: false, detail: `icacls 收紧失败（退出 ${applied.status}）` };
  const acl = readAclSddl(target);
  if (acl.error) return { ok: false, detail: `已执行收紧，但无法复核 ACL：${acl.error}` };
  const broad = broadAclEntries(acl.sddl!);
  return broad.length
    ? { ok: false, detail: `已执行收紧，但 ACL 仍含宽权限条目：${broad.join(', ')}` }
    : { ok: true, detail: `凭据 ACL 已收紧为仅当前用户（+SYSTEM/Administrators），继承已移除。` };
}
try {
  if (command === 'discover') {
    // Install-time adoption: scan user agents for existing knowledge. Read-only by
    // default; --roots restricts the scan. Nothing is promoted here.
    const roots = values.roots ? String(values.roots).split(',').map(root => root.trim()).filter(Boolean) : defaultScanRoots();
    const report = discover(roots);
    const corePath = join(dir, 'core.json');
    let compared: ReturnType<typeof diff> | undefined;
    if (existsSync(corePath)) {
      const store = new Store(join(dir, 'knowledge.sqlite'));
      try {
        compared = diff(report.candidates, store.allEntries().map(entry => ({ id: entry.id, title: entry.content.title })));
      } finally { store.close(); }
    }
    console.log(JSON.stringify({
      summary: summarize(report),
      scannedRoots: report.scannedRoots,
      candidates: (compared ?? report.candidates.map(candidate => ({ ...candidate, change: 'new' as const }))).map(candidate => ({
        id: candidate.id, kind: candidate.kind, title: candidate.title,
        change: candidate.change, source: candidate.source, rationale: candidate.rationale,
        leafCount: candidate.leaves?.length ?? 0,
        // Leaf bodies are included so the user can review what travels with a
        // skill; console flooding is avoided by listing paths and sizes only.
        leaves: (candidate.leaves ?? []).map(leaf => ({ path: leaf.path, hash: leaf.hash, bytes: leaf.bytes })),
      })),
      excluded: report.excluded,
      wrote: report.wrote,
      note: 'Discovery is read-only. Nothing was written to the knowledge base or to any host file.',
    }, null, 2));
  } else if (command === 'adopt') {
    // Promotion is explicit and reversible. Without --yes this only reports what
    // would change; it never writes, and it never touches a host file.
    if (!existsSync(join(dir, 'core.json'))) throw new Error('Core is not initialized for this data dir; run init first.');
    const store = new Store(join(dir, 'knowledge.sqlite'));
    try {
      if (values.revoke !== undefined) {
        if (!Number.isFinite(Number(values.revoke))) throw new Error('--revoke requires the numeric batch timestamp printed by adopt');
        const result = store.revokeAdoption(Number(values.revoke));
        console.log(JSON.stringify({
          revoked: result.retired, skipped: result.skipped,
          note: 'Only entries created by that adoption batch were retired. Host files were never touched.'
            + (result.skipped.length ? ' Entries edited since adoption were preserved, not discarded.' : ''),
        }, null, 2));
      } else {
        const roots = values.roots ? String(values.roots).split(',').map(root => root.trim()).filter(Boolean) : defaultScanRoots();
        const report = discover(roots);
        const compared = diff(report.candidates, store.allEntries().map(entry => ({ id: entry.id, title: entry.content.title })));
        const pending = compared.filter(candidate => candidate.change === 'new');
        if (values.yes !== true) {
          // Distinguish a first import from a restore. After a revoke the entry
          // still exists (retired, history preserved), so the same source is
          // adoptable again — but reporting it as plain "would adopt" hides that
          // the entry is being brought back rather than created.
          const retiredIds = store.retiredIds();
          const restored = pending.filter(candidate => retiredIds.has(candidate.id));
          console.log(JSON.stringify({
            dryRun: true,
            summary: summarize(report),
            wouldAdopt: pending.length,
            restored: restored.map(candidate => ({ id: candidate.id, title: candidate.title })),
            skipped: compared.filter(candidate => candidate.change !== 'new')
              .map(candidate => ({ id: candidate.id, change: candidate.change, title: candidate.title })),
            note: 'Dry run: nothing was written. Re-run with --yes to adopt. Conflicts are never auto-resolved.'
              + (restored.length ? ` ${restored.length} entr(y/ies) were previously revoked and will be restored, not created.` : ''),
          }, null, 2));
        } else if (pending.length === 0) {
          console.log(JSON.stringify({ adopted: 0, note: 'Nothing new to adopt.' }, null, 2));
        } else {
          const batch = pending.map(candidate => ({
            source: { path: candidate.source.path, hash: candidate.source.hash },
            kind: candidate.kind,
            title: candidate.title,
            knowledge: toKnowledge(candidate),
          }));
          const result = store.adopt(batch);
          console.log(JSON.stringify({
            adopted: result.count, adoptedAt: result.adoptedAt, knowledgeRevision: result.knowledgeRevision,
            // Duplicates are reported rather than silently dropped, so a count of
            // zero is explainable instead of looking like nothing happened.
            skipped: result.skipped,
            revokeWith: result.count > 0 ? `adopt --revoke ${result.adoptedAt}` : undefined,
            note: result.count > 0
              ? 'Adopted into the knowledge base. Source files were not modified; revoke with the shown command.'
              : 'Nothing new to adopt; every candidate was already active or otherwise skipped.',
          }, null, 2));
        }
      }
    } finally { store.close(); }
  } else if (command === 'rescan') {
    // Periodic re-scan: compare sources against the adoption ledger. Reporting is
    // read-only; --yes applies "latest record wins" to changed sources, which
    // creates a new revision and records the supersession rather than deleting
    // anything. Vanished sources are reported, never auto-retired: a path may be
    // temporarily missing and retiring the user's knowledge on that basis would
    // be destructive.
    if (!existsSync(join(dir, 'core.json'))) throw new Error('Core is not initialized for this data dir; run init first.');
    const store = new Store(join(dir, 'knowledge.sqlite'));
    try {
      const roots = values.roots ? String(values.roots).split(',').map(root => root.trim()).filter(Boolean) : defaultScanRoots();
      const report = rescanDiff(discover(roots), store.adoptions());

      if (values.yes !== true) {
        console.log(JSON.stringify({
          dryRun: true,
          summary: summarizeRescan(report),
          counts: report.counts,
          changed: report.entries.filter(e => e.status === 'changed')
            .map(e => ({ source: e.source.path, knowledgeId: e.knowledgeId, title: e.title })),
          newEntries: report.entries.filter(e => e.status === 'new')
            .map(e => ({ source: e.source.path, title: e.title, kind: e.kind })),
          vanished: report.vanished,
          note: 'Dry run: nothing was written. Re-run with --yes to refresh changed sources (latest record wins).',
        }, null, 2));
      } else {
        const outcome = applyRescan(store, roots);
        const { report } = outcome;
        console.log(JSON.stringify({
          summary: outcome.summary, counts: report.counts,
          refreshed: outcome.refreshed, adopted: outcome.adopted,
          vanished: report.vanished, errors: outcome.errors,
          lastRescanAt: store.rescanState().lastRescanAt,
          intervalMs: store.rescanState().intervalMs,
          note: 'Changed sources were refreshed with the newest record. Earlier revisions were kept in history.'
            + (outcome.refreshed.some(r => r.replacedLocalEdit) ? ' WARNING: at least one refresh overwrote a local edit; both are retained in history.' : '')
            + (report.vanished.length ? ' Vanished sources were reported but not retired.' : ''),
        }, null, 2));
      }
    } finally { store.close(); }
  } else if (command === 'supersede') {
    // Working-time correction: after verifying in practice, replace or complement
    // an earlier experience. The earlier revision is always retained, so an
    // overturn is auditable rather than a silent overwrite.
    if (!values.old || !values.new) throw new Error('--old ID and --new ID are required');
    if (!values.reason) throw new Error('--reason is required: a supersession must state why');
    if (!values.evidence) throw new Error('--evidence is required: cite what verified the change');
    const action = values.action ?? 'supersede';
    if (action !== 'supersede' && action !== 'supplement') throw new Error('--action must be supersede or supplement');
    const store = new Store(join(dir, 'knowledge.sqlite'));
    try {
      const result = store.supersede({
        oldId: String(values.old), newId: String(values.new), action,
        reason: String(values.reason), evidence: String(values.evidence), origin: 'agent',
      });
      console.log(JSON.stringify({
        action, ...result,
        note: action === 'supersede'
          ? 'Earlier revision retired but retained in history; the new record is now current.'
          : 'Both records remain active; the new one supplements rather than replaces.',
      }, null, 2));
    } finally { store.close(); }
  } else if (command === 'history') {
    // Lineage view: which revisions exist and what replaced or supplemented what.
    if (!values.id) throw new Error('--id ID is required');
    const store = new Store(join(dir, 'knowledge.sqlite'));
    try { console.log(JSON.stringify(store.history(String(values.id)), null, 2)); }
    finally { store.close(); }
  } else if (command === 'unstructured') {
    // Adopted skills still awaiting structure, so a user can see what is pending.
    const store = new Store(join(dir, 'knowledge.sqlite'));
    try {
      const skills = store.unstructuredSkills();
      console.log(JSON.stringify({
        count: skills.length, skills,
        note: 'These adopted skills hold their original text and are not presented as verified procedures until structured.',
      }, null, 2));
    } finally { store.close(); }
  } else if (command === 'structure') {
    // Convert one adopted skill into a real workflow.
    //
    // The structure is supplied by the caller, never inferred from the Markdown:
    // ordered steps and completion criteria cannot be reliably read out of prose,
    // so inventing them would dress a fabrication up as a verified method.
    if (!values.skill) throw new Error('--skill ID is required (the adopted skill to structure)');
    if (!values.input) throw new Error('--input FILE is required (the authored workflow structure as JSON)');
    if (!values.evidence) throw new Error('--evidence TEXT is required: cite what the structure is based on');
    const derivedBy = values['derived-by'] ?? 'user';
    if (derivedBy !== 'user' && derivedBy !== 'agent') throw new Error('--derived-by must be user or agent');
    const store = new Store(join(dir, 'knowledge.sqlite'));
    try {
      const workflow = workflowSchema.parse(JSON.parse(readFileSync(resolve(values.input), 'utf8')));
      const result = store.structureSkill({
        skillId: String(values.skill), workflow, derivedBy, evidence: String(values.evidence),
      });
      console.log(JSON.stringify({
        ...result,
        note: 'The authored workflow is now active and the raw skill was retired in the same transaction.'
          + ' The skill text is retained in history and the conversion is recorded in the supersession ledger.',
      }, null, 2));
    } finally { store.close(); }
  } else if (command === 'service') {
    // Resident-core management: status, start, stop, recover, and login startup.
    //
    // The design asks for a user-level core that manages its own startup, is
    // single-instance, and can be checked and recovered. This is that control
    // surface. It is deliberately not a Windows service: a service runs as another
    // account with its own data directory, which would put the user's knowledge
    // somewhere they cannot see, and the design says user-level.
    const action = positionals[1] ?? 'status';
    // Resolved before the action switch so `status` can report the same entry the
    // other actions would use, instead of the caller having to guess the layout.
    const { entry: coreEntry, candidates: coreEntryOptions } = resolveCoreEntry();
    const endpoint = (() => {
      const corePath = join(dir, 'core.json');
      if (!existsSync(corePath)) return null;
      try { return `http://127.0.0.1:${(JSON.parse(readFileSync(corePath, 'utf8')) as { port: number }).port}`; }
      catch { return null; }
    })();

    if (action === 'status') {
      const lock = inspectLock(dir);
      const health = endpoint ? await probeHealth(endpoint) : { healthy: false, detail: '未找到 core.json，无法确定端口' };
      const startup = loginStartupStatus();
      const payload = {
        lock: lock.state === 'absent' ? { state: 'absent' }
          : lock.state === 'unreadable' ? { state: 'unreadable', detail: lock.detail }
          : { state: lock.state, pid: lock.info.pid, port: lock.info.port, startedAt: lock.info.startedAt },
        healthy: health.healthy, healthDetail: health.detail,
        // Reported because "which file would logon run" is the question the
        // silent-startup defect left unanswered; the diagnosis should not need a
        // second command.
        coreEntry: coreEntry ? { path: coreEntry.path, source: coreEntry.source } : null,
        loginStartup: startup.registered, loginStartupDetail: startup.detail,
        note: '锁表示"谁在运行"；健康探测表示"核心是否在回应"。两者分开报告，因为一个陈旧的锁和一个挂掉的核心是不同的问题。',
      };
      // Prose by default. `status` is the first command a user runs, and the answer it owes
      // is "is it running right now" - a wall of JSON is not that answer. The other commands
      // already follow this convention (doctor, logs, restore); this one had missed it.
      // `--json` still returns the raw shape for scripts.
      if (values.json === true) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        const l = payload.lock;
        const lockLine = l.state === 'absent' ? '未在运行（没有锁文件）'
          : l.state === 'unreadable' ? '锁不可读：' + l.detail
          : `运行中（pid ${l.pid}，端口 ${l.port}，启动于 ${l.startedAt}）`;
        console.log('Agent Memory Backpack 状态');
        console.log('  运行      ' + lockLine);
        console.log('  核心响应  ' + (payload.healthy ? '有响应' : '无响应')
          + (payload.healthDetail ? ' — ' + payload.healthDetail : ''));
        console.log('  开机启动  ' + (payload.loginStartup ? '已登记' : '未登记')
          + (payload.loginStartupDetail ? ' — ' + payload.loginStartupDetail : ''));
        if (payload.coreEntry) {
          console.log('  核心入口  ' + payload.coreEntry.path + '（来源：' + payload.coreEntry.source + '）');
        }
        console.log('');
        console.log('  ' + payload.note);
      }
    } else if (action === 'start') {
      if (!coreEntry) throw new Error(coreEntryHint(coreEntryOptions));
      const lock = inspectLock(dir);
      if (lock.state === 'held') {
        console.log(JSON.stringify({ started: false, reason: 'already-running', pid: lock.info.pid, note: '已有核心在运行，未启动第二个。' }, null, 2));
      } else {
        if (lock.state === 'stale') console.log(`（清理了上一次异常退出留下的锁，pid ${lock.info.pid}。）`);
        const logFile = join(dir, 'core-service.log');
        const { pid } = startDetached(coreEntry.path, dir, logFile);
        console.log(JSON.stringify({ started: true, pid, log: logFile, entry: coreEntry.path, note: '核心已脱离本终端运行，关闭本窗口不会停止它。' }, null, 2));
      }
    } else if (action === 'stop') {
      const result = stopFromLock(dir);
      console.log(JSON.stringify({
        ...result,
        note: result.stopped
          ? '已请求停止该进程；锁会由它自己在关闭后释放。'
          : '没有停止任何进程。',
      }, null, 2));
    } else if (action === 'recover') {
      const result = recoverStale(dir);
      console.log(JSON.stringify({
        ...result,
        note: result.recovered
          ? '已清理陈旧锁；下一次启动不会再被它挡住。'
          : '没有发现陈旧锁，无需恢复。',
      }, null, 2));
    } else if (action === 'enable-startup' || action === 'disable-startup') {
      // The entry is validated *before* the registry write, and a missing one is a
      // hard failure rather than a value pointing nowhere. Writing a logon command
      // for a file that does not exist is the defect this guards: the entry looks
      // installed, nothing starts at the next logon, and no log connects the two.
      if (action === 'enable-startup' && !coreEntry) throw new Error(coreEntryHint(coreEntryOptions));
      const result = action === 'enable-startup'
        ? registerLoginStartup(coreEntry!.path, dir)
        : unregisterLoginStartup();
      console.log(JSON.stringify({ action, ...result }, null, 2));
      if (!result.ok) process.exitCode = 1;
    } else {
      throw new Error(`未知的 service 动作：${action}。可用：status、start、stop、recover、enable-startup、disable-startup。`);
    }
  } else if (command === 'ui') {
    // Print the address of the core-served management interface.
    //
    // The interface is a page the core serves, not a separate application: the
    // design asked for a local web page rather than a desktop shell, and a page
    // needs no extra runtime and no window to keep alive. It is reachable
    // whenever the core is, including from a browser surface inside the host.
    //
    // The credential goes in the URL fragment, which browsers do not transmit, so
    // it stays out of the server's request log. Only the address is printed here;
    // the token is in it, and the warning says so rather than pretending.
    const configPath = join(dir, 'admin-client.json');
    if (!existsSync(configPath)) throw new Error(`未找到管理凭据：${configPath}。先运行 init 或安装脚本。`);
    const admin = clientSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')));
    const base = admin.endpoint.replace(/\/$/, '');
    const url = `${base}/ui#${encodeURIComponent(admin.token)}`;
    console.log(url);
    console.log('');
    console.log('说明：');
    console.log(`  · 该地址含管理凭据（URL 片段，不会发送到服务端，也不进请求日志），请勿外发或贴到聊天里。`);
    console.log(`  · 界面由核心自己提供，核心在跑就能访问，不需要额外安装任何桌面程序。`);
    console.log(`  · 核心没在跑时先用插件或 serve 启动它。`);
    if (values.open === true) {
      // Best effort: a browser may not be installed on a server, and failing to
      // open one must not look like failing to produce the address.
      const opener = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
      try { spawn(opener, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); }
      catch { console.error('（未能自动打开浏览器，请手动访问上面的地址。）'); }
    }
  } else if (command === 'doctor') {
    // Self-check: answer "why is this not working" without a reproduction.
    // Never prints a credential and never throws on a failing check.
    const clientPath = values.input ? resolve(String(values.input)) : join(dir, 'client.json');
    const report = await doctor({
      dataDir: dir,
      clientPath,
      offline: values.offline === true,
      runtimeVersions: values['dsh-runtime-version']
        ? { '@deepseek-ai/dsh-tools': String(values['dsh-runtime-version']) }
        : undefined,
    });
    if (values.json === true) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Agent Memory Backpack 自检：${summarizeDoctor(report)}`);
      console.log(`数据目录 ${dir}`);
      console.log(`版本 ${Object.entries(report.versions).map(([k, v]) => `${k}=${v}`).join('  ')}`);
      console.log('');
      for (const check of report.checks) {
        const tag = { pass: '通过', warn: '留意', fail: '失败', skip: '跳过' }[check.status];
        console.log(`[${tag}] ${check.title} — ${check.detail}`);
        if (check.hint) console.log(`        建议：${check.hint}`);
      }
      console.log('');
      console.log(report.ok ? '自检未发现阻塞问题。' : '自检发现问题，请按上面的建议处理。');
    }
    if (!report.ok) process.exitCode = 1;
  } else if (command === 'logs') {
    // Run log reader: the record that makes a past failure diagnosable.
    //
    // Two logs exist by design: the core's (written while `serve` runs) and the
    // adapter's (written inside the host process, so it survives the core being
    // unreachable). --source picks one, or --all-sources merges both.
    const wantCore = values.source !== 'plugin';
    const wantPlugin = values.source === 'plugin' || values['all-sources'] === true;
    const collected: Array<Record<string, unknown>> = [];

    if (wantCore) collected.push(...new Logger(dir).read({ includeRotated: values.all === true }) as unknown as Array<Record<string, unknown>>);
    if (wantPlugin) {
      const pluginLog = join(dir, 'amb-plugin.log.jsonl');
      if (!existsSync(pluginLog)) {
        console.error(`插件日志尚不存在：${pluginLog}（插件在宿主中加载后生成）`);
        if (values.source === 'plugin') process.exitCode = 1;
      } else {
        for (const line of readFileSync(pluginLog, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try { collected.push(JSON.parse(line) as Record<string, unknown>); } catch { /* skip a torn line */ }
        }
      }
    }

    const floor = values.level ? LOG_LEVEL_ORDER[values.level as LogLevel] : undefined;
    let records = collected
      .filter(record => floor === undefined || LOG_LEVEL_ORDER[record.level as LogLevel] >= floor)
      .filter(record => !values.event || String(record.event).includes(String(values.event)))
      .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    if (values.limit) records = records.slice(-Number(values.limit));

    if (values.json === true) console.log(JSON.stringify(records, null, 2));
    else if (records.length === 0) console.log(`暂无日志记录（${dir}）`);
    else for (const record of records) {
      const { ts, level, event, ...rest } = record;
      const fields = Object.keys(rest).length ? ' ' + JSON.stringify(rest) : '';
      console.log(`${ts} [${level}] ${event}${fields}`);
    }
    const logger = new Logger(dir);
    if (logger.isDegraded) { console.error('日志不可写：请检查数据目录权限。'); process.exitCode = 1; }
  } else if (command === 'export') {
    // Write the knowledge out as ordinary host-readable skills.
    //
    // Requirement this serves: a skill must stay usable if the plugin is
    // removed, so the output is a plain SKILL.md tree with no plugin-only
    // front matter. An explicit --dir is required; the exporter refuses any
    // directory it does not own.
    if (!values.dir) throw new Error('--dir DIRECTORY is required (the export target, e.g. <project>/.agents/skills/amb)');
    const store = new Store(join(dir, 'knowledge.sqlite'));
    try {
      const kinds = values.kinds ? String(values.kinds).split(',').map(k => k.trim()) as Array<Knowledge['kind']> : undefined;
      const result = exportSkills(store, { directory: String(values.dir), kinds, dryRun: values.yes !== true });
      console.log(JSON.stringify({
        dryRun: values.yes !== true,
        directory: result.directory,
        wouldWrite: result.written.length,
        unchanged: result.unchanged.length,
        skipped: result.skipped,
        sample: result.written.slice(0, 5).map(path => path.replace(result.directory, '.')),
        note: values.yes === true
          ? '导出为普通 SKILL.md 文档，脱离插件仍然可用。未声明归属的目录会被拒绝写入。'
          : '干跑：未写入任何文件。加 --yes 执行导出。',
      }, null, 2));
    } finally { store.close(); }
  } else if (command === 'backup' || command === 'restore') {
    // Migration: one file carrying everything, so a user can move their
    // knowledge to another device and import it there.
    //
    // Both directions print absolute paths and deliberate dry-run wording. The
    // archive never holds credentials (the directory exporter refuses even a
    // credential-shaped file name), and the import only adds: a local entry that
    // is newer or has diverged is reported as a conflict and left untouched.
    if (!existsSync(join(dir, 'core.json'))) throw new Error('Core is not initialized for this data dir; run init first.');
    const store = new Store(join(dir, 'knowledge.sqlite'));
    try {
      if (command === 'backup') {
        // A missing --file is a convenience, not an error: the default name is
        // dated, so re-running cannot silently overwrite yesterday's archive.
        const file = values.file ? resolve(String(values.file)) : resolve(defaultArchiveName());
        const result = exportArchive(store, { file, dryRun: values.yes !== true, overwrite: values.overwrite === true });
        console.log(JSON.stringify({
          dryRun: values.yes !== true,
          file: result.file,
          bytes: result.bytes,
          entries: result.entries,
          counts: result.counts,
          skipped: result.skipped,
          note: values.yes === true
            ? '归档已写入。它包含全部知识、历史版本、任务与候选队列，不含任何凭据；复制到另一台设备后用 restore 导入。'
            : '干跑：未写入文件。确认路径后加 --yes 执行导出。',
        }, null, 2));
      } else {
        if (!values.file) throw new Error('--file FILE is required: point it at the .ambpack archive to import');
        const file = resolve(String(values.file));
        if (values.yes !== true) {
          // Inspect first, so the user sees what is inside before anything is
          // merged; this is the same read the console shows in its confirm step.
          const preview = importArchive(store, { file, dryRun: true });
          console.log(JSON.stringify({
            dryRun: true,
            archive: inspectArchive(file),
            wouldImport: preview.imported,
            wouldSkip: preview.skipped,
            conflicts: preview.conflicts,
            note: `干跑：未写入任何内容。加 --yes 执行合并导入。`
              + (preview.conflicts.length ? ` 有 ${preview.conflicts.length} 条冲突会保留本机版本，不会覆盖。` : ''),
          }, null, 2));
        } else {
          const result = importArchive(store, { file, dryRun: false });
          console.log(JSON.stringify({
            ...result,
            knowledgeRevision: store.revision,
            note: '导入完成，采用合并策略：只新增，不删除。'
              + (result.conflicts.length ? ` ${result.conflicts.length} 条冲突保留了本机版本。` : ''),
          }, null, 2));
        }
      }
    } finally { store.close(); }
  } else if (command === 'init') {
    const corePath = join(dir, 'core.json');
    if (existsSync(corePath) || existsSync(join(dir, 'client.json'))) throw new Error('Configuration exists; refusing to overwrite credentials');
    // Three credentials, two roles. The adapters are agents: they read and
    // propose. The admin credential is the human's, and only it can review
    // proposals — otherwise an agent could approve its own submission.
    const config = coreSchema.parse({
      protocolVersion: 1, port: Number(values.port),
      clients: [
        { id: 'codex', projectId: values.project, role: 'adapter', token: randomBytes(32).toString('hex') },
        { id: 'dsh', projectId: values.project, role: 'adapter', token: randomBytes(32).toString('hex') },
        { id: 'admin', projectId: values.project, role: 'admin', token: randomBytes(32).toString('hex') },
      ],
    });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(corePath, JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
    // The admin credential can be placed outside the adapter directory. Keeping it
    // apart does not stop a same-user process — an agent running as this user can
    // read anything the user can — but it does keep the privileged credential out
    // of the directory an adapter is pointed at, which is the difference between
    // "no reason to look" and "one directory listing away".
    const adminDir = values['admin-dir'] ? resolve(String(values['admin-dir'])) : dir;
    if (adminDir !== dir) mkdirSync(adminDir, { recursive: true, mode: 0o700 });
    const written: Array<{ id: string; path: string; role: string }> = [];
    for (const c of config.clients) {
      const client = JSON.stringify({
        endpoint: `http://127.0.0.1:${config.port}`, token: c.token,
        projectId: c.projectId,
        ...(values['project-root'] ? { projectRoot: resolve(String(values['project-root'])) } : {}),
        role: c.role,
      }, null, 2);
      const target = c.role === 'admin' ? adminDir : dir;
      const path = join(target, `${c.id}-client.json`);
      writeFileSync(path, client, { flag: 'wx', mode: 0o600 });
      written.push({ id: c.id, path, role: c.role });
      if (c.id === 'codex') writeFileSync(join(dir, 'client.json'), client, { flag: 'wx', mode: 0o600 });
    }
    /**
     * Tighten each credential file, then say what actually happened.
     *
     * The mode above is not enforced on Windows, so until this runs the file
     * inherits whatever the directory grants — and a `--data-dir` on a drive root
     * grants `Authenticated Users` and `Users`. The result of the attempt is
     * printed rather than assumed, and a failure to tighten is a non-zero exit:
     * this is a security property of a token, and reporting success while the
     * token stays world-readable would be worse than not attempting it.
     */
    const aclResults = written
      .filter(entry => existsSync(entry.path))
      .map(entry => ({ id: entry.id, path: entry.path, ...restrictCredentialAcl(entry.path) }));
    console.log(`P0 configuration created at ${dir}. Credentials were not printed. Keep these files private.`);
    console.log('Adapter credentials (codex, dsh) may read knowledge and submit candidates; only the admin credential may review proposals.');
    // Say plainly what the file mode does and does not buy, rather than implying
    // the credential is protected when a same-user process can read it anyway.
    console.log(`Files written: ${written.map(w => `${w.id}(${w.role})`).join(', ')}.`);
    for (const acl of aclResults) console.log(`ACL ${acl.ok ? 'ok' : 'FAILED'} ${acl.id}: ${acl.detail}`);
    if (aclResults.some(acl => !acl.ok)) process.exitCode = 1;
    console.log('Note: file permissions are set to owner-only, but on Windows that mode is not enforced — the file ACL is what applies, and it has been restricted to this user (plus SYSTEM/Administrators). Any process running as this user can still read these files, so treat the whole directory as holding credentials.'
      + (adminDir === dir ? ' Pass --admin-dir to keep the admin credential in a separate directory from the adapters.' : ` The admin credential is in ${adminDir}.`));
  } else if (['serve', 'seed', 'retire', 'status'].includes(command ?? '')) {
    const config = coreSchema.parse(JSON.parse(readFileSync(join(dir, 'core.json'), 'utf8')));
    const store = new Store(join(dir, 'knowledge.sqlite'));
    if (command === 'serve') {
      // Single instance, taken before the socket is bound.
      //
      // The port alone is not a lock: between "is the port free" and "bind it"
      // there is a window where two cores can both decide it is, and the loser
      // then fails with an address-in-use error that reads like a defect rather
      // than like "one is already running". The lock is exclusive, so one wins and
      // the other is told who holds it.
      const lock = acquireLock(dir, { pid: process.pid, port: config.port, startedAt: Date.now(), dataDir: dir });
      if (!lock.acquired) {
        const holder = lock.heldBy;
        console.error(holder
          ? `核心已在运行（pid ${holder.pid}，端口 ${holder.port}，启动于 ${new Date(holder.startedAt).toLocaleString()}）。`
          : '核心启动失败：未能取得实例锁，且看不到持有者；请检查数据目录权限。');
        process.exitCode = 1;
        store.close();
      } else {
      if (lock.clearedStale) {
        // Said out loud: a crash left this behind, and the next diagnosis should
        // not have to rediscover why the previous run ended without cleaning up.
        console.log(`已清理上一次异常退出留下的锁（pid ${lock.clearedStale.pid}）。`);
      }
      const releaseOnExit = () => releaseLock(dir);
      process.once('exit', releaseOnExit);

      const server = createCoreServer(store, config);
      const maintenance = createMaintenanceWorker(store, dir, config.clients.map(client=>client.projectId));
      const maintenanceTimer = setInterval(() => { void maintenance.tick().catch(() => {}); }, 10000);
      maintenanceTimer.unref();
      const cleanup = setInterval(() => store.cleanup(), 60000); cleanup.unref();
      // Persisted scan roots let a timer-driven rescan know what to walk; without
      // them the periodic job has nothing to do and stays a no-op.
      const configuredRoots = values.roots
        ? store.setScanRoots(String(values.roots).split(',').map(root => root.trim()).filter(Boolean))
        : store.scanRoots().length ? store.scanRoots() : store.setScanRoots(defaultScanRoots());
      if (values['rescan-interval'] !== undefined) store.setRescanInterval(Number(values['rescan-interval']));

      // Run log: version stamps make an old log interpretable after an update,
      // and every rescan/export failure is recorded so a user can report a
      // problem with evidence instead of a reproduction request.
      const logger = new Logger(dir);
      logger.stamp({
        phase: 'P0', protocolVersion: 1,
        pluginVersion: (() => {
          try { return JSON.parse(readFileSync(join(dir, '..', 'package.json'), 'utf8')).version ?? 'unknown'; }
          catch { return 'unknown'; }
        })(),
        adapterIds: config.clients.map(client => client.id),
        pid: process.pid,
        execPath: process.version,
        platform: process.platform,
        nodeVersion: process.versions.node,
        scanRoots: configuredRoots,
        rescanIntervalMs: store.rescanState().intervalMs,
        logFile: logger.file,
      });

      // Periodic rescan lives in the core: it holds the database and the file
      // system access, so it does not depend on a desktop adapter being open.
      // The timer only fires when the configured cadence has actually elapsed,
      // and failures are reported without killing the core.
      const rescanTimer = setInterval(() => {
        if (!store.rescanDue()) return;
        try {
          const outcome = applyRescan(store, configuredRoots);
          logger.info('rescan.done', {
            summary: outcome.summary, refreshed: outcome.refreshed.length,
            adopted: outcome.adopted, errors: outcome.errors,
            knowledgeRevision: store.revision,
          });
          if (outcome.refreshed.length || outcome.adopted || outcome.errors.length) {
            console.log(`amb rescan: ${outcome.summary} refreshed=${outcome.refreshed.length} adopted=${outcome.adopted} errors=${outcome.errors.length}`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'unknown error';
          logger.error('rescan.failed', { message });
          console.error(`amb rescan failed: ${message}`);
        }
      }, 60000); rescanTimer.unref();

      server.once('error', (error: Error) => {
        maintenance.stop(); clearInterval(maintenanceTimer);
        clearInterval(cleanup); clearInterval(rescanTimer); store.close();
        logger.error('core.listen_failed', { code: (error as NodeJS.ErrnoException).code, message: error.message });
        console.error('Cannot start core. Check whether this configured port is already in use.');
        process.exitCode = 1;
      });
      server.listen(config.port, '127.0.0.1', () => {
        void maintenance.tick().catch(() => {});
        logger.info('core.listening', { port: config.port, knowledgeRevision: store.revision, rescanRoots: configuredRoots.length });
        console.log(`P0 core listening on http://127.0.0.1:${config.port}; desktop integration remains unverified.`);
        if (configuredRoots.length) {
          const { intervalMs, lastRescanAt } = store.rescanState();
          console.log(`Periodic rescan enabled over ${configuredRoots.length} root(s); interval ${Math.round(intervalMs / 60000)} min, last run ${lastRescanAt ? new Date(lastRescanAt).toISOString() : 'never'}.`);
        }
        console.log(`Run log: ${logger.file}`);
      });
      const stop = () => {
        maintenance.stop(); clearInterval(maintenanceTimer);
        logger.info('core.stopping', { knowledgeRevision: store.revision });
        clearInterval(cleanup); clearInterval(rescanTimer);
        // The lock goes with the process, in the order a restart expects: released
        // only after the socket is closed, so the next core does not take the lock
        // and then lose the port race to the one still shutting down.
        server.close(() => { releaseLock(dir); store.close(); });
      };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      }
    } else {
      try {
        if (command === 'seed') {
          if (!values.input) throw new Error('--input is required');
          const input = seedSchema.parse(JSON.parse(readFileSync(resolve(values.input), 'utf8')));
          /**
           * The report names what was written and what is not usable.
           *
           * A bare revision was the whole of this output before, and it read as
           * "all imported" even when a temporary-material entry had been stored
           * already expired — the schema's 0 default means *lapsed*, so those
           * entries were purged by the next cleanup and could never be read. The
           * fix gives an entry with no stated lifetime the design's 90 days, and
           * this output is the other half: anything that is *still* unusable is
           * named here, with the reason, instead of being counted as a success.
           */
          const result = store.importWithReport(input.entries);
          console.log(JSON.stringify({
            knowledgeRevision: result.knowledgeRevision,
            imported: result.imported,
            ...(result.unusable.length ? { unusable: result.unusable } : {}),
            note: result.unusable.length
              ? `${result.imported} 条已写入，但其中 ${result.unusable.length} 条导入后不可读（见 unusable，已列出 id 与原因）。`
              : `${result.imported} 条已写入并生效。`,
          }, null, 2));
          if (result.unusable.length) process.exitCode = 1;
        } else if (command === 'retire') {
          if (!values.id || !values.revision || !Number.isInteger(Number(values.revision))) throw new Error('--id and integer --revision required');
          store.retire(values.id, Number(values.revision)); console.log('Knowledge retired; history preserved.');
        } else if (command === 'status') {
          // Prose by default. This answers "what is in my library?", and the rest of the
          // CLI already prints prose with --json for scripts; this one had not.
          const s = store.stats();
          if (values.json === true) {
            console.log(JSON.stringify(s, null, 2));
          } else {
            console.log('Agent Memory Backpack 知识库');
            console.log('  知识版本  ' + s.knowledgeRevision);
            console.log('  知识条目  ' + s.entries);
            console.log('  待审候选  ' + s.pendingProposals);
            console.log('  任务      ' + s.tasks);
            console.log('  采纳记录  ' + s.adoptions + '，取代记录 ' + s.supersessions);
            console.log('  事件      ' + s.events);
            console.log('  发送队列  待发 ' + s.outbox.pending + '，失败 ' + s.outbox.failed + '，已放弃 ' + s.outbox.abandoned);
            if (s.lastRescanAt) console.log('  上次重扫  ' + new Date(s.lastRescanAt).toLocaleString());
          }
        } else {
          // An unknown command used to fall through to the stats dump, which reads as
          // success and hides the typo entirely. Say what is wrong instead.
          console.error('未知命令：' + command);
          console.error('运行 amb --help 查看全部命令。');
          process.exitCode = 1;
        }
      } finally { store.close(); }
    }
  } else if (command === undefined) {
    console.log(USAGE);
  } else {
    // An unknown command is a usage mistake, not a crash: name it and show help
    // rather than letting it fall through to a stack trace.
    console.error(`Unknown command: ${command}\n\n${USAGE}`);
    process.exitCode = 1;
  }
} catch (error) {
  // Schema errors can include submitted content; avoid dumping credentials or seed documents.
  const message = error instanceof Error ? error.message : String(error);
  if (/Unknown option/.test(message)) {
    // parseArgs phrases this poorly; answer a usage mistake with usage.
    console.error(`${message}\n\n${USAGE}`);
  } else {
    console.error(error instanceof Error && error.name === 'ZodError' ? 'Configuration or import schema is invalid' : message);
  }
  process.exitCode = 1;
}
