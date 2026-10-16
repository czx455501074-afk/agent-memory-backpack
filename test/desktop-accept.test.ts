import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The desktop acceptance runner is the artefact a human acts on, so its own
 * behaviour is tested: it must run unattended, be repeatable, produce a usable
 * report, and never claim that the manual steps are done.
 */
function runAccept(args: string[], timeoutMs = 180_000, preload?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>(resolveRun => {
    const child = spawn(process.execPath, [...(preload ? ['--import', pathToFileURL(preload).href] : []), join(repoRoot, 'scripts', 'desktop-accept.mjs'), ...args], {
      cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once('close', code => { clearTimeout(timer); resolveRun({ code, stdout, stderr, timedOut }); });
  });
}

test('桌面验收脚本可无人值守运行，报告区分自动项与人工项', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'amb-accept-'));
  const workspace = join(fixture, 'ws');
  const dataDir = join(fixture, 'data');
  const reportPath = join(fixture, 'report.json');
  t.after(async () => {
    const rel = relative(resolve(tmpdir()), resolve(fixture));
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    await rm(fixture, { recursive: true, force: true });
  });

  const result = await runAccept(['--workspace', workspace, '--data-dir', dataDir, '--report', reportPath, '--keep']);
  assert.equal(result.timedOut, false, `脚本不得超时：${result.stdout.slice(-300)}`);
  assert.equal(existsSync(reportPath), true, `必须输出报告文件；code=${result.code}; stderr=${result.stderr.slice(-1000)}; stdout=${result.stdout.slice(-1000)}`);

  const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
    summary: { pass: number; fail: number; skip: number; manual: number; automatedOk: boolean };
    results: Array<{ id: string; status: string; detail: string; evidence?: string }>;
  };

  // Every run reports both kinds of item; a report without manual items would
  // hide the fact that desktop loading is still unverified.
  assert.ok(report.summary.manual > 0, '报告必须列出需人工完成的步骤');
  const manual = report.results.filter(item => item.status === 'manual');
  for (const item of manual) {
    assert.ok(item.detail.length > 0, `人工项 ${item.id} 必须说明怎么做`);
    assert.ok(item.evidence, `人工项 ${item.id} 必须说明留什么证据`);
  }

  // The runner must not pass an automatable check it could not perform.
  for (const item of report.results) {
    assert.ok(['pass', 'fail', 'skip', 'manual'].includes(item.status), `未知状态：${item.status}`);
  }

  // A failing automated check must be visible rather than swallowed.
  assert.equal(report.summary.automatedOk, report.summary.fail === 0,
    'automatedOk 必须与失败计数一致');
  // Exit code reflects only automatable outcomes.
  assert.equal(result.code, report.summary.automatedOk ? 0 : 1,
    `退出码应与自动项结果一致，实际 ${result.code}`);
});

test('isolated core exiting before cleanup still produces a failing report instead of silently losing it', async t => {
  const fixture=await mkdtemp(join(tmpdir(),'amb-accept-early-exit-'));
  t.after(async()=>{
    const rel=relative(resolve(tmpdir()),resolve(fixture));assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));
    await rm(fixture,{recursive:true,force:true});
  });
  const preload=join(fixture,'exit-core.mjs'),reportPath=join(fixture,'report.json');
  // Patch only this disposable runner process, never a real profile or core.
  // All normal checks still run; its isolated `serve` child exits immediately.
  await writeFile(preload, `import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const original=cp.spawn;
cp.spawn=function(command,args,options){
  return args?.includes('serve') ? original(command,['-e','process.exit(23)'],options) : original(command,args,options);
};
syncBuiltinESMExports();\n`);
  const result=await runAccept(['--workspace',join(fixture,'ws'),'--data-dir',join(fixture,'data'),'--report',reportPath],30000,preload);
  assert.equal(result.timedOut,false);assert.equal(result.code,1,`${result.stderr}\n${result.stdout}`);
  assert.equal(existsSync(reportPath),true,`${result.stderr}\n${result.stdout}`);
  const report=JSON.parse(await readFile(reportPath,'utf8'));
  assert.equal(report.summary.automatedOk,false);assert.ok(report.summary.fail>0);assert.ok(report.summary.manual>0);
});

