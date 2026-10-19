import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createCoreServer } from '../src/server.js';
import type { KnowledgeDraft, WorkflowDraft } from '../src/schema.js';

/**
 * Scope boundaries on the two write paths that leaked across projects.
 *
 * Both defects were measured before this file existed:
 *   - `/v1/knowledge/retire` validated the envelope's project but called a store method
 *     that matched on id alone, so one project's credential retired another's entry
 *     (read: 404, retire: 200). Retiring a `global` prohibition then flipped `gate`
 *     from deny to allow, which is the one thing a prohibition must never do.
 *   - A `global` workflow could declare a `project`/`task` workflow as a prerequisite,
 *     and `expand` returned that child's overview and stage text to every project.
 */

const ADAPTER = 'a'.repeat(64);
const ADMIN = 'b'.repeat(64);

const norm = (id: string, body: string, scope: KnowledgeDraft['scope']): KnowledgeDraft => ({
  id, kind: 'norm', title: `规范 ${id}`, scope, baseRevision: 0, body,
  deniedTools: [], hostProvided: false,
} as KnowledgeDraft);

const flow = (id: string, scope: KnowledgeDraft['scope'], dependency?: { workflowId: string; revision: number }): WorkflowDraft => ({
  id, kind: 'workflow', title: id, scope, baseRevision: 0, overview: `流程 ${id}`,
  triggers: ['测试'], categories: [['测试']], tags: [], isEntryPoint: false, preconditions: ['前提'],
  stages: [{
    id: 's', title: '步骤', instructions: '执行。', checks: ['检查'],
    dependencies: dependency ? [{ ...dependency, relationship: 'prerequisite' }] : [],
  }],
  completion: ['完成'], recovery: '停止。',
});

