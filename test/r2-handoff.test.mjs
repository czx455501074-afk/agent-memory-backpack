import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after } from 'node:test';
import { spawn } from 'node:child_process';
import { inspectRuntime, runtimeRoot } from './dsh-target.mjs';

const runtimeProbe = inspectRuntime();
const runtimeSkip = runtimeProbe.available ? false : runtimeProbe.reason;
const cordisUrl = pathToFileURL(resolve(runtimeRoot, '@deepseek-ai/cordis/lib/index.js'));
const { Context } = runtimeProbe.available ? await import(cordisUrl.href) : { Context: class {} };
const adapter = await import('../adapters/dsh/index.mjs');
const hookPath = resolve('adapters/codex/scripts/hook.mjs');

let server;
let endpoint;
const servers = new Set();
const tempDirs = new Set();

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

after(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise(r => s.close(r));
  }
  for (const d of tempDirs) {
    await rm(d, { recursive: true, force: true });
  }
});

function runHook(input, configPath) {
  return new Promise((resolveRun, reject) => {
    const env = { ...process.env, AMB_CONFIG: configPath };
    const child = spawn(process.execPath, [hookPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), 10000);
    child.stdout.setEncoding('utf8').on('data', c => { stdout += c; });
    child.stderr.setEncoding('utf8').on('data', c => { stderr += c; });
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('close', status => { clearTimeout(timer); resolveRun({ status, stdout, stderr }); });
    child.stdin.end(JSON.stringify(input));
  });
}

