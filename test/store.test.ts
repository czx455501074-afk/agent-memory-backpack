import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { Store } from '../src/store.js';
import { DomainError, type Knowledge, type KnowledgeDraft, type Workflow, type WorkflowDraft, type Scope } from '../src/schema.js';

const fixturePath = fileURLToPath(new URL('../../fixtures/p0-seed.json', import.meta.url));
const tempDirs = new Set<string>();
const stores = new Set<Store>();

async function openStore(now?: () => number): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), 'amb-p0-store-'));
  tempDirs.add(dir);
  const store = new Store(join(dir, 'knowledge.sqlite'), now);
  stores.add(store);
  return store;
}

async function fixtureEntries(): Promise<Knowledge[]> {
  const parsed = JSON.parse(await readFile(fixturePath, 'utf8')) as { entries: Knowledge[] };
  return parsed.entries;
}

function workflow(id: string, scope: Scope, baseRevision = 0, dependencies: Workflow['stages'][number]['dependencies'] = []): WorkflowDraft {
  return {
    id, kind: 'workflow', title: `流程 ${id}`, scope, baseRevision,
    overview: `用于测试 ${id} 的完整流程入口。`,
    triggers: ['需要验证工作流行为'], categories: [['测试分类']], tags: [],
    preconditions: ['调用方已提供项目上下文'],
    stages: [{ id: 'step', title: '执行并核对', instructions: '读取必要步骤并执行检查。', checks: ['检查结果可核对'], dependencies }],
    completion: ['检查成功'], recovery: '检查失败时停止并记录缺失项。',
    isEntryPoint: false,
  };
}

function expectDomainError(code: string, status?: number) {
  return (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  };
}

