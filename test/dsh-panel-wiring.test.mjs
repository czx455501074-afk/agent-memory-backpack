import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPanelAdminParams, entryFromClassification } from '../adapters/dsh/index.mjs';

/**
 * W7 wiring: what the panel's admin actions actually send, and what the one-click
 * approval path decides.
 *
 * These are dry-run tests. `buildPanelAdminParams` is the single place where the panel's
 * request becomes the core's parameters, so it is driven directly with a stubbed admin
 * client: nothing here talks to a core, and the assertions are about the parameters the
 * core would receive.
 */

const PROJECT = 'p0';
const CONFIG = { projectId: PROJECT, endpoint: 'http://127.0.0.1:1', token: 'x'.repeat(64) };

/** An admin client that answers `proposals/get` and records what it was asked. */
function adminStub(payload) {
  const calls = [];
  return {
    calls,
    async post(path, body) {
      calls.push({ path, body });
      return { id: body.id, payload };
    },
  };
}

test('the panel asks for the aggregated queue view by default', async () => {
  const params = await buildPanelAdminParams('proposals-list', {}, CONFIG, adminStub(null));
  assert.equal(params.view, 'queue', '面板默认必须请求聚合视图，而不是扁平列表');
  assert.equal(params.include, 'actionable', '默认切片必须是可操作条目（折叠组仍由 groups 报出）');
  assert.equal(params.projectId, PROJECT, '作用域仍由这一侧补齐');
});

test('the panel can ask for the folded members back without losing the aggregate parameters', async () => {
  const params = await buildPanelAdminParams(
    'proposals-list',
    { include: 'failure-facts', sampleLimit: 5 },
    CONFIG,
    adminStub(null),
  );
  assert.equal(params.view, 'queue', '取回成员仍走聚合视图：成员是同一批行的另一个切片');
  assert.equal(params.include, 'failure-facts', '取回成员必须显式请求折叠组');
  assert.equal(params.sampleLimit, 5, '调用方给出的取样上限必须透传');
});

test('a candidate the classifier refused to auto-promote is rejected with its reason', async () => {
  const payload = {
    projectId: PROJECT,
    discovery: '证据等级不足的规范候选',
    classification: {
      kind: 'norm', scope: 'project', relation: 'new', confidence: 0.8,
      autoPromotable: false,
      promotionBlockedReason: 'evidence=self-reported：证据等级不足，需人工显式确认类别与作用域',
    },
  };
  const admin = adminStub(payload);
  await assert.rejects(
    () => buildPanelAdminParams('proposal-approve', { id: 'c1' }, CONFIG, admin),
    error => {
      assert.match(error.message, /evidence=self-reported/, '拒绝理由必须原样进入错误消息');
      assert.match(error.message, /人工选定类别与作用域/, '必须指明退回的是既有的人工路径');
      return true;
    },
  );
  // The refusal happens before the approve call: nothing was written.
  assert.equal(admin.calls.some(call => call.path === '/v1/proposals/approve'), false,
    '被拦下的候选不得走到采纳请求');
});

test('a candidate the classifier allows is still promoted in one click', async () => {
  const payload = {
    projectId: PROJECT,
    discovery: '只读命令也要探测真实的失败形态\n第二行细节',
    classification: {
      kind: 'norm', scope: 'project', relation: 'new', confidence: 0.9,
      autoPromotable: true,
    },
  };
  const params = await buildPanelAdminParams('proposal-approve', { id: 'c2' }, CONFIG, adminStub(payload));
  assert.equal(params.entry.kind, 'norm', '可自动升格的候选必须仍是一键，并保持分类给出的类别');
  assert.equal(params.entry.scope.kind, 'project', '作用域沿用分类结论');
  assert.equal(params.entry.evidence, 'unverifiable', '捕获的候选在库里仍是未核实，一键不改变这一点');
  assert.equal(params.entry.provenance, 'agent', '形态由插件决定这一事实必须留在条目里');
});

