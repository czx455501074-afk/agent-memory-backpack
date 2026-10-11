import test from 'node:test';
import assert from 'node:assert/strict';
import { characterSimilarity, classifyCandidate, calculateHybridScore } from '../src/semantic.js';

test('characterSimilarity 计算中文字符与技术标记的相似度', () => {
  assert.equal(characterSimilarity('', 'test'), 0);
  assert.equal(characterSimilarity('完全相同文本', '完全相同文本'), 1);

  const simHigh = characterSimilarity('核心重启排查', '排查核心重启问题');
  const simLow = characterSimilarity('核心重启排查', '图像生成风格调整');
  assert.ok(simHigh > simLow, `相似文本得分应显著高于无关文本：high=${simHigh}, low=${simLow}`);
  assert.ok(simHigh > 0.4);
  assert.ok(simLow < 0.2);
});

test('classifyCandidate 准确识别规范、偏好、资料与操作流程', () => {
  const norm = classifyCandidate('严禁在生产环境执行未确认的 drop database 操作');
  assert.equal(norm.kind, 'norm');

  const pref = classifyCandidate('用户偏好在所有 TypeScript 文件中使用两个空格缩进');
  assert.equal(pref.kind, 'preference');

  const mat = classifyCandidate('参考外部文档 https://api.example.com/v1/auth 进行接口联调');
  assert.equal(mat.kind, 'material');

  const proc = classifyCandidate('第一步检查端口占用，第二步确认服务进程存活，第三步执行连通性测试');
  assert.equal(proc.kind, 'skill');
});

test('classifyCandidate 识别任务级与全局级作用域', () => {
  const taskScoped = classifyCandidate('仅限当前任务临时使用 SQLite 内存模式加速单元测试');
  assert.equal(taskScoped.scope, 'task');

  const globalScoped = classifyCandidate('所有项目通用的日志脱敏规范与凭据保护要求');
  assert.equal(globalScoped.scope, 'global');
});

test('classifyCandidate 识别混合多类型内容并建议拆分 (C2)', () => {
  const mixed = classifyCandidate('严禁直接推送 master 分支；同时偏好在提交信息中使用语义化约定式前缀');
  assert.equal(mixed.needsSplit, true);
  assert.ok(mixed.suggestedSplit && mixed.suggestedSplit.length >= 2);
  const kinds = mixed.suggestedSplit.map(s => s.kind);
  assert.ok(kinds.includes('norm'));
  assert.ok(kinds.includes('preference'));
});

test('classifyCandidate 结合已有条目判断重复、补充与推翻 (C4/C5)', () => {
  const existing = [
    {
      id: 'm-restart',
      title: '核心重启排查经验',
      body: '当核心重启无法拉起时，检查端口47631占用与独占排他锁状态。',
      kind: 'memory',
    },
  ];

  const dup = classifyCandidate('核心重启无法拉起时，检查端口47631占用与独占排他锁状态。', existing);
  assert.equal(dup.relation, 'duplicate');
  assert.equal(dup.conflictingEntryId, 'm-restart');

  const sup = classifyCandidate('核心重启排查经验：当端口47631占用时，进一步使用 Get-Process 排查持有进程。', existing);
  assert.equal(sup.relation, 'supplement');
  assert.equal(sup.conflictingEntryId, 'm-restart');

  const supersede = classifyCandidate('旧结论错误，核心重启不是因为端口47631，而是因为锁文件未释放，改用清理锁文件。', existing);
  assert.equal(supersede.relation, 'supersede');
  assert.equal(supersede.conflictingEntryId, 'm-restart');
});

test('calculateHybridScore 结合覆盖率、语义相似度、证据等级与版本条件排序 (B2)', () => {
  const scoreVerified = calculateHybridScore({
    coverage: 1.0,
    semanticSim: 0.8,
    evidence: 'verified',
    revision: 2,
  });

  const scoreSelfReported = calculateHybridScore({
    coverage: 1.0,
    semanticSim: 0.8,
    evidence: 'self-reported',
    revision: 2,
  });

  assert.ok(scoreVerified > scoreSelfReported, '已验证证据的混合得分必须高于自述证据');

  const scoreHighCoverage = calculateHybridScore({
    coverage: 0.9,
    semanticSim: 0.7,
    evidence: 'observed',
    revision: 1,
  });

  const scoreLowCoverage = calculateHybridScore({
    coverage: 0.3,
    semanticSim: 0.7,
    evidence: 'observed',
    revision: 1,
  });

  assert.ok(scoreHighCoverage > scoreLowCoverage, '覆盖率高者整体排名靠前');
});
