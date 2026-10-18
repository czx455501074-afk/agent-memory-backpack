import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

/**
 * The diary must count what happened, not how much machinery it took.
 *
 * `generateJournal`'s template used `events.length`, and 94% of events on the real library
 * are heartbeats (`tool/call`, `step/start`, …). So a diary line said "共记录 1,610 个事件"
 * about a session whose actual content was a few dozen decisions — a number a reader cannot
 * check, that made every journal read the same.
 */

const PROJECT = 'p0';

test('工具与步骤心跳不再被算成要点，但仍如实报出', () => {
  const store = new Store(':memory:');
  try {
    store.recordTask(PROJECT, { id: 'task-heartbeat', title: '测试任务', status: 'in_progress', sessionIds: [] });
    const taskId = 'task-heartbeat';
    for (let index = 0; index < 3; index += 1) {
      store.event('dsh', { eventId: `hb-${index}`, adapter: 'dsh', projectId: PROJECT, taskId, kind: 'tool/call', summary: 'x' } as never);
    }
    store.event('dsh', { eventId: 'note-1', adapter: 'dsh', projectId: PROJECT, taskId, kind: 'note', summary: '一条真正的记录' } as never);
    store.event('dsh', { eventId: 'stop-1', adapter: 'dsh', projectId: PROJECT, taskId, kind: 'turn_stopped', summary: '中断' } as never);

    const journal = store.generateJournal(taskId, PROJECT) as { did: string };
    assert.match(journal.did, /2 个要点/, `要点数应为 2（note + 中断），实际：${journal.did}`);
    assert.match(journal.did, /1 次中断/, '中断另行计数，便于读者区分');
    assert.match(journal.did, /3 条工具与步骤记录/, '心跳要如实报出，只是不再与要点混为一谈');
    assert.ok(!/共记录 5 个事件/.test(journal.did), '不得再把两者相加成一个数字');
  } finally { store.close(); }
});

test('任务自带摘要时，摘要优先于模板句', () => {
  const store = new Store(':memory:');
  try {
    store.recordTask(PROJECT, {
      id: 'task-summary', title: '有摘要的任务', status: 'in_progress', sessionIds: [],
      summary: '这是调用方写的摘要',
    });
    const journal = store.generateJournal('task-summary', PROJECT) as { did: string };
    assert.match(journal.did, /这是调用方写的摘要/, '有摘要时不应退回模板句');
  } finally { store.close(); }
});
