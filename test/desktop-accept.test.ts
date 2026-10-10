import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The desktop acceptance runner is the artefact a human acts on, so its own
 * behaviour is tested: it must run unattended, be repeatable, produce a usable
 * report, and never claim that the manual steps are done.
 */
function runAccept(args: string[], timeoutMs = 180_000) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>(resolveRun => {
    const child = spawn(process.execPath, [join(repoRoot, 'scripts', 'desktop-accept.mjs'), ...args], {
      cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once('close', code => { clearTimeout(timer); resolveRun({ code, stdout, stderr, timedOut }); });
  });
}

test('桌面验收脚本可无人值守运行，报告区分自动项与人工项', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'amb-accept-'));
  const workspace = join(fixture, 'ws');
  const dataDir = join(fixture, 'data');
  const reportPath = join(fixture, 'report.json');
  t.after(async () => {
    const rel = relative(resolve(tmpdir()), resolve(fixture));
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    await rm(fixture, { recursive: true, force: true });
  });

  const result = await runAccept(['--workspace', workspace, '--data-dir', dataDir, '--report', reportPath, '--keep']);
  assert.equal(result.timedOut, false, `脚本不得超时：${result.stdout.slice(-300)}`);
  assert.equal(existsSync(reportPath), true, '必须输出报告文件');

  const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
    summary: { pass: number; fail: number; skip: number; manual: number; automatedOk: boolean };
    results: Array<{ id: string; status: string; detail: string; evidence?: string }>;
  };

  // Every run reports both kinds of item; a report without manual items would
  // hide the fact that desktop loading is still unverified.
  assert.ok(report.summary.manual > 0, '报告必须列出需人工完成的步骤');
  const manual = report.results.filter(item => item.status === 'manual');
  for (const item of manual) {
    assert.ok(item.detail.length > 0, `人工项 ${item.id} 必须说明怎么做`);
    assert.ok(item.evidence, `人工项 ${item.id} 必须说明留什么证据`);
  }

  // The runner must not pass an automatable check it could not perform.
  for (const item of report.results) {
    assert.ok(['pass', 'fail', 'skip', 'manual'].includes(item.status), `未知状态：${item.status}`);
  }

  // A failing automated check must be visible rather than swallowed.
  assert.equal(report.summary.automatedOk, report.summary.fail === 0,
    'automatedOk 必须与失败计数一致');
  // Exit code reflects only automatable outcomes.
  assert.equal(result.code, report.summary.automatedOk ? 0 : 1,
    `退出码应与自动项结果一致，实际 ${result.code}`);
});

test('桌面验收脚本可重复运行且结果稳定', async t => {
  // A rerun must not fail because the previous run left a data directory behind:
  // `init` refuses to overwrite an existing configuration.
  const fixture = await mkdtemp(join(tmpdir(), 'amb-accept-repeat-'));
  const workspace = join(fixture, 'ws');
  const dataDir = join(fixture, 'data');
  const first = join(fixture, 'first.json');
  const second = join(fixture, 'second.json');
  t.after(async () => {
    const rel = relative(resolve(tmpdir()), resolve(fixture));
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    await rm(fixture, { recursive: true, force: true });
  });

  const a = await runAccept(['--workspace', workspace, '--data-dir', dataDir, '--report', first]);
  const b = await runAccept(['--workspace', workspace, '--data-dir', dataDir, '--report', second]);
  assert.equal(a.timedOut || b.timedOut, false, '两次运行都不得超时');

  const reportA = JSON.parse(await readFile(first, 'utf8')) as { summary: { pass: number; fail: number } };
  const reportB = JSON.parse(await readFile(second, 'utf8')) as { summary: { pass: number; fail: number } };
  assert.equal(reportB.summary.fail, reportA.summary.fail, '二次运行不得因残留状态而多出失败');
  assert.equal(reportB.summary.pass, reportA.summary.pass, '两次运行的通过数应一致');
});

test('验收报告不含凭据，也不含本机绝对路径', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'amb-accept-secret-'));
  const reportPath = join(fixture, 'report.json');
  t.after(async () => {
    const rel = relative(resolve(tmpdir()), resolve(fixture));
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    await rm(fixture, { recursive: true, force: true });
  });

  await runAccept(['--workspace', join(fixture, 'ws'), '--data-dir', join(fixture, 'data'), '--report', reportPath]);
  const text = await readFile(reportPath, 'utf8');

  // The report is meant to be pasted into an issue, so it must be safe to share.
  assert.equal(/Bearer\s+[A-Za-z0-9]{32,}/.test(text), false, '报告不得包含 bearer 令牌');
  assert.equal(/[a-f0-9]{64}/.test(text), false, '报告不得包含 64 位十六进制凭据');

  // A machine-specific path leaks the author's layout and is useless to a reader
  // on another machine. Loopback endpoints are fine; file paths are not.
  const absolutePaths = [...text.matchAll(/[A-Za-z]:[\\/]{1,2}[A-Za-z][^\s"']*/g)]
    .map(match => match[0])
    .filter(path => !/^[A-Za-z]:[\\/]{1,2}(?:127\.0\.0\.1|localhost)/.test(path));
  assert.deepEqual([...new Set(absolutePaths)], [], '报告不得包含本机绝对路径');
});