test('R2-a: DSH 接续已有任务：用户表达接续意图时，查询任务列表、获取交接、追加当前 session 并注入 [Task Handoff]', { skip: runtimeSkip }, async () => {
  const requests = [];
  const initialTask = {
    id: 'task-dsh-prev',
    title: '重构认证模块',
    status: 'paused',
    startedAt: 1000,
    summary: '已完成基础结构，暂停待接续',
    notes: '',
    unfinished: ['修复刷新令牌边界测试'],
    sessionIds: ['session-old'],
    files: ['src/auth.ts', 'test/auth.test.ts'],
  };
  let currentTask = { ...initialTask };

  const s = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    requests.push({ url: req.url, body });

    if (req.url === '/v1/tasks/list') {
      return json(res, 200, { tasks: [currentTask] });
    }
    if (req.url === '/v1/tasks/handoff') {
      return json(res, 200, {
        task: currentTask,
        knowledgeRevision: 3,
        norms: [],
        workflows: [{ id: 'wf-auth', revision: 1, title: '认证流程', ready: true }],
        files: currentTask.files,
        verification: { verified: null, taskStatus: currentTask.status },
        suggestion: '继续处理未完成项：修复刷新令牌边界测试',
        caveat: '接收端需重新确认文件与环境状态；本交接不迁移运行中的进程、凭据或工具权限。上面的 files 只是需要核对的清单，不代表已经核对过。',
      });
    }
    if (req.url === '/v1/tasks/record') {
      currentTask = { ...body.task };
      return json(res, 200, { ok: true });
    }
    if (req.url === '/v1/prepare') {
      return json(res, 200, {
        protocolVersion: 1, knowledgeRevision: 3, mode: 'Managed', norms: [], workflows: [], context: 'Standard knowledge context.',
      });
    }
    if (req.url === '/v1/events') {
      return json(res, 200, { id: 'evt-1', stored: true, duplicate: false });
    }
    return json(res, 404, { error: 'not found' });
  });

  await new Promise(r => s.listen(0, '127.0.0.1', r));
  servers.add(s);
  const { port } = s.address();

  const dir = await mkdtemp(join(tmpdir(), 'amb-r2-dsh-'));
  tempDirs.add(dir);
  const projectRoot = join(dir, 'project');
  await mkdir(projectRoot);
  const configPath = join(dir, 'client.json');
  await writeFile(configPath, JSON.stringify({
    endpoint: `http://127.0.0.1:${port}`,
    token: 'x'.repeat(32),
    projectId: 'p0-workflow',
    projectRoot,
  }), 'utf8');

  const oldEnv = process.env.AMB_DSH_CONFIG;
  process.env.AMB_DSH_CONFIG = configPath;

  const base = new Context();
  const tools = { register: () => () => {}, guard: () => () => {} };
  const toolsFiber = base.plugin({ name: 'p0-test-tools', apply(c) { c.provide('tools', tools); } });
  await toolsFiber;
  const fiber = base.plugin(adapter.default);
  await fiber;

  try {
    const injected = [];
    const agent = {
      id: 'session-dsh-new',
      session: { header: { cwd: projectRoot } },
      inject(m) { injected.push(m); },
    };

    // Agent pre-step with continuation query
    const userMessage = {
      id: 'msg-1',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '请继续之前的工作，完成未尽事宜。' }],
    };

    const preStep = await base.waterfall('agent/pre-step', {
      agent,
      messages: [userMessage],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }, async () => ({ kind: 'enter', messages: [userMessage] }));

    // 1. tasks/list, tasks/handoff, tasks/record should be called
    assert.equal(requests.some(r => r.url === '/v1/tasks/list'), true, '必须查询任务列表');
    assert.equal(requests.some(r => r.url === '/v1/tasks/handoff'), true, '必须获取交接详情');
    assert.equal(requests.some(r => r.url === '/v1/tasks/record'), true, '必须更新任务 sessionIds');

    // 2. The task's sessionIds in core must now contain 'session-dsh-new'
    assert.deepEqual(currentTask.sessionIds, ['session-old', 'session-dsh-new'], '必须将当前 sessionId 追加进任务');

    // 3. Injected context must contain [Task Handoff] and caveat
    const handoffMsg = preStep.messages.find(m => m.source?.kind === 'agent-memory-backpack');
    assert.ok(handoffMsg);
    const handoffText = handoffMsg.content.at(-1).text;
    assert.match(handoffText, /\[Task Handoff\]/);
    assert.match(handoffText, /task-dsh-prev/);
    assert.match(handoffText, /修复刷新令牌边界测试/);
    assert.match(handoffText, /接收端需重新确认文件与环境状态/);

    // 4. Subsequent session/event must carry the taskId
    await base.emit('session/event', {
      id: 'session-dsh-new',
      header: { cwd: projectRoot },
    }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } });

    // Wait for the async void client.post('/v1/events') to arrive
    for (let i = 0; i < 50; i++) {
      if (requests.some(r => r.url === '/v1/events' && r.body.kind === 'turn_stopped')) break;
      await new Promise(r => setTimeout(r, 20));
    }

    const stopReq = requests.find(r => r.url === '/v1/events' && r.body.kind === 'turn_stopped');
    assert.ok(stopReq, '必须发送 turn_stopped 事件');
    assert.equal(stopReq.body.taskId, 'task-dsh-prev', '事件必须携带已接续的 taskId');
  } finally {
    if (oldEnv === undefined) delete process.env.AMB_DSH_CONFIG;
    else process.env.AMB_DSH_CONFIG = oldEnv;
    await fiber.dispose();
    await toolsFiber.dispose();
  }
});

