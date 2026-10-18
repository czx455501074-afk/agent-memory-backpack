import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

/**
 * The data layer's two new claims, each pinned by something that can fail.
 *
 * 1. The three event reads (`taskActivity`, `generateJournal`, `exportTask`) ask the
 *    database for the rows they need instead of reading the whole stream and filtering
 *    in JavaScript. On the real library that stream holds 56,870 rows, and the three
 *    statements measured 98.16 / 86.95 / 85.96 ms per call — on a path an agent hits
 *    every turn. The plan is asserted, not the clock: a timing assertion on a 0.03 ms
 *    statement is a flake generator, while `SCAN events` in the plan is the defect
 *    itself and is stable.
 *
 * 2. The active library is decoded once per revision. The risk this introduces is a
 *    stale read, so the cache is tested from the two directions that can produce one:
 *    a write on the same connection, and a write on a *different* connection to the
 *    same file. The second is the reason the key is the revision stored in the
 *    database rather than a counter in this object.
 */

const clock = { now: 1_700_000_000_000 };
const PROJECT = 'p0';
const OTHER = 'p1';

const memory = (id: string) => ({
  id, baseRevision: 0, kind: 'memory' as const, title: `条目 ${id}`, body: `正文 ${id}`,
  scope: { kind: 'global' as const },
});

