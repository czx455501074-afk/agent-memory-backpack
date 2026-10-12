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

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = 'dsh-agent-memory-backpack';
/** A file that only the current package has; used to prove the link is fresh. */
const SENTINEL = 'ensure-core.mjs';

const { values } = parseArgs({
  options: {
    artifact: { type: 'string' },
    target: { type: 'string' },
    profiles: { type: 'string' },
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
    '  -h, --help       show this help',
  ].join('\n'));
  process.exit(0);
}

const artifactRoot = resolve(values.artifact
  ?? JSON.parse(readFileSync(join(root, 'artifacts', 'latest.json'), 'utf8')).directory);
const source = join(artifactRoot, 'dsh-plugin');
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

// Replace rather than merge: a stale file left in place would be loaded beside
// the new ones, which is harder to diagnose than a slow first start.
if (existsSync(target)) rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
console.log(`package   ${source}\n       -> ${target}`);

/**
 * Which profiles to touch.
 *
 * Defaults to the ones already declaring this package, so the script never
 * introduces the plugin into a profile the user has not opted in to.
 */
const candidates = values.profiles
  ? values.profiles.split(',').map(p => p.trim()).filter(Boolean)
  : existsSync(profilesDir)
    ? readdirSync(profilesDir).filter(name => {
        const manifest = join(profilesDir, name, 'package.json');
        if (!existsSync(manifest)) return false;
        try { return Boolean(JSON.parse(readFileSync(manifest, 'utf8')).dependencies?.[PACKAGE]); }
        catch { return false; }
      })
    : [];

if (!candidates.length) {
  console.error(`\nNo profile declares ${PACKAGE}; nothing to wire up.`);
  process.exit(1);
}

let failures = 0;
for (const profile of candidates) {
  const dir = join(profilesDir, profile);
  const manifestPath = join(dir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  // 1 + 2. manifest: point the dependency at the deployment, and ensure it is active.
  const before = JSON.stringify(manifest);
  manifest.dependencies[PACKAGE] = `link:${target.replace(/\\/g, '/')}`;
  const bundles = manifest.dsh?.profile?.bundles;
  const activated = Array.isArray(bundles) && bundles.includes(PACKAGE);
  if (Array.isArray(bundles) && !activated) bundles.push(PACKAGE);
  if (JSON.stringify(manifest) !== before) {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  }

  // 3. the link the host actually resolves.
  const modules = join(dir, 'node_modules');
  const link = join(modules, PACKAGE);
  const existing = lstatSync(link, { throwIfNoEntry: false });
  if (existing && !existing.isSymbolicLink()) {
    console.error(`  ${profile}: ${PACKAGE} is a real directory, not a link; refusing to replace it`);
    failures += 1;
    continue;
  }
  if (existing) rmSync(link, { recursive: true, force: true });
  mkdirSync(modules, { recursive: true });
  symlinkSync(target, link, 'junction');

  // Verified by reading through the link, not by trusting the calls above.
  const wired = existsSync(join(link, SENTINEL));
  if (!wired) failures += 1;
  // `activated` is the real answer and is reported alone. It previously read
  // `activated || Array.isArray(bundles)`, which is true for any profile that
  // merely *has* a bundles list — so a deploy that failed to add this package
  // still printed active=true and could exit 0. A user reading that line would
  // believe the plugin was enabled when it was not, which is the same
  // false-positive class as the capability report this project already fixed.
  if (Array.isArray(bundles) && !activated) failures += 1;
  console.log(`  ${profile.padEnd(10)} active=${activated} linked=${wired ? 'yes' : 'NO'}`);
}

console.log(`\nRestart DSH for the host to load the deployed package.`);
process.exit(failures ? 1 : 0);
