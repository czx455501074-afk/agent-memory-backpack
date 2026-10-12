/**
 * R0 data-layer verification harness (F01-F09, F15, F18, F19, F21, F23).
 *
 * Isolated on purpose: an in-memory SQLite authority (never ~/.agent-memory-backpack),
 * a loopback server on an ephemeral port, an injected clock so a ninety-day expiry is
 * asserted in milliseconds. Each case prints PASS/FAIL with the observed value, so the
 * same script documents the defect before the fix and its absence afterwards.
 *
 * Run: npm run build && node scripts/verify-data-layer-r0.mjs
 */
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../dist/src/store.js';
import { createCoreServer } from '../dist/src/server.js';
import { exportAll, importAll } from '../dist/src/backup.js';

const results = [];
const record = (id, detail) => { results.push({ id, ...detail }); };
async function check(id, what, body) {
  try { const detail = await body(); record(id, { status: 'PASS', what, ...(detail ?? {}) }); }
  catch (error) { record(id, { status: 'FAIL', what, error: String(error && error.message ? error.message : error).slice(0, 300) }); }
}

const DAY = 86_400_000;
const clock = { now: Date.UTC(2026, 0, 1) };
const out = resolve('.local/r0-datalayer');
mkdirSync(out, { recursive: true });

const tokens = {
  alphaAdapter: randomBytes(32).toString('hex'),
  alphaAdmin: randomBytes(32).toString('hex'),
  betaAdapter: randomBytes(32).toString('hex'),
};

const norm = (id, body, projectId, extra = {}) => ({
  id, kind: 'norm', title: `规范 ${id}`, scope: projectId ? { kind: 'project', projectId } : { kind: 'global' },
  baseRevision: 0, body, deniedTools: [], hostProvided: false, ...extra,
});
const memory = (id, body, projectId) => ({
  id, kind: 'memory', title: `记忆 ${id}`,
  scope: projectId ? { kind: 'project', projectId } : { kind: 'global' }, baseRevision: 0, body,
});
const skill = (id, projectId) => ({
  id, kind: 'skill', title: `技能 ${id}`, scope: { kind: 'project', projectId }, baseRevision: 0,
  body: '原始技能正文。', leaves: [{ path: 'references/leaf.md', hash: 'h', body: '叶子正文' }], needsStructure: true,
});
const workflow = (id, projectId, baseRevision = 0) => ({
  id, kind: 'workflow', title: `流程 ${id}`, scope: { kind: 'project', projectId }, baseRevision,
  overview: '审计流程。', triggers: ['审计'], categories: [['审计']], preconditions: ['已就绪'],
  stages: [{ id: 's', title: '步骤', instructions: '执行。', checks: ['检查'], dependencies: [] }],
  completion: ['完成'], recovery: '停止。',
});

const store = new Store(':memory:', () => clock.now);
store.import([norm('beta-norm', 'BETA RULE PRIVATE-REASON EVIDENCE', 'beta')]);
store.import([norm('beta-norm-2', 'BETA SECOND RULE', 'beta')]);
store.import([memory('beta-memory', 'BETA PRIVATE MEMORY', 'beta')]);
store.import([skill('beta-skill', 'beta')]);
store.import([memory('global-entry', 'ORIGINAL GLOBAL', null)]);
store.import([workflow('alpha-flow', 'alpha')]);
store.recordTask('beta', { id: 'beta-task', title: 'beta 任务', status: 'in_progress' });
store.recordTask('beta', { id: 'f06-task', title: '终态任务', status: 'completed', summary: '已完成', verified: '旧验证说明' });
const betaProposal = store.submit('beta-adapter', { idempotencyKey: 'beta-candidate', projectId: 'beta', discovery: 'beta 的候选经验。' });
store.supersede({ oldId: 'beta-norm-2', newId: 'beta-norm', action: 'supplement', reason: '审计链路', evidence: '审计', origin: 'agent' });

