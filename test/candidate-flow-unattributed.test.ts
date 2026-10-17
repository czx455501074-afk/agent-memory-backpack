import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { skillSchema, workflowSchema } from '../src/schema.js';

/**
 * W11: a candidate nobody can attribute must not be a candidate nobody can adopt.
 *
 * Measured state of the review queue this covers: 349 pending candidates, 349 of
 * them `attribution.resolved: false`, and a library holding 0 workflow entries. The
 * mechanism was structural rather than a matter of taste — attribution asked for a
 * workflow that did not exist — and the receipt said as much on every submission
 * ("本条候选未标注归属流程，请人工确认它应归属哪个流程/步骤"). The queue view then
 * disagreed with the detail view about the same row, and reported a candidate that
 * names nothing as though a person had placed it in a flow.
 *
 * What these tests pin down:
 *
 *  1. an unattributed candidate is in the default queue, is a candidate rather than a
 *     folded failure group, and says why it is unattributed;
 *  2. it can be adopted, with its provenance recorded as what it actually is;
 *  3. when an attribution does exist it still ranks above one that does not;
 *  4. nothing here manufactures a workflow to make attribution succeed, and no
 *     candidate is rejected, hidden or downgraded out of the queue for lacking one.
 *
 * A person still reviews: adoption stays a separate, explicit act by a reviewer, and
 * a self-reported submission keeps the tier the policy gave it.
 */

const PROJECT = 'p0';
const clock = { now: 1_700_000_000_000 };
const open = () => new Store(':memory:', () => clock.now);

let seq = 0;
/** Submit one candidate through the ordinary path and return its id. */
function submit(s: Store, text: string, extra: Record<string, unknown> = {}) {
  seq += 1;
  clock.now += 1000;
  return s.submit('dsh', { idempotencyKey: `w11-${seq}`, projectId: PROJECT, discovery: text, ...extra });
}

/** A workflow the project can see, for the "attribution exists" case. */
const flow = (id: string) => workflowSchema.parse({
  id, kind: 'workflow', title: `${id} 标题`, scope: { kind: 'project', projectId: PROJECT },
  baseRevision: 0, overview: '概览', triggers: ['触发'], categories: [['类']],
  preconditions: ['前置'],
  stages: [{ id: 'apply', title: '实施', instructions: '按步骤实施', checks: ['已完成'], dependencies: [] }],
  completion: ['完成'], recovery: '回滚',
});

const entry = (id: string, overrides: Record<string, unknown> = {}) => skillSchema.parse({
  id, kind: 'skill', title: '未归属候选采纳后的条目', scope: { kind: 'project', projectId: PROJECT },
  body: '正文：这条经验是 agent 自己提交并被人确认的。',
  provenance: 'agent', evidence: 'self-reported', ...overrides,
});

const queueItem = (s: Store, id: string, state = 'pending') => s.queueProposals(PROJECT, { include: 'all', state }).items
  .find(item => item.id === id) as Record<string, any> | undefined;

// ── ① unattributed candidates are queued, not held back ─────────────────────

test('W11-①：未归属候选出现在默认队列里，且明确说明"采纳不依赖归属"', () => {
  const s = open();
  try {
    const receipt = submit(s, '没有标注任何流程的经验也应当能被审、能被采纳。');
    // The receipt keeps telling the truth about what was stored; it is an
    // explanation, not a refusal, and it must not read like a blocker.
    assert.equal(receipt.state, 'pending', '未归属候选必须照常入队待审');
    assert.deepEqual(receipt.attribution, { workflowId: null, stageId: null, resolved: false });
    assert.match(String(receipt.note), /未标注归属流程/);

    const inQueue = queueItem(s, String(receipt.id));
    assert.ok(inQueue, '未归属候选必须出现在队列视图里，而不是被默认视图过滤掉');
    assert.equal(inQueue.state, 'pending');
    assert.equal(inQueue.kind, 'candidate', '普通候选必须显式标明自己是 candidate（与折叠组的 aggregate 区分）');
    assert.equal(inQueue.attribution.resolved, false, '未归属必须如实报告为未归属');
    assert.equal(inQueue.attribution.described, true, '提交时已写入判定，读取时必须如实报告"有判定"');

    const totals = s.queueProposals(PROJECT, {}).totals;
    assert.equal(totals.inState, 1);
    assert.equal(totals.returned, 1, '默认视图必须返回这条候选');
    assert.equal(totals.failureSignatures, 0, '人工提交的候选不得被当成失败事实聚合掉');
  } finally { s.close(); }
});

// ── ② adoption works, and the provenance stays honest ───────────────────────

