import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { Store } from '../src/store.js';

/**
 * Credential-shaped text is sanitised **on the way in**, not only refused on the way out.
 *
 * The difference is not cosmetic. An export guard fires when somebody exports; by then the
 * value is in the database, in every revision kept for history, and in the full-text index —
 * and a library that never gets exported keeps it forever. Two peer projects sanitise on
 * ingest, and this is the gap that comparison surfaced.
 *
 * The tests below pin three things that are easy to get wrong while making this work:
 *   - a real-shaped value is replaced, and the receipt says so without echoing it;
 *   - a *placeholder* is left exactly as written (otherwise every document that teaches an
 *     API format gets mangled, and the guard becomes something people work around);
 *   - the idempotency fingerprint still comes from the submitted text, so a retry stays a
 *     retry instead of becoming a 409.
 */

const roots: string[] = [];
const stores: Store[] = [];
function open() {
  const directory = mkdtempSync(join(tmpdir(), 'backpack-redact-write-'));
  roots.push(directory);
  const store = new Store(join(directory, 'knowledge.sqlite'), () => 1000);
  stores.push(store);
  return store;
}
after(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of roots.splice(0)) {
    const rel = relative(resolve(tmpdir()), resolve(path));
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Windows keeps the handle open; leftover temp is not the verdict.
    }
  }
});

/** A value with the shape of a live key. Not a real credential: a fixture, like the ones the
 * export guard's own tests use. */
const LIVE_SHAPED = 'sk-ant-api03-Q7wE8rT9yU0iO1pA2sD3fG4hJ5kL6zX';
const TEACHING = '写法是 `api_key=<key>`，或者 `Bearer sk-xxx` 这种占位形态';

function storedProposal(store: Store, id: string) {
  const row = store.db.prepare('SELECT payload FROM proposals WHERE id=?').get(id) as { payload: string } | undefined;
  assert.ok(row, `候选 ${id} 应当已落库`);
  return JSON.parse(row.payload) as { discovery: string; evidence?: string };
}
function currentBody(store: Store, id: string) {
  const row = store.db.prepare(`SELECT r.content FROM knowledge k JOIN revisions r ON r.id=k.id AND r.revision=k.head WHERE k.id=?`).get(id) as { content: string } | undefined;
  assert.ok(row, `条目 ${id} 应当已落库`);
  return JSON.parse(row.content) as { body?: string; title?: string };
}

test('a candidate carrying a live-shaped key is stored redacted, and the receipt names where', () => {
  const store = open();
  const receipt = store.submit('principal', {
    idempotencyKey: 'redact-1', projectId: 'p0-workflow',
    discovery: `排查时发现请求头里带了 ${LIVE_SHAPED}，换掉后正常。`,
    evidence: `证据：配置里写了 api_key=${LIVE_SHAPED}`,
  });
  const stored = storedProposal(store, receipt.id);
  assert.ok(stored.discovery.includes('REDACTED-CREDENTIAL'), '落库正文必须已替换');
  assert.ok(!stored.discovery.includes(LIVE_SHAPED), '落库正文不得残留原值');
  assert.ok(!String(stored.evidence).includes(LIVE_SHAPED), '证据字段同样要替换');
  assert.ok((receipt.redacted?.length ?? 0) > 0, '回执必须说明文本被改过（空数组会让这条断言变成空检查）');
  for (const item of receipt.redacted!) {
    assert.ok(item.where && item.rule, '每条替换记录都要带位置与规则');
    assert.ok(!item.where.includes('sk-ant'), '记录里不能出现值本身');
  }
  assert.ok(!JSON.stringify(receipt).includes(LIVE_SHAPED), '回执整体不得回显原值');
});

test('a document that teaches the format is stored exactly as written', () => {
  // The counter-direction. A guard that redacts every mention of a key format mangles the very
  // entries a later reader needs, and the usual response to that is to stop using the guard.
  const store = open();
  const receipt = store.submit('principal', { idempotencyKey: 'teach-1', projectId: 'p0-workflow', discovery: TEACHING });
  const stored = storedProposal(store, receipt.id);
  assert.equal(stored.discovery, TEACHING, '占位与教学写法必须逐字保留');
  assert.equal(receipt.redacted, undefined, '没有替换时不得出现该字段（否则无法区分"没替换"与"忘了填"）');
});

test('a retry of the same submission is still a retry, not a conflict', () => {
  // Redaction happens after the fingerprint is taken, on purpose. If the stored (redacted) text
  // were what the fingerprint came from, a retry would hash differently from the first attempt
  // and the caller would get a 409 for a request that was merely repeated.
  const store = open();
  const payload = { idempotencyKey: 'retry-1', projectId: 'p0-workflow', discovery: `含 ${LIVE_SHAPED} 的原文` };
  const first = store.submit('principal', payload);
  const again = store.submit('principal', payload);
  assert.equal(again.duplicate, true);
  assert.equal(again.id, first.id, '重试必须命中同一条候选');
  assert.deepEqual(again, { id: first.id, state: 'pending', duplicate: true });
});

test('importing an entry redacts it, and reports what was replaced', () => {
  const store = open();
  const report = store.importWithReport([{
    id: 'memory:secret', baseRevision: 0, kind: 'memory', title: '配置记录',
    body: `连接串里带了 password=${LIVE_SHAPED}，不要照抄。`, scope: { kind: 'global' },
  }]);
  const body = currentBody(store, 'memory:secret').body ?? '';
  assert.ok(body.includes('REDACTED-CREDENTIAL'), '导入的知识正文必须已替换');
  assert.ok(!body.includes(LIVE_SHAPED), '导入的知识正文不得残留原值');
  assert.ok((report.redacted?.length ?? 0) > 0, '导入回执要报告替换处数');
});

test('importing a clean entry changes nothing at all', () => {
  const store = open();
  const clean = '一段普通正文，没有任何凭据形状的内容。';
  const report = store.importWithReport([{
    id: 'memory:clean', baseRevision: 0, kind: 'memory', title: '普通记录', body: clean, scope: { kind: 'global' },
  }]);
  assert.equal(currentBody(store, 'memory:clean').body, clean, '未命中的条目必须逐字节不变');
  assert.equal(report.redacted, undefined);
});
