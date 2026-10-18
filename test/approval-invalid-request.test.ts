import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { Store } from '../src/store.js';
import { createCoreServer } from '../src/server.js';

/**
 * A rejected request must name the field it rejected.
 *
 * Measured defect: the panel's approval form can build an entry for six kinds, and two of them
 * (`material`, `journal`) require fields the form never collected. Approving as one of those
 * returned `400 invalid_request` with the single sentence "Request fields are invalid" — so a
 * reviewer who picked "材料" and left the URL blank had no way to learn that a material needs
 * `url`, `summary` and a fingerprint. Zod had already computed the exact path and reason; the HTTP
 * edge was throwing them away, which is what turned a fixable form into an opaque failure.
 *
 * Two things are pinned here, and the second is what keeps the first honest:
 *   - the refusal names the offending fields (path + reason), never the submitted values;
 *   - a valid approval of the same kind still succeeds, so the check is not simply "always refuse".
 */

const roots: string[] = [];
const stores: Store[] = [];
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

function seeded() {
  const directory = mkdtempSync(join(tmpdir(), 'backpack-approve-'));
  roots.push(directory);
  const store = new Store(join(directory, 'knowledge.sqlite'), () => 1_000_000);
  stores.push(store);
  return store;
}

async function withServer(store: Store, run: (post: (path: string, body: unknown) => Promise<{ status: number; data: Record<string, any> }>) => Promise<void>) {
  const token = 'w'.repeat(64);
  const server = createCoreServer(store, { protocolVersion: 1, port: 47631,
    clients: [{ id: 'admin', token, projectId: 'p0-workflow', role: 'admin' }] });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-amb-protocol': '1' },
      body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() as Record<string, any> };
  };
  try { await run(post); }
  finally { server.closeAllConnections(); server.close(); }
}

/** Submit one candidate and return its id, so the approval has something real to act on. */
async function seedCandidate(post: (path: string, body: unknown) => Promise<{ status: number; data: Record<string, any> }>) {
  const created = await post('/v1/proposals', {
    projectId: 'p0-workflow', idempotencyKey: 'approve-fixture-1',
    discovery: '夹具：一条用于验证采纳错误信息的候选。',
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  return String(created.data.id);
}

test('an approval missing a kind-required field names the fields, not just "invalid"', async () => {
  const store = seeded();
  await withServer(store, async post => {
    const id = await seedCandidate(post);
    // Exactly what the panel produced before the form collected these: a material with a body and
    // nothing else. `url`, `summary` and `fingerprint` are required by the material schema.
    const refused = await post('/v1/proposals/approve', {
      projectId: 'p0-workflow', id,
      entry: { id, kind: 'material', title: '材料', body: '正文', scope: { kind: 'project', projectId: 'p0-workflow' },
        baseRevision: 0, labels: ['approved'], provenance: 'user', evidence: 'verifiable', platforms: [] },
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.data.code, 'invalid_request');
    assert.ok(Array.isArray(refused.data.fields) && refused.data.fields.length > 0,
      '拒绝必须带上字段级原因，否则读者只能看到"字段不合法"这句话');
    const paths = refused.data.fields.map((field: { path: string }) => field.path);
    assert.ok(paths.some((path: string) => path.endsWith('url')), `字段列表里应指出 url：${paths.join('、')}`);
    assert.ok(paths.some((path: string) => path.endsWith('summary')), `字段列表里应指出 summary：${paths.join('、')}`);
    assert.match(String(refused.data.message), /url/, '消息正文也要点名，不能只有一句笼统的话');
    // Never echo submitted values: a refusal travels through logs and screenshots.
    assert.ok(!JSON.stringify(refused.data).includes('夹具：一条用于验证采纳错误信息的候选。'),
      '拒绝回执不得回显提交的内容');
  });
});

test('a journal approval missing `did` is refused by name as well', async () => {
  const store = seeded();
  await withServer(store, async post => {
    const id = await seedCandidate(post);
    const refused = await post('/v1/proposals/approve', {
      projectId: 'p0-workflow', id,
      entry: { id, kind: 'journal', title: '日记', body: '正文', scope: { kind: 'project', projectId: 'p0-workflow' },
        baseRevision: 0, labels: ['approved'], provenance: 'user', evidence: 'verifiable', platforms: [] },
    });
    assert.equal(refused.status, 400);
    const paths = refused.data.fields.map((field: { path: string }) => field.path);
    assert.ok(paths.some((path: string) => path.endsWith('did')), `字段列表里应指出 did：${paths.join('、')}`);
  });
});

test('the same approval succeeds once the required fields are present', async () => {
  // The counter-direction: if this also failed, "names the field" would be true of a form that
  // simply never works, and the first two tests would be measuring nothing.
  const store = seeded();
  await withServer(store, async post => {
    const id = await seedCandidate(post);
    const accepted = await post('/v1/proposals/approve', {
      projectId: 'p0-workflow', id,
      entry: { id, kind: 'material', title: '材料', body: '正文', scope: { kind: 'project', projectId: 'p0-workflow' },
        baseRevision: 0, labels: ['approved'], provenance: 'user', evidence: 'verifiable', platforms: [],
        url: 'https://example.invalid/source', summary: '摘要', fingerprint: 'ui-abc123' },
    });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
    assert.ok(Number(accepted.data.knowledgeRevision) >= 1);
  });
});
