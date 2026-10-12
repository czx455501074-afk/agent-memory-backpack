import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capabilityManifest, operatingModeFromDisk } from '../src/capabilities.js';
import { doctor } from '../src/doctor.js';

/**
 * The capability list and the operating mode.
 *
 * The design requires the two ends to be marked separately on what they can do, and
 * requires a shortfall to be *shown as a downgrade* rather than reported as full
 * support. That is the same discipline as the gate itself: a status surface that
 * overstates what is enforced is worse than none, because the user cannot tell
 * which of their protections are real.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'amb-capabilities-'));
  dirs.push(dir);
  return dir;
}
process.on('exit', () => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

test('两端分别列出，且已知的能力缺口如实标为不支持', () => {
  const manifest = capabilityManifest(tempDir());
  assert.equal(manifest.length, 2, '必须两端分别标记，不能合并成一份');
  assert.deepEqual(manifest.map(m => m.id).sort(), ['codex', 'dsh']);

  const codex = manifest.find(m => m.id === 'codex')!;
  // Codex hooks are one short-lived process per event, so there is nowhere to hold
  // "which task is this session doing". Reporting `yes` because the core has the API
  // would be exactly the overstatement this list exists to prevent.
  assert.equal(codex.capabilities.linkTask, 'no', 'codex 不支持任务关联，必须如实标注');

  const dsh = manifest.find(m => m.id === 'dsh')!;
  assert.equal(dsh.capabilities.linkTask, 'yes', 'dsh 能保存会话级任务关联');

  // Both adapters implement the same seven capabilities; the set must not drift.
  const expected = ['autoRetrieve', 'blockOperations', 'collectEvents', 'linkTask', 'notifyRuleChange', 'readNorms', 'submitCandidate'];
  for (const adapter of manifest) {
    assert.deepEqual(Object.keys(adapter.capabilities).sort(), expected, `${adapter.id} 的能力集合应与设计一致`);
  }
});

test('每端都附上它自己的边界说明，而不是共用一个', () => {
  const manifest = capabilityManifest(tempDir());
  const dsh = manifest.find(m => m.id === 'dsh')!;
  const codex = manifest.find(m => m.id === 'codex')!;
  assert.ok(dsh.notes.some(note => /别名归并|范围隔离/.test(note)), 'dsh 必须说明工具名不做别名归并');
  assert.ok(codex.notes.some(note => /任务关联/.test(note)), 'codex 必须说明任务关联的限制');
  assert.notDeepEqual(dsh.notes, codex.notes, '两端的边界不同，不得共用同一份说明');
});

test('运行模式从磁盘推导：无快照即未受约束，有快照即只读执行', () => {
  const dir = tempDir();
  // No snapshot and no core: nothing was ever recorded, so nothing is claimed.
  const ungoverned = operatingModeFromDisk(dir, false);
  assert.equal(ungoverned.mode, 'Ungoverned');
  assert.match(ungoverned.detail, /从未|不受规则约束/, '必须说明当前不受约束');

  // A usable snapshot means recorded prohibitions still apply.
  writeFileSync(join(dir, 'gate-snapshot.json'),
    JSON.stringify({ deniedTools: ['Bash', 'amb_p0_blocked'], revision: 5, at: Date.now() }), 'utf8');
  const snapshotMode = operatingModeFromDisk(dir, false);
  assert.equal(snapshotMode.mode, 'ReadOnlySnapshot');
  assert.match(snapshotMode.detail, /2 条/, '必须报出仍在执行的禁止项数量');

  // Reachable core overrides the snapshot entirely.
  assert.equal(operatingModeFromDisk(dir, true).mode, 'Managed');

  // An expired snapshot degrades rather than enforcing a stale rule.
  writeFileSync(join(dir, 'gate-snapshot.json'),
    JSON.stringify({ deniedTools: ['Bash'], revision: 5, at: 1 }), 'utf8');
  assert.equal(operatingModeFromDisk(dir, false).mode, 'Ungoverned');

  // A corrupt one does too, and says why.
  writeFileSync(join(dir, 'gate-snapshot.json'), 'broken', 'utf8');
  const broken = operatingModeFromDisk(dir, false);
  assert.equal(broken.mode, 'Ungoverned');
  assert.match(broken.detail, /无法读取/);
});

test('自检把运行模式与能力清单都列出来，且缺口不标为通过', async () => {
  const dir = tempDir();
  const report = await doctor({ dataDir: dir, offline: true });

  const mode = report.checks.find(check => check.id === 'operating-mode');
  assert.ok(mode, '自检必须报告运行模式：它决定规则是否真的在被执行');
  assert.notEqual(mode!.status, 'pass', '核心不可达时模式不是 pass');
  assert.match(mode!.detail, /Ungoverned|ReadOnlySnapshot/, '必须写明具体模式');
  assert.ok(mode!.hint, '必须给出恢复 Managed 的做法');

  // One entry per adapter, so a reader can tell which end is short.
  for (const id of ['dsh', 'codex']) {
    const entry = report.checks.find(check => check.id === `capability-${id}`);
    assert.ok(entry, `必须为 ${id} 单独列一条`);
  }
  const codexEntry = report.checks.find(check => check.id === 'capability-codex')!;
  assert.equal(codexEntry.status, 'warn', 'codex 有已知缺口，不得标为通过');
  assert.match(codexEntry.detail, /linkTask/, '必须点名缺哪一项');
});

test('核心侧与适配器侧对快照文件名的约定一致', () => {
  // The core cannot import from a package the host installs, so the name is written
  // in two places. A drift would mean the core reports a mode based on a file the
  // adapter never writes.
  const adapterSource = readFileSync(join(repoRoot, 'adapters/dsh/gate-cache.mjs'), 'utf8');
  const coreSource = readFileSync(join(repoRoot, 'src/capabilities.ts'), 'utf8');
  const name = /'gate-snapshot\.json'/;
  assert.match(adapterSource, name, '适配器侧应使用该文件名');
  assert.match(coreSource, name, '核心侧应使用同一文件名');
});

/**
 * Installation detection must describe the profile that would actually load the
 * plugin, and must not be fooled by a leftover link.
 *
 * Found on a real machine rather than in the audit: the user uninstalled the plugin
 * from the `desktop` profile, which removed the dependency and the bundle entry but
 * left the `node_modules` junction in place. The candidate list was hardcoded to
 * `profiles/desktop/node_modules/dsh-agent-memory-backpack`, so the report answered
 * "installed" from that stale link — while the profiles that did declare and load
 * the plugin (`headless`, `web`) were never examined.
 *
 * Both halves are checked here: a declared profile is found, and a bare link is
 * reported as a leftover rather than as an installation.
 */
