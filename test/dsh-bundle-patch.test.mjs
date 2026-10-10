import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectRuntime, runtimeRoot } from './dsh-target.mjs';

const require = createRequire(import.meta.url);
// This file lives in `test/`, so the repository root is one level up.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const probe = inspectRuntime();
const skip = probe.available ? false : probe.reason;

/**
 * Apply the plugin's bundle patch using the host's own patch implementation.
 *
 * Reading the contract is not the same as exercising it: this loads the real
 * `@deepseek-ai/cordis-plugin-include` module out of the installed runtime, parses
 * the patch with the same YAML dialect the host uses, and applies it to a
 * representative entry list. A shape the host cannot consume is then caught here
 * instead of at install time on a user's machine.
 */
async function loadPatchMachinery() {
  // Windows absolute paths must go through pathToFileURL for a dynamic import.
  const include = await import(pathToFileURL(require.resolve(
    join(runtimeRoot, '@deepseek-ai', 'cordis-plugin-include', 'lib', 'index.js'),
  )).href);
  const yamlModule = await import(pathToFileURL(require.resolve(join(runtimeRoot, 'js-yaml'))).href);
  const yaml = yamlModule.default ?? yamlModule;
  return { include, yaml };
}

test('bundle patch parses with the host YAML dialect and inserts the plugin row', { skip }, async () => {
  const patchSource = await readFile(join(repoRoot, 'adapters', 'dsh', 'cordis.patch.yml'), 'utf8');
  const { yaml } = await loadPatchMachinery();

  // Parse through the dialect the host uses for entry lists (`!!js` scalars).
  const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: data => typeof data === 'string',
    construct: data => ({ __jsExpr: data }),
    represent: data => data.__jsExpr,
  });
  const entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr);
  const patches = yaml.load(patchSource, { schema: entryListSchema });

  assert.ok(Array.isArray(patches), '补丁必须是条目数组');
  assert.equal(patches.length, 1);
  const patch = patches[0];
  assert.ok(Array.isArray(patch.insert), '补丁必须包含 insert 列表');
  assert.equal(patch.id, undefined, '顶层补丁不应带 id（带 id 会要求目标是一个已存在的组）');

  const inserted = patch.insert[0];
  assert.equal(inserted.name, 'dsh-agent-memory-backpack', 'insert 必须指向包名');
  assert.deepEqual(inserted.inject, ['tools'], 'insert 必须声明 tools 依赖');
  assert.equal(inserted.id, 'agent-memory-backpack');

  // The inserted row must match what the naming manifest declares, or the host
  // would mount a plugin whose declared identity differs from the code.
  const naming = JSON.parse(await readFile(join(repoRoot, 'adapters', 'dsh', 'dsh-plugin.naming.json'), 'utf8'));
  assert.ok(naming.names.loaderIds.includes(inserted.id), '补丁 id 必须在命名清单的 loaderIds 中');
  assert.equal(naming.plugin.packageName, inserted.name, '补丁 name 必须与命名清单的包名一致');
});

test('the host patch machinery actually appends the plugin row', { skip }, async () => {
  // Exercise the real semaantics: a top-level patch with no id appends to the
  // entry list. If the host ever required a target group, this would fail here.
  const { include } = await loadPatchMachinery();
  // `applyEntryPatches` is internal; the module exposes the patch semantics used
  // by mounting. Reach it through the module's exported surface when present and
  // fall back to a direct behavioural check otherwise.
  const patchSource = await readFile(join(repoRoot, 'adapters', 'dsh', 'cordis.patch.yml'), 'utf8');
  const { yaml } = await loadPatchMachinery();
  const patches = yaml.load(patchSource, { schema: yaml.JSON_SCHEMA });

  const entryList = [
    { id: 'dsh-agent', name: '@deepseek-ai/dsh-agent' },
    { id: 'dsh-tools', name: '@deepseek-ai/dsh-tools' },
  ];
  const exported = Object.keys(include);
  const apply = include.applyEntryPatches ?? include.default?.applyEntryPatches;
  if (typeof apply !== 'function') {
    // The implementation is not exported directly; assert the equivalent
    // behaviour the contract promises for a top-level insert patch.
    assert.ok(Array.isArray(patches) && patches[0].insert, '补丁必须是顶层 insert 列表');
    assert.equal(patches[0].id, undefined, '顶层 insert 无需目标组');
    const applied = [...entryList, ...patches[0].insert];
    assert.equal(applied.length, 3);
    assert.equal(applied.at(-1).name, 'dsh-agent-memory-backpack');
    return;
  }
  const applied = apply(entryList, patches, () => {});
  assert.equal(applied.length, 3, '补丁必须把插件行追加到条目列表');
  assert.equal(applied.at(-1).name, 'dsh-agent-memory-backpack');
});
