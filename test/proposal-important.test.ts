import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

/**
 * "Important" must be read as a value, not as a string of JSON.
 *
 * The exemption from the pending deadline used `payload NOT LIKE '%"important":true%'`,
 * which matches the exact spelling `JSON.stringify` produces today. Any writer that pretty-
 * prints, or any payload edited by hand, inserts a space — and then a normative conflict
 * reserved for a human decision is expired and has its text cleared.
 */

const PROJECT = 'p0';
const DAY = 86_400_000;

/**
 * `submit` does not take `important` — the classifier decides it — so the flag is written
 * into the row the same way a later classification pass would.
 */
const submitImportant = (store: Store, key: string, important: boolean) => {
  const { id } = store.submit('agent', { idempotencyKey: key, projectId: PROJECT, discovery: `候选 ${key} 的正文` });
  if (important) {
    const row = store.db.prepare('SELECT payload FROM proposals WHERE id=?').get(id) as { payload: string };
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    payload.important = true;
    store.db.prepare('UPDATE proposals SET payload=? WHERE id=?').run(JSON.stringify(payload), id);
  }
  return id;
};

test('紧凑 JSON 里的 important 仍被豁免', () => {
  const store = new Store(':memory:');
  try {
    const id = submitImportant(store, 'imp-compact', true);
    // The stored text is what `JSON.stringify` produced — the case the old LIKE handled.
    const raw = store.db.prepare('SELECT payload FROM proposals WHERE id=?').get(id) as { payload: string };
    assert.ok(raw.payload.includes('"important":true'), '前提：紧凑写法确实存在');
    store.db.prepare('UPDATE proposals SET expires_at=? WHERE id=?').run(0, id);

    store.expireProposals();
    const after = store.getProposal(id, PROJECT);
    assert.equal(after.state, 'pending', 'important 的候选不该被等待期清掉');
    assert.notEqual((store.db.prepare('SELECT payload FROM proposals WHERE id=?').get(id) as { payload: string }).payload, '{}',
      '正文更要保留：它是等人裁决的那一条');
  } finally { store.close(); }
});

test('带空格的 JSON 同样被豁免（旧实现会在这里失效）', () => {
  const store = new Store(':memory:');
  try {
    const id = submitImportant(store, 'imp-pretty', true);
    // A pretty-printed writer — or a hand-edited payload — inserts a space after the colon.
    store.db.prepare('UPDATE proposals SET payload=?, expires_at=? WHERE id=?')
      .run(JSON.stringify({ important: true, discovery: '候选 imp-pretty 的正文' }, null, 2), 0, id);

    store.expireProposals();
    const after = store.getProposal(id, PROJECT);
    assert.equal(after.state, 'pending',
      ' IMPORTANT 的判定必须看 JSON 值：文本匹配一旦遇到格式化就会把该留的条目清掉');
    assert.ok(String((after.payload as Record<string, unknown>).discovery).includes('imp-pretty'));
  } finally { store.close(); }
});

test('不带 important 的候选照常过期', () => {
  const store = new Store(':memory:');
  try {
    const id = submitImportant(store, 'plain', false);
    store.db.prepare('UPDATE proposals SET expires_at=? WHERE id=?').run(0, id);
    store.expireProposals();
    assert.equal(store.getProposal(id, PROJECT).state, 'expired', '普通候选仍按期限过期，规则没有被放宽');
  } finally { store.close(); }
});
