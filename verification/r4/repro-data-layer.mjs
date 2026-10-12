/**
 * Reproduce the five data-layer defects this round fixes, against a compiled build.
 *
 * Usage: node verification/r4/repro-data-layer.mjs [buildDir]
 *        buildDir defaults to "dist" (i.e. dist/src/*.js from the repo build).
 *
 * Isolation rules this script obeys, deliberately:
 *   - No host contact at all. The HTTP checks bind a core on an ephemeral
 *     loopback port (`listen(0)`) with synthetic credentials, never on the
 *     configured 47631/47761 where a real core may be listening.
 *   - The store checks use an in-memory SQLite database.
 *   - The CLI checks run against throwaway data directories under the system
 *     temp dir; nothing writes to %USERPROFILE%\.agent-memory-backpack.
 *   - The login-startup check registers into a scratch registry key
 *     (HKCU\Software\AmbReproTests\...), never the real HKCU\...\Run key.
 *
 * The output is deliberately before/after-agnostic: run it once on the pre-fix
 * build to capture the broken behaviour, then again on the post-fix build to show
 * the same commands now behave. Every check prints the raw observed facts.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const buildDir = resolve(repoRoot, process.argv[2] ?? 'dist');
const srcDir = join(buildDir, 'src');
const { Store } = await import(pathToFileURL(join(srcDir, 'store.js')).href);
const { createCoreServer } = await import(pathToFileURL(join(srcDir, 'server.js')).href);

const results = [];
const record = (id, requirement, detail) => {
  results.push({ id, requirement, detail });
  console.log(`\n### ${id} — ${requirement}\n${detail}`);
};

const scratchRoot = mkdtempSync(join(tmpdir(), 'amb-r4-'));
const cleanups = [];
process.on('exit', () => {
  for (const fn of cleanups.reverse()) { try { fn(); } catch { /* best effort */ } }
});

// ── HTTP harness ────────────────────────────────────────────────────────────
const PROJECT = 'alpha';
const FOREIGN = 'beta';
const TOKEN = 'a'.repeat(48);
const FOREIGN_TOKEN = 'b'.repeat(48);
// Listing the queue is an admin-only operation by design (an adapter must not be
// able to read or clear its own review queue), so the acceptance check uses the
// human's credential rather than the adapter's.
const ADMIN_TOKEN = 'c'.repeat(48);

function config() {
  return {
    protocolVersion: 1, port: 1,
    clients: [
      { id: 'dsh', projectId: PROJECT, role: 'adapter', token: TOKEN },
      { id: 'codex', projectId: FOREIGN, role: 'adapter', token: FOREIGN_TOKEN },
      { id: 'admin', projectId: PROJECT, role: 'admin', token: ADMIN_TOKEN },
    ],
  };
}

async function startCore(store) {
  const server = createCoreServer(store, config());
  await new Promise(done => server.listen(0, '127.0.0.1', () => done()));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  // Closed explicitly rather than through the exit hook: an open listener keeps
  // the event loop alive, so an exit hook would never run. `stop()` is called at
  // the end of each block, and the hook covers the failure path.
  const stop = () => { try { server.closeAllConnections(); } catch { /* older runtime */ } server.close(); };
  cleanups.push(stop);
  return { origin, stop };
}

async function post(origin, path, body, token = TOKEN) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-amb-protocol': '1' },
    body: JSON.stringify(body),
  });
  let payload;
  try { payload = await response.json(); } catch { payload = null; }
  return { status: response.status, body: payload };
}

