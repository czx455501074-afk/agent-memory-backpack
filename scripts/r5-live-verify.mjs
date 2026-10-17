// What the running core actually does, asked over the wire.
//
// The existing acceptance script drives the library directly with no model
// provider configured, which means it exercises the *degraded* retrieval path
// (`local_index`) while a real host runs the *model* path. That difference was
// found the hard way: `selection: {mode:'model'}` came back from the live core
// while the script could only ever report `local_index`. A check that cannot see
// the path production uses is not acceptance, it is a smoke test.
//
// This script talks to the core the host talks to. It is read-mostly: the only
// request that can write is `/v1/prepare`, and it is called without a sessionId so
// it cannot create or resume a task. Nothing is deployed, restarted or committed.
//
// Usage: node scripts/r5-live-verify.mjs [--data-dir <dir>] [--project <id>] [--json]
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const dataDir = flag('data-dir', join(homedir(), '.agent-memory-backpack'));
const projectId = flag('project', 'p0-workflow');
const asJson = argv.includes('--json');

const corePath = join(dataDir, 'core.json');
if (!existsSync(corePath)) {
  console.error(`找不到 ${corePath}：核心从未启动过，或数据目录不是这个。`);
  process.exit(2);
}
const core = JSON.parse(readFileSync(corePath, 'utf8'));
const clients = Array.isArray(core.clients) ? core.clients : [];
// The adapter identity is required: /v1/prepare refuses an admin credential with
// `scope_denied`, because an admin is not an adapter. That refusal is correct and
// is why this script looks for the adapter token specifically.
const adapter = clients.find(entry => entry.id === 'dsh') ?? clients.find(entry => entry.id === 'codex');
if (!adapter?.token) {
  console.error('core.json 里没有适配器凭据（dsh/codex），无法按宿主的方式提问。');
  process.exit(2);
}
const base = `http://127.0.0.1:${core.port}`;
const headers = { Authorization: `Bearer ${adapter.token}`, 'x-amb-protocol': '1', 'Content-Type': 'application/json' };
// Two identities, two jobs. `/v1/prepare` refuses an admin ("an admin is not an
// adapter"), and `/v1/proposals/list` refuses an adapter with 403 because reading
// the review queue is an admin surface. Using one token for both would either fail
// or, worse, hide which credential the check really exercised.
const admin = clients.find(entry => entry.id === 'admin');
const adminHeaders = admin?.token
  ? { Authorization: `Bearer ${admin.token}`, 'x-amb-protocol': '1', 'Content-Type': 'application/json' }
  : null;