async function fixture() {
  const store = new Store(':memory:');
  store.import([norm('alpha-rule', '甲方规范。', { kind: 'project', projectId: 'alpha' })]);
  store.import([norm('beta-rule', '乙方规范。', { kind: 'project', projectId: 'beta' })]);
  store.import([norm('global-rule', '全库规范。', { kind: 'global' })]);
  const server = createCoreServer(store, {
    protocolVersion: 1, port: 47631,
    clients: [
      { id: 'dsh', token: ADAPTER, projectId: 'alpha', role: 'adapter' },
      { id: 'admin', token: ADMIN, projectId: 'alpha', role: 'admin' },
    ],
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const post = async (path: string, body: unknown, credential = ADAPTER) => {
    const response = await fetch(endpoint + path, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}`, 'x-amb-protocol': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'alpha', ...body as object }),
    });
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* keep empty */ }
    return { status: response.status, data: parsed };
  };
  return {
    store, post,
    async close() {
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
      store.close();
    },
  };
}

test('适配器不得退役他项目条目：读 404 时写也必须 404', async () => {
  const f = await fixture();
  try {
    const read = await f.post('/v1/knowledge/get', { id: 'beta-rule' });
    assert.equal(read.status, 404, '前提：跨项目读取本就拒绝');
    const retired = await f.post('/v1/knowledge/retire', { id: 'beta-rule', baseRevision: 1, reason: '越权尝试' });
    assert.equal(retired.status, 404, `跨项目退役必须失败，实际 ${retired.status}`);
    const row = f.store.db.prepare('SELECT status FROM knowledge WHERE id=?').get('beta-rule') as { status: string };
    assert.equal(row.status, 'active', '他项目条目必须保持生效');
  } finally { await f.close(); }
});

test('适配器不得退役全局规范，管理员可以', async () => {
  const f = await fixture();
  try {
    const before = f.store.gate('alpha', 'write');
    assert.equal(before.decision, 'allow', '前提：该规范不禁止 write');
    f.store.import([{ ...norm('global-guard', '禁止写入。', { kind: 'global' }), deniedTools: ['write'] } as KnowledgeDraft]);
    assert.equal(f.store.gate('alpha', 'write').decision, 'deny', '前提：全局禁令生效');

    const adapter = await f.post('/v1/knowledge/retire', { id: 'global-guard', baseRevision: 1, reason: '越权尝试' });
    assert.equal(adapter.status, 404, '适配器退役全局条目必须被拒');
    assert.equal(f.store.gate('alpha', 'write').decision, 'deny', '禁令不得被适配器拆掉');

    const admin = await f.post('/v1/knowledge/retire', { id: 'global-guard', baseRevision: 1, reason: '人工决定' }, ADMIN);
    assert.equal(admin.status, 200, '管理员可以退役全局条目');
    assert.equal(f.store.gate('alpha', 'write').decision, 'allow', '退役后禁令解除');
  } finally { await f.close(); }
});

test('适配器仍可退役自己项目的条目', async () => {
  const f = await fixture();
  try {
    const own = await f.post('/v1/knowledge/retire', { id: 'alpha-rule', baseRevision: 1, reason: '本项目不再适用' });
    assert.equal(own.status, 200, `本项目条目应可退役，实际 ${own.status}`);
    const row = f.store.db.prepare('SELECT status FROM knowledge WHERE id=?').get('alpha-rule') as { status: string };
    assert.equal(row.status, 'retired');
  } finally { await f.close(); }
});

test('全局流程不得依赖项目或任务作用域的流程', () => {
  const store = new Store(':memory:');
  try {
    store.import([flow('beta-task', { kind: 'task', projectId: 'beta', taskId: 'task-b' })]);
    store.import([flow('beta-project', { kind: 'project', projectId: 'beta' })]);
    for (const child of ['beta-task', 'beta-project']) {
      assert.throws(
        () => store.import([flow(`global-parent-${child}`, { kind: 'global' }, { workflowId: child, revision: 1 })]),
        /incompatible scope/,
        `全局流程不得依赖 ${child}`,
      );
    }
  } finally { store.close(); }
});

test('项目流程不得依赖任务流程；任务流程可以依赖同任务与全局', () => {
  const store = new Store(':memory:');
  try {
    store.import([flow('beta-task', { kind: 'task', projectId: 'beta', taskId: 'task-b' })]);
    assert.throws(
      () => store.import([flow('alpha-project', { kind: 'project', projectId: 'alpha' }, { workflowId: 'beta-task', revision: 1 })]),
      /incompatible scope/,
      '项目流程不得依赖别的项目的任务流程',
    );
    // 同一项目内：任务流程依赖自己的任务子流程是合法的
    store.import([flow('alpha-task', { kind: 'task', projectId: 'alpha', taskId: 'task-a' })]);
    assert.doesNotThrow(() => store.import([
      flow('alpha-task-parent', { kind: 'task', projectId: 'alpha', taskId: 'task-a' }, { workflowId: 'alpha-task', revision: 1 }),
    ]), '同任务内的依赖必须允许');
  } finally { store.close(); }
});

test('expand 不会把更窄作用域的依赖正文交给别的项目', async () => {
  const f = await fixture();
  try {
    // The import guard only stops new pairs; a library written before it can still hold
    // one. Reproduce that state by rewriting the stored revision directly.
    f.store.import([flow('beta-private', { kind: 'task', projectId: 'beta', taskId: 'task-b' })]);
    f.store.import([flow('global-wrap', { kind: 'global' })]);
    const row = f.store.db.prepare('SELECT revision, content FROM revisions WHERE id=? ORDER BY revision DESC LIMIT 1')
      .get('global-wrap') as { revision: number; content: string };
    const content = JSON.parse(String(row.content)) as Record<string, unknown>;
    const stages = content.stages as Array<Record<string, unknown>>;
    stages[0]!.dependencies = [{ workflowId: 'beta-private', revision: 1, relationship: 'prerequisite' }];
    f.store.db.prepare('UPDATE revisions SET content=? WHERE id=? AND revision=?')
      .run(JSON.stringify(content), 'global-wrap', row.revision);

    const expanded = await f.post('/v1/expand', { workflowId: 'global-wrap', stageId: 's' });
    const text = JSON.stringify(expanded.data);
    assert.equal(text.includes('流程 beta-private'), false, `不得返回他项目流程正文：${text.slice(0, 200)}`);
    assert.ok(expanded.status >= 400, `不可用的依赖必须让展开失败，实际 ${expanded.status}`);
  } finally { await f.close(); }
});
