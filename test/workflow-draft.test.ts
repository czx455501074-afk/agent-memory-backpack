import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { skillSchema } from '../src/schema.js';
import { generateWorkflowDraft, isWorkflowDraftCurrent, validateWorkflowDraft, workflowSourceHash, type WorkflowDraftSource } from '../src/workflow-draft.js';

function fixture() {
  const source: WorkflowDraftSource = { skillId: 'skill:connection', skillRevision: 2, skill: skillSchema.parse({
    id: 'skill:connection', kind: 'skill', title: '连接排查', scope: { kind: 'project', projectId: 'p' },
    body: '连接排查\n恢复本机连接\n连接失败时\n已知本机端口\n检查监听\n查看端口监听状态\n确认监听存在\n连接恢复\n无监听则保留失败状态',
    leaves: [{ path: 'refs/port.md', hash: 'source-hash', body: '端口检查的补充说明。' }],
  }) };
  const workflow = { id: 'workflow:connection', kind: 'workflow', title: '连接排查', scope: source.skill.scope,
    provenance: 'agent', evidence: 'self-reported', overview: '恢复本机连接', triggers: ['连接失败时'], categories: [['运维']],
    preconditions: ['已知本机端口'], stages: [{ id: 'inspect', title: '检查监听', instructions: '查看端口监听状态', checks: ['确认监听存在'], dependencies: [] }],
    completion: ['连接恢复'], recovery: '无监听则保留失败状态' };
  const fields = { title: workflow.title, overview: workflow.overview, 'triggers.0': workflow.triggers[0], 'preconditions.0': workflow.preconditions[0],
    'stages.0.title': workflow.stages[0]!.title, 'stages.0.instructions': workflow.stages[0]!.instructions,
    'stages.0.checks.0': workflow.stages[0]!.checks[0], 'completion.0': workflow.completion[0], recovery: workflow.recovery };
  const raw = { workflow, grounding: Object.entries(fields).map(([field, quote]) => ({ field, sourcePath: 'SKILL.md', quote })), missing: [] as string[],
    digest: {summary:'连接故障排查',whenToUse:['本机连接失败'],exclusions:[],aliases:['连接修复'],versions:[]} };
  return { source, raw };
}

test('grounded draft is reviewable, never executable, with source version and intact reference snapshot', () => {
  const { source, raw } = fixture();
  const result = validateWorkflowDraft(source, raw);
  assert.equal(result.status, 'ready_for_review'); assert.equal(result.executable, false); assert.equal(result.authority, 'advisory');
  assert.deepEqual(result.source, { skillId: source.skillId, revision: 2, hash: workflowSourceHash(source) });
  assert.equal(result.references[0]!.body, source.skill.leaves[0]!.body);
  assert.notEqual(result.references[0]!.hash, 'source-hash');
  assert.equal(source.skill.needsStructure, true);
});

test('invented checks, stale claims, authority and scope expansion cannot yield a ready draft', () => {
  const { source, raw } = fixture();
  raw.workflow.stages[0]!.checks = ['所有测试均通过'];
  assert.equal(validateWorkflowDraft(source, raw).status, 'needs_evidence');
  const altered = fixture();
  assert.equal(validateWorkflowDraft(source, { ...altered.raw, workflow: { ...altered.raw.workflow, scope: { kind: 'global' } } }).status, 'needs_evidence');
  assert.equal(validateWorkflowDraft(source, { ...altered.raw, workflow: { ...altered.raw.workflow, evidence: 'observed' } }).status, 'needs_evidence');
  assert.equal(validateWorkflowDraft(source, { ...altered.raw, approved: true }).reason, 'invalid_response');
});

test('schema-incomplete structure and missing source information remain non-executable', () => {
  const { source, raw } = fixture();
  assert.equal(validateWorkflowDraft(source, { ...raw, workflow: { ...raw.workflow, stages: [] } }).reason, 'invalid_response');
  const result = validateWorkflowDraft(source, { workflow: null, grounding: [], missing: ['没有完成判据'] });
  assert.equal(result.status, 'needs_evidence'); assert.deepEqual(result.missing, ['没有完成判据']); assert.equal(result.workflow, null);
});

