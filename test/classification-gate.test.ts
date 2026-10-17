import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store, CLASSIFIER_VERSION, classificationApprovalGate } from '../src/store.js';
import { createCoreServer } from '../src/server.js';

/**
 * B1 (the review gate is enforced by the server) and B2 (existing candidates are
 * reclassified).
 *
 * What these pin down, and why each one exists:
 *
 *  - **Three entry points, one rule.** The adapter path, the web page's single approval
 *    and its batch approval all have to end at the same verdict. Before this change the
 *    gate lived inside one client and was absent from the other two, so "an experience is
 *    not promoted into a rule by one click" held for exactly one door.
 *  - **Missing is not consent.** The two boundary tests are the load-bearing ones: a
 *    snapshot with no `autoPromotable` field must still require a person, and an explicit
 *    acknowledgement must still let the candidate through. A test suite that only proved
 *    "blocked candidates are refused" would pass just as well if the gate had been turned
 *    into a blanket refusal, and the next reader could not tell the two apart.
 *  - **The backfill is reversible, idempotent and narrow.** Dry run writes nothing, a
 *    second run reports everything as skipped, and only `pending` rows move.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { entryFromClassification, buildPanelAdminParams } = await import(
  pathToFileURL(join(repoRoot, 'adapters', 'dsh', 'index.mjs')).href
) as {
  entryFromClassification: (payload: unknown, projectId: string, proposalId: string) => Record<string, unknown> | null;
  buildPanelAdminParams: (
    action: string,
    body: Record<string, unknown>,
    config: Record<string, unknown>,
    admin: { post: (path: string, body: Record<string, unknown>) => Promise<Record<string, unknown>> },
  ) => Promise<Record<string, unknown>>;
};
const { createClient } = await import(
  pathToFileURL(join(repoRoot, 'adapters', 'dsh', 'core-client.mjs')).href
) as {
  createClient: (config: { endpoint: string; token: string; projectId: string }) => {
    post: (path: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
};

const token = 'a'.repeat(64);
const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'amb-classification-gate-'));
  dirs.push(dir);
  return dir;
}
process.on('exit', () => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

async function core() {
  const store = new Store(':memory:', () => 1000);
  const server = createCoreServer(store, {
    protocolVersion: 1, port: 47631,
    clients: [{ id: 'admin', token, projectId: 'p0', role: 'admin' }],
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    store.close();
  };
  return { origin, store, close };
}

const post = (origin: string, path: string, body: Record<string, unknown>) =>
  fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-amb-protocol': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'p0', ...body }),
  });

async function submit(origin: string, discovery: string, key: string): Promise<string> {
  const res = await post(origin, '/v1/proposals', { idempotencyKey: key, discovery });
  assert.equal(res.status, 200, '候选提交应成功');
  return (await res.json() as { id: string }).id;
}

/**
 * Rewrite a stored classification, which is how the two states under test are produced.
 *
 * The point of B1 is a snapshot written by an *older* build, so it cannot be produced by
 * submitting text: every submission now carries a verdict the current classifier computed.
 * These are the two shapes that exist in a real library — a verdict with an explicit `false`
 * and a verdict with no `autoPromotable` field at all — plus the ordinary promotable one.
 */
function storedClassification(store: Store, id: string): Record<string, unknown> {
  const payload = storedPayload(store, id);
  assert.ok(payload.classification, '候选必须有分类快照');
  return payload.classification as Record<string, unknown>;
}
function storedPayload(store: Store, id: string): Record<string, unknown> {
  const row = store.db.prepare('SELECT payload FROM proposals WHERE id=?').get(id) as { payload: string };
  return JSON.parse(row.payload) as Record<string, unknown>;
}
function rewriteStoredClassification(store: Store, id: string, classification: Record<string, unknown>): void {
  const row = store.db.prepare('SELECT payload FROM proposals WHERE id=?').get(id) as { payload: string };
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  payload.classification = classification;
  store.db.prepare('UPDATE proposals SET payload=? WHERE id=?').run(JSON.stringify(payload), id);
}

