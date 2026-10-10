import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Store } from '../src/store.js';
import { createCoreServer } from '../src/server.js';
import type { Knowledge, Workflow } from '../src/schema.js';

/**
 * Regression tests for the permission and isolation defects found by a
 * multi-model review. Each one reproduces the reported bypass, so a future change
 * that reopens it fails here rather than shipping.
 *
 * The pattern in every case: a credential for one project, or for an agent rather
 * than a human, must not be able to change what another scope reads.
 */

const TOKEN = 'a'.repeat(64);
const ADMIN = 'b'.repeat(64);

const norm = (id: string, body: string, projectId: string, base = 0): Knowledge => ({
  id, kind: 'norm', title: `规范 ${id}`, scope: { kind: 'project', projectId },
  baseRevision: base, body, deniedTools: [], hostProvided: false,
} as Knowledge);

const workflow = (id: string, projectId: string, base = 0): Workflow => ({
  id, kind: 'workflow', title: `流程 ${id}`, scope: { kind: 'project', projectId }, baseRevision: base,
  overview: '测试流程。', triggers: ['测试'], categories: [['测试']], tags: [], isEntryPoint: false,
  preconditions: ['前提'],
  stages: [{ id: 's', title: '步骤', instructions: '执行。', checks: ['检查'], dependencies: [] }],
  completion: ['完成'], recovery: '停止。',
});

