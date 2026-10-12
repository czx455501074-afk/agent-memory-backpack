import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function runScript(args, env = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [resolve('scripts/amb-uninstall.mjs'), ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolveRun({ code, stdout, stderr }));
  });
}

test('BUG-H6 / W2 (b): 锁文件记录无关存活 PID 时，卸载脚本必须拒绝发信号且不清理数据目录', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'amb-unrelated-pid-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Start a synthetic loopback server answering /health as a valid AMB core
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ protocolVersion: 1, status: 'ok' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const port = server.address().port;

  // Fake an active AMB data directory
  const dataDir = join(dir, 'data');
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'core.json'), JSON.stringify({ endpoint: `http://127.0.0.1:${port}`, port }), 'utf8');
  await writeFile(join(dataDir, 'knowledge.sqlite'), 'sqlite-placeholder', 'utf8');

  // Spawn an unrelated dummy worker process (e.g. node -e "setInterval(()=>{}, 1000)")
  // This process is ALIVE, but does NOT own the port above!
  const dummyWorker = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  t.after(() => {
    try { dummyWorker.kill(); } catch {}
  });

  assert.ok(dummyWorker.pid, 'Dummy worker process must be alive');

  // Write the lock referencing dummyWorker.pid and the server port
  await writeFile(join(dataDir, 'core.lock'), JSON.stringify({
    pid: dummyWorker.pid,
    port,
    startedAt: Date.now(),
    dataDir,
  }), 'utf8');

  const isolatedDsh = join(dir, 'dsh');
  const isolatedPlugin = join(dir, 'plugin');

  // Run amb-uninstall with --purge-data --yes
  const result = await runScript(['--data-dir', dataDir, '--purge-data', '--yes'], {
    DSH_HOME: isolatedDsh,
    AMB_PLUGIN_DIR: isolatedPlugin,
  });

  // Verification:
  // 1. Script must exit with non-zero
  assert.notEqual(result.code, 0, '未确认归属的进程必须让卸载脚本失败退出');
  // 2. Error output must explain refusal to kill
  assert.match(result.stderr + result.stdout, /拒绝发信号|未通过验证|为防止误杀/);
  // 3. The dummy worker must STILL be alive (not killed!)
  let dummyStillAlive = false;
  try {
    process.kill(dummyWorker.pid, 0);
    dummyStillAlive = true;
  } catch {}
  assert.equal(dummyStillAlive, true, '严禁杀死不拥有该监听端口的无关存活进程！');
  // 4. The data directory must NOT have been purged
  assert.equal(existsSync(dataDir), true, '验证失败时不得清理数据目录');
  assert.equal(existsSync(join(dataDir, 'knowledge.sqlite')), true, '数据文件必须保持原样');
});

test('BUG-H6 / W2: 端口健康探测未响应时，同样必须拒绝发信号且不清理数据', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'amb-unverified-health-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const dataDir = join(dir, 'data');
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'core.json'), JSON.stringify({ port: 49876 }), 'utf8');
  await writeFile(join(dataDir, 'knowledge.sqlite'), 'sqlite-placeholder', 'utf8');

  // Alive dummy process
  const dummyWorker = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  t.after(() => {
    try { dummyWorker.kill(); } catch {}
  });

  // Lock points to dummy process on a port that does NOT answer AMB health
  await writeFile(join(dataDir, 'core.lock'), JSON.stringify({
    pid: dummyWorker.pid,
    port: 49876,
    startedAt: Date.now(),
    dataDir,
  }), 'utf8');

  const result = await runScript(['--data-dir', dataDir, '--purge-data', '--yes'], {
    DSH_HOME: join(dir, 'dsh'),
    AMB_PLUGIN_DIR: join(dir, 'plugin'),
  });

  assert.notEqual(result.code, 0, '健康未确认时必须非零退出');
  assert.match(result.stderr + result.stdout, /拒绝发信号|未通过验证|为防止误杀/);
  let alive = false;
  try { process.kill(dummyWorker.pid, 0); alive = true; } catch {}
  assert.equal(alive, true, '不得误杀存活进程');
  assert.equal(existsSync(dataDir), true, '未确认时不得删除数据目录');
});

test('BUG-H6 / W2 (c) & (d): 陈旧锁清理且重复卸载收敛', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'amb-stale-lock-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const dataDir = join(dir, 'data');
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'core.json'), JSON.stringify({ port: 47999 }), 'utf8');
  await writeFile(join(dataDir, 'knowledge.sqlite'), 'sqlite-data', 'utf8');

  // A stale pid that is definitely not running
  const deadPid = 9999999;
  await writeFile(join(dataDir, 'core.lock'), JSON.stringify({
    pid: deadPid,
    port: 47999,
    startedAt: Date.now() - 100000,
    dataDir,
  }), 'utf8');

  const isolatedDsh = join(dir, 'dsh');
  const isolatedPlugin = join(dir, 'plugin');

  // First run: cleans stale lock and purges data
  const first = await runScript(['--data-dir', dataDir, '--purge-data', '--yes'], {
    DSH_HOME: isolatedDsh,
    AMB_PLUGIN_DIR: isolatedPlugin,
  });
  assert.equal(first.code, 0, `第一次卸载应成功：${first.stderr}`);
  assert.equal(existsSync(dataDir), false, '数据目录应被完全删除');

  // Second run: idempotent convergence
  const second = await runScript(['--data-dir', dataDir, '--purge-data', '--yes'], {
    DSH_HOME: isolatedDsh,
    AMB_PLUGIN_DIR: isolatedPlugin,
  });
  assert.equal(second.code, 0, '重复卸载应幂等收敛退出 0');
  assert.match(second.stdout, /该目录不存在，无需卸载/);
});
