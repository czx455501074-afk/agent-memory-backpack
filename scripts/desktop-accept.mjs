// Desktop acceptance runner.
//
// Runs everything about desktop acceptance that a machine can check, and writes
// an evidence file a human can act on. It deliberately does NOT: install or
// trust plugins in either desktop, edit a real profile, or restart an app. Those
// steps require a person to click, so they are reported as `manual` with the
// exact observation to record.
//
// Usage:
//   node scripts/desktop-accept.mjs [--workspace DIR] [--data-dir DIR] [--artifact-dir DIR] [--keep]
//   node scripts/desktop-accept.mjs --report evidence/desktop-acceptance.json
//
// --artifact-dir points at the directory holding latest.json and the packaged
// trees; it exists so a fixture can exercise the checks without touching the
// real artifacts/ directory.
//
// Exit code is 0 only when every automatable check passes. Manual items never
// fail the run: they are what the report is for.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createServer } from 'node:net';
import { Script } from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: {
    workspace: { type: 'string' },
    'data-dir': { type: 'string' },
    'artifact-dir': { type: 'string' },
    report: { type: 'string' },
    keep: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
});

const workspace = resolve(values.workspace ?? join(root, '.local', 'desktop-accept', 'workspace'));
const dataDir = resolve(values['data-dir'] ?? join(root, '.local', 'desktop-accept', 'data'));
const artifactRoot = resolve(values['artifact-dir'] ?? join(root, 'artifacts'));
const reportPath = resolve(values.report ?? join(root, 'docs', 'implementation', 'desktop-acceptance-report.json'));

/** A free loopback port, so the run never collides with a service already up. */
async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

const results = [];
/** What the artifact claimed about its build versus what the tree says now. */
let buildIdentity = null;
/**
 * Record one check.
 *
 * Details are scrubbed of absolute paths before they are stored. The report is
 * meant to be pasted into an issue, and a machine-specific path in it both leaks
 * the author's directory layout and makes the output useless to a reader on
 * another machine. `artifact` is deliberately relative for the same reason.
 */
function record(id, title, status, detail, extra = {}) {
  results.push({ id, title, status, detail: scrubPaths(detail), ...scrubDeep(extra) });
}

/** Replace absolute paths with a stable relative form. */
function scrubPaths(value) {
  let text = String(value ?? '');
  // Repository-relative is readable and portable: strip the repository prefix.
  text = text.split(root).join('.');
  // Any remaining drive-letter path is reduced to its last two segments. This
  // covers fixtures outside the repository (temporary directories) as well.
  // The separator must follow the letter directly and must not be the first half
  // of a URL's `//`: `s://attacker.invalid` is a URL, not a drive, and rewriting
  // it would corrupt the evidence it is quoted as.
  text = text.replace(/[A-Za-z]:(?:\\+|\/(?!\/))[^\s"']*/g, match => {
    const parts = match.split(/[\\/]/).filter(Boolean);
    return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : match;
  });
  return text;
}

/** Apply the same scrubbing to a nested structure. */
function scrubDeep(value) {
  if (typeof value === 'string') return scrubPaths(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = scrubDeep(item);
    return out;
  }
  return value;
}

/** Run a command and capture its output; never throws on a non-zero exit. */
function run(command, args, options = {}) {
  return new Promise(resolveRun => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...(options.env ?? {}) },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', error => resolveRun({ code: -1, stdout, stderr: String(error.message) }));
    child.once('close', code => resolveRun({ code, stdout, stderr }));
  });
}

/**
 * Reduce a recorded build identity to the fact that decides whether an artifact
 * belongs to the tree under verification: which commit, and whether that tree
 * was dirty. null means the artifact recorded nothing usable, which is not the
 * same as a match.
 */
function buildKey(build) {
  const commit = typeof build?.git?.commit === 'string' ? build.git.commit.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{40}$/.test(commit)) return null;
  return `${commit}:${build.git.clean === true ? 'clean' : build.git.clean === false ? 'dirty' : 'unknown'}`;
}

