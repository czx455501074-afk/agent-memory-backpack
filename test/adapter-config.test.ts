import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

// Two levels up: this file compiles to dist/test/, so one level is dist/.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The rule that makes one knowledge base reach both desktops.
 *
 * A user installs the plugin into DSH and Codex and expects their knowledge to
 * be shared. That only holds if both adapters resolve to the same core and the
 * same database — so the property worth pinning is not "each adapter can read a
 * config" but "the two adapters agree".
 *
 * These tests read the real resolver out of each adapter package and run it
 * against the same inputs, rather than asserting on a copy of the logic.
 */

const dshResolver = join(repoRoot, 'adapters/dsh/resolve-config.mjs');
const codexResolver = join(repoRoot, 'adapters/codex/scripts/resolve-config.mjs');

/** An absolute path as an import specifier; a bare Windows drive fails ESM. */
const asSpecifier = (path: string) => pathToFileURL(path).href;

/** Run a resolver in a child process and return its decision as JSON. */
function resolveWith(modulePath: string, adapterId: string, env: Record<string, string>): {
  path: string; source: string; envVar: string | null; warning: string | null;
} {
  const script = `
    import { resolveClientConfig } from ${JSON.stringify(asSpecifier(modulePath))};
    process.stdout.write(JSON.stringify(resolveClientConfig(${JSON.stringify(adapterId)}, process.env)));
  `;
  // The home is redirected through the child's environment, so the resolver's
  // real `os.homedir()` call lands in a temporary directory. Asserting against
  // a temp path the resolver never actually read would be a test that passes
  // without testing anything.
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, ...env, USERPROFILE: env.USERPROFILE ?? process.env.USERPROFILE, HOME: env.HOME ?? process.env.HOME },
  });
  return JSON.parse(out);
}

