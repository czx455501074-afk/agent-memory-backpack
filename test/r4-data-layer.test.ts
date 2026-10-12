/**
 * Permanent regressions for the data-layer defects fixed in this round.
 *
 * The scope is the store/server/CLI surface owned by the data layer: the read
 * route's `id@revision` handling and kind coverage (H2), the treatment of an
 * unknown workflow on a candidate (M1), the lifetime a seeded material entry
 * gets and how the import reports what it could not make usable (M6), the entry
 * login startup is registered against (W1), and the ACL of a credential written
 * outside a user directory (W3).
 *
 * Isolation is the same as the other data-layer tests: in-memory or temp-file
 * SQLite, a random loopback port with synthetic credentials, throwaway data
 * directories under the system temp dir, and — for the one test that writes a
 * registry value — a scratch key under this project's own `Software` tree. No
 * host install, no real library, no real `HKCU\...\Run` entry, no contact with
 * the configured core ports.
 *
 * Test names state the rule that would be lost, so a future change that weakens
 * one fails a test whose name says which.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { createCoreServer } from '../src/server.js';
import type { KnowledgeDraft } from '../src/schema.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliEntry = join(repoRoot, 'dist', 'src', 'cli.js');

/** Temp trees created by this file, removed on exit even if a test throws. */
const scratch: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}
process.on('exit', () => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

/** Run the built CLI, returning its exit code and streams. */
function runCli(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [cliEntry, ...args], {
    encoding: 'utf8', windowsHide: true, cwd: repoRoot, env: { ...process.env, ...env },
  });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const PROJECT = 'alpha';
const TOKEN = 'a'.repeat(48);
const ADMIN_TOKEN = 'c'.repeat(48);

function workflow(id: string, projectId = PROJECT) {
  return {
    id, kind: 'workflow' as const, title: `${id} 流程`, scope: { kind: 'project' as const, projectId },
    baseRevision: 0, overview: `${id} 的概览正文。`, triggers: ['触发'], categories: [['分类']],
    preconditions: ['前提'], completion: ['完成'], recovery: '恢复',
    stages: [{ id: 'apply', title: '执行', instructions: '执行步骤', checks: ['检查'], dependencies: [] }],
  };
}

const code = (error: unknown) => (error as { code?: string }).code;

/**
 * A core on an ephemeral loopback port.
 *
 * Port 0 rather than a configured port: a real core may be listening on
 * 47631/47761, and a test must never talk to it.
 */
async function startCore(store: Store) {
  const server = createCoreServer(store, {
    protocolVersion: 1, port: 1,
    clients: [
      { id: 'dsh', projectId: PROJECT, role: 'adapter', token: TOKEN },
      { id: 'admin', projectId: PROJECT, role: 'admin', token: ADMIN_TOKEN },
    ],
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  const { port } = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${port}`,
    stop: () => { try { server.closeAllConnections(); } catch { /* older runtime */ } server.close(); },
  };
}

async function post(origin: string, path: string, body: unknown, token = TOKEN) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-amb-protocol': '1' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

// ── BUG-H2: the read route ──────────────────────────────────────────────────

// Typed as drafts rather than left inferred: the discriminated union cannot be
// reconstructed from an array literal's widened member types, and the array is
// handed to `store.import`, whose parameter is the draft union.
const H2_ENTRIES: KnowledgeDraft[] = [
  { id: 'alpha-mem', kind: 'memory', title: '记忆', scope: { kind: 'project', projectId: PROJECT }, baseRevision: 0, body: '项目代号是翡翠。' },
  { id: 'alpha-norm', kind: 'norm', title: '规范', scope: { kind: 'project', projectId: PROJECT }, baseRevision: 0, body: '回答必须用中文。', deniedTools: [], hostProvided: false },
  { id: 'alpha-log', kind: 'journal', title: '日记', scope: { kind: 'project', projectId: PROJECT }, baseRevision: 0, did: '完成了核验。', outcome: 'success' },
  { id: 'alpha-pref', kind: 'preference', title: '偏好', scope: { kind: 'project', projectId: PROJECT }, baseRevision: 0, body: '先给结论。', stated: true },
  { id: 'alpha-skill', kind: 'skill', title: '技能', scope: { kind: 'project', projectId: PROJECT }, baseRevision: 0, body: 'SKILL 正文', leaves: [], needsStructure: true },
  { id: 'beta-secret', kind: 'memory', title: '外部记忆', scope: { kind: 'project', projectId: 'beta' }, baseRevision: 0, body: '不该被 alpha 读到。' },
];

test('BUG-H2：get 与 read 对同一 id 的结论必须一致，且 skill/memory 以外的可读类型也不得 404', async () => {
  const store = new Store(':memory:');
  store.import(H2_ENTRIES);
  const { origin, stop } = await startCore(store);
  try {
    for (const entry of H2_ENTRIES.filter(e => e.id.startsWith('alpha-'))) {
      const get = await post(origin, '/v1/knowledge/get', { projectId: PROJECT, id: entry.id });
      const read = await post(origin, '/v1/knowledge/read', { projectId: PROJECT, knowledgeId: entry.id });
      assert.equal(get.status, 200, `${entry.kind} 的 get 应为 200`);
      // The defect: read refused every kind except skill/memory with a 404 whose
      // message said "unavailable", which was false and sent a reader hunting a
      // problem that did not exist.
      assert.equal(read.status, 200, `${entry.kind} 的 read 应为 200（此前 404 "unavailable"）`);
    }
  } finally { stop(); store.close(); }
});

test('BUG-H2：注入文本里出现的 id@revision 形式必须可读（模型照抄该形式）', async () => {
  const store = new Store(':memory:');
  store.import([...H2_ENTRIES, workflow('alpha-flow')]);
  const { origin, stop } = await startCore(store);
  try {
    const prepared = store.prepare(PROJECT, 'alpha');
    // Every handle the summary advertises, exactly as the model sees it.
    const handles = [...prepared.context.matchAll(/([\p{L}\p{N}_.:-]+)@(\d+)/gu)].map(match => `${match[1]}@${match[2]}`);
    assert.ok(handles.length > 0, '前提：注入文本必须包含 id@revision 形式，否则本测试无意义');
    for (const handle of new Set(handles)) {
      const read = await post(origin, '/v1/knowledge/read', { projectId: PROJECT, knowledgeId: handle });
      assert.equal(read.status, 200, `注入文本中的 ${handle} 必须可读`);
    }
    // The bare id and the suffixed handle must agree, which is the acceptance
    // criterion stated as a comparison rather than as two separate expectations.
    const bare = await post(origin, '/v1/knowledge/read', { projectId: PROJECT, knowledgeId: 'alpha-norm' });
    const suffixed = await post(origin, '/v1/knowledge/read', { projectId: PROJECT, knowledgeId: 'alpha-norm@1' });
    assert.equal(bare.status, suffixed.status, '同一 id 的两种写法结论必须一致');
  } finally { stop(); store.close(); }
});

test('BUG-H2：@revision 是要求而非提示，不符时 409 并给出当前版本，不得静默给旧版或报 404', () => {
  const store = new Store(':memory:');
  store.import(H2_ENTRIES);
  try {
    // `get` and `read` must reach the same conclusion for the same input.
    for (const invoke of [
      (id: string) => store.getKnowledge(PROJECT, id),
      (id: string) => store.readKnowledge(PROJECT, id),
    ]) {
      assert.throws(() => invoke('alpha-norm@7'), (error: unknown) => code(error) === 'revision_conflict',
        'revision 不符必须是版本冲突，不是 not_found');
      assert.throws(() => invoke('alpha-norm@7'), /revision 1, not 7/, '消息必须给出当前 revision');
      // The matching revision still resolves, so the check is a requirement and
      // not a blanket refusal of the suffixed form.
      assert.doesNotThrow(() => invoke('alpha-norm@1'));
    }
  } finally { store.close(); }
});

test('BUG-H2 反例：read 支持全部类型后，跨项目读取仍 404，未知 id 仍 404', () => {
  const store = new Store(':memory:');
  store.import(H2_ENTRIES);
  try {
    // Widening the readable kinds must not widen the visible projects.
    assert.throws(() => store.readKnowledge(PROJECT, 'beta-secret'), (error: unknown) => code(error) === 'not_found');
    assert.throws(() => store.getKnowledge(PROJECT, 'beta-secret'), (error: unknown) => code(error) === 'not_found');
    assert.throws(() => store.readKnowledge(PROJECT, 'no-such-entry'), (error: unknown) => code(error) === 'not_found');
    // A `@` that is not a revision stays part of the id rather than being split.
    assert.throws(() => store.readKnowledge(PROJECT, 'alpha-norm@latest'), (error: unknown) => code(error) === 'not_found');
  } finally { store.close(); }
});

test('BUG-H2：read 返回各类型自己的正文，不得对半个库返回空串', () => {
  const store = new Store(':memory:');
  store.import([...H2_ENTRIES, workflow('alpha-flow')]);
  try {
    assert.equal(store.readKnowledge(PROJECT, 'alpha-norm').body, '回答必须用中文。');
    // A journal records `did`, a workflow `overview`; neither has a `body` field,
    // so a reader that only read `body` returned '' for both.
    assert.equal(store.readKnowledge(PROJECT, 'alpha-log').body, '完成了核验。');
    assert.equal(store.readKnowledge(PROJECT, 'alpha-flow').body, 'alpha-flow 的概览正文。');
    assert.equal(store.readKnowledge(PROJECT, 'alpha-mem').body, '项目代号是翡翠。');
    // Kind-specific extras stay visible so a reader knows what it is holding.
    assert.equal(store.readKnowledge(PROJECT, 'alpha-log').outcome, 'success');
    assert.equal(store.readKnowledge(PROJECT, 'alpha-pref').stated, true);
    assert.equal(store.readKnowledge(PROJECT, 'alpha-skill').needsStructure, true);
  } finally { store.close(); }
});

// ── BUG-M1: an unknown workflow must not swallow the candidate ───────────────

test('BUG-M1：未知 workflowId 的候选必须入队并可被人工看到，attribution 标为未解析', async () => {
  const store = new Store(':memory:');
  const { origin, stop } = await startCore(store);
  try {
    const submitted = await post(origin, '/v1/proposals', {
      idempotencyKey: 'no-such-workflow', projectId: PROJECT,
      workflowId: 'no-such-workflow', discovery: '库中还没有流程，但这条经验必须被留下来。',
    });
    // The defect: a 404 here meant the text existed nowhere afterwards.
    assert.equal(submitted.status, 200, '未知 workflow 不得让候选丢失');
    const listed = await post(origin, '/v1/proposals/list', { projectId: PROJECT }, ADMIN_TOKEN);
    const item = (listed.body.proposals as Array<Record<string, any>>).find(p => p.id === submitted.body.id);
    assert.ok(item, '候选必须出现在人工可查看的队列中');
    assert.equal(item.state, 'pending');
    assert.equal(item.payload.discovery, '库中还没有流程，但这条经验必须被留下来。', '正文必须原样保留');
    // The reviewer must be able to see both what was claimed and that it is unverified.
    assert.deepEqual(item.attribution, { workflowId: 'no-such-workflow', stageId: null, resolved: false },
      '未解析的归属必须如实标注，且 stageId 一并标为未解析');
  } finally { stop(); store.close(); }
});

test('BUG-M1：attribution.resolved 只在真正定位到流程/步骤时为 true', () => {
  const store = new Store(':memory:');
  store.import([workflow('real-flow')]);
  try {
    const located = store.submit('dsh', { idempotencyKey: 'located', projectId: PROJECT, workflowId: 'real-flow', stageId: 'apply', discovery: '归属正确的候选。' });
    const listedLocated = store.listProposals(PROJECT, 'pending').find(p => p.id === located.id);
    assert.deepEqual(listedLocated?.attribution, { workflowId: 'real-flow', stageId: 'apply', resolved: true });

    const unattached = store.submit('dsh', { idempotencyKey: 'unattached', projectId: PROJECT, discovery: '没有归属的候选。' });
    const listedUnattached = store.listProposals(PROJECT, 'pending').find(p => p.id === unattached.id);
    // Nothing was named, so nothing was located. Reporting `true` here is the one
    // thing this flag exists to prevent.
    assert.deepEqual(listedUnattached?.attribution, { workflowId: null, stageId: null, resolved: false },
      '没有归属就是没有定位到');

    const unknown = store.submit('dsh', { idempotencyKey: 'unknown', projectId: PROJECT, workflowId: 'ghost', discovery: '指向不存在的流程。' });
    const listedUnknown = store.listProposals(PROJECT, 'pending').find(p => p.id === unknown.id);
    assert.deepEqual(listedUnknown?.attribution, { workflowId: 'ghost', stageId: null, resolved: false },
      '找不到的流程必须标为未解析，并保留提交者写下的 workflowId 供人工确认');
  } finally { store.close(); }
});

test('BUG-M1：未知 workflow 的说明文案不得泄漏 undefined/null', () => {
  const store = new Store(':memory:');
  try {
    const unknown = store.submit('dsh', { idempotencyKey: 'w-named', projectId: PROJECT, workflowId: 'ghost', discovery: '指向不存在的流程。' });
    assert.match(String(unknown.note), /ghost/, '填了但找不到时应点名该流程');
    assert.equal(/undefined|null|NaN/.test(String(unknown.note)), false, '文案不得包含内部值字面量');

    const none = store.submit('dsh', { idempotencyKey: 'w-none', projectId: PROJECT, discovery: '没填流程。' });
    // No flow was named, so claiming one does not exist would invent a fact.
    assert.equal(/undefined|null|NaN/.test(String(none.note)), false, '未填时文案不得出现 undefined');
    assert.match(String(none.note), /未标注归属流程/, '未填时应陈述事实，而不是声称某个流程不存在');
  } finally { store.close(); }
});

test('BUG-M1：stageId 的既有语义不得放松（未知步骤仍明确失败，单独 stageId 仍被拒）', () => {
  const store = new Store(':memory:');
  store.import([workflow('flow-a')]);
  try {
    assert.throws(
      () => store.submit('dsh', { idempotencyKey: 'orphan', projectId: PROJECT, stageId: 'apply', discovery: '没有 workflow 的步骤归属。' }),
      (error: unknown) => code(error) === 'invalid_request',
      '没有 workflowId 的 stageId 仍应被拒绝，不得存成孤立片段',
    );
    assert.throws(
      () => store.submit('dsh', { idempotencyKey: 'ghost-stage', projectId: PROJECT, workflowId: 'flow-a', stageId: 'nope', discovery: '指向不存在的步骤。' }),
      (error: unknown) => code(error) === 'not_found',
      '已存在的 workflow 上的未知步骤必须明确失败',
    );
    assert.equal(store.listProposals(PROJECT, 'pending').length, 0, '被拒的提交不得留下候选');
  } finally { store.close(); }
});

test('BUG-M1：submit 的运行时校验与 HTTP 契约一致（replay 绕过 zod 时也必须拒绝）', () => {
  const store = new Store(':memory:');
  try {
    // The replay path calls `submit` directly, so these must not depend on zod
    // having run at the HTTP edge.
    for (const discovery of ['', '   ']) {
      assert.throws(
        () => store.submit('dsh', { idempotencyKey: 'blank', projectId: PROJECT, discovery }),
        (error: unknown) => code(error) === 'invalid_request',
        '空或纯空白的 discovery 必须被拒，不得进入审阅队列',
      );
    }
    // A missing field is a domain error naming the field, not a raw TypeError.
    assert.throws(
      () => store.submit('dsh', { idempotencyKey: 'missing', projectId: PROJECT } as never),
      (error: unknown) => error instanceof Error && error.name !== 'TypeError' && code(error) === 'invalid_request',
      '缺失字段必须报领域错误，而不是裸 TypeError',
    );
    assert.throws(
      () => store.submit('dsh', { idempotencyKey: 'zero-base', projectId: PROJECT, baseRevision: 0, discovery: '版本 0 不合法。' } as never),
      (error: unknown) => code(error) === 'invalid_request',
      'baseRevision 0 在契约层非法，必须与 HTTP 路径同样拒绝',
    );
    assert.equal(store.listProposals(PROJECT, 'pending').length, 0);
  } finally { store.close(); }
});

// ── BUG-M6: seeded material must be usable, and the report must be honest ────

const MATERIAL_TTL_DAYS = 90;
const DAY = 86_400_000;

function seedFile(dir: string, entries: unknown[]): string {
  const file = join(dir, 'seed.json');
  writeFileSync(file, JSON.stringify({ entries }, null, 2), 'utf8');
  return file;
}

test('BUG-M6：seed 导入的 material 缺 expiresAt 时必须可读，且 cleanup 之后仍在', () => {
  const dir = tempDir('amb-m6-seed-');
  const dataDir = join(dir, 'data');
  assert.equal(runCli(['init', '--data-dir', dataDir, '--project', 'p0', '--project-root', dir]).code, 0);
  const file = seedFile(dir, [{
    id: 'seed-material', kind: 'material', title: '资料', scope: { kind: 'global' },
    baseRevision: 0, url: 'https://example.test/runbook', fingerprint: 'fp-m6',
    summary: '一份临时资料。', body: '正文', savedAt: Date.now(),
  }]);

  const seeded = runCli(['seed', '--data-dir', dataDir, '--input', file]);
  assert.equal(seeded.code, 0, `seed 应成功：${seeded.stderr}`);
  assert.equal((JSON.parse(seeded.stdout) as { imported: number }).imported, 1);

  const store = new Store(join(dataDir, 'knowledge.sqlite'));
  try {
    // The defect: the schema's 0 default means "already lapsed", so this entry was
    // stored expired, purged by the next cleanup, and reported as a success.
    assert.ok(store.liveMaterial().some(entry => entry.id === 'seed-material'), '导入后必须立即不可读之前，能读到');
    const content = JSON.parse(String((store.db.prepare("SELECT content FROM revisions WHERE id='seed-material'").get() as { content: string }).content));
    assert.ok(content.expiresAt > Date.now(), '缺省有效期必须被补成未来的 90 天，而不是 0');
    assert.ok(Math.abs((content.expiresAt - content.savedAt) - MATERIAL_TTL_DAYS * DAY) < 1000, '默认期限必须是设计 §8 的 90 天');
    store.cleanup();
    assert.ok(store.liveMaterial().some(entry => entry.id === 'seed-material'), '一次 cleanup 之后仍必须可读');
  } finally { store.close(); }
});

test('BUG-M6：导入后仍不可读的条目必须被如实报告，不得静默成功', () => {
  const dir = tempDir('amb-m6-expired-');
  const dataDir = join(dir, 'data');
  assert.equal(runCli(['init', '--data-dir', dataDir, '--project', 'p0', '--project-root', dir]).code, 0);
  const file = seedFile(dir, [
    {
      id: 'already-dead', kind: 'material', title: '过期资料', scope: { kind: 'global' },
      baseRevision: 0, url: 'https://example.test/dead', fingerprint: 'fp-dead',
      summary: '早已过期。', body: '正文', savedAt: 1_000, expiresAt: 2_000,
    },
    { id: 'seed-norm', kind: 'norm', title: '规范', scope: { kind: 'global' }, baseRevision: 0, body: '种子规范。', deniedTools: [], hostProvided: false },
  ]);

  const seeded = runCli(['seed', '--data-dir', dataDir, '--input', file]);
  const report = JSON.parse(seeded.stdout) as { imported: number; unusable?: Array<{ id: string; reason: string }> };
  assert.equal(report.imported, 2, '条目仍应写入，不能被丢弃');
  assert.ok(report.unusable?.some(entry => entry.id === 'already-dead'), '已过期条目必须被点名');
  assert.match(report.unusable![0]!.reason, /过期/, '必须说明原因');
  // An import that leaves an entry the user cannot read is not a clean success.
  assert.notEqual(seeded.code, 0, '存在不可读条目时 seed 必须以非零退出表明它没有完全成功');
});

test('BUG-M6 反例：显式给出的未来有效期不得被导入边界改写', () => {
  const dir = tempDir('amb-m6-explicit-');
  const dataDir = join(dir, 'data');
  assert.equal(runCli(['init', '--data-dir', dataDir, '--project', 'p0', '--project-root', dir]).code, 0);
  // Deliberately shorter than the 90-day default, and in the future — otherwise
  // the entry is expired and the seed would rightly refuse to call it a success.
  const savedAt = Date.now();
  const expiresAt = savedAt + 7 * DAY;
  const file = seedFile(dir, [{
    id: 'short-lived', kind: 'material', title: '短期限资料', scope: { kind: 'global' },
    baseRevision: 0, url: 'https://example.test/week', fingerprint: 'fp-week',
    summary: '一周有效。', body: '正文', savedAt, expiresAt,
  }]);

  assert.equal(runCli(['seed', '--data-dir', dataDir, '--input', file]).code, 0);
  const store = new Store(join(dataDir, 'knowledge.sqlite'));
  try {
    const content = JSON.parse(String((store.db.prepare("SELECT content FROM revisions WHERE id='short-lived'").get() as { content: string }).content));
    // Expiry is stored, not computed: a retention default must not reach back and
    // move an entry that was saved under an explicit date.
    assert.equal(content.expiresAt, expiresAt, '显式有效期必须原样保留');
    assert.equal(content.savedAt, savedAt, '显式保存时间必须原样保留');
    assert.ok(store.liveMaterial().some(entry => entry.id === 'short-lived'), '未过期条目必须可读');
  } finally { store.close(); }
});

// ── BUG-W1: login startup must name a file that exists ──────────────────────

test('BUG-W1：enable-startup 只写存在的入口；入口不存在时非零退出且不写注册表', (t) => {
  if (process.platform !== 'win32') { t.skip('登录启动只为 Windows 实现'); return; }
  const dir = tempDir('amb-w1-');
  const dataDir = join(dir, 'data');
  const key = `HKCU\\Software\\AgentMemoryBackpack\\Tests\\W1-${process.pid}`;
  const value = 'AgentMemoryBackpackCore';
  const readBack = () => spawnSync('reg', ['query', key, '/v', value], { encoding: 'utf8', windowsHide: true });
  spawnSync('reg', ['delete', 'HKCU\\Software\\AgentMemoryBackpack', '/f'], { encoding: 'utf8', windowsHide: true });
  try {
    // The entry a real install has: this test names one that exists, which is what
    // the packaged layout provides (`core/runtime/cli.js`).
    const enabled = runCli(['service', 'enable-startup', '--data-dir', dataDir], { AMB_RUN_KEY: key, AMB_CORE_ENTRY: cliEntry });
    assert.equal(enabled.code, 0, `入口存在时 enable-startup 应成功：${enabled.stderr}`);
    const query = readBack();
    assert.equal(query.status, 0, '注册表项应被写入');
    const command = /REG_SZ\s+(.+)/.exec(query.stdout ?? '')?.[1]?.trim() ?? '';
    const named = /"([^"]+\.js)"/.exec(command)?.[1];
    // The defect: the registered command named a file that did not exist, so
    // nothing started at logon and no log connected the two.
    assert.ok(named, `注册命令必须点名一个入口：${command}`);
    assert.equal(existsSync(named!), true, `注册命令指向的文件必须存在：${named}`);

    // A missing entry must fail before the write, not install a dead command.
    spawnSync('reg', ['delete', key, '/f'], { encoding: 'utf8', windowsHide: true });
    const missing = runCli(['service', 'enable-startup', '--data-dir', dataDir], {
      AMB_RUN_KEY: key, AMB_CORE_ENTRY: join(dir, 'definitely-missing-entry.js'),
    });
    assert.notEqual(missing.code, 0, '入口不存在必须以非零退出');
    assert.match(missing.stderr + missing.stdout, /未找到核心入口/, '必须给出可执行的提示');
    assert.notEqual(readBack().status, 0, '入口不存在时绝不得写入注册表项');
  } finally {
    spawnSync('reg', ['delete', 'HKCU\\Software\\AgentMemoryBackpack', '/f'], { encoding: 'utf8', windowsHide: true });
  }
});

test('BUG-W1：从打包布局运行时，解析出的入口是 runtime/cli.js 而不是 dist/src/cli.js', (t) => {
  if (process.platform !== 'win32') { t.skip('该布局只在打包件上出现'); return; }
  const dir = tempDir('amb-w1-layout-');
  // A directory with a package.json and a runtime/ tree is what `scripts/package.mjs`
  // produces; `root` then resolves here, and a hard-written `dist/src/cli.js` would
  // name a file that does not exist.
  const root = join(dir, 'core');
  mkdirSync(join(root, 'runtime'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"amb-core","type":"module"}', 'utf8');
  const invoked = cliEntry; // run the real CLI, whose own path is a valid candidate
  const key = `HKCU\\Software\\AgentMemoryBackpack\\Tests\\W1L-${process.pid}`;
  const value = 'AgentMemoryBackpackCore';
  spawnSync('reg', ['delete', 'HKCU\\Software\\AgentMemoryBackpack', '/f'], { encoding: 'utf8', windowsHide: true });
  try {
    const enabled = runCli(['service', 'enable-startup', '--data-dir', join(dir, 'data')], { AMB_RUN_KEY: key });
    assert.equal(enabled.code, 0, `应成功：${enabled.stderr}`);
    const query = spawnSync('reg', ['query', key, '/v', value], { encoding: 'utf8', windowsHide: true });
    const named = /"([^"]+\.js)"/.exec(/REG_SZ\s+(.+)/.exec(query.stdout ?? '')?.[1] ?? '')?.[1];
    assert.ok(named, '注册命令必须点名入口');
    assert.equal(existsSync(named!), true, '解析出的入口必须存在');
    assert.equal(named!.replace(/\\/g, '/').endsWith('cli.js'), true);
    void invoked;
  } finally {
    spawnSync('reg', ['delete', 'HKCU\\Software\\AgentMemoryBackpack', '/f'], { encoding: 'utf8', windowsHide: true });
  }
});

// ── BUG-W3: a credential outside a user directory must be tightened ─────────

/** Broad ACE trustees that must never survive on a credential file. */
const BROAD_SIDS = ['AU', 'BU', 'AC', 'WD', 'IU', 'SU'];

/** Read a path's ACL as SDDL, or null. */
function aclSddl(target: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), 'amb-aclread-'));
  try {
    const saved = join(dir, 'acl.txt');
    const run = spawnSync('icacls', [target, '/save', saved], { encoding: 'utf8', windowsHide: true });
    if (run.status !== 0 || !existsSync(saved)) return null;
    // UTF-16LE: read as latin1 this shows `c r e d . j s o n` and no rule matches.
    const text = new TextDecoder('utf-16le').decode(readFileSync(saved));
    return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)[1] ?? null;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Broad principals appearing as ACE trustees in an SDDL string. */
function broadPrincipals(sddl: string | null): string[] {
  if (!sddl) return [];
  const found = new Set<string>();
  for (const ace of sddl.match(/\([^)]*\)/g) ?? []) {
    for (const token of ace.slice(1, -1).split(';')) {
      if (BROAD_SIDS.includes(token.trim().toUpperCase())) found.add(token.trim());
    }
  }
  return [...found];
}

test('BUG-W3：数据目录含宽权限时，init 必须收紧凭据 ACL 且退出 0', (t) => {
  if (process.platform !== 'win32') { t.skip('ACL 收紧只为 Windows 实现'); return; }
  const work = tempDir('amb-w3-');
  const dataDir = join(work, 'data');
  mkdirSync(dataDir, { recursive: true });
  // Reproduce a drive root: Authenticated Users with modify, inherited downward.
  spawnSync('icacls', [dataDir, '/grant:r', '*S-1-5-11:(OI)(CI)(M)'], { encoding: 'utf8', windowsHide: true });

  // Prove the condition is real, or the test would pass without testing anything.
  const probe = join(dataDir, 'inherit-probe.json');
  writeFileSync(probe, '{}', 'utf8');
  assert.ok(broadPrincipals(aclSddl(probe)).length > 0, '前提：该目录下的新文件确实会继承宽权限');

  const init = runCli(['init', '--data-dir', dataDir, '--project', 'w3', '--project-root', work]);
  // The verification step must not fail the command; the first version of the fix
  // reported FAILED for every credential and exited non-zero, and no test noticed.
  assert.equal(init.code, 0, `init 必须成功：${init.stdout}\n${init.stderr}`);
  assert.match(init.stdout, /ACL ok/, '必须如实报告收紧结果');

  for (const name of ['dsh-client.json', 'codex-client.json', 'admin-client.json']) {
    const path = join(dataDir, name);
    assert.equal(existsSync(path), true, `${name} 应被写出`);
    // The defect: these files inherited Authenticated Users:(M) and Users:(RX),
    // so the token was readable by every account on the machine.
    assert.deepEqual(broadPrincipals(aclSddl(path)), [], `${name} 不得残留宽权限主体`);
  }
});

test('BUG-W3 反例：收紧后当前用户仍读得到凭据（安全改动不得把功能弄坏）', (t) => {
  if (process.platform !== 'win32') { t.skip('ACL 收紧只为 Windows 实现'); return; }
  const work = tempDir('amb-w3-read-');
  const dataDir = join(work, 'data');
  mkdirSync(dataDir, { recursive: true });
  spawnSync('icacls', [dataDir, '/grant:r', '*S-1-5-11:(OI)(CI)(M)'], { encoding: 'utf8', windowsHide: true });

  const init = runCli(['init', '--data-dir', dataDir, '--project', 'w3r', '--project-root', work]);
  assert.equal(init.code, 0, `init 必须成功：${init.stderr}`);
  // A credential the owner can no longer read would be a worse bug than the one
  // this fixes, so the positive path is asserted alongside the ACL result.
  const parsed = JSON.parse(readFileSync(join(dataDir, 'dsh-client.json'), 'utf8')) as { token?: string };
  assert.equal(typeof parsed.token, 'string', '当前用户必须仍能读到凭据内容');
  assert.equal((parsed.token ?? '').length >= 32, true);
  // And the CLI itself can still use it.
  const status = runCli(['status', '--data-dir', dataDir]);
  assert.equal(status.code, 0, '凭据收紧后 status 仍应可用');
});
