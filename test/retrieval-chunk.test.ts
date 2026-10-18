import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkBody } from '../src/retrieval-chunk.js';

/**
 * 分块读取：让 agent 能把长条目读完，而不是"看到很大就只读开头"。
 *
 * 实测背景：库里正文平均 7459 字符、**最长 53117 字符**，而 `amb_read_knowledge` 过去一次
 * 给全文；`prepare` 注入的又只有前 400 字符。前者让 agent 面对五万字只读开头，后者让它以为
 * "就这些"。这里的判据是：**默认不给全文，且回执必须说清还有多少没读**——"没读完"要成为
 * 可见状态，而不是靠叮嘱。
 */

const LONG = [
  '# 长条目',
  '开头一段。'.repeat(20),
  '## 第一节 准备',
  '准备内容。'.repeat(60),
  '## 第二节 执行',
  '执行内容。'.repeat(60),
  '## 第三节 收尾',
  '收尾内容。'.repeat(60),
].join('\n');

test('按标题切块，并给出目录与未读数量', () => {
  const first = chunkBody(LONG);
  assert.ok(first.totalChunks >= 3, `至少应切出三块：${first.totalChunks}`);
  assert.equal(first.chunkIndex, 0);
  assert.ok(first.hasMore, '第一块之后还有内容');
  assert.equal(first.outline.length, first.totalChunks, '目录必须覆盖每一块（否则跳读无从下手）');
  assert.ok(first.outline.some(item => item.heading.includes('第二节')), `目录应含小节标题：${first.outline.map(o => o.heading).join('、')}`);
  assert.match(first.advisory, /还有 \d+ 块未读/, '未读必须明说，否则回执看起来像已经给全了');
  assert.ok(first.text.length < LONG.length, '默认不得返回全文');
});

test('chunkIndex 取指定块；最后一块不再声称还有未读', () => {
  const all = chunkBody(LONG);
  const last = chunkBody(LONG, { chunkIndex: all.totalChunks - 1 });
  assert.equal(last.chunkIndex, all.totalChunks - 1);
  assert.equal(last.hasMore, false);
  assert.equal(last.nextChunkIndex, null);
  assert.match(last.advisory, /最后一块/);
});

test('startLine/endLine 精确取行，并说明总共多少行', () => {
  const view = chunkBody(LONG, { startLine: 1, endLine: 5 });
  assert.equal(view.startLine, 1);
  assert.equal(view.endLine, 5);
  assert.equal(view.text.split('\n').length, 5);
  assert.match(view.advisory, /共 \d+ 行/);
});

test('没有标题的长文本也能切：按字符窗口，且单块不超过上限', () => {
  // 反方向：如果只有"有标题"的文本能切，那大量无标题的日记正文仍然会一次全给。
  const flat = '一句话。'.repeat(2000);
  const view = chunkBody(flat, { maxChars: 1000 });
  assert.ok(view.totalChunks > 1, '无标题时也必须能切');
  assert.ok(view.text.length <= 1000, `单块不得超过上限：${view.text.length}`);
});

test('越界的 chunkIndex 被夹到有效范围，不抛错也不返回空', () => {
  const view = chunkBody(LONG, { chunkIndex: 999 });
  assert.ok(view.text.length > 0, '越界应夹到最后一块，而不是给空正文');
  assert.equal(view.hasMore, false);
});
