import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
  // the console and the diagnostics without knowing where the artifact put things.
  const packagedScripts = {
    start: 'node runtime/cli.js serve',
    doctor: 'node runtime/cli.js doctor',
    logs: 'node runtime/cli.js logs',
    console: 'electron console/main.cjs',
  };
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    ...manifest,
    scripts: target === 'codex-plugin' ? { ...packagedScripts, console: 'electron ../console/main.cjs' } : packagedScripts,
  }, null, 2));
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
// core runtime as well. Shipping only the adapter would let the plugin load and
// then fail every tool call with "core unavailable", which is the failure this
// project keeps having to apologise for.
//
// The packages stay separate rather than sharing one runtime copy because each
// is installed by a different host into a different tree; a relative path from
// one to the other does not survive either host's install step.
cpSync(join(root, 'adapters/dsh'), join(out, 'dsh-plugin'), { recursive: true });
cpSync(join(root, 'dist/src'), join(out, 'dsh-plugin/runtime'), { recursive: true });
{
  const dir = join(out, 'dsh-plugin');
  // The adapter package itself has no runtime dependencies; declaring the core's
  // means `npm ci` below has something to install.
  const dshManifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    ...dshManifest, dependencies: { ...manifest.dependencies },
  }, null, 2));
  cpSync(join(root, 'package-lock.json'), join(dir, 'package-lock.json'));
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !existsSync(npmCli) || !statSync(npmCli).isFile() || !npmCli.toLowerCase().endsWith('.js')) {
    throw new Error('Run packaging via npm run pack:local so npm_execpath identifies the npm CLI JavaScript file.');
  }
  const installed = spawnSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: dir, stdio: 'inherit', windowsHide: true,
  });
  if (installed.status !== 0) throw new Error('Runtime installation failed: dsh-plugin');
}
// The desktop console ships as source. It is an Electron app, so its runtime is
// the user's Electron rather than an npm dependency of the core; shipping the
// source keeps the artifact small and lets the console be updated independently.
cpSync(join(root, 'console'), join(out, 'console'), { recursive: true });
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
for (const folder of ['core', 'codex-plugin', 'dsh-plugin', 'console']) addTree(out, folder);
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
for (const folder of ['dist/src', 'adapters/codex', 'adapters/dsh', 'console']) addSourceTree(folder);
const copiedPairs = [
  ['dist/src', 'core/runtime'], ['dist/src', 'codex-plugin/runtime'],
  ['adapters/codex', 'codex-plugin'], ['adapters/dsh', 'dsh-plugin'],
  ['console', 'console'],
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
writeFileSync(join(out, 'artifact-manifest.json'), JSON.stringify({
  format: 'agent-memory-backpack-artifact-hashes-v1', packageVersion: manifest.version,
  sourceFiles: sourceInventory, artifactFiles: inventory,
  copiedTreesVerified: copiedPairs.map(([source, artifact]) => ({ source, artifact })),
}, null, 2));
writeFileSync(join(root, 'artifacts/latest.json'), JSON.stringify({ directory: out, phase: 'P0', desktopVerified: false }, null, 2));
console.log(`Local artifacts: ${out}`);
console.log(`Relative artifact root: ${relative(root, out)}`);
