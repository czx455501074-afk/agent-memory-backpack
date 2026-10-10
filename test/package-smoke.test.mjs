import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { test } from 'node:test';

const artifactDir = process.env.AMB_ARTIFACT_DIR ? resolve(process.env.AMB_ARTIFACT_DIR) : undefined;

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
