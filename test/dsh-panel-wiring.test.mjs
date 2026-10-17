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

test('a stored candidate classified before the verdict existed keeps its one-click path', async () => {
  // The verdict is an addition, not a replacement: candidates submitted before it have
  // no `autoPromotable` field, and reading absence as a refusal would turn every one of
  // them into a form. Only an explicit `false` blocks.
  const payload = {
    projectId: PROJECT,
    discovery: '旧候选的文本',
    classification: { kind: 'memory', scope: 'project', relation: 'new', confidence: 0.5 },
  };
  const params = await buildPanelAdminParams('proposal-approve', { id: 'c3' }, CONFIG, adminStub(payload));
  assert.equal(params.entry.kind, 'memory', '缺少判定字段的旧候选必须保持一键采纳');
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