/** How many entries a recorded worktree status holds; null when it was not recorded. */
function worktreeEntryCount(git) {
  if (typeof git?.worktreeStatus !== 'string') return null;
  return git.worktreeStatus.split('\n').filter(line => line.trim() !== '').length;
}

/** Read the git identity of the tree right now, in the shape package.mjs writes. */
async function currentBuildIdentity() {
  const head = await run('git', ['rev-parse', 'HEAD']);
  const commit = head.code === 0 ? head.stdout.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    const reason = (head.stderr || head.stdout).trim().slice(0, 200) || `exit code ${head.code}`;
    return { git: { commit: null, worktreeStatus: null, clean: null, unavailable: reason } };
  }
  const status = await run('git', ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.code !== 0) {
    const reason = (status.stderr || status.stdout).trim().slice(0, 200) || `exit code ${status.code}`;
    return { git: { commit, worktreeStatus: null, clean: null, unavailable: reason } };
  }
  const worktreeStatus = status.stdout.replace(/\r\n/g, '\n');
  return {
    git: {
      commit, worktreeStatus,
      clean: worktreeStatus.split('\n').filter(line => line.trim() !== '').length === 0,
      unavailable: null,
    },
  };
}

/** Read a response body as JSON, keeping the raw text when it is not JSON. */
async function readJson(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200) }; }
}

