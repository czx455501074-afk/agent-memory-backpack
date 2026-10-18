import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { Store } from '../src/store.js';
import { proposeBridge } from '../src/term-bridge-model.js';

/**
 * 模型归纳版术语桥：补规则覆盖不到的那部分（项目内部黑话、旧称、某个人的习惯叫法）。
 *
 * 四条纪律各有判据，缺一条都会让"可选增强"变成隐患：
 *   1. **未配置就明说**，不假装做过、也不崩；
 *   2. **模型不可用/返回垃圾 → 降级到规则桥**，而不是"没有桥"；
 *   3. **产出要清洗**（去重、拒绝单字泛词），因为编出来的别名会让检索命中无关条目；
 *   4. **不写回条目**：桥存独立表，跑完重建索引即可生效（造新修订是它不该付的代价）。
 */

const roots: string[] = [];
const stores: Store[] = [];
after(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of roots.splice(0)) {
    const rel = relative(resolve(tmpdir()), resolve(path));
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    try { rmSync(path, { recursive: true, force: true }); } catch { /* Windows 句柄未释放不算结论 */ }
  }
});
function open() {
  const directory = mkdtempSync(join(tmpdir(), 'backpack-model-bridge-'));
  roots.push(directory);
  const store = new Store(join(directory, 'knowledge.sqlite'), () => 1_000_000);
  stores.push(store);
  return store;
}

const CONFIG = { endpoint: 'https://model.example.invalid/v1', model: 'stub-model' };
/** 一个只回答固定 JSON 的假模型。 */
const answering = (payload: unknown) => (async () =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status: 200 })) as unknown as typeof fetch;
const failing = (status: number) => (async () => new Response('nope', { status })) as unknown as typeof fetch;

test('未配置模型时不崩，并如实说明只有规则桥', async () => {
  const proposal = await proposeBridge({ title: '标题', body: '正文' });
  assert.equal(proposal.source, 'rule');
  assert.equal(proposal.reason, 'not_configured');
  assert.deepEqual(proposal.aliases, []);
  assert.deepEqual(proposal.keywords, []);
});

test('模型正常作答时产出可用的别名与关键词', async () => {
  const proposal = await proposeBridge({ title: '入库纪律', body: '写库前先写规范描述。', kind: 'norm', config: CONFIG }, {
    fetchImpl: answering({ aliases: ['写库的讲究', '入库的规矩'], keywords: ['入库纪律', '规范化'], summary: '写库前先写规范描述。' }),
  });
  assert.equal(proposal.source, 'model');
  assert.equal(proposal.model, 'stub-model');
  assert.ok(proposal.aliases.includes('入库的规矩'), `别名应含模型给的说法：${proposal.aliases.join('、')}`);
  assert.ok(proposal.summary.length > 0);
});

test('模型不可用时降级到规则桥，而不是"没有桥"', async () => {
  // 反方向：如果这条返回 source:'model' 或抛错，"可选增强"就变成了隐患。
  const proposal = await proposeBridge({ title: '标题', body: '正文', config: CONFIG }, { fetchImpl: failing(503) });
  assert.equal(proposal.source, 'rule');
  assert.equal(proposal.reason, 'unavailable');
});

test('模型返回不合形状时降级，不把垃圾当桥', async () => {
  const proposal = await proposeBridge({ title: '标题', body: '正文', config: CONFIG }, {
    fetchImpl: answering({ aliases: '不是数组', somethingElse: 1 }),
  });
  assert.equal(proposal.source, 'rule');
  assert.equal(proposal.reason, 'invalid_response');
});

test('产出被清洗：去重，且拒绝单字泛词', async () => {
  const proposal = await proposeBridge({ title: '标题', body: '正文', config: CONFIG }, {
    fetchImpl: answering({ aliases: ['库', '入库的规矩', '入库的规矩', ' '], keywords: ['入库', '入库'], summary: '摘要' }),
  });
  assert.equal(proposal.source, 'model');
  assert.ok(!proposal.aliases.includes('库'), `单字泛词应被拒绝：${proposal.aliases.join('、')}`);
  assert.equal(proposal.aliases.filter(word => word === '入库的规矩').length, 1, '重复项应被去掉');
  assert.equal(proposal.keywords.filter(word => word === '入库').length, 1, '关键词同样去重');
});

test('模型桥落库后进索引，且不需要改条目（不造新修订）', async () => {
  const store = open();
  store.import([{
    id: 'memory:probe', baseRevision: 0, kind: 'memory', title: '入库纪律', scope: { kind: 'global' },
    body: '写库前先写规范描述。',
  }]);
  const revisionBefore = store.revision;
  store.saveBridge([{ id: 'memory:probe', revision: 1, model: 'stub-model', aliases: ['写库的讲究'], keywords: [], summary: '摘要' }]);
  assert.equal(store.revision, revisionBefore, '存桥不得产生新修订');

  // 前提：这个词在规则桥下也搜不到（否则下面的断言证明不了模型桥生效）。
  const rebuilt = store.rebuildSearchIndex();
  assert.ok(rebuilt >= 1);
  const hit = store.searchUniversal('p0-workflow', '写库的讲究', 'memory', 10);
  assert.ok(hit.some(entry => entry.id === 'memory:probe'),
    `模型桥应进索引并可用：${hit.map(entry => entry.id).join('、')}`);
});