test('W11-②：未归属候选可被采纳，provenance 如实记为 agent 提交的经验', () => {
  const s = open();
  try {
    const receipt = submit(s, '未归属但已被人工确认的经验：采纳后必须能按来源追溯。');
    // The reviewer here is a person, and B1 requires that acknowledgement to travel with the
    // decision: a candidate whose stored verdict cannot promote itself is not adopted on a
    // bare call, whichever entry point makes it.
    const revision = s.approveProposal(String(receipt.id), entry('w11-adopted'), {
      actor: 'reviewer', projectId: PROJECT, classificationAcknowledged: true,
    });
    assert.ok(revision >= 1, '未归属候选的采纳必须真正写入知识库');

    const stored = s.allEntries().find(item => item.id === 'w11-adopted');
    assert.ok(stored, '采纳必须真正写入知识库');
    assert.equal(stored.content.provenance, 'agent', 'agent 提交的经验不得因为采纳而变成 user 陈述');
    assert.equal(stored.content.evidence, 'self-reported', '自述内容不得被记成已验证证据');

    const decided = s.listProposals(PROJECT, 'approved').find(row => row.id === receipt.id);
    assert.equal(decided?.state, 'approved', '采纳后状态必须离开待审队列');
    assert.equal((decided?.decision as { actor?: string })?.actor, 'reviewer', '决定必须记下是谁做的');

    // Review is still a separate act: nothing about the submission adopted itself.
    const second = submit(s, '第二条未归属候选：必须继续停在待审状态，等人审。');
    assert.equal(s.listProposals(PROJECT, 'pending').filter(row => row.id === second.id).length, 1);
    assert.equal(second.review?.tier, 'review', '自述提交仍按策略进入人工审核档');
  } finally { s.close(); }
});

// ── ③ a real attribution still ranks first ──────────────────────────────────

test('W11-③：归属存在时仍按归属优先展示（未归属不被排除，只是排在后面）', () => {
  const s = open();
  try {
    s.import([flow('flow-with-steps')]);
    const unattributed = submit(s, '未归属的经验：同等条件下应当排在已归属之后。');
    const attributed = submit(s, '已归属到流程与步骤的经验：同等条件下应当排在前面。', {
      workflowId: 'flow-with-steps', stageId: 'apply', baseRevision: 1,
    });

    const items = s.queueProposals(PROJECT, { include: 'all' }).items as Array<Record<string, any>>;
    const ids = items.map(item => item.id);
    assert.equal(ids.indexOf(String(attributed.id)), 0, '已归属候选必须排在未归属候选之前');
    assert.ok(ids.includes(String(unattributed.id)), '未归属候选仍必须在队列里，只是靠后');

    const located = items[0];
    assert.ok(located, '队列必须至少返回这一条已归属候选');
    assert.equal(located.attribution.resolved, true);
    assert.equal(located.attribution.reason, null, '已定位的候选没有需要解释的缺口');
    assert.ok(located.priority.reasons.some((reason: string) => reason.includes('已归属')), '排序理由必须说明为什么靠前');

    const later = items.find(item => item.id === unattributed.id);
    assert.ok(later, '未归属候选仍必须在队列里，只是靠后');
    assert.ok(later.priority.reasons.some((reason: string) => reason.includes('未归属流程，采纳不依赖')), '未归属的理由必须写明采纳不依赖它');
    assert.equal(later.priority.band, 'normal', '未归属不得把候选降级到低价值分组');
  } finally { s.close(); }
});

// ── ④ no workflow is invented, and both read paths agree ────────────────────

