import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  spoolEnqueue,
  spoolReplay,
  loadSpool,
  saveSpool,
  spoolFilePath,
  SPOOL_MAX_ITEMS,
} from '../adapters/dsh/spool.mjs';

test('M3: 核心与核心 outbox 均不可达时，适配器落盘到本地 spool 且不阻断主流程', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'amb-spool-test-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const payload = {
    idempotencyKey: 'offline-cand-1',
    projectId: 'p0',
    discovery: '核心离线时的发现经验',
  };

  const outcome = spoolEnqueue(dir, {
    kind: 'candidate',
    idempotencyKey: 'offline-cand-1',
    projectId: 'p0',
    payload,
    error: 'connect ECONNREFUSED 127.0.0.1:47751',
  });

  assert.equal(outcome.enqueued, true, '应成功写入本地 spool');
  assert.equal(outcome.key, 'offline-cand-1');

  // Verify file on disk
  const items = loadSpool(dir);
  assert.equal(items.length, 1);
  assert.equal(items[0].idempotencyKey, 'offline-cand-1');
  assert.equal(items[0].kind, 'candidate');
  assert.deepEqual(items[0].payload, payload);

  // Idempotent duplicate enqueue: does not duplicate item
  const dupOutcome = spoolEnqueue(dir, {
    kind: 'candidate',
    idempotencyKey: 'offline-cand-1',
    projectId: 'p0',
    payload,
    error: 'connect ECONNREFUSED again',
  });
  assert.equal(dupOutcome.enqueued, true);
  assert.equal(dupOutcome.updated, true);
  const itemsAfterDup = loadSpool(dir);
  assert.equal(itemsAfterDup.length, 1, '同 key 重复入队应合并，不得产生第二条记录');
});

test('M3: 核心恢复后，spoolReplay 重放送达后即清空本地缓冲且保证幂等', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'amb-spool-replay-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Seed two items into local spool
  spoolEnqueue(dir, {
    kind: 'candidate',
    idempotencyKey: 'replay-key-1',
    projectId: 'p0',
    payload: { idempotencyKey: 'replay-key-1', discovery: '经验 1' },
  });
  spoolEnqueue(dir, {
    kind: 'event',
    idempotencyKey: 'replay-evt-1',
    projectId: 'p0',
    payload: { eventId: 'replay-evt-1', kind: 'turn_stopped', summary: '事件 1' },
  });

  assert.equal(loadSpool(dir).length, 2);

  const deliveredToCore = [];
  const fakeCoreClient = {
    async post(path, body) {
      deliveredToCore.push({ path, body });
      return { ok: true, stored: true };
    },
  };

  const replayResult = await spoolReplay(dir, fakeCoreClient);
  assert.equal(replayResult.replayed, 2, '两项都应成功送达核心');
  assert.equal(replayResult.remaining, 0, '重放完成后本地 spool 应清空');
  assert.equal(loadSpool(dir).length, 0, '送达即删：本地 spool 文件不得残留已送达条目');
  assert.equal(deliveredToCore.length, 2);
  assert.equal(deliveredToCore[0].body.idempotencyKey, 'replay-key-1', '必须复用原始 idempotencyKey');
  assert.equal(deliveredToCore[1].body.eventId, 'replay-evt-1', '必须复用原始 eventId');

  // Second replay is no-op
  const secondReplay = await spoolReplay(dir, fakeCoreClient);
  assert.equal(secondReplay.replayed, 0);
  assert.equal(secondReplay.remaining, 0);
});

test('M3: 超过容量上限时明确拒绝入队，不静默丢弃也不阻断调用方', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'amb-spool-limit-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Simulate 500 pre-existing items
  const dummyItems = [];
  for (let i = 0; i < SPOOL_MAX_ITEMS; i++) {
    dummyItems.push({
      idempotencyKey: `k-${i}`,
      kind: 'event',
      createdAt: Date.now(),
      attempts: 0,
    });
  }
  saveSpool(dir, dummyItems);
  assert.equal(loadSpool(dir).length, SPOOL_MAX_ITEMS);

  // Attempt to enqueue 501th item
  const outcome = spoolEnqueue(dir, {
    kind: 'candidate',
    idempotencyKey: 'overflow-key',
    projectId: 'p0',
    payload: { idempotencyKey: 'overflow-key', discovery: '超限条目' },
  });

  assert.equal(outcome.enqueued, false, '达到 500 上限时必须拒绝入队');
  assert.equal(outcome.reason, 'capacity_exceeded');
  assert.match(String(outcome.error), /capacity limit exceeded/);
  assert.equal(loadSpool(dir).length, SPOOL_MAX_ITEMS, '原有的 500 条应完好无损');
});