test('桌面验收脚本可重复运行且结果稳定', async t => {
  // A rerun must not fail because the previous run left a data directory behind:
  // `init` refuses to overwrite an existing configuration.
  const fixture = await mkdtemp(join(tmpdir(), 'amb-accept-repeat-'));
  const workspace = join(fixture, 'ws');
  const dataDir = join(fixture, 'data');
  const first = join(fixture, 'first.json');
  const second = join(fixture, 'second.json');
  t.after(async () => {
    const rel = relative(resolve(tmpdir()), resolve(fixture));
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    await rm(fixture, { recursive: true, force: true });
  });

  const a = await runAccept(['--workspace', workspace, '--data-dir', dataDir, '--report', first]);
  const b = await runAccept(['--workspace', workspace, '--data-dir', dataDir, '--report', second]);
  assert.equal(a.timedOut || b.timedOut, false, '两次运行都不得超时');
  for (const [path, result] of [[first,a],[second,b]] as const)
    assert.equal(existsSync(path),true,`必须输出每次报告；code=${result.code}; stderr=${result.stderr.slice(-1000)}; stdout=${result.stdout.slice(-1000)}`);

  const reportA = JSON.parse(await readFile(first, 'utf8')) as { summary: { pass: number; fail: number } };
  const reportB = JSON.parse(await readFile(second, 'utf8')) as { summary: { pass: number; fail: number } };
  assert.equal(reportB.summary.fail, reportA.summary.fail, '二次运行不得因残留状态而多出失败');
  assert.equal(reportB.summary.pass, reportA.summary.pass, '两次运行的通过数应一致');
});

