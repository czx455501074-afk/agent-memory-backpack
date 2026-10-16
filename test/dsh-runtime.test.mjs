import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Store } from '../dist/src/store.js';
import { createCoreServer } from '../dist/src/server.js';
import adapter from '../adapters/dsh/index.mjs';
import { inspectRuntime, isSupported, runtimeRoot, supportedRange, verifiedVersion } from './dsh-target.mjs';
import { existsSync, readFileSync } from 'node:fs';

// A cloned repository has no extracted desktop runtime. Skip with an explicit
// reason instead of failing the whole file at import time; a present-but-stale
// runtime still throws from inspectRuntime().
const runtimeProbe = inspectRuntime();
const skip = runtimeProbe.available ? false : runtimeProbe.reason;
const load = name => import(pathToFileURL(resolve(runtimeRoot, '@deepseek-ai', name, 'lib/index.js')).href);
const [{ Context }, { ToolRuntime }, { SystemPrompt }] = runtimeProbe.available
  ? await Promise.all([load('cordis'), load('dsh-tools'), load('dsh-system-prompt')])
  : [{}, {}, {}];

test('host runtime is inside the supported range and the manifest passes the real compatibility evaluator', { skip }, async () => {
  const { evaluatePluginCompatibility, getDshRuntimeVersion } = await load('dsh-app-boot');
  const manifest = JSON.parse(readFileSync(new URL('../adapters/dsh/package.json', import.meta.url), 'utf8'));
  const hostVersion = getDshRuntimeVersion();

  // The adapter must not be pinned to one build: the host reports any version
  // inside the supported range as acceptable, and the verified build is recorded
  // separately rather than enforced.
  assert.equal(isSupported(hostVersion), true,
    `宿主 ${hostVersion} 应落在支持区间 >=${supportedRange.min} <${supportedRange.max} 内`);
  if (hostVersion !== verifiedVersion) {
    console.warn(`注意：宿主为 ${hostVersion}，已验证版本是 ${verifiedVersion}；测试仍会执行以确保基础兼容。`);
  }

  // The decisive check: the host's own evaluator must accept ranged peer specs.
  // If it only understood exact versions, moving off the pinned build would stop
  // the plugin from loading at all.
  const current = evaluatePluginCompatibility(manifest, {}, hostVersion);
  assert.equal(current, undefined, `宿主兼容性检查未通过: ${JSON.stringify(current)}`);

  // A host outside the supported range must still be rejected, so widening the
  // range did not turn the check into a no-op.
  const old = { ...manifest, peerDependencies: { ...manifest.peerDependencies, '@deepseek-ai/dsh-tools': '>=0.1.0 <0.2' } };
  assert.ok(evaluatePluginCompatibility(old, {}, hostVersion), '超出区间的依赖声明必须被拒绝');

  // And a future host inside the range must pass, proving the range is what
  // decides — not a match against today's build.
  const future = evaluatePluginCompatibility(manifest, {}, '0.2.9');
  assert.equal(future, undefined, `区间内的更晚版本应被接受: ${JSON.stringify(future)}`);
});

