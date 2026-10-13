import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
  // F04: the offline receipt must be distinguishable from a server acceptance,
  // not a bare `pending` that a reader would report as "已入服务器待审".
  assert.equal(offlineReceipt.receiptSource, 'local');
  assert.equal(offlineReceipt.deliveryState, 'queued-local');
  assert.equal(offlineReceipt.clientSubmissionId, 'offline-key-2');
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

test('F05: 同会话（不换聊天）在核心恢复后触发受控重放，且每轮不再无节制重试', { skip: runtimeSkip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'amb-f05-replay-'));
  tempDirs.add(dir);
  const projectRoot = join(dir, 'project');
  await mkdir(projectRoot, { recursive: true });

  let coreUp = false;
  let replayCalls = 0;
  const s = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (!coreUp) { req.socket.destroy(); return; }
    if (req.url === '/v1/outbox/replay') { replayCalls += 1; return json(res, 200, { attempted: 0, delivered: [], failed: [], abandoned: [] }); }
    if (req.url === '/v1/prepare') {
      return json(res, 200, { protocolVersion: 1, knowledgeRevision: 4, mode: 'Managed', norms: [], workflows: [], context: 'recovered context' });
    }
    if (req.url === '/v1/tasks/list') return json(res, 200, { tasks: [] });
    if (req.url === '/v1/events') return json(res, 200, { id: 'e', stored: true, duplicate: false });
    return json(res, 404, { error: 'not found', body });
  });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  servers.add(s);
  const { port } = s.address();

  const configPath = join(dir, 'client.json');
  await writeFile(configPath, JSON.stringify({
    endpoint: `http://127.0.0.1:${port}`,
    token: 'x'.repeat(32),
    projectId: PROJECT,
    projectRoot,
  }), 'utf8');

  const oldEnv = process.env.AMB_DSH_CONFIG;
  process.env.AMB_DSH_CONFIG = configPath;
  const base = new Context();
  const tools = { register: () => () => {}, guard: () => () => {} };
  const toolsFiber = base.plugin({ name: 'f05-tools', apply(c) { c.provide('tools', tools); } });
  await toolsFiber;
  const fiber = base.plugin(adapter);
  await fiber;

  try {
    const agent = { id: 'session-f05', session: { header: { cwd: projectRoot } }, inject: () => {} };
    const runStep = (text) => base.waterfall('agent/pre-step', {
      agent,
      messages: [{ id: 'm-' + Math.random().toString(36).slice(2), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }],
      turn: 1, step: 1, signal: new AbortController().signal,
    }, async () => ({ kind: 'enter', messages: [] }));

    // Core down on the session's first entry: no replay request can be answered.
    await runStep('继续工作');
    assert.equal(replayCalls, 0, '核心不可达时不应产生成功的重放请求');

    // Core recovers; the same session's next step is the
    // unreachable→reachable transition and must replay exactly once.
    coreUp = true;
    await runStep('继续工作');
    assert.equal(replayCalls, 1, '核心恢复后同一会话必须触发受控重放一次');
    // Further turns must not replay again (no per-turn retry loop).
    await runStep('继续工作');
    await runStep('继续工作');
    assert.equal(replayCalls, 1, '重放后不得每轮无节制重试');
  } finally {
    if (oldEnv === undefined) delete process.env.AMB_DSH_CONFIG; else process.env.AMB_DSH_CONFIG = oldEnv;
    await fiber.dispose();
    await toolsFiber.dispose();
  }
});