const fixture = {
  memory: {
    id: 'alpha-mem', kind: 'memory', title: '记忆', scope: { kind: 'project', projectId: PROJECT },
    baseRevision: 0, body: '项目代号是翡翠。',
  },
  norm: {
    id: 'alpha-style', kind: 'norm', title: '规范', scope: { kind: 'project', projectId: PROJECT },
    baseRevision: 0, body: '回答必须用中文。', deniedTools: [], hostProvided: false,
  },
  journal: {
    id: 'alpha-log', kind: 'journal', title: '日记', scope: { kind: 'project', projectId: PROJECT },
    baseRevision: 0, did: '完成了核验。', outcome: 'success',
  },
  preference: {
    id: 'alpha-pref', kind: 'preference', title: '偏好', scope: { kind: 'project', projectId: PROJECT },
    baseRevision: 0, body: '先给结论。', stated: true,
  },
  skill: {
    id: 'alpha-skill', kind: 'skill', title: '技能', scope: { kind: 'project', projectId: PROJECT },
    baseRevision: 0, body: 'SKILL', leaves: [], needsStructure: true,
  },
  foreign: {
    id: 'beta-secret', kind: 'memory', title: '外部记忆', scope: { kind: 'project', projectId: FOREIGN },
    baseRevision: 0, body: '不该被 alpha 读到。',
  },
};

// ── BUG-H2: read route vs get route, and the id@revision form ───────────────
{
  const store = new Store(':memory:');
  store.import(Object.values(fixture));
  const { origin, stop } = await startCore(store);
  const lines = [];

  for (const kind of ['memory', 'norm', 'journal', 'preference', 'skill']) {
    const id = fixture[kind].id;
    const get = await post(origin, '/v1/knowledge/get', { projectId: PROJECT, id });
    const read = await post(origin, '/v1/knowledge/read', { projectId: PROJECT, knowledgeId: id });
    lines.push(`${kind.padEnd(10)} id=${id.padEnd(12)} get=${get.status} read=${read.status}${read.status !== 200 ? ` read=${JSON.stringify(read.body)}` : ''}`);
  }
  // The form the injected context actually uses, and which the model copies.
  const suffixed = await post(origin, '/v1/knowledge/read', { projectId: PROJECT, knowledgeId: 'alpha-style@1' });
  const suffixedGet = await post(origin, '/v1/knowledge/get', { projectId: PROJECT, id: 'alpha-mem@1' });
  lines.push(`read("alpha-style@1")  -> ${suffixed.status} ${JSON.stringify(suffixed.body)}`);
  lines.push(`get("alpha-mem@1")     -> ${suffixedGet.status} ${JSON.stringify(suffixedGet.body)}`);
  // A stale revision must be reported as a conflict, never as "not found".
  const stale = await post(origin, '/v1/knowledge/read', { projectId: PROJECT, knowledgeId: 'alpha-style@7' });
  lines.push(`read("alpha-style@7")  -> ${stale.status} ${JSON.stringify(stale.body)}`);
  const staleGet = await post(origin, '/v1/knowledge/get', { projectId: PROJECT, id: 'alpha-style@7' });
  lines.push(`get("alpha-style@7")   -> ${staleGet.status} ${JSON.stringify(staleGet.body)}`);
  // Positive control: the scope rule must still hold.
  const cross = await post(origin, '/v1/knowledge/read', { projectId: PROJECT, knowledgeId: 'beta-secret' });
  const crossGet = await post(origin, '/v1/knowledge/get', { projectId: PROJECT, id: 'beta-secret' });
  lines.push(`cross-project read beta-secret -> ${cross.status}; get -> ${crossGet.status}`);
  const unknown = await post(origin, '/v1/knowledge/read', { projectId: PROJECT, knowledgeId: 'no-such-entry' });
  lines.push(`unknown id read -> ${unknown.status} ${JSON.stringify(unknown.body)}`);

  record('BUG-H2', 'get 与 read 对同一 id 的结论必须一致；注入文本里的 id@rev 必须可读', lines.join('\n'));
  stop();
  store.close();
}

