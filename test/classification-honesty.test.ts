import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCandidate } from '../src/semantic.js';

/**
 * Classification honesty (W2).
 *
 * The defect these tests pin down was measured, not imagined: of 295 real pending
 * candidates, 193 were classified `norm/project` while the whole library held only
 * 7 genuine norms. The cause was `isNormative` accepting a single keyword
 * (`必须/不得/规范/…`), combined with `norm` having the highest precedence — so an
 * experience write-up that mentioned an obligation *about something that happened*
 * was promoted above every other signal in its own text.
 *
 * Both directions are asserted here on purpose. A test suite that only proves
 * "experiences are no longer norms" would pass just as well if the classifier had
 * been broken into always answering `memory`, and the next person to read it would
 * have no way to tell. Every normative sample below is therefore a text that must
 * *stay* a norm: four of them are verbatim norms already adopted in this project's
 * own library, which is the strongest available evidence that the tightened rule
 * did not simply stop recognising constraints.
 *
 * The experience samples are rewritten from real `payload.discovery` texts found in
 * the local library. Machine paths, user names and identifiers are replaced, and no
 * sample carries a line that identifies this machine — these run on any checkout.
 */

/** Texts that report an episode. None of them may be classified as a norm. */
const EXPERIENCE_SAMPLES: Array<{ label: string; text: string; expected: 'memory' | 'skill' }> = [
  {
    label: '自动捕获的失败事实（harness 写入的模板，含"不得"）',
    text: '【自动捕获的失败事实；待核实】 所属流程：工具执行与故障恢复；步骤：记录失败、检索已有经验、验证修复。'
      + ' 观察：exit_code=1，一个脚本在 junction 路径下静默失败、输出为零字节。'
      + ' 根因与修复：尚未验证；不得将本记录直接当作已采纳规范。',
    expected: 'memory',
  },
  {
    label: '实测发现的构建经验（含"必须"）',
    text: '实测发现打包时必须先清空 dist 目录，否则上一次的 .js 会被一起带上，发布包里混入旧产物。本次复跑已确认。',
    expected: 'memory',
  },
  {
    label: '排查叙述 + 判据清单（含"不要"）',
    text: '接入第三方网关时，如何判定卡在凭据还是卡在区域策略——实测判据与清单。'
      + '1. 先向它的配置端点要权威参数，不要只信文档表格，两者会不一致。'
      + '2. 免费层在外部调用恒返 403，凭据本身是好的。',
    expected: 'memory',
  },
  {
    label: '会话复盘（含日期与"不要用"）',
    text: '把订阅模型接进本机网关的端到端流程与实测坑（2026-10-15 全程跑通）。'
      + '一、凭据：把 key 写进用户级环境变量，不要用客户端自身读取的那个名字。'
      + '坑：写完环境变量后，已在运行的宿主不会重新读取它。',
    expected: 'memory',
  },
  {
    label: '方法论标题（闭环法，含两处"必须有"）',
    text: '短剧道具交付的物理因果闭环法：1. 交付段必须拍出两双手掌接触的接触帧，接收者收拢手指把材料带走，原主腰侧随即空瘪。'
      + '2. 接收者必须有大步穿过通道、推门进入工坊的离场动作。',
    expected: 'memory',
  },
  {
    label: '本会话遇到的自造 id 问题（含"必须先"）',
    text: '本次会话里我遇到一个问题：自造 taskId 时，检查点调用返回 404，内容完全不落盘。'
      + '原来必须先建任务、拿到它返回的真实 id，再去写检查点。',
    expected: 'memory',
  },
  {
    label: '带"实例："的计数陷阱（含"不要用"）',
    text: '断言"某类动作发生过几次"时，不要用"值里包含某个子串"当过滤器——同一个地址会被多个不同的 setter 写入，导致计数虚高。'
      + '实例：同一份基址同时写进两个字段，两处值都含同一个路径片段。',
    expected: 'memory',
  },
];

/**
 * Texts that state what must hold. Every one of them must stay a norm.
 *
 * The first four are verbatim adopted norms of this project's library; the fifth
 * and sixth are the shapes the original test suite already relied on. If a future
 * change makes any of these `memory`, the classifier has stopped working rather
 * than become stricter.
 */
const NORMATIVE_SAMPLES: Array<{ label: string; text: string }> = [
  {
    label: '采纳规范：接口超时归因',
    text: '排查接口超时必须带 x-amb-protocol: 1 请求头以防 426；使用无外部调用的纯同步端点作为对照组分离数据层与模型层耗时。',
  },
  {
    label: '采纳规范：日志窗口可比性',
    text: '比对日志计数验证修复效果前必须先证明两窗口可比：对齐事件类型集合、用比率而非绝对数、核对时间分布而不是总数。',
  },
  {
    label: '采纳规范：打包语法门禁',
    text: '打包发布脚本 scripts/package.mjs 必须包含 node --check 全量语法扫描，防止语法错误的脚本逃逸到安装目录。',
  },
  {
    label: '采纳规范：超时预算判定',
    text: '判断超时预算是否生效必须核对返回的 selection.mode 字段与 reason，不能仅凭总耗时推断；注意下游同步逻辑的未受控开销。',
  },
  {
    label: '既有测试样本：生产环境禁则',
    text: '严禁在生产环境执行未确认的 drop database 操作',
  },
  {
    label: '既有测试样本：分支推送禁则',
    text: '禁止直接推送 master 分支，必须先走评审',
  },
];

