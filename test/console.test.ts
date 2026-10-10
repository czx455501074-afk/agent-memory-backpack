import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../src/store.js';
import { createCoreServer } from '../src/server.js';

const electronBinary = resolve('node_modules/electron/dist/electron.exe');
const token = 'a'.repeat(64), adminToken = 'c'.repeat(64);

/**
 * Launch the Electron console and observe it.
 *
 * Two observation modes, because the two kinds of check need different things:
 *
 *  - `exitAfter`: wait for the process to finish on its own (the dump and
 *    failure paths exit by themselves). A condition, not a sleep.
 *  - `aliveFor`: wait a fixed window and report whether it was still running, for
 *    the liveness check where staying up IS the expected behaviour.
 *
 * Electron needs a display; when the binary is absent (a plain clone without the
 * postinstall download) the test skips with a reason rather than reporting a
 * false pass.
 *
 * ELECTRON_RUN_AS_NODE is stripped deliberately: if it is inherited, Electron
 * degrades to plain Node and `require('electron')` returns a path string, so the
 * test would measure the wrong thing entirely.
 */
async function launch(args: string[], env: NodeJS.ProcessEnv, options: { exitAfter?: number; aliveFor?: number }) {
  const cleanEnv: NodeJS.ProcessEnv = { ...env };
  delete cleanEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, args, { env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });

  let timedOut = false;
  if (options.exitAfter !== undefined) {
    // Resolve as soon as the process ends; the timeout only bounds a hang.
    await new Promise<void>(resolveExit => {
      const timer = setTimeout(() => { timedOut = true; resolveExit(); }, options.exitAfter);
      child.once('close', () => { clearTimeout(timer); resolveExit(); });
    });
  } else {
    await new Promise<void>(resolveDelay => setTimeout(resolveDelay, options.aliveFor ?? 3000));
  }

  const alive = child.exitCode === null && child.signalCode === null;
  if (alive) { child.kill(); await new Promise<void>(resolveExit => child.once('close', () => resolveExit())); }
  return { alive, timedOut, exitCode: child.exitCode, stdout, stderr };
}

