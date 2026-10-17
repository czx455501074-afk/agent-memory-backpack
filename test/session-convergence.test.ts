import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store, TASK_ARCHIVE_AFTER_MS, TASK_IDLE_CONVERGE_MS, taskArchiveId } from '../src/store.js';
import { createCoreServer } from '../src/server.js';

/**
 * The session-end rule, and the task scope it finally gives data to.
 *
 * The failure being pinned: a session ends and its task stays `in_progress` for
 * ever, because only a caller ever wrote a status; and the "this time only" scope
 * holds nothing at all, because no core path ever wrote one. Both are asserted
 * here against a controlled clock, since the rule is entirely about elapsed time.
 *
 * `paused` and never `completed` is the load-bearing assertion. Completion is an
 * assertion with evidence attached (`checkpointTask` refuses one without verified
 * text and a checkable evidence level), so a timer that closed tasks would be the
 * clock making a claim no one verified.
 */

const token = 'a'.repeat(64), adminToken = 'c'.repeat(64);
const PROJECT = 'p0';
const HOUR = 3600_000;
/** Fixed base so every elapsed time in this file is exact. */
const T0 = Date.UTC(2026, 9, 1, 0, 0, 0);

function memoryStore(clock: { at: number } = { at: T0 }) {
  return { store: new Store(':memory:', () => clock.at), clock };
}

