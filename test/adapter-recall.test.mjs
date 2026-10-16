import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isContinuationQuery, recallKnowledge } from '../adapters/dsh/recall.mjs';

test('automatic recall is identical in both hosts, skips empty queries and bounds actual body reads', async () => {
  assert.equal(readFileSync(new URL('../adapters/dsh/recall.mjs', import.meta.url), 'utf8'),
    readFileSync(new URL('../adapters/codex/scripts/recall.mjs', import.meta.url), 'utf8'));
  const calls = [], logs = [];
  const logger = { info: (event, data) => logs.push({ event, ...data }), warn: (event, data) => logs.push({ event, ...data }) };
  const client = { async post(route, payload) {
    calls.push({ route, payload });
    if (route.endsWith('search-universal')) return { results: Array.from({ length: 4 }, (_, i) => ({ id: `id${i}`, revision: 1 })), knowledgeRevision: 3 };
    return { id: payload.knowledgeId, title: 'Fixture', revision: 1, body: 'private-token\n' + 'x'.repeat(9000),
      leaves: [{ path: 'references/a.md', body: '' }], needsStructure: true };
  } };
  const options = { client, logger, config: { projectId: 'shared', token: 'private-token' }, adapter: 'dsh', sessionId: 's' };
  assert.equal((await recallKnowledge({ ...options, query: ' ' })).context, '');
  assert.equal(calls.length, 0);
  assert.equal((await recallKnowledge({ ...options, query: '继续' })).context, '');
  assert.equal(calls.length, 0);
  assert.equal(isContinuationQuery('继续开发新的检索模块'), false, 'An explicit new task must retain its intent');
  const recalled = await recallKnowledge({ ...options, query: 'x'.repeat(5000) });
  assert.equal(calls.length, 3, 'One search and at most two actual body reads');
  assert.equal(calls[0].payload.query.length, 4000);
  assert(calls.slice(1).every(call => call.payload.includeLeaves === false));
  assert.equal(recalled.ids.length, 2);
  assert(recalled.context.length < 6500);
  assert.match(recalled.context, /正文节选/);
  assert.match(recalled.context, /references\/a.md/);
  assert.match(recalled.context, /尚未结构化/);
  assert.doesNotMatch(recalled.context, /private-token/);
  assert.doesNotMatch(JSON.stringify(logs), /private-token|xxxxx/);
});

test('recall degrades visibly on unavailable or malformed search and retains successful partial reads', async () => {
  const logs = [], logger = { info: event => logs.push(event), warn: event => logs.push(event) };
  const base = { config: { projectId: 'shared' }, logger, adapter: 'codex', sessionId: 's', query: 'fixture' };
  const failed = await recallKnowledge({ ...base, client: { async post() { throw new Error('private transport detail'); } } });
  assert.equal(failed.context, '');
  assert(logs.includes('knowledge.auto_recall_failed'));
  const partial = await recallKnowledge({ ...base, client: { async post(route, payload) {
    if (route.endsWith('search-universal')) return { results: [{ id: 'bad' }, { id: 'good' }] };
    if (payload.knowledgeId === 'bad') throw new Error('gone');
    return { id: 'good', revision: 2, body: 'Read this relevant body.' };
  } } });
  assert.deepEqual(partial.ids, ['good']);
  assert.match(partial.context, /relevant body/);
  assert(logs.includes('knowledge.auto_read_failed'));
});
