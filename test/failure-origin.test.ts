import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import {
  collect, proposalSourceFrom, classifyFailureOrigin, failureOriginOf, FAILURE_ORIGIN_MARKER,
  FAILURE_ORIGINS, ORIGIN_RULES, REFINE_DEFAULTS,
} from '../src/refine.js';

/**
 * W14：the sampling frame — which failures the thresholds are allowed to count.
 *
 * The defect being pinned: two processes editing one file produce a refusal that the
 * *tool* reported (`old_string was not found in "…"`, `file changed since it was read`),
 * and auto-capture used to file it as a repeated failure worth distilling. 22 of this
 * library's failure facts (measured, `verification/r5/replay-failure-origin.mjs`) are
 * exactly that, plus 34 host refusals (EIO, timeouts, interrupted calls). Counting them
 * inflated the occurrence numbers the thresholds were calibrated against and would have
 * distilled "when the editor refuses the write, retry" as a norm.
 *
 * What these tests hold: those rows still get captured and stored — they are simply not
 * in the population that calibrates thresholds and not sampled for suggestions — and the
 * exclusion is reported, not silent. The mechanism is deliberately separate from the
 * negative filters, so both tests appear here side by side.
 *
 * The reproducibility criterion is not pinned here because it is not decidable here:
 * "does another independent execution hit this" is answered by a re-run or a reviewer,
 * never by the count of sightings, and the count is only an attention bound.
 */

const PROJECT = 'p0-workflow';
const clock = { now: 1_700_000_000_000 };
const open = () => new Store(':memory:', () => clock.now);

/** Byte-for-byte the wrapper the adapter wrote *before* W14 (no origin line). */
const captureLegacy = (tool: string, observation: string, session = 'sess-a') =>
  '【自动捕获的失败事实；待核实】\n'
  + '所属流程：工具执行与故障恢复；步骤：记录失败、检索已有经验、验证修复。\n'
  + `来源：dsh 会话 ${session}；工具：${tool}。\n`
  + `观察：${observation}\n`
  + '根因与修复：尚未验证；请主动检索相关经验，验证后用 amb_submit_experience 补充可复用结论。不得将本记录直接当作已采纳规范。';

/** The same wrapper as `adapters/dsh/failure-capture.mjs` writes it now. */
const captureMarked = (tool: string, observation: string, session = 'sess-a') => {
  const { origin, rule } = classifyFailureOrigin(observation);
  return '【自动捕获的失败事实；待核实】\n'
    + '所属流程：工具执行与故障恢复；步骤：记录失败、检索已有经验、验证修复。\n'
    + `来源：dsh 会话 ${session}；工具：${tool}。\n`
    + `${FAILURE_ORIGIN_MARKER}${origin}；判据：${rule}。\n`
    + `观察：${observation}\n`
    + '根因与修复：尚未验证；请主动检索相关经验，验证后用 amb_submit_experience 补充可复用结论。不得将本记录直接当作已采纳规范。';
};

let seq = 0;
/**
 * Submit one capture. The session id varies per call on purpose: the store deduplicates
 * byte-identical submissions, so a fixture that repeated one wrapper would store a single
 * row and quietly measure nothing. `autoFailureSignature` normalises the session away, so
 * the signature — and therefore the group under test — is unaffected.
 */
function submit(s: Store, tool: string, observation: string, options: { gapMs?: number; marked?: boolean } = {}): string {
  seq += 1;
  clock.now += options.gapMs ?? 60_000;
  const build = options.marked ? captureMarked : captureLegacy;
  return String(s.submit('agent', {
    idempotencyKey: `origin-${seq}`, projectId: PROJECT, discovery: build(tool, observation, `sess-${seq}`),
  }).id);
}

const source = (s: Store) => proposalSourceFrom(
  s.db as unknown as { prepare: (sql: string) => { all: (...params: unknown[]) => unknown[] } },
  [PROJECT],
);
const read = (s: Store) => collect({ source: source(s), meta: () => undefined, now: clock.now });
const footprint = (s: Store) => ({
  proposals: Number((s.db.prepare('SELECT count(*) AS n FROM proposals').get() as { n: number }).n),
  revision: s.revision,
  adoptions: Number((s.db.prepare('SELECT count(*) AS n FROM adoptions').get() as { n: number }).n),
});

/** The two shapes the usage report measured on this library, by name. */
const COLLISION_SHAPES = [
  'old_string was not found in "D:\\huange-skill\\src\\refine.ts"',
  'cannot edit "D:\\huange-skill\\adapters\\dsh\\recall.mjs": file changed since it was read — re-read the file, then retry',
];