test('real DSH ToolRuntime loads, executes and disposes the adapter with a real core', { skip }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'amb-real-runtime-'));
  // The adapter writes its own log; point it at the fixture directory so the test
  // can read back what the real runtime actually recorded.
  const logDir = join(dir, 'logs');
  const previousLogDir = process.env.AMB_LOG_DIR; process.env.AMB_LOG_DIR = logDir;
  const store = new Store(':memory:');
  store.import([{ id: 'deny-test', kind: 'norm', title: 'Fixture', scope: { kind: 'project', projectId: 'p0' }, baseRevision: 0, body: 'Block only the side effect fixture.', deniedTools: ['amb_p0_blocked'] }]);
  const token = 'a'.repeat(64);
  const server = createCoreServer(store, { protocolVersion: 1, port: 47631, clients: [{ id: 'dsh', token, projectId: 'p0' }] });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const config = join(dir, 'client.json');
  await writeFile(config, JSON.stringify({ endpoint: `http://127.0.0.1:${server.address().port}`, token, projectId: 'p0', projectRoot: process.cwd() }));
  const previous = process.env.AMB_DSH_CONFIG; process.env.AMB_DSH_CONFIG = config;
  const root = new Context();
  const fibers = [];
  t.after(async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose();
    server.closeAllConnections(); await new Promise(done => server.close(done)); store.close();
    if (previous === undefined) delete process.env.AMB_DSH_CONFIG; else process.env.AMB_DSH_CONFIG = previous;
    if (previousLogDir === undefined) delete process.env.AMB_LOG_DIR; else process.env.AMB_LOG_DIR = previousLogDir;
    const rel = relative(resolve(tmpdir()), resolve(dir));
    assert(rel && !rel.startsWith('..') && !isAbsolute(rel)); await rm(dir, { recursive: true, force: true });
  });
  const plugin = async (p, options) => { const fiber = root.plugin(p, options); fibers.push(fiber); await fiber; return fiber; };
  await plugin(SystemPrompt, {});
  await plugin(ToolRuntime, { mode: 'native' });
  let tools;
  await plugin({ name: 'p0-observer', inject: ['tools'], apply(ctx) { tools = ctx.tools; } });
  assert(tools, 'Real tools service must be reachable from a declared consumer');
  // Another policy may overwrite a waterfall denial; the final guard must remain monotonic.
  let skipOtherPolicies = false;
  await plugin({ name: 'permissive-fixture', apply(ctx) {
    ctx.on('tools/pre-execute', async (_exec, next) => { if (!skipOtherPolicies) await next(); return { kind: 'allow' }; });
  } });
  const fiber = await plugin(adapter);
  const ambToolNames = tools.schemas().filter(x => x.name.startsWith('amb_')).map(x => x.name).sort();
  assert.equal(ambToolNames.length, 15);
  assert.deepEqual(ambToolNames, [
    'amb_checkpoint_task', 'amb_inspect_archive', 'amb_knowledge_history', 'amb_prepare', 'amb_read_knowledge',
    'amb_read_stage', 'amb_save_material', 'amb_search_universal', 'amb_search_workflows', 'amb_self_check', 'amb_structure_skill',
    'amb_submit_experience', 'amb_supersede_experience', 'amb_task_activity', 'amb_unstructured_skills',
  ]);
  const injected = [];
  const agent = { id: 'real-tool-session', session: { header: { cwd: process.cwd() } }, inject(message) { injected.push(message); } };
  const execute = (name, args = {}, owner = agent) => tools.execute({ callId: randomUUID(), name, arguments: args, agent: owner, signal: new AbortController().signal });
  const prepared = await execute('amb_prepare');
  assert.notEqual(prepared.isError, true, JSON.stringify(prepared));
  assert.match(JSON.stringify(prepared), /Block only the side effect fixture/);
  const proposal = await execute('amb_submit_experience', { idempotencyKey: 'real-runtime-proposal', discovery: 'A runtime fixture candidate' });
  assert.match(JSON.stringify(proposal), /pending/);
  assert.equal(store.stats().pendingProposals, 1);
  let sideEffects = 0;
  await plugin({ name: 'side-effect-fixture', inject: ['tools'], apply(ctx) {
    ctx.tools.register({ name: 'amb_p0_blocked', description: 'Side effect counter fixture', parameters: { type: 'object', properties: {}, additionalProperties: false }, output: { schema: { type: 'object', additionalProperties: true }, render: () => [] }, execute() { sideEffects++; return { executed: true }; } });
  } });
  const denied = await execute('amb_p0_blocked');
  assert.equal(sideEffects, 0, JSON.stringify(denied));
  assert.match(JSON.stringify(denied), /deny|denied|DENIED|禁止/);
  skipOtherPolicies = true;
  const bypassAttempt = await execute('amb_p0_blocked');
  assert.equal(sideEffects, 0, JSON.stringify(bypassAttempt));
  assert.match(JSON.stringify(bypassAttempt), /not checked/);
  skipOtherPolicies = false;
  const outside = { id: 'outside', session: { header: { cwd: dir } } };
  await execute('amb_p0_blocked', {}, outside);
  assert.equal(sideEffects, 1, 'Unrelated project tools are unaffected');
  const outsideRead = await execute('amb_prepare', {}, outside);
  assert.equal(outsideRead.isError, true);
  assert.doesNotMatch(JSON.stringify(outsideRead), /Block only the side effect fixture/);
  const outsideWrite = await execute('amb_submit_experience', { idempotencyKey: 'outside', discovery: 'Must not store' }, outside);
  assert.equal(outsideWrite.isError, true);
  assert.equal(store.stats().pendingProposals, 1);
  store.import([{ id: 'deny-test', kind: 'norm', title: 'Replaced fixture', scope: { kind: 'project', projectId: 'p0' }, baseRevision: 1, body: 'The fixture restriction is now removed.', deniedTools: [] }]);
  const refreshed = await execute('amb_p0_blocked');
  assert.notEqual(refreshed.isError, true);
  assert.equal(sideEffects, 2);
  assert.match(injected.at(-1).content[0].text, /restriction is now removed/);
  assert.equal(injected.at(-1).source.kind, 'agent-memory-backpack');
  await fiber.dispose();
  assert.equal(tools.schemas().filter(x => x.name === 'amb_prepare').length, 0);

  // The adapter's own log, as written by the real runtime during this test.
  const logFile = join(logDir, 'amb-plugin.log.jsonl');
  assert.equal(existsSync(logFile), true, '适配器必须在真实运行时中写出自己的日志');
  const records = readFileSync(logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const events = records.map(r => r.event);
  assert.ok(events.includes('adapter.load'), `加载必须留痕，实际：${events.join(', ')}`);
  assert.ok(events.includes('adapter.config'), '配置加载必须留痕');
  // The adapter logs a distinct event for each failure class, so a report can say
  // whether a call was refused for scope or failed for another reason.
  assert.ok(events.includes('tool.out_of_scope'), `越界调用必须留痕，实际：${events.join(', ')}`);
  const outOfScope = records.find(r => r.event === 'tool.out_of_scope');
  assert.equal(outOfScope.tool, 'amb_prepare', '记录必须点名具体工具');
  assert.ok(events.includes('adapter.out_of_scope'), '越界项目上下文本身必须留痕');
  // No credential may reach the log, even though the adapter holds one.
  assert.equal(readFileSync(logFile, 'utf8').includes('a'.repeat(64)), false, '凭据不得写入日志');
});

