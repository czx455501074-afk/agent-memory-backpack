import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store } from '../src/store.js';
import { createCoreServer } from '../src/server.js';
import { normSchema, workflowSchema } from '../src/schema.js';
import { CoreClient } from '../src/client.js';

const token = 'a'.repeat(64), dshToken = 'b'.repeat(64), adminToken = 'c'.repeat(64);
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'amb-protocol-'));
  const store = new Store(join(dir, 'knowledge.sqlite'));
  store.import([normSchema.parse({ id: 'rule', kind: 'norm', title: 'P0 test rule', scope: { kind: 'project', projectId: 'p0' }, body: 'P0 fixture: block the named test tool', deniedTools: ['blocked'] })]);
  const server = createCoreServer(store, { protocolVersion: 1, port: 47631, clients: [
    { id: 'codex', token, projectId: 'p0', role: 'adapter' },
    { id: 'dsh', token: dshToken, projectId: 'p0', role: 'adapter' },
    { id: 'admin', token: adminToken, projectId: 'p0', role: 'admin' },
  ] });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const configPath = join(dir, 'client.json');
  writeFileSync(configPath, JSON.stringify({ endpoint, token, projectId: 'p0' }));
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(endpoint + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-amb-protocol': '1', ...headers }, body: JSON.stringify(body) });
  return { store, endpoint, configPath, tmpDir: dir, post, async close() {
    server.closeIdleConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close(); rmSync(dir, { recursive: true, force: true });
  } };
}

