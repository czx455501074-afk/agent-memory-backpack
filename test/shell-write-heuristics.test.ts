import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The shell-write heuristic has to catch the same operation under a different verb.
 *
 * Measured before this file existed: with `write` in `deniedTools`,
 * `Set-Content fixture.txt x` was denied while `Add-Content fixture.txt x` and
 * `Copy-Item fixture.txt out.txt` were allowed. A prohibition that only recognises one
 * spelling of a write is a prohibition the agent can walk around by accident.
 *
 * The heuristic is still bounded on purpose - `python -c` and script files are out of
 * reach - so these tests pin the verbs, not a claim of completeness.
 */

type Verdict = { denied: boolean; reason?: string };
type GateModule = {
  checkShellWriteBypass: (toolName: string, command: string, deniedTools: string[]) => Verdict;
};

// Two levels up: this file compiles to dist/test/.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dsh = await import(pathToFileURL(join(repoRoot, 'adapters', 'dsh', 'gate-cache.mjs')).href) as GateModule;
const codex = await import(pathToFileURL(join(repoRoot, 'adapters', 'codex', 'scripts', 'gate-cache.mjs')).href) as GateModule;

const DENIED = ['write', 'edit', 'apply_patch'];

const mustDeny = [
  'Set-Content -Path notes.txt -Value x',
  'Add-Content notes.txt x',
  'Copy-Item fixture.txt out.txt',
  'Move-Item fixture.txt elsewhere.txt',
  'Remove-Item notes.txt',
  'New-Item notes.txt -ItemType File',
  'Export-Csv -Path out.csv',
  'cp fixture.txt out.txt',
  'mv fixture.txt out.txt',
  'rm notes.txt',
  'sed -i s/a/b/ notes.txt',
];

const mustAllow = [
  'Get-Content notes.txt',
  'Get-ChildItem',
  'cat notes.txt',
  'ls -la',
  'grep pattern file.txt',
  'git status',
  'git log --oneline -5',
  'echo "just printing"',
];

for (const [label, module] of [['dsh', dsh], ['codex', codex]] as const) {
  test(`${label}: 写入命令的其它拼写同样被拦`, () => {
    for (const command of mustDeny) {
      const verdict = module.checkShellWriteBypass('pwsh', command, DENIED);
      assert.equal(verdict.denied, true, `${label} 应拦截：${command}`);
      assert.match(String(verdict.reason), /启发式/, '理由必须说明这是启发式');
    }
  });

  test(`${label}: 只读命令不被误拦`, () => {
    for (const command of mustAllow) {
      const verdict = module.checkShellWriteBypass('bash', command, DENIED);
      assert.equal(verdict.denied, false, `${label} 不应拦截：${command}`);
    }
  });

  test(`${label}: 没有写工具禁令时不拦截`, () => {
    assert.equal(module.checkShellWriteBypass('pwsh', 'Add-Content notes.txt x', ['read']).denied, false);
  });
}

test('两份适配器的启发式实现保持逐字节一致', () => {
  const left = readFileSync(join(repoRoot, 'adapters', 'dsh', 'gate-cache.mjs'), 'utf8');
  const right = readFileSync(join(repoRoot, 'adapters', 'codex', 'scripts', 'gate-cache.mjs'), 'utf8');
  assert.equal(left, right, '宿主两侧的写入启发式必须逐字节相同，否则同一命令在两端结论不同');
});