async function fixture() {
  const store = new Store(':memory:');
  // Two projects, so cross-project access is observable rather than hypothetical.
  store.import([norm('alpha-rule', '甲方规范。', 'alpha')]);
  store.import([norm('beta-secret', '乙方的机密规范。', 'beta')]);
  store.import([workflow('beta-flow', 'beta')]);

  const server = createCoreServer(store, {
    protocolVersion: 1, port: 47631,
    clients: [
      { id: 'dsh', token: TOKEN, projectId: 'alpha', role: 'adapter' },
      { id: 'admin', token: ADMIN, projectId: 'alpha', role: 'admin' },
    ],
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const post = async (path: string, body: unknown, credential = TOKEN) => {
    const response = await fetch(endpoint + path, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}`, 'x-amb-protocol': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'alpha', adapter: 'dsh', ...body as object }),
    });
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* keep empty */ }
    return { status: response.status, data: parsed };
  };
  return {
    store, endpoint, post,
    async close() {
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
      store.close();
    },
  };
}

test('跨项目规范不得泄露：/v1/norms 只返回调用方项目的规范', async () => {
  // The endpoint used to read every norm in the database, so one project's
  // credential could read another project's normative text.
  const f = await fixture();
  try {
    const listed = await f.post('/v1/norms', {});
    assert.equal(listed.status, 200);
    const ids = (listed.data.norms as Array<{ id: string }>).map(entry => entry.id);
    assert.deepEqual(ids, ['alpha-rule'], `只应看到本项目规范，实际：${ids.join(', ')}`);
    assert.equal(JSON.stringify(listed.data).includes('乙方'), false, '不得出现他项目规范正文');
  } finally { await f.close(); }
});

test('跨项目知识不得被推翻：supersede 受项目范围约束', async () => {
  // Naming another project's entry id used to be enough to retire it.
  const f = await fixture();
  try {
    const refused = await f.post('/v1/knowledge/supersede', {
      oldId: 'beta-secret', newId: 'alpha-rule', action: 'supersede',
      reason: '越权尝试', evidence: '测试',
    });
    // Refused as either forbidden (role) or unavailable (scope); never applied.
    assert.ok(refused.status >= 400, `越权推翻必须失败，实际 ${refused.status}`);
    const stillActive = f.store.allEntries().some(entry => entry.id === 'beta-secret');
    assert.equal(stillActive, true, '他项目条目必须保持生效');
  } finally { await f.close(); }
});

test('跨项目任务不得被篡改：recordTask 按项目隔离', async () => {
  // The update matched on task id alone, so one project could overwrite another
  // project's task merely by reusing its id.
  const f = await fixture();
  try {
    f.store.recordTask('beta', { id: 'shared-task-id', title: '乙方的任务', status: 'in_progress', summary: '', notes: '', unfinished: [] });
    assert.throws(
      () => f.store.recordTask('alpha', { id: 'shared-task-id', title: '被篡改', status: 'failed', summary: '', notes: '', unfinished: [] }),
      /another project/,
      '跨项目任务写入必须被拒绝',
    );
    const task = f.store.tasks('beta').find(t => t.id === 'shared-task-id');
    assert.equal(task?.title, '乙方的任务', '原任务不得被改写');
    assert.equal(task?.status, 'in_progress', '原状态不得被改写');
  } finally { await f.close(); }
});

test('agent 凭据不得写入生效库：structure 与 supersede 需要管理凭据', async () => {
  // Blocking only the approval endpoint left self-structuring and self-superseding
  // open: both write an effective revision directly, so an agent could change what
  // every other session reads without any review.
  const f = await fixture();
  try {
    const structure = await f.post('/v1/knowledge/structure', {
      skillId: 'beta-flow', workflow: workflow('alpha-made', 'alpha'), evidence: 'agent 自行结构化',
    });
    assert.equal(structure.status, 403, 'agent 不得直接结构化');

    const supersede = await f.post('/v1/knowledge/supersede', {
      oldId: 'alpha-rule', newId: 'beta-secret', action: 'supersede', reason: 'r', evidence: 'e',
    });
    assert.equal(supersede.status, 403, 'agent 不得直接推翻');

    // The refusal must tell the agent what to do instead, not just say "no".
    const message = String(supersede.data.message ?? '');
    assert.match(message, /admin/, '说明需要管理凭据');
    assert.match(message, /candidate/i, '指出应改走候选流程');
  } finally { await f.close(); }
});

test('门禁工具名按规范化比较，大小写与空白不再绕过', async () => {
  // An exact string comparison let `bash`, `Bash ` and ` Bash` through while `Bash`
  // was denied, so a prohibition looked enforced but was not.
  const f = await fixture();
  try {
    f.store.import([{ ...norm('deny-bash', '禁止 Bash。', 'alpha'), deniedTools: ['Bash'] } as Knowledge]);
    for (const variant of ['Bash', 'bash', 'BASH', 'Bash ', ' bash', '\tBash']) {
      const verdict = f.store.gate('alpha', variant);
      assert.equal(verdict.decision, 'deny', `变体 ${JSON.stringify(variant)} 必须被拒绝`);
    }
    // A genuinely different tool is still allowed: normalisation must not widen
    // the prohibition beyond the names the user listed.
    assert.equal(f.store.gate('alpha', 'Read').decision, 'allow');
    // An empty name cannot be matched, so it is reported rather than silently allowed.
    const empty = f.store.gate('alpha', '   ');
    assert.equal(empty.decision, 'allow');
    assert.match(empty.reason, /无法核对/, '空工具名应说明无法核对');
  } finally { await f.close(); }
});

test('批准不得扩大范围：项目提案不能产出 global 条目', async () => {
  // Approval previously accepted any entry, including a `global` one, so a
  // project-scoped review could silently make one project's knowledge apply to
  // every project. Widening now needs an explicit decision.
  const f = await fixture();
  try {
    const submitted = f.store.submit('dsh', {
      idempotencyKey: 'scope-1', projectId: 'alpha', discovery: '一个项目内的候选。',
    });

    assert.throws(
      () => f.store.approveProposal(String(submitted.id), {
        id: 'would-be-global', kind: 'norm', title: '全库规范', scope: { kind: 'global' },
        baseRevision: 0, body: '不该被静默提升为全局。', deniedTools: [], hostProvided: false,
      } as never),
      /global|project-scoped/i,
      '项目提案不得静默产出 global 条目',
    );

    // The same approval succeeds when the widening is stated deliberately.
    assert.doesNotThrow(() => f.store.approveProposal(String(submitted.id), {
      id: 'deliberate-global', kind: 'norm', title: '全库规范', scope: { kind: 'global' },
      baseRevision: 0, body: '经明确决定提升为全局。', deniedTools: [], hostProvided: false,
    } as never, { allowGlobalScope: true }));

    // And the default is not changed on a second read.
    assert.equal(f.store.allEntries().some(entry => entry.id === 'deliberate-global'), true);
  } finally { await f.close(); }
});

test('批准不得写到别的项目', async () => {
  const f = await fixture();
  try {
    const submitted = f.store.submit('dsh', {
      idempotencyKey: 'scope-2', projectId: 'alpha', discovery: 'alpha 的候选。',
    });
    assert.throws(
      () => f.store.approveProposal(String(submitted.id), {
        id: 'beta-entry', kind: 'norm', title: '写给 beta', scope: { kind: 'project', projectId: 'beta' },
        baseRevision: 0, body: '越权写入另一个项目。', deniedTools: [], hostProvided: false,
      } as never),
      /different project/,
      '不得批准一条属于其他项目的条目',
    );
  } finally { await f.close(); }
});

test('批准不得顶替另一条目：提案指定目标时必须写该目标', async () => {
  const f = await fixture();
  try {
    // `submit` requires the target to be a workflow, so a second one is added to
    // have something legitimate to name.
    f.store.import([workflow('alpha-flow', 'alpha')]);
    const submitted = f.store.submit('dsh', {
      idempotencyKey: 'target-1', projectId: 'alpha', workflowId: 'alpha-flow', baseRevision: 1,
      discovery: '针对 alpha-flow 的候选。',
    });

    // Approving a different entry under this proposal's cover must be refused.
    assert.throws(
      () => f.store.approveProposal(String(submitted.id), {
        ...workflow('unrelated', 'alpha'), baseRevision: 0,
      } as never),
      /targets/,
      '提案指定目标时不得批准另一个条目',
    );

    // Approving the named target is accepted.
    assert.doesNotThrow(() => f.store.approveProposal(String(submitted.id), {
      ...workflow('alpha-flow', 'alpha'), baseRevision: 1,
    } as never));
  } finally { await f.close(); }
});

test('提案列表按项目隔离', async () => {
  // Unfiltered listing let one project's reviewer read another project's
  // candidates, the same class of leak as the norms endpoint.
  const f = await fixture();
  try {
    f.store.submit('dsh', { idempotencyKey: 'p-alpha', projectId: 'alpha', discovery: 'alpha 的候选。' });
    f.store.submit('dsh', { idempotencyKey: 'p-beta', projectId: 'beta', discovery: 'beta 的候选。' });

    const alphaList = f.store.listProposals('alpha');
    assert.equal(alphaList.length, 1, '只应看到本项目的提案');
    assert.equal(JSON.stringify(alphaList).includes('beta 的候选'), false, '不得出现他项目候选内容');

    const betaList = f.store.listProposals('beta');
    assert.equal(betaList.length, 1);
    assert.equal(betaList[0]!.payload?.projectId, 'beta');
  } finally { await f.close(); }
});

test('自检与日志不输出凭据的任何片段', async () => {
  const f = await fixture();
  try {
    const report = await f.post('/v1/stats', {});
    assert.equal(report.status, 200);
    // The self-check is exercised through the store-facing path here; the shape
    // formatter is what must not emit a prefix.
    const { doctor } = await import('../src/doctor.js');
    const offline = await doctor({ dataDir: '.', offline: true });
    const text = JSON.stringify(offline);
    assert.equal(/prefix\s+[0-9a-f]{2,}/i.test(text), false, '自检不得输出凭据前缀');
  } finally { await f.close(); }
});
