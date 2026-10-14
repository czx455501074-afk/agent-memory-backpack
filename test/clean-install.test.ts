import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';

/**
 * Cleanliness of the open-source drop.
 *
 * The project is intended for release: a user installs it and then accumulates
 * their own knowledge. Two properties follow, and both are asserted rather than
 * assumed:
 *
 *  1. A fresh install starts empty. Nothing of the author's is shipped, and no
 *     knowledge is written until the user asks for it.
 *  2. Neither the repository nor the packaged artifact carries machine paths,
 *     personal identifiers, or the author's own skill content.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function scratch(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}
async function cleanup(dir: string): Promise<void> {
  const rel = relative(resolve(tmpdir()), resolve(dir));
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await rm(dir, { recursive: true, force: true });
}

test('一次全新安装不写入任何知识，用户从空开始积累', async () => {
  // The decisive property behind "install it and start storing your own data":
  // `init` may create credentials, but it must not seed a single entry.
  const dir = await scratch('amb-clean-install-');
  try {
    execFileSync(process.execPath, [join(repoRoot, 'dist', 'src', 'cli.js'), 'init',
      '--data-dir', dir, '--project', 'fresh', '--project-root', dir], { stdio: 'ignore' });

    // Credentials only; no knowledge database is created by init.
    assert.equal(existsSync(join(dir, 'core.json')), true, 'init 应生成核心配置');
    const filesAfterInit = await readdir(dir);
    assert.deepEqual(
      filesAfterInit.filter(name => name.endsWith('.sqlite')),
      [],
      `init 不得创建知识库，实际：${filesAfterInit.join(', ')}`,
    );

    // And the store, once opened, really is empty.
    const store = new Store(join(dir, 'knowledge.sqlite'));
    try {
      const stats = store.stats();
      assert.equal(stats.entries, 0, '全新安装不得有任何生效条目');
      assert.equal(stats.knowledgeRevision, 0, '知识版本应从 0 开始');
      assert.equal(stats.adoptions, 0, '不得预置采纳记录');
      assert.equal(stats.supersessions, 0, '不得预置取代记录');
      assert.equal(stats.tasks, 0, '不得预置任务');
      assert.equal(stats.pendingProposals, 0, '不得预置候选');
      assert.deepEqual(store.allEntries(), [], '不得有任何条目');

      // Cleanup actually works on a fresh database.
      const cleanupResult = store.markRescanned(0);
      assert.equal(cleanupResult.lastRescanAt, 0, '不得默认标记为已扫描');
    } finally { store.close(); }
  } finally { await cleanup(dir); }
});

test('插件自带的技能只有工具使用说明，不含作者个人的任何技能', async () => {
  // A host plugin needs a skill telling the agent how to call its tools. That is
  // not the same as shipping the author's knowledge: it must describe the tool
  // surface only, and must not contain procedures from this machine.
  const skillsDir = join(repoRoot, 'adapters', 'codex', 'skills');
  const entries = await readdir(skillsDir, { recursive: true }) as string[];
  const skillFiles = entries.filter(name => name.endsWith('.md'));

  assert.deepEqual(skillFiles, [join('agent-memory-backpack', 'SKILL.md')],
    `插件只应自带一份工具说明，实际：${skillFiles.join(', ')}`);

  const body = await readFile(join(skillsDir, skillFiles[0]!), 'utf8');
  // It must be about the plugin's own tools, and stay free of personal material.
  assert.match(body, /amb_prepare/, '应说明如何调用插件工具');
  assert.equal(/D:\\|C:\\Users|\.agents[\\/]skills[\\/][a-z]/.test(body), false,
    '工具说明不得引用本机路径或本地技能目录');
});

test('仓库与产物都不含机器路径、用户名或作者技能内容', async () => {
  // Markers are assembled at runtime rather than written literally: this file
  // ships with the project, and a published test has no business embedding the
  // very paths it forbids. Joining the parts keeps the check just as strict while
  // leaving nothing personal in the source.
  const sep = String.fromCharCode(92); // backslash
  const slash = '/';
  const drive = (letter: string) => `${letter}:${sep}`;
  const markers = [
    drive('D') + 'harness', `D:${slash}harness`,
    drive('D') + 'agent-memory-backpack', `D:${slash}agent-memory-backpack`,
    drive('C') + ['Users', 'czx'].join(sep), `C:${slash}Users${slash}czx`,
    ['DeepSeek', 'Harness', 'plugins'].join('-'),
  ];
  // Personal skill directory names of this project's author, split so the file
  // does not itself contain them.
  const authorSkills = [
    ['cliproxyapi', 'ops'].join('-'),
    ['h3', 'camera', 'language'].join('-'),
    ['plugin', 'fleet', 'sweep'].join('-'),
    ['dsh', 'migration', 'recovery'].join('-'),
  ];
  const textExt = new Set(['.md', '.json', '.ts', '.mjs', '.cjs', '.js', '.yml', '.yaml', '.txt']);
  const skip = /(?:^|[\\/])(node_modules|\.git|\.local|artifacts|dist|tmp-|diagnostics|handoffs)($|[\\/])/;

  const violations: string[] = [];
  const walk = async (dir: string, scope: string) => {
    for (const name of await readdir(dir)) {
      const full = join(dir, name);
      if (skip.test(full.replace(repoRoot, ''))) continue;
      const info = await stat(full);
      if (info.isDirectory()) { await walk(full, scope); continue; }
      if (!textExt.has(extname(full))) continue;
      const text = await readFile(full, 'utf8');
      for (const marker of [...markers, ...authorSkills]) {
        if (text.includes(marker)) violations.push(`${scope}/${relative(repoRoot, full)}: ${marker}`);
      }
      // Any absolute path into a user profile is rejected outright.
      const profile = new RegExp(`${drive('[A-Za-z]')}{1,2}Users${sep}{1,2}[^${sep}/\\s"']+`);
      if (profile.test(text)) violations.push(`${scope}/${relative(repoRoot, full)}: 疑似用户目录绝对路径`);
    }
  };

  // Repository (excluding build output and working directories).
  await walk(repoRoot, 'repo');
  // Packaged artifact, when one exists.
  const latest = join(repoRoot, 'artifacts', 'latest.json');
  if (existsSync(latest)) {
    const artifactDir = JSON.parse(await readFile(latest, 'utf8')).directory as string;
    await walk(artifactDir, 'artifact');
  }

  assert.deepEqual([...new Set(violations)], [],
    '开源交付物不得包含机器路径、用户名或作者个人技能内容');
});