test('验收报告不含凭据，也不含本机绝对路径', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'amb-accept-secret-'));
  const reportPath = join(fixture, 'report.json');
  t.after(async () => {
    const rel = relative(resolve(tmpdir()), resolve(fixture));
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    await rm(fixture, { recursive: true, force: true });
  });

  await runAccept(['--workspace', join(fixture, 'ws'), '--data-dir', join(fixture, 'data'), '--report', reportPath]);
  const text = await readFile(reportPath, 'utf8');

  // The report is meant to be pasted into an issue, so it must be safe to share.
  assert.equal(/Bearer\s+[A-Za-z0-9]{32,}/.test(text), false, '报告不得包含 bearer 令牌');
  assert.equal(/[a-f0-9]{64}/.test(text), false, '报告不得包含 64 位十六进制凭据');

  // A machine-specific path leaks the author's layout and is useless to a reader
  // on another machine. Loopback endpoints are fine; file paths are not. A URL is
  // neither: only a letter followed by a separator that is not the start of `//`
  // counts as a drive, so `https://…` quoted as evidence survives.
  const absolutePaths = [...text.matchAll(/[A-Za-z]:(?:\\+|\/(?!\/))[A-Za-z][^\s"']*/g)]
    .map(match => match[0])
    .filter(path => !/^[A-Za-z]:(?:\\+|\/(?!\/))(?:127\.0\.0\.1|localhost)/.test(path));
  assert.deepEqual([...new Set(absolutePaths)], [], '报告不得包含本机绝对路径');
});

/** Read git output exactly as the acceptance runner does, so both agree on it. */
function gitOutput(args: string[]): Promise<string> {
  return new Promise((resolveRun, reject) => {
    const child = spawn('git', args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0
      ? resolveRun(stdout)
      : reject(new Error(`git ${args.join(' ')} failed (${code}): ${stderr.slice(0, 200)}`)));
  });
}

type AcceptanceReport = {
  summary: { pass: number; fail: number; skip: number; manual: number; automatedOk: boolean };
  results: Array<{ id: string; status: string; detail: string; evidence?: string }>;
  buildIdentity: {
    artifact: { commit: string | null; clean: boolean | null };
    current: { commit: string | null; clean: boolean | null };
    matched: boolean;
  };
};

type GitIdentity = { commit: string; worktreeStatus: string; clean: boolean };

/**
 * A minimal but real browser half: the host's module loader hands the factory to
 * `window.__ModuleLoader__.load`, and activating the exported `apply` registers
 * the panel into the host's own slot. The acceptance runner evaluates exactly
 * this shape, so a fixture that registers nothing must not pass.
 */
const CLIENT_HALF_FIXTURE = `window.__ModuleLoader__.load({
  id: "amb-accept-fixture",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var SLOT = "conversation.view";
    var VIEW = "amb-knowledge-view";
    exports.inject = ["slots"];
    exports.apply = (ctx) => {
      ctx.slots.inject(SLOT, () => {
        ctx.slots.register({ name: SLOT, id: VIEW, order: 25, label: () => "AMB 知识库" }, function Panel() { return null; });
      });
    };
    return module.exports;
  },
});
`;

/** The same declaration with a syntax error, which only a real compile can catch. */
const CLIENT_HALF_BROKEN = `window.__ModuleLoader__.load({ id: "amb-accept-fixture", factory: (require) => { var broken = ; } });\n`;

/** How the fixture's plugin package carries its browser half. */
type ClientHalfShape = 'valid' | 'missing' | 'broken';

/**
 * Write a minimal but complete artifact fixture. The hashes are real, so the
 * content check passes on its own and only the build identity can decide the
 * same-build question. `latestGit` defaults to `manifestGit`; passing a
 * different one models a latest.json that disagrees with the manifest it points
 * at. `clientHalf` picks the shape of the browser half: a valid one, one the
 * package declares but does not contain, or one that cannot be compiled.
 */
async function writeArtifactFixture(
  artifactRoot: string,
  artifactDir: string,
  manifestGit: GitIdentity,
  latestGit: GitIdentity = manifestGit,
  clientHalf: ClientHalfShape = 'valid',
): Promise<void> {
  const dshDir = join(artifactDir, 'dsh-plugin');
  // Start from an empty package directory: a shape that omits a file must really
  // omit it rather than inherit whatever a previous fixture wrote there.
  await rm(dshDir, { recursive: true, force: true });
  await mkdir(dshDir, { recursive: true });
  const pluginFiles: Record<string, string> = {
    'index.mjs': 'export const name = "artifact-fixture";\n',
    'core-client.mjs': 'export const client = null;\n',
    'log.mjs': 'export const log = () => {};\n',
    'cordis.patch.yml': 'patch: []\n',
    // The declaration stays in place for every shape: a package that ships no
    // browser half at all is a different failure and is not what this models.
    'package.json': JSON.stringify({
      name: '@amb/dsh-plugin-fixture',
      version: '0.0.0',
      exports: { '.': './index.mjs', './client': './client.js' },
      dsh: { client: { platform: 'web' } },
    }, null, 2),
  };
  if (clientHalf !== 'missing') {
    pluginFiles['client.js'] = clientHalf === 'broken' ? CLIENT_HALF_BROKEN : CLIENT_HALF_FIXTURE;
  }
  const artifactFiles: Record<string, string> = {};
  for (const [name, body] of Object.entries(pluginFiles)) {
    await writeFile(join(dshDir, name), body, 'utf8');
    artifactFiles[`dsh-plugin/${name}`] = createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex');
  }
  const buildOf = (git: GitIdentity) =>
    ({ git, node: process.version, packageVersion: '0.0.0-fixture', packagedAt: new Date().toISOString() });
  await writeFile(join(artifactDir, 'artifact-manifest.json'), JSON.stringify({
    format: 'agent-memory-backpack-artifact-hashes-v1',
    packageVersion: '0.0.0-fixture',
    sourceFiles: {},
    artifactFiles,
    copiedTreesVerified: [],
    build: buildOf(manifestGit),
  }, null, 2), 'utf8');
  await writeFile(join(artifactRoot, 'latest.json'), JSON.stringify({
    directory: artifactDir, phase: 'P0', desktopVerified: false, build: buildOf(latestGit),
  }, null, 2), 'utf8');
}

test('产物记录的构建身份必须与当前工作树一致，被篡改的 build.git 判定失败', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'amb-accept-build-'));
  const artifactRoot = join(fixture, 'artifacts');
  const artifactDir = join(artifactRoot, 'p0-fixture');
  const okReportPath = join(fixture, 'ok.json');
  const badReportPath = join(fixture, 'bad.json');
  t.after(async () => {
    const rel = relative(resolve(tmpdir()), resolve(fixture));
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    await rm(fixture, { recursive: true, force: true });
  });

  // The fixture claims the identity of the tree the test runs in, which is what
  // a fresh pack would have recorded.
  const commit = (await gitOutput(['rev-parse', 'HEAD'])).trim().toLowerCase();
  const worktreeStatus = (await gitOutput(['status', '--porcelain=v1', '--untracked-files=all'])).replace(/\r\n/g, '\n');
  const clean = worktreeStatus.split('\n').filter(line => line.trim() !== '').length === 0;
  assert.match(commit, /^[0-9a-f]{40}$/, '同一构建用例必须在 git 仓库内运行');

  const identity: GitIdentity = { commit, worktreeStatus, clean };
  await writeArtifactFixture(artifactRoot, artifactDir, identity);
  const args = (report: string) => ['--artifact-dir', artifactRoot, '--workspace', join(fixture, 'ws'),
    '--data-dir', join(fixture, 'data'), '--report', report];

  const ok = await runAccept(args(okReportPath));
  assert.equal(ok.timedOut, false, `脚本不得超时：${ok.stdout.slice(-300)}`);
  assert.equal(existsSync(okReportPath), true, `必须输出报告；code=${ok.code}; stderr=${ok.stderr.slice(-600)}`);
  const okReport = JSON.parse(await readFile(okReportPath, 'utf8')) as AcceptanceReport;
  const okBuild = okReport.results.find(item => item.id === 'same-build');
  assert.ok(okBuild, `报告必须包含 same-build 检查：${ok.stdout.slice(-500)}`);
  assert.equal(okBuild.status, 'pass', `同一构建校验应通过：${okBuild.detail}`);
  assert.equal(okReport.results.find(item => item.id === 'latest-build')?.status, 'pass',
    'latest.json 与清单记录同一构建时应通过');
  assert.equal(okReport.buildIdentity.matched, true);
  assert.equal(okReport.buildIdentity.artifact.commit, commit);
  assert.equal(okReport.buildIdentity.current.commit, commit);
  assert.equal(okReport.buildIdentity.current.clean, clean);

  // Same artifact content, a different claimed commit, and a latest.json that
  // still carries the real one: the hashes still match, so only the build
  // identity can catch either disagreement.
  await writeArtifactFixture(artifactRoot, artifactDir, { ...identity, commit: 'b'.repeat(40) }, identity);
  const bad = await runAccept(args(badReportPath));
  assert.equal(bad.timedOut, false, `脚本不得超时：${bad.stdout.slice(-300)}`);
  assert.equal(existsSync(badReportPath), true, `必须输出报告；code=${bad.code}; stderr=${bad.stderr.slice(-600)}`);
  const badReport = JSON.parse(await readFile(badReportPath, 'utf8')) as AcceptanceReport;
  const badBuild = badReport.results.find(item => item.id === 'same-build');
  assert.ok(badBuild, `报告必须包含 same-build 检查：${bad.stdout.slice(-500)}`);
  assert.equal(badBuild.status, 'fail', `构建身份不符必须失败：${badBuild.detail}`);
  assert.equal(badReport.results.find(item => item.id === 'latest-build')?.status, 'fail',
    'latest.json 与清单不一致必须失败');
  assert.equal(badReport.results.find(item => item.id === 'artifact')?.status, 'pass',
    '篡改构建身份后哈希仍然匹配，证明该校验的是身份而不是内容');
  assert.equal(badReport.buildIdentity.matched, false);
  assert.equal(badReport.buildIdentity.artifact.commit, 'b'.repeat(40));
  assert.equal(badReport.buildIdentity.current.commit, commit);
  assert.equal(badReport.summary.automatedOk, false);
  assert.equal(bad.code, 1, `构建身份失败必须反映在退出码上，实际 ${bad.code}`);

  // An artifact packed before build identities existed. Nothing can be proven
  // about it, so the same-build check fails, while a latest.json without a build
  // field is not an error in itself.
  type ManifestShape = { build?: unknown; artifactFiles: Record<string, string> };
  const legacyManifest = JSON.parse(await readFile(join(artifactDir, 'artifact-manifest.json'), 'utf8')) as ManifestShape;
  delete legacyManifest.build;
  await writeFile(join(artifactDir, 'artifact-manifest.json'), JSON.stringify(legacyManifest, null, 2), 'utf8');
  await writeFile(join(artifactRoot, 'latest.json'), JSON.stringify({
    directory: artifactDir, phase: 'P0', desktopVerified: false,
  }, null, 2), 'utf8');
  const legacyReportPath = join(fixture, 'legacy.json');
  const legacy = await runAccept(args(legacyReportPath));
  assert.equal(legacy.timedOut, false, `脚本不得超时：${legacy.stdout.slice(-300)}`);
  const legacyReport = JSON.parse(await readFile(legacyReportPath, 'utf8')) as AcceptanceReport;
  const legacyBuild = legacyReport.results.find(item => item.id === 'same-build');
  assert.ok(legacyBuild, `报告必须包含 same-build 检查：${legacy.stdout.slice(-500)}`);
  assert.equal(legacyBuild.status, 'fail', '旧产物没有 build 身份时必须判失败');
  assert.match(legacyBuild.detail, /缺失|不可用/, `失败原因必须说清缺失项：${legacyBuild.detail}`);
  assert.equal(legacyReport.results.find(item => item.id === 'latest-build'), undefined,
    'latest.json 不带 build 字段时不额外记一项');
  assert.equal(legacyReport.buildIdentity.matched, false);
  assert.equal(legacy.code, 1, `缺少构建身份必须反映在退出码上，实际 ${legacy.code}`);
});