test('DSH project scope follows real paths and excludes a junction escaping the project', async t => {
  const { isWithinProject } = await import('../adapters/dsh/core-client.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'amb-scope-'));
  t.after(async () => {
    const rel = relative(resolve(tmpdir()), resolve(dir));
    assert(rel && !rel.startsWith('..') && !isAbsolute(rel));
    await rm(dir, { recursive: true, force: true });
  });
  const project = join(dir, 'project'); const outside = join(dir, 'outside');
  await mkdir(project); await mkdir(outside); await mkdir(join(project, 'inside'));
  await symlink(outside, join(project, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(isWithinProject(project, join(project, 'inside')), true);
  assert.equal(isWithinProject(project, join(project, 'escape')), false);
  assert.equal(isWithinProject(project, join(project, 'missing')), false);
});

test('shared DSH sessions read one library and capture failed tools as one pending candidate', { skip }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'amb-shared-runtime-'));
  const previous = process.env.AMB_DSH_CONFIG;
  const previousLog = process.env.AMB_LOG_DIR;
  process.env.AMB_DSH_CONFIG = join(dir, 'client.json');
  process.env.AMB_LOG_DIR = dir;
  const store = new Store(join(dir, 'knowledge.sqlite'));
  store.import([{ id: 'shared-memory', kind: 'memory', title: 'Shared failure recovery journal',
    scope: { kind: 'global' }, baseRevision: 0, body: 'Look up the missing binary before retrying.', provenance: 'user' }]);
  const token = 'd'.repeat(64);
  const server = createCoreServer(store, { protocolVersion: 1, port: 47631,
    clients: [{ id: 'dsh', token, projectId: 'shared' }, { id: 'codex', token: 'c'.repeat(64), projectId: 'shared' }] });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  await writeFile(process.env.AMB_DSH_CONFIG, JSON.stringify({ endpoint, token, projectId: 'shared' }));
  const root = new Context();
  const fibers = [];
  t.after(async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose();
    server.closeAllConnections(); await new Promise(done => server.close(done)); store.close();
    if (previous === undefined) delete process.env.AMB_DSH_CONFIG; else process.env.AMB_DSH_CONFIG = previous;
    if (previousLog === undefined) delete process.env.AMB_LOG_DIR; else process.env.AMB_LOG_DIR = previousLog;
    await rm(dir, { recursive: true, force: true });
  });
  const mount = async (plugin, config = {}) => { const fiber = root.plugin(plugin, config); fibers.push(fiber); await fiber; };
  await mount(SystemPrompt);
  await mount(ToolRuntime, { mode: 'native' });
  let tools;
  await mount({ name: 'shared-observer', inject: ['tools'], apply(ctx) { tools = ctx.tools; } });
  await mount(adapter);
  await mount({ name: 'failure-fixture', inject: ['tools'], apply(ctx) {
    ctx.tools.register({ name: 'missing_binary', description: 'Failure fixture', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: () => [] }, execute() { throw new Error('ENOENT token=private-value'); } });
  } });
  const reflections = [];
  const agent = { id: 'project-a-session', session: { header: { cwd: tmpdir() } }, inject() {}, steer(message) { reflections.push(message); } };
  const execute = (name, args = {}, owner = agent) => tools.execute({ callId: randomUUID(), name,
    arguments: args, agent: owner, signal: new AbortController().signal });
  const readA = await execute('amb_read_knowledge', { knowledgeId: 'shared-memory' });
  const readB = await execute('amb_read_knowledge', { knowledgeId: 'shared-memory' },
    { ...agent, id: 'project-b-session', session: { header: { cwd: process.cwd() } } });
  assert.equal(readA.isError, false, JSON.stringify(readA));
  assert.equal(readB.isError, false, JSON.stringify(readB));
  store.recordTask('shared', { id: 'unrelated-task', title: 'Other project task', status: 'paused', sessionIds: ['unrelated-session'] });
  const message = { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] };
  const preStep = await root.waterfall('agent/pre-step', { agent, messages: [message], signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [message] }));
  assert.doesNotMatch(JSON.stringify(preStep), /\[Task Handoff\]|Other project task/,
    'A shared library must not bind a bare continue request to an unrelated session');
  const recallMessage = { ...message, id: randomUUID(), content: [{ type: 'text', text: 'missing binary' }] };
  const autoRead = await root.waterfall('agent/pre-step', { agent, messages: [recallMessage], signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [recallMessage] }));
  assert.match(JSON.stringify(autoRead.messages), /AMB 自动检索并读取/);
  assert.match(JSON.stringify(autoRead.messages), /Look up the missing binary before retrying/,
    'Actual host pre-step must read and inject body, not merely tell the model to search');
  await root.serial('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal });
  assert.equal(reflections.length, 0, 'Only querying the plugin must not trigger an extra reflection step');
  for (let i = 0; i < 2; i++) assert.equal((await execute('missing_binary')).isError, true);
  await root.serial('agent/turn-stopping', { agent, turn: 2, signal: AbortSignal.abort() });
  assert.equal(reflections.length, 0, 'Aborted user turns must never be revived');
  await root.serial('agent/turn-stopping', { agent, turn: 2, signal: new AbortController().signal });
  await root.serial('agent/turn-stopping', { agent, turn: 2, signal: new AbortController().signal });
  assert.equal(reflections.length, 1, 'Business tools trigger at most one reflection request per natural turn');
  assert.match(JSON.stringify(reflections), /amb_checkpoint_task/);
  assert.match(JSON.stringify(reflections), /不要编造/);
  const checkpoint = await execute('amb_checkpoint_task', { status: 'paused', summary: 'Missing binary still unresolved',
    unfinished: ['Locate binary'], idempotencyKey: 'runtime-progress-checkpoint' });
  assert.equal(checkpoint.isError, false, JSON.stringify(checkpoint));
  const activity = await execute('amb_task_activity');
  assert.equal(activity.isError, false, JSON.stringify(activity));
  assert.match(JSON.stringify(activity), /journal/);
  const proposals = store.listProposals('shared', 'pending');
  assert.equal(proposals.length, 1);
  assert.match(proposals[0].payload.discovery, /ENOENT/);
  assert.doesNotMatch(JSON.stringify(proposals), /private-value/);
  const { CoreClient } = await import('../dist/src/client.js');
  const codex = new CoreClient({ endpoint, token: 'c'.repeat(64), projectId: 'shared', role: 'adapter' });
  const shared = await codex.post('/v1/knowledge/read', { knowledgeId: 'shared-memory' });
  assert.match(JSON.stringify(shared), /missing binary/);
  const log = readFileSync(join(dir, 'amb-plugin.log.jsonl'), 'utf8');
  assert.match(log, /experience.captured/);
  assert.match(log, /tool.ok/);
  assert.doesNotMatch(log, /private-value/);
  assert.match(log, /knowledge.auto_recall/);
  assert.match(log, /readIds.*shared-memory/);
  await root.emit('session/event', { id: agent.id, header: { cwd: tmpdir() } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } });
  for (let i = 0; i < 30 && !store.searchUniversal('shared', '', 'journal').length; i++) {
    await new Promise(done => setTimeout(done, 20));
  }
  const journals = store.searchUniversal('shared', '', 'journal');
  assert.equal(journals.length, 1, 'Natural turn-end persists a journal without an explicit task id');
  assert.equal(store.readKnowledge('shared', journals[0].id).outcome, 'unverified');
});