test('F06: 适配器透传核心结构化错误（code/message/retryable），不再只剩 HTTP 409', { skip: runtimeSkip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'amb-f06-errors-'));
  tempDirs.add(dir);
  const projectRoot = join(dir, 'project');
  await mkdir(projectRoot, { recursive: true });

  const s = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    if (req.url === '/v1/expand') {
      return json(res, 409, { code: 'dependency_unavailable', message: 'Required dependency realistic-prerequisite@1 is not current' });
    }
    if (req.url === '/v1/proposals') {
      return json(res, 409, { code: 'idempotency_conflict', message: 'Same idempotency key has different content' });
    }
    return json(res, 200, {});
  });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  servers.add(s);
  const { port } = s.address();

  const configPath = join(dir, 'client.json');
  await writeFile(configPath, JSON.stringify({
    endpoint: `http://127.0.0.1:${port}`,
    token: 'x'.repeat(32),
    projectId: PROJECT,
    projectRoot,
  }), 'utf8');

  const oldEnv = process.env.AMB_DSH_CONFIG;
  process.env.AMB_DSH_CONFIG = configPath;
  const base = new Context();
  const registeredTools = new Map();
  const tools = {
    guard: () => () => {},
    register(definition) { registeredTools.set(definition.name, definition); return () => registeredTools.delete(definition.name); },
  };
  const toolsFiber = base.plugin({ name: 'f06-tools', apply(c) { c.provide('tools', tools); } });
  await toolsFiber;
  const fiber = base.plugin(adapter);
  await fiber;

  try {
    const agent = { id: 'session-f06', session: { header: { cwd: projectRoot } }, inject: () => {} };
    const readStage = registeredTools.get('amb_read_stage');
    await assert.rejects(
      () => readStage.execute({ workflowId: 'w', stageId: 's' }, { agent, signal: new AbortController().signal }),
      (err) => {
        assert.equal(err.status, 409);
        assert.equal(err.code, 'dependency_unavailable');
        assert.match(err.message, /dependency_unavailable/);
        assert.match(err.message, /realistic-prerequisite@1/);
        assert.equal(err.retryable, false, '4xx 是可修正的决定，不是可重试故障');
        return true;
      },
      '核心原因必须随错误透传',
    );

    // 同键异文必须可被调用方按 code 区分
    const submit = registeredTools.get('amb_submit_experience');
    await assert.rejects(
      () => submit.execute({ idempotencyKey: 'k', discovery: 'x' }, { agent, signal: new AbortController().signal }),
      (err) => {
        assert.equal(err.code, 'idempotency_conflict');
        return true;
      },
    );
  } finally {
    if (oldEnv === undefined) delete process.env.AMB_DSH_CONFIG; else process.env.AMB_DSH_CONFIG = oldEnv;
    await fiber.dispose();
    await toolsFiber.dispose();
  }
});

test('F08: amb_prepare 接受 query 并真实用于检索；不传 query 时不检索', { skip: runtimeSkip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'amb-f08-prepare-'));
  tempDirs.add(dir);
  const projectRoot = join(dir, 'project');
  await mkdir(projectRoot, { recursive: true });

  const prepareBodies = [];
  const s = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (req.url === '/v1/prepare') {
      prepareBodies.push(body);
      return json(res, 200, { protocolVersion: 1, knowledgeRevision: 1, mode: 'Managed', norms: [], workflows: [], context: 'ctx' });
    }
    return json(res, 200, {});
  });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  servers.add(s);
  const { port } = s.address();

  const configPath = join(dir, 'client.json');
  await writeFile(configPath, JSON.stringify({
    endpoint: `http://127.0.0.1:${port}`,
    token: 'x'.repeat(32),
    projectId: PROJECT,
    projectRoot,
  }), 'utf8');

  const oldEnv = process.env.AMB_DSH_CONFIG;
  process.env.AMB_DSH_CONFIG = configPath;
  const base = new Context();
  const registeredTools = new Map();
  const tools = {
    guard: () => () => {},
    register(definition) { registeredTools.set(definition.name, definition); return () => registeredTools.delete(definition.name); },
  };
  const toolsFiber = base.plugin({ name: 'f08-tools', apply(c) { c.provide('tools', tools); } });
  await toolsFiber;
  const fiber = base.plugin(adapter);
  await fiber;

  try {
    const prepare = registeredTools.get('amb_prepare');
    assert.ok(prepare.parameters.properties.query, '工具 schema 必须声明 query，模型才能按任务检索');
    const agent = { id: 'session-f08', session: { header: { cwd: projectRoot } }, inject: () => {} };
    await prepare.execute({ query: '资料交付' }, { agent, signal: new AbortController().signal });
    assert.equal(prepareBodies.at(-1).query, '资料交付', 'query 必须真实传到核心');
    await prepare.execute({}, { agent, signal: new AbortController().signal });
    assert.equal(prepareBodies.at(-1).query, undefined, '未提供 query 时不得伪造检索条件');
  } finally {
    if (oldEnv === undefined) delete process.env.AMB_DSH_CONFIG; else process.env.AMB_DSH_CONFIG = oldEnv;
    await fiber.dispose();
    await toolsFiber.dispose();
  }
});

