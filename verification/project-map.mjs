/**
 * Project map check: does the handover document still describe this repository?
 *
 * The cost this exists to remove: a fresh agent opens the repository, finds 120 top-level
 * entries of which 94 are historical backups, no structural document at all, and spends its
 * first hour scanning (and re-scanning) to find out where anything lives. A written map fixes
 * that once — and then rots the moment somebody adds a directory, because nothing tells them
 * the map exists.
 *
 * So this check does two things a document alone cannot:
 *   1. every path mentioned in AGENTS.md must exist (a map that points at moved files is
 *      worse than no map: it sends the reader somewhere confidently wrong);
 *   2. every top-level entry must be either registered as in-service or matched by a known
 *      historical pattern — anything else is new and unrecorded, and is exactly the directory
 *      the next person will have to explore by hand.
 *
 * Usage: node verification/project-map.mjs [--json]
 * Exit: 0 = map matches the repository, 1 = something is unregistered or missing.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');

/** In-service top-level entries. Adding one here is the act of registering it. */
const REGISTERED = [
  'AGENTS.md', 'README.md', 'CHANGELOG.md', 'LICENSE', 'package.json', 'package-lock.json',
  'tsconfig.json', '.gitignore', '.gitattributes', 'debug.log',
  'src', 'adapters', 'test', 'verification', 'scripts', 'docs', 'dist',
  'core', 'desktop-tauri', 'fixtures', 'artifacts', 'node_modules',
  'dist-console', 'dist-console-out', 'console.archived-electron',
  '.local', '.zerotoken',
];

/**
 * Historical snapshots left by the packaging and deployment scripts.
 *
 * They are matched by pattern rather than listed: the point is that a *new* backup must not
 * look like a new directory, while a genuinely new directory must not be able to hide behind
 * the pattern.
 */
const HISTORICAL = [
  /-backup-\d+-\d+-(?:plugin|core|console)?$/,   // deploy-plugin.mjs 的备份
  /^\.amb-deploy-test-target-\d+(?:\.backup-\d+-\d+-plugin)?$/,  // 部署测试的隔离目标
  /^console\.backup-\d+-\d+-console$/,
  /^core\.backup-\d+-\d+-core$/,
];

const problems = [];
const facts = {};

// 1. The map's own claims: every repository path it names must exist.
const agentsPath = join(ROOT, 'AGENTS.md');
if (!existsSync(agentsPath)) problems.push({ kind: 'missing-map', detail: 'AGENTS.md 不存在：接手者没有入口' });
const mentioned = new Set();
if (existsSync(agentsPath)) {
  for (const match of readFileSync(agentsPath, 'utf8').matchAll(/`([A-Za-z0-9_.\-/]+)`/g)) {
    const raw = match[1].replace(/\/$/, '');
    if (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/.test(raw)) continue;   // 只要带目录的路径
    if (!REGISTERED.includes(raw.split('/')[0])) continue;              // 只校验本项目内的
    mentioned.add(raw);
  }
  for (const path of [...mentioned].sort()) {
    if (!existsSync(join(ROOT, path))) problems.push({ kind: 'stale-map-path', detail: `AGENTS.md 指向的路径不存在：${path}` });
  }
  facts.mapPathsChecked = mentioned.size;
}

// 2. Every top-level entry is either registered or a known historical artifact.
const entries = readdirSync(ROOT, { withFileTypes: true }).map(entry => entry.name).filter(name => name !== '.git');
const unregistered = [], historical = [];
for (const name of entries) {
  if (REGISTERED.includes(name)) continue;
  if (HISTORICAL.some(pattern => pattern.test(name))) { historical.push(name); continue; }
  unregistered.push(name);
}
for (const name of unregistered) problems.push({ kind: 'unregistered-entry', detail: `顶层出现未登记条目：${name}（要么登记进 AGENTS.md 与 project-map.mjs，要么清理）` });
for (const name of REGISTERED) if (name !== 'debug.log' && !existsSync(join(ROOT, name)))
  problems.push({ kind: 'registered-missing', detail: `已登记的条目不存在：${name}` });

// 3. Size facts: the number a handover pays for. Off by default — it is slow (millions of
//    files) and it is never a pass/fail, so the structural check above stays fast.
facts.topLevel = entries.length;
facts.registered = REGISTERED.length;
facts.historical = historical.length;
// Pack copies are rotated by package.mjs (ARTIFACT_KEEP), so a growing count means the rotation
// stopped working. Reported, not judged: the number is only meaningful next to that limit.
const artifactsDir = join(ROOT, 'artifacts');
facts.artifactCopies = existsSync(artifactsDir)
  ? readdirSync(artifactsDir).filter(name => /^p0-\d+$/.test(name)).length
  : 0;
const withSizes = argv.includes('--sizes');
const countFiles = (dir, limit = 200000) => {
  let files = 0, bytes = 0, dirs = 0;
  const walk = (current) => {
    let list; try { list = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const item of list) {
      if (item.isDirectory()) { dirs++; walk(join(current, item.name)); }
      else if (item.isFile()) { files++; try { bytes += statSync(join(current, item.name)).size; } catch { /* racing writer */ } }
      if (files >= limit) return;
    }
  };
  walk(dir);
  return { files, bytes, dirs, capped: files >= limit };
};
if (withSizes) {
  const heavy = ['artifacts', 'desktop-tauri', '.local'].filter(name => existsSync(join(ROOT, name)));
  facts.heavy = Object.fromEntries(heavy.map(name => {
    const size = countFiles(join(ROOT, name));
    return [name, { files: size.files, mb: Math.round(size.bytes / 1048576), capped: size.capped }];
  }));
  facts.historicalMb = Math.round(historical.reduce((sum, name) => sum + countFiles(join(ROOT, name), 20000).bytes, 0) / 1048576);
}

if (asJson) console.log(JSON.stringify({ facts, problems }, null, 2));
else {
  console.log('项目结构导览与仓库现状对账\n');
  const sizeNote = facts.historicalMb === undefined ? '' : `（约 ${facts.historicalMb} MB）`;
  console.log(`顶层条目 ${facts.topLevel} = 已登记 ${facts.registered} + 历史快照 ${facts.historical}${sizeNote} + 未登记 ${unregistered.length}`);
  console.log(`AGENTS.md 引用的路径：校验 ${facts.mapPathsChecked ?? 0} 条`);
  for (const [name, size] of Object.entries(facts.heavy ?? {}))
    console.log(`  ${name.padEnd(15)} ${String(size.files).padStart(8)} 文件  ${String(size.mb).padStart(6)} MB${size.capped ? '（已达统计上限）' : ''}`);
  console.log(`  artifacts 下的 p0-* 打包副本：${facts.artifactCopies} 份（轮转上限见 scripts/package.mjs 的 ARTIFACT_KEEP）`);
  if (!problems.length) console.log('\n一致：没有未登记的顶层条目，导览指向的路径全部存在。');
  else { console.log(''); for (const item of problems) console.log(`FAIL  [${item.kind}] ${item.detail}`); }
}
process.exit(problems.length ? 1 : 0);
