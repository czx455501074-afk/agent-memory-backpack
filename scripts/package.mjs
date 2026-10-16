import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { validateDshClient } from './validate-dsh-client.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
validateDshClient(join(root, 'adapters/dsh'));

/**
 * Record which commit and which working tree produced this artifact.
 *
 * The hashes written below only prove that the artifact matches its own
 * manifest; they say nothing about the tree it came from, so a source tree that
 * kept moving after packaging still looks verified. This identity is what makes
 * "same build" checkable later. Git being unavailable is not a reason to refuse
 * to pack, so every failure degrades to an explicit null plus the reason.
 */
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const gitBuildIdentity = () => {
  const git = args => spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  const head = git(['rev-parse', 'HEAD']);
  const commit = head.status === 0 ? String(head.stdout ?? '').trim().toLowerCase() : '';
  if (!COMMIT_PATTERN.test(commit)) {
    const reason = head.error ? head.error.message : (String(head.stderr ?? '').trim() || `exit code ${head.status}`);
    return { commit: null, worktreeStatus: null, clean: null, worktreeEntryCount: null, unavailable: `git rev-parse HEAD failed: ${reason}` };
  }
  const status = git(['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.status !== 0) {
    const reason = status.error ? status.error.message : (String(status.stderr ?? '').trim() || `exit code ${status.status}`);
    return { commit, worktreeStatus: null, clean: null, worktreeEntryCount: null, unavailable: `git status failed: ${reason}` };
  }
  const worktreeStatus = String(status.stdout ?? '').replace(/\r\n/g, '\n');
  const lines = worktreeStatus.split('\n').filter(line => line.trim() !== '');
  return { commit, worktreeStatus, clean: lines.length === 0, worktreeEntryCount: lines.length, unavailable: null };
};
const id = new Date().toISOString().replace(/[-:.TZ]/g, '');
const out = join(root, 'artifacts', `p0-${id}`);
if (!existsSync(join(root, 'dist/src/mcp.js'))) throw new Error('Run npm run build first');
mkdirSync(out, { recursive: true });
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
// Each package has an independent, lockfile-pinned runtime. Never copy user configuration.
for (const target of ['core', 'codex-plugin']) {
  const dir = join(out, target); mkdirSync(dir);
  cpSync(join(root, 'dist/src'), join(dir, 'runtime'), { recursive: true });
  if (target === 'codex-plugin') cpSync(join(root, 'adapters/codex'), dir, { recursive: true });
  // Scripts in the packaged copy point at the packaged layout, so a user can run
  // the diagnostics without knowing where the artifact put things.
  const packagedScripts = {
    start: 'node runtime/cli.js serve',
    doctor: 'node runtime/cli.js doctor',
    logs: 'node runtime/cli.js logs',
  };
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ ...manifest, scripts: packagedScripts }, null, 2));
  cpSync(join(root, 'package-lock.json'), join(dir, 'package-lock.json'));
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !existsSync(npmCli) || !statSync(npmCli).isFile() || !npmCli.toLowerCase().endsWith('.js')) {
    throw new Error('Run packaging via npm run pack:local so npm_execpath identifies the npm CLI JavaScript file.');
  }
  const installed = spawnSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: dir, stdio: 'inherit', windowsHide: true,
  });
  if (installed.status !== 0) throw new Error(`Runtime installation failed: ${target}`);
}
// The DSH adapter starts the shared core itself, so its package must carry the
// core runtime and that runtime's dependencies. Shipping only the adapter would
// let the plugin load and then fail every tool call with "core unavailable",
// which is the failure this project keeps having to apologise for.
//
// The runtime's dependencies are taken from the `core` package installed just
// above rather than installed again here. A second `npm ci` would need a lock
// file matching this package's own manifest — the adapter declares peer
// dependencies on host packages, so it cannot borrow the root lock — and the two
// copies would be identical anyway.
//
// The packages stay separate rather than sharing one runtime copy because each is
// installed by a different host into a different tree; a relative path from one
// to the other does not survive either host's install step.
cpSync(join(root, 'adapters/dsh'), join(out, 'dsh-plugin'), { recursive: true });
cpSync(join(root, 'dist/src'), join(out, 'dsh-plugin/runtime'), { recursive: true });
// The runtime's dependencies come from the `core` package installed above rather
// than from a second `npm ci` here. A second install would need a lock file
// matching this package's own manifest — the adapter declares peer dependencies
// on host packages, so it cannot borrow the root lock — and the two copies would
// be identical anyway.
//
// `package.json` is deliberately left exactly as the source has it: this script
// verifies that every copied file matches its source, and a manifest rewritten on
// the way out would break that check for no gain, since Node resolves these
// imports from `node_modules` beside them.
cpSync(join(out, 'core', 'node_modules'), join(out, 'dsh-plugin', 'node_modules'), { recursive: true });
// The Electron console is retired and is deliberately not an artifact input. The
// product has exactly two surfaces: the Tauri desktop app and the DSH native
// panel. Its source is kept, not shipped, at `console.archived-electron/`; see
// docs/implementation/electron-deprecation.md. Re-adding a `console` tree here
// would reinstate a third surface that no longer has an owner.
cpSync(join(root, 'fixtures/p0-seed.json'), join(out, 'p0-seed.json'));
const marketplace = { name: 'amb-local', interface: { displayName: 'Agent Memory Backpack P0 Local' }, plugins: [
  { name: 'agent-memory-backpack', source: { source: 'local', path: './codex-plugin' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' },
] };
// Marketplace schema is verified separately before use in a desktop.
mkdirSync(join(out, '.agents/plugins'), { recursive: true });
writeFileSync(join(out, '.agents/plugins/marketplace.json'), JSON.stringify(marketplace, null, 2));
const hashFile = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const inventory = {};
const addTree = (base, folder) => {
  const full = join(base, folder);
  for (const entry of readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = join(full, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') addTree(base, relative(base, child));
    } else if (entry.isFile() && !/(^|[\\/])(?:client\.json|core\.json|\.env(?:\.|$))$/i.test(relative(base, child))) {
      inventory[relative(out, child).split(sep).join('/')] = hashFile(child);
    }
  }
};
for (const folder of ['core', 'codex-plugin', 'dsh-plugin']) addTree(out, folder);
for (const path of ['.agents/plugins/marketplace.json', 'p0-seed.json']) inventory[path] = hashFile(join(out, path));
const sourceInventory = {};
const addSourceTree = folder => {
  const full = join(root, folder);
  for (const entry of readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = join(full, entry.name);
    if (entry.isDirectory()) addSourceTree(relative(root, child));
    else if (entry.isFile()) sourceInventory[relative(root, child).split(sep).join('/')] = hashFile(child);
  }
};
for (const folder of ['dist/src', 'adapters/codex', 'adapters/dsh']) addSourceTree(folder);
const copiedPairs = [
  ['dist/src', 'core/runtime'], ['dist/src', 'codex-plugin/runtime'],
  ['adapters/codex', 'codex-plugin'], ['adapters/dsh', 'dsh-plugin'],
];
for (const [sourceDir, artifactDir] of copiedPairs) {
  const sourceBase = join(root, sourceDir);
  const artifactBase = join(out, artifactDir);
  const verify = folder => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const sourcePath = join(folder, entry.name);
      const suffix = relative(sourceBase, sourcePath);
      const artifactPath = join(artifactBase, suffix);
      if (entry.isDirectory()) verify(sourcePath);
      else if (entry.isFile() && (!existsSync(artifactPath) || hashFile(sourcePath) !== hashFile(artifactPath))) {
        throw new Error(`Packaged file differs from source: ${relative(root, sourcePath)}`);
      }
    }
  };
  verify(sourceBase);
}
// Syntax check gate: verify all emitted .js and .mjs files with node --check.
// Never ship a package containing syntax errors (e.g. invalid regex flags in client scripts).
const syntaxCheck = dir => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') syntaxCheck(full);
    } else if (entry.isFile() && /\.(?:c?js|mjs)$/i.test(entry.name)) {
      const res = spawnSync(process.execPath, ['--check', full], { windowsHide: true });
      if (res.status !== 0) {
        const err = res.stderr?.toString() || res.stdout?.toString() || `Exit code ${res.status}`;
        throw new Error(`Syntax verification failed for packaged script ${relative(out, full)}: ${err.trim()}`);
      }
    }
  }
};
for (const folder of ['core', 'codex-plugin', 'dsh-plugin']) syntaxCheck(join(out, folder));

