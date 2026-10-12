/**
 * Credential resolution: a degraded resolution must always be visible.
 *
 * The design separates the two ends' credentials so each has its own identity — the
 * `admin`/`adapter` split is what makes "an agent may propose but must not approve its
 * own proposal" enforceable rather than advisory. A resolver that quietly answers with
 * a different adapter's file therefore does more than mislabel a path: it can change
 * which project and which role this end acts under, while every surface reports a
 * normal configuration.
 *
 * An older install wrote the Codex credential to a bare `client.json`, so the fallback
 * is kept for compatibility. What is checked here is that it is never *silent* — the
 * explicit-pointer case already warned, and this path warned about nothing.
 *
 * Each fixture moves the home rather than setting an `AMB_*` variable, because
 * `defaultDataDir()` is `join(homedir(), '.agent-memory-backpack')`; pointing at the
 * real home would read the operator's own credentials and answer a different question.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfigPath } from '../src/config.js';

const dirs: string[] = [];
const saved = {
  USERPROFILE: process.env.USERPROFILE,
  HOME: process.env.HOME,
  AMB_DSH_CONFIG: process.env.AMB_DSH_CONFIG,
  AMB_CONFIG: process.env.AMB_CONFIG,
};

/** A home whose data directory holds the named credential files. */
function homeWith(...files: string[]): string {
  const home = mkdtempSync(join(tmpdir(), 'amb-cfg-'));
  dirs.push(home);
  const dir = join(home, '.agent-memory-backpack');
  mkdirSync(dir, { recursive: true });
  for (const name of files) {
    writeFileSync(join(dir, name), JSON.stringify({
      endpoint: 'http://127.0.0.1:47631', token: 'x'.repeat(32), projectId: 'p', role: 'adapter',
    }), 'utf8');
  }
  return home;
}

/** Resolve both ends against `home` with no explicit pointers in the environment. */
function resolveBoth(home: string, adapter: 'dsh' | 'codex' = 'dsh') {
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  delete process.env.AMB_DSH_CONFIG;
  delete process.env.AMB_CONFIG;
  return resolveConfigPath(adapter, process.env);
}

test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test('两端各有自己的凭据时解析到各自文件，且无告警', () => {
  const home = homeWith('dsh-client.json', 'codex-client.json');
  const dsh = resolveBoth(home, 'dsh');
  const codex = resolveBoth(home, 'codex');
  assert.match(dsh.path, /dsh-client\.json$/);
  assert.match(codex.path, /codex-client\.json$/);
  assert.notEqual(dsh.path, codex.path, '两端必须解析到不同文件');
  assert.equal(dsh.warning, null, '正常解析不得产生告警');
  assert.equal(codex.warning, null);
});

test('缺专属凭据而采用遗留共用文件时，必须给出可见告警（不得静默）', () => {
  const home = homeWith('client.json');
  for (const adapter of ['dsh', 'codex'] as const) {
    const resolved = resolveBoth(home, adapter);
    assert.match(resolved.path, /client\.json$/, `${adapter} 会回退到遗留文件`);
    assert.ok(resolved.warning, `${adapter} 的回退必须可见，而不是静默使用他端凭据`);
    // The message has to be actionable and specific: which adapter, which file is
    // missing, and the risk it carries.
    assert.match(resolved.warning, new RegExp(`${adapter}-client\\.json`), '告警须点名缺失的专属文件');
    assert.match(resolved.warning, /other adapter|project or role/, '告警须说明可能以他端身份行事');
    assert.match(resolved.warning, /Run init/, '告警须给出可执行的补救');
  }
});

test('一端缺凭据而另一端存在时，缺的一方仍须告警', () => {
  // The shape a partly-broken install takes: Codex's dedicated file is there, DSH's
  // is not, and a legacy file is lying around. DSH must not adopt it quietly.
  const home = homeWith('codex-client.json', 'client.json');
  const dsh = resolveBoth(home, 'dsh');
  assert.match(dsh.path, /client\.json$/);
  assert.ok(dsh.warning, 'DSH 缺自己的凭据时不得静默采用遗留文件');

  // And the end that does have its own credential stays quiet.
  const codex = resolveBoth(home, 'codex');
  assert.match(codex.path, /codex-client\.json$/);
  assert.equal(codex.warning, null, '有专属凭据的一端不应被牵连告警');
});

test('显式指向不存在的文件时告警，并说明实际使用的文件', () => {
  const home = homeWith('dsh-client.json');
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  process.env.AMB_DSH_CONFIG = join(home, 'does-not-exist.json');
  const resolved = resolveConfigPath('dsh', process.env);
  assert.match(resolved.path, /dsh-client\.json$/, '应回退到专属文件');
  assert.ok(resolved.warning);
  assert.match(resolved.warning, /AMB_DSH_CONFIG/, '告警须点名是哪个变量');
  assert.match(resolved.warning, /does not exist/, '告警须说明原因');
});

test('显式指向存在的文件时直接采用，且无告警', () => {
  const home = homeWith('dsh-client.json');
  const explicit = join(home, 'custom.json');
  writeFileSync(explicit, JSON.stringify({
    endpoint: 'http://127.0.0.1:47631', token: 'y'.repeat(32), projectId: 'q', role: 'adapter',
  }), 'utf8');
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  process.env.AMB_DSH_CONFIG = explicit;
  const resolved = resolveConfigPath('dsh', process.env);
  assert.equal(resolved.path, explicit, '显式指定的文件应优先');
  assert.equal(resolved.warning, null);
});

test('什么都不存在时返回待创建的位置，且不谎报已有凭据', () => {
  const home = homeWith();
  const resolved = resolveBoth(home, 'dsh');
  assert.match(resolved.path, /dsh-client\.json$/, '应指向待创建的位置');
  assert.equal(resolved.warning, null, '没有可回退的文件时不应产生「正在回退」的告警');
});
