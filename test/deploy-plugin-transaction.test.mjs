import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const script = join(repo, 'scripts', 'deploy-plugin.mjs');
const PACKAGE = 'dsh-agent-memory-backpack';

function fixture({ conflict = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'amb-deploy-transaction-'));
  const artifact = join(dir, 'artifact');
  const plugin = join(artifact, 'dsh-plugin');
  const core = join(artifact, 'core');
  const consoleDir = join(artifact, 'console');
  const home = join(dir, 'home');
  const profile = join(home, 'profiles', 'p1');
  const target = join(dir, 'plugins', 'amb-plugin');
  mkdirSync(plugin, { recursive: true });
  mkdirSync(join(core, 'runtime'), { recursive: true });
  mkdirSync(consoleDir, { recursive: true });
  mkdirSync(join(profile, 'node_modules'), { recursive: true });
  writeFileSync(join(plugin, 'client.js'), 'globalThis.fixture = true;');
  writeFileSync(join(plugin, 'ensure-core.mjs'), 'export {};');
  writeFileSync(join(core, 'runtime', 'client.js'), 'export {};');
  writeFileSync(join(consoleDir, 'main.cjs'), '');
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'p1', dependencies: { [PACKAGE]: 'link:old-target' }, dsh: { profile: { bundles: [PACKAGE] } },
  }, null, 2));
  mkdirSync(join(target, 'preserve'), { recursive: true });
  writeFileSync(join(target, 'old.txt'), 'old-plugin');
  writeFileSync(join(target, 'preserve', 'untouched.txt'), 'keep');
  mkdirSync(join(dir, 'plugins', 'core'), { recursive: true });
  writeFileSync(join(dir, 'plugins', 'core', 'old.txt'), 'old-core');
  mkdirSync(join(dir, 'plugins', 'console'), { recursive: true });
  writeFileSync(join(dir, 'plugins', 'console', 'old.txt'), 'old-console');
  const link = join(profile, 'node_modules', PACKAGE);
  if (conflict) mkdirSync(link);
  return { dir, artifact, home, profile, target, link, coreTarget: join(dir, 'plugins', 'core'), consoleTarget: join(dir, 'plugins', 'console') };
}

function run(fx, extraArgs = [], extraEnv = {}) {
  const result = spawnSync(process.execPath, [script, '--artifact', fx.artifact, '--target', fx.target, '--profiles', 'p1', ...extraArgs], {
    cwd: repo, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, DSH_HOME: fx.home, AMB_PLUGIN_DIR: fx.target, ...extraEnv },
  });
  if (result.error) {
    const details = `spawnSync failed (${result.error.code ?? 'unknown'}): ${result.error.message}\nstdout: ${result.stdout ?? ''}\nstderr: ${result.stderr ?? ''}`;
    throw Object.assign(new Error(details, { cause: result.error }), { spawnResult: result });
  }
  return result;
}

function snapshot(fx) {
  const manifest = readFileSync(join(fx.profile, 'package.json'));
  return {
    manifest: manifest.toString('base64'),
    plugin: readFileSync(join(fx.target, 'old.txt'), 'utf8'),
    preserve: readFileSync(join(fx.target, 'preserve', 'untouched.txt'), 'utf8'),
    core: readFileSync(join(fx.coreTarget, 'old.txt'), 'utf8'),
    console: readFileSync(join(fx.consoleTarget, 'old.txt'), 'utf8'),
    linkEntries: readdirSync(join(fx.profile, 'node_modules')),
    targetEntries: readdirSync(join(fx.dir, 'plugins')).sort(),
  };
}

test('dry-run 完成完整预检但不创建或修改任何部署目标', () => {
  const fx = fixture();
  try {
    const before = snapshot(fx);
    const result = run(fx, ['--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Dry run complete/);
    assert.deepEqual(snapshot(fx), before);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test('链接冲突在任何部署写入前被拒绝', () => {
  const fx = fixture({ conflict: true });
  try {
    const before = snapshot(fx);
    const result = run(fx, ['--dry-run']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /real directory|refusing to replace/i);
    assert.deepEqual(snapshot(fx), before);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test('提交中途故障恢复插件、core、console、manifest 与原有 junction', () => {
  const fx = fixture();
  try {
    const originalLinkTarget = fx.target;
    const oldLink = join(fx.profile, 'node_modules', PACKAGE);
    rmSync(oldLink, { recursive: true, force: true });
    mkdirSync(join(fx.dir, 'previous-plugin'), { recursive: true });
    writeFileSync(join(fx.dir, 'previous-plugin', 'old.txt'), 'previous-link-target');
    symlinkSync(join(fx.dir, 'previous-plugin'), oldLink, 'junction');
    const before = snapshot(fx);
    const failAt = '2';
    const result = run(fx, [], { AMB_DEPLOY_FAIL_AT: failAt });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Injected deployment failure/);
    assert.deepEqual(snapshot(fx), before);
    assert.equal(statSync(oldLink).isDirectory(), true);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});