test('F03: 交接块携带会话真实触碰的文件与进度，并只注入一次', { skip: runtimeSkip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'amb-f03-handoff-'));
  tempDirs.add(dir);
  const projectRoot = join(dir, 'project');
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, 'delivery.md'), '# 交付\n', 'utf8');

  const recorded = [];
  const s = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (req.url === '/v1/tasks/list') {
      return json(res, 200, { tasks: [{ id: 'task-f03', title: '交付任务', status: 'in_progress', sessionIds: ['session-a'], files: [], unfinished: [] }] });
    }
    if (req.url === '/v1/tasks/handoff') {
      return json(res, 200, {
        task: { id: 'task-f03', title: '交付任务', status: 'in_progress', sessionIds: ['session-a'], files: [], unfinished: [] },
        knowledgeRevision: 2, norms: [], workflows: [],
        files: [], suggestion: '继续', caveat: '接收端需重新确认文件与环境状态',
      });
    }
    if (req.url === '/v1/tasks/record') { recorded.push(body.task); return json(res, 200, { ok: true }); }
    if (req.url === '/v1/prepare') {
      return json(res, 200, { protocolVersion: 1, knowledgeRevision: 2, mode: 'Managed', norms: [], workflows: [], context: 'ctx' });
    }
    return json(res, 200, {});
  });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  servers.add(s);
  const { port } = s.address();

  const configPath = join(dir, 'client.json');
  await writeFile(configPath, JSON.stringify({
    endpoint: `http://127.0.0.1:${port}`,
    token: 'x'.repeat(32),
    projectId: PROJECT,
    projectRoot,
  }), 'utf8');

  const oldEnv = process.env.AMB_DSH_CONFIG;
  process.env.AMB_DSH_CONFIG = configPath;
  const base = new Context();
  const tools = { register: () => () => {}, guard: () => () => {} };
  const toolsFiber = base.plugin({ name: 'f03-tools', apply(c) { c.provide('tools', tools); } });
  await toolsFiber;
  const fiber = base.plugin(adapter);
  await fiber;

  try {
    // 会话事件流使用真实 DSH 形状：tool/call 带 name+callId（无 message），
    // tool/result 带 message+toolCallId（无 name），两者靠 callId 配对。
    const session = { id: 'session-f03', header: { cwd: projectRoot } };
    base.emit('session/event', session, { type: 'tool/call', data: { name: 'write', callId: 'call-w', arguments: JSON.stringify({ file_path: join(projectRoot, 'delivery.md'), content: '# 交付\n' }) } });
    base.emit('session/event', session, { type: 'tool/result', data: { message: { toolCallId: 'call-w', content: [{ type: 'text', text: 'Created file' }], isError: false } } });

    const injected = [];
    const agent = { id: 'session-f03', session: { header: { cwd: projectRoot } }, inject: (m) => injected.push(m) };
    const runStep = () => base.waterfall('agent/pre-step', {
      agent,
      messages: [{ id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续这个任务' }] }],
      turn: 1, step: 1, signal: new AbortController().signal,
    }, async () => ({ kind: 'enter', messages: [] }));

    await runStep();
    const handoffMessages = injected.filter(m => m.content[0].text.includes('[Task Handoff]'));
    assert.equal(handoffMessages.length, 1, '交接块必须注入');
    assert.match(handoffMessages[0].content[0].text, /delivery\.md/, '交接必须列出会话真实触碰的文件');
    assert.match(handoffMessages[0].content[0].text, /Progress:.*write/, '交接必须携带按 callId 配对出的真实进度（工具名）');
    assert.ok(recorded.some(t => Array.isArray(t.files) && t.files.some(f => String(f).includes('delivery.md'))), '触碰的文件必须写回任务记录');

    // 关键回归反例：会话继续做更多工具调用（每次输出都不同）。
    // 内容随活动变化的 ack 会让交接在每一步都重新注入——这正是 F03 的重复模式，
    // 复核方用 9 个工具步骤观察到 9 次注入。这里逐字复现该序列并断言只有 1 次。
    for (let i = 0; i < 9; i += 1) {
      base.emit('session/event', session, { type: 'tool/call', data: { name: 'pwsh', callId: `call-p${i}`, arguments: JSON.stringify({ command: `Get-ChildItem delivery${i}.md` }) } });
      base.emit('session/event', session, { type: 'tool/result', data: { message: { toolCallId: `call-p${i}`, content: [{ type: 'text', text: `delivery.md   ${10 + i} bytes` }], isError: false } } });
      await runStep();
    }
    const after = injected.filter(m => m.content[0].text.includes('[Task Handoff]'));
    assert.equal(after.length, 1, '9 个活动步骤之后，同一交接仍必须只注入一次（按任务，而非按内容）');
  } finally {
    if (oldEnv === undefined) delete process.env.AMB_DSH_CONFIG; else process.env.AMB_DSH_CONFIG = oldEnv;
    await fiber.dispose();
    await toolsFiber.dispose();
  }
});

