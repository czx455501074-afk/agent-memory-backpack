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
  failureKindOf,
  isRetryableItem,
  SPOOL_MAX_ITEMS,
} from '../adapters/dsh/spool.mjs';
import {
  CoreClientError,
  clientFailureMeta,
  createClient,
  isCancelledClientError,
  isExplicitClientRejection,
  isRetryableClientError,
} from '../adapters/dsh/core-client.mjs';

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

// ---------------------------------------------------------------------------
// core-client: structured failures (kind/code/status/cause) with no server echo
// ---------------------------------------------------------------------------

const CLIENT_CONFIG = { endpoint: 'http://127.0.0.1:9', token: 'x'.repeat(32), projectId: 'p0' };
/** The actionable half of a refusal: business guidance that must reach the caller. */
const BUSINESS_DETAIL = 'Required dependency realistic-prerequisite@1 is not current';
/** Credential-shaped text that must never survive into an error, a log or a receipt. */
const CREDENTIAL_DETAIL = `Bearer ${'a'.repeat(48)} password=hunter2 token=${'b'.repeat(64)}`;
const SERVER_MESSAGE = `${BUSINESS_DETAIL} ${CREDENTIAL_DETAIL}`;

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function stubFetch(handler) {
  return (url, init) => Promise.resolve().then(() => handler(url, init));
}

/**
 * A fetch that never answers on its own and rejects with whatever aborted the
 * request signal, which is how a real fetch reports an abort: a TimeoutError for
 * this client's own deadline, the caller's own reason when the caller withdrew.
 */