test('a stored candidate classified before the verdict existed now needs a person', async () => {
  // Deliberate reversal (B1). The verdict used to be additive: a snapshot without
  // `autoPromotable` kept its one-click path, because reading absence as a refusal "would
  // turn every one of them into a form". Measured on the real library, 341 of the pending
  // candidates have no such field and 256 of those still say `norm` — so absence was
  // precisely the door through which an older classifier's verdict could still become a
  // rule. Absence is now a reason to ask a person, and the refusal has to say which one
  // it is rather than reporting "no classification".
  const payload = {
    projectId: PROJECT,
    discovery: '旧候选的文本',
    classification: { kind: 'memory', scope: 'project', relation: 'new', confidence: 0.5 },
  };
  await assert.rejects(
    () => buildPanelAdminParams('proposal-approve', { id: 'c3' }, CONFIG, adminStub(payload)),
    /旧版本判定器/,
    '缺少判定字段的旧候选不得再一键采纳，且必须说明原因',
  );
});

test('a core that allows the promotion restores the one-click path', async () => {
  // The adapter reads the core's own gate when it is present, so a candidate the core has
  // reclassified (or a core that computed a fresh verdict) is promoted exactly as before.
  // One rule, one place: the adapter does not second-guess the verdict it was handed.
  const payload = {
    projectId: PROJECT,
    discovery: '已由核心判定的候选',
    classification: { kind: 'memory', scope: 'project' },
    classificationGate: {
      required: false, reason: '', kind: 'memory', scope: 'project', autoPromotable: true, classifierVersion: 'test',
    },
  };
  const params = await buildPanelAdminParams('proposal-approve', { id: 'c5' }, CONFIG, adminStub(payload));
  assert.equal(params.entry.kind, 'memory', '核心判定为可放行时必须仍然一键采纳');
  assert.equal(params.entry.provenance, 'agent');
});

test('entryFromClassification refuses a verdict-bearing candidate on its own', () => {
  const blocked = entryFromClassification({
    projectId: PROJECT,
    discovery: '文本',
    classification: { kind: 'norm', scope: 'project', autoPromotable: false, promotionBlockedReason: '理由' },
  }, PROJECT, 'c4');
  assert.equal(blocked, null, '函数本身必须拒绝：门禁不能只存在于调用方');

  const allowed = entryFromClassification({
    projectId: PROJECT,
    discovery: '文本',
    classification: { kind: 'norm', scope: 'project', autoPromotable: true },
  }, PROJECT, 'c5');
  assert.equal(allowed.kind, 'norm', '明确允许时必须给出条目');
});

/**
 * The compose form is the way past the gate, so the request has to say so.
 *
 * Reported from a live panel: a withheld candidate was opened, the kind and scope were
 * confirmed, "确认采纳" was pressed — and the core refused with `classification_confirmation_required`,
 * while the panel's own guidance told the reviewer to do what they had just done. The
 * panel never sent `classificationAcknowledged`, so the route the guidance described did
 * not exist. These three cases pin who may claim the confirmation.
 */

const FORM_ENTRY = {
  id: 'memory:c9',
  kind: 'memory',
  title: '人工确认过的标题',
  body: '候选正文',
  scope: { kind: 'project', projectId: PROJECT },
  baseRevision: 0,
};

test('a form approval carries the reviewer confirmation to the core', async () => {
  const params = await buildPanelAdminParams('proposal-approve', { id: 'c9', entry: FORM_ENTRY }, CONFIG, adminStub(null));
  assert.equal(params.classificationAcknowledged, true,
    '表单里点过确认的采纳必须把人工确认带给核心，否则被拦下的候选永远无法采纳');
  assert.deepEqual(params.entry, FORM_ENTRY, '条目必须原样透传，不被这一层改写');
});

test('a derived entry does not pretend a person confirmed it', async () => {
  const payload = {
    projectId: PROJECT,
    discovery: '可自动升格',
    classification: { kind: 'memory', scope: 'project', autoPromotable: true },
  };
  const params = await buildPanelAdminParams('proposal-approve', { id: 'c10' }, CONFIG, adminStub(payload));
  assert.ok(params.entry, '一键路径仍应构造出条目');
  assert.equal(params.classificationAcknowledged, undefined,
    '由适配器派生的条目不是人工确认，不得带上标记');
});

test('an explicit refusal to confirm is not overwritten', async () => {
  const params = await buildPanelAdminParams(
    'proposal-approve',
    { id: 'c11', entry: FORM_ENTRY, classificationAcknowledged: false },
    CONFIG,
    adminStub(null),
  );
  assert.equal(params.classificationAcknowledged, false,
    '调用方明确说未确认时必须保留，只有缺省才由表单补上');
});
