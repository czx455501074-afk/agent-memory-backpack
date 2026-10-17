import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { collect, proposalSourceFrom, refineThresholds, confidenceOf, NEGATIVE_FILTERS, REFINE_DEFAULTS } from '../src/refine.js';
import { refineStatus } from '../src/maintenance.js';

/**
 * W11 第二阶段：the distillation skeleton, pinned to the properties that make it safe
 * to leave switched off.
 *
 * The numbers in the defaults come from a read-only census of this library's own queue
 * (`verification/r5/replay-failure-distribution.mjs`, 2026-10-17): 360 pending = 134
 * auto-captured failures + 226 human submissions over 46 signatures, 37 signatures
 * appearing exactly once, the top three signatures carrying 49% of all failure rows.
 * The tests below use the same shapes the census found, so what they assert is what
 * the queue actually contains rather than a synthetic ideal.
 *
 * What matters is not that it produces candidates — it is that it does not produce
 * them from noise, never writes, and says what it withheld.
 */

const PROJECT = 'p0-workflow';
const clock = { now: 1_700_000_000_000 };
const open = () => new Store(':memory:', () => clock.now);

/** Byte-for-byte the text `adapters/dsh/failure-capture.mjs` submits for a failure. */
const captured = (tool: string, observation: string, session = 'sess-a') =>
  '【自动捕获的失败事实；待核实】\n'
  + '所属流程：工具执行与故障恢复；步骤：记录失败、检索已有经验、验证修复。\n'
  + `来源：dsh 会话 ${session}；工具：${tool}。\n`
  + `观察：${observation}\n`
  + '根因与修复：尚未验证；请主动检索相关经验，验证后用 amb_submit_experience 补充可复用结论。不得将本记录直接当作已采纳规范。';

let seq = 0;
/** Capture one failure through the ordinary submit path, as the adapter does. */
function capture(s: Store, tool: string, observation: string, gapMs = 60_000): string {
  seq += 1;
  clock.now += gapMs;
  return String(s.submit('agent', { idempotencyKey: `refine-${seq}`, projectId: PROJECT, discovery: captured(tool, observation, `sess-${seq}`) }).id);
}

const source = (s: Store) => proposalSourceFrom(
  s.db as unknown as { prepare: (sql: string) => { all: (...params: unknown[]) => unknown[] } },
  [PROJECT],
);
const read = (s: Store, projects: string[] = [PROJECT]) => collect({ source: source(s), meta: () => undefined, now: clock.now });

/** The rows the run must never touch, counted before and after. */
const footprint = (s: Store) => ({
  proposals: Number((s.db.prepare('SELECT count(*) AS n FROM proposals').get() as { n: number }).n),
  revision: s.revision,
  adoptions: Number((s.db.prepare('SELECT count(*) AS n FROM adoptions').get() as { n: number }).n),
});

test('W11-R1：负向过滤挡住"只有错误码"的失败，重复再多次也不产出（实测 21 条 pwsh exit_code=1 一类）', () => {
  const s = open();
  try {
    // Same signature twelve times across more than two minutes: every threshold is
    // satisfied, so only the negative filter can stop it.
    for (let i = 0; i < 12; i += 1) capture(s, 'pwsh', 'exit_code=1', 660_000);
    const run = read(s);
    assert.equal(run.groups, 1, '这一批只有一个签名');
    assert.equal(run.suggestions.length, 0, '只有错误码的失败不得变成候选');
    assert.equal(run.suppressed.length, 1);
    assert.equal(run.suppressed[0]!.rule, 'no_actionable_detail');
    assert.match(run.suppressed[0]!.reason, /没有具体对象/);

    // The counterpart: the same shape of failure *with* a concrete object does pass,
    // otherwise "no detail" would secretly mean "no failures here ever". The fixture is a
    // `task_failure` shape on purpose: since W14 the concurrent-edit refusals are out of
    // the sampling frame entirely (see `test/failure-origin.test.ts`), so a collision
    // fixture would no longer exercise the negative filter this test is about.
    const other = open();
    try {
      for (let i = 0; i < 12; i += 1) capture(other, 'edit', 'old_string matched 2 times in "D:\\proj\\src\\a.ts"; provide a more specific old_string or set replace_all to true', 660_000);
      const passed = read(other);
      assert.equal(passed.suggestions.length, 1, '带具体对象的重复失败应当产出候选');
      assert.equal(passed.suppressed.length, 0);
    } finally { other.close(); }
  } finally { s.close(); }
});

