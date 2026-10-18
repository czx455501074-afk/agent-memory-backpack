import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Store } from '../dist/src/store.js';
import { createCoreServer } from '../dist/src/server.js';
import { inspectRuntime, runtimeRoot } from './dsh-target.mjs';

const runtime = inspectRuntime();
const latestFile = new URL('../artifacts/latest.json', import.meta.url);
const artifact = process.env.AMB_TEST_DSH_ARTIFACT || (existsSync(latestFile)
  ? join(JSON.parse(readFileSync(latestFile, 'utf8')).directory, 'dsh-plugin') : '');
const skip = !runtime.available ? runtime.reason : !existsSync(join(artifact, 'index.mjs'))
  ? 'Packaged artifact unavailable: run npm run pack:local first.' : false;
const moduleUrl = name => pathToFileURL(resolve(runtimeRoot, '@deepseek-ai', name, 'lib/index.js')).href;

test('real Loader reads isolated config, loads packaged AMB, retrieves bodies and persists failed-tool and journal receipts', { skip }, async t => {
  const [{ Context }, { Loader }] = await Promise.all([import(moduleUrl('cordis')), import(moduleUrl('cordis-plugin-loader'))]);
  const dir = await mkdtemp(join(tmpdir(), 'amb-loader-entry-'));
  const previousConfig = process.env.AMB_DSH_CONFIG, previousLog = process.env.AMB_LOG_DIR;
  process.env.AMB_DSH_CONFIG = join(dir, 'client.json');
  process.env.AMB_LOG_DIR = dir;
  const dbPath = join(dir, 'knowledge.sqlite');
  const store = new Store(dbPath);
  store.import([{ id: 'loader-knowledge', kind: 'memory', title: 'loaderprobe recovery', scope: { kind: 'global' },
    baseRevision: 0, provenance: 'user', body: 'loaderprobe recovery body: inspect the missing executable path.' }]);
  const token = 'isolated-loader-fixture-token-for-testing';
  const server = createCoreServer(store, { protocolVersion: 1, port: 47631,
    clients: [{ id: 'dsh', token, projectId: 'loader-library' }] });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  // This fixture proves the packaged plugin retains a failed-tool receipt, and capture is
  // opt-in — so the switch has to be named here. Leaving it out would make the suite pass
  // only while the parser silently defaulted capture to on, which is the defect it now
  // guards against (see test/adapter-defaults.test.mjs).
  await writeFile(process.env.AMB_DSH_CONFIG, JSON.stringify({
    endpoint: `http://127.0.0.1:${server.address().port}`, token, projectId: 'loader-library', autoCaptureFailures: true }));
  const root = new Context();
  const loader = new Loader(root, { baseUrl: pathToFileURL(join(dir, 'cordis.yml')).href });
  t.after(async () => {
    for (const entry of [...loader.entries()].reverse()) await entry.fiber?.dispose();
    loader.root.stop();
    server.closeAllConnections(); await new Promise(done => server.close(done)); store.close();
    if (previousConfig === undefined) delete process.env.AMB_DSH_CONFIG; else process.env.AMB_DSH_CONFIG = previousConfig;
    if (previousLog === undefined) delete process.env.AMB_LOG_DIR; else process.env.AMB_LOG_DIR = previousLog;
    const rel = relative(resolve(tmpdir()), resolve(dir));
    assert(rel && !rel.startsWith('..') && !isAbsolute(rel)); await rm(dir, { recursive: true, force: true });
  });
  const fixtureFile = join(dir, 'fixture.mjs');
  await writeFile(fixtureFile, `export let tools; export const inject = ['tools'];
export function apply(ctx) { tools = ctx.tools;
  ctx.effect(() => ctx.tools.register({ name: 'loader_missing_binary', description: 'Isolated failure fixture',
    parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] },
    execute() { throw new Error('loaderprobe executable missing'); } }), 'fixture registration'); }
`);
  // JSON is a YAML subset. Read the saved composition, then pass its entries to
  // the real Loader. Every runtime plugin is imported by Loader, including AMB;
  // no direct ctx.plugin(adapter) can bypass artifact resolution or exports.
  const config = [
    { id: 'system-prompt', name: moduleUrl('dsh-system-prompt'), config: {} },
    { id: 'tools', name: moduleUrl('dsh-tools'), config: { mode: 'native' } },
    { id: 'amb', name: pathToFileURL(join(artifact, 'index.mjs')).href, config: {} },
    { id: 'fixture', name: pathToFileURL(fixtureFile).href, config: {} },
  ];
  const configFile = join(dir, 'cordis.yml');
  await writeFile(configFile, JSON.stringify(config, null, 2));
  await loader.root.update(JSON.parse(await readFile(configFile, 'utf8')));
  await loader.await();
  const { tools } = await import(pathToFileURL(fixtureFile).href);
  assert(tools, 'Loader must resolve and activate the actual ToolRuntime service');
  assert(loader.resolve('amb').fiber?.uid, 'Packaged AMB must be a running Loader entry');
  const agent = { id: 'loader-session', session: { header: { cwd: dir } }, inject() {} };
  const prompt = { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'loaderprobe' }] };
  const step = await root.waterfall('agent/pre-step', { agent, messages: [prompt], signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [prompt] }));
  assert.match(JSON.stringify(step.messages), /AMB 自动检索并读取/);
  assert.match(JSON.stringify(step.messages), /inspect the missing executable path/);
  const execute = (name, args = {}) => tools.execute({ callId: randomUUID(), name, arguments: args,
    agent, signal: new AbortController().signal });
  assert.equal((await execute('loader_missing_binary')).isError, true);
  assert.equal((await execute('amb_read_knowledge', { knowledgeId: 'loader-knowledge' })).isError, false);
  await root.emit('session/event', { id: agent.id, header: { cwd: dir } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } });
  const observer = new Store(dbPath);
  try {
    for (let attempt = 0; attempt < 40 && observer.searchUniversal('loader-library', '', 'journal').length === 0; attempt++) {
      await new Promise(done => setTimeout(done, 20));
    }
    assert.equal(observer.listProposals('loader-library', 'pending').length, 1);
    const journals = observer.searchUniversal('loader-library', '', 'journal');
    assert.equal(journals.length, 1, 'A separate database connection must see the durable journal');
    assert.equal(observer.readKnowledge('loader-library', journals[0].id).outcome, 'unverified');
  } finally { observer.close(); }
  await loader.resolve('amb').fiber.dispose();
  assert.equal(tools.schemas().some(tool => tool.name === 'amb_prepare'), false, 'Loader plugin disposal removes AMB tools');
});
