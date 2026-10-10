import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { createCoreServer } from '../src/server.js';
import type { Knowledge, Workflow } from '../src/schema.js';

const token = 'a'.repeat(64), adminToken = 'c'.repeat(64);
const PROJECT = 'p0';
const norm = (over: Record<string, unknown> = {}): Knowledge => ({
  id: 'mgmt-norm', kind: 'norm', title: '管理界面测试规范',
  scope: { kind: 'project', projectId: PROJECT }, baseRevision: 0,
  body: '只用于管理 API 测试的规范正文。', deniedTools: [], hostProvided: false, ...over,
} as Knowledge);
const workflow = (id: string, baseRevision = 0): Workflow => ({
  id, kind: 'workflow', title: `流程 ${id}`, scope: { kind: 'project', projectId: PROJECT }, baseRevision,
  overview: '管理 API 测试用完整流程。', triggers: ['测试'], categories: [['测试']], tags: [],
  preconditions: ['已提供项目上下文'],
  stages: [{ id: 'step', title: '执行', instructions: '执行并核对。', checks: ['结果可核对'], dependencies: [] }],
  completion: ['完成'], recovery: '失败时停止并记录。', isEntryPoint: false,
});

async function fixture() {
  const store = new Store(':memory:');
  const server = createCoreServer(store, {
    protocolVersion: 1, port: 47631, clients: [
    { id: 'dsh', token, projectId: PROJECT, role: 'adapter' },
    { id: 'admin', token: adminToken, projectId: PROJECT, role: 'admin' },
  ],
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  /**
   * POST with an explicit credential.
   *
   * The default is the adapter credential, which is what an agent holds. Review
   * operations pass the admin credential, because that separation is the point:
   * an adapter must not be able to approve a proposal.
   */
  const post = async (path: string, body: unknown, credential: string = token) => {
    const res = await fetch(endpoint + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'x-amb-protocol': '1' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, data: (text ? JSON.parse(text) : undefined) as Record<string, unknown> };
  };
  /** POST as the human reviewer. */
  const adminPost = (path: string, body: unknown) => post(path, body, adminToken);
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  };
  return { store, endpoint, post, adminPost, close };
}

test('管理 API 需要认证并受项目范围约束', async () => {
  const f = await fixture();
  try {
    const noToken = await fetch(`${f.endpoint}/v1/stats`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-amb-protocol': '1' },
      body: JSON.stringify({ projectId: PROJECT }),
    });
    assert.equal(noToken.status, 401);

    const wrongProject = await f.post('/v1/stats', { projectId: 'other-project' });
    assert.equal(wrongProject.status, 403);

    const wrongProtocol = await fetch(`${f.endpoint}/v1/proposals/list`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-amb-protocol': '9' },
      body: JSON.stringify({ projectId: PROJECT }),
    });
    assert.equal(wrongProtocol.status, 426);
  } finally { await f.close(); }
});

test('agent 凭据不能审阅或批准提案，只有管理凭据可以', async () => {
  // The plan requires that an agent may propose but must not approve its own
  // proposal. With one shared credential that was unenforceable: an adapter could
  // always reach the approval endpoint. The role is what makes it a real
  // boundary, so it is asserted rather than assumed.
  const f = await fixture();
  try {
    const submitted = await f.post('/v1/proposals', {
      projectId: PROJECT, idempotencyKey: 'role-1', discovery: 'agent 自己提交的候选。',
    });
    assert.equal(submitted.status, 200);
    const id = String(submitted.data.id);

    // Every review operation is refused for the adapter credential.
    const asAgent = [
      ['/v1/proposals/list', { projectId: PROJECT, state: 'pending' }],
      ['/v1/proposals/approve', { projectId: PROJECT, id, entry: workflow('agent-written') }],
      ['/v1/proposals/reject', { projectId: PROJECT, id }],
      ['/v1/rescan/interval', { projectId: PROJECT, intervalMs: 120000 }],
      ['/v1/rescan/mark', { projectId: PROJECT }],
    ];
    for (const [path, body] of asAgent) {
      const refused = await f.post(path as string, body);
      assert.equal(refused.status, 403, `${path} 必须拒绝适配器凭据，实际 ${refused.status}`);
      assert.match(String(refused.data?.message ?? ''), /admin/, `${path} 的拒绝理由应指出需要管理凭据`);
    }

    // The proposal is untouched: nothing was approved by the agent's attempt.
    const stillPending = await f.adminPost('/v1/proposals/list', { projectId: PROJECT, state: 'pending' });
    assert.equal((stillPending.data.proposals as unknown[]).length, 1, 'agent 的批准尝试不得生效');

    // The same operation succeeds with the admin credential.
    const approved = await f.adminPost('/v1/proposals/approve', {
      projectId: PROJECT, id, entry: workflow('admin-approved'),
    });
    assert.equal(approved.status, 200, `管理凭据应能批准：${JSON.stringify(approved.data)}`);
  } finally { await f.close(); }
});

