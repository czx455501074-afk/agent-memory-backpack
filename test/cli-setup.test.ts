import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * `amb setup` is the first run, in one command.
 *
 * The gap it closes is measured: this project's first run was six steps (clone → npm ci → build
 * → install:local → host add → restart) while the peer projects ask for one command and let the
 * agent assemble the rest. Publishing to npm is out of scope, so the honest target is "one
 * command does everything this repository can do by itself, and it prints exactly what remains,
 * with paths and profile names already resolved".
 *
 * Two properties are pinned here that a happy-path check would miss: running it twice must not
 * touch existing credentials (a re-run that silently re-issued tokens would break every adapter
 * that already had one), and it must never print a placeholder the user has to fill in.
 */

const roots: string[] = [];
after(() => {
  for (const path of roots.splice(0)) {
    const rel = relative(resolve(tmpdir()), resolve(path));
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Windows keeps handles open; leftover temp is not the verdict.
    }
  }
});

const CLI = join(process.cwd(), 'dist', 'src', 'cli.js');
function run(args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true });
  return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}

test('setup creates the data directory and prints the resolved host command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'backpack-setup-'));
  roots.push(dir);
  const first = run(['setup', '--data-dir', dir]);
  assert.equal(first.status, 0, first.stderr);
  for (const name of ['core.json', 'dsh-client.json', 'codex-client.json', 'admin-client.json'])
    assert.ok(existsSync(join(dir, name)), `setup 应当写出 ${name}`);
  assert.match(first.stdout, /dsh plugin --profile \S+ add "/, '必须给出可直接执行的宿主命令');
  assert.match(first.stdout, /adapters[\\/]dsh/, '命令里的插件路径应当是真实解析出来的路径');
  assert.ok(!first.stdout.includes('<你的 profile>'), '本机能查到 profile 时不得回退成占位符');
});

test('a second setup never overwrites existing credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'backpack-setup-again-'));
  roots.push(dir);
  run(['setup', '--data-dir', dir]);
  const before = readFileSync(join(dir, 'core.json'), 'utf8');
  const second = run(['setup', '--data-dir', dir]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(join(dir, 'core.json'), 'utf8'), before,
    '重跑不得重新签发凭据——否则已经在用的适配器会立刻失效');
  assert.match(second.stdout, /已初始化/, '要说明跳过而不是静默');
  assert.ok(!second.stdout.includes('已创建数据目录'), '已初始化时不得声称创建过');
});