async function fixture() {
  const clock = { at: T0 };
  const store = new Store(':memory:', () => clock.at);
  const server = createCoreServer(store, {
    protocolVersion: 1, port: 47635, clients: [
      { id: 'dsh', token, projectId: PROJECT, role: 'adapter' },
      { id: 'admin', token: adminToken, projectId: PROJECT, role: 'admin' },
    ],
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const post = async (path: string, body: unknown, admin = false) => {
    const res = await fetch(endpoint + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin ? adminToken : token}`, 'Content-Type': 'application/json', 'x-amb-protocol': '1' },
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
  return { store, clock, post, close };
}

test('无进展的任务被收敛为 paused，并在自己的记录里写明原因', () => {
  const { store, clock } = memoryStore();
  try {
    store.recordTask(PROJECT, {
      id: 'task-stalled', title: '停下的会话', status: 'in_progress',
      sessionIds: ['sess-1'], summary: '第一阶段已完成', unfinished: ['核对结果'],
    });
    clock.at = T0 + 13 * HOUR;

    const result = store.convergeTasks(PROJECT);
    assert.equal(result.dryRun, false);
    assert.equal(result.thresholds.idleMs, TASK_IDLE_CONVERGE_MS, '默认阈值必须来自代码里的默认值');
    assert.deepEqual(result.converged.map(item => item.taskId), ['task-stalled']);

    const task = store.getTask('task-stalled', PROJECT);
    assert.ok(task);
    assert.equal(task.status, 'paused', '长期无活动只能收敛为 paused');
    assert.notEqual(task.status, 'completed', '收敛不得把任务标成完成');
    assert.equal(task.completedAt, null, '不是完成就不能写完成时间');
    assert.equal(task.summary, '第一阶段已完成', '收敛不得丢掉已有的摘要');
    assert.deepEqual(task.unfinished, ['核对结果'], '收敛不得丢掉未完成项');
    assert.match(task.notes, /\[自动收敛 /, '必须写明是自动收敛的');
    assert.match(task.notes, /会话已结束/, '必须写明原因');
    assert.match(task.notes, /阈值 12\.0 小时/, '必须写明触发规则用到的阈值');
    assert.match(task.notes, /这不是完成/, '必须写明它不是完成声明');
  } finally { store.close(); }
});

test('有进展的、以及仍在活跃窗口内的任务都不被误收敛', () => {
  const { store, clock } = memoryStore();
  try {
    store.recordTask(PROJECT, { id: 'task-stale', title: '早已停下', status: 'in_progress', sessionIds: ['s1'] });
    store.recordTask(PROJECT, { id: 'task-active', title: '还在推进', status: 'in_progress', sessionIds: ['s2'] });
    // Recorded progress twelve hours in, which leaves it idle for one hour when the
    // rule runs: a task that has just moved is not a task whose session has ended.
    clock.at = T0 + 12 * HOUR;
    store.recordTask(PROJECT, { id: 'task-active', title: '还在推进', status: 'in_progress', summary: '又推进了一步' });

    clock.at = T0 + 13 * HOUR;
    const result = store.convergeTasks(PROJECT);
    assert.deepEqual(result.converged.map(item => item.taskId), ['task-stale'], '只收敛真正停下的那个');
    const active = store.getTask('task-active', PROJECT);
    assert.equal(active?.status, 'in_progress', '刚有进展的任务保持进行中');
    assert.equal(active?.summary, '又推进了一步', '收敛规则不得触碰还在推进的任务');
    const kept = result.kept.find(item => item.taskId === 'task-active');
    assert.ok(kept, '仍在窗口内的任务必须出现在 kept 里，而不是被静默跳过');
    assert.equal(kept.status, 'in_progress');
    assert.match(kept.reason, /活跃阈值内/);
  } finally { store.close(); }
});

test('终态任务不被时间规则改写', () => {
  const { store, clock } = memoryStore();
  try {
    store.recordTask(PROJECT, {
      id: 'task-done', title: '已完成', status: 'completed', verified: '复跑 3/3 通过', evidence: 'verifiable',
    });
    store.recordTask(PROJECT, { id: 'task-cancelled', title: '已取消', status: 'cancelled' });
    clock.at = T0 + 200 * HOUR;

    const result = store.convergeTasks(PROJECT);
    assert.deepEqual(result.converged, []);
    assert.deepEqual(result.archived.map(item => item.taskId), [], '终态任务不需要归档日记');
    assert.equal(store.getTask('task-done', PROJECT)?.status, 'completed');
    assert.equal(store.getTask('task-cancelled', PROJECT)?.status, 'cancelled');
    assert.equal(result.kept.filter(item => /终态/.test(item.reason)).length, 2);
  } finally { store.close(); }
});

test('会话结束后 task 作用域条目被归档保留，并且可查、不泄漏', () => {
  const { store, clock } = memoryStore();
  try {
    store.recordTask(PROJECT, {
      id: 'task-archived', title: '归档候选', status: 'in_progress',
      sessionIds: ['sess-3'], summary: '做了一半', notes: '换行符那处还没确认',
    });
    clock.at = T0 + 49 * HOUR;

    const result = store.convergeTasks(PROJECT);
    assert.equal(result.archived.length, 1, '超过归档时长的任务必须留下 task 作用域条目');
    assert.equal(result.archived[0]?.taskId, 'task-archived');
    assert.equal(result.archived[0]?.unchanged, false);

    const scoped = store.taskScopedEntries(PROJECT, 'task-archived');
    assert.equal(scoped.length, 1, '归档是新增条目，不是改写任务本身');
    assert.equal(scoped[0]?.id, taskArchiveId('task-archived'));
    assert.deepEqual(scoped[0]?.scope, { kind: 'task', projectId: PROJECT, taskId: 'task-archived' });
    assert.equal(scoped[0]?.kind, 'journal');

    const activity = store.taskActivity(PROJECT, { taskId: 'task-archived' });
    assert.equal((activity.taskScoped as unknown[]).length, 1, '任务视图必须能查到归档条目');
    assert.equal(activity.journal, null, '没有 checkpoint 就没有项目作用域日记，不能拿归档条目冒充');
    const scopedRead = (activity.taskScoped as Array<{ excerpt: string; problems: string; promotable: boolean }>)[0]!;
    assert.match(scopedRead.excerpt, /做了一半/, '归档条目的正文必须可读，不能只有标题');
    assert.match(scopedRead.problems, /换行符那处还没确认/, '任务备注随归档保留下来');
    assert.equal(scopedRead.promotable, true);

    // The scope's whole purpose: without a task in hand, the one-time entry is not
    // a candidate for this or any later session.
    const search = store.searchUniversal(PROJECT, '归档候选');
    assert.equal(search.some(entry => entry.id === scoped[0]!.id), false, '不带 taskId 的检索不得看到它');
    const readable = store.knowledge(PROJECT, '归档候选');
    assert.equal(readable.some(entry => entry.id === scoped[0]!.id), false, 'knowledge 入口同样不得看到它');

    const task = store.getTask('task-archived', PROJECT);
    assert.ok(task);
    assert.equal(task.status, 'paused');
    assert.match(task.notes, /\[会话归档\] journal-task-task-archived/, '任务自己必须说明归档去了哪里');
    assert.match(task.notes, /换行符那处还没确认/, '任务原有备注不得被覆盖');
    assert.equal(task.completedAt, null, '归档不是完成');
  } finally { store.close(); }
});

test('收敛幂等：重复执行不产生重复条目、重复修订或重复说明', () => {
  const { store, clock } = memoryStore();
  try {
    store.recordTask(PROJECT, { id: 'task-idem', title: '重复跑', status: 'in_progress', sessionIds: ['s9'] });
    clock.at = T0 + 49 * HOUR;

    const first = store.convergeTasks(PROJECT);
    assert.equal(first.archived.length, 1);
    const firstRevision = first.archived[0]!.revision;
    const storeRevisionAfterFirst = store.revision;
    const rowsAfterFirst = store.tasks(PROJECT).length;
    const notesAfterFirst = store.getTask('task-idem', PROJECT)!.notes;

    // Same instant: nothing left to converge, nothing to file again.
    const second = store.convergeTasks(PROJECT);
    assert.deepEqual(second.converged, []);
    assert.deepEqual(second.archived, [], '同一时刻重跑不得再归档一次');
    assert.equal(store.revision, storeRevisionAfterFirst, '重跑不得产生新的知识修订');
    assert.equal(store.tasks(PROJECT).length, rowsAfterFirst, '重跑不得新增任务行');
    assert.equal(store.taskScopedEntries(PROJECT, 'task-idem').length, 1);
    assert.equal(store.getTask('task-idem', PROJECT)!.notes, notesAfterFirst, '重跑不得重复追加说明');

    // Much later: the rule fires again, and the archive notices its content has not
    // moved — the earlier revision stands and no new one is written.
    clock.at = T0 + 100 * HOUR;
    const third = store.convergeTasks(PROJECT);
    assert.equal(third.archived.length, 1);
    assert.equal(third.archived[0]!.unchanged, true, '内容未变化时必须报告 unchanged');
    assert.equal(third.archived[0]!.revision, firstRevision, '内容未变化时不得新增修订');
    assert.equal(third.archived[0]!.replaced, false);
    assert.equal(store.revision, storeRevisionAfterFirst, '库修订号不得因重跑而增长');
    const refreshed = store.taskScopedEntries(PROJECT, 'task-idem');
    assert.equal(refreshed.length, 1);
    assert.equal(refreshed[0]!.revision, firstRevision, '内容未变化时不得新增修订');
  } finally { store.close(); }
});

test('归档的日记不把收敛记账写进自己的内容（否则会自我重写）', () => {
  const { store, clock } = memoryStore();
  try {
    store.recordTask(PROJECT, {
      id: 'task-notes', title: '备注分离', status: 'in_progress', notes: '真实备注：接口 426 要带协议头',
    });
    clock.at = T0 + 49 * HOUR;
    store.convergeTasks(PROJECT);

    const archived = store.taskScopedEntries(PROJECT, 'task-notes');
    assert.equal(archived.length, 1);
    const problems = archived[0]!.problems;
    assert.match(problems, /真实备注/, '会话自己的备注必须进归档');
    assert.doesNotMatch(problems, /\[自动收敛 /, '收敛说明不能进归档内容');
    assert.doesNotMatch(problems, /\[会话归档\] /, '归档说明不能进归档内容');
  } finally { store.close(); }
});

test('dryRun 只报告不写入', () => {
  const { store, clock } = memoryStore();
  try {
    store.recordTask(PROJECT, { id: 'task-dry', title: '预演', status: 'in_progress', notes: '原样' });
    clock.at = T0 + 49 * HOUR;

    const preview = store.convergeTasks(PROJECT, { dryRun: true });
    assert.equal(preview.dryRun, true);
    assert.deepEqual(preview.converged.map(item => item.taskId), ['task-dry']);
    assert.deepEqual(preview.archived.map(item => item.taskId), ['task-dry']);
    const task = store.getTask('task-dry', PROJECT);
    assert.equal(task?.status, 'in_progress', '预演不得改状态');
    assert.equal(task?.notes, '原样', '预演不得写备注');
    assert.equal(store.taskScopedEntries(PROJECT, 'task-dry').length, 0, '预演不得写条目');
  } finally { store.close(); }
});

test('阈值可配置且有下界，非法组合被拒绝', () => {
  const { store } = memoryStore();
  try {
    assert.deepEqual(store.taskConvergence(), { idleMs: TASK_IDLE_CONVERGE_MS, archiveAfterMs: TASK_ARCHIVE_AFTER_MS });
    const updated = store.setTaskConvergence({ idleMs: 2 * HOUR });
    assert.equal(updated.idleMs, 2 * HOUR);
    assert.equal(updated.archiveAfterMs, TASK_ARCHIVE_AFTER_MS, '只改一个阈值时另一个保持原值');
    assert.throws(() => store.setTaskConvergence({ idleMs: 1000 }), /at least one minute/);
    assert.throws(() => store.setTaskConvergence({ archiveAfterMs: HOUR }), /must not be shorter/);
    // A configured value is what the rule actually applies.
    assert.equal(store.taskConvergence().idleMs, 2 * HOUR);
  } finally { store.close(); }
});

test('task 作用域的提升必须由人决定，提升后全项目可见', () => {
  const { store, clock } = memoryStore();
  try {
    store.recordTask(PROJECT, { id: 'task-promote', title: '可复用结论', status: 'in_progress' });
    clock.at = T0 + 49 * HOUR;
    store.convergeTasks(PROJECT);
    const id = taskArchiveId('task-promote');
    assert.equal(store.searchUniversal(PROJECT, '可复用结论').some(entry => entry.id === id), false);

    const promoted = store.promoteTaskScope(PROJECT, id);
    assert.equal(promoted.widening, true);
    assert.deepEqual(promoted.to, { kind: 'project', projectId: PROJECT });
    assert.equal(promoted.revision, 2, '提升是同一条目的新修订，旧的任务作用域修订保留');
    const after = store.searchUniversal(PROJECT, '可复用结论');
    assert.equal(after.some(entry => entry.id === id), true, '提升后项目内可见');
    const history = store.history(id, PROJECT);
    assert.equal(history.revisions.length, 2, '提升前的窄作用域版本必须留在历史里');
  } finally { store.close(); }
});

test('无 taskId 的可查入口与端点：converge/archive/activity 可用，promote 仅限人', async () => {
  const f = await fixture();
  try {
    const started = await f.post('/v1/tasks/start', { projectId: PROJECT, sessionId: 'sess-http', title: 'HTTP 收敛' });
    assert.equal(started.status, 200);
    const taskId = String(started.data.id);
    f.clock.at = T0 + 49 * HOUR;

    const preview = await f.post('/v1/tasks/converge', { projectId: PROJECT, dryRun: true });
    assert.equal(preview.status, 200);
    assert.equal((preview.data.archived as unknown[]).length, 1);
    const untouched = await f.post('/v1/tasks/list', { projectId: PROJECT });
    const before = (untouched.data.tasks as Array<{ id: string; status: string }>).find(item => item.id === taskId);
    assert.equal(before?.status, 'in_progress', '预演后任务仍是在进行中');

    const converged = await f.post('/v1/tasks/converge', { projectId: PROJECT });
    assert.equal(converged.status, 200);
    assert.equal((converged.data.converged as unknown[]).length, 1);
    assert.equal((converged.data.archived as unknown[]).length, 1);

    const activity = await f.post('/v1/tasks/activity', { projectId: PROJECT, taskId });
    assert.equal(activity.status, 200);
    assert.equal((activity.data.taskScoped as unknown[]).length, 1);
    assert.equal(((activity.data.task as { status: string }).status), 'paused');

    const again = await f.post('/v1/tasks/archive', { projectId: PROJECT, taskId });
    assert.equal(again.status, 200);
    assert.equal(again.data.unchanged, true, '重复归档必须是幂等的');

    const forbidden = await f.post('/v1/tasks/promote', { projectId: PROJECT, knowledgeId: taskArchiveId(taskId) });
    assert.equal(forbidden.status, 403, 'adapter 不得扩大适用范围');
    assert.equal((forbidden.data as { code: string }).code, 'forbidden');

    const promoted = await f.post('/v1/tasks/promote', { projectId: PROJECT, knowledgeId: taskArchiveId(taskId) }, true);
    assert.equal(promoted.status, 200);
    assert.equal(promoted.data.widening, true);
  } finally { await f.close(); }
});