test('管理 API：列出提案不改变知识版本，批准需完整结构化条目', async () => {
  const f = await fixture();
  try {
    const submitted = await f.post('/v1/proposals', { projectId: PROJECT, idempotencyKey: 'mgmt-1', discovery: '发现一个可复用流程要点。' });
    assert.equal(submitted.status, 200);
    const id = String((submitted.data as { id: string }).id);
    const before = f.store.revision;

    const listed = await f.adminPost('/v1/proposals/list', { projectId: PROJECT, state: 'pending' });
    assert.equal(listed.status, 200);
    const proposals = (listed.data as { proposals: Array<{ id: string; state: string }> }).proposals;
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]!.id, id);
    assert.equal(f.store.revision, before, '列出提案不得改变知识版本');

    // 发现文本本身不能被直接提升为知识：缺少结构化条目时批准必须失败。
    const missingEntry = await f.adminPost('/v1/proposals/approve', { projectId: PROJECT, id, discovery: '发现一个可复用流程要点。' });
    assert.equal(missingEntry.status, 400);

    const approved = await f.adminPost('/v1/proposals/approve', { projectId: PROJECT, id, entry: workflow('mgmt-approved') });
    assert.equal(approved.status, 200);
    assert.ok(f.store.revision > before, '批准后知识版本必须前进');
    assert.deepEqual(f.store.search(PROJECT, 'mgmt-approved').map(w => w.id), ['mgmt-approved']);

    const approvedList = await f.adminPost('/v1/proposals/list', { projectId: PROJECT, state: 'approved' });
    assert.equal((approvedList.data as { proposals: unknown[] }).proposals.length, 1);

    const second = await f.post('/v1/proposals', { projectId: PROJECT, idempotencyKey: 'mgmt-2', discovery: '另一个候选。' });
    const secondId = String((second.data as { id: string }).id);
    const rejected = await f.adminPost('/v1/proposals/reject', { projectId: PROJECT, id: secondId });
    assert.equal(rejected.status, 200);
    assert.equal((rejected.data as { state: string }).state, 'rejected');
    const rejectedList = await f.adminPost('/v1/proposals/list', { projectId: PROJECT, state: 'rejected' });
    assert.equal((rejectedList.data as { proposals: unknown[] }).proposals.length, 1);
  } finally { await f.close(); }
});

test('管理 API：同一提案不可重复批准，且失败不产生半写', async () => {
  const f = await fixture();
  try {
    const submitted = await f.post('/v1/proposals', { projectId: PROJECT, idempotencyKey: 'mgmt-once', discovery: '一次性候选。' });
    const id = String((submitted.data as { id: string }).id);
    const first = await f.adminPost('/v1/proposals/approve', { projectId: PROJECT, id, entry: workflow('mgmt-once-wf') });
    assert.equal(first.status, 200);
    const revisionAfter = f.store.revision;

    const again = await f.adminPost('/v1/proposals/approve', { projectId: PROJECT, id, entry: workflow('mgmt-second-wf') });
    assert.equal(again.status, 404);
    assert.equal(f.store.revision, revisionAfter, '重复批准不得推进版本');
    assert.deepEqual(f.store.search(PROJECT, 'mgmt-second-wf'), [], '重复批准不得写入任何条目');
  } finally { await f.close(); }
});

test('管理 API：批准时条目版本冲突回滚且提案保持待审', async () => {
  const f = await fixture();
  try {
    f.store.import([workflow('conflict-target')]);
    const submitted = await f.post('/v1/proposals', { projectId: PROJECT, idempotencyKey: 'mgmt-cas', discovery: '基于旧版本的候选。' });
    const id = String((submitted.data as { id: string }).id);

    // 审阅者提交的条目引用了过期 baseRevision，必须整体失败。
    const conflicted = await f.adminPost('/v1/proposals/approve', {
      projectId: PROJECT, id, entry: { ...workflow('conflict-target'), baseRevision: 99 },
    });
    assert.equal(conflicted.status, 409);
    const stillPending = await f.adminPost('/v1/proposals/list', { projectId: PROJECT, state: 'pending' });
    assert.equal((stillPending.data as { proposals: unknown[] }).proposals.length, 1, '失败后提案必须保持待审');
  } finally { await f.close(); }
});

test('管理 API：列出规范与统计反映权威版本', async () => {
  const f = await fixture();
  try {
    f.store.import([norm()]);
    const norms = await f.post('/v1/norms', { projectId: PROJECT });
    assert.equal(norms.status, 200);
    const list = (norms.data as { norms: Array<{ content: { id: string } }> }).norms;
    assert.equal(list.length, 1);
    assert.equal(list[0]!.content.id, 'mgmt-norm');

    const stats = await f.post('/v1/stats', { projectId: PROJECT });
    assert.equal(stats.status, 200);
    const s = stats.data as { knowledgeRevision: number; entries: number; pendingProposals: number; events: number };
    assert.equal(s.knowledgeRevision, f.store.revision);
    assert.equal(s.entries, 1);
    assert.equal(s.pendingProposals, 0);
    assert.equal(s.events, 0);
  } finally { await f.close(); }
});
