/**
 * The Node version gate exists in two places, so they must agree on every version.
 *
 * `package.json` declares `engines: {"node": ">=24.13.0 <25"}`. Enforcement is
 * implemented twice, because the two entry points ship in different packages: the
 * Codex MCP server is built from `src/mcp.ts` into the core bundle, while the Codex
 * hooks are `.mjs` scripts beside `adapters/codex/scripts/node-version.mjs`. They
 * cannot import each other at runtime, so the range is duplicated.
 *
 * The external report found the gate missing entirely (a host launched the plugin under
 * Node 20 and nothing objected). Adding it twice is how a *different* defect gets
 * introduced: the two copies accept slightly different sets and a host that passes one
 * check is refused by the other. This test compares them across the boundary values,
 * so a future edit to either has to keep the other in step.
 *
 * `AMB_TEST_NODE_VERSION` lets each check be driven without changing the runtime.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertSupportedNodeVersion } from '../src/mcp.js';

// Two levels up: this file compiles to dist/test/.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

type NodeCheck = (version?: string) => { ok: boolean; version: string; error?: string };
const { checkNodeVersion } = await import(
  pathToFileURL(join(repoRoot, 'adapters', 'codex', 'scripts', 'node-version.mjs')).href
) as { checkNodeVersion: NodeCheck };

/** Does the MCP-side gate accept this version? It signals refusal by throwing. */
function mcpAccepts(version: string): boolean {
  const saved = process.env.AMB_TEST_NODE_VERSION;
  process.env.AMB_TEST_NODE_VERSION = version;
  try { assertSupportedNodeVersion(); return true; }
  catch { return false; }
  finally {
    if (saved === undefined) delete process.env.AMB_TEST_NODE_VERSION;
    else process.env.AMB_TEST_NODE_VERSION = saved;
  }
}

/** Versions around both ends of the declared range, plus the ones hosts were seen on. */
const CASES: Array<[string, boolean]> = [
  ['24.13.0', true],   // the lower bound itself
  ['24.13.1', true],
  ['24.18.1', true],   // the version the desktop host reports
  ['24.19.0', true],
  ['24.99.0', true],
  ['25.0.0', false],   // the upper bound is exclusive
  ['26.1.0', false],
  ['24.12.9', false],  // just below the lower bound
  ['23.11.0', false],
  ['20.19.2', false],  // the version the external report caught Codex running on
  ['22.14.0', false],
];

test('MCP 与 Codex hook 的 Node 版本判定完全一致，且范围就是 engines 声明的那一段', () => {
  const rows: string[] = [];
  for (const [version, expected] of CASES) {
    const mcp = mcpAccepts(version);
    const hook = checkNodeVersion(version).ok;
    assert.equal(mcp, hook,
      `${version}: MCP 判定=${mcp} hook 判定=${hook} —— 两处实现已经分叉`);
    assert.equal(mcp, expected, `${version} 应被判为${expected ? '支持' : '不支持'}`);
    rows.push(`${version}=${mcp ? 'ok' : 'no'}`);
  }
  assert.ok(rows.length === CASES.length);
});

test('无法解析的版本必须拒绝，而不是当成支持的版本放行', () => {
  // An unparseable runtime string is not evidence of a supported runtime. These are
  // all *present* values that simply do not name a version.
  for (const broken of ['not-a-version', 'twenty-four', 'v', '24', '24.x', 'v24']) {
    assert.equal(checkNodeVersion(broken).ok, false, `hook 不得放行 "${broken}"`);
    assert.equal(mcpAccepts(broken), false, `MCP 不得放行 "${broken}"`);
  }
});

test('空的版本覆盖等同未提供，两端一致回落到真实运行时', () => {
  /**
   * An empty string is conventionally "not set", and both implementations use
   * `override || env || process.versions.node`, so an empty override falls through to
   * the runtime actually in use — which is supported here, hence `ok`.
   *
   * Asserted rather than ignored, because this is the one input where the two checks
   * could reasonably have disagreed: one could have treated `''` as a malformed
   * version and refused while the other fell through, which would mean a host passing
   * one gate and failing the other. The requirement is that they agree, and that
   * neither treats an empty override as a claim about the runtime.
   */
  const viaHook = checkNodeVersion('').ok;
  const viaMcp = mcpAccepts('');
  assert.equal(viaHook, viaMcp, '空覆盖时两处判定必须一致');
  assert.equal(viaHook, true, '空覆盖应回落到当前运行时（本机为受支持版本），而不是被当作非法版本');
});

test('拒绝时给出可执行的提示，而不是只有一个状态码', () => {
  const refusal = checkNodeVersion('20.19.2');
  assert.equal(refusal.ok, false);
  assert.match(String(refusal.error), /24/, '必须说明需要哪个版本');
  assert.match(String(refusal.error), /20\.19\.2/, '必须说明当前是什么版本');
  assert.match(String(refusal.error), /24\.13\.0|Node 24/, '必须给出可执行的补救方向');

  // And the MCP side says the same kind of thing rather than failing silently.
  const saved = process.env.AMB_TEST_NODE_VERSION;
  process.env.AMB_TEST_NODE_VERSION = '20.19.2';
  try {
    assert.throws(() => assertSupportedNodeVersion(), /24/);
  } finally {
    if (saved === undefined) delete process.env.AMB_TEST_NODE_VERSION;
    else process.env.AMB_TEST_NODE_VERSION = saved;
  }
});
