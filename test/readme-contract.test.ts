import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Documentation contracts.
 *
 * A usability review run as a first-time user found the README written in a
 * contributor's voice for a user's problem: no install entry point, examples that
 * wrote to a different database than the one the reader had just started, and a
 * command shown as runnable that could not work. These tests pin the properties
 * that make the document followable, so a later edit cannot quietly undo them.
 */

async function readme() {
  return await readFile(resolve(repoRoot, 'README.md'), 'utf8');
}

/** CLI invocations inside fenced code blocks, which is what a reader copies. */
function fencedCommands(text: string): Array<{ command: string; line: string }> {
  const found: Array<{ command: string; line: string }> = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (!inFence) continue;
    const match = /node dist\/src\/cli\.js\s+([a-z-]+)/.exec(line);
    if (match?.[1]) found.push({ command: match[1], line: line.trim() });
  }
  return found;
}

test('README 的每个 CLI 示例都是真实存在的命令', async () => {
  const text = await readme();
  const commands = fencedCommands(text);
  assert.ok(commands.length >= 10, `README 应含可执行示例，实际 ${commands.length} 条`);

  // Cross-check against the CLI's own usage text rather than a hand-kept list.
  const { execFileSync } = await import('node:child_process');
  const usage = execFileSync(process.execPath, [resolve(repoRoot, 'dist/src/cli.js'), '--help'], { encoding: 'utf8' });
  const unknown = commands.filter(entry => !new RegExp(`\\b${entry.command}\\b`).test(usage));
  assert.deepEqual(unknown.map(u => u.command), [], `README 引用了 CLI 不支持的命令：${unknown.map(u => u.command).join(', ')}`);
});

test('README 中会写库的示例都指定了 --data-dir', async () => {
  // Without it the reader silently creates a second database: the core they just
  // started stays empty and the numbers do not match, with no warning anywhere.
  // `backup`/`restore` belong here for the same reason as the rest: without
  // --data-dir they open whatever `defaultDataDir()` resolves to, which is not
  // necessarily the library the reader just started the core against.
  const writing = new Set(['adopt', 'rescan', 'supersede', 'structure', 'seed', 'retire', 'serve', 'backup', 'restore']);
  const offenders = fencedCommands(await readme())
    .filter(entry => writing.has(entry.command) && !/--data-dir/.test(entry.line))
    .map(entry => entry.line);
  assert.deepEqual([...new Set(offenders)], [],
    '这些写库示例缺少 --data-dir，会让读者写到另一个库');
});

test('README 回答了首次使用必须知道的四件事', async () => {
  const text = await readme();
  // 1. What it is and whether the reader can use it, before any detail.
  const intro = text.slice(0, Math.max(text.indexOf('## 已实现'), text.indexOf('## 快速开始')));
  assert.match(intro, /这是什么|给谁用/, '开头必须说明这是什么、给谁用');
  assert.match(intro, /P0 原型|桌面端.*仍需人工/, '开头必须给出诚实的当前状态结论');

  // 2. An install path with the required build step. P0 now ships install scripts.
  assert.match(text, /## 快速开始|## 面向使用者/, '必须有面向使用者的安装段落');
  assert.match(text, /npm run build/, '必须说明构建步骤');
  assert.match(text, /install:local|npm run install/, '必须说明安装脚本入口');

  // 3. How to tell it is working, and what to do when it is not.
  assert.match(text, /## 出问题怎么办/, '必须有排错段落');
  assert.match(text, /doctor/, '排错段落必须提到自检命令');

  // 4. The three questions a careful user asks.
  assert.match(text, /## 隐私与信任/, '必须有隐私与信任段落');
  assert.match(text, /127\.0\.0\.1/, '必须说明只连本地');
  assert.match(text, /卸载/, '必须说明如何卸载');
});

test('README 不声称已实现未落地的功能', async () => {
  // P0 原型已交付，但桌面集成仍需人工确认。README 必须诚实说明当前状态。
  const text = await readme();
  const intro = text.slice(0, Math.max(text.indexOf('## 快速开始'), text.indexOf('## 面向使用者')));
  assert.match(intro, /P0 原型|桌面端加载与信任.*仍需人工|手动完成/, 
    '开头必须说明桌面集成仍需人工步骤，不能声称全自动');
  
  // 数据迁移（.ambpack）已实现，不能再列为未落地
  assert.match(text, /数据迁移|\.ambpack|backup.*file|restore.*file/, 
    'README 必须说明已实现的数据迁移功能');
});