const plan = (store: Store, sql: string, params: unknown[]) => store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`)
  .all(...(params as never[])).map(row => String((row as { detail: string }).detail)).join(' | ');

test('三条事件读取与候选队列查询都走索引，不是全表扫描', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'amb-event-plan-'));
  const store = new Store(join(dir, 'knowledge.sqlite'), () => clock.now);
  try {
    // The statements are copied here on purpose. Asserting the plan of the *product's*
    // statement would need the statement to be reachable, and these four are the ones
    // whose shape is load-bearing. If a later change rewrites them the equivalence test
    // below still protects behaviour; this one is what protects the index from being
    // dropped as "unused".
    const queries: Array<[string, string, unknown[]]> = [
      ['taskActivity',
        `SELECT id,payload,created_at FROM events
         WHERE json_extract(payload,'$.taskId')=? AND json_extract(payload,'$.projectId')=?
         ORDER BY created_at DESC LIMIT 100`, ['t', PROJECT]],
      ['generateJournal',
        `SELECT payload, created_at FROM events
         WHERE json_valid(payload)
           AND (json_extract(payload,'$.taskId')=?
                OR ((json_extract(payload,'$.taskId') IS NULL OR json_extract(payload,'$.taskId')='')
                    AND json_extract(payload,'$.sessionId') IN (?)))
           AND (json_extract(payload,'$.projectId') IS NULL OR json_extract(payload,'$.projectId')=?)
         ORDER BY created_at`, ['t', 's', PROJECT]],
      ['exportTask',
        `SELECT json_extract(payload,'$.taskId') AS taskId, created_at FROM events
         WHERE json_valid(payload) AND json_extract(payload,'$.taskId')=?
           AND (json_extract(payload,'$.projectId') IS NULL OR json_extract(payload,'$.projectId')=?)
         ORDER BY created_at`, ['t', PROJECT]],
      ['review queue',
        `SELECT id,payload FROM proposals WHERE 1=1 AND project_id = ? ORDER BY created_at DESC`, [PROJECT]],
    ];

    // A loop that asserts per item must first assert there is something to iterate:
    // an empty list here would make every assertion below vacuous and green.
    assert.ok(queries.length >= 4, '至少要有四条查询参与计划断言');
    for (const [name, sql, params] of queries) {
      const detail = plan(store, sql, params as unknown[]);
      assert.doesNotMatch(detail, /SCAN events|SCAN proposals/, `${name} 不得全表扫描：${detail}`);
      assert.match(detail, /USING INDEX/, `${name} 必须使用索引：${detail}`);
    }

    // Naming the index matters, not just "an index was used". A standalone
    // `events_project` index is a legal choice for the two-condition query — a project
    // matches almost every row — and it measured 57.37 ms against 0.02 ms on the real
    // stream. `USING INDEX` alone would have called that a pass.
    const dual = plan(store,
      `SELECT id,payload,created_at FROM events
       WHERE json_extract(payload,'$.taskId')=? AND json_extract(payload,'$.projectId')=?
       ORDER BY created_at DESC LIMIT 100`, ['t', PROJECT]);
    assert.match(dual, /USING INDEX events_task/, `双条件事件查询必须落在 events_task 上：${dual}`);
    assert.doesNotMatch(dual, /events_project/, `不得选中 project 单列索引：${dual}`);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('事件读取按任务/会话/项目过滤，跨项目与他任务事件都不出现', () => {
  const store = new Store(':memory:', () => clock.now);
  try {
    store.recordTask(PROJECT, { id: 'T1', title: '任务一', status: 'in_progress', sessionIds: ['s1'] });
    store.recordTask(PROJECT, { id: 'T2', title: '任务二', status: 'in_progress', sessionIds: ['s2'] });
    const add = (eventId: string, payload: Record<string, unknown>) => store.event('agent', { eventId, ...payload });
    add('e-a', { projectId: PROJECT, taskId: 'T1', kind: 'step', summary: 'A' });
    add('e-b', { projectId: PROJECT, taskId: 'T2', kind: 'step', summary: 'B' });
    // No task id, but one of T1's sessions: the diary counts it, the export does not.
    add('e-c', { projectId: PROJECT, sessionId: 's1', kind: 'note', summary: 'C' });
    // Right task id, wrong project. `event()` already refuses this at write time
    // (`scope_denied`), so the row is inserted directly to stand in for one written
    // before that check existed — the read paths are the second line of defence and
    // have to hold on their own.
    store.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run('evt-d', 'agent', 'e-d', 'fp-d',
      JSON.stringify({ eventId: 'e-d', projectId: OTHER, taskId: 'T1', kind: 'step', summary: 'D' }),
      clock.now, clock.now + 86_400_000);
    add('e-e', { projectId: PROJECT, sessionId: 's2', kind: 'note', summary: 'E' });

    const activity = store.taskActivity(PROJECT, { taskId: 'T1' });
    const activityIds = activity.events.map(event => event.eventId).sort();
    assert.ok(activityIds.length >= 1, '任务活动必须有事件可断言，空集会让下面的比较形同虚设');
    // Strict task-id match, which is what the previous JavaScript filter did: an event
    // that only names the session belongs to the diary, not to the activity stream.
    // Listing `e-c` here would be a behaviour change disguised as a test expectation.
    assert.deepEqual(activityIds, ['e-a'], `任务活动只应按任务 id 匹配：${activityIds.join(',')}`);

    // Two events: the one naming the task, and the one naming its session.
    const journal = store.generateJournal('T1', PROJECT);
    // The unit changed on purpose (`事件` → `要点`, because heartbeats no longer count as
    // content), so this pins the number and not the noun: what this case is about is that
    // the session-only event is included and the other project's event is not.
    assert.match(journal.did, /共记录 2 个/, `日记应统计 2 条（含会话事件），实际：${journal.did}`);

    // One event: the export keys on the task id, so the session-only event is out.
    const exported = store.exportTask('T1', PROJECT).json.events;
    assert.ok(exported.length >= 1, '导出必须至少包含一条事件，否则下面的断言不检查任何东西');
    assert.deepEqual(exported.map(event => event.kind), ['step']);
    assert.equal(exported.length, 1, '会话事件没有任务 id，不应出现在按任务导出里');
  } finally { store.close(); }
});

test('活动库按 revision 缓存，同一 revision 内不再重复解码', () => {
  const store = new Store(':memory:', () => clock.now);
  try {
    store.import([memory('m1')]);
    const first = store.allEntries();
    const second = store.allEntries();
    assert.ok(first.length >= 1, '库内至少一条，否则无法区分“缓存命中”与“本来就空”');
    // Same array identity proves the decode was not repeated. A future change that
    // returns a defensive copy is fine, but it must replace this assertion with a
    // probe that still proves the second call did not re-read the table.
    assert.equal(second, first, '同一 revision 下的第二次读取应命中缓存');
  } finally { store.close(); }
});

test('写入后缓存立即失效，读到的条数随之增加', () => {
  const store = new Store(':memory:', () => clock.now);
  try {
    store.import([memory('m1')]);
    const before = store.allEntries();
    assert.equal(before.length, 1);
    store.import([memory('m2')]);
    const after = store.allEntries();
    assert.equal(after.length, before.length + 1, '写入 bump revision，下一次读取必须重新加载');
    assert.deepEqual(after.map(entry => entry.id).sort(), ['m1', 'm2']);
  } finally { store.close(); }
});

test('写入持久性档位是显式设置的 NORMAL，不是默认值', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'amb-sync-'));
  const store = new Store(join(dir, 'knowledge.sqlite'), () => clock.now);
  try {
    // 1 = NORMAL, 2 = FULL, 0 = OFF. Pinned because the difference is invisible in any
    // functional test and worth 21x on write throughput (measured: 1,009 -> 21,409 event
    // inserts per second). A silent revert to FULL would look like a slow machine; a
    // silent move to OFF would look like nothing at all until a crash corrupted a library.
    const { synchronous } = store.db.prepare('PRAGMA synchronous').get() as { synchronous: number };
    assert.equal(synchronous, 1, `必须显式为 NORMAL（1），实际 ${synchronous}`);
    const { journal_mode: journalMode } = store.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    assert.equal(journalMode, 'wal', `必须为 WAL，实际 ${journalMode}`);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('另一个连接写入后，本连接不会返回陈旧的缓存快照', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'amb-current-cache-'));
  const path = join(dir, 'knowledge.sqlite');
  const reader = new Store(path, () => clock.now);
  const writer = new Store(path, () => clock.now);
  try {
    reader.import([memory('m-local')]);
    assert.deepEqual(reader.allEntries().map(entry => entry.id), ['m-local'], '先建立缓存');

    // A second connection stands in for `amb reclassify` running while the core is up.
    writer.import([memory('m-remote')]);
    const seen = reader.allEntries().map(entry => entry.id).sort();
    assert.deepEqual(seen, ['m-local', 'm-remote'],
      '缓存键必须来自数据库里的 revision，否则另一个进程的写入会被永久遮蔽');
  } finally {
    reader.close();
    writer.close();
    await rm(dir, { recursive: true, force: true });
  }
});
