import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

/**
 * Task diary, cross-session association, handoff and export.
 *
 * The design requires a task to span several sessions, a diary built from what
 * actually happened, three distinct outcomes, and a handoff that names the files
 * the receiving end must re-check. Each of those is a property that a plausible
 * implementation could get subtly wrong, so each has its own case below.
 */

const clock = { now: 1_700_000_000_000 };
const open = () => new Store(':memory:', () => clock.now);

test('同一任务跨多个会话，且会话查得到自己正在做的任务', () => {
  const s = open();
  try {
    const first = s.startTaskForSession('p', 'session-a', '整理迁移流程');
    assert.equal(first.created, true, '首次会话应创建任务');

    // A second session joins the same task rather than opening a new one.
    const same = s.startTaskForSession('p', 'session-a', '整理迁移流程');
    assert.equal(same.id, first.id, '同一会话应回到同一任务');
    assert.equal(same.created, false);

    // Linking a second session to the first one's task is explicit.
    s.recordTask('p', {
      id: first.id, title: '整理迁移流程', status: 'in_progress',
      sessionIds: ['session-a', 'session-b'],
    });
    assert.equal(s.taskForSession('p', 'session-b')?.id, first.id,
      '第二个会话应找到同一个任务，而不是各自新建');

    // A different session still gets its own task.
    const other = s.startTaskForSession('p', 'session-z', '另一件事');
    assert.notEqual(other.id, first.id, '无关会话不应并入既有任务');
  } finally { s.close(); }
});

test('更新状态不会清掉先前记录的关联与未完成项', () => {
  const s = open();
  try {
    s.recordTask('p', {
      id: 't1', title: '任务一', status: 'in_progress', summary: '做了些事',
      notes: '关键观察', unfinished: ['待验证 X'],
      sessionIds: ['s1'], relatedExperiences: ['exp-1'], files: ['src/a.ts'], verified: '运行了测试',
    });
    // A status-only update, as an adapter would send at turn end.
    s.recordTask('p', { id: 't1', title: '任务一', status: 'paused' });
    const task = s.getTask('t1', 'p')!;
    assert.equal(task.status, 'paused');
    assert.equal(task.summary, '做了些事', '状态更新不得清空摘要');
    assert.deepEqual(task.unfinished, ['待验证 X'], '状态更新不得清空未完成项');
    assert.deepEqual(task.relatedExperiences, ['exp-1'], '状态更新不得清空关联经验');
    assert.deepEqual(task.files, ['src/a.ts'], '状态更新不得清空文件清单');
    assert.equal(task.verified, '运行了测试', '状态更新不得清空验证依据');
  } finally { s.close(); }
});

test('日记由任务事实生成；完成但无验证依据记为未验证，不冒充成功', () => {
  const s = open();
  try {
    s.recordTask('p', { id: 't1', title: '任务一', status: 'in_progress', summary: '完成了迁移' });

    // Completed without a verification basis.
    s.recordTask('p', { id: 't1', title: '任务一', status: 'completed', summary: '完成了迁移' });
    const unverified = s.generateJournal('t1', 'p');
    assert.equal(unverified.outcome, 'unverified',
      '完成但没有验证依据时必须记为未验证，这是设计要求区分的三态之一');
    assert.match(unverified.title, /任务一/, '日记标题应指向任务');

    // The same task with a stated verification basis is a success.
    s.recordTask('p', { id: 't1', title: '任务一', status: 'completed', summary: '完成了迁移', verified: '迁移后 165 条可检索' });
    assert.equal(s.generateJournal('t1', 'p').outcome, 'success');

    // A failed task is a failure regardless of any verification text.
    s.recordTask('p', { id: 't2', title: '任务二', status: 'failed' });
    assert.equal(s.generateJournal('t2', 'p').outcome, 'failure');
  } finally { s.close(); }
});

test('日记作为知识落库，可重复生成而只保留一条', () => {
  const s = open();
  try {
    s.recordTask('p', { id: 't1', title: '任务一', status: 'completed', summary: '做完了', verified: '已核对' });
    const first = s.writeJournal('t1', 'p');
    assert.equal(first.replaced, false);
    const second = s.writeJournal('t1', 'p');
    assert.equal(second.replaced, true, '重复生成应更新同一条日记，而不是新增');

    const journals = s.allEntries().filter(entry => entry.content.kind === 'journal');
    assert.equal(journals.length, 1, '同一任务只应有一条日记');
    assert.equal(journals[0]!.content.kind === 'journal' && journals[0]!.content.outcome, 'success');
  } finally { s.close(); }
});

test('交接带上待核对文件、验证结果与建议下一步，并声明未替对方核对', () => {
  const s = open();
  try {
    s.recordTask('p', {
      id: 't1', title: '迁移任务', status: 'paused', summary: '迁移到一半',
      unfinished: ['核对设备 B 的条目数'], files: ['src/store.ts', 'docs/x.md'],
      verified: 'A 端导出成功',
    });
    const handoff = s.handoff('t1', 'p');
    assert.deepEqual(handoff.files, ['src/store.ts', 'docs/x.md'], '必须列出待核对文件');
    assert.equal(handoff.verification.verified, 'A 端导出成功', '必须带上验证结果');
    assert.match(handoff.suggestion, /核对设备 B/, '建议下一步应来自未完成项');
    // The caveat must be explicit that the check has not been performed here.
    assert.match(handoff.caveat, /未.*核对|重新确认/, '必须声明未替接收端核对');
    assert.deepEqual(handoff.norms, [], '规范照常带上');
  } finally { s.close(); }
});

test('任务导出 Markdown 可读且包含关键信息，JSON 保留完整记录', () => {
  const s = open();
  try {
    s.recordTask('p', {
      id: 't1', title: '导出任务', status: 'completed', summary: '做了 A 与 B',
      notes: '用户补充的观察', unfinished: ['后续优化 Y'], files: ['a.ts'],
      relatedExperiences: ['exp-9'], verified: '测试通过',
    });
    s.event('codex', { eventId: 'e1', adapter: 'codex', projectId: 'p', taskId: 't1', kind: 'tool_used', summary: '运行了测试' });

    const md = s.exportTask('t1', 'p').markdown;
    for (const expected of ['导出任务', 't1', '做了 A 与 B', '用户补充的观察', '后续优化 Y', 'a.ts', 'exp-9', '测试通过']) {
      assert.ok(md.includes(expected), `Markdown 应包含 ${expected}`);
    }
    assert.match(md, /完成（有验证依据）/, '有验证依据的完成应如实标注');
    assert.match(md, /不是行为指令/, '必须声明日记不是行为指令');

    const json = s.exportTask('t1', 'p').json;
    assert.equal((json.task as { id: string }).id, 't1');
    assert.equal(json.events.length, 1, 'JSON 应带上事件');
    assert.equal(typeof json.exportedAt, 'number');
  } finally { s.close(); }
});

test('未验证的完成在导出中不读作成功', () => {
  const s = open();
  try {
    s.recordTask('p', { id: 't1', title: '没验证的任务', status: 'completed', summary: '声称完成' });
    const md = s.exportTask('t1', 'p').markdown;
    assert.match(md, /未验证/, '没有验证依据的完成必须标为未验证');
    assert.equal(/完成（有验证依据）/.test(md), false, '不得读作有依据的成功');
  } finally { s.close(); }
});