test('reference and main-body changes change draft source hash; duplicate reference names are rejected', () => {
  const { source, raw } = fixture();
  const original = workflowSourceHash(source);
  const saved = validateWorkflowDraft(source, raw);
  assert.equal(isWorkflowDraftCurrent(saved, source), true);
  source.skill.leaves[0]!.body += '新版本'; assert.notEqual(workflowSourceHash(source), original);
  assert.equal(isWorkflowDraftCurrent(saved, source), false);
  source.skill.leaves.push({ ...source.skill.leaves[0]! });
  assert.equal(validateWorkflowDraft(source, raw).status, 'needs_evidence');
});

test('no provider and refused endpoints explicitly await model', async () => {
  const { source } = fixture();
  assert.equal((await generateWorkflowDraft(source)).reason, 'not_configured');
  assert.equal((await generateWorkflowDraft(source, { endpoint: 'http://example.com/v1', model: 'x' })).status, 'awaiting_model');
});

test('HTTP generation validates grounded output, redacts credentials, and preserves references locally', async t => {
  const { source, raw } = fixture();
  source.skill.body += '\napi_key=hidden-secret';
  let request = '';
  const server = createServer(async (req, res) => {
    for await (const chunk of req) request += chunk;
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(raw) } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address() as { port: number };
  const result = await generateWorkflowDraft(source, { endpoint: `http://127.0.0.1:${address.port}/v1`, model: 'fixture', apiKey: 'hidden-provider-key' });
  assert.equal(result.status, 'ready_for_review'); assert.equal(result.model, 'fixture');
  assert.ok(!request.includes('hidden-secret')); assert.ok(!request.includes('hidden-provider-key'));
  assert.equal(result.references[0]!.path, 'refs/port.md');
});

test('truncated source coverage prevents ready status even with otherwise grounded model output', async t => {
  const { source, raw } = fixture();
  source.skill.leaves[0]!.body = 'x'.repeat(60000);
  const server = createServer((_req, res) => res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(raw) } }] })));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address() as { port: number };
  const result = await generateWorkflowDraft(source, { endpoint: `http://127.0.0.1:${address.port}/v1`, model: 'fixture' });
  assert.equal(result.status, 'needs_evidence'); assert.ok(result.missing.some(text => text.includes('budget')));
});

test('invalid model JSON is a visible invalid draft, never a ready result', async t => {
  const { source } = fixture();
  const server = createServer((_req, res) => res.end(JSON.stringify({ choices: [{ message: { content: 'not json' } }] })));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address() as { port: number };
  const result = await generateWorkflowDraft(source, { endpoint: `http://127.0.0.1:${address.port}/v1`, model: 'fixture' });
  assert.equal(result.status, 'awaiting_model'); assert.equal(result.reason, 'invalid_response'); assert.equal(result.workflow, null);
});

test('generator requires digest even for null workflow, preserves incomplete model drafts, and manual legacy drafts remain valid',async t=>{
  const {source,raw}=fixture();
  const {digest,...legacy}=raw;
  assert.equal(validateWorkflowDraft(source,legacy).status,'ready_for_review','manual old-format workflow stays compatible');
  let content:unknown=legacy;
  const server=createServer((_req,res)=>res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(content)}}]})));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const address=server.address() as {port:number};
  const config={endpoint:`http://127.0.0.1:${address.port}/v1`,model:'fixture'};
  const missing=await generateWorkflowDraft(source,config);
  assert.equal(missing.status,'awaiting_model');assert.equal(missing.reason,'invalid_response');
  assert.equal(missing.workflow?.id,raw.workflow.id,'valid procedural draft must not be discarded');
  content={workflow:null,grounding:[],missing:['Missing completion criteria']};
  assert.equal((await generateWorkflowDraft(source,config)).status,'awaiting_model');
  content={workflow:null,grounding:[],missing:['Missing completion criteria'],digest};
  const complete=await generateWorkflowDraft(source,config);
  assert.equal(complete.status,'needs_evidence');assert.deepEqual(complete.digest,digest);
});