/** A verdict from an older classifier: it has kind/scope, and no `autoPromotable`. */
const LEGACY_NORM = { kind: 'norm', scope: 'project', relation: 'new', confidence: 0.71, reasoning: '旧版判定' };
/** A verdict that explicitly declines to promote itself. */
const BLOCKED_NORM = {
  kind: 'norm', scope: 'project', relation: 'new', confidence: 0.71,
  autoPromotable: false,
  promotionBlockedReason: 'provenance=agent：插件自身的推断不足以升格为参与门禁判定的硬规范，需人工显式确认',
};
/** A verdict that may promote itself. */
const PROMOTABLE_MEMORY = { kind: 'memory', scope: 'project', relation: 'new', confidence: 0.7, autoPromotable: true };

const entryFor = (id: string) => ({
  id, kind: 'memory', title: '门禁测试条目', body: '正文', scope: { kind: 'project', projectId: 'p0' },
  baseRevision: 0, labels: ['approved'], provenance: 'user', evidence: 'verifiable', platforms: [],
});

/**
 * The page's single-approval entry point.
 *
 * It is driven the way the page drives it — the core's own verdict is read first, then the
 * approval is sent — because the page's decision to ask a person is the core's answer, not
 * a rule of its own. Two approvals per case: the one without the acknowledgement has to be
 * refused with a readable reason, and the one with it has to succeed.
 */
test('B1 网页单条：判定不能自证的候选被服务端拒绝，说明原因与做法，人工确认后可采纳', async () => {
  const { origin, store, close } = await core();
  try {
    const id = await submit(origin, '旧版判定器写下的一条规范候选，快照里没有 autoPromotable 字段。', 'gate-single-1');
    rewriteStoredClassification(store, id, LEGACY_NORM);

    const refused = await post(origin, '/v1/proposals/approve', { id, entry: entryFor(id) });
    assert.equal(refused.status, 409, '缺字段时不得采纳');
    const body = await refused.json() as {
      code: string; message: string; requiredField: string;
      classificationGate: { required: boolean; kind: string; autoPromotable: boolean | null };
    };
    assert.equal(body.code, 'classification_confirmation_required', '必须有稳定可判定的错误码');
    assert.equal(body.requiredField, 'classificationAcknowledged', '必须点名要补哪个字段');
    assert.equal(body.classificationGate.required, true);
    assert.equal(body.classificationGate.kind, 'norm', '拒绝响应要带上被读到的判定');
    assert.equal(body.classificationGate.autoPromotable, null, '缺失就是缺失，不能写成 false 冒充一个判定');
    assert.match(body.message, /旧版本判定器/, '必须说明为什么需要确认');
    assert.match(body.message, /classificationAcknowledged/, '必须说明怎么做');
    assert.equal(store.getProposal(id, 'p0').state, 'pending', '被拒的候选必须留在待审队列里');

    const ok = await post(origin, '/v1/proposals/approve', {
      id, entry: entryFor(id), classificationAcknowledged: true,
    });
    assert.equal(ok.status, 200, '人工确认后必须能正常采纳');
    assert.equal(store.getProposal(id, 'p0').state, 'approved');
  } finally { await close(); }
});

