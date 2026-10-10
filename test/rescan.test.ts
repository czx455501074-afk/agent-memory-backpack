import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { Store } from '../src/store.js';
import { discover, rescanDiff, summarizeRescan } from '../src/discovery.js';
import { applyRescan } from '../src/rescan.js';
import type { Knowledge } from '../src/schema.js';

const norm = (id: string, body: string, baseRevision = 0): Knowledge => ({
  id, kind: 'norm', title: `规范 ${id}`, scope: { kind: 'global' },
  baseRevision, body, deniedTools: [], hostProvided: false,
});

async function scratch(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}
async function cleanup(dir: string): Promise<void> {
  const rel = relative(resolve(tmpdir()), resolve(dir));
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Supersession ledger: "latest wins" must never mean "older is destroyed"
// ---------------------------------------------------------------------------

test('推翻旧经验：新版生效、旧版退场，但历史与链路完整保留', async () => {
  const dataDir = await scratch('amb-sup-');
  try {
    const s = new Store(join(dataDir, 'k.sqlite'));
    try {
      s.import([norm('old-rule', '旧做法：先执行 A 再执行 B。')]);
      s.import([norm('new-rule', '经验证：应先执行 B 再执行 A，旧顺序会失败。')]);
      const before = s.revision;

      const result = s.supersede({
        oldId: 'old-rule', newId: 'new-rule', action: 'supersede',
        reason: '实践中验证旧顺序会失败', evidence: '任务 T-42 复现失败，改序后通过', origin: 'agent',
      });

      assert.equal(result.historyPreserved, true);
      assert.equal(result.oldRevision, 1);
      assert.equal(result.newRevision, 1);
      assert.ok(s.revision > before, '推翻必须推进知识版本');

      // The new record is current; the old one left default retrieval.
      const active = s.allEntries().map(entry => entry.id);
      assert.deepEqual(active, ['new-rule'], '被推翻的条目不得继续出现在默认检索中');
      assert.equal(s.norms('').some(n => n.id === 'old-rule'), false);

      // The retired revision is still readable: an overturn is auditable, not a wipe.
      const stored = s.db.prepare('SELECT content FROM revisions WHERE id=? AND revision=1').get('old-rule') as { content: string };
      assert.match(stored.content, /先执行 A 再执行 B/, '被推翻的正文必须永久保留');
    } finally { s.close(); }
  } finally { await cleanup(dataDir); }
});

test('补充旧经验：两条都保持生效，因为补充不是矛盾', async () => {
  const dataDir = await scratch('amb-sup-');
  try {
    const s = new Store(join(dataDir, 'k.sqlite'));
    try {
      s.import([norm('base-rule', '基础做法：检查配置。')]);
      s.import([norm('extra-rule', '补充：还要检查 Node 版本。')]);

      s.supersede({
        oldId: 'base-rule', newId: 'extra-rule', action: 'supplement',
        reason: '实践中发现还需检查运行时版本', evidence: '两次任务因版本不符失败', origin: 'agent',
      });

      const active = s.allEntries().map(entry => entry.id);
      assert.equal(active.includes('base-rule'), true, '补充不得让原条目退场');
      assert.equal(active.includes('extra-rule'), true);
    } finally { s.close(); }
  } finally { await cleanup(dataDir); }
});

test('推翻必须有理由与证据，且不能自推翻或跨类型', async () => {
  const dataDir = await scratch('amb-sup-');
  try {
    const s = new Store(join(dataDir, 'k.sqlite'));
    try {
      s.import([norm('a', '第一条。')]);
      s.import([norm('b', '第二条。')]);
      s.import([norm('c', '第三条。')]);

      assert.throws(() => s.supersede({ oldId: 'a', newId: 'b', action: 'supersede', reason: '', evidence: 'x', origin: 'agent' }), /must state why/);
      assert.throws(() => s.supersede({ oldId: 'a', newId: 'b', action: 'supersede', reason: 'r', evidence: '', origin: 'agent' }), /must cite evidence/);
      assert.throws(() => s.supersede({ oldId: 'a', newId: 'a', action: 'supersede', reason: 'r', evidence: 'e', origin: 'agent' }), /cannot supersede itself/);
      assert.throws(() => s.supersede({ oldId: 'missing', newId: 'b', action: 'supersede', reason: 'r', evidence: 'e', origin: 'agent' }), /unavailable/);

      // A memory cannot replace a norm: kinds carry different obligations.
      s.import([{ id: 'mem', kind: 'memory', title: '记忆', scope: { kind: 'global' }, baseRevision: 0, body: '事实。' }]);
      assert.throws(() => s.supersede({ oldId: 'a', newId: 'mem', action: 'supersede', reason: 'r', evidence: 'e', origin: 'agent' }), /same knowledge kind/);

      assert.equal(s.supersessions().length, 0, '失败的推翻不得留下记录');
      assert.equal(s.allEntries().length, 4, '失败的推翻不得改变生效集合');
    } finally { s.close(); }
  } finally { await cleanup(dataDir); }
});

test('history 同时给出当前状态、全部版本与取代链路', async () => {
  const dataDir = await scratch('amb-sup-');
  try {
    const s = new Store(join(dataDir, 'k.sqlite'));
    try {
      s.import([norm('v1', '初版做法。')]);
      s.import([norm('v2', '改进做法。')]);
      s.supersede({ oldId: 'v1', newId: 'v2', action: 'supersede', reason: '初版在实践中不足', evidence: '任务 T-1 记录', origin: 'agent' });

      const old = s.history('v1');
      assert.equal(old.current?.status, 'retired', '被推翻条目应显示为已退场');
      assert.equal(old.revisions.length, 1, '历史版本必须可枚举');
      assert.equal(old.chain.length, 1);
      assert.equal(old.chain[0]!.action, 'supersede');
      assert.equal(old.chain[0]!.reason, '初版在实践中不足');
      assert.equal(old.chain[0]!.evidence, '任务 T-1 记录');
      assert.equal(old.chain[0]!.origin, 'agent');

      const fresh = s.history('v2');
      assert.equal(fresh.current?.status, 'active');
      assert.equal(fresh.chain.length, 1, '替代者也能查到它取代了谁');
      assert.equal(fresh.chain[0]!.oldKnowledgeId, 'v1');
    } finally { s.close(); }
  } finally { await cleanup(dataDir); }
});

// ---------------------------------------------------------------------------
// Periodic rescan: newest record wins, vanished sources are not destroyed
// ---------------------------------------------------------------------------

async function adoptAll(s: Store, root: string) {
  const report = discover([root]);
  return s.adopt(report.candidates.map(candidate => ({
    source: { path: candidate.source.path, hash: candidate.source.hash },
    kind: candidate.kind, title: candidate.title,
    knowledge: candidate.kind === 'memory'
      ? { id: candidate.id, kind: 'memory' as const, title: candidate.title, scope: { kind: 'global' as const }, baseRevision: 0, body: candidate.body }
      : candidate.kind === 'skill'
        ? { id: candidate.id, kind: 'skill' as const, title: candidate.title, scope: { kind: 'global' as const }, baseRevision: 0, body: candidate.body, leaves: (candidate.leaves ?? []).map(l => ({ path: l.path, hash: l.hash, body: l.body })), needsStructure: true }
        : { id: candidate.id, kind: 'norm' as const, title: candidate.title, scope: { kind: 'global' as const }, baseRevision: 0, body: candidate.body, deniedTools: [], hostProvided: candidate.hostProvided },
  })));
}

test('重扫描识别新增、未变、变更与消失四类来源', async () => {
  const root = await scratch('amb-rescan-');
  const dataDir = await scratch('amb-rescan-db-');
  try {
    await writeFile(join(root, 'memory.md'), '# 记忆\n\n甲：初始内容。\n');
    await writeFile(join(root, 'AGENTS.md'), '# 契约\n\n乙：不会变化。\n');
    const s = new Store(join(dataDir, 'k.sqlite'));
    try {
      await adoptAll(s, root);

      // Change one source, leave another, add a third in a new subdirectory.
      await writeFile(join(root, 'memory.md'), '# 记忆\n\n甲：已经更新的内容。\n');
      await mkdir(join(root, 'added'), { recursive: true });
      await writeFile(join(root, 'added', 'AGENTS.md'), '# 新增契约\n\n丙：新增内容。\n');
      const report = rescanDiff(discover([root]), s.adoptions());

      assert.equal(report.counts.changed, 1, '内容变化的来源必须识别为 changed');
      assert.equal(report.counts.unchanged, 1, '未变来源必须识别为 unchanged');
      assert.equal(report.counts.new, 1, '新增来源必须识别为 new');
      assert.equal(report.counts.vanished, 0);
      assert.match(summarizeRescan(report), /changed=1/);

      const changed = report.entries.find(e => e.status === 'changed')!;
      assert.ok(changed.knowledgeId, '变更项必须关联到已采纳的条目');
    } finally { s.close(); }
  } finally { await cleanup(root); await cleanup(dataDir); }
});

test('重扫描以最新记录为准：自动刷新变更来源并保留旧版', async () => {
  const root = await scratch('amb-rescan-');
  const dataDir = await scratch('amb-rescan-db-');
  try {
    await writeFile(join(root, 'memory.md'), '# 记忆\n\n甲：初始内容。\n');
    const s = new Store(join(dataDir, 'k.sqlite'));
    try {
      await adoptAll(s, root);
      const before = s.allEntries();
      assert.equal(before.length, 1);
      const knowledgeId = before[0]!.id;

      await writeFile(join(root, 'memory.md'), '# 记忆\n\n甲：已更新的内容，这是最新记录。\n');
      const outcome = applyRescan(s, [root]);

      assert.equal(outcome.refreshed.length, 1, '变更来源必须被刷新');
      assert.equal(outcome.adopted, 0, '没有新增来源时不应重复采纳');
      assert.equal(outcome.errors.length, 0);

      const after = s.allEntries();
      assert.equal(after.length, 1, '刷新是就地更新，不是新增条目');
      assert.equal(after[0]!.id, knowledgeId, '来源相同则身份保持稳定');
      const content = after[0]!.content;
      assert.ok(content.kind === 'norm' || content.kind === 'memory');
      assert.match(content.body, /最新记录/, '新内容必须成为当前生效版本');

      // The earlier revision is retained and the chain explains the change.
      const history = s.history(knowledgeId);
      assert.equal(history.revisions.length, 2, '旧版必须保留在历史中');
      assert.equal(history.chain.length, 1);
      assert.equal(history.chain[0]!.origin, 'rescan');
      assert.equal(history.chain[0]!.action, 'supersede');
    } finally { s.close(); }
  } finally { await cleanup(root); await cleanup(dataDir); }
});

test('重扫描在本地编辑被覆盖时明确告警，且两版都留在历史', async () => {
  const root = await scratch('amb-rescan-');
  const dataDir = await scratch('amb-rescan-db-');
  try {
    await writeFile(join(root, 'AGENTS.md'), '# 契约\n\n来源初版。\n');
    const s = new Store(join(dataDir, 'k.sqlite'));
    try {
      await adoptAll(s, root);
      const entry = s.allEntries()[0]!;
      // The user edits the adopted copy inside the plugin.
      s.import([{ ...entry.content, baseRevision: entry.revision, body: '用户在插件内修改过的版本。' } as Knowledge]);

      await writeFile(join(root, 'AGENTS.md'), '# 契约\n\n来源更新版。\n');
      const outcome = applyRescan(s, [root]);

      assert.equal(outcome.refreshed.length, 1);
      assert.equal(outcome.refreshed[0]!.replacedLocalEdit, true, '必须报告本地编辑被覆盖');

      const history = s.history(entry.id);
      assert.equal(history.revisions.length, 3, '来源初版、本地编辑、来源新版都必须保留');
      assert.equal(history.chain[0]!.replacedLocalEdit, true, '链路必须记录该事实');
    } finally { s.close(); }
  } finally { await cleanup(root); await cleanup(dataDir); }
});

test('消失的来源只报告不自动退场，避免误删用户知识', async () => {
  const root = await scratch('amb-rescan-');
  const dataDir = await scratch('amb-rescan-db-');
  try {
    await writeFile(join(root, 'memory.md'), '# 记忆\n\n会被删除的内容。\n');
    await writeFile(join(root, 'AGENTS.md'), '# 契约\n\n保留的内容。\n');
    const s = new Store(join(dataDir, 'k.sqlite'));
    try {
      await adoptAll(s, root);
      assert.equal(s.allEntries().length, 2);

      await rm(join(root, 'memory.md'));
      const outcome = applyRescan(s, [root]);

      assert.equal(outcome.report.counts.vanished, 1, '消失来源必须被报告');
      assert.equal(outcome.report.vanished[0]!.sourcePath.endsWith('memory.md'), true);
      assert.equal(s.allEntries().length, 2, '消失来源对应的知识不得被自动退场');
    } finally { s.close(); }
  } finally { await cleanup(root); await cleanup(dataDir); }
});

test('单个来源刷新失败不中断其余来源', async () => {
  const root = await scratch('amb-rescan-');
  const dataDir = await scratch('amb-rescan-db-');
  try {
    await writeFile(join(root, 'memory.md'), '# 记忆\n\n甲。\n');
    const s = new Store(join(dataDir, 'k.sqlite'));
    try {
      await adoptAll(s, root);
      // Retirement makes the adopted entry unavailable, so refreshing it must fail.
      const knowledgeId = s.allEntries()[0]!.id;
      s.retire(knowledgeId, 1);

      await writeFile(join(root, 'memory.md'), '# 记忆\n\n甲的新内容。\n');
      await mkdir(join(root, 'extra'), { recursive: true });
      await writeFile(join(root, 'extra', 'AGENTS.md'), '# 附加契约\n\n新来源。\n');
      const outcome = applyRescan(s, [root]);

      assert.equal(outcome.errors.length, 1, '失败必须被记录而不是抛出');
      assert.match(outcome.errors[0]!.source, /memory\.md/);
      // The unrelated new source was still adopted.
      assert.equal(outcome.adopted, 1, '一个来源失败不得阻断其他来源');
    } finally { s.close(); }
  } finally { await cleanup(root); await cleanup(dataDir); }
});

// ---------------------------------------------------------------------------
// Cadence bookkeeping
// ---------------------------------------------------------------------------

test('重扫描周期可配置，未到期时不重复扫描', async () => {
  let now = Date.UTC(2026, 0, 1);
  const dataDir = await scratch('amb-cadence-');
  try {
    const s = new Store(join(dataDir, 'k.sqlite'), () => now);
    try {
      const initial = s.rescanState();
      assert.equal(initial.lastRescanAt, 0, '初始状态表示从未扫描');
      assert.equal(initial.intervalMs, 86400000, '默认周期为一天');
      assert.equal(s.rescanDue(), true, '从未扫描时必须认为到期');

      s.markRescanned();
      assert.equal(s.rescanDue(), false, '刚扫描过不应立即再次扫描');

      now += 86400000 + 1;
      assert.equal(s.rescanDue(), true, '周期届满后应到期');

      assert.throws(() => s.setRescanInterval(1000), /at least one minute/);
      s.setRescanInterval(3600000);
      now += 3600000 + 1;
      assert.equal(s.rescanDue(), true);
    } finally { s.close(); }
  } finally { await cleanup(dataDir); }
});

test('扫描根持久化，供核心定时任务使用', async () => {
  const dataDir = await scratch('amb-roots-');
  try {
    const s = new Store(join(dataDir, 'k.sqlite'));
    try {
      assert.deepEqual(s.scanRoots(), [], '默认无扫描根，定时任务应保持空转');
      const saved = s.setScanRoots(['  /a/b  ', '/c/d', '']);
      assert.deepEqual(saved, ['/a/b', '/c/d'], '扫描根必须去空白与空项');
      assert.deepEqual(s.scanRoots(), ['/a/b', '/c/d'], '扫描根必须跨连接持久化');
    } finally { s.close(); }
  } finally { await cleanup(dataDir); }
});
