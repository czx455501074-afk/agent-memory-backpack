import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * `scripts/verify-host-deployment.mjs` answers one narrow question — is the running core
 * the deployed build — and it answered it wrongly for a whole class of changes: it took
 * the deployment time from `index.mjs` alone, while a package also carries a `runtime/`
 * copy of the core. A change confined to the core leaves the adapter file untouched, so
 * the script compared the core's start time against an old timestamp and reported
 * "RUNNING DEPLOYED BUILD" while the core predated the runtime it was supposed to be
 * running. Measured on the real deployment before the fix: index.mjs 2026-10-17T16:10Z,
 * runtime/store.js 2026-10-18T05:59Z, core started 05:04Z — old rule: deployed; truth:
 * previous build.
 *
 * Every case below drives the real script as a subprocess against a throwaway fixture, so
 * what is asserted is the verdict a person reads, not an internal helper.
 */

const script = fileURLToPath(new URL('../scripts/verify-host-deployment.mjs', import.meta.url));
// Two clocks with two units, and mixing them is exactly how a verdict test passes for the
// wrong reason: `utimesSync` takes seconds, `core.lock` stores milliseconds. Passing a
// seconds value as `startedAt` put the core in 1970, which made every case report
// "previous build" — including the one that expects it.
const OLD_S = 1_600_000_000;
const NEWER_S = OLD_S + 3_600;
const OLD_MS = OLD_S * 1_000;
const NEWER_MS = NEWER_S * 1_000;

function fixture({ adapterAt, runtimeAt, startedAt }) {
  const root = mkdtempSync(join(tmpdir(), 'amb-deploy-verdict-'));
  const profiles = join(root, 'profiles');
  const deploy = join(root, 'deploy');
  const data = join(root, 'data');
  mkdirSync(join(profiles, 'p1'), { recursive: true });
  mkdirSync(join(deploy, 'runtime'), { recursive: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(join(profiles, 'p1', 'package.json'), JSON.stringify({
    dependencies: { 'dsh-agent-memory-backpack': `link:${deploy}` },
    dsh: { profile: { bundles: ['dsh-agent-memory-backpack'] } },
  }));
  writeFileSync(join(deploy, 'index.mjs'), '// adapter entry\n');
  writeFileSync(join(deploy, 'client.js'), '// browser half\n');
  writeFileSync(join(deploy, 'runtime', 'store.js'), '// core\n');
  utimesSync(join(deploy, 'index.mjs'), adapterAt, adapterAt);
  utimesSync(join(deploy, 'client.js'), adapterAt, adapterAt);
  utimesSync(join(deploy, 'runtime', 'store.js'), runtimeAt, runtimeAt);
  writeFileSync(join(data, 'core.lock'), JSON.stringify({ startedAt }));
  return { root, profiles, data };
}

const run = (fx) => {
  const result = spawnSync(process.execPath,
    [script, '--profiles-dir', fx.profiles, '--data-dir', fx.data],
    { encoding: 'utf8', windowsHide: true });
  const [jsonPart] = result.stdout.split('\n\n结论: ');
  return { ...result, report: JSON.parse(jsonPart), verdict: (result.stdout.split('\n\n结论: ')[1] ?? '').split('\n')[0].trim() };
};

const cleanup = (fx) => rmSync(fx.root, { recursive: true, force: true });

test('适配器未变、核心已更新：必须判为上一版，而不是已部署', async t => {
  const fx = fixture({ adapterAt: OLD_S, runtimeAt: NEWER_S, startedAt: OLD_MS + 600_000 });
  t.after(() => cleanup(fx));
  const result = run(fx);
  assert.equal(result.verdict, 'RUNNING PREVIOUS BUILD',
    `核心启动早于 runtime 部署，必须判为上一版；实际 ${result.verdict}`);
  // The timestamp must come from the core copy, not the adapter: that distinction is the
  // whole fix. Asserting only the verdict would still pass if the file were chosen by luck.
  assert.match(result.report.deployedFile, /runtime[\\/]store\.js$/,
    `部署时间必须取自 runtime 文件，实际 ${result.report.deployedFile}`);
  assert.ok(result.report.deployedEntriesChecked >= 3,
    `必须检查多个入口（适配器与 runtime），实际 ${result.report.deployedEntriesChecked} 个`);
  assert.notEqual(result.status, 0, '判为上一版时退出码必须非零');
});

test('插件包与核心都已部署且核心更晚启动：判为已加载部署构建', async t => {
  const fx = fixture({ adapterAt: OLD_S, runtimeAt: OLD_S, startedAt: NEWER_MS });
  t.after(() => cleanup(fx));
  const result = run(fx);
  assert.equal(result.verdict, 'RUNNING DEPLOYED BUILD', `实际 ${result.verdict}`);
  assert.equal(result.status, 0, '判为已部署时退出码为零');
});

test('只有适配器变新、核心仍是旧的：同样判为上一版', async t => {
  const fx = fixture({ adapterAt: NEWER_S, runtimeAt: OLD_S, startedAt: OLD_MS + 600_000 });
  t.after(() => cleanup(fx));
  const result = run(fx);
  assert.equal(result.verdict, 'RUNNING PREVIOUS BUILD', `实际 ${result.verdict}`);
  assert.match(result.report.deployedFile, /index\.mjs$/, '此时最新文件就是适配器入口');
});

test('没有核心锁文件时报告“没有核心在跑”，而不是猜一个结论', async t => {
  const fx = fixture({ adapterAt: OLD_S, runtimeAt: NEWER_S, startedAt: OLD_MS });
  t.after(() => cleanup(fx));
  rmSync(join(fx.data, 'core.lock'), { force: true });
  const result = run(fx);
  assert.match(result.verdict, /NO CORE RUNNING/, `实际 ${result.verdict}`);
  assert.notEqual(result.status, 0);
  // The fixture must actually contain the entries the script reads, or the case would be
  // satisfied by an empty directory rather than by the lock being absent.
  assert.ok(readdirSync(join(fx.root, 'deploy')).includes('index.mjs'));
});
