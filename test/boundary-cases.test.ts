import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkBody } from '../src/retrieval-chunk.js';
import { buildTermBridge } from '../src/term-bridge.js';

/**
 * 边界与对抗性输入。
 *
 * 顺路径的测试证明"能用"，这一组证明**不会在别的输入上炸、挂住、或者骗人**。每一项都写清
 * 它在防什么，因为"防什么"才是它存在的理由。
 *
 * 已知的实测来源：正文平均 7459 字符、最长 53117；用户会用口语提问；条目里混着中英、
 * emoji、CRLF、无换行的长串。这些都是真实会出现的形状，不是假想的。
 */

test('空正文不崩，也不假装有内容', () => {
  const view = chunkBody('');
  assert.equal(view.totalChunks, 1, '空正文应视为一块');
  assert.equal(view.hasMore, false);
  assert.ok(view.advisory.length > 0, '即使空也要给出说明，不能返回一个没有解释的空壳');
});

test('只有换行的正文不崩', () => {
  assert.ok(chunkBody('\n\n\n\n').totalChunks >= 1);
  assert.ok(chunkBody('\r\n\r\n').totalChunks >= 1);
});

test('极小 maxChars 不能让切分退化：块数必须与上限相称', () => {
  /**
   * 这条判据的第一版是"块数 < 2000"，而**它放过了真正的退化**：把重叠改回硬编码 120 之后，
   * 步长 `maxChars - overlap` 变成负数，被 `Math.max(1, …)` 兜成 1 —— 没有死循环，但 1500 字符
   * 的正文会切出 1500 个块，同样是坏的（跳读变成了逐字翻）。反向验证才发现这一点。
   *
   * 正确的期望：无重叠可加时步长就等于上限，所以块数 ≈ 正文长度 / maxChars。
   */
  const body = '内容。'.repeat(500);
  const view = chunkBody(body, { maxChars: 10 });
  assert.ok(view.totalChunks >= 1, '必须切出块');
  assert.ok(view.totalChunks <= 200,
    `块数应与 maxChars 相称（1500 字符 / 上限 10 ≈ 150 块）；实得 ${view.totalChunks} 说明步长退化了`);
  assert.ok(view.text.length <= 10, '单块不得超过上限');
});

test('maxChars 大于全文时只有一块，且不声称还有未读', () => {
  const view = chunkBody('短正文', { maxChars: 100000 });
  assert.equal(view.totalChunks, 1);
  assert.equal(view.hasMore, false);
});

test('五万字符的单行（无换行）能被切，行号如实', () => {
  const view = chunkBody('x'.repeat(50000));
  assert.ok(view.totalChunks > 1, '无换行的长文本也必须能切（真实数据里就有这种长串）');
  assert.equal(view.totalLines, 1, '它确实只有一行，回执不该编造行号');
  assert.ok(view.text.length <= 4000, '单块仍受默认上限约束');
});

test('endLine 早于 startLine 时不返回看起来正常的垃圾', () => {
  /**
   * 矛盾参数有两种可接受的处置：显式报错，或返回空并把范围如实写回。**不可接受的是**返回
   * 一段"看起来正常"的正文 —— 那会让调用方以为拿到了东西。
   */
  const view = chunkBody('第一行\n第二行\n第三行', { startLine: 3, endLine: 1 });
  const empty = view.text === '';
  assert.ok(empty || view.startLine <= view.endLine,
    `矛盾的行范围必须显式处理：startLine=${view.startLine} endLine=${view.endLine} text=${JSON.stringify(view.text)}`);
});

test('负数与越界索引被夹住，不崩', () => {
  const body = 'a\n'.repeat(3000);
  assert.ok(chunkBody(body, { chunkIndex: -5 }).text.length > 0, '负块号应夹到第一块');
  assert.equal(chunkBody(body, { chunkIndex: 99999 }).hasMore, false, '超界应夹到最后一块');
  assert.equal(chunkBody(body, { startLine: -3 }).startLine, 1, '负行号应夹到第 1 行');
});

test('CRLF 与混合换行不产生空标题', () => {
  const body = ['# 标题一\r', '内容一\r', '\r', '## 标题二\n', '内容二\n'].join('\n');
  const view = chunkBody(body, { maxChars: 10 });
  assert.ok(view.outline.length >= 1);
  assert.ok(view.outline.every(item => item.heading.trim().length > 0),
    `目录不得出现空标题（空标题在跳读时等于没有）：${JSON.stringify(view.outline)}`);
});

test('超长标题不会让目录失去可读性', () => {
  const view = chunkBody(`# ${'很长的标题'.repeat(300)}\n内容\n`);
  assert.ok(view.outline[0]!.heading.length < 3000, '标题不该等于整段正文');
});

test('术语桥：空输入不崩，也不产生噪声', () => {
  const bridge = buildTermBridge({});
  assert.deepEqual(bridge.aliases, []);
  assert.deepEqual(bridge.keywords, []);
});

test('术语桥：纯停用词不产出关键词（宁可为空，不要泛词）', () => {
  const bridge = buildTermBridge({ title: '说明', body: '需要 使用 进行 可以 这个 当前 一个 我们 任务 经验 检查 继续 主动' });
  for (const stop of ['需要', '使用', '进行', '这个']) {
    assert.ok(!bridge.keywords.includes(stop), `停用词不得成为关键词：${stop}`);
  }
});

test('术语桥：单字泛词不得成为别名（否则任何查询都能命中一堆条目）', () => {
  /**
   * 「库」是概念组「知识库/library/库」里的单字成员。单字泛词一旦进别名，含它的条目会被
   * 任何带"库"的查询命中 —— 这正是同类调研里警告的"tags/keywords 不能替代专名映射"。
   */
  const bridge = buildTermBridge({ title: '第三方库的用法', body: '这里讲某个包。' });
  assert.ok(!bridge.aliases.includes('库'), `单字泛词不应成为别名：${bridge.aliases.join('、')}`);
});

test('术语桥：超长与 emoji 输入不崩，且长度受 schema 约束', () => {
  const bridge = buildTermBridge({ title: '🎯'.repeat(400), body: `${'😀'.repeat(5000)}中文English123`, kind: 'memory' });
  assert.ok(Array.isArray(bridge.aliases));
  assert.ok(bridge.keywords.every(word => word.length >= 2 && word.length <= 200),
    '关键词长度必须落在 schema 允许的区间内（否则入库会被 400 拒绝）');
  assert.ok(bridge.aliases.every(word => word.length >= 2 && word.length <= 200), '别名同理');
  assert.ok(bridge.keywords.length <= 60, '关键词数量上限由 schema 决定');
  assert.ok(bridge.aliases.length <= 40, '别名数量上限由 schema 决定');
});

test('术语桥：英文与中文混合的条目两种说法都能成为别名', () => {
  const bridge = buildTermBridge({ title: 'Plugin 安装', body: '关于插件安装与 setup 的说明。', kind: 'memory' });
  assert.ok(bridge.aliases.includes('插件') || bridge.aliases.includes('plugin'),
    `概念组应把中英两侧连起来：${bridge.aliases.join('、')}`);
});
