import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Store } from './store.js';
import { seedSchema, workflowSchema, type Knowledge } from './schema.js';
import { coreSchema, clientSchema, defaultDataDir } from './config.js';
import { spawn } from 'node:child_process';
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
    const coreEntry = join(root, 'dist', 'src', 'cli.js');
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
      console.log(JSON.stringify({
        lock: lock.state === 'absent' ? { state: 'absent' }
          : lock.state === 'unreadable' ? { state: 'unreadable', detail: lock.detail }
          : { state: lock.state, pid: lock.info.pid, port: lock.info.port, startedAt: lock.info.startedAt },
        healthy: health.healthy, healthDetail: health.detail,
        loginStartup: startup.registered, loginStartupDetail: startup.detail,
        note: '锁表示"谁在运行"；健康探测表示"核心是否在回应"。两者分开报告，因为一个陈旧的锁和一个挂掉的核心是不同的问题。',
      }, null, 2));
    } else if (action === 'start') {
      if (!existsSync(coreEntry)) throw new Error(`未找到核心入口：${coreEntry}。先运行 npm run build。`);
      const lock = inspectLock(dir);
      if (lock.state === 'held') {
        console.log(JSON.stringify({ started: false, reason: 'already-running', pid: lock.info.pid, note: '已有核心在运行，未启动第二个。' }, null, 2));
      } else {
        if (lock.state === 'stale') console.log(`（清理了上一次异常退出留下的锁，pid ${lock.info.pid}。）`);
        const logFile = join(dir, 'core-service.log');
        const { pid } = startDetached(coreEntry, dir, logFile);
        console.log(JSON.stringify({ started: true, pid, log: logFile, note: '核心已脱离本终端运行，关闭本窗口不会停止它。' }, null, 2));
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
      const result = action === 'enable-startup'
        ? registerLoginStartup(coreEntry, dir)
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
        projectId: c.projectId, projectRoot: resolve(values['project-root'] ?? process.cwd()),
        role: c.role,
      }, null, 2);
      const target = c.role === 'admin' ? adminDir : dir;
      const path = join(target, `${c.id}-client.json`);
      writeFileSync(path, client, { flag: 'wx', mode: 0o600 });
      written.push({ id: c.id, path, role: c.role });
      if (c.id === 'codex') writeFileSync(join(dir, 'client.json'), client, { flag: 'wx', mode: 0o600 });
    }
    console.log(`P0 configuration created at ${dir}. Credentials were not printed. Keep these files private.`);
    console.log('Adapter credentials (codex, dsh) may read knowledge and submit candidates; only the admin credential may review proposals.');
    // Say plainly what the file mode does and does not buy, rather than implying
    // the credential is protected when a same-user process can read it anyway.
    console.log(`Files written: ${written.map(w => `${w.id}(${w.role})`).join(', ')}.`);
    console.log('Note: file permissions are set to owner-only, but on Windows that mode is not enforced — the directory ACL is what applies. Any process running as this user can read these files, so treat the whole directory as holding credentials.'
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
      const cleanup = setInterval(() => store.cleanup(), 60000); cleanup.unref();
      // Persisted scan roots let a timer-driven rescan know what to walk; without
      // them the periodic job has nothing to do and stays a no-op.
      const configuredRoots = values.roots
        ? store.setScanRoots(String(values.roots).split(',').map(root => root.trim()).filter(Boolean))
        : store.scanRoots();
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
        if (configuredRoots.length === 0) { store.markRescanned(); return; }
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
        clearInterval(cleanup); clearInterval(rescanTimer); store.close();
        logger.error('core.listen_failed', { code: (error as NodeJS.ErrnoException).code, message: error.message });
        console.error('Cannot start core. Check whether this configured port is already in use.');
        process.exitCode = 1;
      });
      server.listen(config.port, '127.0.0.1', () => {
        logger.info('core.listening', { port: config.port, knowledgeRevision: store.revision, rescanRoots: configuredRoots.length });
        console.log(`P0 core listening on http://127.0.0.1:${config.port}; desktop integration remains unverified.`);
        if (configuredRoots.length) {
          const { intervalMs, lastRescanAt } = store.rescanState();
          console.log(`Periodic rescan enabled over ${configuredRoots.length} root(s); interval ${Math.round(intervalMs / 60000)} min, last run ${lastRescanAt ? new Date(lastRescanAt).toISOString() : 'never'}.`);
        }
        console.log(`Run log: ${logger.file}`);
      });
      const stop = () => {
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
          console.log(JSON.stringify({ knowledgeRevision: store.import(input.entries) }));
        } else if (command === 'retire') {
          if (!values.id || !values.revision || !Number.isInteger(Number(values.revision))) throw new Error('--id and integer --revision required');
          store.retire(values.id, Number(values.revision)); console.log('Knowledge retired; history preserved.');
        } else console.log(JSON.stringify(store.stats(), null, 2));
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
