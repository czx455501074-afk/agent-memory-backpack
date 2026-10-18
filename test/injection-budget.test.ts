import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

/**
 * A summary must not grow into the thing it summarises.
 *
 * Injection carries a workflow's entry point — overview, preconditions, stage *names* — and
 * the per-stage checks stay one `amb_read_stage` call away. The stage list itself was
 * unbounded though: a thirty-stage workflow put thirty `id:title` pairs into every turn's
 * context. Twelve now travel inline and the rest are named by count.
 */

const PROJECT = 'p0';

const workflow = (id: string, stageCount: number) => ({
  id, kind: 'workflow' as const, title: `流程 ${id}`,
  scope: { kind: 'project' as const, projectId: PROJECT }, baseRevision: 0,
  overview: `用于测试阶段截断的流程 ${id}。`,
  triggers: ['需要验证阶段列表长度'], categories: [['测试']], tags: [],
  preconditions: ['调用方已提供项目上下文'],
  stages: Array.from({ length: stageCount }, (_, index) => ({
    id: `stage-${String(index + 1).padStart(2, '0')}`,
    title: `第 ${index + 1} 步`,
    instructions: '执行并核对。', checks: ['结果可核对'], dependencies: [],
  })),
  completion: ['完成'], recovery: '失败时停止。', isEntryPoint: false,
});

test('阶段很多时只内联前 12 个，其余按数量提示', () => {
  const store = new Store(':memory:');
  try {
    store.import([workflow('long-flow', 30) as never]);
    const prepared = store.prepare(PROJECT, '验证阶段列表长度') as { context: string };

    assert.match(prepared.context, /stage-12:第 12 步/, '前 12 个阶段应内联');
    assert.match(prepared.context, /另有 18 个阶段/, `必须说明还有多少个阶段，实际：${prepared.context.slice(0, 400)}`);
    assert.ok(!prepared.context.includes('stage-13:'), '第 13 个及之后不应内联——它们本来就该用 amb_read_stage 读');
    assert.match(prepared.context, /共 30 个阶段/, '总数仍要如实报出，否则读者会以为只有 12 个');
  } finally { store.close(); }
});

test('阶段不多时完整列出，不出现截断提示', () => {
  const store = new Store(':memory:');
  try {
    store.import([workflow('short-flow', 4) as never]);
    const prepared = store.prepare(PROJECT, '验证阶段列表长度') as { context: string };
    assert.match(prepared.context, /stage-04:第 4 步/);
    assert.ok(!prepared.context.includes('另有'), '未超上限时不应出现截断提示');
  } finally { store.close(); }
});

test('过长的 overview 被截断，并说明是截断', () => {
  const store = new Store(':memory:');
  try {
    const long = { ...workflow('verbose-flow', 2), overview: `开头。${'这是一段很长的概述。'.repeat(60)}结尾。` };
    store.import([long as never]);
    const prepared = store.prepare(PROJECT, '验证阶段列表长度') as { context: string };

    assert.match(prepared.context, /已截断，完整内容请读取该条目/, '必须说明被截断，否则半句话会被读成全部');
    assert.ok(!prepared.context.includes('结尾。'), '超出上限的部分不应内联');
    // The cap is generous enough that an ordinary overview is untouched — this asserts the
    // truncated marker is the only new thing, not that the whole field vanished.
    assert.ok(prepared.context.includes('开头。'), '保留开头，让读者知道这段讲什么');
  } finally { store.close(); }
});

test('普通长度的 overview 与完成条件原样保留', () => {
  const store = new Store(':memory:');
  try {
    store.import([workflow('normal-flow', 3) as never]);
    const prepared = store.prepare(PROJECT, '验证阶段列表长度') as { context: string };
    assert.ok(prepared.context.includes('用于测试阶段截断的流程 normal-flow。'), '正常长度的概述不该被改动');
    assert.ok(!prepared.context.includes('已截断，完整内容请读取该条目'));
  } finally { store.close(); }
});