// The release scripts themselves are never inside a packaged tree, so the gate
// above cannot see them, yet they are the scripts that produce and verify a
// release. A syntax error here escapes the artifact check entirely and is only
// discovered when the release is already half-run, so they are parsed with the
// same `node --check`. The list is fixed rather than globbed: it names the
// scripts a release actually depends on, including the two that package.json
// points at for local install and uninstall.
const releaseScripts = [
  'scripts/package.mjs',
  'scripts/desktop-accept.mjs',
  'scripts/deploy-plugin.mjs',
  'scripts/amb-install.mjs',
  'scripts/amb-uninstall.mjs',
];
for (const releaseScript of releaseScripts) {
  const file = join(root, releaseScript);
  if (!existsSync(file)) continue;
  const res = spawnSync(process.execPath, ['--check', file], { windowsHide: true });
  if (res.status !== 0) {
    const err = res.stderr?.toString() || res.stdout?.toString() || `Exit code ${res.status}`;
    throw new Error(`Syntax verification failed for release script ${releaseScript}: ${err.trim()}`);
  }
}

const build = {
  git: gitBuildIdentity(),
  node: process.version,
  packageVersion: manifest.version,
  packagedAt: new Date().toISOString(),
};

writeFileSync(join(out, 'artifact-manifest.json'), JSON.stringify({
  format: 'agent-memory-backpack-artifact-hashes-v1', packageVersion: manifest.version,
  sourceFiles: sourceInventory, artifactFiles: inventory,
  copiedTreesVerified: copiedPairs.map(([source, artifact]) => ({ source, artifact })),
  build,
}, null, 2));
writeFileSync(join(root, 'artifacts/latest.json'), JSON.stringify({ directory: out, phase: 'P0', desktopVerified: false, build }, null, 2));
console.log(`Local artifacts: ${out}`);
console.log(`Relative artifact root: ${relative(root, out)}`);