const server = createCoreServer(store, {
  protocolVersion: 1, port: 47631,
  clients: [
    { id: 'codex', token: tokens.alphaAdapter, projectId: 'alpha', role: 'adapter' },
    { id: 'dsh', token: tokens.betaAdapter, projectId: 'beta', role: 'adapter' },
    { id: 'admin', token: tokens.alphaAdmin, projectId: 'alpha', role: 'admin' },
  ],
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const endpoint = `http://127.0.0.1:${server.address().port}`;
const post = async (path, body, credential, projectId = 'alpha') => {
  const response = await fetch(endpoint + path, {
    method: 'POST',
    headers: { authorization: `Bearer ${credential}`, 'x-amb-protocol': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, ...body }),
  });
  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /* keep empty */ }
  return { status: response.status, data };
};
const A = (path, body, projectId = 'alpha') => post(path, body, tokens.alphaAdapter, projectId);
const ADMIN = (path, body, projectId = 'alpha') => post(path, body, tokens.alphaAdmin, projectId);
const B = (path, body, projectId = 'beta') => post(path, body, tokens.betaAdapter, projectId);

try {
  // ------------------------------------------------------------------ F01
  await check('F01-material-scope', 'adapter 保存的资料不得成为全局、且来源不得自称 user', async () => {
    const saved = await A('/v1/material/save', {
      id: 'f01-mat', title: 'ALPHA MATERIAL', url: 'https://example.invalid/f01',
      summary: 'F01-SUMMARY', body: 'F01-ALPHA-BODY', provenance: 'user',
    });
    assert.equal(saved.status, 200, `保存应成功，实际 ${saved.status}`);
    const foreign = await B('/v1/knowledge/get', { id: 'f01-mat' });
    assert.notEqual(foreign.status, 200, `beta 不得读到 alpha 资料正文，实际 ${foreign.status}`);
    const search = await B('/v1/knowledge/search-universal', { query: 'F01-ALPHA-BODY' });
    assert.equal(JSON.stringify(search.data).includes('F01-ALPHA-BODY'), false, '跨项目检索不得出现他项目资料正文');
    const own = await A('/v1/knowledge/get', { id: 'f01-mat' });
    assert.equal(own.status, 200, '本项目必须仍能读到自己的资料');
    assert.notEqual(own.data.content.provenance, 'user', 'adapter 提交的资料不得自称 user');
    return { storedProvenance: own.data.content.provenance, scope: own.data.content.scope };
  });

  // ------------------------------------------------------------------ F02
  await check('F02-history-scope', '历史/待结构化入口必须按项目过滤', async () => {
    const recent = await A('/v1/history/recent', {});
    assert.equal(recent.status, 200);
    assert.equal(JSON.stringify(recent.data).includes('beta-norm'), false, 'history/recent 泄露他项目条目');
    const history = await A('/v1/knowledge/history', { knowledgeId: 'beta-norm' });
    assert.notEqual(history.status, 200, `跨项目 history 必须失败，实际 ${history.status}`);
    const unstructured = await A('/v1/knowledge/unstructured', {});
    assert.equal(JSON.stringify(unstructured.data).includes('beta-skill'), false, 'unstructured 泄露他项目技能');
    const chain = store.supersessions(undefined, 'alpha');
    assert.equal(chain.length, 0, `本项目的替代链应为空，实际 ${chain.length}`);
    return { recentEntries: recent.data.history.length, historyStatus: history.status };
  });

  // ------------------------------------------------------------------ F03
  await check('F03-object-ownership', '按 id 的单审/续期/写删必须校验对象归属', async () => {
    const approve = await ADMIN('/v1/proposals/approve', {
      id: betaProposal.id, entry: memory('f03-made', '写给他人的条目', 'alpha'),
    });
    assert.notEqual(approve.status, 200, `alpha admin 不得批准 beta 提案，实际 ${approve.status}`);
    const reject = await ADMIN('/v1/proposals/reject', { id: betaProposal.id });
    assert.notEqual(reject.status, 200, `alpha admin 不得拒收 beta 提案，实际 ${reject.status}`);
    const evidence = await ADMIN('/v1/proposals/request-evidence', { id: betaProposal.id, reason: '越权' });
    assert.notEqual(evidence.status, 200, `alpha admin 不得挂起 beta 提案，实际 ${evidence.status}`);
    const archive = await ADMIN('/v1/proposals/archive', { id: betaProposal.id });
    assert.notEqual(archive.status, 200, `alpha admin 不得归档 beta 提案，实际 ${archive.status}`);
    assert.equal(store.listProposals('beta', 'pending').length, 1, 'beta 提案必须保持原状');

    const write = await ADMIN('/v1/knowledge/write', { entry: memory('f03-beta', '写给 beta', 'beta') });
    assert.notEqual(write.status, 200, `不得写入他项目作用域条目，实际 ${write.status}`);
    // An adapter may not widen anything to global; only the human's admin credential
    // is an explicit enough decision for a rule that applies everywhere.
    const adapterGlobal = await A('/v1/knowledge/write', { entry: memory('f03-global', '擅自提权为全局', null) });
    assert.notEqual(adapterGlobal.status, 200, `适配器不得经 /v1/knowledge/write 提权为全局，实际 ${adapterGlobal.status}`);
    const del = await ADMIN('/v1/knowledge/delete', { id: 'beta-memory' });
    assert.notEqual(del.status, 200, `不得删除他项目条目，实际 ${del.status}`);
    const renew = await ADMIN('/v1/material/renew', { id: 'beta-material', reason: '越权续期' });
    assert.notEqual(renew.status, 200, `不得续期他项目资料，实际 ${renew.status}`);

    // The `wasGlobal` branch must not become a laundering channel.
    const globalProposal = store.submit('alpha-adapter', { idempotencyKey: 'f03-global', projectId: 'beta', discovery: 'beta 的全局条目候选' });
    const launder = await ADMIN('/v1/proposals/approve', {
      id: globalProposal.id, entry: { ...memory('global-entry', 'BETA APPROVED BY ALPHA', null), baseRevision: 1 },
    });
    assert.notEqual(launder.status, 200, `alpha admin 不得改写他项目提案指向的全局条目，实际 ${launder.status}`);
    assert.equal(store.getKnowledge('beta', 'global-entry').content.body, 'ORIGINAL GLOBAL', '全局条目正文不得被越权改写');
    return { approve: approve.status, write: write.status, delete: del.status, renew: renew.status };
  });

  // ------------------------------------------------------------------ F04
  await check('F04-event-task-binding', '事件 taskId 必须属于调用方项目，日记/导出按项目过滤', async () => {
    const event = await A('/v1/events', {
      eventId: 'f04-cross', adapter: 'codex', taskId: 'beta-task', kind: 'tool_completed', summary: 'ALPHA-POLLUTES-BETA',
    });
    assert.notEqual(event.status, 200, `不得把事件写进他项目任务，实际 ${event.status}`);
    const exported = await B('/v1/tasks/export', { taskId: 'beta-task', format: 'json' });
    assert.equal(JSON.stringify(exported.data).includes('ALPHA-POLLUTES-BETA'), false, 'beta 导出不得包含他项目事件');
    const journal = await B('/v1/tasks/export', { taskId: 'beta-task', format: 'markdown' });
    assert.equal(String(journal.data.markdown).includes('ALPHA-POLLUTES-BETA'), false, 'beta 日记不得包含他项目事件');
    return { eventStatus: event.status };
  });

  // ------------------------------------------------------------------ F05
  await check('F05-task-platform-scope', 'taskId 与 platforms 必须贯穿 prepare/gate', async () => {
    store.import([{
      id: 'f05-task-norm', kind: 'norm', title: '本次任务规范', scope: { kind: 'task', projectId: 'alpha', taskId: 'task-x' },
      baseRevision: 0, body: 'F05 TASK ONLY RULE', deniedTools: ['f05-tool'], hostProvided: false,
    }]);
    store.import([{
      id: 'f05-codex-norm', kind: 'norm', title: 'codex 专用规范', scope: { kind: 'global' },
      baseRevision: 0, body: 'F05 CODEX ONLY', deniedTools: [], hostProvided: false, platforms: ['codex'],
    }]);
    const withTask = await A('/v1/prepare', { taskId: 'task-x', adapter: 'codex', query: '' });
    assert.equal(JSON.stringify(withTask.data.norms).includes('F05 TASK ONLY RULE'), true,
      `显式 taskId 必须激活任务规范，实际 ${JSON.stringify(withTask.data.norms.map(n => n.id))}`);
    const gateTask = await A('/v1/gate', { taskId: 'task-x', adapter: 'codex', toolName: 'f05-tool' });
    assert.equal(gateTask.data.decision, 'deny', `任务规范中的禁止项必须生效，实际 ${gateTask.data.decision}`);
    const gateNoTask = await A('/v1/gate', { adapter: 'codex', toolName: 'f05-tool' });
    assert.equal(gateNoTask.data.decision, 'allow', '没有任务上下文时任务规范不得生效');

    // Platform applicability, exercised against the store directly because the HTTP
    // adapter field is itself an identity the credential must match.
    const dshNorms = store.prepare('alpha', '', { platform: 'dsh' }).norms.map(n => n.id);
    const codexNorms = store.prepare('alpha', '', { platform: 'codex' }).norms.map(n => n.id);
    assert.equal(dshNorms.includes('f05-codex-norm'), false, `codex 专用规范不得进入 DSH，实际 ${JSON.stringify(dshNorms)}`);
    assert.equal(codexNorms.includes('f05-codex-norm'), true, `codex 会话应看到 codex 专用规范，实际 ${JSON.stringify(codexNorms)}`);
    assert.equal(store.gate('alpha', 'f05-tool', { taskId: 'task-x', platform: 'codex' }).decision, 'deny');
    assert.equal(store.gate('alpha', 'f05-tool', { platform: 'codex' }).decision, 'allow');
    return { taskNormInjected: true, dshNorms, codexNorms };
  });

  // ------------------------------------------------------------------ F06
  await check('F06-terminal-task', '普通 prepare 不得重开终态任务', async () => {
    // Give the session a task whose generated id it owns, then mark it completed.
    const started = store.startTaskForSession('beta', 's-f06', '终态任务');
    store.recordTask('beta', { id: started.id, title: '终态任务', status: 'completed', summary: '已完成', verified: '旧验证说明' });
    const before = store.getTask(started.id, 'beta');
    const prepared = await B('/v1/prepare', { sessionId: 's-f06', query: '再检索一次' });
    assert.equal(prepared.status, 200);
    const after = store.getTask(started.id, 'beta');
    assert.equal(after.status, 'completed', `终态任务不得被 prepare 重开，实际 ${after.status}`);
    assert.equal(after.completedAt, before.completedAt, '完成时间不得被重置');
    assert.equal(after.verified, '旧验证说明', '旧验证说明不得被清空');
    return { status: after.status, completedAt: after.completedAt, reopened: after.status !== 'completed' };
  });

  // ------------------------------------------------------------------ F07
  await check('F07-journal-basis', '日记不得把自述当成实证', async () => {
    store.recordTask('beta', {
      id: 'f07-task', title: '自述任务', status: 'completed', summary: '声称完成', verified: '我跑过测试，都通过了',
    });
    const journal = store.generateJournal('f07-task', 'beta');
    assert.notEqual(journal.evidence, 'observed', '自述的验证说明不得被标为插件观测到的实证');
    assert.equal(journal.verification.selfReported, true, '必须显式标注这是自述而无独立核验');
    assert.equal(journal.verification.events, 0, '必须如实报告本次任务绑定的事件数');
    return { outcome: journal.outcome, evidence: journal.evidence, verification: journal.verification };
  });

  // ------------------------------------------------------------------ F08
  await check('F08-ttl-read-gate', '到期资料即使清理失败也不得被任何默认读入口返回', async () => {
    const saved = await A('/v1/material/save', {
      id: 'f08-mat', title: 'EXPIRED', url: 'https://example.invalid/f08', summary: 'F08-SUMMARY', body: 'F08-PRIVATE-BODY',
    });
    assert.equal(saved.status, 200);
    clock.now += 91 * DAY;
    // Make the persistent purge fail, as an injected cleanup failure would.
    store.db.exec("CREATE TRIGGER f08_block BEFORE DELETE ON revisions WHEN OLD.id='f08-mat' BEGIN SELECT RAISE(ABORT,'injected'); END");
    const purge = await ADMIN('/v1/material/purge', {});
    assert.ok(purge.data.failed.length >= 1, `清理必须报出失败项，实际 ${JSON.stringify(purge.data)}`);
    const fetched = await A('/v1/knowledge/get', { id: 'f08-mat' });
    assert.notEqual(fetched.status, 200, `到期正文不得被 get 返回，实际 ${fetched.status}`);
    const searched = await A('/v1/knowledge/search-universal', { query: 'F08-PRIVATE-BODY' });
    assert.equal(JSON.stringify(searched.data).includes('F08-PRIVATE-BODY'), false, '到期正文不得被通用检索返回');
    const listed = await A('/v1/material/list', {});
    assert.equal(listed.data.material.length, 0, '专用列表不得返回到期资料');
    store.db.exec('DROP TRIGGER f08_block');
    // Every request runs `cleanup()` before its handler, so the retry may already
    // have been performed by that implicit pass; what matters is that the retry
    // succeeds in making the item's payload actually gone.
    const retried = await ADMIN('/v1/material/purge', {});
    assert.deepEqual(retried.data.failed, [], `重试清理不得再有失败项，实际 ${JSON.stringify(retried.data)}`);
    const rowsAfter = store.db.prepare('SELECT count(*) AS n FROM revisions WHERE id=?').get('f08-mat').n;
    const headAfter = store.db.prepare('SELECT count(*) AS n FROM knowledge WHERE id=?').get('f08-mat').n;
    const searchAfter = store.db.prepare('SELECT count(*) AS n FROM workflow_search WHERE id=?').get('f08-mat').n;
    assert.equal(rowsAfter, 0, '清理必须真删除正文修订行');
    assert.equal(headAfter, 0, '清理必须删除条目行（否则备份会因缺 head revision 而无法恢复）');
    assert.equal(searchAfter, 0, '清理必须删除检索索引行');
    assert.deepEqual(store.purgeFailures(), [], '重试成功后失败记录必须清除');
    return { getStatus: fetched.status, purgeFailures: purge.data.failed.length, retriedFailed: retried.data.failed.length };
  });

  await check('F08-backup-restore-ttl', '恢复备份前必须执行到期检查，不得让过期正文复活', async () => {
    const source = new Store(':memory:', () => clock.now);
    // Saved ninety-one days before the restoring clock, so it is already lapsed when
    // the archive is opened.
    source.saveMaterial({ id: 'f08-restore', title: 'R', url: 'https://example.invalid/r', summary: 'S', body: 'RESTORE-BODY' });
    const directory = join(mkdtempSync(join(tmpdir(), 'amb-r0-')), 'backup');
    exportAll(source, { directory });
    source.close();
    const restored = new Store(':memory:', () => clock.now + 91 * DAY);
    try {
      importAll(restored, { directory });
      const retained = restored.db.prepare('SELECT count(*) AS n FROM revisions WHERE id=?').get('f08-restore').n;
      assert.equal(retained, 0, `过期正文不得随备份复活，实际仍有 ${retained} 行修订`);
      assert.equal(restored.allEntries().some(e => e.id === 'f08-restore'), false, '过期资料不得在恢复后进入活跃库');
    } finally { restored.close(); }
    return { restoredRows: 0 };
  });

  // ------------------------------------------------------------------ F09
  await check('F09-supersede-target', '替代目标必须是 active 且可用', async () => {
    store.import([memory('f09-old', '旧条目', 'alpha')]);
    store.import([memory('f09-dead', '被退役的替代者', 'alpha')]);
    store.retire('f09-dead', 1);
    let refused = false;
    try {
      store.supersede({
        oldId: 'f09-old', newId: 'f09-dead', action: 'supersede',
        reason: '审计', evidence: '审计', origin: 'user', projectId: 'alpha',
      });
    } catch { refused = true; }
    assert.equal(refused, true, '以已退役条目作为替代目标必须被拒绝');
    assert.equal(store.history('f09-old').current?.status, 'active', '失败的替代不得让原条目退役');
    return { oldStatus: store.history('f09-old').current?.status };
  });

  // ------------------------------------------------------------------ F15
  await check('F15-approval-recompare', '审批必须重比较提案原基线', async () => {
    store.import([workflow('f15-flow', 'alpha')]);
    const proposal = store.submit('alpha-adapter', {
      idempotencyKey: 'f15', projectId: 'alpha', workflowId: 'f15-flow', baseRevision: 1, discovery: '基于版本 1 的修改',
    });
    store.import([{ ...workflow('f15-flow', 'alpha'), baseRevision: 1, overview: '并发的新版本。' }]);
    let code = null;
    try {
      store.approveProposal(String(proposal.id), { ...workflow('f15-flow', 'alpha', 2), overview: '基于旧基线批准的修改。' });
    } catch (error) { code = error.code; }
    assert.equal(code, 'revision_conflict', `旧基线提案不得被批准，实际 ${code}`);
    assert.equal(store.listProposals('alpha')[0].payload.baseRevision, 1, '原基线必须保留在记录中');
    return { code };
  });

  // ------------------------------------------------------------------ F18
  await check('F18-supplement-visible', '补充关系在读取时可见，语义判定接入生产链路', async () => {
    store.import([memory('f18-base', '基础做法', 'alpha')]);
    store.import([memory('f18-extra', '补充做法', 'alpha')]);
    const before = store.revision;
    store.supersede({
      oldId: 'f18-base', newId: 'f18-extra', action: 'supplement',
      reason: '补充不是矛盾', evidence: '审计', origin: 'user', projectId: 'alpha',
    });
    assert.ok(store.revision > before, '补充关系必须推进知识版本，而不是静默不生效');
    const relations = store.readKnowledge('alpha', 'f18-base').relations;
    assert.ok(relations && JSON.stringify(relations).includes('f18-extra'), '读取时必须能看出补充关系');
    const submitted = store.submit('alpha-adapter', {
      idempotencyKey: 'f18-sem', projectId: 'alpha', discovery: '必须禁止使用旧导出脚本，改用新的导出流程。',
    });
    const payload = store.listProposals('alpha').find(p => p.id === submitted.id).payload;
    assert.ok(payload.classification, '候选必须记录语义判定结果，供审阅参考');
    return { relations, classification: payload.classification };
  });

  // ------------------------------------------------------------------ F19
  await check('F19-conflict-and-audit', '重要冲突不因普通期限过期；补证可重审；审批留痕', async () => {
    const conflict = store.submit('alpha-adapter', {
      idempotencyKey: 'f19-conflict', projectId: 'alpha',
      discovery: '与当前全局规范冲突：必须改用另一套导出流程，不能继续使用旧的。',
    });
    // A conflict is detected up front and held off the ordinary deadline.
    const held0 = store.listProposals('alpha').find(p => p.id === conflict.id);
    assert.equal(held0.payload.important, true, '冲突候选必须被标记为重要，而非普通待审');
    const held = store.submit('alpha-adapter', { idempotencyKey: 'f19-held', projectId: 'alpha', discovery: '结论待补证。' });
    store.requestEvidence(String(held.id), '缺少可核对结果');
    const second = store.supplementEvidence(String(held.id), '补上可核对的运行结果');
    assert.equal(second.state, 'pending', `补证后必须回到待审，实际 ${second.state}`);

    const approved = store.approveProposal(String(held.id), memory('f19-fact', '补证后的事实', 'alpha'), { actor: 'alpha-admin' });
    assert.ok(approved > 0);
    const approvedPayload = store.listProposals('alpha').find(p => p.id === held.id).payload;
    assert.equal(approvedPayload.decision.actor, 'alpha-admin', '批准必须记录操作者');
    assert.ok(Number.isFinite(approvedPayload.decision.at), '批准必须记录时间');
    const rejected = store.submit('alpha-adapter', { idempotencyKey: 'f19-reject', projectId: 'alpha', discovery: '一条被拒的候选。' });
    store.rejectProposal(String(rejected.id), { reason: '与已有规范冲突且无证据', actor: 'alpha-admin' });
    const rejectedPayload = store.listProposals('alpha').find(p => p.id === rejected.id).payload;
    assert.equal(rejectedPayload.decision.reason, '与已有规范冲突且无证据', '拒收必须记录理由');
    assert.equal(rejectedPayload.decision.actor, 'alpha-admin', '拒收必须记录操作者');

    clock.now += 31 * DAY;
    store.expireProposals();
    const conflictAfter = store.listProposals('alpha').find(p => p.id === conflict.id);
    assert.equal(conflictAfter.state, 'pending', `重要冲突不得被普通期限清空，实际 ${conflictAfter.state}`);
    assert.notEqual(conflictAfter.payload, null, '重要冲突的正文不得被清除');
    return { conflictState: conflictAfter.state, approveDecision: approvedPayload.decision, rejectDecision: rejectedPayload.decision };
  });

  // ------------------------------------------------------------------ F23
  await check('F23-norm-budget', '规范总量受预算约束、超预算可见、判定不丢禁止项', async () => {
    clock.now += DAY;
    const big = 'F23 长篇规范正文。'.repeat(700); // ~8400 chars
    for (let index = 0; index < 40; index += 1) {
      store.import([norm(`f23-norm-${index}`, `${big}${index}`, 'alpha')]);
    }
    const prepared = await A('/v1/prepare', { query: '没有任何相关词汇的组合' });
    const budget = prepared.data.budget;
    assert.ok(budget, '必须报告预算使用情况');
    assert.ok(prepared.data.context.length <= budget.limitChars + 2000,
      `上下文必须受预算约束，实际 ${prepared.data.context.length} / ${budget.limitChars}`);
    assert.ok(budget.omitted.length > 0, '被省略的规范必须逐条列出，不得静默丢弃');
    assert.ok(budget.omitted.every(item => item.id && item.reason), '每条省略都必须给出原因');

    store.import([{
      id: 'f23-deny', kind: 'norm', title: '禁止项规范', scope: { kind: 'global' }, baseRevision: 0,
      body: 'F23 最后一条禁止项规范。', deniedTools: ['f23-tool'], hostProvided: false,
    }]);
    const gate = await A('/v1/gate', { toolName: 'f23-tool', knowledgeRevision: store.revision });
    assert.equal(gate.data.decision, 'deny', '预算不得削弱禁止项判定');
    assert.ok(gate.data.deniedTools.includes('f23-tool'), '禁止清单必须完整');
    assert.equal(gate.data.contextUnchanged, true, '同一知识版本已送过的规范不得重复整段返回');
    return { contextChars: prepared.data.context.length, limitChars: budget.limitChars, omitted: budget.omitted.length };
  });
} finally {
  server.closeAllConnections();
  await new Promise(done => server.close(done));
  store.close();
}

const summary = {
  at: new Date().toISOString(),
  counts: { pass: results.filter(r => r.status === 'PASS').length, fail: results.filter(r => r.status === 'FAIL').length },
  results,
};
writeFileSync(join(out, 'verify.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