test('浏览器半必须存在、可编译并注册 conversation.view，缺失或语法错误都判失败', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'amb-accept-client-'));
  const artifactRoot = join(fixture, 'artifacts');
  const artifactDir = join(artifactRoot, 'p0-fixture');
  t.after(async () => {
    const rel = relative(resolve(tmpdir()), resolve(fixture));
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    await rm(fixture, { recursive: true, force: true });
  });

  const commit = (await gitOutput(['rev-parse', 'HEAD'])).trim().toLowerCase();
  const worktreeStatus = (await gitOutput(['status', '--porcelain=v1', '--untracked-files=all'])).replace(/\r\n/g, '\n');
  const clean = worktreeStatus.split('\n').filter(line => line.trim() !== '').length === 0;
  const identity: GitIdentity = { commit, worktreeStatus, clean };
  const args = (report: string) => ['--artifact-dir', artifactRoot, '--workspace', join(fixture, 'ws'),
    '--data-dir', join(fixture, 'data'), '--report', report];
  const acceptance = async (shape: ClientHalfShape, name: string) => {
    await writeArtifactFixture(artifactRoot, artifactDir, identity, identity, shape);
    const reportPath = join(fixture, `${name}.json`);
    const result = await runAccept(args(reportPath));
    assert.equal(result.timedOut, false, `脚本不得超时：${result.stdout.slice(-300)}`);
    assert.equal(existsSync(reportPath), true, `必须输出报告；code=${result.code}; stderr=${result.stderr.slice(-600)}`);
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as AcceptanceReport;
    const item = report.results.find(entry => entry.id === 'client-half-valid');
    assert.ok(item, `报告必须包含 client-half-valid 检查：${result.stdout.slice(-500)}`);
    return { item, report };
  };

  // The plugin ships a native browser half on purpose. A fixture whose half
  // compiles and really registers the panel is what the current design looks
  // like, so demanding its absence would now fail a healthy package.
  const valid = await acceptance('valid', 'valid');
  assert.equal(valid.item.status, 'pass', `有效浏览器半必须通过：${valid.item.detail}`);
  assert.match(valid.item.detail, /conversation\.view/, 'detail 必须写明注册的插槽');
  assert.match(valid.item.detail, /amb-knowledge-view/, 'detail 必须写明注册的视图 id');
  assert.equal(valid.report.results.some(entry => entry.id === 'no-client-half'), false,
    '旧的「不得有浏览器半」断言必须已被替换');

  // Declared but not packaged: the host would try to load a file that is not
  // there, so this fails even though every packaged file matches its hash.
  const missing = await acceptance('missing', 'missing');
  assert.equal(missing.item.status, 'fail', `缺少 client.js 必须失败：${missing.item.detail}`);
  assert.match(missing.item.detail, /client\.js/, '失败原因必须指出缺失的文件');
  assert.equal(missing.report.results.find(entry => entry.id === 'artifact')?.status, 'pass',
    '清单内文件仍然一致，缺失只应记在浏览器半一项上');

  // Present and hashed, but not compilable: existence alone must not pass.
  const broken = await acceptance('broken', 'broken');
  assert.equal(broken.item.status, 'fail', `语法错误必须失败：${broken.item.detail}`);
  assert.match(broken.item.detail, /语法/, '失败原因必须说明编译未通过');
  assert.equal(broken.report.results.find(entry => entry.id === 'artifact')?.status, 'pass',
    '语法失败与清单哈希无关，两者必须分开报告');
});