/** POST to the core with the given credential. */
async function post(endpoint, token, path, body) {
  const response = await fetch(`${endpoint}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-amb-protocol': '1',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await readJson(response) };
}

/**
 * POST over node:http instead of fetch.
 *
 * fetch derives the Host header from the URL and never lets a caller replace it,
 * so the Host check cannot be exercised through it. node:http sends the header it
 * is given, which is what makes the second request door testable.
 */
function postRaw({ port, path, token, body, host, origin }) {
  return new Promise(resolvePost => {
    const headers = {
      authorization: `Bearer ${token}`,
      'x-amb-protocol': '1',
      'content-type': 'application/json',
    };
    if (host) headers.host = host;
    if (origin) headers.origin = origin;
    const request = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.once('end', () => {
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 200) }; }
        resolvePost({ status: response.statusCode, body: parsed });
      });
    });
    // A transport failure is reported as a status the checks can fail on, rather
    // than as an exception that would abort the whole run.
    request.once('error', error => resolvePost({ status: 0, body: { raw: String(error?.code ?? error.message) } }));
    request.end(JSON.stringify(body));
  });
}

/**
 * Load the packaged browser half the way the host does, and report what it did.
 *
 * The DSH browser half is a classic script the host's module loader evaluates and
 * then activates through the module's exported `apply`. That makes three facts
 * worth checking, and none of them is implied by the file's existence: the file
 * is there, it compiles, and activating it really registers the panel into the
 * host's `conversation.view` slot. A missing or broken half is invisible until
 * the panel fails to appear in a live desktop, which is exactly the failure this
 * check exists to catch.
 *
 * No `document` is provided: the registration contract does not depend on the
 * DOM, and a smaller stub is a smaller place to be wrong about the host.
 */
function inspectClientHalf(directory) {
  const file = join(directory, 'client.js');
  const report = {
    file: 'client.js', present: false, syntaxOk: false, applyIsFunction: false,
    declaredSlot: null, registeredSlot: null, registeredId: null, reason: '',
  };
  if (!existsSync(file)) {
    report.reason = '包内缺少 client.js';
    return report;
  }
  report.present = true;
  let source;
  try {
    source = readFileSync(file, 'utf8');
    new Script(source, { filename: file });
    report.syntaxOk = true;
  } catch (error) {
    report.reason = `语法检查未通过：${String(error?.message ?? error).split('\n')[0].slice(0, 160)}`;
    return report;
  }
  let registration;
  const registrations = [];
  try {
    const context = {
      window: { __ModuleLoader__: { load(value) { registration = value; } } },
      console: { warn() {}, log() {}, error() {} },
      encodeURIComponent,
    };
    new Script(source, { filename: file }).runInNewContext(context);
    if (!registration || typeof registration.factory !== 'function') {
      report.reason = '未通过 window.__ModuleLoader__.load 注册模块工厂，宿主无法加载该浏览器半';
      return report;
    }
    const exported = registration.factory(() => ({}));
    report.applyIsFunction = typeof exported?.apply === 'function';
    if (!report.applyIsFunction) {
      report.reason = '模块没有导出 apply，宿主无法激活面板';
      return report;
    }
    exported.apply({
      slots: {
        inject(name, callback) { report.declaredSlot = name; callback(); },
        register(options) { registrations.push(options); },
      },
    });
    report.registeredSlot = registrations[0]?.name ?? null;
    report.registeredId = registrations[0]?.id ?? null;
    if (report.registeredSlot !== 'conversation.view') {
      report.reason = `apply 未注册 conversation.view（实际注册：${report.registeredSlot ?? '无'}）`;
    }
  } catch (error) {
    report.reason = `激活浏览器半时抛出：${String(error?.message ?? error).split('\n')[0].slice(0, 160)}`;
  }
  return report;
}

async function main() {
  // A rerun must produce the same result as a first run. Both the fixture
  // workspace and the data directory are therefore cleared unless --keep asks to
  // preserve them; `init` refuses to overwrite an existing configuration, so a
  // leftover data directory from a previous run would otherwise fail the check.
  if (!values.keep) {
    for (const dir of [workspace, dataDir]) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  }
  mkdirSync(workspace, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const cli = join(root, 'dist', 'src', 'cli.js');
  if (!existsSync(cli)) {
    record('build', '构建产物存在', 'fail', `未找到 ${cli}；先运行 npm run build`);
    return;
  }

  // --- 1. the packaged artifact matches its own manifest -------------------
  const latestPath = join(artifactRoot, 'latest.json');
  if (!existsSync(latestPath)) {
    record('artifact', '打包产物存在', 'fail',
      `未找到 ${relative(root, latestPath).replace(/\\/g, '/')}；先运行 npm run pack:local`);
  } else {
    const latest = JSON.parse(readFileSync(latestPath, 'utf8'));
    const artifactDir = latest.directory;
    const manifestPath = join(artifactDir, 'artifact-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const mismatched = [];
    for (const [rel, hash] of Object.entries(manifest.artifactFiles)) {
      const file = join(artifactDir, rel);
      if (!existsSync(file)) { mismatched.push(`${rel}: 缺失`); continue; }
      const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
      if (actual !== hash) mismatched.push(`${rel}: 哈希不符`);
    }
    record('artifact', '打包产物与其清单一致', mismatched.length ? 'fail' : 'pass',
      mismatched.length ? `${mismatched.length} 个文件不一致` : `${Object.keys(manifest.artifactFiles).length} 个文件哈希全部匹配`,
      { artifact: relative(root, artifactDir), mismatched: mismatched.slice(0, 10) });

    // Hashes prove the artifact matches its own manifest. They do not prove
    // which tree produced it, so a source tree that kept changing after the pack
    // would still pass. The recorded build identity closes that gap: the commit
    // must be the one checked out now, and the tree's dirty state must be the
    // state recorded at pack time.
    const current = await currentBuildIdentity();
    const artifactKey = buildKey(manifest.build);
    const currentKey = buildKey(current);
    const artifactState = {
      commit: typeof manifest.build?.git?.commit === 'string' ? manifest.build.git.commit : null,
      clean: typeof manifest.build?.git?.clean === 'boolean' ? manifest.build.git.clean : null,
    };
    const currentState = { commit: current.git.commit, clean: current.git.clean };
    buildIdentity = {
      artifact: artifactState,
      current: currentState,
      artifactWorktreeEntries: worktreeEntryCount(manifest.build?.git),
      currentWorktreeEntries: worktreeEntryCount(current.git),
      matched: artifactKey !== null && artifactKey === currentKey,
    };
    const stateLabel = key => key === null ? 'unavailable' : key.endsWith(':clean') ? 'clean' : key.endsWith(':dirty') ? 'dirty' : 'unknown';
    if (artifactKey === null) {
      record('same-build', '产物与当前工作树来自同一构建', 'fail',
        `产物清单未记录可用的 build.git.commit，无法证明它出自当前工作树：${manifest.build?.git?.unavailable ?? 'build.git.commit 缺失'}`,
        { buildIdentity });
    } else if (currentKey === null) {
      record('same-build', '产物与当前工作树来自同一构建', 'skip',
        `无法读取当前 git 身份，本项跳过：${current.git.unavailable ?? 'git 不可用'}`,
        { buildIdentity });
    } else {
      record('same-build', '产物与当前工作树来自同一构建', artifactKey === currentKey ? 'pass' : 'fail',
        artifactKey === currentKey
          ? `产物记录的 commit ${current.git.commit}（工作树 ${stateLabel(currentKey)}）与当前工作树一致`
          : `产物记录的 commit ${artifactState.commit}（工作树 ${stateLabel(artifactKey)}）与当前 ${current.git.commit}（工作树 ${stateLabel(currentKey)}）不符；源码在打包后已改动`,
        { buildIdentity });
    }

    // latest.json is what a rerun reads first, so it must not disagree with the
    // manifest it points at. An older latest.json without a build identity is
    // reported by the check above and not repeated here.
    if (latest.build) {
      const latestKey = buildKey(latest.build);
      record('latest-build', 'latest.json 与产物清单记录同一构建',
        latestKey !== null && latestKey === artifactKey ? 'pass' : 'fail',
        latestKey === null
          ? 'latest.json 的 build.git 缺少可用的 commit'
          : latestKey === artifactKey
            ? `两者同为 commit ${latestKey.split(':')[0]}（工作树 ${stateLabel(latestKey)}）`
            : `latest.json 记录 ${latestKey}，产物清单记录 ${artifactKey ?? 'unavailable'}`,
        { latestBuild: { commit: latest.build?.git?.commit ?? null, clean: latest.build?.git?.clean ?? null } });
    }

    // The plugin packages must carry what they import.
    const dshDir = join(artifactDir, 'dsh-plugin');
    const needed = ['index.mjs', 'core-client.mjs', 'log.mjs', 'cordis.patch.yml'];
    const missing = needed.filter(name => !existsSync(join(dshDir, name)));
    record('plugin-files', 'DSH 插件包包含全部被导入的模块', missing.length ? 'fail' : 'pass',
      missing.length ? `缺少：${missing.join(', ')}` : `已包含 ${needed.length} 个必需文件`);

    // The plugin ships a native browser half on purpose (adapters/dsh/client.js):
    // it contributes the knowledge panel to the host's own conversation.view slot
    // instead of embedding a second document. The check therefore verifies that
    // the half is present *and* loadable, never that it is absent — a missing or
    // unloadable half is what leaves the desktop without a panel.
    const dshManifest = JSON.parse(readFileSync(join(dshDir, 'package.json'), 'utf8'));
    const clientDeclarations = [
      dshManifest.dsh?.client ? 'dsh.client' : null,
      dshManifest.exports?.['./client'] ? 'exports["./client"]' : null,
    ].filter(Boolean);
    const clientHalf = inspectClientHalf(dshDir);
    const clientHalfOk = clientDeclarations.length > 0 && clientHalf.present && clientHalf.syntaxOk
      && clientHalf.applyIsFunction && clientHalf.registeredSlot === 'conversation.view';
    let clientHalfDetail;
    if (clientDeclarations.length === 0) {
      clientHalfDetail = '包未声明浏览器半（dsh.client 或 exports["./client"]）：宿主不会加载 client.js，conversation.view 原生面板不会出现';
    } else if (!clientHalf.present) {
      clientHalfDetail = `已声明 ${clientDeclarations.join(' 与 ')} 但包内缺少 client.js：宿主会尝试加载并失败，原生面板不会出现`;
    } else if (!clientHalf.syntaxOk) {
      clientHalfDetail = clientHalf.reason;
    } else if (!clientHalf.applyIsFunction || clientHalf.registeredSlot !== 'conversation.view') {
      clientHalfDetail = clientHalf.reason;
    } else {
      clientHalfDetail = `已声明 ${clientDeclarations.join(' 与 ')}；client.js 通过语法编译，导出 apply，并在 conversation.view 注册视图 ${clientHalf.registeredId}`;
    }
    record('client-half-valid', '浏览器半存在、可编译并能注册原生面板', clientHalfOk ? 'pass' : 'fail',
      clientHalfDetail, { clientHalf, clientDeclarations });
  }

  // --- 2. the bundle patch is accepted by the host's own machinery ---------
  const patchTest = await run(process.execPath, ['--test', 'test/dsh-bundle-patch.test.mjs'], { cwd: root });
  const patchSkipped = /skipped 0/.test(patchTest.stdout) === false && /tests 0/.test(patchTest.stdout);
  record('bundle-patch', '宿主真实补丁机制接受该补丁', patchTest.code === 0 ? 'pass' : (patchSkipped ? 'skip' : 'fail'),
    patchTest.code === 0
      ? '用宿主自己的 cordis-plugin-include 与 YAML 方言解析并应用成功'
      : `测试未通过：${(patchTest.stdout + patchTest.stderr).slice(-300)}`);

  // --- 3. adapters load inside the real host runtime -----------------------
  const runtimeTest = await run(process.execPath, ['--test', 'test/dsh-runtime.test.mjs'], { cwd: root });
  const runtimeSkipped = /skipped 3/.test(runtimeTest.stdout);
  record('runtime-load', '适配器在真实 DSH 运行时中加载与执行', runtimeTest.code === 0 ? (runtimeSkipped ? 'skip' : 'pass') : 'fail',
    runtimeTest.code === 0
      ? (runtimeSkipped ? '未提取桌面运行时，本项跳过' : '真实 Cordis 事件总线与 ToolRuntime 下通过')
      : `测试未通过：${(runtimeTest.stdout + runtimeTest.stderr).slice(-300)}`);

  // --- 4. a real end-to-end round trip against a live core -----------------
  const port = await freePort();
  const init = await run(process.execPath, [cli, 'init', '--data-dir', dataDir, '--project', 'accept', '--port', String(port), '--project-root', workspace]);
  if (init.code !== 0) {
    record('core-init', '初始化隔离数据目录', 'fail', init.stderr.slice(0, 200));
  } else {
    record('core-init', '初始化隔离数据目录', 'pass', `数据目录 ${relative(root, dataDir)}，端口 ${port}`);

    // A fresh install must hold no knowledge of its own.
    const fresh = await run(process.execPath, [cli, 'status', '--data-dir', dataDir]);
    try {
      const stats = JSON.parse(fresh.stdout);
      const empty = stats.entries === 0 && stats.knowledgeRevision === 0 && stats.adoptions === 0;
      record('fresh-empty', '全新安装不含任何预置知识', empty ? 'pass' : 'fail',
        `entries=${stats.entries} revision=${stats.knowledgeRevision} adoptions=${stats.adoptions}`);
    } catch {
      record('fresh-empty', '全新安装不含任何预置知识', 'fail', `无法读取状态：${fresh.stdout.slice(0, 120)}`);
    }

    const server = spawn(process.execPath, [cli, 'serve', '--data-dir', dataDir], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let serverOut = '';
    server.stdout.setEncoding('utf8').on('data', chunk => { serverOut += chunk; });
    server.stderr.setEncoding('utf8').on('data', chunk => { serverOut += chunk; });
    // Subscribe before doing any asynchronous work. Attaching only in finally
    // misses an early close and leaves an unresolved promise; Node can then exit
    // successfully without ever writing the acceptance report.
    const serverClosed = new Promise(resolveClosed => {
      server.once('close', resolveClosed);
      server.once('error', error => { serverOut += `\n${error.code ?? 'spawn_failed'}`; resolveClosed(); });
    });

    try {
      const endpoints = await new Promise(resolveEndpoints => {
        const deadline = Date.now() + 15000;
        const poll = setInterval(() => {
          if (existsSync(join(dataDir, 'core.json'))) { clearInterval(poll); resolveEndpoints(true); }
          else if (Date.now() > deadline) { clearInterval(poll); resolveEndpoints(false); }
        }, 200);
      });
      // Give the listener a moment to bind after the config file appears.
      await new Promise(r => setTimeout(r, 1200));
      const core = JSON.parse(readFileSync(join(dataDir, 'core.json'), 'utf8'));
      const token = core.clients.find(c => c.id === 'dsh').token;

      // Health, without a credential.
      let healthy = false;
      try {
        const health = await fetch(`http://127.0.0.1:${port}/health`);
        healthy = health.ok;
      } catch { /* reported below */ }
      record('core-health', '核心在环回地址上可访问', healthy ? 'pass' : 'fail',
        healthy ? `http://127.0.0.1:${port}/health 回应正常` : '无法访问 /health');

      // Credential enforcement: the two failures a real host would hit.
      const noOrigin = await post(`http://127.0.0.1:${port}`, token, '/v1/stats', { projectId: 'accept' });
      record('auth-ok', '带正确凭据的请求被接受', noOrigin.status === 200 ? 'pass' : 'fail', `HTTP ${noOrigin.status}`);

      const wrongToken = await fetch(`http://127.0.0.1:${port}/v1/stats`, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + 'z'.repeat(64), 'x-amb-protocol': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: 'accept' }),
      });
      record('auth-reject', '错误凭据被拒绝', wrongToken.status === 401 ? 'pass' : 'fail', `HTTP ${wrongToken.status}`);

      // A browser request from another site must stay refused. This is the real
      // boundary the core draws (src/server.ts:135-136): it is an app's backend,
      // and a page from anywhere but loopback must not be able to drive it.
      const foreignOrigin = await postRaw({
        port, path: '/v1/stats', token, body: { projectId: 'accept' }, origin: 'https://attacker.invalid',
      });
      const foreignOriginRefused = foreignOrigin.status === 403 && foreignOrigin.body.code === 'origin_denied';
      record('origin-refused', '非回环 Origin 的浏览器式请求被拒绝',
        foreignOriginRefused ? 'pass' : 'fail',
        foreignOriginRefused
          ? `HTTP ${foreignOrigin.status} origin_denied（Origin: https://attacker.invalid）`
          : `期望 403 origin_denied，实际 HTTP ${foreignOrigin.status} ${foreignOrigin.body.code ?? foreignOrigin.body.raw ?? ''}`);

      // A loopback Origin is admitted *on purpose*, and this check pins that down
      // so a later tightening reads as a design change rather than a regression.
      // src/server.ts:129-134 gives the reason: the management page is embedded in
      // the DSH desktop on another loopback port, and a browser sends Origin on its
      // own POSTs even same-origin, so refusing every loopback Origin blanks every
      // tab. The Host door below still refuses a non-loopback host, so a name that
      // resolves to 127.0.0.1 is turned away for two independent reasons.
      const loopbackOrigin = await postRaw({
        port, path: '/v1/stats', token, body: { projectId: 'accept' }, origin: 'http://127.0.0.1:9999',
      });
      const loopbackOriginAdmitted = loopbackOrigin.status === 200;
      record('origin-loopback-admitted', '回环 Origin 被有意放行（设计如此，非回归）',
        loopbackOriginAdmitted ? 'pass' : 'fail',
        loopbackOriginAdmitted
          ? 'HTTP 200：设计允许任意回环端口的 Origin（同源 POST 也带 Origin，DSH 桌面把页面嵌在另一个回环端口，全拒会让界面空白）；非回环 Origin 与非回环 Host 仍被拒绝'
          : `HTTP ${loopbackOrigin.status}：Origin 策略已收紧。这是设计变更而不是回归——请同步修改 src/server.ts:129-136 的注释、桌面端与本文档，而不是把本项期望值改回去`);

      // The Host door is the second, independent check: a name that resolves to
      // 127.0.0.1 must not pass by DNS. `fetch` derives Host from the URL and
      // ignores a caller-supplied one, so this request goes out over node:http.
      const foreignHost = await postRaw({
        port, path: '/v1/stats', token, body: { projectId: 'accept' }, host: 'attacker.invalid',
      });
      const foreignHostRefused = foreignHost.status === 403 && foreignHost.body.code === 'host_denied';
      record('host-refused', '非回环 Host 头被拒绝',
        foreignHostRefused ? 'pass' : 'fail',
        foreignHostRefused
          ? `HTTP ${foreignHost.status} host_denied（Host: attacker.invalid）`
          : `期望 403 host_denied，实际 HTTP ${foreignHost.status} ${foreignHost.body.code ?? foreignHost.body.raw ?? ''}`);

      // Cross-project access must be refused.
      const crossProject = await post(`http://127.0.0.1:${port}`, token, '/v1/stats', { projectId: 'someone-else' });
      record('project-isolation', '凭据不能跨项目访问', crossProject.status === 403 ? 'pass' : 'fail', `HTTP ${crossProject.status}`);

      // Core-side log written and readable.
      const logs = await run(process.execPath, [cli, 'logs', '--data-dir', dataDir, '--json']);
      let logRecords = [];
      try { logRecords = JSON.parse(logs.stdout); } catch { /* reported below */ }
      record('core-log', '核心写入可读的运行日志', logRecords.length > 0 ? 'pass' : 'fail',
        `${logRecords.length} 条记录：${[...new Set(logRecords.map(r => r.event))].join(', ').slice(0, 120)}`);

      // Self-check must pass against this live core.
      const doctor = await run(process.execPath, [cli, 'doctor', '--data-dir', dataDir, '--json']);
      try {
        const report = JSON.parse(doctor.stdout);
        const failures = report.checks.filter(c => c.status === 'fail');
        record('self-check', '自检对照运行中的核心通过', report.ok ? 'pass' : 'fail',
          report.ok ? `共 ${report.checks.length} 项检查，无阻塞问题` : `失败项：${failures.map(c => c.id).join(', ')}`);
        // The credential must never appear in the report.
        const leaked = doctor.stdout.includes(token);
        record('no-credential-leak', '自检输出不含凭据', leaked ? 'fail' : 'pass',
          leaked ? '自检输出包含凭据原文' : '凭据只以形态形式出现（长度与前缀）');
      } catch {
        record('self-check', '自检对照运行中的核心通过', 'fail', `无法解析自检输出：${doctor.stdout.slice(0, 120)}`);
      }

      record('core-output', '核心启动输出包含监听地址', serverOut.includes('listening') ? 'pass' : 'fail',
        serverOut.split('\n')[0].slice(0, 140));
    } finally {
      if (server.exitCode === null && server.signalCode === null) server.kill();
      await serverClosed;
    }
  }
}