function pendingFetch() {
  return (_url, init) => new Promise((_resolve, reject) => {
    const signal = init.signal;
    if (signal?.aborted) { reject(signal.reason); return; }
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

test('core-client: 自身超时归类 timeout/request_timeout 并保留 cause', async t => {
  const original = AbortSignal.timeout;
  t.after(() => { AbortSignal.timeout = original; });
  // A deadline that has already fired, with the same TimeoutError reason a real one
  // produces: no five-second wait, and no test-only switch inside the client.
  AbortSignal.timeout = () => {
    const controller = new AbortController();
    controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    return controller.signal;
  };
  const client = createClient(CLIENT_CONFIG, pendingFetch());
  await assert.rejects(() => client.post('/v1/prepare', {}), (error) => {
    assert.ok(error instanceof CoreClientError, '必须是带 kind/code/status 的结构化错误');
    assert.equal(error.name, 'CoreClientError');
    assert.equal(error.kind, 'timeout');
    assert.equal(error.code, 'request_timeout');
    assert.equal(error.status, undefined);
    assert.equal(error.cause?.name, 'TimeoutError');
    assert.equal(isRetryableClientError(error), true, '自身超时可重试');
    assert.equal(isExplicitClientRejection(error), false);
    return true;
  });
});

test('core-client: 调用方取消归类 cancelled/request_cancelled，不得当作自身超时', async () => {
  const caller = new AbortController();
  caller.abort(new DOMException('The operation was aborted.', 'AbortError'));
  const client = createClient(CLIENT_CONFIG, pendingFetch());
  await assert.rejects(() => client.post('/v1/prepare', {}, { signal: caller.signal }), (error) => {
    assert.equal(error.kind, 'cancelled');
    assert.equal(error.code, 'request_cancelled');
    assert.equal(error.status, undefined);
    assert.equal(isCancelledClientError(error), true);
    assert.equal(isRetryableClientError(error), false, '取消严禁进入 outbox 或 spool');
    assert.equal(isExplicitClientRejection(error), true);
    return true;
  });
});

test('core-client: fetch TypeError 归类 network，其他传输错误归类 transport', async () => {
  const network = createClient(CLIENT_CONFIG, () => { throw new TypeError('fetch failed'); });
  await assert.rejects(() => network.post('/v1/prepare', {}), (error) => {
    assert.equal(error.kind, 'network');
    assert.equal(error.code, 'network_error');
    assert.equal(error.status, undefined);
    assert.equal(isRetryableClientError(error), true, '不可达核心可排队重放');
    return true;
  });

  const transport = createClient(CLIENT_CONFIG, () => { throw new Error('socket hang up'); });
  await assert.rejects(() => transport.post('/v1/prepare', {}), (error) => {
    assert.equal(error.kind, 'transport');
    assert.equal(error.code, 'transport_error');
    assert.equal(error.cause?.message, 'socket hang up');
    return true;
  });
});

test('core-client: 响应体解析失败归类 protocol/invalid_response 并保留 status', async () => {
  const client = createClient(CLIENT_CONFIG, stubFetch(() => ({
    ok: true,
    status: 200,
    json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
  })));
  await assert.rejects(() => client.post('/v1/prepare', {}), (error) => {
    assert.equal(error.kind, 'protocol');
    assert.equal(error.code, 'invalid_response');
    assert.equal(error.status, 200);
    assert.equal(error.cause?.name, 'SyntaxError');
    assert.match(error.message, /HTTP 200/);
    assert.equal(isRetryableClientError(error), false, '协议损坏不得排队重放');
    return true;
  });
});

test('core-client: 400/426→http4xx，500→http5xx，507→capacity，业务 message 保留而凭据被剥离', async () => {
  const cases = [
    { status: 400, body: { code: 'bad_request', message: SERVER_MESSAGE }, kind: 'http4xx', code: 'bad_request' },
    { status: 426, body: { code: 'protocol_mismatch', message: SERVER_MESSAGE }, kind: 'http4xx', code: 'protocol_mismatch' },
    { status: 500, body: { message: SERVER_MESSAGE }, kind: 'http5xx', code: 'http5xx' },
    { status: 507, body: { code: 'outbox_full', message: SERVER_MESSAGE }, kind: 'capacity', code: 'outbox_full' },
    { status: 507, body: {}, kind: 'capacity', code: 'capacity_exhausted' },
  ];
  for (const expected of cases) {
    const client = createClient(CLIENT_CONFIG, stubFetch(() => jsonResponse(expected.status, expected.body)));
    await assert.rejects(() => client.post('/v1/prepare', {}), (error) => {
      assert.equal(error.kind, expected.kind, `status ${expected.status} 的 kind`);
      assert.equal(error.code, expected.code, `status ${expected.status} 的 code`);
      assert.equal(error.status, expected.status);
      assert.match(error.message, new RegExp(`HTTP ${expected.status}`));
      if (expected.body?.message) {
        assert.equal(error.message.includes(BUSINESS_DETAIL), true, '业务指导必须保留给调用方');
        assert.equal(error.message.includes('hunter2'), false, 'password 值必须剥离');
        assert.equal(error.message.includes('a'.repeat(48)), false, '长 base64 串必须剥离');
        assert.equal(error.message.includes('b'.repeat(64)), false, 'token 值必须剥离');
        assert.equal(error.message.includes('[redacted]'), true, '剥离处必须留下占位符');
      } else {
        assert.equal(error.message.includes('Detail:'), false, '无服务端 message 时不得凭空拼出明细段');
      }
      assert.equal(error.coreBody, undefined, '不得把服务端响应体挂在错误上');
      assert.equal(
        isRetryableClientError(error),
        expected.kind === 'http5xx' || expected.kind === 'capacity',
        `status ${expected.status} 的可重试判定`,
      );
      return true;
    });
  }
});

test('core-client: clientFailureMeta 产出 kind/code/status/reason/at，reason 已脱敏', async () => {
  const client = createClient(CLIENT_CONFIG, stubFetch(() => jsonResponse(400, { code: 'bad_request', message: SERVER_MESSAGE })));
  const error = await client.post('/v1/prepare', {}).catch(caught => caught);
  const meta = clientFailureMeta(error);
  assert.equal(meta.kind, 'http4xx');
  assert.equal(meta.code, 'bad_request');
  assert.equal(meta.status, 400);
  assert.equal(Number.isFinite(meta.at), true, '必须带时间戳');
  assert.equal(meta.reason.includes(BUSINESS_DETAIL), true, 'reason 保留业务指导');
  assert.equal(meta.reason.includes('b'.repeat(64)), false, 'reason 已剥离凭据');
});

test('core-client: 超长服务端 message 被截断，不放大错误体积', async () => {
  // Long enough to exceed the cap several times over, and free of credential
  // shapes so the length itself is what is under test.
  const long = Array.from({ length: 400 }, (_value, index) => `第${index}项`).join(' ');
  const client = createClient(CLIENT_CONFIG, stubFetch(() => jsonResponse(400, { code: 'bad_request', message: long })));
  const error = await client.post('/v1/prepare', {}).catch(caught => caught);
  assert.equal(error.message.includes('第0项'), true, '截断必须保留前部信息');
  assert.ok(error.message.length < 700, `错误消息必须被截断，实际 ${error.message.length} 字符`);
  assert.equal(error.message.includes('第399项'), false, '截断必须丢弃尾部');
});

// ---------------------------------------------------------------------------
// spool: structured failure metadata and category-aware replay
// ---------------------------------------------------------------------------

test('spool: 首次失败 attempts=0 且记录结构化元数据；同 key 合并不重置 createdAt 与 attempts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'amb-spool-meta-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const failure = {
    kind: 'http5xx', code: 'http5xx', status: 503,
    reason: 'Agent Memory Backpack request rejected (HTTP 503, http5xx).', at: 1_700_000_000_000,
  };
  const outcome = spoolEnqueue(dir, {
    kind: 'event', idempotencyKey: 'meta-1', projectId: 'p0',
    payload: { eventId: 'meta-1', kind: 'turn_stopped' }, failure,
  });
  assert.equal(outcome.enqueued, true);

  const [first] = loadSpool(dir);
  assert.equal(first.attempts, 0, '首次失败只登记，不计入 attempts');
  assert.equal(first.failure.kind, 'http5xx');
  assert.equal(first.failure.code, 'http5xx');
  assert.equal(first.failure.status, 503);
  assert.equal(first.failure.reason, failure.reason);
  assert.equal(first.failure.at, failure.at);
  assert.equal(first.lastError, failure.reason, 'lastError 保留字符串形式供旧读取方使用');

  // Spend some retry budget and a little age, then let the same key arrive again.
  first.attempts = 3;
  saveSpool(dir, [first]);
  const merged = spoolEnqueue(dir, {
    kind: 'event', idempotencyKey: 'meta-1', projectId: 'p0',
    payload: { eventId: 'meta-1', kind: 'turn_stopped', summary: 'updated' },
    failure: { kind: 'network', code: 'network_error', reason: 'Agent Memory Backpack core unavailable. Governance could not be checked.', at: 1_700_000_000_100 },
  });
  assert.equal(merged.enqueued, true);
  assert.equal(merged.updated, true);

  const afterMerge = loadSpool(dir);
  assert.equal(afterMerge.length, 1, '同 key 二次到达必须合并而非新增');
  assert.equal(afterMerge[0].attempts, 3, '合并不得重置重试预算');
  assert.equal(afterMerge[0].createdAt, first.createdAt, '合并不得重置 TTL 起点');
  assert.equal(afterMerge[0].failure.kind, 'network', '合并应保留最近一次失败类别');
  assert.equal(afterMerge[0].payload.summary, 'updated', '合并应更新 payload');
});

test('spool: 可重试类别（timeout/network/5xx/507）重放失败后 attempts+1 并保留重试', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'amb-spool-retry-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  spoolEnqueue(dir, {
    kind: 'candidate', idempotencyKey: 'retry-1', projectId: 'p0',
    payload: { idempotencyKey: 'retry-1', discovery: '待重试的候选' },
    failure: { kind: 'timeout', code: 'request_timeout', reason: 'Agent Memory Backpack core unavailable. Governance could not be checked.' },
  });
  spoolEnqueue(dir, {
    kind: 'event', idempotencyKey: 'retry-2', projectId: 'p0',
    payload: { eventId: 'retry-2', kind: 'turn_stopped' },
    failure: { kind: 'capacity', code: 'outbox_full', status: 507, reason: 'Agent Memory Backpack request rejected (HTTP 507, outbox_full).' },
  });

  const logger = { info: () => {}, warn: () => {} };
  const failingClient = {
    async post() {
      const error = new Error('Agent Memory Backpack request rejected (HTTP 503, http5xx).');
      error.kind = 'http5xx';
      error.code = 'http5xx';
      error.status = 503;
      throw error;
    },
  };

  const first = await spoolReplay(dir, failingClient, logger);
  assert.equal(first.replayed, 0);
  assert.equal(first.rejected, 0, '暂态故障不得被当作永久拒绝');
  assert.equal(first.remaining, 2, '可重试条目必须留在队列里');
  const items = loadSpool(dir);
  assert.equal(items.find(i => i.idempotencyKey === 'retry-1').attempts, 1, '重放失败应递增 attempts');
  assert.equal(items.find(i => i.idempotencyKey === 'retry-2').attempts, 1);
  assert.equal(items[0].failure.kind, 'http5xx', '重放失败应更新结构化失败元数据');
  assert.equal(items[0].failure.status, 503);

  const second = await spoolReplay(dir, failingClient, logger);
  assert.equal(second.remaining, 2, '仍可继续重试');
  assert.equal(loadSpool(dir)[0].attempts, 2);
});