test('W11-R2：只出现一次的签名不产出（实测 37 个单次签名 = 失败事实的 27%）', () => {
  const s = open();
  try {
    capture(s, 'read', 'offset 55 is out of range for "D:\\proj\\src\\a.ts" (47 lines)', 10_000);
    const run = read(s);
    assert.equal(run.groups, 1);
    assert.equal(run.suggestions.length, 0, '单次签名是一个会话的噪声，不是模式');
    assert.equal(run.belowThreshold.length, 1, '未产出的原因必须被报出，而不是静默');
    assert.match(run.belowThreshold[0]!.why, /出现 1 次 < 下限 2/);
    assert.equal(run.belowThreshold[0]!.confidence < REFINE_DEFAULTS.minConfidence, true);
  } finally { s.close(); }
});

test('W11-R3：达到门槛才产出，正文自述"尚未验证"，并带上可核对的成员', () => {
  const s = open();
  try {
    const ids: string[] = [];
    for (let i = 0; i < 8; i += 1) ids.push(capture(s, 'edit', 'cannot modify "D:\\proj\\src\\b.ts": file has not been read — read the file, then retry', 60_000));
    const run = read(s);
    assert.equal(run.suggestions.length, 1, '8 次、跨度超过 120 秒的签名应当产出');
    const item = run.suggestions[0]!;
    assert.equal(item.occurrences, 8);
    assert.equal(item.memberIds.length, 8, '建议必须能指回它读的那几条记录');
    assert.deepEqual([...item.memberIds].sort(), [...ids].sort(), '成员就是实际入库的那些候选');
    assert.ok(item.confidence >= REFINE_DEFAULTS.minConfidence);
    assert.match(item.discovery, /尚未验证/, '正文不得声称已经验证');
    assert.match(item.evidence, /8 条同签名/, '证据必须写明来源数量');
    assert.ok(item.lastSeenAt > item.firstSeenAt, '首末时间必须来自真实时间戳');
  } finally { s.close(); }
});

test('W11-R4：每次产出有上限，且被上限挡下的条数如实报出', () => {
  const s = open();
  try {
    // Six distinct signatures, each repeated eight times: more than the ceiling.
    // The codes are deliberately task-failure ones: `EIO`, `EPERM`, `ETIMEDOUT` and the
    // `Win32 1175` replacement code are classified `environment` (W14), and a fixture
    // that no longer reaches the thresholds could not measure the ceiling.
    const codes = ['ENOENT', 'EACCES', 'EEXIST', 'EISDIR', 'ENOTDIR'];
    const shapes = [
      'old_string matched 2 times in "D:\\proj\\src\\a.ts"; provide a more specific old_string or set replace_all to true',
      ...codes.map((code) => `read ${code} while opening "D:\\proj\\src\\a.ts"`),
    ];
    for (const shape of shapes)
      for (let i = 0; i < 8; i += 1) capture(s, 'edit', shape, 90_000);
    const run = read(s);
    assert.equal(run.considered, 6, '六个签名都过了门槛');
    assert.equal(run.suggestions.length, REFINE_DEFAULTS.maxProposalsPerRun, '产出不得超过上限');
    assert.equal(run.withheld, 6 - REFINE_DEFAULTS.maxProposalsPerRun, '被上限挡下的数量必须报出，不能静默丢弃');
    assert.deepEqual([...run.suggestions].sort((a, b) => b.confidence - a.confidence).map(i => i.signature),
      run.suggestions.map(i => i.signature), '上限截取的是置信度最高的几条');
  } finally { s.close(); }
});

test('W11-R5：门槛可从 core 的 meta 覆盖，非法值回落到保守默认', () => {
  const s = open();
  try {
    const values = new Map<string, number>();
    const meta = (key: string) => values.get(key);
    // A single sighting is below the default floor…
    capture(s, 'read', 'offset 55 is out of range for "D:\\proj\\src\\a.ts" (47 lines)', 5_000);
    assert.equal(collect({ source: source(s), meta, now: clock.now }).suggestions.length, 0);

    // …and becomes eligible when the operator lowers the floor deliberately. The
    // confidence floor is relaxed too, because one sighting cannot earn repetition and
    // the point here is that the override is read, not that it produces good output.
    values.set('refine.minOccurrences', 1);
    // The span bound has to come down to 0 as well, which is a legal override and a
    // real case: a group with a single member has `lastSeenAt == firstSeenAt`, so its
    // span is exactly 0 and any positive bound rejects it. `0` means "any span"; a
    // negative value is still refused as meaningless.
    values.set('refine.minSpanMs', 0);
    values.set('refine.minConfidence', 0.01);
    const lowered = collect({ source: source(s), meta, now: clock.now });
    assert.equal(lowered.thresholds.minSpanMs, 0);
    assert.equal(lowered.suggestions.length, 1, 'meta 覆盖必须生效');
    assert.equal(lowered.thresholds.minConfidence, 0.01, '小于 1 的置信度下限必须能被配置，而不是被当成非法值丢掉');
    values.set('refine.minSpanMs', -1);
    assert.equal(refineThresholds(meta).minSpanMs, REFINE_DEFAULTS.minSpanMs, '负跨度不是跨度');
    assert.equal(lowered.thresholds.minOccurrences, 1);
    assert.equal(lowered.thresholds.minConfidence, 0.01, '小于 1 的置信度下限必须能被配置，而不是被当成非法值丢掉');

    // A nonsense override leaves the default in force rather than becoming permissive.
    values.set('refine.minOccurrences', -5);
    assert.equal(refineThresholds(meta).minOccurrences, REFINE_DEFAULTS.minOccurrences);
    values.set('refine.maxProposalsPerRun', 1.5);
    assert.equal(refineThresholds(meta).maxProposalsPerRun, REFINE_DEFAULTS.maxProposalsPerRun);
    values.set('refine.minConfidence', 3);
    assert.equal(refineThresholds(meta).minConfidence, REFINE_DEFAULTS.minConfidence, '超过 1 的置信度不是置信度');
  } finally { s.close(); }
});

