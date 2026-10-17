// The recall block has to say HOW to read what it injects.
//
// The core attaches outcome (success/failure/unverified) to journals, stated vs inferred to
// preferences, and an expiry to material - and the point of attaching them is that a reader
// not be misled. The recall path used to render none of them, so after injection a failed
// attempt and a successful one looked identical. Treating a failed attempt as reusable
// experience is the error this whole system exists to prevent, so the rendering is asserted
// here rather than left to the next reader of the template.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recallKnowledge } from '../adapters/dsh/recall.mjs';

function recording() {
  const logs = [];
  return { logs, info: (e, d) => logs.push({ e, ...d }), warn: (e, d) => logs.push({ e, ...d }), error: (e, d) => logs.push({ e, ...d }) };
}

/** The budget fixture's shape, extended with the diagnostic fields the core sends. */
function fixtureClient(entries) {
  const post = async (route, payload) => {
    if (route.endsWith('search-universal')) {
      return {
        results: entries.map(entry => ({ id: entry.id, revision: 1 })),
        knowledgeRevision: 7,
        selection: { mode: 'index', reason: 'fixture' },
      };
    }
    const found = entries.find(entry => entry.id === payload.knowledgeId);
    if (!found) throw new Error('unknown knowledge id');
    return { id: found.id, title: found.title, revision: 1, body: found.body, ...(found.extra ?? {}) };
  };
  return { client: { post } };
}

async function inject(entries) {
  const { context } = await recallKnowledge({
    client: fixtureClient(entries).client, config: { projectId: 'p' }, logger: recording(),
    adapter: 'dsh', sessionId: 's', query: 'fixture',
  });
  return context;
}

test('注入块标明结果状态：失败的尝试不会被读成成功经验', async () => {
  const context = await inject([
    { id: 'journal-1', title: '一次失败尝试', body: '尝试 A 方法未能完成。'.repeat(20), extra: { outcome: 'failure' } },
    { id: 'journal-2', title: '一次成功尝试', body: 'B 方法可行并已复现。'.repeat(20), extra: { outcome: 'success' } },
  ]);
  assert.match(context, /结果=失败/, '失败日记必须带结果状态——否则它与成功的日记在注入后无法区分');
  assert.match(context, /结果=成功/);
  // Both titles really are present, so the assertions above are about the marker and not
  // about one of the two blocks happening to be dropped.
  assert.match(context, /一次失败尝试/);
  assert.match(context, /一次成功尝试/);
});

test('注入块区分"由人明说"与"插件推断"', async () => {
  const context = await inject([
    { id: 'pref-1', title: '工作习惯', body: '偏好简短回复。'.repeat(20), extra: { stated: false } },
    { id: 'pref-2', title: '明确要求', body: '要求中文作答。'.repeat(20), extra: { stated: true } },
  ]);
  assert.match(context, /工作习惯/);
  assert.match(context, /明确要求/);
  assert.match(context, /插件推断/, '推断出来的偏好不能被读成对方明说的');
  assert.match(context, /由人明说/);
});

test('材料带上失效时间', async () => {
  const expiresAt = Date.now() + 3 * 86400000;
  const context = await inject([
    {
      id: 'material-1', title: '外部资料', body: '一份外部文档的摘录。'.repeat(20),
      extra: { url: 'https://example.invalid/x', savedAt: Date.now(), expiresAt },
    },
  ]);
  // Assert the premise first. The first version of this test put the material third, the
  // budget only carried two entries, and the marker assertion was checking an empty space -
  // it failed for a reason that had nothing to do with what it meant to test.
  assert.match(context, /外部资料/, '先确认这一条真的被注入了，否则下面的断言是在测空气');
  assert.match(context, /材料 \d+ 天后失效/);
});

test('没有诊断字段的条目不会被凭空加上标记', async () => {
  const context = await inject([{ id: 'mem-1', title: '普通记忆', body: '一段普通正文。'.repeat(30), extra: {} }]);
  assert.doesNotMatch(context, /结果=|由人明说|插件推断|天后失效/, '只有真的带字段时才渲染——标记不能靠猜');
});

test('两份适配器保持逐字节相同（同一行为在两个宿主上）', () => {
  const dsh = readFileSync('adapters/dsh/recall.mjs');
  const codex = readFileSync('adapters/codex/scripts/recall.mjs');
  assert.ok(dsh.equals(codex), '两侧副本一旦分叉，同一段记忆在两个宿主上会被不同地解读');
});
