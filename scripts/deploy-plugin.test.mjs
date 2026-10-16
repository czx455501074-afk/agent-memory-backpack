import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, lstatSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = [resolve(here, '..'), resolve(here, '..', '..')].find(candidate =>
  existsSync(join(candidate, 'scripts', 'deploy-plugin.mjs'))) ?? resolve(here, '..');
const script = process.env.AMB_DEPLOY_SCRIPT ?? join(repoRoot, 'scripts', 'deploy-plugin.mjs');
const latest = join(repoRoot, 'artifacts', 'latest.json');
const artifactRoot = existsSync(latest) ? JSON.parse(readFileSync(latest, 'utf8')).directory : '';
const PACKAGE = 'dsh-agent-memory-backpack';
const fixtureTarget = join(repoRoot, `.amb-deploy-test-target-${process.pid}`);

function fakeHome({ active = false, bundlesList = true, realDirAtLink = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'amb-deploy-'));
  const profile = join(home, 'profiles', 'p1');
  mkdirSync(join(profile, 'node_modules'), { recursive: true });
  mkdirSync(dirname(fixtureTarget), { recursive: true });
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'p1',
    dependencies: { [PACKAGE]: `link:${fixtureTarget}` },
    ...(bundlesList ? { dsh: { profile: { bundles: active ? [PACKAGE] : [] } } } : {}),
  }, null, 2), 'utf8');
  if (realDirAtLink) mkdirSync(join(profile, 'node_modules', PACKAGE), { recursive: true });
  return home;
}

function deploy(home, extraEnv = {}) {
  const run = spawnSync(process.execPath, [script], {
    encoding: 'utf8', windowsHide: true, cwd: repoRoot,
    env: { ...process.env, DSH_HOME: home, AMB_PLUGIN_DIR: fixtureTarget, ...extraEnv },
  });
  const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'p1', 'package.json'), 'utf8'));
  return { status: run.status, output: `${run.stdout}${run.stderr}`, bundles: manifest.dsh?.profile?.bundles ?? null };
}

const ready = existsSync(script) && existsSync(latest);
const skip = ready ? false : 'no artifact built yet (run npm run pack:local)';

test('首次部署后清单、激活状态和链接一致', { skip }, () => {
  const home = fakeHome();
  try {
    const result = deploy(home);
    assert.equal(result.status, 0, result.output);
    assert.ok(result.bundles.includes(PACKAGE));
    assert.match(result.output, /active=true/);
    const link = join(home, 'profiles', 'p1', 'node_modules', PACKAGE);
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.ok(existsSync(join(link, 'ensure-core.mjs')));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('重复部署幂等', { skip }, () => {
  const home = fakeHome();
  try {
    const first = deploy(home);
    const second = deploy(home);
    assert.equal(second.status, 0, second.output);
    assert.deepEqual(second.bundles, first.bundles);
    assert.equal(second.bundles.filter(item => item === PACKAGE).length, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('dry-run 完成预检但不改清单、链接或目标文件', { skip }, () => {
  const home = fakeHome();
  try {
    const manifestPath = join(home, 'profiles', 'p1', 'package.json');
    const beforeManifest = readFileSync(manifestPath, 'utf8');
    const result = spawnSync(process.execPath, [script, '--dry-run'], {
      encoding: 'utf8', windowsHide: true, cwd: repoRoot,
      env: { ...process.env, DSH_HOME: home, AMB_PLUGIN_DIR: fixtureTarget },
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /Dry run complete/);
    assert.equal(readFileSync(manifestPath, 'utf8'), beforeManifest);
    assert.equal(existsSync(join(fixtureTarget, 'ensure-core.mjs')), true);
    assert.equal(existsSync(join(home, 'profiles', 'p1', 'node_modules', PACKAGE)), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('部分提交失败时恢复清单、链接与既有目标目录', { skip }, () => {
  const home = fakeHome();
  const target = fixtureTarget;
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'old.txt'), 'old-plugin');
  try {
    const manifestPath = join(home, 'profiles', 'p1', 'package.json');
    const beforeManifest = readFileSync(manifestPath, 'utf8');
    const result = deploy(home, { AMB_DEPLOY_FAIL_AT: '4' });
    assert.notEqual(result.status, 0, result.output);
    assert.equal(readFileSync(manifestPath, 'utf8'), beforeManifest);
    assert.equal(readFileSync(join(target, 'old.txt'), 'utf8'), 'old-plugin');
    assert.equal(existsSync(join(target, 'ensure-core.mjs')), true);
    assert.equal(existsSync(join(home, 'profiles', 'p1', 'node_modules', PACKAGE)), false);
    assert.deepEqual(readdirSync(home).sort(), ['profiles']);
    assert.deepEqual(readdirSync(target).filter(name => name !== 'old.txt').sort(), readdirSync(join(artifactRoot, 'dsh-plugin')).sort());
  } finally { rmSync(home, { recursive: true, force: true }); }
});


test('真实目录占据链接位置时拒绝替换', { skip }, () => {
  const home = fakeHome({ realDirAtLink: true });
  try {
    const result = deploy(home);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /real directory|refusing/i);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('没有 bundles 列表时不声称已激活', { skip }, () => {
  const home = fakeHome({ bundlesList: false });
  try {
    const result = deploy(home);
    assert.equal(result.status, 0, result.output);
    assert.doesNotMatch(result.output, /active=true/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