test('B1 网页批量：批中混有需确认项时整批拒绝并给出条数与理由，一条都不静默写入', async () => {
  const { origin, store, close } = await core();
  try {
    const legacyId = await submit(origin, '批量里的存量候选（旧版判定器）。', 'gate-batch-legacy');
    rewriteStoredClassification(store, legacyId, LEGACY_NORM);
    const plainId = await submit(origin, '批量里的新候选（判定可自动升格）。', 'gate-batch-plain');
    rewriteStoredClassification(store, plainId, PROMOTABLE_MEMORY);
    const entries = { [legacyId]: entryFor(legacyId), [plainId]: entryFor(plainId) };

    const refused = await post(origin, '/v1/proposals/batch', {
      action: 'approve', ids: [legacyId, plainId], entries,
    });
    assert.equal(refused.status, 409, '混批不得静默整批提交');
    const body = await refused.json() as {
      code: string; message: string; count: number; proposals: Array<{ id: string; reason: string }>;
    };
    assert.equal(body.code, 'classification_confirmation_required');
    assert.equal(body.count, 1, '必须告知有几条需要确认');
    assert.deepEqual(body.proposals.map(item => item.id), [legacyId]);
    assert.match(body.proposals[0]!.reason, /旧版本判定器/);
    assert.match(body.message, /1 条/, '错误文本本身要说出条数');
    assert.equal(store.getProposal(legacyId, 'p0').state, 'pending');
    assert.equal(store.getProposal(plainId, 'p0').state, 'pending', '整批未执行：不需要确认的那条也不得被写入');

    const confirmed = await post(origin, '/v1/proposals/batch', {
      action: 'approve', ids: [legacyId, plainId], entries, classificationAcknowledged: true,
    });
    assert.equal(confirmed.status, 200);
    const applied = (await confirmed.json() as { applied: string[] }).applied;
    assert.deepEqual(applied.slice().sort(), [legacyId, plainId].sort());

    // 不改变既有行为：批里没有需确认的候选时，原请求照旧通过。
    const plainOnly = await submit(origin, '只含可自动升格候选的一批。', 'gate-batch-plain-2');
    rewriteStoredClassification(store, plainOnly, PROMOTABLE_MEMORY);
    const untouched = await post(origin, '/v1/proposals/batch', {
      action: 'approve', ids: [plainOnly], entries: { [plainOnly]: entryFor(plainOnly) },
    });
    assert.equal(untouched.status, 200, '不需要确认的批量必须和以前一样直接通过');
  } finally { await close(); }
});

test('B1 适配器路径：一键采纳依赖核心判定，核心的拒绝与理由都能回到适配器', async () => {
  const { origin, store, close } = await core();
  try {
    const id = await submit(origin, '适配器面板里的存量候选（旧版判定器）。', 'gate-adapter-1');
    rewriteStoredClassification(store, id, LEGACY_NORM);
    const admin = createClient({ endpoint: origin, token, projectId: 'p0' });

    const detail = await admin.post('/v1/proposals/get', { projectId: 'p0', id }) as {
      payload: Record<string, unknown>; classificationGate: { required: boolean; reason: string };
    };
    assert.equal(detail.classificationGate.required, true, '读取详情时就该知道这条要人工确认');
    assert.match(detail.classificationGate.reason, /旧版本判定器/);

    // 适配器不再自己发明判定：核心说需要人，就不构造条目。
    assert.equal(entryFromClassification({ ...detail.payload, classificationGate: detail.classificationGate }, 'p0', id), null);
    // 没有 gate（更旧的核心）时，规则相同：只有明确 true 才放行，缺失不放行。
    assert.equal(entryFromClassification(detail.payload, 'p0', id), null);
    assert.ok(
      entryFromClassification({ ...detail.payload, classification: PROMOTABLE_MEMORY }, 'p0', id),
      '明确可升格的候选仍应一键采纳',
    );

    // 面板路径：服务端是权威关卡，它的中文理由必须能到达适配器（而不是只剩一个状态码）。
    await assert.rejects(
      () => admin.post('/v1/proposals/approve', { projectId: 'p0', id, entry: entryFor(id) }),
      (error: { code?: string; message?: string }) => {
        assert.equal(error.code, 'classification_confirmation_required');
        assert.match(String(error.message), /旧版本判定器/, '服务端给出的原因要随拒绝一起回来');
        return true;
      },
    );
    // 面板的合成路径在服务端判定"需要人"时也必须给出可读理由而不是"没有分类"。
    await assert.rejects(
      () => buildPanelAdminParams('proposal-approve', { id, projectId: 'p0' }, { projectId: 'p0' }, admin),
      (error: Error) => {
        assert.match(error.message, /旧版本判定器/);
        return true;
      },
    );

    const confirmed = await admin.post('/v1/proposals/approve', {
      projectId: 'p0', id, entry: entryFor(id), classificationAcknowledged: true,
    });
    assert.ok(Number(confirmed.knowledgeRevision) >= 1, '确认后适配器路径必须能采纳');
  } finally { await close(); }
});

