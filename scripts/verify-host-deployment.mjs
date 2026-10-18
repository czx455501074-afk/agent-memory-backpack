// Is the host actually running the deployed build?
//
// "I deployed and restarted" and "the host is running the new code" are different
// claims, and the gap between them is the single most common way a change looks
// broken on a machine where it was verified. This script answers the narrow
// question with two timestamps and the profile wiring, and prints a verdict.
//
// Read-only: it reads profile package.json files, the deployed file's mtime, and
// the core lock file. It never prints credentials and never starts anything.
//
// Usage: node scripts/verify-host-deployment.mjs [--deploy-dir <dir>] [--profiles-dir <dir>] [--data-dir <dir>]
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const dataDir = flag('data-dir', join(homedir(), '.agent-memory-backpack'));
const profilesDir = flag('profiles-dir', join(homedir(), '.dsh', 'profiles'));
const deployDir = flag('deploy-dir', null);
const packageName = 'dsh-agent-memory-backpack';

const rows = [];
if (existsSync(profilesDir)) {
  for (const name of readdirSync(profilesDir)) {
    const dir = join(profilesDir, name);
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(manifest, 'utf8'));
    } catch {
      rows.push({ profile: name, dependency: '(unreadable package.json)', bundles: '', linked: false });
      continue;
    }
    const dependency = parsed?.dependencies?.[packageName] ?? '';
    const bundles = Array.isArray(parsed?.dsh?.profile?.bundles) ? parsed.dsh.profile.bundles : [];
    const link = join(dir, 'node_modules', packageName);
    rows.push({
      profile: name,
      dependency: dependency || '(not a dependency)',
      bundles: bundles.includes(packageName) ? 'listed' : 'missing',
      linked: existsSync(link),
    });
  }
}

const resolvedDeploy = deployDir
  ?? (() => {
    const fromProfile = rows.find(row => typeof row.dependency === 'string' && row.dependency.startsWith('link:'));
    return fromProfile ? fromProfile.dependency.slice('link:'.length) : null;
  })();

/**
 * When was the deployed package last written?
 *
 * This used to be the mtime of `index.mjs` alone, and that is only half of what the host
 * runs. A package carries the adapter entry points at its root *and* a `runtime/` copy of
 * the core; a change that touches only the core leaves `index.mjs` untouched while
 * `runtime/store.js` is new. Measured on a real deployment: `index.mjs` 2026-10-17T16:10Z,
 * `runtime/store.js` 2026-10-18T05:59Z, core started 05:04Z. The old rule compared the
 * core's start time against 16:10 and reported RUNNING DEPLOYED BUILD — while the core had
 * in fact been started 55 minutes before the runtime it was supposed to be running
 * existed. The verdict said "deployed", the machine was serving the previous build, and
 * that is precisely the confusion this script exists to remove.
 *
 * So take the newest of every file the host actually loads: the adapter entries at the
 * root and the `.js` files of `runtime/`. `node_modules` is skipped on purpose — it is
 * dependencies, not this package's code, and walking it would add seconds for no signal.
 */
function newestDeployedFile(dir) {
  if (!dir || !existsSync(dir)) return { at: null, file: null, checked: 0 };
  const candidates = ['index.mjs', 'client.js'].map(name => join(dir, name));
  const runtime = join(dir, 'runtime');
  if (existsSync(runtime)) {
    for (const name of readdirSync(runtime)) if (name.endsWith('.js')) candidates.push(join(runtime, name));
  }
  let newest = { at: null, file: null, checked: 0 };
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    newest.checked += 1;
    const at = statSync(file).mtimeMs;
    if (newest.at === null || at > newest.at) newest = { at, file, checked: newest.checked };
  }
  return newest;
}

const deployed = newestDeployedFile(resolvedDeploy);
const deployedAt = deployed.at;

let coreStartedAt = null;
const lock = join(dataDir, 'core.lock');
if (existsSync(lock)) {
  try {
    coreStartedAt = Number(JSON.parse(readFileSync(lock, 'utf8')).startedAt) || null;
  } catch {
    coreStartedAt = null;
  }
}

const iso = value => (value ? new Date(value).toISOString() : '(unknown)');
console.log(JSON.stringify({
  profiles: rows,
  deployDir: resolvedDeploy ?? '(unresolved)',
  deployedAt: iso(deployedAt),
  // Which entry set the timestamp, and how many entries were considered: "the newest
  // file" is only useful if a reader can see which file that was.
  deployedFile: deployed.file ?? '(none)',
  deployedEntriesChecked: deployed.checked,
  coreStartedAt: iso(coreStartedAt),
}, null, 2));

// The verdict. A core that started before the deployment cannot be running it -
// the plugin only loads at process start (or at a host restart).
let verdict = 'UNKNOWN';
if (deployedAt && coreStartedAt) verdict = coreStartedAt > deployedAt ? 'RUNNING DEPLOYED BUILD' : 'RUNNING PREVIOUS BUILD';
else if (deployedAt && !coreStartedAt) verdict = 'NO CORE RUNNING (nothing has loaded the plugin yet)';
console.log(`\n结论: ${verdict}`);
if (verdict === 'RUNNING PREVIOUS BUILD')
  console.log('部署产物比核心进程更新——宿主尚未重启，界面与注入行为都还是旧代码。');
if (verdict === 'NO CORE RUNNING (nothing has loaded the plugin yet)')
  console.log('还没有核心进程：插件要等宿主第一次加载时才会把它拉起来。');
process.exit(verdict === 'RUNNING DEPLOYED BUILD' ? 0 : 1);
