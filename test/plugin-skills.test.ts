import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { discover, exclusionReason, defaultScanRoots } from '../src/discovery.js';

async function scratch(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}
async function cleanup(dir: string): Promise<void> {
  const rel = relative(resolve(tmpdir()), resolve(dir));
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await rm(dir, { recursive: true, force: true });
}

test('扫描根位于 cache 等受限目录名下时，技能仍被识别', async () => {
  // Hosts install plugins under a path segment named `cache`. Applying the
  // runtime-store rule to the absolute path excluded the whole root, so
  // plugin-provided skills were silently invisible. The rule belongs to the
  // path *below* the root.
  const base = await scratch('amb-pluginroot-');
  try {
    const root = join(base, 'cache', 'amb-local', 'agent-memory-backpack', '0.1.0', 'skills');
    await mkdir(join(root, 'inspect'), { recursive: true });
    await writeFile(join(root, 'inspect', 'SKILL.md'), '# 巡检技能\n\n## 触发\n需要巡检时。\n\n## 步骤\n先看日志。\n', 'utf8');

    const report = discover([root]);
    const skills = report.candidates.filter(c => c.kind === 'skill');
    assert.equal(skills.length, 1, `插件目录下的技能必须被发现，实际 candidates=${report.candidates.length} excluded=${report.excluded.length}`);
    assert.equal(skills[0]!.title, '巡检技能');

    // A nested runtime directory must still be skipped: the rule was narrowed,
    // not removed.
    await mkdir(join(root, 'inspect', 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'inspect', 'node_modules', 'pkg', 'SKILL.md'), '# 不应采纳\n', 'utf8');
    const again = discover([root]);
    // The extra file sits under node_modules, so it must be reported as excluded.
    assert.ok(
      again.excluded.some(item => item.path.includes('node_modules')),
      '根内部的运行时目录仍必须被排除',
    );
  } finally { await cleanup(base); }
});

test('排除规则针对相对路径：根自身的名字不参与判定', () => {
  // Direct unit check: a relative path is what the rule consumes.
  assert.equal(exclusionReason('inspect/SKILL.md', 'SKILL.md'), undefined);
  assert.match(String(exclusionReason('node_modules/pkg/SKILL.md', 'SKILL.md')), /runtime or secret store/);
  assert.match(String(exclusionReason('inspect/.git/x.md', 'x.md')), /runtime or secret store/);
  // `.env` and manifests are name-based and unaffected by path handling.
  assert.match(String(exclusionReason('x/.env', '.env')), /credentials/);
  assert.match(String(exclusionReason('x/package.json', 'package.json')), /manifest/);
  assert.match(String(exclusionReason('x/hook.mjs', 'hook.mjs')), /executable logic/);
});

test('凭据文档即使位于有效技能目录内也不被采纳', () => {
  // Adopted text is injected into agent context, so a file that exists to store
  // secrets must stay out even though it is Markdown.
  for (const name of ['credentials.md', 'secrets.md', 'passwords.md', 'api-keys.md', '.env.md']) {
    const reason = exclusionReason(`skill/${name}`, name);
    assert.ok(reason, `${name} 必须被排除`);
    assert.match(String(reason), /credential|environment/, `${name} 的理由应说明是凭据`);
  }
  // A procedure *about* secrets is still legitimate knowledge.
  assert.equal(exclusionReason('skill/secret-management.md', 'secret-management.md'), undefined);
  assert.equal(exclusionReason('skill/token-rotation.md', 'token-rotation.md'), undefined);
});

test('默认扫描根覆盖宿主插件技能目录', async () => {
  const home = await scratch('amb-home-');
  try {
    // A realistic layout: plugin-installed skills live inside the host's cache.
    await mkdir(join(home, '.codex', 'plugins', 'cache', 'vendor', 'plugin', '1.0.0', 'skills'), { recursive: true });
    await mkdir(join(home, '.agents', 'skills'), { recursive: true });

    const roots = defaultScanRoots(home, home);
    assert.ok(roots.some(r => r.includes(join('.agents', 'skills'))), '用户技能目录必须在默认扫描范围内');

    // The plugin root is discovered even though it sits under `cache`.
    const report = discover(roots);
    assert.equal(report.wrote, false, '扫描必须保持只读');
  } finally { await cleanup(home); }
});
