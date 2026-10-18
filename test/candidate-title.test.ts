import assert from 'node:assert/strict';
import test from 'node:test';
import { Store, derivedTitle } from '../src/store.js';

/**
 * A candidate has text, not a title.
 *
 * Adopting one used to end in a form field the reviewer had to fill: the panel disabled
 * its confirm button while the title was empty, and a caller that skipped the form left
 * the core to reject the entry (`title` is `min(1)` in the schema). The title is an index
 * label — the decision under review is the kind and the scope — so the core now derives
 * it from the candidate's own first line. These cases pin the derivation and the
 * end-to-end behaviour that a reviewer sees.
 */

test('候选标题去掉 Markdown 外壳，并且永远不会是空串', () => {
  assert.equal(derivedTitle('## 现象\n\n正文', 'x'), '现象', '二级标题必须去掉井号');
  assert.equal(derivedTitle('- 先做这个\n- 再做那个', 'x'), '先做这个', '列表符号必须去掉');
  assert.equal(derivedTitle('```js\ncode\n```\n真正的第一行', 'x'), '真正的第一行',
    '代码围栏不能当标题，要取围栏之后的第一行');
  assert.equal(derivedTitle('   \n\n  ', 'fallback-id'), 'fallback-id', '全空白时退回给出的兜底值');
  assert.equal(derivedTitle('', ''), '未命名条目', '连兜底值都没有时也必须给出可读标题');
  assert.equal(derivedTitle('a   b\n第二行', 'x'), 'a b', '内部多余空白要折叠');
  const long = '很'.repeat(200);
  const shortened = derivedTitle(long, 'x');
  assert.equal(shortened.length, 61, '超长标题截到 60 字后加一个省略号');
  assert.ok(shortened.endsWith('…'), '截断必须有可见标记，不能悄悄变短');
});

test('采纳时标题留空，用候选首行命名而不是拒绝', () => {
  const store = new Store(':memory:');
  try {
    const submitted = store.submit('agent', {
      idempotencyKey: 'derived-title-1',
      projectId: 'p0',
      discovery: '## 现象\n\n`VACUUM` 之后重建索引耗时约 250 ms。',
    });
    store.approveProposal(submitted.id, {
      id: 'memory:derived-title',
      kind: 'memory',
      // Blank on purpose: this is what an untouched form (or an API caller that has no
      // opinion about naming) sends, and it must not be the reason adoption fails.
      title: '   ',
      body: '正文内容。',
      scope: { kind: 'project', projectId: 'p0' },
      baseRevision: 0,
    }, { projectId: 'p0', classificationAcknowledged: true });

    const entry = store.readKnowledge('p0', 'memory:derived-title');
    assert.equal(entry.title, '现象', `标题必须取自候选首行，实际「${entry.title}」`);
    assert.equal(entry.body, '正文内容。', '正文不被派生逻辑触碰');
  } finally { store.close(); }
});

test('调用方给出的标题不被派生覆盖', () => {
  const store = new Store(':memory:');
  try {
    const submitted = store.submit('agent', {
      idempotencyKey: 'derived-title-2',
      projectId: 'p0',
      discovery: '候选首行',
    });
    store.approveProposal(submitted.id, {
      id: 'memory:explicit-title',
      kind: 'memory',
      title: '人写的标题',
      body: '正文。',
      scope: { kind: 'project', projectId: 'p0' },
      baseRevision: 0,
    }, { projectId: 'p0', classificationAcknowledged: true });
    assert.equal(store.readKnowledge('p0', 'memory:explicit-title').title, '人写的标题',
      '派生只填空缺，绝不改写人给的值');
  } finally { store.close(); }
});
