import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { Store } from '../src/store.js';
import { discover } from '../src/discovery.js';
import type { Knowledge, KnowledgeDraft, Workflow, WorkflowDraft } from '../src/schema.js';

async function scratch(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}
async function cleanup(dir: string): Promise<void> {
  const rel = relative(resolve(tmpdir()), resolve(dir));
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await rm(dir, { recursive: true, force: true });
}

/** Adopt one skill directory, returning the store holding it. */
async function adoptSkill(s: Store, root: string): Promise<string> {
  const report = discover([root]);
  const skill = report.candidates.find(candidate => candidate.kind === 'skill');
  assert.ok(skill, '测试必须先产生一个技能候选');
  s.adopt([{
    source: { path: skill.source.path, hash: skill.source.hash },
    kind: skill.kind, title: skill.title,
    knowledge: {
      id: skill.id, kind: 'skill', title: skill.title, scope: { kind: 'global' },
      baseRevision: 0, body: skill.body,
      leaves: (skill.leaves ?? []).map(leaf => ({ path: leaf.path, hash: leaf.hash, body: leaf.body })),
      needsStructure: true,
    },
  }]);
  return skill.id;
}

/** A workflow the caller authored, deliberately not derived from the Markdown. */
const authoredWorkflow = (id: string): WorkflowDraft => ({
  id, kind: 'workflow', title: '已结构化的部署流程', scope: { kind: 'global' }, baseRevision: 0,
  overview: '按作者理解的顺序执行部署并逐项核对。',
  triggers: ['需要部署到测试环境'], categories: [['部署']], tags: [], isEntryPoint: true,
  preconditions: ['已确认目标环境与凭据可用'],
  stages: [
    { id: 'prepare', title: '准备环境', instructions: '确认依赖与配置齐全。', checks: ['依赖已就绪'], dependencies: [] },
    { id: 'deploy', title: '执行部署', instructions: '按顺序执行部署命令。', checks: ['部署输出无错误'], dependencies: [] },
  ],
  completion: ['服务健康检查通过'], recovery: '任一步失败时停止并回滚到上一个可用版本。',
});

test('结构化：新流程生效，原技能同事务退场，链路可追溯', async () => {
  const root = await scratch('amb-struct-');
  const dataDir = await scratch('amb-struct-db-');
  try {
    await mkdir(join(root, 'ops'), { recursive: true });
    await writeFile(join(root, 'ops', 'SKILL.md'), '# 部署技能\n\n## 触发\n需要部署时。\n\n## 步骤\n先准备，再部署。\n');

    const s = new Store(join(dataDir, 'k.sqlite'));
    try {
      const skillId = await adoptSkill(s, root);
      assert.equal(s.allEntries().length, 1);
      assert.equal(s.allEntries()[0]!.content.kind, 'skill');
      assert.equal(s.unstructuredSkills().length, 1, '采纳的技能应出现在待结构化列表中');

      const result = s.structureSkill({
        skillId, workflow: authoredWorkflow('ops-deploy'),
        derivedBy: 'user', evidence: '按本人实际操作顺序整理',
      });

      assert.equal(result.workflowId, 'ops-deploy');
      assert.equal(result.retiredSkillRevision, 1);

      // The workflow is now the only active entry; the skill left default retrieval.
      const active = s.allEntries();
      assert.equal(active.length, 1);
      assert.equal(active[0]!.content.id, 'ops-deploy');
      assert.equal(active[0]!.content.kind, 'workflow');

      // The structured workflow carries its provenance.
      const wf = active[0]!.content as Workflow;
      assert.ok(wf.derivedFrom, '结构化流程必须记录出处');
      assert.equal(wf.derivedFrom!.skillId, skillId);
      assert.equal(wf.derivedFrom!.skillRevision, 1);
      assert.equal(wf.derivedFrom!.derivedBy, 'user');
      assert.equal(wf.derivedFrom!.evidence, '按本人实际操作顺序整理');

      // The skill text survives, and the chain explains the conversion.
      const history = s.history(skillId);
      assert.equal(history.revisions.length, 1, '技能原文必须保留');
      assert.equal(history.current?.status, 'retired');
      assert.equal(history.chain.length, 1);
      assert.equal(history.chain[0]!.action, 'supersede');
      assert.equal(history.chain[0]!.oldKnowledgeId, skillId);
      assert.equal(history.chain[0]!.newKnowledgeId, 'ops-deploy');

      // It becomes reachable through normal workflow retrieval.
      assert.deepEqual(s.search('', '部署').map(w => w.id), ['ops-deploy']);
      assert.equal(s.unstructuredSkills().length, 0, '结构化后不再列为待处理');
    } finally { s.close(); }
  } finally { await cleanup(root); await cleanup(dataDir); }
});

