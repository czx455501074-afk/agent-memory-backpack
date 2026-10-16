import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { Store } from '../src/store.js';
import { discover } from '../src/discovery.js';
import type { Knowledge, KnowledgeDraft } from '../src/schema.js';

/** Adopt exactly what discovery reported, preserving body verbatim. */
function toEntries(root: string) {
  const report = discover([root]);
  return report.candidates.map(candidate => ({
    source: { path: candidate.source.path, hash: candidate.source.hash },
    kind: candidate.kind,
    title: candidate.title,
    knowledge: candidate.kind === 'skill'
      ? { id: candidate.id, kind: 'skill' as const, title: candidate.title, scope: { kind: 'global' as const }, baseRevision: 0, body: candidate.body, leaves: (candidate.leaves ?? []).map(l => ({ path: l.path, hash: l.hash, body: l.body })), needsStructure: true }
      : { id: candidate.id, kind: 'norm' as const, title: candidate.title, scope: { kind: 'global' as const }, baseRevision: 0, body: candidate.body, deniedTools: [], hostProvided: candidate.hostProvided },
  }));
}

function store(path: string): Store { return new Store(path); }

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'amb-adopt-'));
  await mkdir(join(root, 'skills', 'demo', 'references'), { recursive: true });
  await writeFile(join(root, 'AGENTS.md'), '# 工作契约\n\n默认中文；先读规范。\n');
  await writeFile(join(root, 'skills', 'demo', 'SKILL.md'), '# 演示技能\n\n## 触发\n需要演示时。\n');
  await writeFile(join(root, 'skills', 'demo', 'references', 'notes.md'), '# 参考\n\n补充细节。\n');
  await writeFile(join(root, '.env'), 'TOKEN=must-never-be-adopted\n');
  return root;
}

async function digestTree(root: string): Promise<Record<string, string>> {
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

async function cleanup(root: string): Promise<void> {
  const rel = relative(resolve(tmpdir()), resolve(root));
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await rm(root, { recursive: true, force: true });
}

test('采纳写入知识库，且不修改任何宿主源文件', async () => {
  const root = await fixture();
  const dataDir = await mkdtemp(join(tmpdir(), 'amb-adoptdb-'));
  try {
    const before = await digestTree(root);
    const s = store(join(dataDir, 'k.sqlite'));
    try {
      const result = s.adopt(toEntries(root));
      assert.equal(result.count, 2, '一个规范 + 一个技能');
      assert.ok(result.knowledgeRevision > 0);
      assert.ok(result.adoptedAt > 0);

      const entries = s.allEntries();
      assert.equal(entries.length, 2);
      const skill = entries.find(e => e.content.kind === 'skill');
      assert.ok(skill, '技能必须以 skill 类型保存');
      assert.equal((skill.content as { needsStructure: boolean }).needsStructure, true);
      assert.equal((skill.content as { leaves: unknown[] }).leaves.length, 1, '参考文档必须随技能归组');

      // Skills must not leak into workflow retrieval as if fully structured.
      assert.deepEqual(s.search('', skill.id), []);

      const ledger = s.adoptions();
      assert.equal(ledger.length, 2);
      assert.ok(ledger.every(record => record.sourcePath.startsWith(root)));
    } finally { s.close(); }

    assert.deepEqual(await digestTree(root), before, '采纳过程绝不能改动源文件');
  } finally { await cleanup(root); await cleanup(dataDir); }
});

test('一键撤销精确回滚该批次，且不触碰源文件', async () => {
  const root = await fixture();
  const dataDir = await mkdtemp(join(tmpdir(), 'amb-revoke-'));
  try {
    const before = await digestTree(root);
    const s = store(join(dataDir, 'k.sqlite'));
    try {
      const adopted = s.adopt(toEntries(root));
      assert.equal(s.allEntries().length, 2);

      const revoked = s.revokeAdoption(adopted.adoptedAt);
      assert.equal(revoked.retired.length, 2, '批次内两条都应被撤回');
      assert.equal(revoked.skipped.length, 0);
      assert.equal(s.allEntries().length, 0, '撤回后知识库回到采纳前状态');
      assert.equal(s.stats().entries, 0);

      // History is retained even though the entries are no longer active.
      const history = s.db.prepare('SELECT count(*) AS n FROM revisions').get() as { n: number };
      assert.equal(history.n, 2);

      const audit = s.adoptions(true);
      assert.ok(audit.every(record => record.revokedAt !== null), '审计记录必须标记撤回时间');

      // A second revoke of the same batch is an explicit error, not a silent no-op.
      assert.throws(() => s.revokeAdoption(adopted.adoptedAt), /No active adoption batch/);
    } finally { s.close(); }
    assert.deepEqual(await digestTree(root), before, '撤销绝不能改动源文件');
  } finally { await cleanup(root); await cleanup(dataDir); }
});

test('被用户修改过的采纳条目在撤销时保留，不被静默丢弃', async () => {
  const root = await fixture();
  const dataDir = await mkdtemp(join(tmpdir(), 'amb-revoke-edit-'));
  try {
    const s = store(join(dataDir, 'k.sqlite'));
    try {
      const adopted = s.adopt(toEntries(root));
      const target = s.allEntries().find(e => e.content.kind === 'norm')!;
      // The user edits an adopted entry after adoption.
      s.import([{ ...target.content, baseRevision: target.revision, body: '用户后来修改过的正文。' } as KnowledgeDraft]);
      assert.equal(s.allEntries().length, 2);

      const revoked = s.revokeAdoption(adopted.adoptedAt);
      assert.equal(revoked.skipped.length, 1, '被编辑的条目必须报告为跳过');
      assert.match(revoked.skipped[0]!.reason, /edited since adoption/);
      assert.equal(revoked.retired.length, 1, '未被编辑的条目才被撤回');

      const remaining = s.allEntries();
      assert.equal(remaining.length, 1);
      const survivor = remaining[0]!.content;
      assert.ok(survivor.kind === 'norm' || survivor.kind === 'memory');
      assert.equal(survivor.body, '用户后来修改过的正文。', '用户的修改必须保留');
    } finally { s.close(); }
  } finally { await cleanup(root); await cleanup(dataDir); }
});

test('重复采纳同一内容被跳过，不产生新版本也不失败整批', async () => {
  const root = await fixture();
  const dataDir = await mkdtemp(join(tmpdir(), 'amb-adopt-dup-'));
  try {
    const s = store(join(dataDir, 'k.sqlite'));
    try {
      const first = s.adopt(toEntries(root));
      assert.equal(first.count, 2);
      const revisionAfterFirst = s.revision;

      // Re-adopting identical content is a repeat: it is skipped and reported,
      // not thrown. A batch must not die on one duplicate — that was the same
      // failure mode as the oversized-document defect.
      const second = s.adopt(toEntries(root));
      assert.equal(second.count, 0, '重复内容不应再次写入');
      assert.equal(second.skipped.length, 2, '重复项必须被报告为跳过');
      assert.match(second.skipped[0]!.reason, /already active/);
      assert.equal(s.revision, revisionAfterFirst, '被跳过的重复采纳不得推进版本');
      assert.equal(s.allEntries().length, 2);
    } finally { s.close(); }
  } finally { await cleanup(root); await cleanup(dataDir); }
});

test('撤销后可以重新采纳同一来源，恢复为新的生效版本', async () => {
  // The documented flow "adopt, then revoke if you change your mind" used to end
  // in a dead end: re-adopting reported it would adopt one entry and then failed
  // with "Revision changed". A revoke is an explicit human act and re-adopting is
  // another, so restoring the entry is the intended result.
  const root = await fixture();
  const dataDir = await mkdtemp(join(tmpdir(), 'amb-adopt-restore-'));
  try {
    const s = store(join(dataDir, 'k.sqlite'));
    try {
      const first = s.adopt(toEntries(root));
      assert.equal(first.count, 2);

      const revoked = s.revokeAdoption(first.adoptedAt);
      assert.equal(revoked.retired.length, 2);
      assert.equal(s.allEntries().length, 0, '撤销后不再生效');

      // The ledger no longer holds the source, but the entries still exist.
      assert.equal(s.retiredIds().size, 2, '被撤销的条目应被识别为已退场');

      const again = s.adopt(toEntries(root));
      assert.equal(again.count, 2, '撤销后必须能够重新采纳');
      assert.equal(s.allEntries().length, 2, '重新采纳后恢复生效');
      assert.ok(again.adoptedAt !== first.adoptedAt, '两次采纳是不同的事件');

      // History is preserved rather than overwritten: the original version and
      // the restored one both remain readable.
      const history = s.history(s.allEntries()[0]!.id);
      assert.equal(history.revisions.length, 2, '原版本与恢复版本都必须保留');
    } finally { s.close(); }
  } finally { await cleanup(root); await cleanup(dataDir); }
});

test('空批次被明确拒绝，不写入任何内容', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'amb-adopt-empty-'));
  try {
    const s = store(join(dataDir, 'k.sqlite'));
    try {
      assert.throws(() => s.adopt([]), /at least one entry/);
      assert.equal(s.allEntries().length, 0);
      assert.equal(s.revision, 0);
    } finally { s.close(); }
  } finally { await cleanup(dataDir); }
});

