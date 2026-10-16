import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { analyzeWithModel, modelReviewConfigSchema } from '../src/model-review.js';

test('missing model is explicitly awaiting_model; heuristic does not claim a model ran', async () => {
  const result = await analyzeWithModel('所有项目优先检查连接状态', []);
  assert.equal(result.mode, 'heuristic_only'); assert.equal(result.status, 'awaiting_model');
  assert.equal(result.reason, 'not_configured'); assert.equal(result.authority, 'advisory');
});
test('real HTTP model integration validates advisory JSON and redacts supplied secrets', async t => {
  let request = '';
  const server = createServer(async (req, res) => {
    for await (const chunk of req) request += chunk;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: 'memory', scope: 'global', relation: 'supplement', confidence: 0.8, needsSplit: false, summary: '连接排查经验', reasoning: '与既有检查步骤互补', conflictingEntryId: 'existing' }) } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address() as { port: number };
  const result = await analyzeWithModel('所有项目token=supersecret 应检查连通性', [{ id: 'existing', title: '连接', body: '检查端口', kind: 'memory' }], { endpoint: `http://127.0.0.1:${address.port}/v1`, model: 'fixture-model', apiKey: 'fixture-key' });
  assert.equal(result.mode, 'model'); assert.equal(result.status, 'analyzed');
  assert.equal(result.analysis.conflictingEntryId, 'existing'); assert.equal(result.authority, 'advisory');
  assert.ok(!request.includes('supersecret')); assert.ok(!request.includes('fixture-key'));
});
test('invalid authority-bearing model response never becomes an approval', async t => {
  const server = createServer((_req, res) => res.end(JSON.stringify({ choices: [{ message: { content: '{"approved":true}' } }] })));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address() as { port: number };
  const result = await analyzeWithModel('有价值的排查经验', [], { endpoint: `http://127.0.0.1:${address.port}/v1`, model: 'fixture' });
  assert.equal(result.mode, 'heuristic_only'); assert.equal(result.reason, 'invalid_response');
});
test('model endpoint refuses unsafe HTTP and embedded credentials', () => {
  assert.equal(modelReviewConfigSchema.safeParse({ endpoint: 'http://example.com/v1', model: 'x' }).success, false);
  assert.equal(modelReviewConfigSchema.safeParse({ endpoint: 'https://key@example.com/v1', model: 'x' }).success, false);
});
