import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dshDir = join(repoRoot, 'adapters', 'dsh');

/**
 * Static guarantees about the adapter package.
 *
 * These catch the class of defect that only shows up on the user's machine: a
 * file the code imports but the manifest does not ship, or a manifest that
 * contradicts the code. Both make the plugin fail to load at all, and neither is
 * visible from the repository tree, where every file is present regardless.
 */

test('package files list ships every module the adapter imports', async () => {
  const manifest = JSON.parse(await readFile(join(dshDir, 'package.json'), 'utf8')) as { files: string[] };
  const declared = new Set(manifest.files);

  // Every local import in the entry points must be shipped, or the plugin loads
  // and immediately dies on an unresolved specifier.
  const entries = ['index.mjs', 'core-client.mjs', 'log.mjs'].filter(name => existsSync(join(dshDir, name)));
  const localImports = new Set<string>();
  for (const entry of entries) {
    const source = await readFile(join(dshDir, entry), 'utf8');
    for (const match of source.matchAll(/from\s+['"]\.\/([\w.-]+\.mjs)['"]/g)) {
      if (match[1]) localImports.add(match[1]);
    }
  }

  assert.ok(localImports.size > 0, '应能识别出本地模块导入');
  const missing = [...localImports].filter(name => !declared.has(name));
  assert.deepEqual(missing, [], `这些被导入的模块未在 files 中声明，发布后会缺失：${missing.join(', ')}`);

  // And the reverse: a declared file that does not exist is also a packaging bug.
  for (const name of manifest.files) {
    if (name === 'cordis.patch.yml') continue;
    assert.equal(existsSync(join(dshDir, name)), true, `files 声明的文件不存在：${name}`);
  }
});

test('naming manifest matches the tools the adapter actually registers', async () => {
  // The naming policy is a published declaration about the plugin. A stale list
  // misleads anyone auditing which tools a host will see.
  const naming = JSON.parse(await readFile(join(dshDir, 'dsh-plugin.naming.json'), 'utf8')) as {
    names: { tools: string[]; pluginNames: string[]; loaderIds: string[] };
  };
  const source = await readFile(join(dshDir, 'index.mjs'), 'utf8');
  const registered = [...source.matchAll(/name:\s*'(amb_[\w]+)'/g)].map(match => match[1]).sort();

  assert.ok(registered.length >= 11, `应识别出全部工具，实际 ${registered.length}`);
  assert.deepEqual([...naming.names.tools].sort(), registered, '命名清单必须与实际注册的工具一致');

  // The loader id must match the bundle patch, or the patch inserts nothing.
  const patch = await readFile(join(dshDir, 'cordis.patch.yml'), 'utf8');
  for (const id of naming.names.loaderIds) {
    assert.match(patch, new RegExp(`id:\\s*${id}`), `bundle patch 必须包含 loader id ${id}`);
  }
  assert.match(patch, /inject:\s*\n\s*-\s*tools/, 'bundle patch 必须声明 tools 依赖');
});

test('bundle patch targets the package name the manifest declares', async () => {
  const manifest = JSON.parse(await readFile(join(dshDir, 'package.json'), 'utf8')) as { name: string };
  const patch = await readFile(join(dshDir, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, new RegExp(`name:\\s*${manifest.name}`),
    'patch 中的 name 必须是包名，否则宿主无法解析该插件');
});

test('every manifest and version constant reports the same version', async () => {
  // Version drift makes a bug report ambiguous: the number the user reads may not
  // be the number the code stamps into its logs. All of them are asserted equal.
  const root = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as { version: string };
  const dshManifest = JSON.parse(await readFile(join(dshDir, 'package.json'), 'utf8')) as { version: string };
  const codexPlugin = JSON.parse(await readFile(join(repoRoot, 'adapters', 'codex', '.codex-plugin', 'plugin.json'), 'utf8')) as { version: string };

  assert.equal(dshManifest.version, root.version, 'DSH 适配器版本必须与根一致');
  assert.equal(codexPlugin.version, root.version, 'Codex 插件版本必须与根一致');

  // The constant the adapter logs with must agree too, or the log lies.
  const source = await readFile(join(dshDir, 'index.mjs'), 'utf8');
  const stamped = /PLUGIN_VERSION = '([^']+)'/.exec(source)?.[1];
  assert.equal(stamped, root.version, '适配器日志中的版本必须与清单一致');

  // The MCP server advertises a version to clients as well.
  const mcp = await readFile(join(repoRoot, 'src', 'mcp.ts'), 'utf8');
  const advertised = /new McpServer\(\{[^}]*version:\s*'([^']+)'/.exec(mcp)?.[1];
  assert.equal(advertised, root.version, 'MCP 服务声明的版本必须与清单一致');
});

test('plugin declares safe browser client bundle and isolated core client', async () => {
  const manifest = JSON.parse(await readFile(join(dshDir, 'package.json'), 'utf8')) as {
    exports: Record<string, unknown>;
    dsh: { client?: { inject?: string[]; platform?: string }; bundle?: { patch?: string } };
  };
  assert.ok(manifest.dsh.client, '应声明 dsh.client：提供 Agent 内置知识库页面');
  assert.equal('./client' in manifest.exports, true, '必须导出 ./client 子路径');

  // Verify the client bundle conforms to __ModuleLoader__ registration
  const clientBundle = await readFile(join(dshDir, 'client.js'), 'utf8');
  assert.doesNotThrow(() => new Script(clientBundle), '客户端脚本必须能作为 classic script 解析');
  assert.ok(/__ModuleLoader__/.test(clientBundle), '客户端组件必须经由 __ModuleLoader__ 挂载');
  assert.equal(/from\s+['"]node:/.test(clientBundle), false, '客户端组件不得引用 Node 原生模块');

  // The Node-side core client is a plain module export, not a browser half.
  assert.ok('./core-client' in manifest.exports, '核心客户端应通过独立子路径导出');
  assert.equal(manifest.dsh.bundle?.patch, './cordis.patch.yml');

  const coreClient = await readFile(join(dshDir, 'core-client.mjs'), 'utf8');
  assert.match(coreClient, /from\s+['"]node:/, '核心客户端依赖 Node 能力');
  assert.equal(/__ModuleLoader__/.test(coreClient), false, '核心客户端不是浏览器 bundle');
});
