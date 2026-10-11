import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * What the gate can enforce when the core is unreachable.
 *
 * The behaviour these tests pin down is the fix for a real lockout: the gate used
 * to deny every tool call whenever the core was down, so an optional knowledge
 * service became a single point of failure and the user had to disable the plugin
 * to keep working. The design names three modes and requires visible degradation
 * instead of a halt, so the cases below are about which mode applies and what it
 * does — not merely that a snapshot file round-trips.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dshModule = join(repoRoot, 'adapters/dsh/gate-cache.mjs');
const codexModule = join(repoRoot, 'adapters/codex/scripts/gate-cache.mjs');
const load = (path: string) => import(pathToFileURL(path).href);

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'amb-gate-cache-'));
  dirs.push(dir);
  return dir;
}
process.on('exit', () => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

test('每个适配器包里都有一份逐字相同的模式实现', () => {
  assert.equal(sha(readFileSync(dshModule, 'utf8')), sha(readFileSync(codexModule, 'utf8')),
    '两份 gate-cache.mjs 必须完全相同，否则两端会以不同方式降级');
});

test('核心不可达且从未应答过：模式是 Ungoverned，且不阻断任何调用', async () => {
  const { loadSnapshot, operatingMode, decideFromSnapshot } = await load(dshModule);
  const dir = tempDir();
  const snapshot = loadSnapshot(dir);
  assert.equal(snapshot.state, 'absent', '没有快照');

  const { mode, detail } = operatingMode({ coreReachable: false, snapshot });
  assert.equal(mode, 'Ungoverned', '从未应答过就是未受约束，不得谎称受约束');
  assert.match(detail, /从未|不受约束/, '说明必须让人看懂当前不受规则约束');

  // The point of the mode: nothing is blocked. This is the lockout that was fixed.
  assert.equal(decideFromSnapshot(undefined, 'read'), 'allow');
  assert.equal(decideFromSnapshot(undefined, 'pwsh'), 'allow');
});

test('核心不可达但有快照：禁止项仍被执行，其余放行', async () => {
  const { saveSnapshot, loadSnapshot, operatingMode, decideFromSnapshot } = await load(dshModule);
  const dir = tempDir();
  saveSnapshot(dir, { deniedTools: ['Bash', 'amb_p0_blocked'], revision: 7, at: Date.now() });

  const snapshot = loadSnapshot(dir);
  assert.equal(snapshot.state, 'usable');
  const { mode } = operatingMode({ coreReachable: false, snapshot });
  assert.equal(mode, 'ReadOnlySnapshot', '有可用快照时应按快照执行，而不是完全放手');

  // Recorded prohibitions survive the process going away; that is what stops
  // "kill the core" from being a way to shed policy.
  assert.equal(decideFromSnapshot(snapshot.record, 'Bash'), 'deny');
  assert.equal(decideFromSnapshot(snapshot.record, 'amb_p0_blocked'), 'deny');
  // Case and surrounding space are normalised the same way the core does.
  assert.equal(decideFromSnapshot(snapshot.record, '  bash '), 'deny');
  // Everything else proceeds: a degraded gate is not a halt.
  assert.equal(decideFromSnapshot(snapshot.record, 'read'), 'allow');
  assert.equal(decideFromSnapshot(snapshot.record, 'grep'), 'allow');
});

test('快照保存的是最新一次，而不是第一次', async () => {
  const { saveSnapshot, loadSnapshot } = await load(dshModule);
  const dir = tempDir();
  saveSnapshot(dir, { deniedTools: ['old-tool'], revision: 1, at: 1000 });
  // A norm added later must be reflected, or the cached policy would enforce a
  // stale set of prohibitions.
  saveSnapshot(dir, { deniedTools: ['new-tool'], revision: 2, at: 2000 });
  const snapshot = loadSnapshot(dir, 2000);
  assert.deepEqual(snapshot.record.deniedTools, ['new-tool']);
  assert.equal(snapshot.record.revision, 2);
});

test('过期的快照降级为 Ungoverned，而不是继续执行旧规则', async () => {
  const { saveSnapshot, loadSnapshot, operatingMode } = await load(dshModule);
  const dir = tempDir();
  const now = 1_700_000_000_000;
  saveSnapshot(dir, { deniedTools: ['Bash'], revision: 3, at: now });
  // Far beyond the usable window: an old prohibition may no longer be current, so
  // enforcing it would be imposing a rule nobody has confirmed.
  const old = loadSnapshot(dir, now + 400 * 86_400_000);
  assert.equal(old.state, 'expired');
  assert.equal(operatingMode({ coreReachable: false, snapshot: old }).mode, 'Ungoverned');
  assert.match(operatingMode({ coreReachable: false, snapshot: old }).detail, /过期/);
});

test('损坏的快照被报为不可读，且不谎称受约束', async () => {
  const { loadSnapshot, operatingMode } = await load(dshModule);
  const dir = tempDir();
  writeFileSync(join(dir, 'gate-snapshot.json'), 'not json', 'utf8');
  const snapshot = loadSnapshot(dir);
  assert.equal(snapshot.state, 'unreadable', '坏快照应单独一类');
  const { mode, detail } = operatingMode({ coreReachable: false, snapshot });
  assert.equal(mode, 'Ungoverned');
  assert.match(detail, /无法读取/, '必须说明原因');
});

test('核心可达时模式恒为 Managed，不看快照', async () => {
  const { operatingMode, loadSnapshot } = await load(dshModule);
  const dir = tempDir();
  // Even with no snapshot at all: if the core answers, its decision governs.
  assert.equal(operatingMode({ coreReachable: true, snapshot: loadSnapshot(dir) }).mode, 'Managed');
});

test('写不进去不抛错：快照失败只降低新鲜度，不影响正在成功的调用', async () => {
  const { saveSnapshot } = await load(dshModule);
  // A path that cannot be a directory, so mkdir fails.
  const result = saveSnapshot('\0invalid', { deniedTools: [], revision: 0, at: 0 });
  assert.equal(result.saved, false, '应报告保存失败');
  assert.equal(typeof result.detail, 'string', '并给出原因');
  // No throw: a gate that succeeded must not be turned into a failure by logging.
});

test('快照文件落在适配器日志所在的同一个数据目录', async () => {
  const { snapshotPath } = await load(dshModule);
  const dir = tempDir();
  assert.equal(snapshotPath(dir), join(dir, 'gate-snapshot.json'));
  assert.equal(existsSync(join(dir, 'gate-snapshot.json')), false, '未保存前不应存在');
});