test('F03-crosstask: 同一会话切换任务时，前一个任务的文件不得泄漏进后一个任务', { skip: runtimeSkip }, async () => {
  // 独立复核发现的缺陷：文件累加器若按会话（或插件）而非按（会话, 任务）保存，
  // 同一会话先做 task-A 再做 task-B 时，task-A 的文件会出现在 task-B 的记录与交接里。
  const dir = await mkdtemp(join(tmpdir(), 'amb-f03-crosstask-'));
  tempDirs.add(dir);
  const projectRoot = join(dir, 'project');
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, 'a-only.md'), 'A\n', 'utf8');
  await writeFile(join(projectRoot, 'b-only.md'), 'B\n', 'utf8');

  const tasks = {
    'task-A': { id: 'task-A', title: '任务A', status: 'in_progress', sessionIds: ['s'], files: [], unfinished: [] },
    'task-B': { id: 'task-B', title: '任务B', status: 'in_progress', sessionIds: ['s'], files: [], unfinished: [] },
  };
  const recorded = [];
  const s = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (req.url === '/v1/tasks/list') return json(res, 200, { tasks: Object.values(tasks) });
    if (req.url === '/v1/tasks/handoff') {
      const task = tasks[body.taskId] ?? tasks['task-A'];
      return json(res, 200, { task, knowledgeRevision: 2, norms: [], workflows: [], files: task.files, suggestion: '继续', caveat: 'x' });
    }
    if (req.url === '/v1/tasks/record') {
      recorded.push({ taskId: body.task.id, files: body.task.files });
      tasks[body.task.id] = { ...tasks[body.task.id], ...body.task };
      return json(res, 200, { ok: true });
    }
    if (req.url === '/v1/prepare') return json(res, 200, { protocolVersion: 1, knowledgeRevision: 2, mode: 'Managed', norms: [], workflows: [], context: 'ctx' });
    return json(res, 200, {});
  });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  servers.add(s);
  const { port } = s.address();

  const configPath = join(dir, 'client.json');
  await writeFile(configPath, JSON.stringify({ endpoint: `http://127.0.0.1:${port}`, token: 'x'.repeat(32), projectId: PROJECT, projectRoot }), 'utf8');
  const oldEnv = process.env.AMB_DSH_CONFIG;
  process.env.AMB_DSH_CONFIG = configPath;
  const base = new Context();
  const tools = { register: () => () => {}, guard: () => () => {} };
  const toolsFiber = base.plugin({ name: 'f03x-tools', apply(c) { c.provide('tools', tools); } });
  await toolsFiber;
  const fiber = base.plugin(adapter);
  await fiber;

  try {
    const session = { id: 'session-x', header: { cwd: projectRoot } };
    // Events are UNTAGGED, matching the real host (the verifier found the host does
    // not put a taskId on session events). Task attribution therefore relies on the
    // pre-step agent's header, and file segmentation on the per-step cohort.
    const emitWrite = (callId, file) => {
      base.emit('session/event', session, { type: 'tool/call', data: { name: 'write', callId, arguments: JSON.stringify({ file_path: join(projectRoot, file), content: 'x' }) } });
      base.emit('session/event', session, { type: 'tool/result', data: { message: { toolCallId: callId, content: [{ type: 'text', text: 'Created' }], isError: false } } });
    };
    const agentFor = (taskId) => ({ id: 'session-x', session: { header: { cwd: projectRoot, taskId } }, inject: () => {} });
    const runStep = (taskId) => base.waterfall('agent/pre-step', {
      agent: agentFor(taskId),
      messages: [{ id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续这个任务' }] }],
      turn: 1, step: 1, signal: new AbortController().signal,
    }, async () => ({ kind: 'enter', messages: [] }));

    // task-A: touch a-only.md
    emitWrite('c-a', 'a-only.md');
    await runStep('task-A');
    const aFiles = recorded.find(r => r.taskId === 'task-A')?.files ?? [];
    assert.ok(aFiles.some(f => String(f).includes('a-only.md')), 'task-A 必须记录 a-only.md');

    // task-B in the same session: touch b-only.md
    emitWrite('c-b', 'b-only.md');
    await runStep('task-B');
    const bFiles = recorded.filter(r => r.taskId === 'task-B').at(-1)?.files ?? [];
    assert.ok(bFiles.some(f => String(f).includes('b-only.md')), 'task-B 必须记录 b-only.md');
    assert.equal(bFiles.some(f => String(f).includes('a-only.md')), false, 'task-A 的文件绝不得泄漏进 task-B');
  } finally {
    if (oldEnv === undefined) delete process.env.AMB_DSH_CONFIG; else process.env.AMB_DSH_CONFIG = oldEnv;
    await fiber.dispose();
    await toolsFiber.dispose();
  }
});