test('spool: 4xx 判为永久拒绝并移出队列，不得无限重试，日志不得含 payload', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'amb-spool-reject-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  spoolEnqueue(dir, {
    kind: 'candidate', idempotencyKey: 'reject-1', projectId: 'p0',
    payload: { idempotencyKey: 'reject-1', discovery: '这段内容不得出现在日志里' },
    failure: { kind: 'http4xx', code: 'bad_request', status: 400, reason: 'Agent Memory Backpack request rejected (HTTP 400, bad_request).' },
  });

  const logs = [];
  const logger = {
    info: (event, fields) => logs.push({ event, fields }),
    warn: (event, fields) => logs.push({ event, fields }),
  };
  const rejectingClient = {
    async post() {
      const error = new Error('Agent Memory Backpack request rejected (HTTP 400, bad_request).');
      error.kind = 'http4xx';
      error.code = 'bad_request';
      error.status = 400;
      throw error;
    },
  };

  const result = await spoolReplay(dir, rejectingClient, logger);
  assert.equal(result.replayed, 0);
  assert.equal(result.rejected, 1, '永久拒绝必须计入 rejected');
  assert.equal(result.remaining, 0);
  assert.equal(loadSpool(dir).length, 0, '永久拒绝的条目必须移出队列，不得无限重试');

  const rejection = logs.find(entry => entry.event === 'spool.rejected');
  assert.ok(rejection, '必须记录永久拒绝事件');
  assert.equal(rejection.fields.code, 'bad_request');
  assert.equal(rejection.fields.failureKind, 'http4xx');
  assert.equal(rejection.fields.status, 400);
  assert.equal(JSON.stringify(logs).includes('这段内容不得出现在日志里'), false, '日志严禁记录 payload 内容');
});

