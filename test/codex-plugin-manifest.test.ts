import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Codex loads hooks from the plugin manifest, not from a standalone hooks file.
 *
 * Measured on the installed plugin: `codex plugin list` reported the plugin, the
 * `hooks/hooks.json` file sat beside it, and a real `codex exec` turn produced no hook
 * log line at all - while feeding the same event to `scripts/hook.mjs` by hand worked.
 * Every plugin shipped with Codex inlines its hooks under `"hooks": { "hooks": ... }`,
 * so a file the manifest never references is simply never read.
 *
 * The manifest is generated from `hooks/hooks.json` so the definition stays in one
 * place; this test is what keeps the copy honest.
 */

// Two levels up: this file compiles to dist/test/.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifestPath = join(repoRoot, 'adapters', 'codex', '.codex-plugin', 'plugin.json');
const hooksPath = join(repoRoot, 'adapters', 'codex', 'hooks', 'hooks.json');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  name?: string; version?: string; skills?: string; mcpServers?: string;
  hooks?: { hooks?: Record<string, unknown> };
};
const standalone = JSON.parse(readFileSync(hooksPath, 'utf8')) as { hooks?: Record<string, unknown> };

test('Codex 插件清单必须内联声明 hooks，而不是只放一个独立文件', () => {
  assert.ok(manifest.hooks, 'plugin.json 缺少 hooks：Codex 不会读取 hooks/hooks.json');
  assert.ok(manifest.hooks?.hooks, 'hooks 必须是 { hooks: { <Event>: [...] } } 形状');
  const events = Object.keys(manifest.hooks!.hooks!);
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
    assert.ok(events.includes(event), `缺少事件 ${event}`);
  }
});

test('内联的 hooks 与 hooks/hooks.json 完全一致，不得漂移', () => {
  assert.deepEqual(manifest.hooks, standalone,
    'plugin.json 的 hooks 与 hooks/hooks.json 不一致：改一处必须同步另一处');
});

test('清单仍声明 skills 与 MCP，三者缺一都会让 Codex 端少一条链路', () => {
  assert.equal(manifest.skills, './skills/');
  assert.equal(manifest.mcpServers, './.mcp.json');
  assert.equal(manifest.name, 'agent-memory-backpack');
});