function finishReport() {
  // --- 5. steps only a person can perform ---------------------------------
  const manual = [
    ['codex-load', 'Codex 桌面加载插件', '打开测试工作区（不要用正在工作的仓库），通过本地 marketplace 加载插件，并在信任提示出现时审阅并信任 hooks。未信任不算通过。',
      '插件出现在列表中的截图 + 信任确认后的状态截图'],
    ['codex-inject', 'Codex 自动注入上下文', '在该工作区新建会话，输入：查找本地流程资料，并说明开始前的检查。',
      '会话中出现来源标记为 agent-memory-backpack 的注入内容；仅模型自述不足为证'],
    ['dsh-load', 'DSH 桌面加载插件', '在“设置 → 插件”通过本地包入口加载 dsh-plugin。不要运行 dsh plugin --profile desktop，也不要手工 insert（包自带 bundle patch）。',
      '插件页显示已安装/已启用的截图'],
    ['dsh-inject', 'DSH 自动注入上下文', '在同一工作区新建会话，使用相同的自然语言请求。',
      '同上：注入内容须来自适配器而非模型自述'],
    ['gate-deny', '规范门禁确实阻止调用', '先取到桌面实际传递的工具名，再在测试库加入只禁止该无副作用测试调用的规范，然后尝试调用。',
      '工具未执行 + 桌面显示拒绝原因'],
    ['disable', '停用后不再生效', '通过各自 UI 停用插件，在新会话核查。',
      '不再注入上下文、不再提供工具；记录是否需要重启宿主'],
  ];
  for (const [id, title, how, evidence] of manual) {
    record(id, title, 'manual', how, { evidence });
  }

  // --- report --------------------------------------------------------------
  const counts = results.reduce((acc, item) => { acc[item.status] = (acc[item.status] ?? 0) + 1; return acc; }, {});
  /**
   * Describe a directory portably.
   *
   * `relative` only helps while the path is inside the repository; a fixture in a
   * temporary directory yields a `..`-prefixed path that still names the machine.
   * Such paths are reduced to their last two segments, which is enough to tell
   * two fixtures apart without disclosing the layout.
   */
  const portable = value => {
    const rel = relative(root, value);
    return rel.startsWith('..') || /^[A-Za-z]:/.test(rel)
      ? `…/${value.split(/[\\/]/).filter(Boolean).slice(-2).join('/')}`
      : rel;
  };
  const report = {
    format: 'agent-memory-backpack-acceptance-v1',
    ranAt: new Date().toISOString(),
    workspace: portable(workspace),
    dataDir: portable(dataDir),
    // Which commit the artifact claims and which one is checked out now, so a
    // human can re-check the same-build verdict without re-running the script.
    buildIdentity,
    summary: {
      pass: counts.pass ?? 0, fail: counts.fail ?? 0,
      skip: counts.skip ?? 0, manual: counts.manual ?? 0,
      automatedOk: (counts.fail ?? 0) === 0,
    },
    // Manual items are the point of the report: they are what remains.
    results,
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  const reportJson = JSON.stringify(report, null, 2);
  // Last line of defence: the report is written to be shareable, so refuse to
  // emit one that still carries a machine-specific path. Failing loudly here is
  // better than handing the user something that leaks their layout. A URL is not
  // a drive: only a letter followed by one separator that is not the start of
  // `//` counts, and loopback endpoints were never paths to begin with.
  const stray = [...reportJson.matchAll(/[A-Za-z]:(?:\\+|\/(?!\/))[^\s"']*/g)]
    .map(match => match[0])
    .filter(path => !/^[A-Za-z]:(?:\\+|\/(?!\/))(127\.0\.0\.1|localhost)/.test(path));
  if (stray.length > 0 && !values.keep) {
    process.stderr.write(`报告仍含本机绝对路径，已拒绝写出：${[...new Set(stray)].slice(0, 3).join(', ')}\n`);
    process.exitCode = 1;
    return;
  }
  writeFileSync(reportPath, reportJson, 'utf8');

  if (values.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    const tag = { pass: '通过', fail: '失败', skip: '跳过', manual: '需人工' };
    process.stdout.write(`桌面验收：${reportPath.replace(root + '\\', '')}\n\n`);
    for (const item of results) {
      process.stdout.write(`[${tag[item.status]}] ${item.title}\n`);
      process.stdout.write(`        ${item.detail}\n`);
      if (item.evidence) process.stdout.write(`        证据：${item.evidence}\n`);
    }
    process.stdout.write(`\n自动项 通过=${report.summary.pass} 失败=${report.summary.fail} 跳过=${report.summary.skip}；需人工 ${report.summary.manual} 项\n`);
    process.stdout.write(report.summary.automatedOk
      ? '所有可自动化的检查均已通过。剩余项需要你在两个桌面中各点击一次。\n'
      : '自动检查存在失败项，请先按上面的说明处理。\n');
  }

  if (!values.keep) {
    // The fixture is disposable; the report is the artifact that matters.
    rmSync(workspace, { recursive: true, force: true });
  }
  process.exitCode = report.summary.automatedOk ? 0 : 1;
}

try { await main(); }
catch (error) {
  record('runner-error', '验收执行异常', 'fail', `${error?.name ?? 'Error'}: ${error?.code ?? 'runner_exception'}；未完成的自动检查不得视为通过`);
}
finally { finishReport(); }