test('CLI adopt 默认只报告不改动，--yes 才写入，且提示撤销命令', async () => {
  const root = await fixture();
  const dataDir = await mkdtemp(join(tmpdir(), 'amb-cli-adopt-'));
  try {
    const before = await digestTree(root);
    const cli = resolve('dist/src/cli.js');
    execFileSync(process.execPath, [cli, 'init', '--data-dir', dataDir, '--project', 'p0', '--project-root', root], { encoding: 'utf8' });

    // Dry run: no knowledge written.
    const dry = JSON.parse(execFileSync(process.execPath,
      [cli, 'adopt', '--data-dir', dataDir, '--roots', root], { encoding: 'utf8' }));
    assert.equal(dry.dryRun, true);
    assert.equal(dry.wouldAdopt, 2);
    assert.match(dry.note, /nothing was written/i);

    const statusAfterDry = JSON.parse(execFileSync(process.execPath,
      [cli, 'status', '--json', '--data-dir', dataDir], { encoding: 'utf8' }));
    assert.equal(statusAfterDry.entries, 0, '干跑不得写入任何条目');

    // Real adoption.
    const adopted = JSON.parse(execFileSync(process.execPath,
      [cli, 'adopt', '--data-dir', dataDir, '--roots', root, '--yes'], { encoding: 'utf8' }));
    assert.equal(adopted.adopted, 2);
    assert.match(adopted.revokeWith, /adopt --revoke \d+/);
    assert.match(adopted.note, /Source files were not modified/);

    // Revoke through the CLI using the printed command.
    const revoked = JSON.parse(execFileSync(process.execPath,
      [cli, 'adopt', '--data-dir', dataDir, '--revoke', String(adopted.adoptedAt)], { encoding: 'utf8' }));
    assert.equal(revoked.revoked.length, 2);

    const finalStatus = JSON.parse(execFileSync(process.execPath,
      [cli, 'status', '--json', '--data-dir', dataDir], { encoding: 'utf8' }));
    assert.equal(finalStatus.entries, 0, '撤销后知识库应为空');

    assert.deepEqual(await digestTree(root), before, '整个 CLI 流程不得改动源文件');
  } finally { await cleanup(root); await cleanup(dataDir); }
});
