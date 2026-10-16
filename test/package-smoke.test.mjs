import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { test } from 'node:test';

let resolvedArtifactDir = process.env.AMB_ARTIFACT_DIR ? resolve(process.env.AMB_ARTIFACT_DIR) : undefined;
if (!resolvedArtifactDir) {
  const latestPath = resolve('artifacts', 'latest.json');
  if (existsSync(latestPath)) {
    try {
      const latest = JSON.parse(readFileSync(latestPath, 'utf8'));
      if (latest && typeof latest.directory === 'string' && existsSync(latest.directory)) {
        resolvedArtifactDir = resolve(latest.directory);
      }
    } catch {}
  }
}
const artifactDir = resolvedArtifactDir;

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...options });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolveRun({ child, code, signal, stdout, stderr }));
  });
}

function start(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...options });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  return { child, get output() { return `${stdout}\n${stderr}`; } };
}

async function freeLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = server.address().port;
  await new Promise(resolveClose => server.close(resolveClose));
  return port;
}

async function waitForHealth(url, child, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`Core exited before health check: ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return await response.json();
    } catch {}
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  throw new Error('Timed out waiting for packaged core health endpoint');
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolveExit => child.once('close', resolveExit)),
    new Promise(resolveDelay => setTimeout(resolveDelay, 3000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

test('packaged core CLI and MCP run from a Chinese whitespace fixture directory', {
  skip: artifactDir ? false : 'Set AMB_ARTIFACT_DIR to a packaged artifact root to run this smoke test.',
}, async t => {
  assert.ok(existsSync(artifactDir), `Artifact directory does not exist: ${artifactDir}`);
  const artifactManifestPath = join(artifactDir, 'artifact-manifest.json');
  assert.ok(existsSync(artifactManifestPath), 'Artifact is missing artifact-manifest.json');
  const artifactManifest = JSON.parse(readFileSync(artifactManifestPath, 'utf8'));
  assert.equal(artifactManifest.format, 'agent-memory-backpack-artifact-hashes-v1');
  assert.ok(artifactManifest.artifactFiles['core/runtime/cli.js']);
  assert.ok(artifactManifest.artifactFiles['codex-plugin/runtime/mcp.js']);
  assert.ok(artifactManifest.artifactFiles['codex-plugin/.codex-plugin/plugin.json']);
  assert.ok(artifactManifest.artifactFiles['dsh-plugin/package.json']);

  const fixtureRoot = mkdtempSync(join(tmpdir(), 'amb 打包冒烟 smoke '));
  t.after(() => {
    const rel = relative(resolve(tmpdir()), resolve(fixtureRoot));
    assert(rel && !rel.startsWith('..') && !isAbsolute(rel));
    rmSync(fixtureRoot, { recursive: true, force: true });
  });
  const coreDir = join(fixtureRoot, 'core 包');
  const pluginDir = join(fixtureRoot, 'codex 插件');
  cpSync(join(artifactDir, 'core'), coreDir, { recursive: true });
  cpSync(join(artifactDir, 'codex-plugin'), pluginDir, { recursive: true });
  cpSync(join(artifactDir, 'p0-seed.json'), join(fixtureRoot, 'p0-seed.json'));

  const dataDir = join(fixtureRoot, '配置 数据');
  const port = await freeLoopbackPort();
  const projectRoot = join(fixtureRoot, '项目 根目录');
  mkdirSync(projectRoot);
  const cliPath = join(coreDir, 'runtime', 'cli.js');
  const init = await run(process.execPath, [cliPath, 'init', '--data-dir', dataDir, '--project', 'project-demo', '--project-root', projectRoot, '--port', String(port)], { cwd: coreDir });
  assert.equal(init.code, 0, init.stderr);
  const seed = await run(process.execPath, [cliPath, 'seed', '--data-dir', dataDir, '--input', join(fixtureRoot, 'p0-seed.json')], { cwd: coreDir });
  assert.equal(seed.code, 0, seed.stderr);
  assert.equal(JSON.parse(seed.stdout).knowledgeRevision, 1);

  const serve = start(process.execPath, [cliPath, 'serve', '--data-dir', dataDir], { cwd: coreDir });
  let mcpClient;
  let mcpTransport;
  try {
    const health = await waitForHealth(`http://127.0.0.1:${port}`, serve.child);
    assert.equal(health.protocolVersion, 1);
    assert.equal(health.status, 'ok');

    const clientConfig = join(dataDir, 'codex-client.json');
    const mcpPath = join(pluginDir, 'runtime', 'mcp.js');
    mcpTransport = new StdioClientTransport({
      command: process.execPath,
      args: [mcpPath],
      cwd: pluginDir,
      env: { ...process.env, AMB_CONFIG: clientConfig },
    });
    mcpClient = new Client({ name: 'amb-artifact-smoke', version: '1.0.0' });
    await mcpClient.connect(mcpTransport);
    const tools = await mcpClient.listTools();
    assert.ok(tools.tools.some(tool => tool.name === 'amb_prepare'));
    const result = await mcpClient.callTool({ name: 'amb_prepare', arguments: { query: '本地流程' } });
    assert.notEqual(result.isError, true);
    const payload = JSON.parse(result.content.find(item => item.type === 'text').text);
    assert.equal(payload.knowledgeRevision, 1);
    assert.ok(payload.workflows.some(workflow => workflow.id === 'p0-cn-workflow'));
  } finally {
    if (mcpClient) await mcpClient.close().catch(() => {});
    if (mcpTransport) await mcpTransport.close().catch(() => {});
    await stopChild(serve.child);
  }
});