test('W14-R1：两个进程并发编辑同一文件的失败不得进入提炼采样（12 次也不行）', () => {
  const s = open();
  try {
    for (const shape of COLLISION_SHAPES)
      for (let i = 0; i < 12; i += 1) submit(s, 'edit', shape, { gapMs: 600_000 });
    const before = footprint(s);
    const run = read(s);
    assert.equal(run.groups, 2, '两个签名都被认出是自动捕获的失败事实');
    assert.equal(run.sampledGroups, 0, '没有任何签名进入阈值统计');
    assert.equal(run.considered, 0);
    assert.equal(run.suggestions.length, 0, '并发冲突不得变成候选');
    // Both of the other mechanisms must stay out of it: this is not "below threshold"
    // and not "blocked by a negative filter", it is "not part of the population".
    assert.equal(run.belowThreshold.length, 0, '它们连门槛都没到，不是"差一点"');
    assert.equal(run.suppressed.length, 0, '不是负向过滤挡下的（那是另一个判断）');
    assert.equal(run.excludedByOrigin.length, 2);
    for (const excluded of run.excludedByOrigin) {
      assert.deepEqual(excluded.origins, ['tool_collision']);
      assert.equal(excluded.occurrences, 12);
      assert.deepEqual(excluded.bases, ['derived'], '旧行没有标记，分类是从正文推导的');
    }
    assert.deepEqual(run.origins.find(entry => entry.origin === 'tool_collision'),
      { origin: 'tool_collision', rows: 24, groups: 2 });
    assert.deepEqual(run.origins.find(entry => entry.origin === 'task_failure'),
      { origin: 'task_failure', rows: 0, groups: 0 });
    assert.match(run.note, /tool_collision 24 条/);
    assert.deepEqual(footprint(s), before, '干跑仍然一个字都不写');
  } finally { s.close(); }
});

test('W14-R2：环境类（超时/EIO/EPERM/端口占用/中断）同样不进入，且次数垫不起门槛', () => {
  const s = open();
  try {
    const shapes: Array<[string, string]> = [
      ['glob', 'tool call timed out after 30000ms'],
      ['edit', 'ReplaceFileW EIO (Win32 1175)'],
      ['pwsh', 'EPERM: operation not permitted, rename "D:\\a\\b.txt" -> "E:\\a\\b.txt"'],
      ['pwsh', 'Error: listen EADDRINUSE: address already in use 127.0.0.1:8787'],
      ['group_relay', 'tool call aborted'],
    ];
    // Eight sightings each: every one of these would satisfy `minOccurrences = 2` and
    // the span bound, which is exactly why the frame has to exclude them before those
    // numbers are computed.
    for (const [tool, shape] of shapes)
      for (let i = 0; i < 8; i += 1) submit(s, tool, shape, { gapMs: 600_000, marked: true });
    const run = read(s);
    assert.equal(run.groups, 5);
    assert.equal(run.sampledGroups, 0);
    assert.equal(run.suggestions.length, 0);
    assert.equal(run.excludedByOrigin.length, 5);
    assert.equal(run.excludedByOrigin.every(entry => entry.origins.length === 1 && entry.origins[0] === 'environment'), true);
    assert.equal(run.excludedByOrigin.every(entry => entry.bases.length === 1 && entry.bases[0] === 'marker'), true);
    assert.deepEqual(run.origins.find(entry => entry.origin === 'environment'),
      { origin: 'environment', rows: 40, groups: 5 });

    // The counterpart: the same 8 sightings of a *task* failure do produce. Without
    // this, "no suggestion" could just mean the scheduler stopped working.
    const other = open();
    try {
      for (let i = 0; i < 8; i += 1) submit(other, 'read', 'cannot read "D:\\proj\\src\\missing.ts": not found', { gapMs: 600_000, marked: true });
      const passing = read(other);
      assert.equal(passing.suggestions.length, 1, '普通任务失败仍然正常产出');
      assert.equal(passing.suggestions[0]!.occurrences, 8);
      assert.equal(passing.origins.find(entry => entry.origin === 'task_failure')!.rows, 8);
    } finally { other.close(); }
  } finally { s.close(); }
});

