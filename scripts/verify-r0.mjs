/**
 * R0 independent verification runner.
 *
 * The full-audit scripts import the code under test from a `build/src/*.js`
 * snapshot sitting next to them. Recompiling *current* source into that same
 * layout lets the original reproducers be re-run as verification: same scripts,
 * same fixtures, same assertions, but against the repaired code. That is what
 * makes "the subagent says it is fixed" checkable instead of taken on trust.
 *
 * Layout requirement: each audit script resolves `../../../adapters/...`, so the
 * copy must sit three levels below the repository root — exactly as deep as the
 * original. `.local/verify-r0/<area>/` is that depth; the original
 * `.local/full-audit-20261011/<area>/` is the same depth, which is why the
 * originals can be reused verbatim rather than rewritten.
 *
 * Usage:
 *   node scripts/verify-r0.mjs build    compile current source into each rerun build/
 *   node scripts/verify-r0.mjs run      run every verification script
 *   node scripts/verify-r0.mjs all      build then run
 *   node scripts/verify-r0.mjs report   summarise the last run
 *
 * This script never installs, deploys or enables the plugin in a host, and never
 * writes to the real knowledge directory: the reproducers use in-memory SQLite
 * and random loopback ports, and the only files written are under `.local/`.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verifyRoot = join(root, '.local', 'verify-r0');
const sourceRoot = join(root, '.local', 'full-audit-20261011');

/** Each area keeps the original directory depth so its relative imports resolve. */
const AREAS = [
  { name: 'security', scripts: ['http-audit.mjs', 'supplement-audit.mjs', 'identity-audit.mjs'] },
  { name: 'evolution', scripts: ['reproduce.mjs'] },
  { name: 'shared-call', scripts: ['audit-shared-call.mjs', 'audit-config-path.mjs'] },
  { name: 'performance', scripts: ['performance.mjs'] },
];

/** Scripts that need a live core or a real host session, run separately. */
const SKIP_BY_DEFAULT = new Set(['audit-shared-call.mjs']);

const mode = process.argv[2] ?? 'report';
const only = process.argv.slice(3).filter(arg => !arg.startsWith('-'));

function areaDir(area) { return join(verifyRoot, area.name); }

/**
 * Rewrite each reproducer's output root so it writes inside the rerun directory.
 *
 * This is not cosmetic. The audit scripts compute their output directory with
 * `resolve('.local/full-audit-20261011/<area>')`, which is *relative to the
 * working directory*, so running a copy from the repository root makes it
 * overwrite the original audit evidence — the very "before" files a verification
 * run is supposed to be compared against. An earlier version of this script did
 * exactly that to `evolution/reproduction.json`. Redirecting the literal keeps
 * every artefact of a rerun inside `.local/verify-r0/`.
 */
function redirectOutput(source, areaName) {
  return source
    .split(`.local/full-audit-20261011/${areaName}`).join(`.local/verify-r0/${areaName}`)
    .split('.local\\\\full-audit-20261011\\\\' + areaName).join('.local\\\\verify-r0\\\\' + areaName);
}

function stage(area) {
  const target = areaDir(area);
  mkdirSync(target, { recursive: true });
  for (const script of area.scripts) {
    const from = join(sourceRoot, area.name, script);
    if (!existsSync(from)) continue;
    writeFileSync(join(target, script), redirectOutput(readFileSync(from, 'utf8'), area.name), 'utf8');
  }
  // Repository-relative fixture files some reproducers read for hashing.
  for (const extra of ['fixtures/p0-seed.json']) {
    const from = join(sourceRoot, area.name, extra);
    if (!existsSync(from)) continue;
    mkdirSync(join(target, dirname(extra)), { recursive: true });
    copyFileSync(from, join(target, extra));
  }
}

function build(area) {
  const out = join(areaDir(area), 'build');
  mkdirSync(out, { recursive: true });
  process.stdout.write(`[build] ${area.name} -> ${out}\n`);
  execFileSync(process.execPath, [
    join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    '-p', join(root, 'tsconfig.json'),
    '--outDir', out,
  ], { cwd: root, stdio: 'inherit' });
}

function run(area) {
  const target = areaDir(area);
  const results = [];
  for (const script of area.scripts) {
    const file = join(target, script);
    if (!existsSync(file)) continue;
    if (SKIP_BY_DEFAULT.has(script) && !only.includes(script)) {
      results.push({ script, status: 'skipped', detail: '需要真实宿主会话；不在隔离核验中执行' });
      continue;
    }
    const started = Date.now();
    try {
      const output = execFileSync(process.execPath, [file], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      results.push({ script, status: 'ok', ms: Date.now() - started, tail: output.trim().split('\n').slice(-12).join('\n') });
    } catch (error) {
      // A reproducer asserts the *repaired* expectation, so it exits non-zero when
      // a defect is still present. That is a result, not a crash.
      const output = String(error.stdout ?? '') + String(error.stderr ?? '');
      results.push({
        script, status: 'failed', ms: Date.now() - started,
        tail: output.trim().split('\n').slice(-20).join('\n'),
      });
    }
  }
  return results;
}

function summarise() {
  const all = [];
  for (const area of AREAS) {
    for (const file of ['http-findings.json', 'role-scope-summary.json', 'supplement-findings.json',
      'identity-findings.json', 'reproduction.json', 'config-path-evidence.json', 'results.json']) {
      const path = join(areaDir(area), file);
      if (!existsSync(path)) continue;
      all.push({ area: area.name, file, path });
    }
  }
  return all;
}

if (mode === 'build' || mode === 'all') {
  for (const area of AREAS) { stage(area); build(area); }
}

if (mode === 'run' || mode === 'all') {
  const reports = [];
  for (const area of AREAS) reports.push({ area: area.name, results: run(area) });
  const out = join(verifyRoot, 'run-report.json');
  writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2), 'utf8');
  process.stdout.write(`\n[run] 报告写入 ${out}\n`);
  for (const report of reports) {
    process.stdout.write(`\n== ${report.area} ==\n`);
    for (const item of report.results) {
      process.stdout.write(`  ${item.status.padEnd(8)} ${item.script}${item.ms ? ` (${item.ms}ms)` : ''}\n`);
      if (item.detail) process.stdout.write(`           ${item.detail}\n`);
    }
  }
}

if (mode === 'report') {
  const files = summarise();
  if (!files.length) {
    process.stdout.write('尚无核验产物。先运行： node scripts/verify-r0.mjs all\n');
  } else {
    process.stdout.write('已生成的核验产物：\n');
    for (const item of files) process.stdout.write(`  [${item.area}] ${item.file}\n`);
  }
  const runReport = join(verifyRoot, 'run-report.json');
  if (existsSync(runReport)) {
    const parsed = JSON.parse(readFileSync(runReport, 'utf8'));
    process.stdout.write(`\n上次运行：${parsed.generatedAt}\n`);
    for (const report of parsed.reports) {
      const bad = report.results.filter(r => r.status === 'failed').length;
      process.stdout.write(`  ${report.area}: ${report.results.length} 脚本，${bad} 失败\n`);
    }
  }
}