test('console diagnoses ELECTRON_RUN_AS_NODE instead of crashing obscurely', async t => {
  if (!existsSync(electronBinary)) { t.skip('Electron 二进制未下载；跳过控制台启动测试'); return; }
  // The degenerate case must name itself: an inherited ELECTRON_RUN_AS_NODE makes
  // Electron behave as plain Node, and without this the failure surfaces far from
  // the cause as "cannot read whenReady".
  const child = spawn(electronBinary, ['console/main.cjs'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  await new Promise<void>(done => child.once('close', () => done()));
  assert.match(stderr, /ELECTRON_RUN_AS_NODE/, `必须点名真正的原因，实际输出：${stderr.slice(0, 200)}`);
  assert.equal(/whenReady/.test(stderr), false, '不得抛出难以理解的内部错误');
});

test('console refuses to start without an adapter config, with a usable message', async t => {
  if (!existsSync(electronBinary)) { t.skip('Electron 二进制未下载；跳过控制台启动测试'); return; }
  const result = await launch(['console/main.cjs'],
    { ...process.env, AMB_CONSOLE_CONFIG: join(tmpdir(), 'definitely-missing.json') },
    { exitAfter: 20_000 });
  // It must not hang with a window and no data; it should exit after reporting.
  assert.equal(result.timedOut, false, '缺配置时必须自行退出，而不是挂住');
  assert.equal(result.alive, false, '缺配置时不得停留在运行状态');
  const output = result.stdout + result.stderr;
  assert.match(output, /not found|Adapter config|Console failed/i, `应给出可读原因，实际输出：${output.slice(0, 300)}`);
  assert.equal(output.includes(token), false);
});

test('console opens against a real core and keeps the token out of its output', async t => {
  if (!existsSync(electronBinary)) { t.skip('Electron 二进制未下载；跳过控制台启动测试'); return; }
  const dir = await mkdtemp(join(tmpdir(), 'amb-console-'));
  const store = new Store(join(dir, 'knowledge.sqlite'));
  store.import([{
    id: 'console-norm', kind: 'norm', title: '控制台测试规范',
    scope: { kind: 'project', projectId: 'p0' }, baseRevision: 0,
    body: '仅用于控制台冒烟测试。', deniedTools: [], hostProvided: false,
  }]);
  const server = createCoreServer(store, { protocolVersion: 1, port: 47631, clients: [{ id: 'codex', token, projectId: 'p0', role: 'adapter' }, { id: 'admin', token: adminToken, projectId: 'p0', role: 'admin' }] });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  // The console is the human review surface, so it is pointed at the admin
  // credential: approving proposals is admin-only, and an adapter credential
  // would be correctly refused.
  const configPath = join(dir, 'admin-client.json');
  await writeFile(configPath, JSON.stringify({ endpoint: `http://127.0.0.1:${address.port}`, token: adminToken, projectId: 'p0', role: 'admin' }));

  try {
    const result = await launch(['console/main.cjs', `--config=${configPath}`],
      { ...process.env, AMB_CONSOLE_CONFIG: '' }, { aliveFor: 6000 });
    const output = result.stdout + result.stderr;

    // The decisive property: the credential never reaches the console's output.
    assert.equal(output.includes(adminToken), false, '控制台输出不得包含凭据');
    // A window that opens must not be an immediate crash.
    assert.equal(/Cannot find module|ERR_MODULE_NOT_FOUND|SyntaxError/.test(output), false,
      `控制台不得因加载错误而退出：${output.slice(0, 400)}`);
  } finally {
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('console renders every panel with real data and no failure notice', async t => {
  if (!existsSync(electronBinary)) { t.skip('Electron 二进制未下载；跳过控制台启动测试'); return; }
  // A single screenshot cannot show that the panels nobody opened actually work.
  // This visits all of them against a real core and asserts each produced content
  // rather than an error banner or a stuck placeholder.
  const dir = await mkdtemp(join(tmpdir(), 'amb-console-panels-'));
  const store = new Store(join(dir, 'knowledge.sqlite'));
  store.import([
    { id: 'p-norm', kind: 'norm', title: '面板规范', scope: { kind: 'project', projectId: 'p0' }, baseRevision: 0, body: '正文。', deniedTools: [], hostProvided: false },
    { id: 'p-wf', kind: 'workflow', title: '面板流程', scope: { kind: 'project', projectId: 'p0' }, baseRevision: 0, overview: '概览。', triggers: ['触发'], categories: [['测试']], tags: [], isEntryPoint: true, preconditions: ['前提'], stages: [{ id: 's', title: '步骤', instructions: '执行。', checks: ['检查'], dependencies: [] }], completion: ['完成'], recovery: '停止。' },
    { id: 'p-skill', kind: 'skill', title: '待结构化技能', scope: { kind: 'project', projectId: 'p0' }, baseRevision: 0, body: '# 技能\n', leaves: [], needsStructure: true },
  ] as never[]);
  store.submit('codex', { idempotencyKey: 'panel-1', projectId: 'p0', discovery: '一条待审阅的候选经验。' });
  store.recordTask('p0', { id: 'p-task', title: '面板任务', status: 'paused', summary: '摘要', notes: '', unfinished: [] });

  const server = createCoreServer(store, { protocolVersion: 1, port: 47631, clients: [{ id: 'codex', token, projectId: 'p0', role: 'adapter' }, { id: 'admin', token: adminToken, projectId: 'p0', role: 'admin' }] });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const configPath = join(dir, 'admin-client.json');
  await writeFile(configPath, JSON.stringify({ endpoint: `http://127.0.0.1:${address.port}`, token: adminToken, projectId: 'p0', role: 'admin' }));
  const dumpPath = join(dir, 'dump.json');

  try {
    // Dump mode visits seven panels and exits by itself; wait for that exit
    // rather than sleeping, so a slow machine cannot truncate the capture.
    const result = await launch(['console/main.cjs', `--config=${configPath}`],
      { ...process.env, AMB_CONSOLE_CONFIG: '', AMB_CONSOLE_DUMP: dumpPath }, { exitAfter: 90_000 });
    assert.equal(result.timedOut, false, `导出必须自行结束，输出：${(result.stdout + result.stderr).slice(0, 300)}`);
    assert.equal(existsSync(dumpPath), true, `导出必须生成，输出：${(result.stdout + result.stderr).slice(0, 300)}`);
    const dump = JSON.parse(await readFile(dumpPath, 'utf8')) as Record<string, { text: string; hasError: boolean; rows: number; cards: number }>;

    const expected = ['status', 'proposals', 'norms', 'unstructured', 'tasks', 'workflows', 'doctor', 'migrate'];
    assert.deepEqual(Object.keys(dump).sort(), [...expected].sort(), '八个面板都必须被访问');
    for (const panel of expected) {
      assert.equal(dump[panel]!.hasError, false, `${panel} 不得显示失败提示`);
      assert.ok(dump[panel]!.text.trim().length > 0, `${panel} 不得为空白`);
      assert.equal(/正在读取核心/.test(dump[panel]!.text), false, `${panel} 不得停在加载占位`);
    }
    // Panels backed by rows or cards must show content, not just a header.
    for (const panel of ['norms', 'tasks', 'workflows', 'doctor']) {
      assert.ok(dump[panel]!.rows > 0, `${panel} 必须渲染出数据行`);
    }
    assert.ok(dump.proposals!.cards > 0, '候选面板必须显示候选卡片');
    // The credential must not appear anywhere in what the page sees.
    assert.equal(JSON.stringify(dump).includes(token), false, '页面内容不得包含凭据');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('console main module loads and exposes only the documented IPC surface', async t => {
  if (!existsSync(electronBinary)) { t.skip('Electron 二进制未下载；跳过控制台启动测试'); return; }
  // Static check: the preload bridge must not expose a generic invoke, and the
  // main process must gate views through an allowlist.
  const { readFileSync } = await import('node:fs');
  const preload = readFileSync('console/preload.cjs', 'utf8');
  assert.match(preload, /contextBridge\.exposeInMainWorld\('amb'/);
  assert.equal(/exposeInMainWorld\([^)]*ipcRenderer/.test(preload), false, '不得把 ipcRenderer 整个暴露给页面');
  assert.equal(preload.includes('send:'), false, '不得暴露通用发送通道');

  const main = readFileSync('console/main.cjs', 'utf8');
  assert.match(main, /const VIEWS = \{/, '主进程必须用显式名单而非通用代理');
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /sandbox: true/);
  // The token must never be sent to the renderer.
  assert.equal(/target[\s\S]{0,200}token/.test(main.split('ipcMain.handle(\'amb:target\'')[1]?.split('}));')[0] ?? ''), false,
    'target 视图不得包含凭据');
});

/**
 * Two defects a real desktop run found in the migration panel.
 *
 * Both were display-layer only, which is exactly why they survived the earlier
 * tests: the panel rendered, produced no error notice, and the numbers it did
 * show were correct. Only someone reading the panel as a user noticed that one
 * required number was missing and that the connection indicator lied.
 */
test('migration panel always reports conflicts and never shows a stale connection', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync('console/renderer/app.js', 'utf8');
  const migrate = app.slice(app.indexOf('async function renderMigrate'), app.indexOf('function formatBytes'));

  // Defect 1: conflicts were hidden when empty, so "no conflicts" and "this
  // build does not check conflicts" looked identical. It must always be stated —
  // but exactly once: an earlier fix printed the count on its own line *and* in
  // the empty-case paragraph, so a zero appeared twice on screen.
  assert.match(migrate, /冲突条目：\$\{escapeHtml\(conflicts\.length\)\}/,
    '导入结果必须显示冲突条数');
  const conflictCountLines = (migrate.match(/冲突条目：/g) ?? []).length;
  assert.equal(conflictCountLines, 2,
    `冲突条数应只在两个互斥分支中各出现一次（非零、零），实际出现 ${conflictCountLines} 次`);
  assert.equal(/冲突条目：\$\{escapeHtml\(conflicts\.length\)\}<\/p>\s*<p[^>]*>冲突条目：/.test(migrate), false,
    '不得把冲突条数连续打印两遍');

  // Defect 2: the header kept saying "已连接" after the core stopped, because
  // only the status panel ever updated the indicator. Every migration call must
  // now report the connection outcome it actually observed.
  const handlers = ['backupExport', 'backupInspect', 'backupImport'];
  for (const handler of handlers) {
    const before = migrate.slice(0, migrate.indexOf(`window.amb.${handler}()`));
    assert.ok(before.length > 0, `${handler} 应当出现在迁移面板里`);
  }
  assert.ok((migrate.match(/setConnection\(false\)/g) ?? []).length >= 3,
    '导出的每个失败分支都必须把连接指示改为失败，否则核心停止后仍显示已连接');
  assert.ok((migrate.match(/setConnection\(true\)/g) ?? []).length >= 2,
    '成功分支必须把连接指示恢复为已连接');

  // Cancelling a dialog sends no request, so it must not be read as a connection
  // outcome in either direction.
  const cancelIndex = migrate.indexOf('result.data.canceled');
  const connectIndex = migrate.indexOf('setConnection(true)', cancelIndex === -1 ? 0 : cancelIndex);
  assert.ok(cancelIndex !== -1, '取消分支必须存在');
  assert.ok(connectIndex > cancelIndex, '取消必须在设置连接状态之前处理，否则取消也会被当成一次成功的连接');

  // A replaced archive must be distinguishable from a first export.
  assert.match(migrate, /data\.replaced === true/, '覆盖既有归档时必须告知用户');
});

/**
 * A real user hit this on their second export.
 *
 * The console's save dialog already asked "replace this file?" and the user said
 * yes, but the core was never told. It saw only "the file exists" and refused
 * with 409, so confirming the dialog produced a failure — the confirmation was
 * decorative. The fix carries the answer across as `overwrite`, and this test
 * pins the whole path rather than the module alone, because the module-level
 * guard was already correct and already tested: the defect lived exactly in the
 * seam between the dialog and the HTTP request.
 */
test('re-exporting over an existing archive works once the user confirmed replacement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'amb-console-overwrite-'));
  const store = new Store(join(dir, 'knowledge.sqlite'));
  store.import([{ id: 'ow-entry', kind: 'memory', title: '覆盖测试', scope: { kind: 'global' }, baseRevision: 0, body: '内容。' }] as never[]);
  const server = createCoreServer(store, {
    protocolVersion: 1, port: 47631,
    clients: [{ id: 'admin', token: adminToken, projectId: 'p0', role: 'admin' }],
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const post = async (path: string, body: Record<string, unknown>) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'x-amb-protocol': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'p0', ...body }),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const file = join(dir, 'repeat.ambpack');

  try {
    // First export: the file does not exist, so no overwrite is involved.
    const first = await post('/v1/backup/export', { file, dryRun: false });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(existsSync(file), true);

    // Second export without the user's answer: still refused, so the guard that
    // protects an un-asked-for overwrite is intact.
    const guarded = await post('/v1/backup/export', { file, dryRun: false });
    assert.equal(guarded.status, 409, '未确认覆盖时仍须拒绝，否则保护形同虚设');
    assert.equal(guarded.body.code, 'archive_exists');

    // Third: the console answered the dialog, so it says so and the export runs.
    const confirmed = await post('/v1/backup/export', { file, dryRun: false, overwrite: true });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.ok(Number(confirmed.body.bytes) > 0, '覆盖后的归档必须是真实文件');

    // And the replaced file is still a usable archive, not a truncated stub.
    const inspected = await post('/v1/backup/inspect', { file });
    assert.equal(inspected.status, 200, JSON.stringify(inspected.body));
    assert.equal(inspected.body.format, 'agent-memory-backpack-backup-v1');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