/** A temporary home directory with the two credential files `init` writes. */
function fakeHome(): { home: string; dataDir: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'amb-home-'));
  const dataDir = join(home, '.agent-memory-backpack');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'dsh-client.json'), '{}');
  writeFileSync(join(dataDir, 'codex-client.json'), '{}');
  return { home, dataDir, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

test('每个适配器包里都有一份逐字相同的解析实现', () => {
  // Same guarantee the log module already carries: two copies that a test keeps
  // identical, so the sharing rule cannot drift between the adapters.
  const dsh = readFileSync(dshResolver, 'utf8');
  const codex = readFileSync(codexResolver, 'utf8');
  assert.equal(sha(dsh), sha(codex),
    'adapters/dsh/resolve-config.mjs 与 adapters/codex/scripts/resolve-config.mjs 必须完全相同');
});

test('两个适配器在同一 home 下解析到同一数据目录、各自的凭据文件', () => {
  const fake = fakeHome();
  try {
    // Same home for both, which is the situation every real user is in.
    const env = { USERPROFILE: fake.home, HOME: fake.home };
    const dsh = resolveWith(dshResolver, 'dsh', env);
    const codex = resolveWith(codexResolver, 'codex', env);

    assert.equal(dsh.path, join(fake.dataDir, 'dsh-client.json'),
      `DSH 应读自己的凭据，实际 ${dsh.path}`);
    assert.equal(codex.path, join(fake.dataDir, 'codex-client.json'),
      `Codex 应读自己的凭据，实际 ${codex.path}`);

    // The property that makes knowledge shared: different files, one directory.
    assert.notEqual(dsh.path, codex.path, '两个适配器不应读同一个凭据文件');
    assert.equal(dirname(dsh.path), dirname(codex.path),
      '两个适配器必须落在同一个数据目录，否则知识不会共享');
    assert.equal(dirname(dsh.path), fake.dataDir, '解析结果应真的落在该 home 下');
  } finally {
    fake.cleanup();
  }
});

test('失效的环境变量回落到共享默认目录，而不是让插件失效', () => {
  // This is the defect: a leftover AMB_CONFIG from an earlier test run named a
  // deleted file, which made the plugin look broken with no explanation.
  const fake = fakeHome();
  try {
    const gone = join(fake.home, 'does-not-exist', 'codex-client.json');
    const resolved = resolveWith(codexResolver, 'codex', {
      USERPROFILE: fake.home, HOME: fake.home, AMB_CONFIG: gone,
    });

    assert.notEqual(resolved.path, gone, '不得继续使用不存在的路径');
    assert.ok(resolved.warning, '必须说明哪个变量失效了以及回落到了哪里');
    assert.match(resolved.warning, /AMB_CONFIG/, '警告必须点名失效的变量');
    assert.match(resolved.warning, /does not exist/, '警告必须说明原因');
    assert.equal(resolved.path, join(fake.dataDir, 'codex-client.json'),
      '应回落到该适配器自己的共享凭据');
  } finally {
    fake.cleanup();
  }
});

test('存在的显式变量优先，测试与隔离运行因此仍然可用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'amb-explicit-'));
  const file = join(dir, 'client.json');
  writeFileSync(file, '{}');
  try {
    const resolved = resolveWith(codexResolver, 'codex', { AMB_CONFIG: file });
    assert.equal(resolved.source, 'env');
    assert.equal(resolved.path, resolve(file));
    assert.equal(resolved.warning, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DSH 的专用变量优先于通用变量', () => {
  const dir = mkdtempSync(join(tmpdir(), 'amb-priority-'));
  const specific = join(dir, 'dsh.json');
  const generic = join(dir, 'generic.json');
  writeFileSync(specific, '{}');
  writeFileSync(generic, '{}');
  try {
    const resolved = resolveWith(dshResolver, 'dsh', { AMB_DSH_CONFIG: specific, AMB_CONFIG: generic });
    assert.equal(resolved.path, resolve(specific), 'AMB_DSH_CONFIG 应优先于 AMB_CONFIG');
    assert.equal(resolved.envVar, 'AMB_DSH_CONFIG');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The core's own resolver must agree with the adapters'.
 *
 * The console, the MCP entry point and `doctor` live in the core and resolve
 * paths in TypeScript. If that rule diverged from the adapters', the core would
 * report one thing and the adapters do another — the exact class of bug this
 * whole change exists to remove.
 */
test('核心侧解析与适配器侧一致', () => {
  const script = `
    import { resolveConfigPath } from ${JSON.stringify(asSpecifier(join(repoRoot, 'dist/src/config.js')))};
    const out = {
      codexDefault: resolveConfigPath('codex', {}),
      dshDefault: resolveConfigPath('dsh', {}),
      staleCodex: resolveConfigPath('codex', { AMB_CONFIG: ${JSON.stringify(join(tmpdir(), 'amb-nope', 'x.json'))} }),
      specificWins: resolveConfigPath('dsh', { AMB_DSH_CONFIG: ${JSON.stringify(join(tmpdir(), 'amb-nope', 'a.json'))}, AMB_CONFIG: ${JSON.stringify(join(tmpdir(), 'amb-nope', 'b.json'))} }),
    };
    process.stdout.write(JSON.stringify(out));
  `;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', windowsHide: true }));

  assert.match(out.codexDefault.path, /codex-client\.json$/, 'Codex 默认应读 codex-client.json');
  assert.match(out.dshDefault.path, /dsh-client\.json$/, 'DSH 默认应读 dsh-client.json');
  assert.equal(dirname(out.codexDefault.path), dirname(out.dshDefault.path),
    '核心侧也必须让两个适配器落在同一目录');
  assert.ok(out.staleCodex.warning, '核心侧遇到失效变量也必须告警');
  assert.match(out.staleCodex.warning, /AMB_CONFIG/);
  assert.match(out.specificWins.warning, /AMB_DSH_CONFIG/, '警告应点名优先的那个变量');
});
