import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

/**
 * Which candidate text is allowed to become `important`.
 *
 * `important` is not a label, it is an exemption: `expireProposals` never lapses such a
 * row, so it waits for a person forever. The submission path decides it from the
 * candidate's own text, and that rule used to match bare substrings — `ReplaceFileW`
 * contains `replace`, and an English "global", "rule" or "important" matched the same
 * way. Measured on the live library at the time of the fix: 95 of 331 pending rows held
 * the exemption and 56 of those carried no Chinese trigger at all, `replace` alone
 * accounting for 24. Every false positive is a machine observation that can never be
 * archived, which is how a thirty-day archive stops being one.
 *
 * The rule now reads the three subjects the design means — a conflict with stored
 * knowledge, a supersession of an earlier conclusion, a request for a human ruling —
 * and both sides of it are asserted here, because the cheap fix (match nothing) would
 * silently drop the very candidate a person was meant to decide.
 */

const DAY = 86_400_000;
const START = 1_700_000_000_000;

function clocked(at = START) {
  const clock = { now: at };
  return { clock, open: () => new Store(':memory:', () => clock.now) };
}

/** Submit one candidate and report the facts the gate decides on it. */
function submitted(s: Store, key: string, discovery: string) {
  const receipt = s.submit('agent', { idempotencyKey: `w8-${key}`, projectId: 'p', discovery }) as { id: string };
  const id = String(receipt.id);
  const row = s.db.prepare('SELECT payload, expires_at FROM proposals WHERE id=?').get(id) as
    { payload: string; expires_at: number };
  return {
    id,
    important: (JSON.parse(row.payload) as { important?: boolean }).important === true,
    expiresAt: Number(row.expires_at),
    state: () => String((s.db.prepare('SELECT state FROM proposals WHERE id=?').get(id) as { state: string }).state),
  };
}

test('机器文本与英文技术词不再让候选获得 important 豁免', () => {
  const MACHINE: Array<[string, string]> = [
    ['【自动捕获的失败事实；待核实】工具：edit；观察：ReplaceFileW EIO (Win32 1175)', 'ReplaceFileW 里的 replace 不是取代语义'],
    ['修复 src/utils/replace.ts 的路径判断，本地文件替换逻辑写错了', 'replace 只是文件路径与操作名的一部分'],
    ['After the migration, replace the old log line with the new prefix and retry.', '英文句子里的动词 replace'],
    ['库内全部条目都是全局作用域，跨项目共享同一份 knowledge.sqlite。', '“全局”是作用域，不是冲突'],
    ['idempotency_conflict 表示同一幂等键携带了不同内容。', 'conflict 长在标识符里，词边界之外'],
    ['这条经验很重要，而 rule 与 global 只是常见技术词。', '“重要”是形容词，rule/global 是泛用词'],
  ];
  const { open } = clocked();
  for (const [index, [text, why]] of MACHINE.entries()) {
    const s = open();
    try {
      const row = submitted(s, `machine-${index}`, text);
      assert.equal(row.important, false, `${why}：${text}`);
      assert.equal(row.expiresAt, START + 30 * DAY, '普通候选仍按三十天期限对待');
    } finally { s.close(); }
  }
});

test('冲突、取代与待裁决仍然被保护，三十天后也不会被清空', () => {
  const HUMAN: Array<[string, string]> = [
    ['这个做法与库里既有流程冲突，需要裁决后再采纳。', '与已有规范冲突'],
    ['这条经验取代了旧结论：不要再用空数组表示未做选择。', '明确取代旧结论'],
    ['候选内容需要人工裁决后才能采纳，先留在队列里。', '要求人工裁决'],
    ['用新做法替换旧的判断，原文随后作废。', '替换并点名了被替换的对象'],
    ['This workflow conflicts with the stored norm and must go to a person.', '英文 conflicts 是真冲突语义'],
  ];
  for (const [index, [text, why]] of HUMAN.entries()) {
    const { clock, open } = clocked();
    const s = open();
    try {
      const row = submitted(s, `human-${index}`, text);
      assert.equal(row.important, true, `${why}：${text}`);
      assert.equal(row.expiresAt, Number.MAX_SAFE_INTEGER, '等待人工裁决的候选没有普通期限');
      clock.now += 31 * DAY;
      assert.deepEqual(s.expireProposals().expired, [], '被保护的候选不得被过期流程清空正文');
      assert.equal(row.state(), 'pending', '它仍在队列里等人工裁决');
    } finally { s.close(); }
  }
});

test('被误判的失败事实到期后真正归档，同批里真正待裁决的候选仍在队列', () => {
  const { clock, open } = clocked();
  const s = open();
  try {
    const failure = submitted(s, 'mixed-failure',
      '【自动捕获的失败事实；待核实】工具：edit；观察：ReplaceFileW EIO (Win32 1175)');
    const conflict = submitted(s, 'mixed-conflict', '这个做法与库里既有流程冲突，需要裁决后再采纳。');
    assert.equal(failure.important, false);
    assert.equal(conflict.important, true);
    clock.now += 31 * DAY;
    const outcome = s.expireProposals();
    assert.deepEqual(outcome.expired, [failure.id], '到期归档的只有被误判的那条');
    assert.equal(failure.state(), 'expired');
    assert.equal(conflict.state(), 'pending');
  } finally { s.close(); }
});