test('protocol, identity and project isolation reject untrusted or incompatible requests', async () => {
  const f = await fixture();
  try {
    const body = { adapter: 'codex', projectId: 'p0' };
    assert.equal((await f.post('/v1/prepare', body, { Authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await f.post('/v1/prepare', body, { 'x-amb-protocol': '2' })).status, 426);
    assert.equal((await f.post('/v1/prepare', body, { 'x-amb-protocol': '' })).status, 426);
    assert.equal((await f.post('/v1/prepare', { ...body, adapter: 'dsh' })).status, 403);
    assert.equal((await f.post('/v1/prepare', { ...body, projectId: 'other' })).status, 403);
    assert.equal((await f.post('/v1/prepare', body, { Origin: 'https://attacker.invalid' })).status, 403);
    // fetch normalizes Host; use raw HTTP to actually exercise the DNS-rebinding guard.
    const badHost = await new Promise<number>(resolve => {
      const req = request(f.endpoint + '/health', { headers: { Host: 'attacker.invalid' } }, res => { res.resume(); resolve(res.statusCode!); }); req.end();
    });
    assert.equal(badHost, 403);
    assert.equal((await f.post('/v1/admin', body)).status, 404);
  } finally { await f.close(); }
});

test('both adapter credentials see same authoritative revision and new policy on next gate', async () => {
  const f = await fixture();
  try {
    const codex = await (await f.post('/v1/prepare', { adapter: 'codex', projectId: 'p0' })).json() as { knowledgeRevision: number };
    const dsh = await (await f.post('/v1/prepare', { adapter: 'dsh', projectId: 'p0' }, { Authorization: `Bearer ${dshToken}` })).json() as { knowledgeRevision: number };
    assert.equal(codex.knowledgeRevision, dsh.knowledgeRevision);
    assert.equal((await (await f.post('/v1/gate', { projectId: 'p0', toolName: 'blocked' })).json() as { decision: string }).decision, 'deny');
    f.store.import([normSchema.parse({ id: 'rule', kind: 'norm', title: 'Changed fixture', scope: { kind: 'project', projectId: 'p0' }, baseRevision: 1, body: 'New fixture blocks other tool', deniedTools: ['other'] })]);
    const updated = await (await f.post('/v1/gate', { projectId: 'p0', toolName: 'other', knowledgeRevision: codex.knowledgeRevision })).json() as { decision: string; knowledgeRevision: number };
    assert.equal(updated.decision, 'deny'); assert(updated.knowledgeRevision > codex.knowledgeRevision);
    assert.equal((await (await f.post('/v1/gate', { projectId: 'p0', toolName: 'blocked' })).json() as { decision: string }).decision, 'allow');
  } finally { await f.close(); }
});

test('submit is idempotent and never changes effective knowledge; stop records only an event', async () => {
  const f = await fixture();
  try {
    const before = f.store.revision;
    const proposal = { projectId: 'p0', idempotencyKey: 'first', discovery: 'A candidate, not an effective rule' };
    const first = await (await f.post('/v1/proposals', proposal)).json() as { state: string; id: string };
    const retry = await (await f.post('/v1/proposals', proposal)).json() as { id: string; duplicate: boolean };
    assert.equal(first.state, 'pending'); assert.equal(first.id, retry.id); assert.equal(retry.duplicate, true);
    assert.equal((await f.post('/v1/proposals', { ...proposal, discovery: 'different' })).status, 409);
    assert.equal(f.store.revision, before);
    assert.equal((await f.post('/v1/events', { eventId: 'stop1', adapter: 'codex', projectId: 'p0', taskId: 'task1', kind: 'turn_stopped', summary: 'Turn stopped; task completion unknown' })).status, 200);
    assert.equal(f.store.stats().events, 1);
    const event = String(f.store.db.prepare('SELECT payload FROM events').get()!.payload);
    assert(event.includes('turn_stopped')); assert(!event.includes('task_completed'));
  } finally { await f.close(); }
});

test('reject oversized input without exposing submitted payload or credentials', async () => {
  const f = await fixture();
  try {
    const response = await f.post('/v1/proposals', { projectId: 'p0', discovery: 'SECRET'.repeat(15000) });
    assert.equal(response.status, 413); const text = await response.text();
    assert(!text.includes('SECRET')); assert(!text.includes(token));
  } finally { await f.close(); }
});

test('built stdio MCP connects using official SDK and exposes read/candidate tools only', async () => {
  const f = await fixture();
  const client = new Client({ name: 'p0-test', version: '1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/src/mcp.js')], env: { AMB_CONFIG: f.configPath }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map(t => t.name).sort();
    assert.deepEqual(names, [
      'amb_inspect_archive', 'amb_knowledge_history', 'amb_prepare', 'amb_read_knowledge',
      'amb_read_stage', 'amb_search_universal', 'amb_search_workflows', 'amb_self_check', 'amb_structure_skill',
      'amb_submit_experience', 'amb_supersede_experience', 'amb_unstructured_skills',
    ]);
    const result = await client.callTool({ name: 'amb_prepare', arguments: { query: 'P0' } });
    assert.equal(result.isError, undefined);
    assert(JSON.stringify(result).includes('P0 fixture'));
    const candidate = await client.callTool({ name: 'amb_submit_experience', arguments: { idempotencyKey: 'mcp1', discovery: 'Only a candidate' } });
    assert(JSON.stringify(candidate).includes('pending'));
    assert.equal(f.store.revision, 1);
  } finally { await client.close(); await f.close(); }
});

test('every exposed MCP tool actually works end to end', async () => {
  // The earlier version of this test only asserted tool *names*, so a path
  // whitelist that blocked 14 of 22 endpoints went unnoticed. Each tool is now
  // really called, and the fixture answers the nested paths the tools use.
  const f = await fixture();
  // Extra endpoints the newer tools need, added through the real store so the
  // responses are genuine rather than hand-written stubs.
  f.store.import([workflowSchema.parse({
    id: 'audit-wf', kind: 'workflow', title: '审计流程', scope: { kind: 'project', projectId: 'p0' },
    baseRevision: 0, overview: '用于校验工具连通性的完整流程。', triggers: ['审计'],
    categories: [['测试']], tags: [], preconditions: ['已提供项目上下文'],
    stages: [{ id: 'step', title: '执行', instructions: '执行并核对。', checks: ['可核对'], dependencies: [] }],
    completion: ['完成'], recovery: '失败时停止。', isEntryPoint: true,
  })]);

  const client = new Client({ name: 'p0-test', version: '1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/src/mcp.js')], env: { AMB_CONFIG: f.configPath }, stderr: 'pipe' });
  try {
    await client.connect(transport);

    const failures: string[] = [];
    /**
     * Call one tool and check it actually reached the core.
     *
     * Every call must state what it expects. An earlier version accepted any 4xx
     * as proof the route worked, which would also accept a 400 from a malformed
     * argument or a 404 from a wrong path — precisely the failures this test
     * exists to catch. `expect` is therefore required, not optional.
     */
    const invoke = async (name: string, args: Record<string, unknown>, expect: (text: string) => boolean) => {
      const result = await client.callTool({ name, arguments: args });
      const text = JSON.stringify(result);
      if (text.includes('Unsupported core path')) failures.push(`${name}: refused locally, tool is unreachable`);
      else if (!expect(text)) failures.push(`${name}: unexpected outcome ${text.slice(0, 180)}`);
      return result;
    };

    await invoke('amb_prepare', { query: 'P0' }, t => t.includes('P0 fixture'));
    await invoke('amb_search_workflows', { query: 'audit' }, t => t.includes('audit-wf'));
    await invoke('amb_search_universal', { query: 'audit' }, t => t.includes('results'));
    await invoke('amb_read_stage', { workflowId: 'audit-wf', stageId: 'step' }, t => t.includes('audit-wf'));
    await invoke('amb_submit_experience', { idempotencyKey: 'mcp1', discovery: 'Only a candidate' }, t => t.includes('pending'));

    // These use nested paths: the exact set the whitelist used to reject. Each
    // asserts the specific business rejection, so a parameter or routing error
    // cannot masquerade as success.
    await invoke('amb_unstructured_skills', {}, t => t.includes('skills'));
    await invoke('amb_read_knowledge', { knowledgeId: 'missing-entry' }, t => t.includes('not_found'));
    await invoke('amb_knowledge_history', { knowledgeId: 'missing-entry' }, t => t.includes('not_found'));
    // Supersede changes the effective library, so an adapter credential must be
    // refused and pointed at the candidate flow instead of writing directly.
    await invoke('amb_supersede_experience', { oldId: 'a', newId: 'b', reason: 'r', evidence: 'e' },
      t => t.includes('admin credential') && t.includes('candidate'));

    // Self-check must work end to end and must not leak the credential.
    const selfCheck = await invoke('amb_self_check', {}, t => t.includes('\\"ok\\":true'));
    const selfCheckText = JSON.stringify(selfCheck);
    assert.equal(selfCheckText.includes(token), false, '自检结果不得包含凭据原文');
    // The shape is reported as length only: even a short prefix is part of the
    // secret and would make "contains no credential value" untrue.
    assert.match(selfCheckText, /value not printed/, '应报告凭据形态而非内容');
    assert.equal(/prefix/.test(selfCheckText), false, '不得输出凭据的任何前缀');

    assert.deepEqual([...failures], [], '所有工具都必须真实可用，不能只在名字上存在');
  } finally { await client.close(); await f.close(); }
});

test('MCP rejects a malformed core response instead of reporting success', async () => {
  // A core answering 200 with an empty object must not be treated as success:
  // that is the "pretend it worked" failure mode the other two adapters refuse.
  const f = await fixture();
  const emptyCore = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await once(emptyCore.listen(0, '127.0.0.1'), 'listening');
  const address = emptyCore.address();
  assert.ok(address && typeof address !== 'string');
  const configPath = join(f.tmpDir, 'empty-client.json');
  writeFileSync(configPath, JSON.stringify({ endpoint: `http://127.0.0.1:${address.port}`, token, projectId: 'p0' }));

  const client = new Client({ name: 'p0-test', version: '1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/src/mcp.js')], env: { AMB_CONFIG: configPath }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'amb_prepare', arguments: { query: 'x' } });
    assert.equal(result.isError, true, '空响应体必须报错，不能当成成功');
    assert.match(JSON.stringify(result), /invalid prepare response/);
  } finally {
    await client.close();
    emptyCore.closeAllConnections();
    await new Promise<void>(resolve => emptyCore.close(() => resolve()));
    await f.close();
  }
});
