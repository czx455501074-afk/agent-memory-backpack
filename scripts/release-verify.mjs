// The release verification, in one command, with one verdict.
//
// Every check in docs/release-checklist.md already existed as its own script. Running
// them by hand has two problems: they get skipped under time pressure, and a run where
// three of six passed looks the same as a run where all six did. This runs them in
// order, prints one line each, and exits non-zero if any required check fails.
//
// IMPORTANT: do not run this while another workstream is mid-edit. It builds, and a
// build taken during in-flight edits compiles half-finished work into dist, which makes
// "the current test result" meaningless. That mistake was made once in R5; this script
// cannot detect it, so the rule is on the operator.
//
// Usage: node scripts/release-verify.mjs [--skip-live] [--json]
//   --skip-live   skip the checks that need a running core (for a clean checkout)
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const args = process.argv.slice(2);
const skipLive = args.includes('--skip-live');
const asJson = args.includes('--json');

/** Run one step and reduce its output to a single verdict line. */
function step(name, command, { required = true, pattern, live = false, retry = true } = {}) {
  if (live && skipLive) return { name, ok: null, detail: '已跳过（--skip-live）', required };
  const run = () => {
    const started = Date.now();
    const result = spawnSync(command, { cwd: root, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const ms = Date.now() - started;
    const match = pattern ? pattern.exec(output) : null;
    // A step without an explicit pattern succeeds when the process exits 0. Steps whose
    // tool reports failures with a zero exit need a pattern (the test runner does not,
    // which is why its summary is read explicitly).
    const ok = result.status === 0 && (!pattern || Boolean(match));
    return { ok, match, ms, status: result.status };
  };

  let first = run();
  // A failure is retried once, because this harness has produced one that did not
  // survive a second run: it built while another workstream was mid-edit, so the
  // compiled tree was momentarily incomplete and the install-face test failed. A single
  // attempt cannot tell "the code is broken" from "I raced someone". The difference
  // matters, so it is measured rather than guessed - and a flaky result is reported as
  // flaky instead of being quietly rounded to pass.
  let flaky = false;
  if (!first.ok && retry) {
    const second = run();
    if (second.ok) { first = second; flaky = true; }
    else first = second; // report the second failure's detail: it is the reproducible one
  }
  const detail = flaky
    ? `重跑通过（首次退出码 ${first.status}）——不稳定，需查并发编辑或计时`
    : (first.match ? first.match.slice(1).filter(Boolean).join(' / ') : (first.status === 0 ? `${first.ms}ms` : `退出码 ${first.status}`));
  return { name, ok: first.ok, detail, required, flaky, ms: first.ms };
}

const results = [
  step('类型检查与构建', 'npm run build', { pattern: /tsc -p tsconfig\.json[\s\S]*$/ }),
  step('全量测试（dist）', 'node --test dist/test/*.test.js', { pattern: /# (pass|fail) (\d+)[\s\S]*?# (pass|fail) (\d+)/ }),
  step('全量测试（.mjs）', 'node --test test/*.test.mjs'),
  step('交付契约（此前各轮是否还在）', 'node scripts/verify-deliverables.mjs', { pattern: /(\d+\/\d+ 通过[^\n]*)/ }),
  step('工具面 × admin 白名单对账', 'node scripts/verify-tool-surface.mjs'),
  step('文档不含机器路径', 'node scripts/sanitize-doc-paths.mjs --check', { pattern: /(\d+ file\(s\) would change)/ }),
  step('冷启动安装面', 'node --test dist/test/clean-install.test.js', { pattern: /# pass (\d+)/ }),
  step('打包内容', 'npm pack --dry-run', { pattern: /package size: ([^\n]*)/ }),
  step('真实库状态（只读）', 'node scripts/r5-live-state.mjs', { pattern: /(\d+) 条 pending/ }),
  step('对运行中的核心验收', 'node scripts/r5-live-verify.mjs', { live: true, pattern: /(\d+\/\d+ 通过)/ }),
];

const failed = results.filter(row => row.required && row.ok === false);
if (asJson) {
  console.log(JSON.stringify({ results, failed: failed.length }, null, 2));
} else {
  console.log('发布前验证\n');
  for (const row of results) {
    const tag = row.ok === null ? 'SKIP ' : row.ok ? 'PASS ' : 'FAIL ';
    console.log(`${tag} ${row.name.padEnd(28)} ${row.detail ?? ''}`);
  }
  const ran = results.filter(row => row.ok !== null).length;
  console.log(`\n${results.filter(row => row.ok === true).length}/${ran} 通过${skipLive ? '（已跳过需要运行中核心的检查）' : ''}。`);
  if (failed.length) {
    console.log('\n未通过的项必须处理或明确标注为已知限制；发布说明里不能出现"全部通过"而实际有 FAIL。');
  }
}
process.exit(failed.length ? 1 : 0);
