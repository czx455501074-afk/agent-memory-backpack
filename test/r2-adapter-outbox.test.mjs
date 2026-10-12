import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after } from 'node:test';
import { spawn } from 'node:child_process';
import { inspectRuntime, runtimeRoot } from './dsh-target.mjs';
import { Store } from '../dist/src/store.js';
import { createCoreServer } from '../dist/src/server.js';

const runtimeProbe = inspectRuntime();
const runtimeSkip = runtimeProbe.available ? false : runtimeProbe.reason;
const cordisUrl = pathToFileURL(resolve(runtimeRoot, '@deepseek-ai/cordis/lib/index.js'));
const { Context } = runtimeProbe.available ? await import(cordisUrl.href) : { Context: class {} };
const adapterModule = await import('../adapters/dsh/index.mjs');
const adapter = adapterModule.default || adapterModule;
const hookPath = resolve('adapters/codex/scripts/hook.mjs');

const PROJECT = 'outbox-test-proj';
const servers = new Set();
const stores = new Set();
const tempDirs = new Set();

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

after(async () => {
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise(r => s.close(r));
  }
  for (const st of stores) {
    try { st.close(); } catch {}
  }
  for (const d of tempDirs) {
    await rm(d, { recursive: true, force: true });
  }
});

function runHook(input, configPath) {
  return new Promise((resolveRun) => {
    const env = { ...process.env, AMB_CONFIG: configPath };
    const child = spawn(process.execPath, [hookPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), 10000);
    child.stdout.setEncoding('utf8').on('data', c => { stdout += c; });
    child.stderr.setEncoding('utf8').on('data', c => { stderr += c; });
    child.on('close', code => {
      clearTimeout(timer);
      resolveRun({ status: code, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

test('1-a & 1-d: 核心故障或不可达时，DSH 候选提交与事件采集落队到 outbox，不可达时不崩溃', { skip: runtimeSkip }, async () => {
  const requests = [];
  const enqueueCalls = [];

  const s = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    requests.push({ url: req.url, method: req.method, body });

    if (req.url === '/health') return json(res, 200, { protocolVersion: 1, status: 'ok' });
    if (req.url === '/v1/proposals') {
      // Simulate 503 temporary service failure
      return json(res, 503, { error: 'Service Unavailable' });
    }
    if (req.url === '/v1/events') {
      // Simulate 500 error
      return json(res, 500, { error: 'Internal Error' });
    }
    if (req.url === '/v1/outbox/enqueue') {
      enqueueCalls.push(body);
      return json(res, 200, {
        id: 'queued-item-1',
        status: 'pending',
        duplicate: false,
        attempts: 1,
        note: '已写入持久队列',
      });
    }
    return json(res, 404, { error: 'not found' });
  });

  await new Promise(r => s.listen(0, '127.0.0.1', r));
  servers.add(s);
  const { port } = s.address();

  const dir = await mkdtemp(join(tmpdir(), 'amb-r2-outbox-dsh-'));
  tempDirs.add(dir);
  const configPath = join(dir, 'client.json');
  await writeFile(configPath, JSON.stringify({
    endpoint: `http://127.0.0.1:${port}`,
    token: 'x'.repeat(32),
    projectId: PROJECT,
    projectRoot: dir,
  }), 'utf8');

  process.env.AMB_DSH_CONFIG = configPath;
  const registeredTools = new Map();
  const tools = {
    guard() { return () => {}; },
    register(definition) {
      registeredTools.set(definition.name, definition);
      return () => registeredTools.delete(definition.name);
    },
  };

  const base = new Context();
  const toolsFiber = base.plugin({ name: 'test-tools', apply(c) { c.provide('tools', tools); } });
  await toolsFiber;
  const fiber = base.plugin(adapter);
  await fiber;

  const agent = {
    id: 'test-agent-1',
    session: { header: { cwd: dir } },
    inject: () => {},
  };

  // 1. amb_submit_experience when proposals fails with 503: must enqueue into outbox and return receipt
  const submitTool = registeredTools.get('amb_submit_experience');
  assert.ok(submitTool, 'amb_submit_experience 必须注册');
  const receipt = await submitTool.execute({
    idempotencyKey: 'offline-key-1',
    discovery: 'A reusable discovery under offline condition.',
  }, { agent, signal: new AbortController().signal });

  assert.equal(receipt.state, 'pending');
  assert.equal(receipt.id, 'queued-item-1');
  assert.equal(enqueueCalls.length, 1, '必须尝试落队');
  assert.equal(enqueueCalls[0].kind, 'candidate');
  assert.equal(enqueueCalls[0].idempotencyKey, 'offline-key-1');
  assert.equal(enqueueCalls[0].projectId, PROJECT);
  assert.equal(enqueueCalls[0].payload.discovery, 'A reusable discovery under offline condition.');

  // 2. session/event delivery failure with 500: must enqueue event into outbox
  const eventPayload = {
    type: 'tool/call',
    data: {},
  };
  base.emit('session/event', { id: 'test-session-1', header: { cwd: dir } }, eventPayload);

  // Allow async void client.post catch to settle
  await new Promise(r => setTimeout(r, 100));
  const eventEnqueue = enqueueCalls.find(c => c.kind === 'event');
  assert.ok(eventEnqueue, '事件投递失败后必须落队到 outbox');
  assert.equal(eventEnqueue.projectId, PROJECT);
  assert.equal(eventEnqueue.payload.kind, 'tool/call');

  // 3. Complete core outage: close server completely, submit must NOT crash
  s.closeAllConnections?.();
  await new Promise(r => s.close(r));
  servers.delete(s);

  const offlineReceipt = await submitTool.execute({
    idempotencyKey: 'offline-key-2',
    discovery: 'Unreachable core insight.',
  }, { agent, signal: new AbortController().signal });

  assert.equal(offlineReceipt.state, 'pending');
  assert.equal(offlineReceipt.id, 'offline-key-2');
  delete process.env.AMB_DSH_CONFIG;
  await fiber.dispose();
  await toolsFiber.dispose();
});

test('1-a & 1-d: 确定性 4xx 语义拒绝（如 403）不得落队到 outbox', { skip: runtimeSkip }, async () => {
  const requests = [];
  const s = createServer(async (req, res) => {
    requests.push(req.url);
    if (req.url === '/health') return json(res, 200, { protocolVersion: 1, status: 'ok' });
    if (req.url === '/v1/proposals') {
      return json(res, 403, { error: 'Forbidden: caller lacks required project permission' });
    }
    if (req.url === '/v1/outbox/enqueue') {
      return json(res, 200, { id: 'unexpected', status: 'pending', duplicate: false });
    }
    return json(res, 404, { error: 'not found' });
  });

  await new Promise(r => s.listen(0, '127.0.0.1', r));
  servers.add(s);
  const { port } = s.address();

  const dir = await mkdtemp(join(tmpdir(), 'amb-r2-outbox-4xx-'));
  tempDirs.add(dir);
  const configPath = join(dir, 'client.json');
  await writeFile(configPath, JSON.stringify({
    endpoint: `http://127.0.0.1:${port}`,
    token: 'x'.repeat(32),
    projectId: PROJECT,
    projectRoot: dir,
  }), 'utf8');

  process.env.AMB_DSH_CONFIG = configPath;
  const registeredTools = new Map();
  const tools = {
    guard() { return () => {}; },
    register(definition) {
      registeredTools.set(definition.name, definition);
      return () => registeredTools.delete(definition.name);
    },
  };

  const base = new Context();
  const toolsFiber = base.plugin({ name: 'test-tools', apply(c) { c.provide('tools', tools); } });
  await toolsFiber;
  const fiber = base.plugin(adapter);
  await fiber;

  const agent = {
    id: 'test-agent-4xx',
    session: { header: { cwd: dir } },
    inject: () => {},
  };

  const submitTool = registeredTools.get('amb_submit_experience');
  await assert.rejects(
    async () => {
      await submitTool.execute({
        idempotencyKey: 'forbidden-key',
        discovery: 'Unauthorized proposal.',
      }, { agent, signal: new AbortController().signal });
    },
    (err) => {
      assert.match(err.message, /403/);
      return true;
    },
    '403 明确拒绝必须向上抛出',
  );

  assert.equal(requests.includes('/v1/outbox/enqueue'), false, '确定性 4xx 绝不得调用 outbox/enqueue');
  delete process.env.AMB_DSH_CONFIG;
  await fiber.dispose();
  await toolsFiber.dispose();
});

test('1-b & 1-d: 会话开始自动重放清空队列，知识与事件只落地一条（幂等重放）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'amb-r2-outbox-real-'));
  tempDirs.add(dir);
  const dbPath = join(dir, 'test-knowledge.sqlite');
  const store = new Store(dbPath);
  stores.add(store);

  // Pick an ephemeral port for CoreServer schema requirement port >= 1
  const testHttp = createServer();
  await new Promise(r => testHttp.listen(0, '127.0.0.1', r));
  const dynamicPort = testHttp.address().port;
  await new Promise(r => testHttp.close(r));

  const token = 'replay-token-'.repeat(3);
  const coreServer = createCoreServer(store, {
    protocolVersion: 1,
    port: dynamicPort,
    clients: [{ id: 'codex', token, role: 'adapter', projectId: PROJECT }],
  });

  await new Promise(r => coreServer.listen(dynamicPort, '127.0.0.1', r));
  servers.add(coreServer);

  // 1. Manually enqueue a candidate and an event into outbox
  const payload = { idempotencyKey: 'replay-cand-1', projectId: PROJECT, discovery: 'Delivered via replay.' };
  store.enqueue('codex', {
    kind: 'candidate',
    idempotencyKey: 'replay-cand-1',
    projectId: PROJECT,
    payload,
    error: 'connection reset',
    attempts: 1,
  });

  const evtPayload = {
    eventId: 'replay-event-1',
    adapter: 'codex',
    projectId: PROJECT,
    sessionId: 'sess-replay-1',
    kind: 'tool_completed',
    summary: 'Finished tool via replay.',
  };
  store.enqueue('codex', {
    kind: 'event',
    idempotencyKey: 'replay-event-1',
    projectId: PROJECT,
    payload: evtPayload,
    error: 'timeout',
    attempts: 1,
  });

  assert.equal(store.outboxStatus(PROJECT).pending, 2, '初始有 2 条待发条目');

  // 2. Configure Codex hook with SessionStart and run it
  const configPath = join(dir, 'client.json');
  await writeFile(configPath, JSON.stringify({
    endpoint: `http://127.0.0.1:${dynamicPort}`,
    token,
    projectId: PROJECT,
    projectRoot: dir,
  }), 'utf8');

  const startRes = await runHook({
    hook_event_name: 'SessionStart',
    session_id: 'session-replay-codex',
    cwd: dir,
  }, configPath);

  assert.equal(startRes.status, 0, `SessionStart 应成功执行，stderr: ${startRes.stderr}`);

  // Verify outbox was replayed!
  const statusAfter = store.outboxStatus(PROJECT);
  assert.equal(statusAfter.pending, 0, '重放后 pending 队列必须清空');
  assert.equal(statusAfter.sent, 2, '2 条条目均已变为 sent');

  // Verify candidate stored only once
  const proposals = store.listProposals(PROJECT);
  assert.equal(proposals.length, 1, '候选库只产生 1 条候选');
  assert.equal(proposals[0].payload.idempotencyKey, 'replay-cand-1');

  // Verify event recorded
  const eventRow = store.db.prepare('SELECT event_id, payload FROM events WHERE event_id=?').get('replay-event-1');
  assert.ok(eventRow, '事件必须已记录到数据库');
  assert.equal(eventRow.event_id, 'replay-event-1');

  store.close();
  stores.delete(store);
});

test('1-b & 1-d: 会话开始自动重放是 best-effort，重放故障绝不阻断 prepare 或会话', async () => {
  let replayAttempted = false;
  let prepareAttempted = false;

  const s = createServer(async (req, res) => {
    if (req.url === '/health') return json(res, 200, { protocolVersion: 1, status: 'ok' });
    if (req.url === '/v1/outbox/replay') {
      replayAttempted = true;
      return json(res, 503, { error: 'Replay service temporarily unavailable' });
    }
    if (req.url === '/v1/prepare') {
      prepareAttempted = true;
      return json(res, 200, {
        protocolVersion: 1,
        knowledgeRevision: 3,
        mode: 'Managed',
        norms: [],
        workflows: [],
        context: 'Best-effort context successfully delivered.',
      });
    }
    return json(res, 404, { error: 'not found' });
  });

  await new Promise(r => s.listen(0, '127.0.0.1', r));
  servers.add(s);
  const { port } = s.address();

  const dir = await mkdtemp(join(tmpdir(), 'amb-r2-outbox-besteffort-'));
  tempDirs.add(dir);
  const configPath = join(dir, 'client.json');
  await writeFile(configPath, JSON.stringify({
    endpoint: `http://127.0.0.1:${port}`,
    token: 'x'.repeat(32),
    projectId: PROJECT,
    projectRoot: dir,
  }), 'utf8');

  // Test Codex SessionStart: replay fails but hook succeeds
  const res = await runHook({
    hook_event_name: 'SessionStart',
    session_id: 'besteffort-session',
    cwd: dir,
  }, configPath);

  assert.equal(res.status, 0, `重放失败时 SessionStart 仍必须成功退出，stderr: ${res.stderr}`);
  assert.equal(replayAttempted, true, '必须尝试了重放');
  assert.equal(prepareAttempted, true, '重放失败后 prepare 必须仍然执行');
  const parsed = JSON.parse(res.stdout.trim());
  assert.match(parsed.hookSpecificOutput?.additionalContext, /Best-effort context successfully delivered/);
});
