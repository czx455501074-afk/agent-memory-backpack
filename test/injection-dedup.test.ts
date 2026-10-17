/**
 * Same-revision injection dedup on the *prepare* path (R5 W6-1).
 *
 * `store.prepare` has been able to return a pointer instead of the whole normative text
 * since the decision list was fixed, but no caller could ask for it: `contextSchema`
 * rejected the `knowledgeRevision` field, so `/v1/prepare` never forwarded it. Every user
 * turn therefore re-injected the normative prose — 594 characters on this machine, linear
 * in the number of norms — which is the cost the plan's §10 measured on both hosts.
 *
 * These cases drive the real HTTP endpoint rather than `store.prepare` directly, because
 * the gap was in the schema and the forwarding, not in the suppression itself.
 *
 * Two rules must survive any change here:
 *   - A *changed* revision is still injected in full. Only an identical revision degrades
 *     to the pointer; "inject only when the version changed" would be the opposite and is
 *     explicitly forbidden.
 *   - The optimisation never weakens a decision. The decision list still travels complete.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { createCoreServer } from '../src/server.js';
import type { KnowledgeDraft } from '../src/schema.js';

const token = 'b'.repeat(64);
const PROJECT = 'p0';
const scope = { kind: 'project', projectId: PROJECT } as const;

/** Four norms whose prose is long enough that the two states cannot be confused. */
function seedNorms(store: Store, count = 4) {
  store.import(Array.from({ length: count }, (_, index) => ({
    id: `dedup-norm-${index}`, kind: 'norm' as const, title: `去重测试规范 ${index}`,
    scope, baseRevision: 0,
    body: `规范 ${index} 的正文：这条规范用来校验同版本不重复注入，正文需要足够长，字符数差异才可观测。`,
    deniedTools: [],
  })));
}

async function fixture() {
  const store = new Store(':memory:');
  const server = createCoreServer(store, {
    protocolVersion: 1, port: 47631,
    clients: [{ id: 'dsh', token, projectId: PROJECT, role: 'adapter' }],
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const post = async (body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${address.port}/v1/prepare`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-amb-protocol': '1' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, data: (text ? JSON.parse(text) : undefined) as Record<string, unknown> };
  };
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  };
  return { store, post, close };
}

test('同版本 prepare 只回指针，版本变化后必须重新注入全文', async () => {
  const f = await fixture();
  try {
    seedNorms(f.store);
    const base = { projectId: PROJECT, adapter: 'dsh', sessionId: 'dedup-session', query: '去重' };

    // (a) First turn: the caller holds no version, so the whole context must travel.
    const first = await f.post(base);
    assert.equal(first.status, 200);
    const revision = first.data.knowledgeRevision as number;
    assert.equal(first.data.contextUnchanged, false, '首次 prepare 不得报告"内容未变"');
    const full = String(first.data.context);
    assert.ok(full.length > 200, `首次 prepare 必须返回完整 context，实际 ${full.length} 字符`);
    assert.match(full, /规范 0 的正文/, '首次 prepare 必须带上规范正文');

    // (b) Second turn at the same revision: the pointer, and nothing else.
    const second = await f.post({ ...base, knowledgeRevision: revision });
    assert.equal(second.status, 200);
    assert.equal(second.data.contextUnchanged, true, '同版本必须报告"内容未变"');
    const pointer = String(second.data.context);
    assert.ok(pointer.length * 5 < full.length,
      `同版本 context 必须显著更小：${pointer.length} 对比 ${full.length} 字符`);
    assert.doesNotMatch(pointer, /规范 0 的正文/, '同版本不得重复发送规范正文');
    // The optimisation covers the prose only: the decision list stays complete.
    assert.equal((second.data.norms as unknown[]).length, 4, '规范清单仍必须完整返回');

    // (c) A new entry moves the revision. A caller still reporting the old version must
    // get the full text again — a change is never suppressed.
    f.store.import([{
      id: 'dedup-norm-new', kind: 'norm' as const, title: '版本变化后的新规范',
      scope, baseRevision: 0, body: '版本变化后必须重新注入的规范正文。', deniedTools: [],
    } as KnowledgeDraft]);
    const moved = f.store.revision;
    assert.ok(moved > revision, `写入新知识必须推进版本，实际 ${revision} → ${moved}`);

    const third = await f.post({ ...base, knowledgeRevision: revision });
    const grown = String(third.data.context);
    assert.equal(third.data.contextUnchanged, false, '版本变化后不得回退为指针');
    assert.ok(grown.length > full.length, `版本变化后的 context 必须完整，实际 ${grown.length} 字符`);
    assert.match(grown, /版本变化后必须重新注入/, '新规范正文必须出现');

    // And the new revision dedups again, so the saving repeats for the rest of the session.
    const fourth = await f.post({ ...base, knowledgeRevision: third.data.knowledgeRevision as number });
    assert.equal(fourth.data.contextUnchanged, true);

    console.log(`[W6-1] 首轮 ${full.length} 字符 → 同版本 ${pointer.length} 字符（节省 ${full.length - pointer.length}）`
      + ` → 变版后 ${grown.length} 字符 → 新版本同版 ${String(fourth.data.context).length} 字符`);
  } finally { await f.close(); }
});

test('新增的可选版本字段不得放宽 /v1/prepare 的其它校验', async () => {
  const f = await fixture();
  try {
    seedNorms(f.store, 1);
    const unknown = await f.post({ projectId: PROJECT, query: '', injected: 'x' });
    assert.equal(unknown.status, 400, '未知字段仍必须被拒（.strict() 不得放宽）');
    const negative = await f.post({ projectId: PROJECT, query: '', knowledgeRevision: -1 });
    assert.equal(negative.status, 400, '负数版本仍必须被拒');
    const fractional = await f.post({ projectId: PROJECT, query: '', knowledgeRevision: 1.5 });
    assert.equal(fractional.status, 400, '非整数版本仍必须被拒');
    // A valid version on a first call is not the same as a matching one: it must not be
    // treated as "already delivered" unless it actually equals the library revision.
    const ahead = await f.post({ projectId: PROJECT, query: '', knowledgeRevision: f.store.revision + 1 });
    assert.equal(ahead.status, 200);
    assert.equal(ahead.data.contextUnchanged, false, '版本不相等时必须是全文');
  } finally { await f.close(); }
});