test('spool: 旧版字符串 lastError 仍可读，并据此把 4xx 判为永久拒绝', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'amb-spool-legacy-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Exactly what an earlier build wrote: no structured failure, only the string.
  saveSpool(dir, [{
    idempotencyKey: 'legacy-1', kind: 'event', projectId: 'p0',
    payload: { eventId: 'legacy-1', kind: 'turn_stopped' },
    createdAt: Date.now(), attempts: 0, lastAttempt: 0,
    lastError: 'Agent Memory Backpack service returned HTTP 400 [bad_request] invalid discovery',
  }]);

  const [legacy] = loadSpool(dir);
  assert.equal(typeof legacy.lastError, 'string', '旧字符串 lastError 必须仍可读');
  assert.equal(failureKindOf(legacy), 'http4xx', '旧字符串里 400 必须被识别为 4xx');
  assert.equal(isRetryableItem(legacy), false, '旧 4xx 不得被当作可重试');

  const logs = [];
  const legacyClient = {
    // An error shaped like the one an older client raised: a message, no kind.
    async post() { throw new Error('Agent Memory Backpack service returned HTTP 400 [bad_request] invalid discovery'); },
  };
  const result = await spoolReplay(dir, legacyClient, { info: () => {}, warn: (event, fields) => logs.push({ event, fields }) });
  assert.equal(result.rejected, 1, '旧格式的 4xx 也必须判为永久拒绝');
  assert.equal(loadSpool(dir).length, 0);
  assert.equal(logs.some(entry => entry.event === 'spool.rejected'), true);
});
