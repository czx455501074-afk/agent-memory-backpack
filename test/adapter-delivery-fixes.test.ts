import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { coreSchema, resolveConfigPath } from '../src/config.js';
import { CoreClient, isWithinProject } from '../src/client.js';
import { exportSkills, EXPORT_MARKER } from '../src/export-skills.js';
import { Store } from '../src/store.js';
import { skillSchema, workflowSchema } from '../src/schema.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const hookPath = join(repoRoot, 'adapters/codex/scripts/hook.mjs');
const dshGateCacheModule = join(repoRoot, 'adapters/dsh/gate-cache.mjs');
const loadGateCache = async () => {
  return await import(pathToFileURL(dshGateCacheModule).href) as {
    saveSnapshot: (dir: string, snapshot: any, identity?: any) => any;
    loadSnapshot: (dir: string, identityOrNow?: any, maybeNow?: number) => any;
    operatingMode: (opts: { coreReachable: boolean; snapshot: any }) => { mode: string; detail: string };
    decideFromSnapshot: (record: any, toolName: string, identity?: any) => 'allow' | 'deny';
  };
};

function runHook(input: any, configPath: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  if (configPath && !Object.hasOwn(input, 'cwd')) {
    input = { ...input, cwd: join(dirname(configPath), 'project') };
  }
  return new Promise((resolve, reject) => {
    const env = { ...process.env, AMB_CONFIG: configPath };
    const child = spawn(process.execPath, [hookPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), 10000);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.stdin.end(JSON.stringify(input));
  });
}

function tempDir(prefix = 'amb-fix-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('F21: coreSchema 拒绝重复 client.id 与重复 client.token', () => {
  const valid = {
    protocolVersion: 1,
    port: 47631,
    clients: [
      { id: 'codex', token: 'a'.repeat(32), projectId: 'p1', role: 'adapter' },
      { id: 'dsh', token: 'b'.repeat(32), projectId: 'p1', role: 'adapter' },
    ],
  };
  assert.doesNotThrow(() => coreSchema.parse(valid));

  const duplicateId = {
    protocolVersion: 1,
    port: 47631,
    clients: [
      { id: 'codex', token: 'a'.repeat(32), projectId: 'p1', role: 'adapter' },
      { id: 'codex', token: 'b'.repeat(32), projectId: 'p2', role: 'adapter' },
    ],
  };
  assert.throws(() => coreSchema.parse(duplicateId), /Duplicate client id: codex/);

  const duplicateToken = {
    protocolVersion: 1,
    port: 47631,
    clients: [
      { id: 'codex', token: 'a'.repeat(32), projectId: 'p1', role: 'adapter' },
      { id: 'dsh', token: 'a'.repeat(32), projectId: 'p1', role: 'adapter' },
    ],
  };
  assert.throws(() => coreSchema.parse(duplicateToken), /Duplicate client token/);
});

