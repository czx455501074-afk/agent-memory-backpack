import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { createCoreServer } from '../src/server.js';
import { createRetrievalService } from '../src/retrieval-service.js';
import { buildRetrievalIndex } from '../src/retrieval-index.js';
import { initializeWorkflowDrafts } from '../src/workflow-organization.js';
import type { RetrievalCandidate } from '../src/semantic-retrieval.js';
import type { KnowledgeDraft } from '../src/schema.js';

/**
 * A rule that exists in the library but cannot be found is a rule the agent breaks
 * silently, and the two retrieval paths must not disagree about whether it exists.
 *
 * Measured before this file was written, on the live library: a query almost
 * verbatim from a stored rule returned nothing from the in-process index while the
 * full-text path could find it. Two causes were confirmed in code:
 *
 *  1. `retrieval-service.ts` dropped `norm` from the candidate set it searched, so
 *     the automatic and model paths were structurally blind to rules. The reason
 *     recorded for that filter was duplicate context - which is real, but belongs on
 *     the injection side, where `prepare()` already reads rules through `norms()`
 *     and `knowledge()` refuses every kind but skill/memory/preference/journal.
 *  2. Ranking scored `idfSum(hits) / presentIdf` with no length term, so a 20KB
 *     diary that contains the rule's own wording outranked the 69-character rule
 *     itself.
 *
 * The cases below pin both, plus the receipt: a receipt that reports an empty match
 * set for a query that did match is worse than no receipt, because it teaches the
 * reader to distrust every future one.
 */

const QUERY = '打包脚本必须包含全量语法扫描，并核对依赖安装顺序';

const rule: KnowledgeDraft = {
  id: 'norm:syntax-gate', kind: 'norm', title: '发布脚本全量语法门禁',
  body: '打包发布脚本 scripts/package.mjs 必须包含 node --check 全量语法扫描，防止语法错误的脚本逃逸到安装目录。',
  scope: { kind: 'project', projectId: 'p' }, baseRevision: 0,
};

// 20KB+ of unrelated diary prose, with the rule's wording quoted inside it once -
// which is exactly what makes the old coverage formula prefer it.
const diaryBody = [
  '2026-10-17 工作记录。',
  '打包脚本必须包含全量语法扫描，依赖安装顺序也要核对。',
  ...Array.from({ length: 400 }, (_, index) =>
    `第 ${index + 1} 段：今天处理了无关的界面调整与会议记录，颜色、按钮间距、字体族都在反复改动，记录于此备查。`),
].join('\n');

const diary: KnowledgeDraft = {
  id: 'journal:long-tail', kind: 'journal', title: '十月十七日工作记录',
  did: diaryBody, problems: '无', outcome: 'success',
  scope: { kind: 'project', projectId: 'p' }, baseRevision: 0,
};

const note: KnowledgeDraft = {
  id: 'memory:unrelated', kind: 'memory', title: '颜色校正参数',
  body: '色彩空间与查找表设置，和构建流程无关。',
  scope: { kind: 'project', projectId: 'p' }, baseRevision: 0,
};

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'amb-norm-recall-'));
  return { dir, path: join(dir, 'knowledge.sqlite') };
}

