/**
 * The deploy step must report what actually happened.
 *
 * Two defects meet here, and they are mirror images of the same mistake — the reported
 * signal not describing reality.
 *
 * The audit's O05 was a false positive: the reported value was
 * `activated || Array.isArray(bundles)`, which is true for any profile that merely *has* a
 * bundles list, so a deploy that failed to add this package still printed `active=true`
 * and could exit 0. A user would read that as "enabled" when it was not.
 *
 * The external report then recorded the opposite: a **first** deploy printed
 * `active=false` and exited 1, while a second run exited 0. The value had been captured
 * before the manifest was written and was then used to judge the result, so the run that
 * did the work was the one that reported failure. That teaches a user to ignore the exit
 * code — and the exit code is the only signal an unattended install has.
 *
 * The script is therefore run against throwaway profiles and judged by its exit code and
 * output, rather than by matching its source. Matching text is what let the previous check
 * pass while the behaviour was wrong, and then fail when the text changed.
 *
 * Skipped when no artifact has been built, so a bare checkout is not made to fail.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/**
 * The repository root, found rather than assumed.
 *
 * This file runs from `test/` while its TypeScript siblings are compiled into
 * `dist/test/`, so the number of levels to climb differs by one depending on which kind
 * of test is asking. Hard-coding either makes this test silently skip — which is how a
 * "passing" suite can contain a test that never runs.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = [resolve(here, '..'), resolve(here, '..', '..')].find(candidate =>
  existsSync(join(candidate, 'scripts', 'deploy-plugin.mjs'))) ?? resolve(here, '..');
// Overridable so the test can be pointed at a deliberately broken copy, which is how it
// was confirmed to fail on the defect it describes rather than merely pass on the fix.
const script = process.env.AMB_DEPLOY_SCRIPT ?? join(repoRoot, 'scripts', 'deploy-plugin.mjs');
const latest = join(repoRoot, 'artifacts', 'latest.json');
const PACKAGE = 'dsh-agent-memory-backpack';

/** Build a fake DSH home whose single profile declares the package but may not be active. */
function fakeHome({ active = false, bundlesList = true, realDirAtLink = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'amb-deploy-'));
  const profile = join(home, 'profiles', 'p1');
  mkdirSync(join(profile, 'node_modules'), { recursive: true });
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'p1',
    dependencies: { [PACKAGE]: `link:${join(home, 'deployed')}` },
    ...(bundlesList ? { dsh: { profile: { bundles: active ? [PACKAGE] : [] } } } : {}),
  }, null, 2), 'utf8');
  if (realDirAtLink) mkdirSync(join(profile, 'node_modules', PACKAGE), { recursive: true });
  return home;
}

/** Run the deploy script against a fake home, and report what it did. */
function deploy(home) {
  const run = spawnSync(process.execPath, [script], {
    encoding: 'utf8', windowsHide: true, cwd: repoRoot,
    env: { ...process.env, DSH_HOME: home, AMB_PLUGIN_DIR: join(home, 'deployed') },
  });
  const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'p1', 'package.json'), 'utf8'));
  return {
    status: run.status,
    output: `${run.stdout}${run.stderr}`,
    bundles: manifest.dsh?.profile?.bundles ?? null,
  };
}

const ready = existsSync(script) && existsSync(latest);
const skip = ready ? false : 'no artifact built yet (run npm run pack:local)';

test('首次部署（此前未激活）成功退出，且报告与它刚做的事一致', { skip }, () => {
  const home = fakeHome({ active: false });
  try {
    const first = deploy(home);
    assert.equal(first.status, 0, `首次部署应成功退出，实际 ${first.status}：${first.output}`);
    assert.ok(
      Array.isArray(first.bundles) && first.bundles.includes(PACKAGE),
      `部署后清单里必须真的出现本插件，实际 bundles=${JSON.stringify(first.bundles)}`,
    );
    assert.match(first.output, /active=true/, '本次部署确实激活了，报告值就不能是 false');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('重复部署幂等：成功、不重复添加', { skip }, () => {
  const home = fakeHome({ active: false });
  try {
    const first = deploy(home);
    const second = deploy(home);
    assert.equal(second.status, 0, `第二次部署应成功，实际 ${second.status}`);
    assert.deepEqual(second.bundles, first.bundles, '重复部署不得改变 bundles 内容');
    assert.equal(second.bundles.filter(item => item === PACKAGE).length, 1, '不得重复添加同一条目');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('链接位置是真实目录时拒绝替换，并以非零退出（不得谎报成功）', { skip }, () => {
  const home = fakeHome({ realDirAtLink: true });
  try {
    const run = deploy(home);
    assert.notEqual(run.status, 0, '无法建立链接时必须以非零退出');
    assert.match(run.output, /real directory|refusing/i, '拒绝的理由必须写清楚');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('profile 没有 bundles 列表时不算失败，也不得报告 active=true', { skip }, () => {
  const home = fakeHome({ bundlesList: false });
  try {
    const run = deploy(home);
    // Nothing to activate there, so it is not a failure — but claiming `active=true`
    // would be the original O05 false positive, and claiming `false` would read as a
    // failure that never happened.
    assert.equal(run.status, 0, `没有 bundles 列表不应计为失败，实际 ${run.status}`);
    assert.doesNotMatch(run.output, /active=true/, '没有 bundles 列表就不能声称已激活');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('部署确实建立链接，且哨兵文件可经链接读到', { skip }, () => {
  const home = fakeHome({ active: false });
  try {
    deploy(home);
    const link = join(home, 'profiles', 'p1', 'node_modules', PACKAGE);
    const stat = lstatSync(link, { throwIfNoEntry: false });
    assert.ok(stat, '部署必须真的建立链接，否则宿主加载不到');
    assert.ok(stat.isSymbolicLink(), '链接位置必须是符号链接/junction');
    // Verified by reading through the link rather than trusting the call that made it.
    assert.ok(existsSync(join(link, 'ensure-core.mjs')), '经链接必须能读到哨兵文件');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
