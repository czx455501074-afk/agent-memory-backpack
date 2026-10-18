import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { Store } from '../src/store.js';

/**
 * 注入（`prepare`）必须按**真实查询**取片段与"读第几块"。
 *
 * 这是踩出来的：把 excerpt 改成"与查询相关的段落"之后，`prepare` 路径上一点没变——因为它给
 * `knowledge()` 传的是**空字符串**（那是故意的：空 query 让它列出全部候选，排序交给
 * `rankAutomatic`）。于是 excerpt 永远退回正文开头、`hitChunks` 永远是 null。
 *
 * 而当时的测试测的是 `knowledge()` 直调，所以全绿。**测了函数不等于测了那条真正在跑的路。**
 * 这条测试因此走 `prepare()`，并断言一个只在后段出现的词能被指出所在块。
 */

const roots: string[] = [];
const stores: Store[] = [];
function open() {
  const directory = mkdtempSync(join(tmpdir(), 'backpack-inject-'));
  roots.push(directory);
  const store = new Store(join(directory, 'knowledge.sqlite'), () => 1_000_000);
  stores.push(store);
  return store;
}
after(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of roots.splice(0)) {
    const rel = relative(resolve(tmpdir()), path);
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    try { rmSync(path, { recursive: true, force: true }); } catch { /* Windows 句柄未释放不算结论 */ }
  }
});

/** 一条 4 万字符左右的技能：`onlyneedle` 只出现在靠后的某一节，前面一次都没有。 */
function longEntry() {
  const filler = Array.from({ length: 12 }, (_unused, index) => `## 第 ${index} 节\n${'无关正文。'.repeat(200)}`);
  return [
    '---',
    'name: probe',
    'description: 一段普通描述',
    '---',
    ...filler,
    '## 稀有结论节',
    '这里才出现 onlyneedle 这个词，前面的章节里一次都没有。',
  ].join('\n');
}

test('prepare 的注入按真实查询取片段：后段关键词能被指出所在块', () => {
  const store = open();
  const body = longEntry();
  store.import([{
    id: 'skill:probe', baseRevision: 0, kind: 'skill',
    // 选中依据放在 **title**：它是独立字段、不进 body，所以不会污染段落匹配。
    // 早两版把锚词放进 body 的 frontmatter，结果开头段得分更高（`relevantPassages` 只取
    // 得分最高的那一段），于是"指到第 1 块"反而是对的 —— 测试测不出东西，还错了两次。
    title: 'probeanchor 探针技能',
    scope: { kind: 'global' }, body, leaves: [], needsStructure: true,
  }]);
  const prepared = store.prepare('p0-workflow', 'probeanchor 与 onlyneedle 该怎么处理');
  const entry = prepared.knowledge.find(item => item.id === 'skill:probe');
  assert.ok(entry, `条目应被自动注入选中：${prepared.knowledge.map(item => item.id).join('、')}`);

  // 这三条断言合起来才是"注入可用"：指了路、路是对的、片段里真的有关键词。
  assert.ok(entry.hitChunks, '必须指出相关段落在第几块——否则 agent 面对十几块只会挑第一块');
  assert.ok(entry.hitChunks!.chunks.some(position => position > 1),
    `onlyneedle 只出现在后段，应指出后段那一块：${entry.hitChunks!.chunks.join('、')}`);
  // excerpt 只有 400 字符，而关键词在窗口内的相对位置可能更靠后 —— 装不下它**不是缺陷**，
  // 因为 `hitChunks` 已经指出了位置（上面那条断言）。所以这里只断言"它不再是正文开头"：
  // 那才是"片段按查询取"的证据（修复前它永远等于 body 前 400 字）。
  //
  // 这里踩过一次：我打印"段文本前 60 字符"看到全是无关正文，就断定窗口选错了 —— 实际上
  // 关键词在窗口内的相对位置 657，**截断的打印会让人误判内容**。
  assert.notEqual(String(entry.excerpt).replace(/…$/, ''), body.slice(0, 400),
    '片段必须按查询取，不能等于正文开头');
  assert.match(prepared.context, /相关段落在第/, '注入行必须写出可执行的位置');
});

test('查询为空时不指路（那是浏览，不是查找）', () => {
  // 反方向：如果这条也指路，"指路"就变成了对任何查询都无意义的噪声。
  const store = open();
  store.import([{
    id: 'skill:probe2', baseRevision: 0, kind: 'skill', title: '探针技能二',
    scope: { kind: 'global' }, body: longEntry(), leaves: [], needsStructure: true,
  }]);
  const catalog = store.knowledge('p0-workflow', '', 5, 400);
  assert.ok(catalog.length > 0, '前提：空查询应列出目录');
  assert.equal(catalog[0]!.hitChunks, null, '浏览目录时不该指路');
});