test('W11-④：不合成任何 workflow；列表与详情的归属判定必须一致', () => {
  const s = open();
  try {
    const workflows = () => s.allEntries().filter(item => item.content.kind === 'workflow').length;
    assert.equal(workflows(), 0, '前置：这条测试的库本来就没有流程');

    const receipt = submit(s, '库中零流程时提交的候选：不得为了归属而凭空造出一个流程。');
    for (const text of ['第二条', '第三条']) submit(s, `${text}未归属候选。`);
    s.approveProposal(String(receipt.id), entry('w11-no-synthesis'), {
      actor: 'reviewer', projectId: PROJECT, classificationAcknowledged: true,
    });
    s.archiveProposal(String(s.listProposals(PROJECT, 'pending').at(-1)!.id), { projectId: PROJECT });

    assert.equal(workflows(), 0, '提交、采纳、归档都不许合成 workflow 条目');
    assert.equal(s.revision, 1, '只应写入被采纳的那一条经验，其余候选不产生修订');

    // Both read paths can be reached with nothing recorded about attribution
    // (rows written before the verdict existed, or a payload edited by hand).
    const legacy = submit(s, '记录里没有 attribution 字段的候选。');
    s.db.prepare('UPDATE proposals SET payload=? WHERE id=?')
      .run(JSON.stringify({ projectId: PROJECT, discovery: '记录里没有 attribution 字段的候选。' }), receipt.id);

    const listed = s.listProposals(PROJECT, 'approved').find(row => row.id === receipt.id);
    assert.ok(listed, '被改写的行必须仍能被列出');
    assert.ok(listed.attribution, '列表必须报告归属字段');
    assert.equal(listed.attribution.resolved, false, '缺少判定不得被读成已定位');
    // The explanation travels in the queue view, which is the one that ranks; the
    // list keeps exactly the three fields its callers already assert on.
    const listedInQueue = queueItem(s, receipt.id, 'approved');
    assert.ok(listedInQueue, '被改写的行仍必须出现在队列里');
    assert.equal(listedInQueue.attribution.described, false, '缺少判定时如实报告"没有判定"，而不是编一个');
    assert.match(String(listedInQueue.attribution.reason), /未标注归属流程/);

    const detail = s.getProposal(String(legacy.id), PROJECT);
    const again = s.listProposals(PROJECT, 'pending').find(row => row.id === legacy.id);
    assert.ok(again, '未归属候选必须能被列出');
    assert.ok(again.attribution, '列表必须报告归属字段');
    assert.deepEqual(detail.attribution.workflowId, again.attribution.workflowId, '同一行的两个读取路径必须给出同一个归属');
    assert.deepEqual(detail.attribution.stageId, again.attribution.stageId);
    assert.equal(detail.attribution.resolved, again.attribution.resolved, '列表与详情不得对同一行的归属给出不同判定');

    // The workflow named here does not exist and is not created for it: the claim is
    // kept verbatim so a reviewer can see what was asserted, the location is reported
    // as unconfirmed, and the candidate is still queued like any other. This runs
    // while the library still holds no workflow at all, which is the measured state
    // the whole mechanism failed in.
    const named = submit(s, '声明了一个不存在的流程的候选。', { workflowId: 'ghost' });
    const namedRow = s.listProposals(PROJECT, 'pending').find(row => row.id === named.id);
    // The list keeps the three fields its existing callers assert on; the queue is
    // where the sentence explaining "unattributed, and adoption does not depend on it"
    // travels, because the queue is the surface a person reads while deciding.
    assert.deepEqual(namedRow?.attribution, { workflowId: 'ghost', stageId: null, resolved: false });
    const namedQueued = queueItem(s, String(named.id));
    assert.ok(namedQueued, '声明了未知流程的候选仍必须出现在队列里');
    assert.equal(namedQueued.attribution.described, true, '有判定就必须如实报告有判定');
    assert.equal(namedQueued.attribution.resolved, false);
    assert.match(String(namedQueued.attribution.reason), /ghost/, '必须点名那个找不到的流程');
    assert.match(String(namedQueued.attribution.reason), /采纳不依赖它/, '必须说清采纳不等这条信息');
    const namedDetail = s.getProposal(String(named.id), PROJECT);
    assert.deepEqual(namedDetail.attribution, namedRow?.attribution, '列表与详情对同一行必须给出同一个归属判定');
    assert.equal(workflows(), 0, '说了不存在的流程也不得为此新建流程');

    // Then, only because this test now needs one to exist, a real workflow is brought
    // in — by import, i.e. the same act that would have to create it. Still-counted
    // workflows prove nothing below synthesised one.
    const beforeAdoption = s.revision;
    s.import([flow('flow-with-steps')]);
    assert.equal(workflows(), 1, '流程只能被显式导入，不能由候选带出来');
    const located = submit(s, '已定位的候选。', { workflowId: 'flow-with-steps', stageId: 'apply', baseRevision: 1 });
    const locatedRow = s.listProposals(PROJECT, 'pending').find(row => row.id === located.id);
    assert.deepEqual(locatedRow?.attribution, { workflowId: 'flow-with-steps', stageId: 'apply', resolved: true });
    const locatedQueued = queueItem(s, String(located.id));
    assert.ok(locatedQueued, '已定位的候选同样在队列里');
    assert.equal(locatedQueued.attribution.described, true);
    assert.equal(locatedQueued.attribution.reason, null, '已定位的候选没有需要解释的缺口');
    assert.equal(located.review?.tier, 'review', '有归属也不改变人工审核档位');
    const locatedDetail = s.getProposal(String(located.id), PROJECT);
    assert.deepEqual(locatedDetail.attribution, locatedRow?.attribution, '已定位的行两个读取路径也必须一致');
    assert.equal(workflows(), 1, '定位成功不额外产生流程');
    assert.equal(s.revision, beforeAdoption + 1, '只有被采纳的经验推进知识版本');
  } finally { s.close(); }
});