test('W14-R3：普通任务失败（旧行）仍正常进入采样，门槛语义不变', () => {
  const s = open();
  try {
    // A single sighting of a genuine task failure: still below `minOccurrences`, and it
    // must be reported as such rather than as a collision.
    submit(s, 'read', 'cannot read "D:\\proj\\src\\missing.ts": not found', { gapMs: 5_000 });
    const once = read(s);
    assert.equal(once.sampledGroups, 1, '任务失败进入统计');
    assert.equal(once.origins.find(entry => entry.origin === 'task_failure')!.rows, 1);
    assert.equal(once.excludedByOrigin.length, 0);
    assert.equal(once.suggestions.length, 0, '单次仍然不产出');
    assert.match(once.belowThreshold[0]!.why, /出现 1 次 < 下限 2/);
  } finally { s.close(); }
});

test('W14-R4：来源分类与负向过滤是两个判断，谁都不能替代谁', () => {
  // (a) A real task failure that carries nothing to act on: the *filter* removes it and
  // the *frame* keeps it. If the two judgements were merged, this group would look like
  // an accident.
  const a = open();
  try {
    for (let i = 0; i < 12; i += 1) submit(a, 'pwsh', 'exit_code=1', { gapMs: 660_000, marked: true });
    const run = read(a);
    assert.equal(run.sampledGroups, 1, '没有可行动信息的失败仍然是采样对象');
    assert.equal(run.suppressed.length, 1, '挡住它的是负向过滤');
    assert.equal(run.suppressed[0]!.rule, 'no_actionable_detail');
    assert.equal(run.excludedByOrigin.length, 0, '它不是来源分类移除的');
    assert.equal(run.origins.find(entry => entry.origin === 'task_failure')!.rows, 12);
  } finally { a.close(); }

  // (b) A collision refusal carries plenty to act on ("old_string was not found in X")
  // and passes every negative filter — and is still out, because the question the frame
  // answers is a different one.
  const b = open();
  try {
    for (let i = 0; i < 12; i += 1) submit(b, 'edit', COLLISION_SHAPES[0]!, { gapMs: 660_000, marked: true });
    const run = read(b);
    assert.equal(run.suppressed.length, 0, '负向过滤没有、也不该挡住它');
    assert.equal(run.belowThreshold.length, 0);
    assert.equal(run.excludedByOrigin.length, 1, '是来源分类把它移出了统计');
  } finally { b.close(); }
});

test('W14-R5：行上的标记优先于事后推导，且规则表本身可核对', () => {
  const marked = failureOriginOf(captureMarked('edit', COLLISION_SHAPES[1]!));
  assert.deepEqual(marked, { origin: 'tool_collision', rule: 'concurrent_edit_file_changed', basis: 'marker' });

  // A row captured by an older adapter: no marker, so the class is reconstructed from
  // the text it stored — otherwise all 145 rows already in the library would read as
  // `task_failure`.
  const derived = failureOriginOf(captureLegacy('edit', COLLISION_SHAPES[1]!));
  assert.equal(derived.origin, 'tool_collision');
  assert.equal(derived.basis, 'derived');

  // The capture's own statement wins when the two disagree: it was written by the host
  // that saw the structured result, and a later rule change must not re-file it.
  const conflicting = captureLegacy('edit', COLLISION_SHAPES[0]!).replace(FAILURE_ORIGIN_MARKER + 'task_failure', FAILURE_ORIGIN_MARKER + 'tool_collision')
    + '';
  assert.equal(failureOriginOf(conflicting).basis, 'derived');
  const overridden = captureMarked('edit', COLLISION_SHAPES[0]!)
    .replace(FAILURE_ORIGIN_MARKER + 'tool_collision', FAILURE_ORIGIN_MARKER + 'task_failure');
  assert.equal(failureOriginOf(overridden).origin, 'task_failure', '标记优先，即使正文看起来像并发冲突');
  assert.equal(failureOriginOf(overridden).basis, 'marker');

  // A default that is a real value, never "unknown": anything unclassified is a task
  // failure, so a rule that misses only ever loses precision, never rows.
  assert.deepEqual(classifyFailureOrigin('ENOENT: configuration file missing'), { origin: 'task_failure', rule: 'default' });
  assert.deepEqual(classifyFailureOrigin(''), { origin: 'task_failure', rule: 'default' });
  assert.equal(FAILURE_ORIGINS.length, 3);
  assert.equal(ORIGIN_RULES.every(rule => FAILURE_ORIGINS.includes(rule.origin)), true);
  assert.equal(new Set(ORIGIN_RULES.map(rule => rule.id)).size, ORIGIN_RULES.length, '规则 id 必须唯一');
  assert.equal(REFINE_DEFAULTS.minOccurrences, 2, '本任务的对比以 minOccurrences=2 为门槛');
});
