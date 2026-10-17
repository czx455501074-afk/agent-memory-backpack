import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store, autoFailureSignature } from '../src/store.js';
import { createCoreServer } from '../src/server.js';

/**
 * W3: the review queue has to be reviewable.
 *
 * The measured failure this covers: 301 pending rows in which 98 auto-captured tool
 * failures are 43 signatures repeated (`edit::replacefilew eio` twelve times), shown
 * as equals beside 203 experiences somebody actually wrote. The tests below pin the
 * four properties the fix has to hold: same signature collapses, different signatures
 * do not, nothing under the view changes, and the folded group is reachable rather
 * than gone.
 */

const clock = { now: 1_700_000_000_000 };
const open = () => new Store(':memory:', () => clock.now);

/** Byte-for-byte the text `adapters/dsh/failure-capture.mjs` submits for a failure. */
const capturedFailure = (tool: string, observation: string, session: string) =>
  '【自动捕获的失败事实；待核实】\n'
  + '所属流程：工具执行与故障恢复；步骤：记录失败、检索已有经验、验证修复。\n'
  + `来源：dsh 会话 ${session}；工具：${tool}。\n`
  + `观察：${observation}\n`
  + '根因与修复：尚未验证；请主动检索相关经验，验证后用 amb_submit_experience 补充可复用结论。不得将本记录直接当作已采纳规范。';

let seq = 0;

/** Capture one failure through the ordinary submit path, as the adapter does. */
function capture(s: Store, tool: string, observation: string, session: string, projectId = 'p'): string {
  seq += 1;
  clock.now += 1000;
  return String(s.submit('agent', {
    idempotencyKey: `fail-${seq}`, projectId,
    discovery: capturedFailure(tool, observation, session),
  }).id);
}

/** A human submission, optionally with evidence. */
function experience(s: Store, discovery: string, evidence?: string, projectId = 'p'): string {
  seq += 1;
  clock.now += 1000;
  return String(s.submit('agent', {
    idempotencyKey: `exp-${seq}`, projectId, discovery,
    ...(evidence === undefined ? {} : { evidence }),
  }).id);
}

const asAggregate = (item: unknown) => item as {
  kind: string; signature: string; tool: string; occurrences: number;
  firstSeenAt: number; lastSeenAt: number; memberIds: string[]; sampleIds: string[];
  samples: Array<{ id: string; createdAt: number; discovery: string }>;
  priority: { band: string; score: number; reasons: string[] };
};

const bandOf = (item: unknown) => (item as { priority: { band: string } }).priority.band;
const idOf = (item: unknown) => (item as { id: string }).id;

const storedRows = (s: Store) => Number((s.db.prepare('SELECT count(*) AS n FROM proposals').get() as { n: number }).n);

test('同签名的 5 次自动捕获聚合成 1 条，计数与首末时间可见', () => {
  const s = open();
  try {
    const observation = 'cannot modify "D:\\work\\src\\a.ts": file has not been read — read the file, then retry';
    const ids = [
      capture(s, 'edit', observation, 'sess-a'),
      capture(s, 'edit', observation, 'sess-b'),
      // Different file, different session: still the same failure to a reader.
      capture(s, 'edit', observation.replace('a.ts', 'b.ts'), 'sess-c'),
      capture(s, 'edit', observation.replace('a.ts', 'c.ts'), 'sess-d'),
      capture(s, 'edit', observation, 'sess-e'),
    ];
    assert.equal(new Set(ids).size, 5, '五次提交各自入库：签名相同不等于文本相同');

    const queue = s.queueProposals('p', { include: 'failure-facts' });
    assert.equal(queue.items.length, 1, '同一签名只留一条待审条目');
    const group = asAggregate(queue.items[0]);
    assert.equal(group.kind, 'aggregate');
    assert.equal(group.occurrences, 5, '出现次数是判断该失败是否值得处理的主要依据');
    assert.equal(group.memberIds.length, 5, '成员 id 全量保留，聚合不等于删除');
    assert.equal(group.sampleIds.length, 3, '默认携带 3 条样本引用');
    assert.equal(group.samples.length, 3);
    for (const sample of group.samples) assert.ok(ids.includes(sample.id), '样本必须是真实存在的候选');
    assert.ok(group.firstSeenAt <= group.lastSeenAt, '首末时间必须成序');
    assert.ok(group.lastSeenAt > group.firstSeenAt, '时间跨度要真实反映多次捕获');
    assert.equal(idOf(queue.items[0]), ids[4], '代表条目取最近一条，样本才代表现状');
    assert.equal(queue.totals.collapsed, 4, '5 条被折叠为 1 条，其余 4 条是重复');
    assert.equal(queue.totals.failureFacts, 5);
    assert.equal(group.priority.band, 'low');
    assert.ok(group.priority.reasons.some(reason => reason.includes('同一签名出现 5 次')), '折叠理由要说清，否则读的人不知道代表谁');
  } finally { s.close(); }
});