/**
 * The two boundaries, at the layer that decides them.
 *
 * Written against `store.approveProposal` on purpose: an HTTP-only test would still pass if
 * the store had been left open, and the store is where "no field means no approval" has to
 * be true.
 */
test('B1 边界：字段缺失与显式 false 都必须人工确认，显式 true 不受影响（不是一刀切禁掉）', () => {
  const store = new Store(':memory:', () => 1000);
  try {
    const submitCandidate = (key: string, text: string) =>
      store.submit('agent', { idempotencyKey: key, projectId: 'p0', discovery: text }).id;

    // 纯函数层：三种判定的读法。
    assert.equal(classificationApprovalGate(undefined).required, true, '没有判定不得视为放行');
    assert.equal(classificationApprovalGate(LEGACY_NORM).required, true, '缺 autoPromotable 必须要求确认');
    assert.match(classificationApprovalGate(LEGACY_NORM).reason, /旧版本判定器/);
    assert.equal(classificationApprovalGate(BLOCKED_NORM).required, true);
    assert.equal(classificationApprovalGate(BLOCKED_NORM).reason, BLOCKED_NORM.promotionBlockedReason, 'false 时必须引用记录下来的理由');
    assert.equal(classificationApprovalGate(PROMOTABLE_MEMORY).required, false, '显式 true 行为不变');
    assert.equal(classificationApprovalGate(PROMOTABLE_MEMORY).code, null);

    // 写入层：三种判定各自的结局。
    const missing = submitCandidate('gate-boundary-missing', '缺失判定的候选。');
    rewriteStoredClassification(store, missing, LEGACY_NORM);
    assert.throws(
      () => store.approveProposal(missing, entryFor('gate-boundary-entry-1') as never, { projectId: 'p0' }),
      (error: { code?: string; status?: number; message?: string }) => {
        assert.equal(error.code, 'classification_confirmation_required');
        assert.equal(error.status, 409);
        assert.match(String(error.message), /旧版本判定器/);
        return true;
      },
    );
    assert.equal(store.approveProposal(missing, entryFor('gate-boundary-entry-1') as never, {
      projectId: 'p0', classificationAcknowledged: true,
    }) >= 1, true, '确认后写入层必须放行');

    const blocked = submitCandidate('gate-boundary-blocked', '显式不得升格的候选。');
    rewriteStoredClassification(store, blocked, BLOCKED_NORM);
    assert.throws(
      () => store.approveProposal(blocked, entryFor('gate-boundary-entry-2') as never, { projectId: 'p0' }),
      (error: { code?: string }) => error.code === 'classification_confirmation_required',
    );
    assert.equal(store.approveProposal(blocked, entryFor('gate-boundary-entry-2') as never, {
      projectId: 'p0', classificationAcknowledged: true,
    }) >= 1, true, '确认后豁免的是"缺一次确认"，不是"禁掉这个候选"');

    const promotable = submitCandidate('gate-boundary-promotable', '可自动升格的候选。');
    rewriteStoredClassification(store, promotable, PROMOTABLE_MEMORY);
    assert.equal(store.approveProposal(promotable, entryFor('gate-boundary-entry-3') as never, { projectId: 'p0' }) >= 1,
      true, '可自动升格的候选必须仍然一键通过');
  } finally { store.close(); }
});

/**
 * B2's three properties.
 *
 * The library is built so that the report has something to report: two stale `norm`
 * snapshots plus one verdict already stamped by the current classifier, and one adopted
 * candidate that must not move.
 */