test('M3: 损坏的 spool 文件被安全隔离留证，不崩溃且不静默销毁', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'amb-spool-corrupt-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const file = spoolFilePath(dir);
  await writeFile(file, 'INVALID-HALF-WRITTEN-JSON{', 'utf8');

  // Loading corrupt spool: does not throw, returns empty array, renames file for evidence
  const loaded = loadSpool(dir);
  assert.deepEqual(loaded, [], '读取损坏文件应安全降级为空数组，绝不得抛错');

  const filesInDir = readdirSync(dir);
  const corruptFile = filesInDir.find(name => name.includes('adapter-spool.json.corrupt-'));
  assert.ok(corruptFile, '损坏的 spool 文件必须改名留证，严禁无痕销毁');
});

test('M3: Codex hook 端到端实跑（503 核心失败）：事件进入本地 spool，同时保持非零退出以报告服务异常', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'amb-spool-hook-e2e-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const projectDir = join(dir, 'project');
  const fakeHome = join(dir, 'home');
  const dataDir = join(fakeHome, '.agent-memory-backpack');
  await mkdir(projectDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const server = createServer((req, res) => {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Service Unavailable' }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const port = server.address().port;

  const configPath = join(dataDir, 'client.json');
  await writeFile(configPath, JSON.stringify({
    endpoint: `http://127.0.0.1:${port}`,
    token: 'x'.repeat(32),
    projectId: 'p0',
    projectRoot: projectDir,
  }), 'utf8');

  const hookScript = resolve('adapters/codex/scripts/hook.mjs');
  const child = spawn(process.execPath, [hookScript], {
    env: {
      ...process.env,
      AMB_CONFIG: configPath,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', c => { stdout += c; });
  child.stderr.setEncoding('utf8').on('data', c => { stderr += c; });

  const exitPromise = new Promise(res => child.once('close', res));
  child.stdin.end(JSON.stringify({
    hook_event_name: 'Stop',
    session_id: 'sess-e2e-spool-1',
    cwd: projectDir,
  }));

  const exitCode = await exitPromise;
  // 1. Hook must exit with non-zero status and report HTTP 503
  assert.notEqual(exitCode, 0, '核心 503 故障时 Stop hook 必须以非零退出，不得伪装成成功');
  assert.match(stderr, /HTTP 503/);

  // 2. Event must be safely preserved in local spool inside dataDir
  const items = loadSpool(dataDir);
  assert.equal(items.length, 1, '未送达的事件必须进入配置目录下的本地 spool，绝不丢失');
  assert.equal(items[0].kind, 'event');
  assert.equal(items[0].payload.kind, 'turn_stopped');
});

test('M3: 确定性 4xx 语义拒绝（如 400/403）不得落入本地 spool', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'amb-spool-4xx-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const projectDir = join(dir, 'project');
  const fakeHome = join(dir, 'home');
  const dataDir = join(fakeHome, '.agent-memory-backpack');
  await mkdir(projectDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const server = createServer((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad Request' }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const port = server.address().port;

  const configPath = join(dataDir, 'client.json');
  await writeFile(configPath, JSON.stringify({
    endpoint: `http://127.0.0.1:${port}`,
    token: 'x'.repeat(32),
    projectId: 'p0',
    projectRoot: projectDir,
  }), 'utf8');

  const hookScript = resolve('adapters/codex/scripts/hook.mjs');
  const child = spawn(process.execPath, [hookScript], {
    env: {
      ...process.env,
      AMB_CONFIG: configPath,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', c => { stderr += c; });

  const exitPromise = new Promise(res => child.once('close', res));
  child.stdin.end(JSON.stringify({
    hook_event_name: 'Stop',
    session_id: 'sess-4xx-1',
    cwd: projectDir,
  }));

  const exitCode = await exitPromise;
  assert.notEqual(exitCode, 0, '400 必须失败退出');

  // Spool must NOT contain 4xx errors
  const items = loadSpool(dataDir);
  assert.equal(items.length, 0, '确定性 4xx 拒绝永远无法通过重放成功，严禁落盘堆积队列');
});
