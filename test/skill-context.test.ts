import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { Store } from '../src/store.js';
import { discover } from '../src/discovery.js';

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'amb-ctx-'));
  await mkdir(join(root, 'skills', 'alpha', 'references'), { recursive: true });
  await writeFile(join(root, 'AGENTS.md'), '# 工作契约\n\n默认中文；密钥不进日志。\n');
  await writeFile(join(root, 'skills', 'alpha', 'SKILL.md'), '# Alpha 技能\n\n## 触发\n需要处理 alpha 任务时。\n\n## 步骤\n先读取参考，再执行。\n');
  await writeFile(join(root, 'skills', 'alpha', 'references', 'detail.md'), '# Alpha 细节\n\n唯一的叶子主题：伽马参数。\n');
  return root;
}

async function cleanup(root: string): Promise<void> {
  const rel = relative(resolve(tmpdir()), resolve(root));
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await rm(root, { recursive: true, force: true });
}

function adoptFrom(root: string, s: Store) {
  const report = discover([root]);
  return s.adopt(report.candidates.map(candidate => ({
    source: { path: candidate.source.path, hash: candidate.source.hash },
    kind: candidate.kind,
    title: candidate.title,
    knowledge: candidate.kind === 'skill'
      ? {
        id: candidate.id, kind: 'skill' as const, title: candidate.title,
        scope: { kind: 'global' as const }, baseRevision: 0, body: candidate.body,
        leaves: (candidate.leaves ?? []).map(l => ({ path: l.path, hash: l.hash, body: l.body })),
        needsStructure: true,
      }
      : {
        id: candidate.id, kind: 'norm' as const, title: candidate.title,
        scope: { kind: 'global' as const }, baseRevision: 0, body: candidate.body,
        deniedTools: [], hostProvided: candidate.hostProvided,
      },
  })));
}

test('采纳的技能可被检索，叶子文本随入口一起索引', async () => {
  const root = await fixture();
  const dataDir = await mkdtemp(join(tmpdir(), 'amb-ctxdb-'));
  try {
    const s = new Store(join(dataDir, 'k.sqlite'));
    try {
      adoptFrom(root, s);

      // The skill entry must be discoverable by its own title.
      const byTitle = s.knowledge('', 'Alpha 技能');
      assert.equal(byTitle.length, 1, JSON.stringify(byTitle));
      assert.equal(byTitle[0]!.kind, 'skill');
      assert.equal(byTitle[0]!.leafCount, 1);
      assert.equal(byTitle[0]!.needsStructure, true);
      assert.match(byTitle[0]!.excerpt, /Alpha 技能/);

      // A leaf-only topic must still find the owning entry, never a fragment.
      const byLeaf = s.knowledge('', '伽马参数');
      assert.equal(byLeaf.length, 1, '叶子主题必须找到其所属技能入口');
      assert.equal(byLeaf[0]!.id, byTitle[0]!.id);

      // Skills must not appear in the workflow result shape.
      assert.deepEqual(s.search('', 'Alpha 技能'), []);
    } finally { s.close(); }
  } finally { await cleanup(root); await cleanup(dataDir); }
});

test('检索只返回有界摘要，全文按需展开', async () => {
  const root = await fixture();
  const dataDir = await mkdtemp(join(tmpdir(), 'amb-excerpt-'));
  try {
    const s = new Store(join(dataDir, 'k.sqlite'));
    try {
      adoptFrom(root, s);
      const id = s.knowledge('', 'Alpha 技能')[0]!.id;

      // The default path must not inline the whole document.
      const summary = s.knowledge('', 'Alpha 技能', 5, 40)[0]!;
      assert.ok(summary.excerpt.length <= 41, '摘要必须被截断');
      assert.ok(summary.chars > summary.excerpt.length, '必须报告正文原始长度供调用方判断');

      // Full text is one explicit call away.
      const full = s.readKnowledge('', id);
      assert.match(full.body, /先读取参考，再执行/);
      assert.equal(full.kind, 'skill');
      assert.equal(full.needsStructure, true, '未结构化技能必须如实标注');
      assert.equal(full.leaves.length, 1, '叶子路径必须可见');
      assert.equal(full.leaves[0]!.body, '', '默认不返回叶子正文，避免无谓膨胀');

      const withLeaves = s.readKnowledge('', id, true);
      assert.match(withLeaves.leaves[0]!.body, /伽马参数/, '显式请求时才返回叶子正文');

      // Unknown or non-knowledge ids are refused rather than returning an empty shell.
      assert.throws(() => s.readKnowledge('', 'norm:deadbeefdeadbeef'), /unavailable/);
    } finally { s.close(); }
  } finally { await cleanup(root); await cleanup(dataDir); }
});