/**
 * Rewrite this disposable runner process's HTTP requests so both origin verdicts
 * invert: a foreign origin is admitted, a loopback origin is refused. A check
 * that cannot fail proves nothing, so the negative direction is tested next to
 * the real one. Only the two origin requests are touched; everything else — the
 * Host door included — still goes to the live isolated core.
 */
function originSpoofPreload(): string {
  return `import { EventEmitter } from 'node:events';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
const original = http.request;
http.request = function (options, callback) {
  const headers = (options && options.headers) || {};
  const foreign = headers.origin === 'https://attacker.invalid';
  const loopback = headers.origin === 'http://127.0.0.1:9999';
  if (!foreign && !loopback) return original.apply(this, arguments);
  const response = new EventEmitter();
  response.statusCode = foreign ? 200 : 403;
  response.setEncoding = () => {};
  response.resume = () => {};
  const request = new EventEmitter();
  request.end = () => {
    setImmediate(() => {
      callback(response);
      response.emit('data', '{}');
      response.emit('end');
    });
  };
  return request;
};
syncBuiltinESMExports();
`;
}

test('非回环 Origin 与 Host 被拒绝，回环 Origin 被有意放行', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'amb-accept-origin-'));
  const artifactRoot = join(fixture, 'artifacts');
  const artifactDir = join(artifactRoot, 'p0-fixture');
  t.after(async () => {
    const rel = relative(resolve(tmpdir()), resolve(fixture));
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    await rm(fixture, { recursive: true, force: true });
  });

  const commit = (await gitOutput(['rev-parse', 'HEAD'])).trim().toLowerCase();
  const worktreeStatus = (await gitOutput(['status', '--porcelain=v1', '--untracked-files=all'])).replace(/\r\n/g, '\n');
  const clean = worktreeStatus.split('\n').filter(line => line.trim() !== '').length === 0;
  await writeArtifactFixture(artifactRoot, artifactDir, { commit, worktreeStatus, clean });
  const args = (report: string) => ['--artifact-dir', artifactRoot, '--workspace', join(fixture, 'ws'),
    '--data-dir', join(fixture, 'data'), '--report', report];

  // Against the real core: the security boundary holds and the loopback
  // admission is recorded as the deliberate design it is.
  const okPath = join(fixture, 'ok.json');
  const ok = await runAccept(args(okPath));
  assert.equal(ok.timedOut, false, `脚本不得超时：${ok.stdout.slice(-300)}`);
  assert.equal(existsSync(okPath), true, `必须输出报告；code=${ok.code}; stderr=${ok.stderr.slice(-600)}`);
  const okReport = JSON.parse(await readFile(okPath, 'utf8')) as AcceptanceReport;

  const foreign = okReport.results.find(item => item.id === 'origin-refused');
  assert.ok(foreign, `报告必须包含 origin-refused：${ok.stdout.slice(-500)}`);
  assert.equal(foreign.status, 'pass', `非回环 Origin 必须被拒绝：${foreign.detail}`);
  assert.match(foreign.detail, /403/, 'detail 必须记录真实状态码');
  assert.match(foreign.detail, /https:\/\/attacker\.invalid/,
    '被拒绝的外部 Origin 必须作为证据原样保留，不被路径清洗改写');

  const loopback = okReport.results.find(item => item.id === 'origin-loopback-admitted');
  assert.ok(loopback, `报告必须包含 origin-loopback-admitted：${ok.stdout.slice(-500)}`);
  assert.equal(loopback.status, 'pass', `回环 Origin 按当前设计必须被放行：${loopback.detail}`);
  assert.match(loopback.detail, /设计/, 'detail 必须写明这是设计而不是偶然');
  assert.match(loopback.detail, /同源/, 'detail 必须写明同源 POST 也带 Origin 的理由');
  assert.match(loopback.detail, /Host/, 'detail 必须指出 Host 校验仍然独立生效');

  const host = okReport.results.find(item => item.id === 'host-refused');
  assert.ok(host, `报告必须包含 host-refused：${ok.stdout.slice(-500)}`);
  assert.equal(host.status, 'pass', `非回环 Host 必须被拒绝：${host.detail}`);
  assert.match(host.detail, /403/, 'detail 必须记录真实状态码');

  // Against spoofed verdicts: relaxing the boundary fails the refusal check, and
  // tightening the policy fails the admission check with a design-change hint.
  const preload = join(fixture, 'origin-spoof.mjs');
  await writeFile(preload, originSpoofPreload(), 'utf8');
  const spoofPath = join(fixture, 'spoof.json');
  const spoof = await runAccept(args(spoofPath), 180_000, preload);
  assert.equal(spoof.timedOut, false, `脚本不得超时：${spoof.stdout.slice(-300)}`);
  assert.equal(existsSync(spoofPath), true, `必须输出报告；code=${spoof.code}; stderr=${spoof.stderr.slice(-600)}`);
  const spoofReport = JSON.parse(await readFile(spoofPath, 'utf8')) as AcceptanceReport;

  const spoofForeign = spoofReport.results.find(item => item.id === 'origin-refused');
  assert.equal(spoofForeign?.status, 'fail', '放行非回环 Origin 必须让拒绝项失败，否则该项无法发现问题');
  assert.match(spoofForeign?.detail ?? '', /期望 403/, '失败原因必须写明期望值');

  const spoofLoopback = spoofReport.results.find(item => item.id === 'origin-loopback-admitted');
  assert.equal(spoofLoopback?.status, 'fail', '拒绝回环 Origin 必须让放行项失败');
  assert.match(spoofLoopback?.detail ?? '', /设计变更/, '该失败必须提示是设计变更而不是把期望值改回去');

  assert.equal(spoofReport.results.find(item => item.id === 'host-refused')?.status, 'pass',
    '只有 Origin 两项受影响，Host 门必须仍然独立生效');
  assert.equal(spoof.code, 1, `失败项必须反映在退出码上，实际 ${spoof.code}`);
});