test('不同签名不聚合：工具的每类错误各成一条', () => {
  const s = open();
  try {
    capture(s, 'edit', 'replaceFileW EIO (win32 5): D:\\work\\src\\a.ts', 'sess-a');
    capture(s, 'edit', 'replaceFileW EIO (win32 5): D:\\work\\src\\b.ts', 'sess-b');
    capture(s, 'edit', 'old_string was not found in "D:\\work\\src\\a.ts"', 'sess-c');
    capture(s, 'pwsh', 'exit_code=1', 'sess-d');
    const queue = s.queueProposals('p', { include: 'failure-facts' });
    assert.equal(queue.items.length, 3, '三类错误三条，不能把不同根因并成一条');
    const counts = queue.items.map(item => asAggregate(item).occurrences).sort((a, b) => b - a);
    assert.deepEqual(counts, [2, 1, 1]);
    const tools = queue.items.map(item => asAggregate(item).tool).sort();
    assert.deepEqual(tools, ['edit', 'edit', 'pwsh']);
  } finally { s.close(); }
});

test('聚合视图是只读派生的：底层行数、状态与逐条可查性都不变', () => {
  const s = open();
  try {
    const observation = 'old_string was not found in "D:\\work\\src\\a.ts"';
    const ids = [
      capture(s, 'edit', observation, 'sess-a'),
      capture(s, 'edit', observation, 'sess-b'),
      capture(s, 'edit', observation, 'sess-c'),
    ];
    const before = storedRows(s);
    const queue = s.queueProposals('p', { include: 'failure-facts' });
    assert.equal(queue.items.length, 1);
    assert.equal(storedRows(s), before, '派生视图不得增删底层记录');
    assert.equal(s.listProposals('p', 'pending').length, 3, '扁平列表仍逐条返回');
    for (const id of asAggregate(queue.items[0]).memberIds) {
      assert.equal(s.listProposals('p', 'pending').some(row => row.id === id), true);
    }
    // Every member answers its own detail call, including the ones the aggregate did
    // not pick as its representative.
    const nonRepresentative = ids.filter(id => id !== idOf(queue.items[0]));
    assert.equal(nonRepresentative.length, 2);
    for (const id of nonRepresentative) {
      const detail = s.getProposal(id, 'p');
      assert.equal(detail.id, id);
      assert.match(String(detail.discovery), /自动捕获的失败事实/, '成员原文必须仍可读');
      assert.equal(detail.state, 'pending', '聚合不改成员状态');
    }
  } finally { s.close(); }
});

test('低价值分组默认折叠但被明确标注，且可以被单独取回', () => {
  const s = open();
  try {
    experience(s, '本轮定位到配置解析顺序导致的重复读取；修复后重跑 3 次通过。', '复现命令与三次运行的日志');
    capture(s, 'edit', 'old_string was not found in "D:\\work\\src\\a.ts"', 'sess-a');
    capture(s, 'edit', 'old_string was not found in "D:\\work\\src\\b.ts"', 'sess-b');
    capture(s, 'pwsh', 'exit_code=1', 'sess-c');

    const actionable = s.queueProposals('p');
    assert.equal(actionable.include, 'actionable');
    assert.equal(actionable.items.length, 1, '默认只给人写的经验');
    assert.equal(bandOf(actionable.items[0]), 'normal');
    const folded = actionable.groups['failure-facts'];
    assert.equal(folded.count, 2, '折叠组必须被报出，而不是消失');
    assert.equal(folded.occurrences, 3);
    assert.equal(folded.collapsedDuplicates, 1, '3 条自动捕获折叠掉 1 条重复');
    assert.equal(folded.preview.length, 2, '折叠组带预览，让人不必展开就能判断');
    assert.equal(actionable.totals.inState, 4);
    assert.equal(actionable.totals.returned, 1);

    const onlyFailures = s.queueProposals('p', { include: 'failure-facts' });
    assert.equal(onlyFailures.items.length, 2, '折叠组可以被单独取回');
    assert.deepEqual(onlyFailures.items.map(item => asAggregate(item).occurrences).sort((a, b) => b - a), [2, 1]);

    const all = s.queueProposals('p', { include: 'all' });
    assert.equal(all.items.length, 3, '合起来看时一条也不少');
    assert.equal(all.totals.actionable, 1);
    assert.equal(all.totals.failureFacts, 3);
  } finally { s.close(); }
});