test('F22: 空白 AMB_DSH_CONFIG 正确回退到有效 AMB_CONFIG，且警告精确点名', () => {
  const dir = tempDir();
  try {
    const validFile = join(dir, 'custom.json');
    writeFileSync(validFile, '{}');
    const resolved = resolveConfigPath('dsh', { AMB_DSH_CONFIG: '', AMB_CONFIG: validFile });
    assert.equal(resolved.path, validFile);
    assert.equal(resolved.warning, null);

    const staleDsh = resolveConfigPath('dsh', {
      AMB_DSH_CONFIG: join(dir, 'nope.json'),
      AMB_CONFIG: validFile,
    });
    assert.ok(staleDsh.warning);
    assert.match(staleDsh.warning, /AMB_DSH_CONFIG/);
    assert.equal(staleDsh.warning.includes('AMB_DSH_CONFIG/AMB_CONFIG'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * F11: the project-scope predicate exists and is used where cwd is meaningful.
 *
 * The predicate itself is checked directly. What is deliberately *not* asserted is
 * that `CoreClient.post` refuses on cwd: the Codex MCP server is launched by the host
 * from the plugin directory (`.mcp.json` declares `"cwd": "."`), so gating its
 * requests on the process working directory refused every legitimate call and broke
 * the pre-existing packaged smoke test with "Connection closed".
 *
 * The protection that actually holds on that path is the credential's project pin,
 * enforced by the core on every request — covered by the cross-project cases in the
 * main suite and in `probe-mcp-cwd-boundary`. The Codex hook and the DSH adapter keep
 * using this predicate against the cwd that comes from their own payloads.
 */
test('F11: isWithinProject 判定正确，且 DSH/Codex hook 仍按其会话 cwd 拦截', async () => {
  const dir = tempDir();
  try {
    const project = join(dir, 'proj');
    const nested = join(project, 'sub', 'deep');
    const outside = join(dir, 'other');
    mkdirSync(nested, { recursive: true });
    mkdirSync(outside);

    assert.equal(isWithinProject(project, project), true, '项目根自身属于范围内');
    assert.equal(isWithinProject(project, nested), true, '子目录属于范围内');
    assert.equal(isWithinProject(project, outside), false, '项目外目录不属于范围内');
    assert.equal(isWithinProject(project, dir), false, '上级目录不属于范围内');
    assert.equal(isWithinProject(project, 'relative/path'), false, '相对路径不可判定为范围内');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * F11 (behaviour): neither adapter sends a request from far outside its project.
 *
 * Both ends gate on the cwd their own host reports — DSH on the session header, the
 * Codex hook on the invocation payload — so this checks the observable effect rather
 * than the predicate: with an out-of-scope cwd, no request reaches the core.
 */
test('F11: 范围外 cwd 下两端都不向核心发起请求', async () => {
  const requests: string[] = [];
  const core = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    requests.push(String(req.url));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, protocolVersion: 1, knowledgeRevision: 1, mode: 'Managed', norms: [], workflows: [], context: '' }));
  });
  await new Promise<void>(resolve => core.listen(0, '127.0.0.1', resolve));
  const { port } = core.address() as { port: number };
  const dir = tempDir();
  try {
    const projectRoot = join(dir, 'proj');
    const outside = join(dir, 'other');
    mkdirSync(projectRoot);
    mkdirSync(outside);
    const configPath = join(dir, 'client.json');
    writeFileSync(configPath, JSON.stringify({
      endpoint: `http://127.0.0.1:${port}`, token: 'x'.repeat(32), projectId: 'proj-1', projectRoot,
    }));

    // The hook is given a cwd outside projectRoot: it must not call the core.
    const hookRes = await runHook({
      hook_event_name: 'PreToolUse', session_id: 's-out', cwd: outside, tool_name: 'Bash', tool_input: {},
    }, configPath);
    assert.equal(hookRes.status, 0, '范围外必须静默跳过，而不是失败');
    assert.equal(requests.length, 0, `范围外 cwd 下不得发起请求，实际：${requests.join(', ')}`);

    // And the same hook inside the project does reach the core, so the check is not
    // simply refusing everything.
    const insideRes = await runHook({
      hook_event_name: 'PreToolUse', session_id: 's-in', cwd: projectRoot, tool_name: 'Bash', tool_input: {},
    }, configPath);
    assert.equal(insideRes.status, 0);
    assert.ok(requests.includes('/v1/gate'), `范围内必须发起门禁请求，实际：${requests.join(', ')}`);
  } finally {
    core.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F12: 快照绑定项目与核心身份，不同项目隔离且不相互覆盖或误裁', async () => {
  const { saveSnapshot, loadSnapshot, operatingMode, decideFromSnapshot } = await loadGateCache();
  const dir = tempDir();
  try {
    // Project alpha saves snapshot denying Bash
    saveSnapshot(dir, {
      deniedTools: ['Bash'],
      revision: 1,
      at: Date.now(),
    }, { projectId: 'alpha', endpoint: 'http://127.0.0.1:47631' });

    // Project beta saves snapshot with empty deniedTools
    saveSnapshot(dir, {
      deniedTools: [],
      revision: 1,
      at: Date.now(),
    }, { projectId: 'beta', endpoint: 'http://127.0.0.1:47631' });

    // Beta loads snapshot: must get empty deniedTools, NOT alpha's Bash denial
    const betaSnap = loadSnapshot(dir, { projectId: 'beta', endpoint: 'http://127.0.0.1:47631' });
    assert.equal(betaSnap.state, 'usable');
    assert.deepEqual(betaSnap.record.deniedTools, []);
    assert.equal(decideFromSnapshot(betaSnap.record, 'Bash', { projectId: 'beta' }), 'allow');

    // Alpha loads snapshot: must STILL have Bash denied
    const alphaSnap = loadSnapshot(dir, { projectId: 'alpha', endpoint: 'http://127.0.0.1:47631' });
    assert.equal(alphaSnap.state, 'usable');
    assert.deepEqual(alphaSnap.record.deniedTools, ['Bash']);
    assert.equal(decideFromSnapshot(alphaSnap.record, 'Bash', { projectId: 'alpha' }), 'deny');

    // Gamma has no snapshot: mismatched identity drops to Ungoverned, never wrongly governed by alpha
    const gammaSnap = loadSnapshot(dir, { projectId: 'gamma', endpoint: 'http://127.0.0.1:47631' });
    const gammaMode = operatingMode({ coreReachable: false, snapshot: gammaSnap });
    assert.equal(gammaMode.mode, 'Ungoverned');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F10: 技能导出写入 references/ 正文、跳过 ready=false 失效父流程、清理已退役条目', () => {
  const dir = tempDir();
  const exportDir = join(dir, 'exported-skills');
  const store = new Store(join(dir, 'knowledge.sqlite'));
  try {
    // 1. Export skill with leaves
    const skill = skillSchema.parse({
      id: 'skill-ref-test',
      kind: 'skill',
      title: '带参考文档的技能',
      body: '这是技能主文档。',
      scope: { kind: 'global' },
      leaves: [
        { path: 'doc1.md', hash: 'h1', body: '参考文档一正文' },
        { path: 'references/doc2.md', hash: 'h2', body: '参考文档二正文' },
      ],
      needsStructure: false,
    });

    // 2. Export child workflow
    const childFlow = workflowSchema.parse({
      id: 'child-wf',
      kind: 'workflow',
      title: '子流程',
      overview: '子流程概览',
      triggers: ['触发'],
      scope: { kind: 'global' },
      preconditions: ['前提'],
      categories: [['通用']],
      tags: [],
      stages: [{ id: 's1', title: '阶段1', instructions: '指导', checks: ['检查'], dependencies: [] }],
      completion: ['完成'],
      recovery: '恢复',
      baseRevision: 0,
      isEntryPoint: true,
    });

    // 3. Export parent workflow depending on child-wf@1
    const parent = workflowSchema.parse({
      id: 'parent-wf',
      kind: 'workflow',
      title: '父流程',
      overview: '父流程概览',
      triggers: ['触发'],
      scope: { kind: 'global' },
      preconditions: ['前提'],
      categories: [['通用']],
      tags: [],
      stages: [{
        id: 'ps1', title: '阶段P1', instructions: '指导', checks: ['检查'],
        dependencies: [{ relationship: 'substep', workflowId: 'child-wf', revision: 1 }],
      }],
      completion: ['完成'],
      recovery: '恢复',
      baseRevision: 0,
      isEntryPoint: true,
    });

    store.import([skill, childFlow, parent]);

    // First export: both child-wf and parent-wf are ready
    const res1 = exportSkills(store, { directory: exportDir });
    assert.equal(res1.written.length >= 3, true);

    // Leaves must be written into references/
    const marker = JSON.parse(readFileSync(join(exportDir, EXPORT_MARKER), 'utf8'));
    const skillFolder = Object.keys(marker.skills).find(k => marker.skills[k].id === 'skill-ref-test');
    assert.ok(skillFolder);

    const ref1 = join(exportDir, skillFolder, 'doc1.md');
    const ref2 = join(exportDir, skillFolder, 'references', 'doc2.md');
    assert.equal(existsSync(ref1), true, '叶子1文件必须已写入');
    assert.equal(existsSync(ref2), true, '叶子2文件必须已写入');
    assert.equal(readFileSync(ref1, 'utf8'), '参考文档一正文');
    assert.equal(readFileSync(ref2, 'utf8'), '参考文档二正文');

    // 4. Retire child workflow: now parent-wf has unready dependency, and child-wf is retired.
    // Re-export: parent-wf must be skipped (ready=false), and old child-wf folder must be cleaned up!
    store.retire('child-wf', 1);
    const res2 = exportSkills(store, { directory: exportDir });
    assert.equal(res2.skipped.some(s => s.id === 'parent-wf'), true, '子流程退役后父流程 ready=false 必须被跳过');
    const childFolder = Object.keys(marker.skills).find(k => marker.skills[k].id === 'child-wf');
    assert.ok(childFolder);
    assert.equal(existsSync(join(exportDir, childFolder)), false, '退役条目的旧导出目录必须被清理');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F07: Codex hook 发送 Stop 事件携带 taskId', async () => {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ url: req.url, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'evt-1', stored: true, duplicate: false }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };

  const dir = tempDir();
  try {
    const projectRoot = join(dir, 'project');
    mkdirSync(projectRoot);
    const configPath = join(dir, 'client.json');
    writeFileSync(configPath, JSON.stringify({
      endpoint: `http://127.0.0.1:${port}`,
      token: 'x'.repeat(32),
      projectId: 'proj-1',
      projectRoot,
    }));

    const hookRes = await runHook({
      hook_event_name: 'Stop',
      session_id: 'session-xyz',
      task_id: 'task-abc',
      turn_id: 'turn-1',
    }, configPath);

    assert.equal(hookRes.status, 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/v1/events');
    assert.equal(requests[0].body.taskId, 'task-abc');
    assert.equal(requests[0].body.sessionId, 'session-xyz');
    assert.equal(requests[0].body.kind, 'turn_stopped');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F12: Codex hook 在核心返回 HTTP 426 协议不匹配时明确拒绝，不降级放行', async () => {
  const server = createServer(async (req, res) => {
    res.writeHead(426, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Upgrade Required' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };

  const dir = tempDir();
  try {
    const projectRoot = join(dir, 'project');
    mkdirSync(projectRoot);
    const configPath = join(dir, 'client.json');
    writeFileSync(configPath, JSON.stringify({
      endpoint: `http://127.0.0.1:${port}`,
      token: 'x'.repeat(32),
      projectId: 'proj-1',
      projectRoot,
    }));

    const hookRes = await runHook({
      hook_event_name: 'PreToolUse',
      session_id: 'session-xyz',
      tool_name: 'Bash',
      tool_input: {},
    }, configPath);

    const stdout = JSON.parse(hookRes.stdout.trim());
    assert.equal(stdout.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(stdout.hookSpecificOutput?.permissionDecisionReason, /426/);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('上下文预算: PreToolUse 在同版本、同会话下对已注入规范去重', async () => {
  const normText = 'PROJECT NORM '.repeat(200); // ~2600 chars
  const server = createServer(async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      decision: 'allow',
      reason: '',
      knowledgeRevision: 5,
      context: normText,
      deniedTools: [],
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };

  const dir = tempDir();
  try {
    const projectRoot = join(dir, 'project');
    mkdirSync(projectRoot);
    const configPath = join(dir, 'client.json');
    writeFileSync(configPath, JSON.stringify({
      endpoint: `http://127.0.0.1:${port}`,
      token: 'x'.repeat(32),
      projectId: 'proj-1',
      projectRoot,
    }));

    // First call: should inject context
    const res1 = await runHook({
      hook_event_name: 'PreToolUse',
      session_id: 'session-repeat',
      tool_name: 'ToolA',
    }, configPath);
    assert.equal(res1.stdout.includes(normText), true, '第一次调用必须注入规范');
    const firstChars = res1.stdout.length;

    // Second call: same session and same revision (5) -> should NOT duplicate context!
    const res2 = await runHook({
      hook_event_name: 'PreToolUse',
      session_id: 'session-repeat',
      tool_name: 'ToolB',
    }, configPath);
    assert.equal(res2.stdout.includes(normText), false, '第二次调用同版本规范不得重复注入');
    const secondChars = res2.stdout.length;

    assert.equal(secondChars < firstChars, true, `第二次调用输出字符数 (${secondChars}) 应远小于第一次 (${firstChars})`);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

