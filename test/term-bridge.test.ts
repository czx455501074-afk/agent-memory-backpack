import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { Store } from '../src/store.js';
import { buildTermBridge } from '../src/term-bridge.js';

/**
 * 术语桥：让「用户怎么说」与「库里怎么写」对上。
 *
 * 实测的病：库里 173 条条目、**173 条没有任何桥字段**；用户问「我以前写下的那些规矩」，
 * 而库里那 4 条 norm 的标题写的是「规范」——检索回执 `matched=0`，agent 就"听不懂"。
 * 这不是模型笨，是**库里没有可对上的术语**，而词法检索看不见"规矩"与"规范"是同一件事。
 *
 * 三条被钉住的性质，顺序就是它们的重要性：
 *   1. 概念组真的能把"规矩"接到"规范"上（否则整套桥只是装饰）；
 *   2. 桥进了索引之后，用别名提问**真的能命中那条条目**（端到端，不是纯函数自证）；
 *   3. 条目自带的别名（模型归纳或人填的）**不被规则覆盖**——那是更强的证据。
 */

const roots: string[] = [];
const stores: Store[] = [];
function open() {
  const directory = mkdtempSync(join(tmpdir(), 'backpack-bridge-'));
  roots.push(directory);
  const store = new Store(join(directory, 'knowledge.sqlite'), () => 1_000_000);
  stores.push(store);
  return store;
}
after(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of roots.splice(0)) {
    const rel = relative(resolve(tmpdir()), resolve(path));
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    try { rmSync(path, { recursive: true, force: true }); } catch { /* Windows 句柄未释放不算结论 */ }
  }
});

test('概念组把「规矩」接到「规范」上，也把中文接到英文上', () => {
  const bridge = buildTermBridge({ title: '规范：入库前先写规范描述', body: '这条规则讲的是入库纪律。', kind: 'norm' });
  assert.ok(bridge.aliases.includes('规矩'), `别名里应有「规矩」：${bridge.aliases.join('、')}`);
  assert.ok(bridge.aliases.includes('rule') || bridge.aliases.includes('norm'), '别名里应有英文对应词');
  assert.ok(bridge.keywords.length > 0, '关键词不该为空（否则桥没有内容）');
});

test('新写入的条目自动带桥：用别名提问即可命中', () => {
  // 写入路径本身就是索引生成点之一，所以新条目不需要额外动作。
  const store = open();
  store.import([{
    id: 'norm:probe', baseRevision: 0, kind: 'norm', title: '入库纪律', scope: { kind: 'global' },
    body: '写库前先写规范、全面的描述，不要把流水原文写进正文。',
  }]);
  const hit = store.searchUniversal('p0-workflow', '规矩', 'norm', 10);
  assert.ok(hit.some(entry => entry.id === 'norm:probe'),
    `新条目写入时就该带桥，「规矩」应命中：${hit.map(entry => entry.id).join('、')}`);
});

test('存量条目（索引里没有桥）要靠 reindex 才受益', () => {
  // 这才是真实库的形状：173 条条目**都已经有索引行**，而那些行是在加桥之前建的。
  // 库打开时只会回填"缺索引"的条目，不会重算已有的——所以需要一个显式重建。
  const store = open();
  store.import([{
    id: 'norm:legacy', baseRevision: 0, kind: 'norm', title: '入库纪律', scope: { kind: 'global' },
    body: '写库前先写规范、全面的描述。',
  }]);
  store.db.prepare('DELETE FROM workflow_search WHERE id=?').run('norm:legacy');
  const before = store.searchUniversal('p0-workflow', '规矩', 'norm', 10);
  assert.equal(before.length, 0, '前提：没有索引行就没有桥（否则下面的断言是空检查）');

  const rebuilt = store.rebuildSearchIndex();
  assert.ok(rebuilt >= 1, '重建应至少覆盖那一条');
  const after = store.searchUniversal('p0-workflow', '规矩', 'norm', 10);
  assert.ok(after.some(entry => entry.id === 'norm:legacy'),
    `重建后「规矩」应命中 norm:legacy：${after.map(entry => entry.id).join('、')}`);
});

test('条目自带的别名不被规则覆盖', () => {
  const store = open();
  store.import([{
    id: 'memory:model', baseRevision: 0, kind: 'memory', title: '一条带模型归纳别名的记忆',
    scope: { kind: 'global' }, body: '正文内容与别名无关。',
    // 模型归纳或人填的别名：比规则更强，索引应原样采用。
    aliases: ['用户自己的叫法'], keywords: ['专有词'],
  }]);
  store.rebuildSearchIndex();
  const hit = store.searchUniversal('p0-workflow', '用户自己的叫法', 'memory', 10);
  assert.ok(hit.some(entry => entry.id === 'memory:model'), '自带别名应进索引并可用');
});