test('基线：一条规范必须能用它的准原文被内存索引命中', async () => {
  const { dir, path } = scratch();
  const store = new Store(path);
  try {
    store.import([rule, note]);
    // The service reads synthesized digests from this table; a real core creates it
    // at startup, and the isolated library below has to be shaped the same way.
    initializeWorkflowDrafts(store);
    // No provider is configured, which is the deterministic local path: the answer
    // is the index's own ranking rather than anything inferred.
    const select = createRetrievalService(store, dir);
    const result = await select('p', QUERY);
    assert.ok(result.selectedIds.includes(rule.id),
      `规范必须能在自动检索里被命中；实际 selectedIds=${JSON.stringify(result.selectedIds)} reason=${result.reason}`);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('基线：短规范不得被引用了同一句话的长日记压在后面', context => {
  const candidates: RetrievalCandidate[] = [
    { id: rule.id, revision: 1, title: rule.title, kind: 'norm', body: rule.body },
    { id: diary.id, revision: 1, title: diary.title, kind: 'journal', body: diaryBody },
  ];
  const hits = buildRetrievalIndex(candidates).rank(QUERY);
  context.diagnostic(JSON.stringify({ query: QUERY, ruleChars: rule.body.length, diaryChars: diaryBody.length,
    order: hits.map(hit => ({ id: hit.candidate.id, score: Number(hit.score.toFixed(4)), strong: hit.strong })) }));
  assert.equal(hits.length, 2, '两个候选都应保留在结果里，比较的是顺序而不是存废');
  assert.equal(hits[0]!.candidate.id, rule.id,
    `准原文出自规范本身，规范就该排在引用它的长日记之前；实际顺序 ${hits.map(hit => hit.candidate.id).join(' > ')}`);
});

test('回执：传入 selectedIds 时命中片段必须真实，规范命中不得计为缺口', () => {
  const { dir, path } = scratch();
  const store = new Store(path);
  try {
    store.import([rule, note]);
    const prepared = store.prepare('p', QUERY, { selectedIds: [rule.id] });
    assert.ok(prepared.retrieval.matchedTokens.length > 0,
      `选择来自模型/索引时仍要保留命中词；实际 matched=${JSON.stringify(prepared.retrieval.matchedTokens)}`);
    for (const token of prepared.retrieval.matchedTokens)
      assert.ok(!prepared.retrieval.gaps.includes(token), `命中的片段 ${token} 不得同时被列为缺口`);
    assert.equal(prepared.retrieval.gaps.length < prepared.retrieval.tokens.length, true,
      '有真实命中时，缺口不可能是全部片段');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('回执：selected 条目要标明选择来自哪条路径', () => {
  const { dir, path } = scratch();
  const store = new Store(path);
  try {
    store.import([rule, note]);
    const prepared = store.prepare('p', '颜色校正参数', { selectedIds: [note.id], selectionSource: 'model' });
    assert.ok(prepared.retrieval.selected.length > 0, '至少应有一条入选条目');
    for (const item of prepared.retrieval.selected)
      assert.equal(item.why.source, 'model', `入选条目 ${item.id} 未标明来源`);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

type Provider = { calls: () => number };

async function coreFixture(t: TestContext, select: (payload: { query: string; catalog: unknown[][] }, response: ServerResponse) => void)
  : Promise<{ store: Store; post: (path: string, payload: Record<string, unknown>) => Promise<Record<string, any>> } & Provider> {
  const dir = mkdtempSync(join(tmpdir(), 'amb-norm-entry-'));
  const store = new Store(join(dir, 'knowledge.sqlite'));
  store.import([rule, note]);
  let calls = 0;
  const provider = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += String(part);
    calls += 1;
    const input = JSON.parse(body) as { messages: Array<{ content: string }> };
    select(JSON.parse(input.messages[1]!.content), res);
  });
  await new Promise<void>(done => provider.listen(0, '127.0.0.1', done));
  const address = provider.address(); assert(address && typeof address === 'object');
  writeFileSync(join(dir, 'model-review.json'),
    JSON.stringify({ endpoint: `http://127.0.0.1:${address.port}/v1`, model: 'norm-entry-fixture' }));
  const token = 'isolated-norm-entry-token-32-characters-x';
  const core = createCoreServer(store, { protocolVersion: 1, port: 47631,
    clients: [{ id: 'codex', token, projectId: 'p', role: 'adapter' }] });
  await new Promise<void>(done => core.listen(0, '127.0.0.1', done));
  const coreAddress = core.address(); assert(coreAddress && typeof coreAddress === 'object');
  t.after(async () => {
    for (const server of [core, provider]) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
    store.close(); rmSync(dir, { recursive: true, force: true });
  });
  return { store, calls: () => calls,
    async post(path, payload) {
      const res = await fetch(`http://127.0.0.1:${coreAddress.port}${path}`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-amb-protocol': '1' },
        body: JSON.stringify({ projectId: 'p', ...payload }) });
      assert.equal(res.status, 200, await res.clone().text());
      return await res.json() as Record<string, any>;
    } };
}

test('两条入口：模型弃权时 autoRecall 与显式检索必须给出同一结论', async t => {
  const f = await coreFixture(t, (_payload, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ selected: [] }) } }] }));
  });
  const automatic = await f.post('/v1/knowledge/search-universal', { query: QUERY, autoRecall: true });
  const explicit = await f.post('/v1/knowledge/search-universal', { query: QUERY });
  const ids = (results: any[]) => results.map(item => item.id).sort();
  assert.deepEqual(ids(automatic.results), ids(explicit.results),
    `同一查询的两条入口给出了不同结论：autoRecall=${JSON.stringify(ids(automatic.results))} 显式=${JSON.stringify(ids(explicit.results))}`);
  assert.ok(ids(explicit.results).includes(rule.id),
    `模型弃权不是“库里没有”，本地索引有命中时仍要给出；实际 ${JSON.stringify(ids(explicit.results))}`);
});
