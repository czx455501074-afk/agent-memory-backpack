// Deploy the packaged plugin into the host's DSH profiles.
//
// The host loads a plugin through `profiles/<name>/node_modules/<package>`, so a
// working deployment needs three things to agree:
//
//   1. the manifest's dependency entry, which records the intent;
//   2. the `bundles` entry, which is what actually activates the plugin — a
//      package listed only as a dependency is installed but never loaded;
//   3. the link under `node_modules`, which is what the host resolves at runtime.
//
// Editing the manifest does not move an existing link. A deploy that updated only
// items 1 and 2 looked successful while the host kept loading the previous
// package, which is how an auto-start fix appeared to do nothing after a restart.
// This script does all three and then verifies by reading through the link.
//
// The package is placed in a stable directory rather than inside `artifacts/`:
// that tree is regenerated on every pack and swept during housekeeping, so a link
// into it breaks the plugin the next time old artifacts are cleaned.

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { validateDshClient } from './validate-dsh-client.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = 'dsh-agent-memory-backpack';
/** A file that only the current package has; used to prove the link is fresh. */
const SENTINEL = 'ensure-core.mjs';

const { values } = parseArgs({
  options: {
    artifact: { type: 'string' },
    target: { type: 'string' },
    profiles: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log([
    'Deploy the packaged plugin into DSH profiles.',
    '',
    'Usage: node scripts/deploy-plugin.mjs [options]',
    '',
    '  --artifact DIR   packaged artifact root (default: artifacts/latest.json)',
    '  --target DIR     where to place the plugin package',
    '                   (default: $AMB_PLUGIN_DIR, else <dsh home>/plugins/agent-memory-backpack)',
    '  --profiles LIST  comma-separated profile names (default: every profile that declares it)',
    '  --dry-run        validate and print planned changes without writing',
    '  -h, --help       show this help',
  ].join('\n'));
  process.exit(0);
}

const artifactRoot = resolve(values.artifact
  ?? JSON.parse(readFileSync(join(root, 'artifacts', 'latest.json'), 'utf8')).directory);
const source = join(artifactRoot, 'dsh-plugin');
validateDshClient(source);
if (!existsSync(join(source, SENTINEL))) {
  console.error(`Not a plugin package (no ${SENTINEL}): ${source}`);
  console.error('Run "npm run pack:local" first.');
  process.exit(1);
}

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const profilesDir = join(dshHome, 'profiles');

/**
 * Where to put the package.
 *
 * Follows the convention already on this machine: if another plugin is linked
 * from a local directory, its parent is where local plugins live, so ours goes
 * beside it and stays discoverable. Falling back to a directory under the DSH
 * home keeps a fresh install self-contained either way.
 */
function defaultTarget() {
  if (!existsSync(profilesDir)) return join(dshHome, 'plugins', 'agent-memory-backpack');
  for (const name of readdirSync(profilesDir)) {
    const manifest = join(profilesDir, name, 'package.json');
    if (!existsSync(manifest)) continue;
    let deps;
    try { deps = JSON.parse(readFileSync(manifest, 'utf8')).dependencies ?? {}; } catch { continue; }
    for (const [dep, spec] of Object.entries(deps)) {
      if (dep === PACKAGE || typeof spec !== 'string' || !spec.startsWith('link:')) continue;
      const sibling = resolve(spec.slice('link:'.length));
      if (existsSync(sibling)) return join(dirname(sibling), 'agent-memory-backpack');
    }
  }
  return join(dshHome, 'plugins', 'agent-memory-backpack');
}

const target = resolve(values.target ?? process.env.AMB_PLUGIN_DIR ?? defaultTarget());
const coreSource = join(artifactRoot, 'core');
const coreTarget = join(dirname(target), 'core');
const hasCore = existsSync(join(coreSource, 'runtime', 'client.js'));

/**
 * Resolve every destination and validate all profiles before creating or replacing
 * anything. The returned snapshots are the rollback source for the commit phase.
 */
function preflight() {
  const profiles = values.profiles
    ? values.profiles.split(',').map(p => p.trim()).filter(Boolean)
    : existsSync(profilesDir)
      ? readdirSync(profilesDir).filter(name => {
          const manifest = join(profilesDir, name, 'package.json');
          if (!existsSync(manifest)) return false;
          try { return Boolean(JSON.parse(readFileSync(manifest, 'utf8')).dependencies?.[PACKAGE]); }
          catch { return false; }
        })
      : [];
  if (!profiles.length) throw new Error(`No profile declares ${PACKAGE}; nothing to wire up.`);

  const items = [
    { name: 'plugin', source, target, required: true },
    { name: 'core', source: coreSource, target: coreTarget, required: hasCore },
  ];
  const normalized = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  const isInside = (parent, child) => {
    const rel = relative(normalized(parent), normalized(child));
    // On Windows, `relative` cannot express a path between two different volumes as a
    // relative one, so it answers with the child's absolute path instead. That answer
    // matches none of the "outside" shapes below (`..`, `..\`, a leading separator),
    // which made every cross-volume pair look contained: a target under `C:\...` was
    // read as sitting inside a source under `D:\...`, and a legitimate deploy was
    // refused over an overlap that could not exist. An absolute result means there is
    // no relative path at all, so the child is not inside the parent. Same-volume
    // containment is decided by the check below and is unchanged.
    if (isAbsolute(rel)) return false;
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep));
  };
  for (const item of items) {
    if (item.required && isInside(item.source, item.target)) {
      throw new Error(`Deployment target must not overlap its source: ${item.target}`);
    }
    for (const other of items) {
      if (item !== other && (isInside(item.target, other.target) || isInside(other.target, item.target))) {
        throw new Error(`Deployment destinations overlap: ${item.target} and ${other.target}`);
      }
    }
    const parent = dirname(item.target);
    if (existsSync(parent) && !lstatSync(parent).isDirectory()) throw new Error(`Invalid deployment parent directory: ${parent}`);
    if (item.required && (!existsSync(item.source) || !lstatSync(item.source).isDirectory())) {
      throw new Error(`Missing ${item.name} source directory: ${item.source}`);
    }
  }

  const manifests = profiles.map(profile => {
    const dir = join(profilesDir, profile);
    const manifestPath = join(dir, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!manifest.dependencies || typeof manifest.dependencies !== 'object' || Array.isArray(manifest.dependencies)) {
      throw new Error(`Invalid dependencies object in ${manifestPath}`);
    }
    const bundles = manifest.dsh?.profile?.bundles;
    if (bundles !== undefined && !Array.isArray(bundles)) {
      throw new Error(`Invalid dsh.profile.bundles array in ${manifestPath}`);
    }
    const modules = join(dir, 'node_modules');
    if (existsSync(modules) && !lstatSync(modules).isDirectory()) {
      throw new Error(`Invalid node_modules path in ${dir}`);
    }
    const link = join(modules, PACKAGE);
    const existing = lstatSync(link, { throwIfNoEntry: false });
    if (existing && !existing.isSymbolicLink()) {
      throw new Error(`${profile}: ${PACKAGE} is a real directory, not a link; refusing to replace it`);
    }
    return { profile, dir, manifestPath, manifest, modules, link };
  });
  return { profiles: manifests, items };
}

