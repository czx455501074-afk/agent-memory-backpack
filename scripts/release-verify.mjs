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
function step(name, command, { required = true, pattern, detailPattern, live = false, retry = true } = {}) {
  if (live && skipLive) return { name, ok: null, detail: '已跳过（--skip-live）', required };
  const run = () => {
    const started = Date.now();
    const result = spawnSync(command, { cwd: root, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const ms = Date.now() - started;
    // `pattern` decides pass or fail and must be written so it cannot match by accident.
    // `detailPattern` only supplies the number shown to the reader; conflating the two is
    // how this script previously reported green suites as red.
    const match = detailPattern ? detailPattern.exec(output) : (pattern ? pattern.exec(output) : null);
    const ok = result.status === 0 && (!pattern || pattern.test(output));
    return { ok, match, ms, status: result.status };
  };

  let first = run();
  // A failure is retried once, because a single attempt cannot tell "the code is broken"
  // from "this step raced something outside itself". If the retry passes, the result is
  // reported as flaky with the first exit code kept, rather than quietly rounded to pass;
  // if it fails again, the reproducible failure is what gets reported.
  let flaky = false;
  if (!first.ok && retry) {
    const second = run();
    if (second.ok) { first = second; flaky = true; }
    else first = second;
  }
  const detail = flaky
    ? `重跑通过（首次退出码 ${first.status}）——不稳定，需查并发编辑或计时`
    : (first.match ? first.match.slice(1).filter(Boolean).join(' / ') : (first.status === 0 ? `${first.ms}ms` : `退出码 ${first.status}`));
  return { name, ok: first.ok, detail, required, flaky, ms: first.ms };
}

const results = [
  step('类型检查与构建', 'npm run build', { pattern: /tsc -p tsconfig\.json[\s\S]*$/ }),
  // node's reporter prints "ℹ fail 0"; TAP's "# fail 0" is a different format. The first
  // version of this harness looked for the TAP form, never matched, and so reported every
  // passing suite as FAILED. I then explained that as a flaky race and wrote it up as a
  // lesson about flakiness - the lesson was wrong, the check was wrong. Assert on the
  // failure count being zero, because that is the thing that matters, and it cannot match
  // by accident.
  step('全量测试（dist）', 'node --test dist/test/*.test.js', { pattern: /ℹ fail 0\b/, detailPattern: /ℹ pass (\d+)/ }),
  step('全量测试（.mjs）', 'node --test test/*.test.mjs', { pattern: /ℹ fail 0\b/, detailPattern: /ℹ pass (\d+)/ }),
  step('交付契约（此前各轮是否还在）', 'node scripts/verify-deliverables.mjs', { pattern: /(\d+\/\d+ 通过[^\n]*)/ }),
  step('工具面 × admin 白名单对账', 'node scripts/verify-tool-surface.mjs'),
  step('文档不含机器路径', 'node scripts/sanitize-doc-paths.mjs --check', { pattern: /(\d+ file\(s\) would change)/ }),
  step('冷启动安装面', 'node --test dist/test/clean-install.test.js', { pattern: /ℹ fail 0\b/, detailPattern: /ℹ pass (\d+)/ }),
  step('打包内容', 'npm pack --dry-run', { pattern: /package size: ([^\n]*)/ }),
  step('真实库状态（只读）', 'node scripts/r5-live-state.mjs', { pattern: /(\d+) 条 pending/ }),
  step('对运行中的核心验收', 'node scripts/r5-live-verify.mjs', { live: true, pattern: /(\d+\/\d+) 通过/ }),
  // The desktop app is one of this product's two surfaces, and until now the release chain did
  // not look at it at all: package.mjs wrote `desktopVerified: false` as a literal, so a build
  // could ship while the desktop acceptance suite went unrun and unreported. It is `required`,
  // not advisory - "we did not check" and "we checked and it passed" must not look the same on
  // release day. `--skip-desktop-accept` on package.mjs still exists for a quick local build, and
  // the artifact records 'skipped' in that case; this line is what makes skipping visible.
  step('桌面端验收（Tauri）', 'node scripts/desktop-accept.mjs', { pattern: /自动项\s+通过=(\d+)/ }),
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