test('结构化必须提供依据，且只能作用于已采纳的技能', async () => {
  const root = await scratch('amb-struct-');
  const dataDir = await scratch('amb-struct-db-');
  try {
    await mkdir(join(root, 'ops'), { recursive: true });
    await writeFile(join(root, 'ops', 'SKILL.md'), '# 部署技能\n\n内容。\n');

    const s = new Store(join(dataDir, 'k.sqlite'));
    try {
      const skillId = await adoptSkill(s, root);

      // Evidence is mandatory: a conversion must state what it is based on.
      await assert.rejects(
        async () => s.structureSkill({ skillId, workflow: authoredWorkflow('wf-1'), derivedBy: 'user', evidence: '   ' }),
        /must cite what the structure is based on/,
      );
      assert.equal(s.allEntries().length, 1, '失败的转换不得改变生效集合');
      assert.equal(s.allEntries()[0]!.content.kind, 'skill');

      // A workflow id must not collide with the skill id it came from.
      await assert.rejects(
        async () => s.structureSkill({ skillId, workflow: authoredWorkflow(skillId), derivedBy: 'user', evidence: 'e' }),
        /needs its own id/,
      );

      // Unknown or non-skill targets are refused.
      await assert.rejects(
        async () => s.structureSkill({ skillId: 'nope', workflow: authoredWorkflow('wf-2'), derivedBy: 'user', evidence: 'e' }),
        /unavailable/,
      );
      s.import([{ id: 'plain-norm', kind: 'norm', title: '规范', scope: { kind: 'global' }, baseRevision: 0, body: '正文。', deniedTools: [], hostProvided: false } as KnowledgeDraft]);
      await assert.rejects(
        async () => s.structureSkill({ skillId: 'plain-norm', workflow: authoredWorkflow('wf-3'), derivedBy: 'user', evidence: 'e' }),
        /Only an adopted skill/,
      );

      // A malformed workflow is rejected by the shared schema, not silently stored.
      // The matcher must be a pattern or error type: a bare string argument is
      // only a failure message, so any thrown error would pass the assertion.
      await assert.rejects(
        async () => s.structureSkill({ skillId, workflow: { id: 'bad', kind: 'workflow' } as unknown as Workflow, derivedBy: 'user', evidence: 'e' }),
        (error: unknown) => error instanceof Error && error.name === 'ZodError',
        '缺字段的结构必须被共享 schema 拒绝',
      );
      assert.equal(s.supersessions().length, 0, '所有失败路径都不得留下链路记录');
    } finally { s.close(); }
  } finally { await cleanup(root); await cleanup(dataDir); }
});

test('结构化不伪造步骤：空步骤结构被拒绝', async () => {
  const root = await scratch('amb-struct-');
  const dataDir = await scratch('amb-struct-db-');
  try {
    await mkdir(join(root, 'ops'), { recursive: true });
    await writeFile(join(root, 'ops', 'SKILL.md'), '# 技能\n\n正文。\n');
    const s = new Store(join(dataDir, 'k.sqlite'));
    try {
      const skillId = await adoptSkill(s, root);
      const hollow = { ...authoredWorkflow('wf-hollow'), stages: [] };
      // A bare string here would be treated as the failure message, so any thrown
      // error (including a TypeError) would satisfy the assertion. The matcher
      // pins the rejection to the schema complaint about the missing stages.
      await assert.rejects(
        async () => s.structureSkill({ skillId, workflow: hollow as unknown as Workflow, derivedBy: 'agent', evidence: 'e' }),
        (error: unknown) => error instanceof Error && /stage/i.test(error.message),
        '缺少步骤的结构不得被接受：那是把技能伪装成已核实方法',
      );
      assert.equal(s.allEntries()[0]!.content.kind, 'skill', '技能必须保持原状');
    } finally { s.close(); }
  } finally { await cleanup(root); await cleanup(dataDir); }
});

test('已退役的技能不能被再次结构化', async () => {
  const root = await scratch('amb-struct-');
  const dataDir = await scratch('amb-struct-db-');
  try {
    await mkdir(join(root, 'ops'), { recursive: true });
    await writeFile(join(root, 'ops', 'SKILL.md'), '# 技能\n\n正文。\n');
    const s = new Store(join(dataDir, 'k.sqlite'));
    try {
      const skillId = await adoptSkill(s, root);
      s.retire(skillId, 1);
      await assert.rejects(
        async () => s.structureSkill({ skillId, workflow: authoredWorkflow('wf-x'), derivedBy: 'user', evidence: 'e' }),
        /is retired/,
        '已退场的技能不得被重新结构化为生效流程',
      );
    } finally { s.close(); }
  } finally { await cleanup(root); await cleanup(dataDir); }
});