test('经验型文本不再被判为 norm（真实库 pending 改写样本）', () => {
  for (const sample of EXPERIENCE_SAMPLES) {
    const result = classifyCandidate(sample.text);
    assert.notEqual(result.kind, 'norm', `${sample.label}：经历叙述不得成为硬规范`);
    assert.equal(result.kind, sample.expected, `${sample.label}：期望 ${sample.expected}，实际 ${result.kind}（${result.reasoning}）`);
  }
});

test('真正的祈使约束仍然是 norm（含四条本项目已采纳规范）', () => {
  for (const sample of NORMATIVE_SAMPLES) {
    const result = classifyCandidate(sample.text);
    assert.equal(result.kind, 'norm', `${sample.label}：真规范被降级，判定改废了（${result.reasoning}）`);
  }
});

/**
 * A norm now has to say *where it came from* before one click may create it.
 *
 * The two "must not" cases are the shapes that produced the defect: an agent's own
 * recollection, and a constraint someone wants applied to every project. The two
 * "may" cases carry an external authority and a checkable evidence level, which is
 * what a rule handed down from outside actually looks like.
 */
test('证据等级与来源不足的规范不得自动升格为门禁硬规范', () => {
  const agentClaim = classifyCandidate('禁止在未确认的情况下对生产库执行 drop database 操作');
  assert.equal(agentClaim.kind, 'norm');
  assert.equal(agentClaim.autoPromotable, false, 'agent 自述的规范不得一键升格');
  assert.match(String(agentClaim.promotionBlockedReason), /provenance=agent/, '必须说明是来源身份不足');

  const globalRule = classifyCandidate('所有项目必须统一附带 x-amb-protocol: 1 请求头', [], {
    provenance: 'external', evidence: 'verifiable', sourceRef: 'AGENTS.md',
  });
  assert.equal(globalRule.kind, 'norm');
  assert.equal(globalRule.scope, 'global');
  assert.equal(globalRule.autoPromotable, false, '把约束推广到所有项目需要人工确认');
  assert.match(String(globalRule.promotionBlockedReason), /global/);

  const weakEvidence = classifyCandidate('打包发布脚本 scripts/package.mjs 必须包含 node --check 全量语法扫描', [], {
    provenance: 'external', evidence: 'self-reported', sourceRef: 'AGENTS.md',
  });
  assert.equal(weakEvidence.kind, 'norm');
  assert.equal(weakEvidence.autoPromotable, false, '自述证据不足以支撑硬规范');
  assert.match(String(weakEvidence.promotionBlockedReason), /evidence=self-reported/);
});

test('带外部权威来源的规范可以自动升格，经验降级后也可以', () => {
  const externalRule = classifyCandidate('打包发布脚本 scripts/package.mjs 必须包含 node --check 全量语法扫描', [], {
    provenance: 'external', evidence: 'verifiable', sourceRef: 'AGENTS.md',
  });
  assert.equal(externalRule.kind, 'norm');
  assert.equal(externalRule.autoPromotable, true, '外部权威来源的规范可以一键采纳');
  assert.equal(externalRule.promotionBlockedReason, undefined, '可升格时不得留下阻塞原因');

  const userRule = classifyCandidate('禁止直接推送 master 分支，必须先走评审', [], {
    provenance: 'user', evidence: 'observed', sourceRef: 'user-supplied rule sheet',
  });
  assert.equal(userRule.kind, 'norm');
  assert.equal(userRule.autoPromotable, true, '用户亲自给出的规则可以一键采纳');

  const experience = classifyCandidate(EXPERIENCE_SAMPLES[1]!.text);
  assert.equal(experience.kind, 'memory');
  assert.equal(experience.autoPromotable, true, '经验按经验采纳不受这条门禁影响');
});

test('规范和经历混在一句话里时，按经历处理而不是按关键词', () => {
  const mixed = classifyCandidate('本次实测发现，日志比对时计数必须先对齐事件类型，否则结论会虚高；我原来的做法是直接看总数。');
  assert.equal(mixed.kind, 'memory', '叙述外壳下的约束不能只凭"必须"升格');
  const rule = classifyCandidate('日志比对时计数必须先对齐事件类型集合，再比较比率。');
  assert.equal(rule.kind, 'norm', '同一约束的规范写法仍应判为 norm');
});

test('举例说明不等于经历叙述，规范里出现"例如"仍须判为 norm', () => {
  const withExample = classifyCandidate('提交信息必须遵循约定式格式，例如 feat/fix/docs 前缀；禁止把类型与描述写在同一行。');
  assert.equal(withExample.kind, 'norm', '"例如"是规范自己的举例方式，不是一次事件的报告');
});