test('排序让值得采纳的排在前面：人工裁决 > 人工经验 > 自动失败事实', () => {
  const s = open();
  try {
    capture(s, 'edit', 'old_string was not found in "D:\\work\\src\\a.ts"', 'sess-a');
    capture(s, 'pwsh', 'exit_code=1', 'sess-b');
    experience(s, '旧的做法会重复读取配置；改用单次解析后再分发。', '两次运行的日志对比');
    // Contains 冲突, so the submission path marks it important: a claim that waits for
    // a person and never lapses on the ordinary deadline.
    experience(s, '这个做法与库里既有流程冲突，需要裁决后再采纳。');

    const all = s.queueProposals('p', { include: 'all' });
    assert.deepEqual(all.items.map(bandOf), ['critical', 'normal', 'low', 'low'],
      '按分数降序：需裁决的人工冲突在前，自动失败事实垫底');
    assert.equal(all.items.length, 4, '检索面不因为排序而变化');
    const ordered = s.queueProposals('p', { include: 'all', limit: 2 });
    assert.equal(ordered.items.length, 2, 'limit 只截返回，不截统计');
    assert.equal(ordered.totals.inState, 4);
    assert.equal(ordered.totals.returned, 2);
    const reasons = (all.items[0] as { priority: { reasons: string[] } }).priority.reasons.join(' ');
    assert.match(reasons, /需人工裁决|冲突|裁决/);
  } finally { s.close(); }
});

test('签名只从自动捕获的文本导出，人工提交永不进入聚合', () => {
  const s = open();
  try {
    assert.equal(autoFailureSignature('人工写的一条经验：工具失败时先读文件。'), null);
    assert.equal(autoFailureSignature(capturedFailure('edit', 'exit_code=1', 'sess-a'))?.signature, 'edit::exit_code=1');
    const a = autoFailureSignature(capturedFailure('edit', 'old_string was not found in "D:\\a.ts"', 'sess-a'))!;
    const b = autoFailureSignature(capturedFailure('edit', 'old_string was not found in "E:\\other\\b.ts"', 'sess-z'))!;
    assert.equal(a.signature, b.signature, '路径与会话不是签名的一部分');
    const c = autoFailureSignature(capturedFailure('edit', 'old_string was not found in "D:\\a.ts" at offset 4096', 'sess-a'))!;
    assert.notEqual(c.signature, a.signature, '多出的定位信息不是同一句话，但仍是同一类错误');
    assert.equal(autoFailureSignature(capturedFailure('pwsh', 'exit_code=1', 'sess-a'))?.tool, 'pwsh');

    // A human submission that quotes the same words is still a human submission: the
    // marker, not the vocabulary, decides what gets folded.
    experience(s, '我把 edit 报的 old_string was not found 归因到没读文件，先 read 再 edit 就好了。');
    const queue = s.queueProposals('p');
    assert.equal(queue.items.length, 1);
    assert.equal(queue.totals.failureFacts, 0, '人工提交不计入失败事实分组');
    assert.equal(bandOf(queue.items[0]), 'normal');
  } finally { s.close(); }
});

test('端点：默认回复仍是扁平列表，view=queue 才返回聚合视图', async () => {
  const adminToken = 'c'.repeat(64);
  const store = new Store(':memory:', () => clock.now);
  const server = createCoreServer(store, {
    protocolVersion: 1, port: 47631, clients: [
      { id: 'dsh', token: 'a'.repeat(64), projectId: 'p', role: 'adapter' },
      { id: 'admin', token: adminToken, projectId: 'p', role: 'admin' },
    ],
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const adminPost = async (path: string, body: unknown) => {
    const res = await fetch(endpoint + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'x-amb-protocol': '1' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, data: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
  };
  try {
    capture(store, 'edit', 'old_string was not found in "D:\\w\\a.ts"', 'sess-a');
    capture(store, 'edit', 'old_string was not found in "D:\\w\\b.ts"', 'sess-b');
    experience(store, '旧做法会重复读取配置；改用单次解析后再分发。', '两次运行的日志对比');

    // The old reply, unchanged: consumers that never asked for review features must
    // not have to learn a new shape.
    const flat = await adminPost('/v1/proposals/list', { projectId: 'p' });
    assert.equal(flat.status, 200);
    assert.equal((flat.data.proposals as unknown[]).length, 3, '默认仍是逐条的扁平列表');

    const queue = await adminPost('/v1/proposals/list', { projectId: 'p', view: 'queue' });
    assert.equal(queue.status, 200);
    assert.equal((queue.data.items as unknown[]).length, 1, '默认只回值得审的');
    assert.equal((queue.data.totals as { inState: number }).inState, 3);
    assert.equal((queue.data.groups as Record<string, { count: number }>)['failure-facts']!.count, 1);

    const folded = await adminPost('/v1/proposals/list', { projectId: 'p', view: 'queue', include: 'failure-facts' });
    assert.equal(folded.status, 200);
    assert.equal(asAggregate((folded.data.items as unknown[])[0]).occurrences, 2);
    assert.equal(store.listProposals('p', 'pending').length, 3, '端点取聚合视图不改动任何记录');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }
});
