import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.js';
import { createCoreServer } from '../src/server.js';
import { reviewPrefill } from '../src/model-review.js';
import { UI_JS } from '../src/ui.js';

/**
 * W10: the step that was computed and then thrown away.
 *
 * `model_reviews` already holds the analyzer's verdict — kind, scope, relation,
 * confidence, the split plan — and the approval endpoint already refuses to
 * promote the discovery text without a structured entry. What was missing is the
 * join between the two: the reviewer had to re-type a decision the program had
 * already made. These tests cover the join, and just as importantly the limits
 * of it: a suggestion is a default value in a form, never an approval, and a
 * candidate with no stored analysis gets no manufactured one.
 */

const token = 'e'.repeat(64);
const PROJECT = 'p0';

type Reply = { status: number; body: Record<string, any> };

async function fixture() {
  const store = new Store(':memory:', () => 1000);
  const server = createCoreServer(store, {
    protocolVersion: 1, port: 47632,
    clients: [{ id: 'admin', token, projectId: PROJECT, role: 'admin' }],
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const post = async (path: string, body: Record<string, unknown> = {}): Promise<Reply> => {
    const response = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-amb-protocol': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: PROJECT, ...body }),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const submit = async (key: string, discovery: string): Promise<string> => {
    const reply = await post('/v1/proposals', { idempotencyKey: key, discovery });
    assert.equal(reply.status, 200, `提交候选应成功：${JSON.stringify(reply.body)}`);
    return String(reply.body.id);
  };
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    store.close();
  };
  return { store, post, submit, close };
}

/**
 * Write the review row the maintenance worker would have written.
 *
 * The `inputHash` is computed from the stored payload exactly as
 * `maintenance.ts` computes it, because that hash is the only thing that lets a
 * reader tell a suggestion computed against the candidate's current text from
 * one computed before the text was edited.
 */
function storeReview(store: Store, proposalId: string, result: Record<string, unknown>) {
  const row = store.db.prepare('SELECT project_id,payload FROM proposals WHERE id=?').get(proposalId) as { project_id: string; payload: string };
  const envelope = { ...result, inputHash: createHash('sha256').update(String(row.payload)).digest('hex') };
  store.db.prepare(`INSERT INTO model_reviews(proposal_id,project_id,result,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(proposal_id) DO UPDATE SET result=excluded.result,updated_at=excluded.updated_at`)
    .run(proposalId, row.project_id, JSON.stringify(envelope), 1000);
}

const MODEL_REVIEW = {
  mode: 'model', status: 'analyzed', model: 'fixture-model', authority: 'advisory',
  analysis: {
    kind: 'norm', scope: 'project', relation: 'supplement', confidence: 0.82, needsSplit: true,
    suggestedSplit: [{ kind: 'norm', text: '规范要求部分' }, { kind: 'skill', text: '操作流程部分' }],
    summary: '一条可复用的约束', reasoning: '与既有条目互补',
    autoPromotable: false, promotionBlockedReason: 'evidence=self-reported：证据等级不足，需人工显式确认类别与作用域',
  },
};

test('有模型判定时，读取接口带回建议并如实标出模型来源', async () => {
  const f = await fixture();
  try {
    const id = await f.submit('prefill-model', '所有项目在升级前必须先跑一遍语法扫描。');
    storeReview(f.store, id, MODEL_REVIEW);

    const detail = await f.post('/v1/proposals/get', { id });
    assert.equal(detail.status, 200);
    const prefill = detail.body.prefill;
    assert.ok(prefill, '有判定时必须带回建议，而不是让人重填');
    assert.equal(prefill.source, 'model', '来源必须是模型，不能含糊成「分析」');
    assert.equal(prefill.model, 'fixture-model');
    assert.equal(prefill.authority, 'advisory', '建议永远只是建议');
    assert.equal(prefill.requiresHumanConfirmation, true, '预填不得被当成已完成的判定');
    assert.equal(prefill.analysisComplete, true);
    assert.equal(prefill.kind, 'norm');
    assert.equal(prefill.scope, 'project');
    assert.equal(prefill.relation, 'supplement');
    assert.equal(prefill.confidence, 0.82);
    assert.equal(prefill.stale, false, '文本未变时不得声称建议过期');
    assert.equal(prefill.suggestedSplit.length, 2);
    assert.match(prefill.note, /采纳仍由人确认/);

    // 列表项带上同一份建议的精简形式，让审阅者不必逐个打开才知道有没有建议。
    const list = await f.post('/v1/proposals/list', { state: 'pending' });
    const item = (list.body.proposals as Array<Record<string, any>>).find(row => row.id === id);
    assert.ok(item?.prefill, '列表项必须标出已有建议');
    assert.equal(item.prefill.source, 'model');
    assert.equal(item.prefill.kind, 'norm');
    assert.equal('reasoning' in item.prefill, false, '列表用精简建议，不搬运整段长文');
  } finally { await f.close(); }
});

test('没有判定时不编造建议，且返回结构与内核投影逐字段一致', async () => {
  const f = await fixture();
  try {
    const id = await f.submit('prefill-none', '这条候选还没有任何分析。');

    const detail = await f.post('/v1/proposals/get', { id });
    assert.equal(detail.status, 200);
    assert.equal('prefill' in detail.body, false, '没有判定就不能有建议字段');
    assert.equal(detail.body.modelReview.status, 'awaiting_model');

    const list = await f.post('/v1/proposals/list', { state: 'pending' });
    const item = (list.body.proposals as Array<Record<string, any>>).find(row => row.id === id);
    assert.ok(item);
    assert.equal('prefill' in item, false, '没有判定就不能凭空补一个建议');
    // 既有契约：没有建议的行必须与内核的原始投影完全相同，逐字段比较。
    const expected = f.store.listProposals(PROJECT, 'pending').find(row => row.id === id);
    assert.deepEqual(item, expected, '无建议的行不得因本次改动多出或少掉任何字段');
  } finally { await f.close(); }
});

test('人只点确认（字段全部取自建议）也能采纳，且 provenance 如实', async () => {
  const f = await fixture();
  try {
    const id = await f.submit('prefill-approve', '所有项目在升级前必须先跑一遍语法扫描。');
    storeReview(f.store, id, MODEL_REVIEW);
    const detail = await f.post('/v1/proposals/get', { id });
    const prefill = detail.body.prefill;

    // 界面路径：把建议填成表单默认值，人一个字都不改就点确认。
    const entry = {
      id,
      kind: prefill.kind,
      title: String(detail.body.discovery).slice(0, 40),
      body: detail.body.discovery,
      scope: { kind: prefill.scope === 'global' ? 'global' : 'project', projectId: PROJECT },
      baseRevision: 0,
      labels: ['approved'],
      provenance: 'user',
      evidence: 'verifiable',
      platforms: [],
    };

    // `classificationAcknowledged` is the click itself made explicit (B1): the core refuses
    // a candidate whose stored verdict cannot promote itself — this one is a `norm` stated
    // by the agent, so `autoPromotable` is false — and a person answering that is exactly
    // what the field records. The suggestion still decides nothing; the human does.
    const approved = await f.post('/v1/proposals/approve', { id, entry, prefillSource: 'model', classificationAcknowledged: true });
    assert.equal(approved.status, 200, `只点确认必须能成功：${JSON.stringify(approved.body)}`);
    assert.ok(approved.body.knowledgeRevision > 0);
    assert.match(String(approved.body.prefillNote), /模型建议/, '回执必须说明预填来自模型建议');
    assert.match(String(approved.body.prefillNote), /provenance/, '回执必须如实说明来源字段的记录方式');

    const stored = f.store.allEntries().find(entry => entry.id === id);
    assert.equal(stored?.content.kind, 'norm', '采纳后的类别应与建议一致（人确认的结果）');
    assert.equal(stored?.content.provenance, 'user', '建议不得把 provenance 改成 agent/external 一类的背书');
  } finally { await f.close(); }
});

test('建议本身不能替代确认：没有条目时采纳仍然被拒', async () => {
  const f = await fixture();
  try {
    const id = await f.submit('prefill-no-entry', '缺少结构化条目的候选。');
    storeReview(f.store, id, MODEL_REVIEW);
    const withoutEntry = await f.post('/v1/proposals/approve', { id, prefillSource: 'model' });
    assert.equal(withoutEntry.status, 400, '「模型已经算过」不能成为批准的凭据');
    assert.equal(f.store.allEntries().some(entry => entry.id === id), false, '被拒的请求不得写入任何条目');
    const stillPending = await f.post('/v1/proposals/list', { state: 'pending' });
    assert.equal((stillPending.body.proposals as unknown[]).length, 1);
  } finally { await f.close(); }
});

test('规则分析的建议标为启发式来源，并如实标出建议所基于的文本已变', async () => {
  const f = await fixture();
  try {
    const id = await f.submit('prefill-heuristic', '先按本地规则分类的候选。');
    storeReview(f.store, id, {
      mode: 'heuristic_only', status: 'awaiting_model', reason: 'not_configured', authority: 'advisory',
      analysis: { kind: 'memory', scope: 'project', relation: 'new', confidence: 0.6, needsSplit: false, reasoning: '语义判定：类型=memory' },
    });

    const detail = await f.post('/v1/proposals/get', { id });
    assert.equal(detail.body.prefill.source, 'heuristic', '规则分析不得冒充模型判定');
    assert.equal(detail.body.prefill.analysisComplete, false);
    assert.match(detail.body.prefill.note, /模型判定尚未完成/);
    assert.equal(detail.body.prefill.stale, false);

    // 候选文本在判定之后被改动：建议必须自报其年龄，而不是装作仍然有效。
    const row = f.store.db.prepare('SELECT payload FROM proposals WHERE id=?').get(id) as { payload: string };
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    payload.discovery = '改过的候选文本，分析没有重跑。';
    f.store.db.prepare('UPDATE proposals SET payload=? WHERE id=?').run(JSON.stringify(payload), id);

    const after = await f.post('/v1/proposals/get', { id });
    assert.equal(after.body.prefill.stale, true, '文本变过之后必须标为过期建议');
    assert.match(after.body.prefill.note, /其后有更新/);
  } finally { await f.close(); }
});

test('词汇表不符或残缺的存储行不产生建议', () => {
  assert.equal(reviewPrefill(null), null);
  assert.equal(reviewPrefill({ analysis: null }), null);
  assert.equal(reviewPrefill({ analysis: { kind: 'rule', scope: 'project', relation: 'new', confidence: 0.5, needsSplit: false } }), null);
  assert.equal(reviewPrefill({ analysis: { kind: 'memory', scope: 'everywhere', relation: 'new', confidence: 0.5, needsSplit: false } }), null);
  assert.equal(reviewPrefill({ analysis: { kind: 'memory', scope: 'project', relation: 'new', confidence: 2, needsSplit: false } }), null);
  assert.equal(reviewPrefill({ analysis: { kind: 'memory', scope: 'project', relation: 'new', confidence: 0.5 } }), null);
  const ok = reviewPrefill({
    mode: 'model', status: 'analyzed', model: 'm1',
    analysis: { kind: 'memory', scope: 'task', relation: 'new', confidence: 0.5, needsSplit: false, autoPromotable: true },
  });
  assert.equal(ok?.source, 'model');
  assert.equal(ok?.scope, 'task');
  assert.equal(ok?.autoPromotable, true);
});

test('管理界面的表单按建议预填，并显示来源与置信度', () => {
  // The page is a string served by the core, so this is the only level at which
  // its wiring can be checked without a browser: the fields the suggestion fills,
  // the wording that says where it came from, and the fact that the confirm
  // button both carries the source and still needs the person to press it.
  assert.match(UI_JS, /id="pe-kind"/, '表单必须有可修改的类别字段');
  assert.match(UI_JS, /prefill && prefill\.kind === kind \? ' selected'/, '类别默认值必须取自建议');
  assert.match(UI_JS, /模型建议/, '必须标出建议来自模型');
  assert.match(UI_JS, /规则分析建议（模型判定尚未完成）/, '规则分析不得冒充模型判定');
  assert.match(UI_JS, /置信度 /, '必须显示置信度');
  assert.match(UI_JS, /暂无建议：模型与规则分析都没有给出这条候选的判定/, '无建议时如实说明，而不是留空');
  assert.match(UI_JS, /data-prefill/, '确认按钮必须带上建议来源，供回执如实说明');
  // Judged on executed code, not comments: the reason prompt() is banned is
  // already written down in this file, and the pattern is the call itself.
  const code = UI_JS.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/prompt\(/.test(code), false, '界面不得回退到 prompt()');
});

/**
 * The queue view, which is the one the panel opens by default.
 *
 * A suggestion that only exists in the flat list would sit on the road the
 * reviewer rarely takes — the same "computed and then unused" defect this file
 * exists to catch, one layer down. These tests check the queue entries carry the
 * same suggestion, and that the folded failure-facts group says why it does not.
 */

/** Byte-for-byte the text `adapters/dsh/failure-capture.mjs` submits for a failure. */
const capturedFailure = (tool: string, observation: string, session: string) =>
  '【自动捕获的失败事实；待核实】\n'
  + '所属流程：工具执行与故障恢复；步骤：记录失败、检索已有经验、验证修复。\n'
  + `来源：dsh 会话 ${session}；工具：${tool}。\n`
  + `观察：${observation}\n`
  + '根因与修复：尚未验证；请主动检索相关经验，验证后用 amb_submit_experience 补充可复用结论。不得将本记录直接当作已采纳规范。';

let queueSeq = 0;
const nextKey = (prefix: string) => `w10-${prefix}-${++queueSeq}`;

test('queue 视图的候选项带回建议，且与 flat 视图同一形态', async () => {
  const f = await fixture();
  try {
    const id = await f.submit(nextKey('queue-candidate'), '所有项目在升级前必须先跑一遍语法扫描。');
    storeReview(f.store, id, MODEL_REVIEW);

    const queue = await f.post('/v1/proposals/list', { view: 'queue', include: 'actionable' });
    assert.equal(queue.status, 200);
    const item = (queue.body.items as Array<Record<string, any>>).find(row => row.id === id);
    assert.ok(item, '人工提交的候选必须出现在默认视图里');
    // Both shapes name themselves, so a consumer can branch on this field without
    // treating "no value" as "the other shape". The earlier version of this assertion
    // pinned the opposite (candidates carry no `kind`) because that was the shape the
    // implementation happened to have; the property worth protecting is that the two
    // are distinguishable, which is what is asserted here and in the aggregation test.
    assert.equal(item.kind, 'candidate', '候选项必须显式标出自己是 candidate');
    assert.notEqual(item.kind, 'aggregate', '候选项不得与折叠组共用同一个 kind 值');
    assert.equal((queue.body.items as Array<Record<string, any>>).some(row => row.kind === 'aggregate'), false,
      '这一批没有同签名失败，因此不应出现折叠组');
    assert.ok(item.prefill, '面板默认视图下的候选必须能看到建议');
    assert.equal(item.prefill.source, 'model');
    assert.equal(item.prefill.kind, 'norm');
    assert.equal(item.prefill.authority, 'advisory');
    assert.equal(item.prefill.requiresHumanConfirmation, true);
    assert.equal('reasoning' in item.prefill, false, '视图里用精简建议，不搬运整段长文');

    const flat = await f.post('/v1/proposals/list', { state: 'pending' });
    const flatItem = (flat.body.proposals as Array<Record<string, any>>).find(row => row.id === id);
    assert.ok(flatItem, '扁平列表也必须能看到这条候选');
    assert.deepEqual(item.prefill, flatItem.prefill, '两条视图必须给同一份建议，否则会漂移');
  } finally { await f.close(); }
});

test('queue 的聚合项按约定不带建议，并在 note 里说明原因', async () => {
  const f = await fixture();
  try {
    const observation = 'cannot modify "D:\\work\\src\\a.ts": file has not been read — read the file, then retry';
    await f.submit(nextKey('fail-a'), capturedFailure('edit', observation, 'sess-a'));
    await f.submit(nextKey('fail-b'), capturedFailure('edit', observation.replace('a.ts', 'b.ts'), 'sess-b'));

    const queue = await f.post('/v1/proposals/list', { view: 'queue', include: 'failure-facts' });
    assert.equal(queue.status, 200);
    const aggregate = (queue.body.items as Array<Record<string, any>>)[0]!;
    assert.equal(aggregate.kind, 'aggregate', '同签名的失败事实必须折叠成一条');
    assert.equal(aggregate.occurrences, 2);
    assert.equal('prefill' in aggregate, false, '折叠组不是一个可采纳的候选，不得带建议');
    // 缺席必须被解释过，否则调用方会以为是自己漏读或服务端漏填。
    assert.match(String(queue.body.note), /聚合组（kind=aggregate）不提供建议/, '必须在 note 里说清聚合组没有建议');
    assert.match(String(queue.body.note), /只读派生视图/, '原有说明必须保留');
  } finally { await f.close(); }
});

test('没有模型判定时，queue 候选项同样缺席建议字段', async () => {
  const f = await fixture();
  try {
    const id = await f.submit(nextKey('queue-no-review'), '这条候选还没有任何分析。');
    const queue = await f.post('/v1/proposals/list', { view: 'queue', include: 'actionable' });
    const item = (queue.body.items as Array<Record<string, any>>).find(row => row.id === id);
    assert.ok(item);
    assert.equal('prefill' in item, false, '没有判定就不能凭空补一个建议');
  } finally { await f.close(); }
});

test('queue 视图的改动没有触碰 store 层的投影', async () => {
  const f = await fixture();
  try {
    const withReview = await f.submit(nextKey('drift-reviewed'), '有判定的候选项。');
    storeReview(f.store, withReview, MODEL_REVIEW);
    const observation = 'old_string was not found in "D:\\w\\a.ts"';
    await f.submit(nextKey('drift-fail-a'), capturedFailure('edit', observation, 'sess-a'));
    await f.submit(nextKey('drift-fail-b'), capturedFailure('edit', observation.replace('a.ts', 'b.ts'), 'sess-b'));

    // The store's own projection, read directly — no HTTP, no additions.
    const raw = f.store.queueProposals(PROJECT, { include: 'all', sampleLimit: 3 });
    const rawItems = raw.items as unknown as Array<Record<string, unknown>>;
    for (const row of rawItems)
      assert.equal('prefill' in row, false, 'store 层的投影片不得出现 prefill');

    const served = await f.post('/v1/proposals/list', { view: 'queue', include: 'all' });
    const items = served.body.items as Array<Record<string, any>>;
    assert.equal(items.length, rawItems.length, '服务端不得增删条目');
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      const expected = rawItems[index]!;
      if (item.kind === 'aggregate') {
        assert.deepEqual(item, expected, '聚合项必须与 store 投影逐字段一致');
        continue;
      }
      const { prefill, ...rest } = item;
      assert.deepEqual(rest, expected, '候选项除新增的可选 prefill 外必须与 store 投影逐字段一致');
      if (item.id === withReview) assert.ok(prefill, '被分析过的候选必须带上建议');
      else assert.equal(prefill, undefined, '没有判定的候选项不得多出 prefill');
    }
  } finally { await f.close(); }
});
