import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = join(repoRoot, 'dist', 'src', 'cli.js');

/**
 * The command line is the entry point a user meets first, and a stack trace is
 * the worst possible reply. These checks come from a real desktop acceptance run
 * where `--help` crashed with ERR_PARSE_ARGS_UNKNOWN_OPTION.
 */
function runCli(args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(resolveRun => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('close', code => resolveRun({ code, stdout, stderr }));
  });
}

const STACK_TRACE = /at (?:Object\.|Module\.|node:internal)/;

test('--help prints usage and exits cleanly instead of throwing', async () => {
  for (const flag of ['--help', '-h']) {
    const result = await runCli([flag]);
    assert.equal(result.code, 0, `${flag} 应以状态 0 退出`);
    assert.match(result.stdout, /Commands:/, `${flag} 应输出命令列表`);
    assert.equal(STACK_TRACE.test(result.stdout + result.stderr), false, `${flag} 不得抛栈追踪`);
    assert.equal(/ERR_PARSE_ARGS/.test(result.stderr), false, `${flag} 不得出现解析器内部错误`);
  }
});

test('usage lists every command the CLI actually implements', async () => {
  // Documentation drift is its own defect: a command that exists but is absent
  // from the help is one a user cannot discover.
  const source = await readFile(join(repoRoot, 'src', 'cli.ts'), 'utf8');
  const implemented = [...source.matchAll(/command === '([a-z-]+)'/g)]
    .map(m => m[1])
    .filter((name): name is string => Boolean(name));
  const result = await runCli(['--help']);
  const missing = [...new Set(implemented)].filter(name => !result.stdout.includes(name));
  assert.deepEqual(missing, [], `这些命令未出现在帮助中：${missing.join(', ')}`);
  // The commands a user needs for a first run must be named.
  for (const expected of ['init', 'serve', 'doctor', 'logs', 'adopt', 'export']) {
    assert.match(result.stdout, new RegExp(`\\b${expected}\\b`), `帮助应包含 ${expected}`);
  }
});

test('an unknown option or command is reported without a stack trace', async () => {
  const unknownOption = await runCli(['status', '--definitely-not-an-option']);
  assert.equal(unknownOption.code, 1, '未知选项应以非零退出');
  assert.equal(STACK_TRACE.test(unknownOption.stdout + unknownOption.stderr), false, '不得抛栈追踪');
  assert.match(unknownOption.stderr, /Invalid arguments/, '应说明参数无效');
  assert.match(unknownOption.stderr, /Commands:/, '应给出命令列表供修正');

  const unknownCommand = await runCli(['definitely-not-a-command']);
  assert.equal(unknownCommand.code, 1, '未知命令应以非零退出');
  assert.equal(STACK_TRACE.test(unknownCommand.stdout + unknownCommand.stderr), false, '不得抛栈追踪');
  assert.match(unknownCommand.stderr, /Unknown command/, '应点名未知命令');
  assert.match(unknownCommand.stderr, /Commands:/, '应给出命令列表');
});

test('no arguments prints usage and succeeds', async () => {
  const result = await runCli([]);
  assert.equal(result.code, 0, '无参数运行应正常退出');
  assert.match(result.stdout, /Commands:/, '应输出用法');
});

test('a normal command still works after the argument handling change', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'amb-cli-usage-'));
  try {
    const init = await runCli(['init', '--data-dir', dir, '--project', 'usage', '--project-root', dir]);
    assert.equal(init.code, 0, `init 应成功：${init.stderr.slice(0, 200)}`);
    const status = await runCli(['status', '--data-dir', dir]);
    assert.equal(status.code, 0, 'status 应成功');
    // `status` prints prose by default now - the answer to "what is in my library" - and
    // the machine-readable shape moved behind --json. Both are asserted so neither can
    // silently disappear.
    assert.match(status.stdout, /知识条目|知识版本/, 'status 应说明库里的情况');
    const asJson = await runCli(['status', '--json', '--data-dir', dir]);
    assert.match(asJson.stdout, /knowledgeRevision/, '--json 仍应输出 JSON 状态');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('injected Codex context carries an identifiable source marker', async () => {
  // DSH carries the source as a structured field. Codex hooks can only return
  // text, and the host labels it by its own rule, so without a marker an
  // acceptance run cannot tell plugin content from the model's own words.
  const hook = await readFile(join(repoRoot, 'adapters', 'codex', 'scripts', 'hook.mjs'), 'utf8');
  const marker = /const SOURCE_MARKER = "([^"]+)"/.exec(hook)?.[1];
  assert.ok(marker, '必须定义来源标记');
  assert.match(hook, /additionalContext:\s*`\$\{SOURCE_MARKER\}/, '注入内容必须以该标记开头');
  // The name must match what the DSH side reports, or the two ends disagree.
  assert.equal(marker.includes('agent-memory-backpack'), true,
    `来源标记应与 DSH 的来源名一致，实际：${marker}`);
});

test('the desktop fixture never writes a project-level enable flag', async () => {
  // A project-level `enabled = true` outranks the global desktop toggle, which
  // made the "disable" acceptance step impossible to pass in Codex. The fixture
  // must not create that condition.
  const source = await readFile(join(repoRoot, 'scripts', 'prepare-desktop-p0.mjs'), 'utf8');

  // The check targets what the script writes, not prose about it: the generated
  // notes intentionally quote `enabled = true` while explaining why the fixture
  // omits it. So look for the actual write and for the key/value inside a
  // template or string that is passed to writeFileSync.
  assert.equal(/writeFileSync\([^)]*config\.toml/.test(source), false,
    '夹具不得生成 config.toml（启用状态应由桌面 UI 控制）');
  assert.equal(/\[\s*plugins\./.test(source), false,
    '夹具不得写入 plugins 配置段');

  // And the generated README must not tell the reader to pre-enable the plugin.
  const readmeMatch = /writeFileSync\(join\(workspace, 'README\.md'\),\s*`([\s\S]*?)`/.exec(source);
  const readme = readmeMatch?.[1];
  if (readme) {
    assert.equal(/enabled\s*=\s*true/.test(readme), false,
      '生成的说明不得指示读者预置 enabled = true');
  }
  assert.match(source, /覆盖|outrank/, '应说明为何不写该标志');
});