test('安装判定以会加载插件的 profile 为准，且残留链接如实报出', () => {
  const home = tempDir();
  const profiles = join(home, '.dsh', 'profiles');

  /** A profile directory that links the package; `declares` controls the manifest. */
  const makeProfile = (name: string, declares: boolean) => {
    const dir = join(profiles, name);
    mkdirSync(join(dir, 'node_modules', 'dsh-agent-memory-backpack'), { recursive: true });
    writeFileSync(
      join(dir, 'node_modules', 'dsh-agent-memory-backpack', 'package.json'),
      JSON.stringify({ name: 'dsh-agent-memory-backpack', version: '9.9.9' }),
      'utf8',
    );
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify(declares
        ? { name: `profile-${name}`, dependencies: { 'dsh-agent-memory-backpack': 'link:../x' }, dsh: { profile: { bundles: ['dsh-agent-memory-backpack'] } } }
        : { name: `profile-${name}`, dependencies: {}, dsh: { profile: { bundles: [] } } }),
      'utf8',
    );
    return dir;
  };

  // The order mirrors the real machine: the leftover sorts before the real one, so a
  // scan that stops at the first hit would report the placeholder profile.
  makeProfile('aaa-leftover', false);
  makeProfile('zzz-active', true);

  const dsh = capabilityManifest(home).find(m => m.id === 'dsh')!;
  assert.equal(dsh.installed, true, '有 profile 声明时才算已安装');
  assert.match(String(dsh.location), /zzz-active/, '必须指向真正声明了插件的 profile，而不是残留目录');
  assert.equal(dsh.version, '9.9.9');

  const leftoverNotes = dsh.notes.filter(note => note.includes('残留'));
  assert.equal(leftoverNotes.length, 1, '残留链接必须单独报出，不能静默');
  assert.match(leftoverNotes[0]!, /aaa-leftover/, '残留说明必须点名具体位置，用户才能清理');

  // Only a leftover, with nothing declaring the package: not an installation.
  const onlyLeftover = tempDir();
  mkdirSync(join(onlyLeftover, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-agent-memory-backpack'), { recursive: true });
  writeFileSync(
    join(onlyLeftover, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-agent-memory-backpack', 'package.json'),
    JSON.stringify({ name: 'dsh-agent-memory-backpack', version: '1.0.0' }),
    'utf8',
  );
  writeFileSync(
    join(onlyLeftover, '.dsh', 'profiles', 'desktop', 'package.json'),
    JSON.stringify({ name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } }),
    'utf8',
  );
  const bare = capabilityManifest(onlyLeftover).find(m => m.id === 'dsh')!;
  assert.equal(bare.installed, false, '只有残留链接、没有声明时不得报告为已安装');
  assert.equal(bare.location, null);
  assert.ok(bare.notes.some(note => note.includes('残留')), '仍须告知用户该残留的存在');
});