test('宿主已加载的指令文件不重复注入，但其他规范正常注入', async () => {
  const root = await fixture();
  const dataDir = await mkdtemp(join(tmpdir(), 'amb-ctxprep-'));
  try {
    const s = new Store(join(dataDir, 'k.sqlite'));
    try {
      adoptFrom(root, s);
      // A norm the host does not load itself; this one must be injected.
      s.import([{
        id: 'plugin-norm', kind: 'norm', title: '插件自有规范',
        scope: { kind: 'global' }, baseRevision: 0,
        body: '这条规范仅由插件提供，宿主不会自行加载。', deniedTools: [], hostProvided: false,
      }]);
      const prepared = s.prepare('', 'Alpha 技能');

      // AGENTS.md is host-provided: indexed and listed for audit, never re-sent.
      assert.equal(prepared.norms.length, 1, '只有非宿主规范进入注入列表');
      assert.equal(prepared.norms[0]!.id, 'plugin-norm');
      assert.match(prepared.context, /宿主已自行加载的规范/, '宿主规范必须被登记而不是被忽略');
      assert.equal(prepared.context.includes('默认中文'), false, '宿主已加载的正文不得重复注入');
      assert.match(prepared.context, /这条规范仅由插件提供/, '插件自有规范必须注入');

      assert.equal(prepared.workflows.length, 0, '技能不得伪装成 workflow');
      assert.equal(prepared.knowledge.length, 1, '技能应出现在 knowledge 中');
      assert.equal(prepared.knowledge[0]!.kind, 'skill');
      assert.equal(prepared.knowledge[0]!.needsStructure, true);

      assert.match(prepared.context, /已采纳技能/);
      assert.match(prepared.context, /尚未结构化/, '未结构化的技能必须明确标注，不能当作已核实方法');
      assert.equal(prepared.context.includes('\uFFFD'), false, '上下文不得含编码损坏字符');
    } finally { s.close(); }
  } finally { await cleanup(root); await cleanup(dataDir); }
});

test('宿主规范被抑制时仍参与工具拒绝判定', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'amb-gate-host-'));
  try {
    const s = new Store(join(dataDir, 'k.sqlite'));
    try {
      // A prohibition stated in a host-loaded file is real even though the text
      // is not re-injected, so the gate must still deny the named tool.
      s.import([{
        id: 'host-norm', kind: 'norm', title: '宿主规范',
        scope: { kind: 'global' }, baseRevision: 0,
        body: '禁止调用危险工具。', deniedTools: ['dangerous_tool'], hostProvided: true,
      }]);
      const gate = s.gate('', 'dangerous_tool');
      assert.equal(gate.decision, 'deny', '宿主规范里的禁止必须仍然生效');
      assert.match(gate.reason, /host-norm/);
      assert.equal(gate.context.includes('禁止调用危险工具'), false, '拒绝上下文不得重复宿主已加载的正文');
      assert.equal(s.gate('', 'safe_tool').decision, 'allow');
    } finally { s.close(); }
  } finally { await cleanup(dataDir); }
});

test('记忆与规范在上下文中分开呈现，记忆不被当作要求', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amb-mem-'));
  const dataDir = await mkdtemp(join(tmpdir(), 'amb-memdb-'));
  try {
    await writeFile(join(root, 'memory.md'), '# 记忆\n\n项目代号是翡翠。\n');
    const s = new Store(join(dataDir, 'k.sqlite'));
    try {
      const report = discover([root]);
      assert.equal(report.candidates.length, 1);
      s.adopt(report.candidates.map(candidate => ({
        source: { path: candidate.source.path, hash: candidate.source.hash },
        kind: candidate.kind, title: candidate.title,
        knowledge: {
          id: candidate.id, kind: 'memory' as const, title: candidate.title,
          scope: { kind: 'global' as const }, baseRevision: 0, body: candidate.body,
        },
      })));
      // A plugin-supplied requirement, to check it is presented as a rule.
      s.import([{
        id: 'rule-norm', kind: 'norm', title: '回答规范', scope: { kind: 'global' },
        baseRevision: 0, body: '必须使用中文回答。', deniedTools: [], hostProvided: false,
      }]);

      const prepared = s.prepare('', '翡翠');
      assert.equal(prepared.norms.length, 1, '规范与记忆必须是不同通道');
      assert.equal(prepared.norms[0]!.id, 'rule-norm');
      assert.equal(prepared.knowledge.filter(k => k.kind === 'memory').length, 1);
      assert.match(prepared.context, /背景记忆/);
      assert.match(prepared.context, /项目代号是翡翠/);
      assert.match(prepared.context, /规范 rule-norm/, '要求必须以「规范」呈现');
      assert.match(prepared.context, /背景记忆 memory:/, '事实必须以「背景记忆」呈现，不能混同为要求');
    } finally { s.close(); }
  } finally { await cleanup(root); await cleanup(dataDir); }
});