// ── BUG-M1: an unknown workflowId must not lose the candidate ───────────────
{
  const store = new Store(':memory:');
  const { origin, stop } = await startCore(store);
  const submit = await post(origin, '/v1/proposals', {
    idempotencyKey: 'no-workflow-1', projectId: PROJECT,
    workflowId: 'no-such-workflow', discovery: '库中还没有流程，但这条经验必须被留下来。',
  });
  const listed = await post(origin, '/v1/proposals/list', { projectId: PROJECT });
  const proposals = listed.body?.proposals ?? [];
  const lines = [
    `submit(workflowId="no-such-workflow") -> ${submit.status} ${JSON.stringify(submit.body)}`,
    `listProposals count = ${proposals.length}`,
    `attribution = ${JSON.stringify(proposals[0]?.attribution ?? null)}`,
    `state = ${JSON.stringify(proposals[0]?.state ?? null)}`,
  ];
  // Positive control: a stage of a real workflow still must be validated.
  store.import([{
    id: 'real-flow', kind: 'workflow', title: '流程', scope: { kind: 'project', projectId: PROJECT },
    baseRevision: 0, overview: 'o', triggers: ['t'], categories: [['c']], preconditions: ['p'],
    stages: [{ id: 'apply', title: 'a', instructions: 'i', checks: ['c'], dependencies: [] }],
    completion: ['d'], recovery: 'r',
  }]);
  const goodStage = await post(origin, '/v1/proposals', {
    idempotencyKey: 'good-stage', projectId: PROJECT, workflowId: 'real-flow', stageId: 'apply',
    discovery: '归属正确的候选。',
  });
  const badStage = await post(origin, '/v1/proposals', {
    idempotencyKey: 'bad-stage', projectId: PROJECT, workflowId: 'real-flow', stageId: 'nope',
    discovery: '指向不存在步骤的候选。',
  });
  const orphanStage = await post(origin, '/v1/proposals', {
    idempotencyKey: 'orphan-stage', projectId: PROJECT, stageId: 'apply', discovery: '没有 workflow 的步骤归属。',
  });
  lines.push(`real workflow + real stage -> ${goodStage.status}`);
  lines.push(`real workflow + ghost stage -> ${badStage.status} ${JSON.stringify(badStage.body)}`);
  lines.push(`stage without workflow       -> ${orphanStage.status} ${JSON.stringify(orphanStage.body)}`);
  lines.push(`listProposals count after controls = ${(await post(origin, '/v1/proposals/list', { projectId: PROJECT })).body?.proposals?.length}`);
  record('BUG-M1', '未知 workflowId 的候选不得丢失，必须可被人工看到并处理', lines.join('\n'));
  stop();
  store.close();
}

