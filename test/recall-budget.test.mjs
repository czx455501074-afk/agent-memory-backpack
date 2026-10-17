import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recallKnowledge, resolveRecallBudget, RECALL_BUDGET_DEFAULTS } from '../adapters/dsh/recall.mjs';

/** A logger that keeps what the adapter logged, so the receipt can be asserted. */
function recording() {
  const logs = [];
  return {
    logs,
    info: (event, data) => logs.push({ event, ...data }),
    warn: (event, data) => logs.push({ event, ...data }),
    error: (event, data) => logs.push({ event, ...data }),
  };
}

function fixtureClient({ ids, bodies, title = 'Fixture' }) {
  const calls = [];
  const post = async (route, payload) => {
    calls.push({ route, payload });
    if (route.endsWith('search-universal')) {
      return {
        results: ids.map(id => ({ id, revision: 1 })),
        knowledgeRevision: 7,
        selection: { mode: 'index', reason: 'fixture' },
      };
    }
    const index = ids.indexOf(payload.knowledgeId);
    if (index < 0) throw new Error('unknown knowledge id');
    return { id: payload.knowledgeId, title, revision: 1, body: bodies[index] };
  };
  return { client: { post }, calls };
}

test('a passage that fits its budget is byte-identical to the pre-budget behaviour', async () => {
  const bodies = ['b'.repeat(120), 'c'.repeat(120)];
  const { client } = fixtureClient({ ids: ['id0', 'id1'], bodies });
  const { context, ids } = await recallKnowledge({
    client, config: { projectId: 'p' }, logger: recording(), adapter: 'dsh', sessionId: 's', query: 'fixture',
  });
  // The golden text is the exact output of the implementation before the budget:
  // header, then one block per document, joined by a blank line.
  const golden = '[AMB 自动检索并读取：task]\n以下为库内参考资料，请结合当前任务与验证结果使用。\n'
    + `### Fixture (id0@1)\n${bodies[0]}\n\n### Fixture (id1@1)\n${bodies[1]}`;
  assert.equal(context, golden);
  assert.deepEqual(ids, ['id0', 'id1']);
  assert.doesNotMatch(context, /召回预算/, 'A passage inside its budget says nothing about omissions');
});

test('over budget the recall passage is what shrinks, and it says so with a way back', async () => {
  const bodies = ['x'.repeat(9000), 'y'.repeat(9000)];
  const logs = recording();
  const { client } = fixtureClient({ ids: ['id0', 'id1'], bodies });
  const { context } = await recallKnowledge({
    client, config: { projectId: 'p', recallBudgetChars: 150 }, logger: logs,
    adapter: 'dsh', sessionId: 's', query: 'fixture',
  });
  assert.doesNotMatch(context, new RegExp('x'.repeat(2000)), 'No full body travels when the budget is 150 characters');
  assert.match(context, /召回预算 150 字符已用尽：本次省略 1 篇正文（共 9000 字符）/, 'The omission states how much was left out');
  assert.match(context, /id1（9000 字符）/, 'The omission names every document it dropped');
  assert.match(context, /amb_read_knowledge\(knowledgeId\)/, 'The omission says how to fetch the full text back');
  assert.match(context, /amb_read_knowledge\(knowledgeId, includeLeaves:true\)/, 'Reference documents stay reachable too');
  assert.match(context, /amb_read_knowledge\(knowledgeId: "id0"\)/, 'The entry that does travel carries its own retrieval hint');
  const recall = logs.logs.find(entry => entry.event === 'knowledge.auto_recall');
  assert.equal(recall.budgetChars, 150);
  assert.deepEqual(recall.omittedIds, ['id1']);
  assert.equal(recall.omittedChars, 9000);
  assert.equal(recall.chars, context.length);
});

test('the budget never shortens a normative entry', async () => {
  const normative = 'n'.repeat(2000);
  const bodies = [normative, 'x'.repeat(9000)];
  const logs = recording();
  const { client } = fixtureClient({ ids: ['norm:fixture-norm', 'skill:fixture-skill'], bodies });
  const { context } = await recallKnowledge({
    client, config: { projectId: 'p', recallBudgetChars: 200 }, logger: logs,
    adapter: 'dsh', sessionId: 's', query: 'fixture',
  });
  assert.ok(context.includes(normative), 'A prohibition or obligation recalled here is delivered whole, budget or not');
  assert.equal(context.length > 2000, true);
  const recall = logs.logs.find(entry => entry.event === 'knowledge.auto_recall');
  assert.deepEqual(recall.disclosure, ['norm:fixture-norm:full']);
  assert.deepEqual(recall.omittedIds, ['skill:fixture-skill'], 'Only the non-normative entry may be dropped');
});

test('an explicit disclosure level holds the passage to one line per document', async () => {
  const bodies = ['x'.repeat(9000), 'y'.repeat(9000)];
  const { client } = fixtureClient({ ids: ['id0', 'id1'], bodies });
  const { context, ids } = await recallKnowledge({
    client, config: { projectId: 'p', recallLevel: 'index' }, logger: recording(),
    adapter: 'dsh', sessionId: 's', query: 'fixture',
  });
  assert.ok(context.length < 600, `index disclosure must stay small, got ${context.length}`);
  assert.match(context, /\[索引\]/);
  assert.match(context, /正文 9000 字符未注入/);
  assert.deepEqual(ids, ['id0', 'id1'], 'An index entry is an entry: the model still learns the id exists');
});

test('the budget is configurable, and configuration outranks the environment', () => {
  assert.equal(RECALL_BUDGET_DEFAULTS.totalChars, 1600);
  assert.equal(resolveRecallBudget({}, { AMB_RECALL_BUDGET_CHARS: '900', AMB_RECALL_LEVEL: 'index' }).totalChars, 900);
  assert.equal(resolveRecallBudget({}, { AMB_RECALL_BUDGET_CHARS: '900', AMB_RECALL_LEVEL: 'index' }).level, 'index');
  assert.equal(resolveRecallBudget({ recallBudgetChars: 500 }, { AMB_RECALL_BUDGET_CHARS: '900' }).totalChars, 500);
  assert.equal(resolveRecallBudget({ recallLevel: 'nonsense' }, {}).level, 'auto', 'An unknown level falls back to auto');
});

test('the recall budget ships identically in both hosts', () => {
  assert.equal(readFileSync(new URL('../adapters/dsh/recall.mjs', import.meta.url), 'utf8'),
    readFileSync(new URL('../adapters/codex/scripts/recall.mjs', import.meta.url), 'utf8'));
});
