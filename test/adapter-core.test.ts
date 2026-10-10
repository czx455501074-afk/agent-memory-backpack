import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';

// Two levels up: this file compiles to dist/test/.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dshModule = join(repoRoot, 'adapters/dsh/ensure-core.mjs');
const codexModule = join(repoRoot, 'adapters/codex/scripts/ensure-core.mjs');
const cliEntry = join(repoRoot, 'dist/src/cli.js');

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** A free loopback port, so a run never collides with a service already up. */
async function freePort(): Promise<number> {
  return await new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      assert.ok(address && typeof address !== 'string');
      const { port } = address;
      probe.close(() => done(port));
    });
  });
}

/**
 * Kill whatever is listening on this port.
 *
 * The core is started detached on purpose — it must outlive the adapter that
 * started it, because the other desktop still needs it. That means the test has
 * no child handle to reap, so it finds the process by the port it holds. Without
 * this the suite would leak a core on every run and eventually fail on the port.
 */
async function killListener(port: number): Promise<void> {
  if (process.platform !== 'win32') {
    // Best effort elsewhere; the CI target for this project is Windows.
    spawn('sh', ['-c', `lsof -ti tcp:${port} | xargs -r kill`], { stdio: 'ignore' });
    return;
  }
  const find = spawn('powershell', ['-NoProfile', '-Command',
    `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess`],
    { windowsHide: true });
  let out = '';
  find.stdout.setEncoding('utf8');
  find.stdout.on('data', (chunk: string) => { out += chunk; });
  await new Promise<void>(done => find.once('close', () => done()));
  for (const pid of out.split(/\s+/).filter(Boolean)) {
    spawn('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore', windowsHide: true });
  }
  // Give the OS a moment to release the port before the next test binds.
  await new Promise<void>(done => setTimeout(done, 500));
}

/** Load a module by path, so the test reads the real shipped file. */
const load = (path: string) => import(pathToFileURL(path).href);

test('每个适配器包里都有一份逐字相同的核心启动实现', () => {
  const dsh = readFileSync(dshModule, 'utf8');
  const codex = readFileSync(codexModule, 'utf8');
  assert.equal(sha(dsh), sha(codex),
    'adapters/dsh/ensure-core.mjs 与 adapters/codex/scripts/ensure-core.mjs 必须完全相同');
});

test('未初始化时报告原因，而不是启动一个必然失败的核心', async () => {
  const { ensureCoreRunning } = await load(dshModule);
  const empty = mkdtempSync(join(tmpdir(), 'amb-no-init-'));
  try {
    // No core.json: `serve` would exit immediately, so spawning would only
    // produce a confusing timeout. The reason must name the real cause.
    const outcome = await ensureCoreRunning({
      endpoint: 'http://127.0.0.1:1', dataDir: empty, coreEntry: cliEntry,
    });
    assert.equal(outcome.started, false);
    assert.equal(outcome.reason, 'not-initialized');
    assert.equal(outcome.detail, empty, '必须回报是哪个数据目录未初始化');
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('缺少核心入口文件时报告缺失，而不是抛错', async () => {
  const { ensureCoreRunning } = await load(dshModule);
  const dir = mkdtempSync(join(tmpdir(), 'amb-no-entry-'));
  // Initialized, so the check reaches the entry-point step.
  writeFileSync(join(dir, 'core.json'), '{}');
  try {
    const outcome = await ensureCoreRunning({
      endpoint: 'http://127.0.0.1:1', dataDir: dir, coreEntry: join(dir, 'missing-cli.js'),
    });
    assert.equal(outcome.started, false);
    assert.equal(outcome.reason, 'core-entry-missing');
    assert.match(outcome.detail ?? '', /missing-cli\.js/, '必须点名缺失的文件');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('核心已在运行时什么都不做', async () => {
  const { ensureCoreRunning, coreIsRunning } = await load(dshModule);
  const port = await freePort();
  const endpoint = `http://127.0.0.1:${port}`;
  // A minimal healthy core: the probe only needs /health to answer 200.
  const server = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"protocolVersion":1,"status":"ok"}');
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>(done => server.listen(port, '127.0.0.1', () => done()));
  try {
    assert.equal(await coreIsRunning(endpoint), true, '健康端点应被识别为运行中');
    const outcome = await ensureCoreRunning({ endpoint, dataDir: tmpdir(), coreEntry: cliEntry });
    assert.equal(outcome.reason, 'already-running');
    assert.equal(outcome.started, false, '不应重复启动第二个核心');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
});

test('从零真实拉起一个核心并使其健康', async () => {
  const { ensureCoreRunning } = await load(dshModule);
  const dir = mkdtempSync(join(tmpdir(), 'amb-autostart-'));
  const port = await freePort();
  const dataDir = join(dir, 'data');

  // A real init, so the spawned core has a real core.json to serve.
  const init = spawn(process.execPath, [cliEntry, 'init', '--data-dir', dataDir,
    '--project', 'autostart', '--project-root', dir], { stdio: 'ignore', windowsHide: true });
  await new Promise<void>((done, fail) => {
    init.once('exit', code => (code === 0 ? done() : fail(new Error(`init exited ${code}`))));
    init.once('error', fail);
  });
  // The packaged core reads its port from core.json, so write the chosen one.
  const corePath = join(dataDir, 'core.json');
  const core = JSON.parse(readFileSync(corePath, 'utf8')) as { port: number };
  core.port = port;
  writeFileSync(corePath, JSON.stringify(core, null, 2), 'utf8');
  // `init` bakes the endpoint into each client file, so align those too.
  for (const name of ['dsh-client.json', 'codex-client.json', 'admin-client.json', 'client.json']) {
    const file = join(dataDir, name);
    if (!existsSync(file)) continue;
    const client = JSON.parse(readFileSync(file, 'utf8')) as { endpoint: string };
    client.endpoint = `http://127.0.0.1:${port}`;
    writeFileSync(file, JSON.stringify(client, null, 2), 'utf8');
  }

  try {
    const outcome = await ensureCoreRunning({
      endpoint: `http://127.0.0.1:${port}`, dataDir, coreEntry: cliEntry,
    });
    assert.equal(outcome.reason, 'started', `应成功拉起核心，实际 ${JSON.stringify(outcome)}`);
    assert.equal(outcome.started, true);

    // Prove it is a real core: ask for something only it can answer.
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200, '拉起的核心必须真的在服务');
    const body = await health.json() as { protocolVersion?: number };
    assert.equal(body.protocolVersion, 1, '必须是我们自己的核心，而不是碰巧占端口的进程');

    // Second call is a no-op: the property that stops two adapters racing.
    const again = await ensureCoreRunning({
      endpoint: `http://127.0.0.1:${port}`, dataDir, coreEntry: cliEntry,
    });
    assert.equal(again.reason, 'already-running', '已运行时不得再启动一个');
  } finally {
    // The core is started detached, so it must be reaped by port rather than by
    // a child handle the test never held.
    await killListener(port);
    rmSync(dir, { recursive: true, force: true });
  }
});