const plan = preflight();
for (const { name, source: from, target: to, required } of plan.items) {
  console.log(`${required ? 'deploy' : 'skip  '} ${name.padEnd(8)} ${from}\n       -> ${to}`);
}
for (const { profile } of plan.profiles) console.log(`wire    ${profile}`);
if (values['dry-run']) {
  console.log('Dry run complete; no files changed.');
  process.exit(0);
}

/**
 * Stage copies beside their destinations so rename stays on the same volume.
 * Existing destinations are renamed to backups before the staged tree is installed.
 */
function pathExists(path) {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

function removePath(path) {
  if (pathExists(path)) rmSync(path, { recursive: true, force: true });
}

/**
 * How many rollback copies to keep per target and label.
 *
 * A backup only has to survive until the next deploy has been verified, so a
 * handful is plenty. Keeping every one of them for ever is its own defect: each
 * deploy used to leave a full copy of the plugin tree behind, which is how this
 * repository accumulated 92 backup directories holding ~1.58 GB of files that
 * were never meant to ship.
 */
const BACKUP_KEEP = 3;

/**
 * Drop all but the newest `limit` backups of each target.
 *
 * Matching is deliberately strict — `<name>.backup-<pid>-<timestamp>[-<label>]`,
 * the exact shape written below — so a directory that merely looks similar is
 * never touched. Anything that cannot be deleted is left in place rather than
 * failing the deploy that just succeeded.
 */
function pruneBackups(backupPaths, limit = BACKUP_KEEP) {
  const removed = [];
  const handled = new Set();
  for (const backupPath of backupPaths) {
    const directory = dirname(backupPath);
    const name = basename(backupPath);
    const match = /^(.+)\.backup-\d+-\d+(?:-([A-Za-z0-9_.-]+))?$/.exec(name);
    if (!match) continue;
    const stem = match[1];
    const label = match[2] === undefined ? '' : `-${match[2]}`;
    const key = `${directory}\u0000${stem}\u0000${label}`;
    if (handled.has(key)) continue;
    handled.add(key);
    const pattern = new RegExp(`^${escapeForRegExp(stem)}\\.backup-\\d+-\\d+${escapeForRegExp(label)}$`);
    let entries;
    try { entries = readdirSync(directory); } catch { continue; }
    const newestFirst = entries
      .filter(entry => pattern.test(entry))
      .map(entry => ({ entry, stamp: Number(/\.backup-\d+-(\d+)/.exec(entry)?.[1] ?? 0) }))
      .sort((left, right) => right.stamp - left.stamp);
    for (const candidate of newestFirst.slice(limit)) {
      const full = join(directory, candidate.entry);
      try {
        rmSync(full, { recursive: true, force: true });
        removed.push(full);
      } catch {
        // A backup we cannot delete is not a reason to fail a verified deploy.
      }
    }
  }
  return removed;
}

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function commit() {
  const operations = [];
  const createdDirectories = [];
  const transaction = `${process.pid}-${Date.now()}`;
  const ensureDirectory = path => {
    if (pathExists(path)) return;
    const parent = dirname(path);
    if (parent !== path) ensureDirectory(parent);
    mkdirSync(path);
    createdDirectories.push(path);
  };
  const cleanupDirectories = () => {
    for (const path of createdDirectories.slice().reverse()) {
      try { rmdirSync(path); } catch (error) { if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error; }
    }
  };
  const stageCopy = (from, to, label) => {
    const staged = `${to}.stage-${transaction}-${label}`;
    const backup = `${to}.backup-${transaction}-${label}`;
    ensureDirectory(dirname(to));
    operations.push({ target: to, staged, backup, existed: pathExists(to), kind: 'tree' });
    cpSync(from, staged, { recursive: true });
  };

  try {
    for (const item of plan.items) if (item.required) stageCopy(item.source, item.target, item.name);
    for (const snapshot of plan.profiles) {
      const staged = `${snapshot.manifestPath}.stage-${transaction}`;
      const backup = `${snapshot.manifestPath}.backup-${transaction}`;
      operations.push({ target: snapshot.manifestPath, staged, backup, existed: true, kind: 'file' });
      const manifest = snapshot.manifest;
      manifest.dependencies[PACKAGE] = `link:${target.replace(/\\/g, '/')}`;
      const bundles = manifest.dsh?.profile?.bundles;
      if (Array.isArray(bundles) && !bundles.includes(PACKAGE)) bundles.push(PACKAGE);
      writeFileSync(staged, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
      operations.push({ target: snapshot.link, staged: null, backup: null,
        existed: Boolean(lstatSync(snapshot.link, { throwIfNoEntry: false })), kind: 'link', linkTarget: target,
        modules: snapshot.modules, originalLinkTarget: snapshot.originalLinkTarget });
    }

    for (const [index, operation] of operations.entries()) {
      // Tests can inject a deterministic failure after partial commit without touching live paths.
      if (process.env.AMB_DEPLOY_FAIL_AT === String(index + 1)) throw new Error(`Injected deployment failure at operation ${index + 1}`);
      if (operation.kind === 'link') {
        if (!pathExists(operation.modules)) ensureDirectory(operation.modules);
        if (operation.existed) {
          operation.backup = `${operation.target}.backup-${transaction}`;
          renameSync(operation.target, operation.backup);
        }
        operation.installed = true;
        symlinkSync(operation.linkTarget, operation.target, 'junction');
        continue;
      }
      if (operation.existed) renameSync(operation.target, operation.backup);
      operation.installed = true;
      renameSync(operation.staged, operation.target);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const operation of operations.slice().reverse()) {
      try {
        if (operation.installed) removePath(operation.target);
        if (operation.backup && pathExists(operation.backup)) renameSync(operation.backup, operation.target);
        if (operation.staged && pathExists(operation.staged)) rmSync(operation.staged, { recursive: true, force: true });
      } catch (rollbackError) { rollbackErrors.push(`${operation.target}: ${rollbackError.message}`); }
    }
    try { cleanupDirectories(); } catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors.map(message => new Error(message))], 'Deployment failed and rollback was incomplete');
    throw error;
  }

  // Keep the transaction backups until all post-write verification passes.
  try {
    for (const { profile, link } of plan.profiles) {
      if (!existsSync(join(link, SENTINEL))) throw new Error(`${profile}: deployed link does not expose ${SENTINEL}`);
      const manifest = JSON.parse(readFileSync(join(profilesDir, profile, 'package.json'), 'utf8'));
      const bundles = manifest.dsh?.profile?.bundles;
      if (Array.isArray(bundles) && !bundles.includes(PACKAGE)) throw new Error(`${profile}: package activation was not persisted`);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const operation of operations.slice().reverse()) {
      try {
        if (operation.installed) removePath(operation.target);
        if (operation.backup && pathExists(operation.backup)) renameSync(operation.backup, operation.target);
      } catch (rollbackError) { rollbackErrors.push(`${operation.target}: ${rollbackError.message}`); }
    }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors.map(message => new Error(message))], 'Verification failed and rollback was incomplete');
    throw error;
  }
  cleanupDirectories();
  const retained = operations.filter(operation => operation.backup && pathExists(operation.backup)).map(operation => operation.backup);
  pruneBackups(retained);
  return retained;
}

const backups = commit();
console.log(`package   ${source}\n       -> ${target}`);
if (hasCore) console.log(`core      ${coreSource}\n       -> ${coreTarget}`);
for (const { profile, link, manifest } of plan.profiles) {
  const bundles = manifest.dsh?.profile?.bundles;
  console.log(`  ${profile.padEnd(10)} active=${Array.isArray(bundles) ? bundles.includes(PACKAGE) : 'n/a'} linked=yes`);
}
console.log(`Backups retained: ${backups.length ? backups.join(', ') : 'none'}`);
console.log('\nRestart DSH for the host to load the deployed package.');
process.exit(0);