// ── CLI helpers ─────────────────────────────────────────────────────────────
function runNode(script, args, options = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function initDataDir(label) {
  const dir = join(scratchRoot, label);
  const init = runNode(join(srcDir, 'cli.js'), ['init', '--data-dir', dir, '--project', 'p0', '--project-root', dir]);
  if (init.code !== 0) throw new Error(`init failed: ${init.stderr}`);
  return dir;
}

// ── BUG-M6: `cli seed` material must be readable afterwards ─────────────────
{
  const dir = initDataDir('seed');
  const input = join(scratchRoot, 'seed-input.json');
  writeFileSync(input, JSON.stringify({
    entries: [
      {
        id: 'seed-norm', kind: 'norm', title: '规范', scope: { kind: 'global' },
        baseRevision: 0, body: '种子规范。', deniedTools: [], hostProvided: false,
      },
      {
        // No expiresAt on purpose: this is the shape the report reproduced.
        id: 'alpha-runbook-material', kind: 'material', title: '资料', scope: { kind: 'global' },
        baseRevision: 0, url: 'https://example.test/runbook', fingerprint: 'fp-1',
        summary: '一份临时资料。', body: '正文', savedAt: Date.now(),
      },
    ],
  }, null, 2), 'utf8');

  const seed = runNode(join(srcDir, 'cli.js'), ['seed', '--data-dir', dir, '--input', input]);
  const status = runNode(join(srcDir, 'cli.js'), ['status', '--data-dir', dir]);
  // Read the material back through the store the CLI just wrote.
  const store = new Store(join(dir, 'knowledge.sqlite'));
  const live = store.liveMaterial();
  const raw = store.db.prepare("SELECT content FROM revisions WHERE id='alpha-runbook-material'").get();
  const storedExpiry = raw ? JSON.parse(String(raw.content)).expiresAt : null;
  const stats = store.materialStats();
  store.close();

  record('BUG-M6', 'seed 导入的 material 必须可读；若确实过期，seed 输出必须说出来',
    [
      `seed exit=${seed.code} stdout=${seed.stdout.trim()}`,
      `seed stderr=${seed.stderr.trim()}`,
      `stored expiresAt = ${storedExpiry}`,
      `materialStats = ${JSON.stringify(stats)}`,
      `liveMaterial count = ${live.length} ${JSON.stringify(live.map(m => m.id))}`,
      `status exit=${status.code}`,
    ].join('\n'));

  // A material that really is already expired must be reported, not silently lost.
  const expiredInput = join(scratchRoot, 'seed-expired.json');
  const staleDir = initDataDir('seed-expired');
  writeFileSync(expiredInput, JSON.stringify({
    entries: [{
      id: 'already-dead', kind: 'material', title: '过期资料', scope: { kind: 'global' },
      baseRevision: 0, url: 'https://example.test/dead', fingerprint: 'fp-2',
      summary: '早已过期。', body: '正文', savedAt: 1_000, expiresAt: 2_000,
    }],
  }, null, 2), 'utf8');
  const expiredSeed = runNode(join(srcDir, 'cli.js'), ['seed', '--data-dir', staleDir, '--input', expiredInput]);
  record('BUG-M6b', '导入后立即失效的条目，seed 结果必须如实反映（不得静默成功）',
    [`seed exit=${expiredSeed.code} stdout=${expiredSeed.stdout.trim()}`].join('\n'));
}

// ── BUG-W1: login startup must point at a file that exists ──────────────────
{
  /**
   * A self-sufficient fake artifact.
   *
   * `dist/src/cli.js` imports the compiled modules and their dependencies from
   * the repo tree, so a copy of `dist/src` on its own cannot run — it cannot even
   * resolve `zod`. The packaged layout, however, is produced by
   * `scripts/package.mjs`, which copies `dist/src` to `core/runtime` and installs
   * the runtime's `node_modules` beside it. The copy below reproduces exactly
   * that: runtime + node_modules + a package.json, so `root` resolves to the
   * artifact's `core` directory just as it does for a real installation.
   *
   * The dependency tree is copied from the repo's own `node_modules` rather than
   * stubbed, so the commands under test execute their real code paths.
   */
  const artifact = join(scratchRoot, 'artifact', 'core');
  mkdirSync(join(artifact, 'runtime'), { recursive: true });
  cpSync(srcDir, join(artifact, 'runtime'), { recursive: true });
  writeFileSync(join(artifact, 'package.json'), JSON.stringify({ name: 'amb-core', type: 'module' }, null, 2), 'utf8');
  cpSync(join(repoRoot, 'node_modules', 'zod'), join(artifact, 'node_modules', 'zod'), { recursive: true });
  const packagedCli = join(artifact, 'runtime', 'cli.js');
  const dataDir = join(scratchRoot, 'w1data');
  const init = runNode(packagedCli, ['init', '--data-dir', dataDir, '--project', 'p0', '--project-root', dataDir]);
  const key = `HKCU\\Software\\AmbReproTests\\Run-${process.pid}`;
  const value = 'AgentMemoryBackpackCore';
  cleanups.push(() => spawnSync('reg', ['delete', 'HKCU\\Software\\AmbReproTests', '/f'], { encoding: 'utf8', windowsHide: true }));
  spawnSync('reg', ['delete', 'HKCU\\Software\\AmbReproTests', '/f'], { encoding: 'utf8', windowsHide: true });

  const enabled = runNode(packagedCli, ['service', 'enable-startup', '--data-dir', dataDir], { env: { AMB_RUN_KEY: key } });
  const query = spawnSync('reg', ['query', key, '/v', value], { encoding: 'utf8', windowsHide: true });
  const registered = /REG_SZ\s+(.+)/.exec(query.stdout ?? '')?.[1]?.trim() ?? '(none)';
  // The registered command names a script; does it exist?
  const named = /"([^"]+\.js)"/.exec(registered)?.[1] ?? null;
  const lines = [
    `fake artifact init exit=${init.code}${init.code !== 0 ? ` stderr=${init.stderr.split('\n').slice(0, 3).join(' | ')}` : ''}`,
    `enable-startup exit=${enabled.code}`,
    `stdout=${enabled.stdout.trim()}`,
    `stderr=${enabled.stderr.trim().split('\n').slice(0, 3).join(' | ')}`,
    `registered command = ${registered}`,
    `named entry = ${named}`,
    `entry exists = ${named ? existsSync(named) : null}`,
  ];
  // The other half of the requirement: a missing entry must fail instead of
  // writing a registry value at all. Reproduced by naming the entry the way an
  // operator wrapping the CLI would — an explicit path that does not exist — and
  // then reading back the scratch key to prove nothing was written.
  const key2 = `HKCU\\Software\\AmbReproTests\\Missing-${process.pid}`;
  const missingEntryPath = join(artifact, 'runtime', 'definitely-missing-entry.js');
  const missing = runNode(packagedCli, ['service', 'enable-startup', '--data-dir', dataDir], {
    env: { AMB_RUN_KEY: key2, AMB_CORE_ENTRY: missingEntryPath },
  });
  const query2 = spawnSync('reg', ['query', key2, '/v', value], { encoding: 'utf8', windowsHide: true });
  lines.push(`missing-entry enable-startup exit=${missing.code}`);
  lines.push(`missing-entry stdout=${missing.stdout.trim()}`);
  lines.push(`missing-entry stderr=${missing.stderr.trim().split('\n').slice(0, 2).join(' | ')}`);
  lines.push(`missing-entry registry written = ${query2.status === 0}`);
  record('BUG-W1', '登录自启命令必须指向存在的入口；入口不存在时必须非零退出且不写注册表', lines.join('\n'));
}