test('R2-b: Codex 会话绑定既有任务：SessionStart 绑定 taskId，提取交接，追加 session，后续 PreToolUse 与 Stop 沿用', async () => {
  const requests = [];
  let currentTask = {
    id: 'task-codex-1',
    title: '数据迁移测试',
    status: 'paused',
    startedAt: 2000,
    summary: '迁移中',
    unfinished: ['核对索引数量'],
    sessionIds: ['session-prev'],
    files: ['knowledge.sqlite'],
  };

  const s = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    requests.push({ url: req.url, body });

    if (req.url === '/v1/tasks/handoff') {
      return json(res, 200, {
        task: currentTask,
        knowledgeRevision: 8,
        norms: [],
        workflows: [],
        files: currentTask.files,
        suggestion: '核对索引数量',
        caveat: '接收端需重新确认文件与环境状态；本交接不迁移运行中的进程、凭据或工具权限。上面的 files 只是需要核对的清单，不代表已经核对过。',
      });
    }
    if (req.url === '/v1/tasks/record') {
      currentTask = { ...body.task };
      return json(res, 200, { ok: true });
    }
    if (req.url === '/v1/prepare') {
      return json(res, 200, {
        protocolVersion: 1, knowledgeRevision: 8, mode: 'Managed', norms: [], workflows: [], context: 'Codex base context',
      });
    }
    if (req.url === '/v1/gate') {
      return json(res, 200, {
        decision: 'allow', reason: '', knowledgeRevision: 8, context: '', deniedTools: [],
      });
    }
    if (req.url === '/v1/events') {
      return json(res, 200, { id: 'evt-c-1', stored: true, duplicate: false });
    }
    return json(res, 404, { error: 'not found' });
  });

  await new Promise(r => s.listen(0, '127.0.0.1', r));
  servers.add(s);
  const { port } = s.address();

  const dir = await mkdtemp(join(tmpdir(), 'amb-r2-codex-'));
  tempDirs.add(dir);
  const projectRoot = join(dir, 'project');
  await mkdir(projectRoot);
  const configPath = join(dir, 'client.json');
  await writeFile(configPath, JSON.stringify({
    endpoint: `http://127.0.0.1:${port}`,
    token: 'x'.repeat(32),
    projectId: 'p0-workflow',
    projectRoot,
  }), 'utf8');

  // 1. SessionStart with task_id
  const startRes = await runHook({
    hook_event_name: 'SessionStart',
    session_id: 'session-codex-new',
    task_id: 'task-codex-1',
    cwd: projectRoot,
  }, configPath);

  assert.equal(startRes.status, 0);
  assert.equal(requests.some(r => r.url === '/v1/tasks/handoff'), true, 'SessionStart 必须调用 handoff');
  assert.equal(requests.some(r => r.url === '/v1/tasks/record'), true, 'SessionStart 必须追加 sessionIds');
  assert.deepEqual(currentTask.sessionIds, ['session-prev', 'session-codex-new']);

  // Context must contain [Task Handoff]
  const parsedStart = JSON.parse(startRes.stdout.trim());
  const injectedText = parsedStart.hookSpecificOutput?.additionalContext;
  assert.match(injectedText, /\[Task Handoff\]/);
  assert.match(injectedText, /task-codex-1/);
  assert.match(injectedText, /核对索引数量/);

  // 2. PreToolUse without passing task_id: should automatically carry taskId from session state!
  const gateRes = await runHook({
    hook_event_name: 'PreToolUse',
    session_id: 'session-codex-new',
    tool_name: 'Bash',
    cwd: projectRoot,
  }, configPath);

  assert.equal(gateRes.status, 0);
  const gateReq = requests.find(r => r.url === '/v1/gate');
  assert.ok(gateReq);
  assert.equal(gateReq.body.taskId, 'task-codex-1', 'PreToolUse 必须自动携带缓存中的 taskId');

  // 3. Stop without passing task_id: should automatically carry taskId from session state!
  const stopRes = await runHook({
    hook_event_name: 'Stop',
    session_id: 'session-codex-new',
    cwd: projectRoot,
  }, configPath);

  assert.equal(stopRes.status, 0);
  const stopReq = requests.find(r => r.url === '/v1/events' && r.body.kind === 'turn_stopped');
  assert.ok(stopReq);
  assert.equal(stopReq.body.taskId, 'task-codex-1', 'Stop 事件必须自动携带缓存中的 taskId');
});

test('R2-c: 范围外 cwd 严格拦截，不向核心发送任务请求', async () => {
  const requests = [];
  const s = createServer(async (req, res) => {
    requests.push(req.url);
    json(res, 200, {});
  });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  servers.add(s);
  const { port } = s.address();

  const dir = await mkdtemp(join(tmpdir(), 'amb-r2-scope-'));
  tempDirs.add(dir);
  const projectRoot = join(dir, 'project');
  const outside = join(dir, 'outside');
  await mkdir(projectRoot);
  await mkdir(outside);
  const configPath = join(dir, 'client.json');
  await writeFile(configPath, JSON.stringify({
    endpoint: `http://127.0.0.1:${port}`,
    token: 'x'.repeat(32),
    projectId: 'p0-workflow',
    projectRoot,
  }), 'utf8');

  // Codex hook with outside cwd
  const hookRes = await runHook({
    hook_event_name: 'SessionStart',
    session_id: 'session-out',
    task_id: 'task-out',
    cwd: outside,
  }, configPath);

  assert.equal(hookRes.status, 0, '范围外 Codex hook 静默跳过，退出码 0');
  assert.equal(hookRes.stdout, '', '范围外无标准输出');
  assert.equal(requests.length, 0, '范围外不得向核心发送任何任务请求');
});