function backfillLibrary(store: Store) {
  const stale = (key: string, text: string) => {
    const id = store.submit('agent', { idempotencyKey: key, projectId: 'p0', discovery: text }).id;
    rewriteStoredClassification(store, id, LEGACY_NORM);
    return id;
  };
  const first = stale('reclassify-stale-1', '实测发现打包时必须先清空 dist 目录，否则上一次的 .js 会被一起带上。');
  const second = stale('reclassify-stale-2', '接入第三方网关时如何判定卡在凭据还是区域策略——实测判据与清单。');
  const current = store.submit('agent', {
    idempotencyKey: 'reclassify-current', projectId: 'p0', discovery: '这条提交时的判定已由当前判定器写下。',
  }).id;
  const adopted = stale('reclassify-adopted', '这条已经被采纳，判定不该再被回填。');
  store.approveProposal(adopted, entryFor('reclassify-adopted-entry') as never, {
    projectId: 'p0', classificationAcknowledged: true,
  });
  const archived = stale('reclassify-archived', '这条已归档，判定不该再被回填。');
  store.archiveProposal(archived, { projectId: 'p0' });
  return { first, second, current, adopted, archived };
}

test('B2 dry-run：给出 before/after 分布与变化明细，且一个字节都不写', () => {
  const store = new Store(':memory:', () => 1000);
  try {
    const ids = backfillLibrary(store);
    const beforeSnapshot = ids.adopted && storedClassification(store, ids.first);
    const report = store.reclassifyPending('p0', {});

    assert.equal(report.applied, false, '默认必须是 dry-run');
    assert.equal(report.classifierVersion, CLASSIFIER_VERSION);
    assert.equal(report.scanned, 3, '只扫描 pending：已采纳与已归档的不在范围内');
    assert.equal(report.changed, 2, '两条旧版判定需要回填');
    assert.equal(report.before.norm, 2, '回填前有两条得标为规范，这正是问题本身');
    assert.ok((report.after.norm ?? 0) < 2, '回填后不该还是两条规范');
    assert.equal(report.beforeAutoPromotable.missing, 2, '旧版判定就是"缺字段"那两条');
    assert.ok(report.changes.length >= 1, '必须给出前若干条变化明细');
    assert.deepEqual(
      report.changes.map(change => change.id).slice().sort(),
      [ids.first, ids.second].sort(),
      '变化明细必须是那两条 norm → memory 的行',
    );
    assert.equal(report.changes[0]!.from, 'norm');
    assert.notEqual(report.changes[0]!.to, 'norm');

    assert.deepEqual(storedClassification(store, ids.first), beforeSnapshot, 'dry-run 之后判定必须原样不动');
    assert.deepEqual(storedClassification(store, ids.second), LEGACY_NORM, 'dry-run 之后判定必须原样不动');
  } finally { store.close(); }
});

test('B2 apply：写入新判定与 classifierVersion；重跑 dry-run 全部跳过（幂等）', () => {
  const store = new Store(':memory:', () => 1000);
  try {
    const ids = backfillLibrary(store);
    const applied = store.reclassifyPending('p0', { apply: true });
    assert.equal(applied.applied, true);
    assert.equal(applied.changed, 2);

    for (const id of [ids.first, ids.second]) {
      const stored = storedClassification(store, id);
      assert.notEqual(stored.kind, 'norm', `${id} 的判定必须被重算`);
      assert.equal(stored.classifierVersion, CLASSIFIER_VERSION, '判定必须记下来自哪一版判定器');
      assert.equal(typeof stored.textDigest, 'string', '必须记下判定依据的文本摘要');
      const payload = storedPayload(store, id);
      assert.equal((payload.classificationPrevious as { kind?: string }).kind, 'norm', '被替换的旧判定必须留下可查的痕迹');
      assert.equal(
        (payload.classificationPrevious as { replacedAt?: number }).replacedAt, 1000,
        '替换记录必须写明时间，判定出自哪一版才可查',
      );
    }

    // 幂等：第二次运行不该再改动任何一行，并如实报告"全部跳过"。
    const rerun = store.reclassifyPending('p0', {});
    assert.equal(rerun.scanned, 3);
    assert.equal(rerun.changed, 0, '判定器版本与文本都没变时必须跳过');
    assert.equal(rerun.skipped, 3, '重跑应报告全部跳过');
    assert.equal(rerun.changes.length, 0);
    const secondApply = store.reclassifyPending('p0', { apply: true });
    assert.equal(secondApply.changed, 0, '再次 apply 也不得写任何东西');
  } finally { store.close(); }
});