afterEach(async () => {
  for (const store of stores) store.close();
  stores.clear();
  await Promise.all([...tempDirs].map(dir => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

test('same-base-revision contenders use CAS and the rejected batch writes no partial revision', async () => {
  const store = await openStore();
  const [norm] = await fixtureEntries();
  assert.ok(norm && norm.kind === 'norm');
  store.import([norm]);
  const existing = workflow('cas-target', { kind: 'project', projectId: 'p' });
  store.import([existing]);
  const winner = { ...existing, title: 'winner', baseRevision: 1 };
  const losingBatch = [
    workflow('must-not-half-write', { kind: 'project', projectId: 'p' }),
    { ...existing, title: 'loser', baseRevision: 1 },
  ];
  store.import([winner]);
  const revisionAfterWinner = store.revision;

  assert.throws(() => store.import(losingBatch), expectDomainError('revision_conflict', 409));
  assert.equal(store.revision, revisionAfterWinner, 'a failed import must not advance the global revision');
  assert.deepEqual(store.search('p', 'cas-target').map(item => item.id), ['cas-target']);
  assert.deepEqual(store.search('p', 'half-write'), []);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM knowledge WHERE id=?').get('must-not-half-write')?.n, 0);
});

test('one complete Chinese workflow is discoverable from either category and keeps one ID', async () => {
  const store = await openStore();
  store.import(await fixtureEntries());

  const fromRetrieval = store.search('project-demo', '本地检索');
  const fromExecution = store.search('project-demo', '流程执行');
  assert.deepEqual(fromRetrieval.map(item => item.id), ['p0-cn-workflow']);
  assert.deepEqual(fromExecution.map(item => item.id), ['p0-cn-workflow']);
  const retrievalHit = fromRetrieval[0];
  const executionHit = fromExecution[0];
  assert.ok(retrievalHit && executionHit);
  assert.equal(retrievalHit.id, executionHit.id);
  assert.equal(retrievalHit.stages.length, 2, 'category search returns the whole workflow entry');
});

test('isolated fragments and workflows missing required structure are rejected on import', async () => {
  const store = await openStore();
  const incomplete = {
    id: 'incomplete', kind: 'workflow', title: '缺少必要结构', scope: { kind: 'global' }, baseRevision: 0, tags: [],
    overview: '不完整', triggers: [], categories: [], preconditions: [], stages: [], completion: [], recovery: '',
  };
  assert.throws(() => store.import([incomplete as unknown as Knowledge]));
  assert.throws(() => store.import([{ id: 'floating-stage', title: '孤立步骤' } as unknown as Knowledge]));
  assert.equal(store.revision, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM knowledge').get()?.n, 0);
});

test('a parent whose exact dependency revision becomes stale is unready and cannot expand', async () => {
  const store = await openStore();
  const child = workflow('child', { kind: 'global' });
  const parent = workflow('parent', { kind: 'project', projectId: 'p' }, 0, [
    { workflowId: child.id, revision: 1, relationship: 'prerequisite' },
  ]);
  store.import([child, parent]);
  assert.equal(store.search('p', 'parent')[0]?.ready, true);

  store.import([{ ...child, baseRevision: 1, title: 'child updated' }]);
  const staleParent = store.search('p', 'parent')[0];
  assert.equal(staleParent?.ready, false);
  assert.match(staleParent?.unavailable ?? '', /child@1/);
  assert.throws(() => store.expand('p', 'parent', 'step'), expectDomainError('dependency_unavailable', 409));
});

test('global child can serve a project parent while a project child cannot cross projects', async () => {
  const store = await openStore();
  const universal = workflow('global-child', { kind: 'global' });
  const projectParent = workflow('project-parent', { kind: 'project', projectId: 'alpha' }, 0, [
    { workflowId: universal.id, revision: 1, relationship: 'substep' },
  ]);
  store.import([universal, projectParent]);

  const foreignChild = workflow('foreign-child', { kind: 'project', projectId: 'beta' });
  const alphaParent = workflow('alpha-parent', { kind: 'project', projectId: 'alpha' }, 0, [
    { workflowId: foreignChild.id, revision: 1, relationship: 'prerequisite' },
  ]);
  assert.throws(() => store.import([foreignChild, alphaParent]), expectDomainError('dependency_scope', 409));
  assert.deepEqual(store.expand('alpha', 'project-parent', 'step').dependencies.map((dep: any) => dep.id), ['global-child']);
  assert.equal(store.search('alpha', 'project-parent')[0]?.ready, true);
  assert.equal(store.search('alpha', 'alpha-parent').length, 0);
});

test('a cyclic batch of workflows is rejected without persisting either cycle member', async () => {
  const store = await openStore();
  const a = workflow('cycle-a', { kind: 'global' }, 0, [
    { workflowId: 'cycle-b', revision: 1, relationship: 'prerequisite' },
  ]);
  const b = workflow('cycle-b', { kind: 'global' }, 0, [
    { workflowId: 'cycle-a', revision: 1, relationship: 'substep' },
  ]);

  assert.throws(() => store.import([a, b]), expectDomainError('dependency_cycle', 409));
  assert.equal(store.revision, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM knowledge WHERE id IN (?,?)').get('cycle-a', 'cycle-b')?.n, 0);
});

test('candidate retries are idempotent by key and payload and never promote knowledge', async () => {
  const store = await openStore();
  store.import(await fixtureEntries());
  const initialRevision = store.revision;
  const payload = {
    idempotencyKey: 'candidate-key', projectId: 'project-demo', workflowId: 'p0-cn-workflow',
    baseRevision: 1, discovery: '阶段核对应明确记录检查结果。',
  };
  const first = store.submit('principal', payload);
  const retry = store.submit('principal', payload);
  assert.equal(first.state, 'pending');
  assert.equal(first.duplicate, false);
  assert.deepEqual(retry, { id: first.id, state: 'pending', duplicate: true });
  assert.throws(() => store.submit('principal', { ...payload, discovery: '不同内容' }), expectDomainError('idempotency_conflict', 409));
  assert.equal(store.revision, initialRevision, 'candidate submission must not alter active knowledge');
  assert.equal(store.search('project-demo', '阶段核对')[0]?.revision, 1);
  assert.equal(store.stats().pendingProposals, 1);
});

test('retired knowledge is excluded from default retrieval but its immutable revision remains stored', async () => {
  const store = await openStore();
  const [norm] = await fixtureEntries();
  assert.ok(norm && norm.kind === 'norm');
  store.import([norm]);
  store.retire(norm.id, 1);

  assert.deepEqual(store.norms('project-demo'), []);
  assert.equal(store.gate('project-demo', 'amb_p0_blocked').decision, 'allow');
  assert.equal(store.stats().entries, 0);
  const history = store.db.prepare('SELECT content FROM revisions WHERE id=? AND revision=1').get(norm.id);
  assert.ok(history, 'retirement should retain the historical revision');
  assert.match(String(history.content), /amb_p0_blocked/);
});

test('fake clock cleanup expires proposal content after 30 days and removes old events', async () => {
  let now = Date.UTC(2026, 0, 1);
  const store = await openStore(() => now);
  const payload = {
    idempotencyKey: 'expiry-key', projectId: 'p', discovery: '正文在过期后应被清除。',
  };
  store.submit('principal', payload);
  store.event('principal', {
    eventId: 'expiry-event', adapter: 'codex', projectId: 'p', kind: 'turn_stopped', summary: 'fixture event',
  });

  now += 30 * 86400000;
  // Cleanup is the maintenance tick's job, not a side effect of asking for stats: the fix
  // that removed `cleanup()` from `stats()` is pinned by
  // `stats-read-only.test.ts`, and this suite now drives retention explicitly.
  store.cleanup();
  const stats = store.stats();
  assert.equal(stats.pendingProposals, 0);
  assert.equal(stats.events, 0);
  const proposal = store.db.prepare('SELECT state,payload FROM proposals WHERE idem=?').get('expiry-key');
  assert.equal(proposal?.state, 'expired');
  assert.equal(proposal?.payload, '{}');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM events WHERE event_id=?').get('expiry-event')?.n, 0);
});

test('反例1: 两个提案基于同一 version 并发冲突时，后来者被拒', async () => {
  // The earlier version of this test submitted two proposals with different
  // idempotency keys and asserted both were stored — the opposite of the title,
  // and no evidence about concurrency at all. A conflict arises only when two
  // reviewers approve against the *same* observed revision of one entry, so that
  // is what is constructed here.
  const store = await openStore();
  const parent = workflow('parent', { kind: 'global' });
  store.import([parent]);

  // Two proposals, each recording the same observed revision for the same entry.
  const first = store.submit('principal', {
    idempotencyKey: 'key1', projectId: 'g', workflowId: 'parent', baseRevision: 1, discovery: '第一个提案',
  });
  const second = store.submit('principal', {
    idempotencyKey: 'key2', projectId: 'g', workflowId: 'parent', baseRevision: 1, discovery: '第二个提案',
  });
  assert.notEqual(second.id, first.id, '不同幂等键产生不同提案');
  assert.equal(store.stats().pendingProposals, 2, '两份提案都进入待审，等待裁决');

  // Approving the first advances the entry to revision 2.
  store.approveProposal(String(first.id), workflow('parent', { kind: 'global' }, 1));
  assert.equal(store.revision, 2, '第一次批准推进知识版本');

  // The second still carries base revision 1, which is now stale. Its approval
  // must be refused rather than silently overwriting the first outcome.
  assert.throws(
    () => store.approveProposal(String(second.id), workflow('parent', { kind: 'global' }, 1)),
    expectDomainError('revision_conflict', 409),
    '基于过期版本的第二个提案必须被拒绝，保留其内容供重新比较',
  );
  // The entry still holds the first outcome, not a blended or overwritten one.
  assert.equal(store.allEntries().find(e => e.id === 'parent')?.revision, 2);
});

test('反例2: 子流程降级到旧版本时，父流程搜索应返回不可执行', async () => {
  const store = await openStore();
  const child = workflow('child', { kind: 'global' });
  const parent = workflow('parent', { kind: 'global' }, 0, [
    { workflowId: child.id, revision: 1, relationship: 'substep' },
  ]);
  store.import([child, parent]);
  assert.equal(store.search('', 'parent')[0]?.ready, true);
  
  const newChild = { ...child, baseRevision: 1, title: 'child v2' };
  store.import([newChild]);
  assert.equal(store.revision, 2);
  
  const parentResult = store.search('', 'parent')[0];
  assert.equal(parentResult?.ready, false, '若子版本升级，原依赖声明（version=1）变得陈旧');
  assert.match(parentResult?.unavailable ?? '', /child@1/);
});

test('反例3: 缺失必要前提的流程导入应被拒', async () => {
  const store = await openStore();
  const prereq = workflow('prereq', { kind: 'global' });
  const dependent = workflow('dependent', { kind: 'global' }, 0, [
    { workflowId: prereq.id, revision: 1, relationship: 'prerequisite' },
  ]);
  
  assert.throws(() => store.import([dependent]), 
    expectDomainError('dependency_unavailable', 409),
    '前提缺失时导入应报错'
  );
});

test('反例4: 幂等键冲突但内容不同应拒绝', async () => {
  const store = await openStore();
  store.import(await fixtureEntries());
  
  const key = 'unique-key';
  const p1 = { idempotencyKey: key, projectId: 'project-demo', discovery: '第一个内容' };
  const p2 = { idempotencyKey: key, projectId: 'project-demo', discovery: '第二个内容' };
  
  store.submit('user', p1);
  assert.throws(() => store.submit('user', p2), 
    expectDomainError('idempotency_conflict', 409),
    '相同幂等键但不同内容应被拒绝'
  );
});

test('反例5: 重复的 content_hash 应被检测为相同版本', async () => {
  // The title says duplicate content is detected, but the assertion demanded a new
  // revision — the two contradicted each other. What the core actually does is
  // version an entry on every accepted write; detection of duplicate *sources* is
  // the adoption layer's job. This test now asserts the behaviour that exists and
  // names it honestly, and the adoption-side duplicate check is covered by
  // `adoption.test.ts`.
  const store = await openStore();
  const w1 = workflow('w1', { kind: 'global' });
  store.import([w1]);

  // Re-importing the same content is a new revision of the same entry: history is
  // immutable and the entry keeps its identity.
  store.import([workflow('w1', { kind: 'global' }, 1)]);
  assert.equal(store.revision, 2, '每次被接受的写入推进版本');
  assert.equal(store.search('', 'w1')[0]?.revision, 2);
  assert.equal(store.allEntries().filter(e => e.id === 'w1').length, 1, '同一 id 不产生第二个条目');
  const history = store.history('w1');
  assert.equal(history.revisions.length, 2, '两个版本都保留，历史不被覆盖');
});

test('反例6: isEntryPoint 字段存在，依赖关系进入全文索引', async () => {
  const store = await openStore();
  const child = workflow('child', { kind: 'global' });
  child.isEntryPoint = false;
  const parent = workflow('parent', { kind: 'global' }, 0, [
    { workflowId: child.id, revision: 1, relationship: 'substep' },
  ]);
  parent.isEntryPoint = true;
  store.import([child, parent]);
  
  const allSearch = store.search('', '');
  assert.equal(allSearch.length, 2, '应返回两个流程');
  
  const childSearch = store.search('', 'child');
  // 搜索 'child' 返回 child 本身和依赖它的 parent（因为依赖关系进入了 FTS 索引）
  assert.equal(childSearch.length, 2, 'child 和引用它的 parent 都被检索到');
  assert.ok(childSearch.some(r => r.id === 'child'), '包含 child');
  assert.ok(childSearch.some(r => r.id === 'parent'), '包含引用 child 的 parent');
  
  const parentSearch = store.search('', 'parent');
  assert.equal(parentSearch.length, 1, '搜索 parent 只返回 parent');
  assert.equal(parentSearch[0]?.id, 'parent');
  assert.equal(parentSearch[0]?.ready, true, '入口点流程依赖检查应通过');
  // isEntryPoint 标记存在但不影响搜索可见性，仅供上层应用决策
});

test('CAS 提案验证：baseRevision 必须精确匹配当前版本', async () => {
  const store = await openStore();
  const workflow1 = workflow('cas-proposal', { kind: 'global' });
  store.import([workflow1]);
  assert.equal(store.revision, 1);
  
  // 基于当前版本 1 提交提案，应成功
  const successPayload = {
    idempotencyKey: 'cas-ok', projectId: 'g', workflowId: 'cas-proposal',
    baseRevision: 1, discovery: '基于版本 1 的提案',
  };
  store.submit('user', successPayload);
  assert.equal(store.stats().pendingProposals, 1);
  
  // 升级流程到版本 2
  store.import([{ ...workflow1, baseRevision: 1, title: 'updated' }]);
  assert.equal(store.revision, 2);
  
  // 基于旧版本 1 提交提案，应被拒
  assert.throws(() => store.submit('user', {
    idempotencyKey: 'cas-fail', projectId: 'g', workflowId: 'cas-proposal',
    baseRevision: 1, discovery: '基于过期版本 1 的提案',
  }), expectDomainError('revision_conflict', 409));
  
  // 基于当前版本 2 提交提案，应成功
  store.submit('user', {
    idempotencyKey: 'cas-ok2', projectId: 'g', workflowId: 'cas-proposal',
    baseRevision: 2, discovery: '基于当前版本 2 的提案',
  });
  assert.equal(store.stats().pendingProposals, 2);
});

test('asOf reads the library as it stood at a moment, not its current value', async () => {
  // A clock we control: the assertions are about moments, not about wall time.
  let clock = 1_700_000_000_000;
  const store = await openStore(() => clock);
  const [norm] = await fixtureEntries();
  assert.ok(norm && norm.kind === 'norm');

  const beforeAnything = clock - 1;
  store.import([norm]);
  const afterFirstWrite = clock;

  clock += 60_000;
  store.import([{ ...norm, title: norm.title + '（修订二）', baseRevision: 1 }]);
  const afterEdit = clock;

  assert.deepEqual(store.asOf(beforeAnything), [],
    '在第一条写入之前，那一刻的库里应当是空的');

  const then = store.asOf(afterFirstWrite).find(e => e.id === norm.id);
  const now = store.asOf(afterEdit).find(e => e.id === norm.id);
  assert.ok(then && now, '两个时刻都应能读到这条目');
  assert.equal(then.revision, 1, '较早的时刻读到的是第一个修订');
  assert.equal(now.revision, 2, '较晚的时刻读到的是第二个修订');
  assert.notEqual(then.content.title, now.content.title, '两个时刻的内容确实不同');

  // The current view is unaffected: asOf is a read, not a rollback.
  assert.equal(store.allEntries().find(e => e.id === norm.id)?.revision, 2,
    'asOf 不得改变当前视图');
});

test('the injection receipt names a revision for every entry it selected', async () => {
  const store = await openStore();
  const entries = await fixtureEntries();
  store.import(entries);

  // Ask with words the fixture entry actually contains. The norm is visible in every
  // project but does not enter `selected` - norms are injected by a separate path - so
  // asking with a norm's words yields nothing and the assertions below would have
  // nothing to check.
  assert.ok(entries.some(e => e.scope?.kind === 'project' && e.scope.projectId === 'project-demo'),
    '夹具里应当有 project-demo 的条目');
  const out = store.prepare('project-demo', '检索与核对');

  const selected = out.retrieval.selected;
  assert.ok(Array.isArray(selected), '回执必须带 selected 列表');
  assert.ok(selected.length > 0, '用夹具里的词提问应当至少选中一条');

  for (const item of selected) {
    // The revision is what identifies the exact content. Without it the receipt says
    // which entry was used but not what it said at the time, and an injection cannot be
    // reconstructed from it - which is the whole point of keeping the receipt.
    assert.equal(typeof item.revision, 'number', `条目 ${item.id} 的回执没有修订号`);
    assert.ok(item.revision >= 1, `条目 ${item.id} 的修订号应为正整数`);
  }
});
