import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { createCoreServer } from '../src/server.js';
import type { Knowledge, KnowledgeDraft, Workflow, WorkflowDraft } from '../src/schema.js';

const token = 'a'.repeat(64), adminToken = 'c'.repeat(64);
const PROJECT = 'p0';
const workflow = (id: string, title: string): WorkflowDraft => ({
  id, kind: 'workflow', title, scope: { kind: 'project', projectId: PROJECT }, baseRevision: 0,
  overview: `${title} 的完整流程入口。`, triggers: ['测试触发'], categories: [['测试']], tags: [],
  preconditions: ['已提供项目上下文'],
  stages: [{ id: 'step', title: '执行', instructions: '执行并核对。', checks: ['结果可核对'], dependencies: [] }],
  completion: ['完成'], recovery: '失败时停止并记录。', isEntryPoint: false,
});
const norm = (): KnowledgeDraft => ({
  id: 'task-norm', kind: 'norm', title: '任务交接规范',
  scope: { kind: 'project', projectId: PROJECT }, baseRevision: 0,
  body: '交接时需重新确认文件与环境状态。', deniedTools: [], hostProvided: false,
} as KnowledgeDraft);

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
  const post = async (path: string, body: unknown) => {
    const res = await fetch(endpoint + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-amb-protocol': '1' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, data: (text ? JSON.parse(text) : undefined) as Record<string, unknown> };
  };
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  };
  return { store, post, close };
}

test('任务可跨会话记录，重复 ID 只更新状态不产生重复日记', async () => {
  const f = await fixture();
  try {
    const first = await f.post('/v1/tasks/record', {
      projectId: PROJECT,
      task: { id: 'task-cross-session', title: '跨会话任务', status: 'in_progress', summary: '第一阶段', notes: '', unfinished: [] },
    });
    assert.equal(first.status, 200);
    assert.equal((first.data as { created: boolean }).created, true);

    const second = await f.post('/v1/tasks/record', {
      projectId: PROJECT,
      task: { id: 'task-cross-session', title: '跨会话任务', status: 'paused', summary: '暂停待续', notes: '', unfinished: ['待验证功能'] },
    });
    assert.equal(second.status, 200);
    assert.equal((second.data as { created: boolean }).created, false, '相同 ID 不得新建任务');

    const list = await f.post('/v1/tasks/list', { projectId: PROJECT });
    assert.equal((list.data as { tasks: unknown[] }).tasks.length, 1, '同一任务只有一条记录');
    const task = (list.data as { tasks: Array<{ status: string; unfinished: string[] }> }).tasks[0]!;
    assert.equal(task.status, 'paused');
    assert.deepEqual(task.unfinished, ['待验证功能']);
  } finally { await f.close(); }
});

test('任务状态区分成功、失败与未验证，并在终态记录完成时间', async () => {
  const f = await fixture();
  try {
    await f.post('/v1/tasks/record', { projectId: PROJECT, task: { id: 'task-failed', title: '失败任务', status: 'failed', summary: '构建失败', notes: '', unfinished: [] } });
    await f.post('/v1/tasks/record', { projectId: PROJECT, task: { id: 'task-open', title: '进行中任务', status: 'in_progress', summary: '仍在推进', notes: '', unfinished: [] } });

    const failed = await f.post('/v1/tasks/list', { projectId: PROJECT, status: 'failed' });
    assert.equal((failed.data as { tasks: unknown[] }).tasks.length, 1);
    const failedTask = (failed.data as { tasks: Array<{ status: string; completedAt: number | null }> }).tasks[0]!;
    assert.equal(failedTask.status, 'failed');
    assert.ok(typeof failedTask.completedAt === 'number', '终态必须记录完成时间');

    const open = await f.post('/v1/tasks/list', { projectId: PROJECT, status: 'in_progress' });
    const openTask = (open.data as { tasks: Array<{ completedAt: number | null }> }).tasks[0]!;
    assert.equal(openTask.completedAt, null, '进行中任务不得有完成时间');
  } finally { await f.close(); }
});

test('交接返回目标、当前规范与相关流程，并声明不迁移进程或凭据', async () => {
  const f = await fixture();
  try {
    f.store.import([norm(), workflow('task-flow', '交接相关流程')]);
    await f.post('/v1/tasks/record', {
      projectId: PROJECT,
      task: { id: 'task-handoff', title: '交接相关流程', status: 'paused', summary: '等待另一端继续', notes: '注意文件状态', unfinished: ['确认工作目录'] },
    });

    const handoff = await f.post('/v1/tasks/handoff', { projectId: PROJECT, taskId: 'task-handoff' });
    assert.equal(handoff.status, 200);
    const data = handoff.data as {
      task: { id: string }; knowledgeRevision: number;
      norms: Array<{ id: string }>; workflows: Array<{ id: string }>; caveat: string;
    };
    assert.equal(data.task.id, 'task-handoff');
    assert.equal(data.knowledgeRevision, f.store.revision);
    assert.ok(data.norms.some(n => n.id === 'task-norm'), '交接必须带上当前有效规范');
    assert.ok(data.workflows.some(w => w.id === 'task-flow'), '交接必须带上相关流程入口');
    assert.match(data.caveat, /不迁移/, '交接必须声明不迁移进程或凭据');
  } finally { await f.close(); }
});

test('不存在的任务交接返回 404 而不是空壳成功', async () => {
  const f = await fixture();
  try {
    const missing = await f.post('/v1/tasks/handoff', { projectId: PROJECT, taskId: 'task-absent' });
    assert.equal(missing.status, 404);
    assert.equal((missing.data as { code: string }).code, 'not_found');
  } finally { await f.close(); }
});

test('任务和事件采用不同保留策略：日记长期保留，原始事件按期限清理', async () => {
  let now = Date.UTC(2026, 0, 1);
  const store = new Store(':memory:', () => now);
  store.recordTask(PROJECT, { id: 'task-keep', title: '长期任务日记', status: 'completed', summary: '已完成', notes: '', unfinished: [] });
  store.event('dsh', { eventId: 'evt-temp', adapter: 'dsh', projectId: PROJECT, kind: 'turn_stopped', summary: '临时事件' });

  now += 31 * 86400000;
  const stats = store.stats();
  assert.equal(stats.events, 0, '原始事件按 30 天清理');
  assert.equal(stats.tasks, 1, '任务日记不被事件清理牵连');
  assert.equal(store.tasks(PROJECT).length, 1);
  store.close();
});