test('B2 只重算 pending：已采纳、已归档候选的判定、state 与 discovery 一律不动', () => {
  const store = new Store(':memory:', () => 1000);
  try {
    const ids = backfillLibrary(store);
    const before = (id: string) => {
      const row = store.db.prepare('SELECT payload,state FROM proposals WHERE id=?').get(id) as { payload: string; state: string };
      return { payload: row.payload, state: row.state };
    };
    const adoptedBefore = before(ids.adopted);
    const archivedBefore = before(ids.archived);
    const pendingBefore = before(ids.first);

    store.reclassifyPending('p0', { apply: true });

    assert.deepEqual(before(ids.adopted), adoptedBefore, '已采纳候选一个字都不能动');
    assert.deepEqual(before(ids.archived), archivedBefore, '已归档候选一个字都不能动');
    const pendingAfter = before(ids.first);
    assert.equal(pendingAfter.state, pendingBefore.state, 'state 必须不变');
    const parsed = JSON.parse(pendingAfter.payload) as { discovery?: string };
    const parsedBefore = JSON.parse(pendingBefore.payload) as { discovery?: string };
    assert.equal(parsed.discovery, parsedBefore.discovery, 'discovery 必须不变');
    assert.notDeepEqual(
      JSON.parse(pendingAfter.payload).classification,
      JSON.parse(pendingBefore.payload).classification,
      'pending 候选的判定字段必须被重算',
    );
  } finally { store.close(); }
});

test('B2 CLI 入口：默认 dry-run 不写库，--yes 才写，重跑报告全部跳过', () => {
  const dir = tempDir();
  /**
   * The real clock, unlike the in-memory fixtures above.
   *
   * This library is opened by a second process (the CLI), and opening a store runs the
   * expiry rule: a candidate stamped in 1970 — which is what the fixed test clock produces
   * — is already past its review window and never appears as pending.
   */
  const store = new Store(join(dir, 'knowledge.sqlite'));
  let id: string;
  try {
    id = store.submit('agent', {
      idempotencyKey: 'reclassify-cli-1', projectId: 'p0',
      discovery: '实测发现打包时必须先清空 dist 目录，否则上一次的 .js 会被一起带上。',
    }).id;
    rewriteStoredClassification(store, id, LEGACY_NORM);
  } finally { store.close(); }

  const cli = join(repoRoot, 'dist', 'src', 'cli.js');
  const run = (extra: string[]) => {
    const result = spawnSync(process.execPath,
      [cli, 'reclassify', '--data-dir', dir, '--project', 'p0', '--json', ...extra],
      { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, `reclassify 必须成功退出：${result.stderr}`);
    return JSON.parse(result.stdout) as {
      applied: boolean; scanned: number; changed: number; skipped: number;
      before: Record<string, number>; after: Record<string, number>;
    };
  };

  const dry = run([]);
  assert.equal(dry.applied, false, '默认必须是预演');
  assert.equal(dry.scanned, 1);
  assert.equal(dry.changed, 1);
  assert.equal(dry.before.norm, 1);
  const afterDry = new Store(join(dir, 'knowledge.sqlite'));
  try {
    assert.deepEqual(storedClassification(afterDry, id), LEGACY_NORM, '预演之后库里必须还是旧判定');
  } finally { afterDry.close(); }

  const applied = run(['--yes']);
  assert.equal(applied.applied, true);
  assert.equal(applied.changed, 1);

  const rerun = run([]);
  assert.equal(rerun.changed, 0);
  assert.equal(rerun.skipped, 1, '幂等证据：重跑一次 dry-run 报告全部跳过');
});
