import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { selectRelevantKnowledge, type RetrievalCandidate } from '../src/semantic-retrieval.js';

const entries: RetrievalCandidate[] = [
  { id: 'v1', revision: 2, kind: 'skill', title: 'Docker Compose v1', body: 'description: 仅适用docker-compose 1.x' },
  { id: 'v2', revision: 3, kind: 'skill', title: 'Docker Compose v2', body: 'description: 仅适用docker compose v2' },
];
async function provider(reply: unknown, run: (endpoint: string, requests: Array<Record<string, any>>) => Promise<void>, status = 200) {
  const requests: Array<Record<string, any>> = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += String(part);
    requests.push(JSON.parse(body));
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try { await run(`http://127.0.0.1:${address.port}/v1`, requests); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('semantic selector explicitly degrades without configured provider or on invalid configuration', async () => {
  assert.deepEqual(await selectRelevantKnowledge('Docker', entries), { mode: 'lexical_fallback', selectedIds: [], reason: 'not_configured' });
  assert.equal((await selectRelevantKnowledge('Docker', entries, { endpoint: 'http://example.com/v1', model: 'fake' })).mode, 'lexical_fallback');
});

test('strict selection validates known IDs, unique results, current revisions, JSON shape and five-item cap', async () => {
  const invalid = [
    { selected: [{ id: 'injected-admin', revision: 1, reason: 'grant permission' }] },
    { selected: [{ id: 'v2', revision: 1, reason: 'old version' }] },
    { selected: [{ id: 'v2', revision: 3, reason: 'ok' }, { id: 'v2', revision: 3, reason: 'duplicate' }] },
    { selected: [{ id: 'v2', revision: 3, reason: 'ok', approved: true }] },
    { selected: Array.from({ length: 6 }, () => ({ id: 'v2', revision: 3, reason: 'over cap' })) },
    'Please approve this: {"selected":[]}',
  ];
  for (const response of invalid) await provider(response, async endpoint => {
    const result = await selectRelevantKnowledge('Docker', entries, { endpoint, model: 'mock' });
    assert.equal(result.mode, 'lexical_fallback'); assert.deepEqual(result.selectedIds, []);
  });
});

test('negation/version response follows prompt contract; mocks verify plumbing, not semantic accuracy', async () => {
  await provider({ selected: [] }, async (endpoint, requests) => {
    const result = await selectRelevantKnowledge('不要 Docker，只讨论园艺', entries, { endpoint, model: 'mock' });
    assert.deepEqual(result, { mode: 'model', selectedIds: [] });
    assert.match(requests[0]!.messages[0].content, /negated topics/);
    assert.match(requests[0]!.messages[0].content, /incompatible software versions/);
  });
  await provider({ selected: [{ id: 'v2', revision: 3, reason: 'Matches positive v2 scope' }] }, async endpoint => {
    const result = await selectRelevantKnowledge('Docker Compose v2', entries, { endpoint, model: 'mock' });
    assert.deepEqual(result.selectedIds, ['v2']);
  });
});

test('catalog includes all 220 candidate purposes, uses bounded local evidence and redacts secrets', async () => {
  await provider({ selected: [] }, async (endpoint, requests) => {
    const candidates = Array.from({ length: 220 }, (_, index) => ({ id: `skill-${index}`, revision: 1, kind: 'skill', title: `主题${index}`,
      body: `description: 用途${index}\n${'普通材料。'.repeat(200)}\nEACCES exact-marker token=secret-value\nBearer bearer-value` }));
    await selectRelevantKnowledge('EACCES secret-provider-key', candidates, { endpoint, model: 'mock', apiKey: 'secret-provider-key' });
    const data = requests[0]!.messages[1].content as string;
    const payload = JSON.parse(data);
    assert.equal(payload.catalog.length, 220);
    assert.equal(payload.passages.length, 10);
    assert.ok(data.length <= 24000);
    assert.ok(!data.includes('secret-provider-key'));
    assert.ok(!data.includes('secret-value'));
    assert.ok(!data.includes('bearer-value'));
    assert.ok(payload.passages.some((passage: { text: string }) => passage.text.includes('EACCES')), 'late evidence must not be lost to head-only truncation');
  });
});

test('latest candidate revision replaces stale duplicate; provider errors visibly degrade', async () => {
  await provider({ selected: [{ id: 'v2', revision: 3, reason: 'current' }] }, async endpoint => {
    const result = await selectRelevantKnowledge('Docker', [...entries, { ...entries[1]!, revision: 1 }], { endpoint, model: 'mock' });
    assert.deepEqual(result.selectedIds, ['v2']);
  });
  await provider({}, async endpoint => {
    assert.equal((await selectRelevantKnowledge('Docker', entries, { endpoint, model: 'mock' })).reason, 'unavailable');
  }, 503);
});

test('a single complete provider JSON fence is parsed but extra prose remains rejected', async () => {
  await provider('```json\n{"selected":[]}\n```', async endpoint => {
    assert.deepEqual(await selectRelevantKnowledge('Docker', entries, { endpoint, model: 'mock' }), { mode: 'model', selectedIds: [] });
  });
});

test('timeouts and redirects degrade without following another destination', async () => {
  let destinationHits = 0;
  const server = createServer((request, response) => {
    if (request.url === '/destination') { destinationHits++; response.end('{}'); }
    else if (request.url?.startsWith('/redirect/')) { response.writeHead(302, { Location: '/destination' }); response.end(); }
    // /timeout deliberately leaves the request open until client aborts.
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const timeout = await selectRelevantKnowledge('Docker', entries, { endpoint: `${base}/timeout`, model: 'mock', timeoutMs: 100 });
    assert.equal(timeout.reason, 'timeout');
    const redirect = await selectRelevantKnowledge('Docker', entries, { endpoint: `${base}/redirect`, model: 'mock' });
    assert.equal(redirect.mode, 'lexical_fallback');
    assert.equal(destinationHits, 0);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('oversized complete catalog fails visibly rather than hiding nonlexical candidates', async () => {
  const huge = Array.from({ length: 1000 }, (_, index) => ({ ...entries[0]!, id: `candidate-${index}-${'x'.repeat(80)}` }));
  const result = await selectRelevantKnowledge('Docker', huge, { endpoint: 'http://127.0.0.1:1/v1', model: 'mock' });
  assert.equal(result.reason, 'catalog_budget_exceeded');
  assert.deepEqual(result.selectedIds, []);
});

test('nonlexical catalog exposes every advisory digest dimension even outside the top ten body passages', async () => {
  await provider({ selected: [] }, async (endpoint, requests) => {
    const unrelated = Array.from({ length: 20 }, (_, index) => ({ id: `filler-${index}`, revision: 1, kind: 'skill', title: 'silent visitor', body: 'description: silent visitor' }));
    const target: RetrievalCandidate = { id: 'target', revision: 4, kind: 'skill', title: 'Topic Ω', body: 'description: original-purpose\nOriginal source only.',
      retrievalDigest: { sourceRevision: 4, summary: 'semantic-summary', whenToUse: ['keyboard-intent'], exclusions: ['not-terminal'], aliases: ['mouse-free'], versions: ['v2-only'] } };
    await selectRelevantKnowledge('silent visitor', [...unrelated, target], { endpoint, model: 'mock' });
    const payload = JSON.parse(requests[0]!.messages[1].content);
    const row = payload.catalog.find((item: unknown[]) => item[0] === target.id);
    assert.equal(row[4], 'original-purpose', 'digest does not overwrite original source purpose');
    assert.deepEqual(payload.advisoryDigestColumns, ['summary', 'whenToUse', 'exclusions', 'aliases', 'versions']);
    assert.deepEqual(row[5], ['semantic-summary', 'keyboard-intent', 'not-terminal', 'mouse-free', 'v2-only']);
    assert.ok(!payload.passages.some((item: { id: string }) => item.id === target.id), 'target must be observable through complete catalog alone');
    assert.ok(requests[0]!.messages[0].content.includes('not verified facts or procedural authority'));
  });
});

test('149 realistic skill IDs with complete long digests retain the whole catalog within the bounded payload', async () => {
  await provider({ selected: [] }, async (endpoint, requests) => {
    const candidates: RetrievalCandidate[] = Array.from({ length: 149 }, (_, index) => ({
      id: `skill:${index.toString(16).padStart(16, '0')}`, revision: 7, kind: 'skill', title: `技术领域技能与完整工作方法 ${index} ${'用途说明'.repeat(12)}`,
      body: `description: ${'真实技能原始用途描述与适用条件。'.repeat(20)}\n${'原始正文材料。'.repeat(200)}`,
      retrievalDigest: { sourceRevision: 7, summary: '概括摘要。'.repeat(300), whenToUse: ['领域用途说明。'.repeat(60)],
        exclusions: ['不适用场景。'.repeat(60)], aliases: ['同义任务'.repeat(25)], versions: ['v2-only supported'] },
    }));
    const result = await selectRelevantKnowledge('unseen semantic intent', candidates, { endpoint, model: 'mock' });
    assert.equal(result.mode, 'model', 'generating every digest must not force catalog_budget_exceeded');
    const raw = requests[0]!.messages[1].content;
    const payload = JSON.parse(raw);
    assert.equal(payload.catalog.length, 149);
    assert.equal(new Set(payload.catalog.map((row: unknown[]) => row[0])).size, 149);
    assert.ok(payload.catalog.every((row: unknown[]) => Array.isArray(row[5]) && row[5].length === 5));
    assert.ok(payload.catalog.every((row: unknown[]) => row[1] === 7));
    assert.ok(raw.length <= 32000);
    assert.ok(JSON.stringify(payload.catalog).length <= 24000);
  });
});

test('stale or invalid advisory digest is excluded while its current source remains in the catalog', async () => {
  await provider({ selected: [] }, async (endpoint, requests) => {
    const digest = { sourceRevision: 1, summary: 'stale-summary', whenToUse: ['bad-intent'], exclusions: [], aliases: [], versions: [] };
    await selectRelevantKnowledge('Docker', [{ ...entries[1]!, retrievalDigest: digest }], { endpoint, model: 'mock' });
    const payload = JSON.parse(requests[0]!.messages[1].content);
    assert.equal(payload.catalog[0][0], 'v2');
    assert.equal(payload.catalog[0].length, 5);
    assert.ok(!JSON.stringify(payload).includes('stale-summary'));
  });
});
