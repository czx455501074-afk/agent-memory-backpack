import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, queryTokens, expandedQueryTokens } from '../src/store.js';
import { inferDomain, isKnownDomain, DOMAINS } from '../src/domain-taxonomy.js';
import { expandQueryTerms } from '../src/term-bridge.js';

function proposalPayload(store: Store, id: string): Record<string, unknown> {
  const row = store.db.prepare('SELECT payload FROM proposals WHERE id=?').get(id) as { payload: string };
  return JSON.parse(row.payload) as Record<string, unknown>;
}

test('提交时自动判定工作类别，不需要调用方给出', () => {
  const store = new Store(':memory:');
  try {
    const receipt = store.submit('adapter', {
      idempotencyKey: 'auto-domain-1', projectId: 'p',
      discovery: '宿主插件装载后 hook 没有挂上，会话重启之后才恢复；排查时先看适配器日志里的 session 记录。',
    });
    const context = proposalPayload(store, receipt.id).autoClassification as { domain?: string } | undefined;
    assert.equal(context?.domain, 'host-runtime');
    assert.ok(isKnownDomain(context!.domain!));
  } finally { store.close(); }
});

test('高置信度的范围直接落定，推断不能自封为规范', () => {
  const store = new Store(':memory:');
  try {
    const plain = store.submit('adapter', {
      idempotencyKey: 'auto-kind-1', projectId: 'p',
      discovery: '适用：单测失败时先确认 dist 是否为最新构建。判据：重建后同一断言转绿。',
    });
    const plainContext = proposalPayload(store, plain.id).autoClassification as { kind?: string; scope?: string } | undefined;
    assert.ok(plainContext, '普通候选应当带上自动分类结果');
    assert.equal(plainContext!.scope, 'project', '非 global 的普通结论可以自动落 scope');

    const claimed = store.submit('adapter', {
      idempotencyKey: 'auto-kind-2', projectId: 'p',
      discovery: '所有项目都必须先停核心再部署插件，否则 EBUSY。',
    });
    const claimedContext = proposalPayload(store, claimed.id).autoClassification as { kind?: string } | undefined;
    assert.notEqual(claimedContext?.kind, 'norm', '推断不能自封为参与工具门禁的规范');
  } finally { store.close(); }
});

test('调用方给了 domain 时不被推断覆盖', () => {
  const store = new Store(':memory:');
  try {
    const explicit = store.submit('adapter', {
      idempotencyKey: 'explicit-domain', projectId: 'p',
      discovery: '数据库迁移之后 integrity_check 必须为 ok 才算完成。',
      memoryContext: { domain: 'retrieval-knowledge' },
    });
    const payload = proposalPayload(store, explicit.id).memoryContext as { domain?: string };
    assert.equal(payload.domain, 'retrieval-knowledge');
  } finally { store.close(); }
});

test('域词表受控：无明确线索时宁可不猜', () => {
  assert.equal(inferDomain('好的，继续。').domain, undefined);
  assert.equal(inferDomain('这件事先放一放。').domain, undefined);
  for (const definition of DOMAINS) assert.ok(isKnownDomain(definition.id));
});

test('双语桥双向：中文查询扩展出英文词，英文查询扩展出中文二元组', () => {
  const fromChinese = expandQueryTerms('上下文预算');
  assert.ok(fromChinese.latin.includes('context'), '中文「上下文」应扩展出 context');
  assert.ok(fromChinese.latin.includes('budget'), '中文「预算」应扩展出 budget');

  const fromEnglish = expandQueryTerms('context budget');
  assert.ok(fromEnglish.han.includes('上下'), '英文 context 应扩展出中文二元组');
  assert.ok(fromEnglish.han.includes('预算'), '英文 budget 应扩展出中文二元组');
});

test('桥接结果与索引同构：中文只出二元组，英文不出空格', () => {
  const bridge = expandQueryTerms('上下文 部署 插件');
  for (const token of bridge.han) assert.equal(token.length, 2);
  for (const token of bridge.latin) assert.ok(!/\s/.test(token));
});

test('显式检索与自动召回使用不同的 token 集', () => {
  const expanded = expandedQueryTokens('部署插件');
  const strict = queryTokens('部署插件');
  assert.ok(expanded.includes('部署'), '原词二元组必须保留');
  assert.ok(expanded.includes('deploy') || expanded.includes('install'), '显式检索应补出英文说法');
  assert.ok(expanded.indexOf('部署') < expanded.indexOf('deploy') || !expanded.includes('deploy'),
    '同长度时原词排在桥接词之前');
  // 自动召回用精确 token：桥接词必须缺席，否则样板话术会把无关技能拉进注入。
  assert.ok(strict.includes('部署'));
  assert.ok(!strict.includes('deploy') && !strict.includes('install'), '自动召回不得使用桥接词');
});