const post = async (path, body, useHeaders = headers) => {
  const started = Date.now();
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: useHeaders, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}: ${text.slice(0, 200)}`);
  return { body: JSON.parse(text), ms: Date.now() - started };
};

const checks = [];
const record = (name, ok, detail) => { checks.push({ name, ok, detail }); };

const query = flag('query', '打包脚本必须包含全量语法扫描');

// 1. Control: a synchronous endpoint with no model behind it. The difference
//    between this and /v1/prepare is the model layer's cost, which is the only way
//    to attribute latency without guessing.
const control = await post('/v1/search', { projectId, query });
record('对照端点 /v1/search 可响应', control.body.knowledgeRevision > 0,
  `${control.ms}ms, knowledgeRevision ${control.body.knowledgeRevision}`);

// 2. The live prepare path: which selection mode is production actually using?
const full = await post('/v1/prepare', { adapter: adapter.id, projectId, query });
const selection = full.body?.retrieval?.selection ?? null;
const matched = full.body?.retrieval?.matchedTokens ?? [];
const selectedIds = selection?.selectedIds ?? [];
record('准备路径给出了检索选择', Array.isArray(selectedIds), `mode=${selection?.mode ?? '(none)'} selectedIds=${selectedIds.join(',') || '(empty)'}`);
record('回执如实报告命中词', matched.length > 0, `matched(全部)=[${matched.join(',')}] gaps=[${(full.body?.retrieval?.gaps ?? []).join(',')}]`);
record('模式已说明（不是空值）', Boolean(selection?.mode), `mode=${selection?.mode ?? '(missing)'}`);
const modelMs = full.ms - control.ms;
record('模型层耗时可分离', modelMs >= 0, `prepare ${full.ms}ms - 对照 ${control.ms}ms = 模型层约 ${modelMs}ms`);

// 3. The same query with the version the caller already has: it must answer with a
//    pointer, and the rules must still be returned in full.
const revision = control.body.knowledgeRevision;
const pointer = await post('/v1/prepare', { adapter: adapter.id, projectId, query, knowledgeRevision: revision });
record('同版本回指针而非全文', pointer.body.context.length < full.body.context.length && pointer.body.contextUnchanged === true,
  `完整 ${full.body.context.length} 字符 → 同版本 ${pointer.body.context.length} 字符 (unchanged=${pointer.body.contextUnchanged})`);
record('指针化没有省掉规则本身', (pointer.body.norms?.length ?? 0) > 0 && (pointer.body.norms?.length ?? 0) === (full.body.norms?.length ?? 0),
  `norms ${full.body.norms?.length ?? 0} → ${pointer.body.norms?.length ?? 0}`);

// 4. The queue view the panel opens by default. This one needs the admin
//    credential: an adapter asking for it is refused with 403, and that refusal is
//    part of the design rather than an obstacle to route around.
if (adminHeaders) {
  const queue = await post('/v1/proposals/list', { projectId, view: 'queue', include: 'actionable' }, adminHeaders);
  const totals = queue.body?.totals ?? {};
  record('待审队列给出聚合视图', Number.isFinite(totals.collapsed),
    `inState ${totals.inState} → 可审 ${totals.actionable}, 折叠 ${totals.collapsed} 条重复 (${totals.failureSignatures} 个签名)`);
} else {
  record('待审队列给出聚合视图', false, 'core.json 里没有 admin 凭据，这一项没有测到（不是通过）');
}

// 5. The library itself, read-only, for the things the API does not expose.
const db = new DatabaseSync(join(dataDir, 'knowledge.sqlite'), { readOnly: true });
const tasks = Object.fromEntries(db.prepare('SELECT status, count(*) n FROM tasks GROUP BY 1').all().map(row => [row.status, row.n]));
const scoped = db.prepare(`SELECT count(*) n FROM knowledge k JOIN revisions r ON r.id = k.id AND r.revision = k.head
  WHERE k.status = 'active' AND json_extract(r.content, '$.scope.kind') = 'task'`).get();
const pendingNorm = db.prepare(`SELECT count(*) n FROM proposals WHERE state = 'pending'`).get();
const reviews = db.prepare('SELECT count(*) n FROM model_reviews').get();
// The classifier version (B2) is written into the stored decision, so it is visible
// without asking the API. Counted here rather than asserted per row: a library where
// none of the pending candidates carry a version is the pre-backfill state.
const versioned = db.prepare(`SELECT count(*) n FROM proposals
  WHERE state = 'pending' AND json_extract(payload, '$.classification.classifierVersion') IS NOT NULL`).get();
db.close();
record('任务不再无限期挂着', (tasks.in_progress ?? 0) < 49, `in_progress ${tasks.in_progress ?? 0} / paused ${tasks.paused ?? 0} / completed ${tasks.completed ?? 0}`);
record('“本会话”作用域有内容', scoped.n > 0, `task 作用域条目 ${scoped.n}`);
record('模型审核在真实库上有产出', reviews.n > 0, `model_reviews ${reviews.n} 条`);
// "Greater than zero" was the first version of this check, and it went green the moment a
// single new submission carried a version - a green light for a backfill that had never run.
// The question is not "does anything carry a version"; it is "has the stored population been
// brought up to the current classifier". Ask that instead: a submission written by the
// current code always carries one, so a ratio near 1 is the only evidence that the backlog
// was actually converted.
const versionedRatio = pendingNorm.n === 0 ? 1 : versioned.n / pendingNorm.n;
record('待审候选的判定带判定器版本（B2）', versionedRatio >= 0.95,
  `带 classifierVersion 的待审候选 ${versioned.n} / ${pendingNorm.n}（${(versionedRatio * 100).toFixed(1)}%）`
  + `——回填未执行时，只有新提交的候选带版本，比例会远低于 1`);

// 6. Checks that only a build containing this round's work can pass. They are reported
//    separately because an older running core is a fact about deployment, not a defect
//    in the code — `verify-host-deployment.mjs` answers which build is live.
const afterDeploy = [];
if (adminHeaders) {
  const queue = await post('/v1/proposals/list', { projectId, view: 'queue', include: 'actionable' }, adminHeaders);
  const items = queue.body?.items ?? [];
  const candidate = items.find(item => item.kind !== 'aggregate');
  afterDeploy.push({
    name: '候选项显式声明自己的形状（W11）',
    ok: Boolean(candidate && candidate.kind === 'candidate'),
    detail: candidate ? `kind=${candidate.kind}` : '队列里没有可用的普通候选项',
  });
  afterDeploy.push({
    name: '队列解释归属状态（W11）',
    ok: Boolean(candidate && candidate.attribution && 'described' in candidate.attribution),
    detail: candidate?.attribution ? `attribution=${JSON.stringify(candidate.attribution)}` : '没有候选可查',
  });
  // The heading is the whole point of this group: without it, two FAILs sit in the same
  // list as the checks that describe the current core, and "not deployed yet" reads as
  // "the code is broken". The heading names the next action instead of leaving the reader
  // to infer it.
  console.log('\n以下检查需要运行中的核心包含本轮构建（部署之后才可能通过）：');
  console.log('若它们 FAIL，先跑 node scripts/verify-host-deployment.mjs 确认在跑哪一版，再决定是否部署；');
  console.log('请不要把"尚未部署"读成"代码坏了"。\n');
  for (const check of afterDeploy) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}\n      ${check.detail}`);
  }
}

if (asJson) console.log(JSON.stringify({ projectId, checks, afterDeploy, pending: pendingNorm.n }, null, 2));
else {
  console.log(`对运行中的核心验收（${base}，项目 ${projectId}）\n`);
  for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}\n      ${check.detail}`);
  const failed = checks.filter(check => !check.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} 通过；待审候选 ${pendingNorm.n} 条。`);
}
process.exit(checks.every(check => check.ok) ? 0 : 1);
