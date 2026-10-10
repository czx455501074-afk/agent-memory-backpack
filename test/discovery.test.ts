import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { discover, exclusionReason, diff, summarize, defaultScanRoots, type AdoptedCandidate } from '../src/discovery.js';

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'amb-discover-'));
  await mkdir(join(root, 'skills', 'demo'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(root, 'AGENTS.md'), '# 工作契约\n\n默认中文，先读规范。\n');
  await writeFile(join(root, 'memory.md'), '# 记忆\n\n项目根在 <PROJECT_ROOT>。\n');
  await writeFile(join(root, 'skills', 'demo', 'SKILL.md'), '# 演示技能\n\n## 触发\n需要演示时。\n');
  await writeFile(join(root, 'skills', 'demo', 'readme.md'), '# 技能说明\n\n参考示例。\n');
  // Must be excluded: host behaviour, secrets, executables, runtime state
  await writeFile(join(root, 'package.json'), '{"name":"x","dsh":{"client":{"platform":"web"}}}');
  await writeFile(join(root, 'plugin.json'), '{"id":"x"}');
  await writeFile(join(root, 'cordis.patch.yml'), '- insert:\n    - id: x\n');
  await writeFile(join(root, '.env'), 'TOKEN=secret-value-never-adopt\n');
  await writeFile(join(root, 'hook.mjs'), 'export function apply() {}\n');
  await writeFile(join(root, 'config.toml'), '[plugins]\nenabled = true\n');
  await writeFile(join(root, 'notes.txt'), 'plain note, not a knowledge doc\n');
  await writeFile(join(root, 'node_modules', 'pkg', 'AGENTS.md'), '# 应当被 node_modules 规则排除\n');
  return root;
}

async function cleanup(root: string): Promise<void> {
  const rel = relative(resolve(tmpdir()), resolve(root));
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await rm(root, { recursive: true, force: true });
}

test('扫描只读：不修改任何宿主文件，且报告 wrote=false', async () => {
  const root = await fixture();
  try {
    const before = await snapshot(root);
    const report = discover([join(root, 'AGENTS.md'), join(root, 'skills'), join(root, '.env'), join(root, 'package.json'), join(root, 'hook.mjs')]);
    const after = await snapshot(root);

    assert.equal(report.wrote, false);
    assert.deepEqual(after, before, '扫描前后宿主机文件签名必须一致');
    assert.ok(report.inspected >= 1);
  } finally { await cleanup(root); }
});

async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    const { readdir } = await import('node:fs/promises');
    for (const name of (await readdir(dir)).sort()) {
      const full = join(dir, name);
      const info = await stat(full);
      if (info.isDirectory()) await walk(full);
      else out[relative(root, full)] = createHash('sha256').update(await readFile(full)).digest('hex');
    }
  };
  await walk(root);
  return out;
}

test('采纳知识文档，排除宿主配置、凭据、可执行逻辑与运行时目录', async () => {
  const root = await fixture();
  try {
    const report = discover([join(root, 'AGENTS.md'), join(root, 'skills'), join(root, 'memory.md')]);
    const kinds = report.candidates.map(c => c.kind).sort();
    // AGENTS.md=norm, memory.md=memory, skills/demo/SKILL.md=skill
    assert.deepEqual(kinds, ['memory', 'norm', 'skill'], JSON.stringify(report.candidates, null, 2));

    const titles = report.candidates.map(c => c.title).sort();
    assert.deepEqual(titles, ['演示技能', '记忆', '工作契约'].sort(), '标题应取自文档首个 Markdown 标题');
    assert.ok(report.candidates.every(c => c.source.hash.length === 64 && c.source.bytes > 0));
    assert.ok(report.candidates.every(c => c.id.includes(':')));
    assert.ok(report.excluded.every(item => item.reason.length > 5));
    assert.equal(summarize(report).includes('wrote=false'), true);
  } finally { await cleanup(root); }
});

test('技能叶子随入口归组，不作为孤立片段采纳', async () => {
  const root = await fixture();
  try {
    await mkdir(join(root, 'skills', 'grouped', 'references', 'leaves'), { recursive: true });
    await writeFile(join(root, 'skills', 'grouped', 'SKILL.md'), '# 分组技能\n\n## 触发\n需要分组时。\n');
    await writeFile(join(root, 'skills', 'grouped', 'references', 'notes.md'), '# 参考\n\n补充说明。\n');
    await writeFile(join(root, 'skills', 'grouped', 'references', 'leaves', 'L01.md'), '# 叶子一\n\n细节步骤。\n');

    const report = discover([join(root, 'skills', 'grouped')]);
    assert.equal(report.candidates.length, 1, '一个技能目录应只产生一个条目');
    const entry = report.candidates[0]!;
    assert.equal(entry.kind, 'skill');
    assert.equal(entry.leaves?.length, 2, '参考与叶子文档必须随入口归组');
    assert.ok(entry.leaves!.every(leaf => leaf.hash.length === 64 && leaf.bytes > 0));
    assert.match(summarize(report), /leaves=2/);
    // Leaves must not appear as standalone candidates.
    assert.equal(report.candidates.some(c => /notes\.md|L01\.md/.test(c.source.path)), false);
  } finally { await cleanup(root); }
});