/**
 * The artifact hashes only prove the artifact matches its own manifest. Without
 * a recorded build identity an artifact produced from a tree that kept changing
 * afterwards is still "verified", so these are asserted on the source text: the
 * packaging script must record the commit and the worktree state, and it must
 * syntax-check the release scripts that never appear inside a packaged tree.
 */
test('打包脚本记录 git 构建身份，并对发布脚本执行语法门', () => {
  const source = readFileSync(resolve('scripts', 'package.mjs'), 'utf8');

  // A commit is recorded as a 40-hex digest; anything else is treated as absent.
  assert.ok(source.includes('[0-9a-f]{40}'), '必须把 commit 约束为 40 位十六进制');
  assert.ok(source.includes("'rev-parse'") && source.includes("'HEAD'"), '必须用 git rev-parse HEAD 采集提交');
  assert.ok(source.includes('--porcelain=v1') && source.includes('--untracked-files=all'),
    '必须采集完整工作树状态（含未跟踪文件）');
  assert.ok(source.includes('worktreeStatus'), '必须记录工作树状态字段');
  assert.ok(/clean:\s/.test(source), '必须派生 clean 布尔值');
  assert.ok(source.includes('unavailable'), 'git 不可用时必须降级为可读原因，而不是中断打包');

  // Both files a later verification reads carry the same identity.
  assert.match(source, /artifact-manifest\.json[\s\S]{0,400}\bbuild,/, '产物清单必须写入 build 身份');
  assert.match(source, /latest\.json[\s\S]{0,300}\bbuild\b/, 'latest.json 必须写入 build 身份');
  for (const field of ['node: process.version', 'packageVersion: manifest.version', 'packagedAt: new Date().toISOString()']) {
    assert.ok(source.includes(field), `build 身份必须包含 ${field}`);
  }

  // The packaged-tree gate must stay exactly as strong as it was.
  assert.ok(source.includes("for (const folder of ['core', 'codex-plugin', 'dsh-plugin', 'console']) syntaxCheck(join(out, folder));"),
    '产物 node --check 门不得被削弱');

  // Release scripts live outside every packaged tree, so they need their own gate.
  for (const script of ['scripts/package.mjs', 'scripts/desktop-accept.mjs', 'scripts/deploy-plugin.mjs', 'scripts/amb-install.mjs', 'scripts/amb-uninstall.mjs']) {
    assert.ok(source.includes(`'${script}'`), `发布脚本清单必须包含 ${script}`);
  }
  assert.match(source, /releaseScripts[\s\S]{0,800}\['--check', file\]/, '发布脚本必须逐个通过 node --check');
});