test('W11-R6：干跑绝不写库——候选、修订、采纳账本前后一致', () => {
  const s = open();
  try {
    // A group that does pass the thresholds, so the run under test is a run that would
    // have produced something. The concurrent-edit shape that used to sit here is
    // `tool_collision` since W14 and never reaches this stage.
    for (let i = 0; i < 9; i += 1) capture(s, 'edit', 'cannot modify "D:\\proj\\src\\c.ts": file has not been read — read the file, then retry', 60_000);
    const before = footprint(s);
    const first = read(s);
    const second = read(s);
    const after = footprint(s);
    assert.deepEqual(after, before, '提炼前后 proposals/revision/adoptions 必须逐项一致');
    assert.equal(first.dryRun, true, '这条路径只能以干跑形式存在');
    assert.equal(second.suggestions.length, first.suggestions.length, '重复运行结果稳定');
    assert.match(String(first.note), /未写入任何候选或知识条目/);
    assert.equal(NEGATIVE_FILTERS.every((filter) => /^[a-z_]+$/.test(filter.id)), true, '规则 id 必须稳定可枚举');
  } finally { s.close(); }
});

test('W11-R7：refineStatus 走真实 store 也是只读，且报出实际生效的门槛', () => {
  const s = open();
  try {
    for (let i = 0; i < 8; i += 1) capture(s, 'read', 'cannot read "D:\\proj\\src\\missing.ts": not found', 60_000);
    const before = footprint(s);
    const run = refineStatus(s, { projects: [PROJECT] });
    assert.equal(run.thresholds.minOccurrences, REFINE_DEFAULTS.minOccurrences, '未覆盖时用默认值');
    assert.equal(run.scanned, 8, '扫描的是待审候选');
    assert.equal(run.suppressed.length, 0, '带具体对象的失败不应被负向过滤挡住');
    assert.equal(run.suggestions.length, 1);
    assert.deepEqual(footprint(s), before, '通过 store 读取同样不得写入任何内容');
  } finally { s.close(); }
});

test('W11-R8：置信度由证据决定——重复次数与跨度不足时达不到下限', () => {
  // Pinned as a formula, because the number decides whether anything is produced.
  assert.equal(confidenceOf({ occurrences: 1, spanMs: 1_000_000, samples: 1, withRootCause: 0, distinctObservations: 1 }), 0.4);
  assert.equal(confidenceOf({ occurrences: 8, spanMs: 600_000, samples: 8, withRootCause: 0, distinctObservations: 1 }), 1);
  // Twelve sightings inside one minute: plenty of repetition, no spread. This is the
  // measured shape of a retry loop, and it stays below the floor.
  assert.equal(confidenceOf({ occurrences: 12, spanMs: 60_000, samples: 12, withRootCause: 0, distinctObservations: 1 }), 0.775);
  // Its real counterpart — nine sightings across a day of sessions — passes.
  assert.equal(confidenceOf({ occurrences: 9, spanMs: 103_301_000, samples: 9, withRootCause: 0, distinctObservations: 1 }), 1);
  // Equal repetition and span, weaker agreement: this is what the stability term is
  // for, and it stays below the floor.
  assert.equal(confidenceOf({ occurrences: 8, spanMs: 120_000, samples: 8, withRootCause: 0, distinctObservations: 8 }), 0.669);
  assert.ok(0.669 < REFINE_DEFAULTS.minConfidence, '证据更弱时不得过关');
});