// ── BUG-W3: credential ACL must be tightened outside a user directory ───────
if (process.platform === 'win32') {
  // A directory whose parent grants Authenticated Users:(M) — mimic the
  // non-user-directory case (D: root) the report reproduced on.
  const outside = `D:\\amb-r4-acl-${process.pid}`;
  let used = outside;
  try { mkdirSync(outside, { recursive: true }); }
  catch { used = join(scratchRoot, 'acl'); mkdirSync(used, { recursive: true }); }
  cleanups.push(() => rmSync(used, { recursive: true, force: true }));

  const init = runNode(join(srcDir, 'cli.js'), ['init', '--data-dir', used, '--project', 'p0', '--project-root', used]);
  const target = join(used, 'dsh-client.json');
  const acl = spawnSync('icacls', [target], { encoding: 'utf8', windowsHide: true });
  const text = `${acl.stdout ?? ''}`;
  const broad = ['Authenticated Users', 'BUILTIN\\Users'].filter(name => text.includes(name));
  record('BUG-W3', '凭据文件 ACL 不得含 Authenticated Users/Users 的宽权限授予',
    [
      `init exit=${init.code}`,
      `icacls ${target}:`,
      text.trim(),
      `broad grants still present = ${JSON.stringify(broad)}`,
    ].join('\n'));
}

console.log(`\n\n${'='.repeat(70)}\nSUMMARY (machine-readable)`);
console.log(JSON.stringify(results, null, 2));
rmSync(scratchRoot, { recursive: true, force: true });
process.exit(0);
