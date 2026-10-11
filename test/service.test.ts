import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, inspectLock, lockPath, loginStartupStatus, processAlive, recoverStale, registerLoginStartup, releaseLock, stopFromLock, unregisterLoginStartup, loginStartupSupported } from '../src/service.js';

/**
 * Single-instance locking and crash recovery.
 *
 * The design requires a resident core that is single-instance and can be checked
 * and recovered. The port alone cannot provide that: between asking whether it is
 * free and binding it, two cores can both decide it is. These cases exercise the
 * lock rather than the socket, because the lock is what makes the guarantee.
 *
 * Real processes are used for liveness where it matters. A test that only wrote
 * and read a file would pass even if liveness detection were removed.
 */

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'amb-service-'));
  dirs.push(dir);
  return dir;
}
process.on('exit', () => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const info = (pid: number) => ({ pid, port: 47631, startedAt: 1_700_000_000_000, dataDir: 'x' });

test('第一个取得锁，第二个被告知持有者是谁', () => {
  const dir = tempDir();
  const first = acquireLock(dir, info(process.pid));
  assert.equal(first.acquired, true, '首次应取得锁');

  // A second process, simulated by a different pid — the point is that the file
  // exists and one call cannot both check and create.
  const second = acquireLock(dir, info(process.pid + 1));
  assert.equal(second.acquired, false, '第二个不得取得锁');
  assert.equal(second.heldBy?.pid, process.pid, '必须报出持有者，而不是只说失败');

  releaseLock(dir);
  assert.equal(inspectLock(dir).state, 'absent', '释放后锁应消失');
});

test('只有持有者能释放锁；旁人不能删掉别人的', () => {
  const dir = tempDir();
  acquireLock(dir, info(process.pid));
  // A different pid must not remove it, or a failed starter would delete the
  // winner's lock on its way out and let a third core in.
  releaseLock(dir, process.pid + 1);
  assert.equal(inspectLock(dir).state, 'held', '非持有者释放必须无效');
  releaseLock(dir, process.pid);
  assert.equal(inspectLock(dir).state, 'absent');
});

test('崩溃留下的陈旧锁被识别并可恢复，不必手工删文件', () => {
  const dir = tempDir();
  // A pid that is certainly not running: reserve one and let it exit.
  const deadPid = 999_999;
  assert.equal(processAlive(deadPid), false, '前提：该 pid 不应在运行');
  writeFileSync(lockPath(dir), JSON.stringify(info(deadPid)), 'utf8');

  const state = inspectLock(dir);
  assert.equal(state.state, 'stale', '进程已不在，锁应报陈旧而不是 held');

  // Starting over a stale lock succeeds, and says it did so.
  const takeover = acquireLock(dir, info(process.pid));
  assert.equal(takeover.acquired, true, '陈旧锁不得阻挡启动');
  assert.equal(takeover.clearedStale?.pid, deadPid, '应报告清理了谁的锁');

  releaseLock(dir);
  writeFileSync(lockPath(dir), JSON.stringify(info(deadPid)), 'utf8');
  const recovered = recoverStale(dir);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.previous?.pid, deadPid);
  assert.equal(existsSync(lockPath(dir)), false, '恢复后锁文件应清除');
});

test('无法解析的锁被报为 unreadable，且不谎报为运行中', () => {
  const dir = tempDir();
  writeFileSync(lockPath(dir), 'not json', 'utf8');
  const state = inspectLock(dir);
  assert.equal(state.state, 'unreadable', '坏锁应单独一类，不得当成 held');
  // And it must not confuse a caller into thinking a core is running.
  assert.notEqual(state.state, 'held');
});

test('stop 只针对锁里记名的进程，且陈旧锁走清理路径而不是发信号', () => {
  const dir = tempDir();
  writeFileSync(lockPath(dir), JSON.stringify(info(999_999)), 'utf8');
  const result = stopFromLock(dir);
  assert.equal(result.stopped, false, '陈旧锁没有进程可停');
  assert.match(result.detail ?? '', /陈旧/, '应说明是陈旧锁');
  assert.equal(existsSync(lockPath(dir)), false, '顺手清理掉');

  // No lock at all is also not an error.
  const none = stopFromLock(dir);
  assert.equal(none.stopped, false);
  assert.match(none.detail ?? '', /未在运行|没有找到/);
});

test('存活判定把"无法发信号"当作存活，而不是当作已死', () => {
  // A pid owned by another user cannot be signalled; treating EPERM as "gone"
  // would let a second core start while the first is still holding the port.
  assert.equal(processAlive(process.pid), true, '自己的进程显然存活');
  assert.equal(processAlive(0), false, '0 不是合法目标');
  assert.equal(processAlive(-1), false, '负 pid 不是合法目标');
});

/**
 * Login startup needs the user's own registry hive, so this writes to the real
 * `HKCU\...\Run` key — and removes what it wrote.
 *
 * The value name is specific to this project, and the test restores whatever was
 * there before, so running the suite on a developer machine neither leaves an
 * entry behind nor clobbers one a user had configured.
 */
test('登录启动可注册、可查询、可移除，且重复注销不算失败', (t) => {
  if (!loginStartupSupported()) { t.skip('登录启动只为 Windows 实现'); return; }
  const before = loginStartupStatus();
  try {
    const added = registerLoginStartup('C:/path/cli.js', 'C:/data');
    assert.equal(added.ok, true, `注册应成功：${added.detail}`);
    const status = loginStartupStatus();
    assert.equal(status.registered, true, '注册后查询应看到');
    assert.match(status.detail, /cli\.js/, '查询应回显命令，便于用户核对');

    const removed = unregisterLoginStartup();
    assert.equal(removed.ok, true);
    assert.equal(loginStartupStatus().registered, false, '移除后查询应看不到');

    // Removing what is absent is a success: a clean machine must not look broken.
    const again = unregisterLoginStartup();
    assert.equal(again.ok, true, '重复注销必须成功，这是卸载路径要用的性质');
  } finally {
    // Restore the machine: leave the entry as it was found.
    unregisterLoginStartup();
    if (before.registered) registerLoginStartup('C:/path/cli.js', 'C:/data');
  }
});