test('技能目录外的孤立 Markdown 不被当作完整方法采纳', async () => {
  const root = await fixture();
  try {
    await mkdir(join(root, 'loose'), { recursive: true });
    await writeFile(join(root, 'loose', 'idea.md'), '# 孤立想法\n\n没有触发条件与完整步骤。\n');

    const report = discover([join(root, 'loose')]);
    assert.equal(report.candidates.length, 0, '孤立片段不得成为候选');
    assert.ok(report.excluded.some(item => /outside a skill entry/.test(item.reason)));
  } finally { await cleanup(root); }
});

test('排除清单覆盖凭据、宿主清单与可执行文件，且理由是机器可读的', async () => {
  const root = await fixture();
  try {
    const cases: Array<[string, RegExp]> = [
      ['package.json', /manifest/],
      ['plugin.json', /manifest/],
      ['cordis.patch.yml', /manifest/],
      ['.env', /credential/],
      ['hook.mjs', /executable|configuration/],
      ['config.toml', /configuration/],
    ];
    for (const [name, pattern] of cases) {
      const reason = exclusionReason(join(root, name), name);
      assert.ok(reason, `${name} 必须被排除`);
      assert.match(reason, pattern, `${name} 的排除理由不明确: ${reason}`);
    }
    // Adoptable documents must not be excluded by the path rules.
    assert.equal(exclusionReason(join(root, 'AGENTS.md'), 'AGENTS.md'), undefined);
    assert.equal(exclusionReason(join(root, 'skills', 'demo', 'SKILL.md'), 'SKILL.md'), undefined);

    // A non-markdown file is excluded during the scan, with a reason.
    const report = discover([join(root, 'notes.txt')]);
    assert.equal(report.candidates.length, 0);
    assert.equal(report.excluded[0]?.reason.startsWith('not a recognised knowledge document'), true);
  } finally { await cleanup(root); }
});

test('node_modules 与符号链接不被跟随', async () => {
  const root = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'amb-outside-'));
  try {
    await writeFile(join(outside, 'AGENTS.md'), '# 项目外内容，不得被采纳\n');
    await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');

    const report = discover([root]);
    assert.equal(report.candidates.some(c => c.source.path.includes('escape')), false, '符号链接目录不得被跟随');
    assert.equal(report.candidates.some(c => c.source.path.includes('node_modules')), false, 'node_modules 不得被采纳');
    assert.ok(report.excluded.some(item => /symbolic link/.test(item.reason)));
    assert.ok(report.excluded.some(item => /node_modules/.test(item.path) || /node_modules/.test(item.reason)));
  } finally { await cleanup(root); await cleanup(outside); }
});

test('重复内容只报一次；相同标题不同内容标记为冲突而非自动解决', async () => {
  const root = await fixture();
  try {
    await mkdir(join(root, 'second'), { recursive: true });
    await writeFile(join(root, 'second', 'AGENTS.md'), await readFile(join(root, 'AGENTS.md')));

    const report = discover([join(root, 'AGENTS.md'), join(root, 'second', 'AGENTS.md')]);
    assert.equal(report.candidates.length, 1, '相同内容只产生一个候选');
    assert.ok(report.excluded.some(item => /same content/.test(item.reason)));

    const sameTitleDifferentBody: AdoptedCandidate = {
      id: 'norm:deadbeefdeadbeef', kind: 'norm' as const, title: report.candidates[0]!.title,
      source: { path: '/other/AGENTS.md', hash: 'b'.repeat(64), bytes: 10 }, rationale: 'x',
      body: '# 不同正文\n\n与库内条目同名但内容不同。\n', hostProvided: true,
    };
    const compared = diff([sameTitleDifferentBody], [{ id: 'norm:0000000000000000', title: report.candidates[0]!.title }]);
    assert.equal(compared[0]!.change, 'conflict', '标题相同内容不同必须报冲突');

    const identical = diff([report.candidates[0]!], [{ id: report.candidates[0]!.id, title: report.candidates[0]!.title }]);
    assert.equal(identical[0]!.change, 'duplicate', '同 ID 必须报重复');

    const fresh: typeof report.candidates = [{ ...report.candidates[0]!, id: 'norm:ffffffffffffffff', title: '全新标题' }];
    assert.equal(diff(fresh, [])[0]!.change, 'new');
  } finally { await cleanup(root); }
});

test('默认扫描根只返回存在的路径，不虚构主机位置', () => {
  const roots = defaultScanRoots();
  assert.ok(Array.isArray(roots));
  assert.ok(roots.every(root => !/^[A-Za-z]:\\Users\\[^\\]+\\$/.test(root)), '不得只返回裸主目录');
  // Absent locations must not appear.
  assert.equal(roots.includes(join('nonexistent-home', '.dsh', 'AGENTS.md')), false);
});
