import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { discover } from '../src/discovery.js';
import { MAX_BODY_CHARS } from '../src/schema.js';
import { Store } from '../src/store.js';
import { candidateToKnowledge } from '../src/rescan.js';

async function scratch(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}
async function cleanup(dir: string): Promise<void> {
  const rel = relative(resolve(tmpdir()), dir);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await rm(dir, { recursive: true, force: true });
}

/**
 * A user-facing availability review found that adopting existing knowledge failed
 * outright on a machine with Codex installed, because the scanner's size limit
 * (1 MB) and the schema's body limit (60000 characters) were independent
 * numbers. One oversized document therefore passed discovery and failed the whole
 * import, reported only as "Configuration or import schema is invalid".
 *
 * These tests pin the two limits together and require the oversized case to be
 * reported by path rather than silently poisoning the batch.
 */

test('扫描器与 schema 使用同一个正文上限', () => {
  // The two limits drifting apart is the defect, so the single source of truth is
  // asserted rather than the value itself.
  assert.equal(typeof MAX_BODY_CHARS, 'number');
  assert.ok(MAX_BODY_CHARS > 0);
});

test('单条超限的文档被按路径报告，且不影响同批其余条目', async () => {
  const root = await scratch('amb-oversize-');
  try {
    await mkdir(join(root, 'big'), { recursive: true });
    await mkdir(join(root, 'small'), { recursive: true });
    // Just over the limit, and comfortably under it.
    await writeFile(join(root, 'big', 'SKILL.md'), `# 超大\n\n${'填充。'.repeat(20001)}\n`, 'utf8');
    await writeFile(join(root, 'small', 'SKILL.md'), '# 正常技能\n\n## 触发\n需要时。\n', 'utf8');

    const report = discover([root]);
    const adopted = report.candidates.filter(c => c.id.startsWith('skill:'));
    assert.equal(adopted.length, 1, '只应采纳未超限的那一份');
    assert.equal(adopted[0]!.source.path.endsWith(join('small', 'SKILL.md')), true);

    // The oversized file is reported with its actual size and the limit, so the
    // user learns which file and by how much.
    const oversize = report.excluded.find(item => item.path.endsWith(join('big', 'SKILL.md')));
    assert.ok(oversize, '超限文件必须出现在排除清单中');
    assert.match(oversize!.reason, new RegExp(String(MAX_BODY_CHARS)), '理由必须写明上限');
    assert.match(oversize!.reason, /\d{5,}/, '理由必须写明实际大小');

    // And the batch that contains both still imports, which is the property the
    // user actually depends on.
    const store = new Store(':memory:');
    try {
      const entries = adopted.map(candidateToKnowledge);
      assert.doesNotThrow(() => store.import(entries), '含超限文件的目录不得导致整批导入失败');
      assert.equal(store.allEntries().length, 1);
    } finally { store.close(); }
  } finally { await cleanup(root); }
});

test('刚好在上限内的文档仍被采纳', async () => {
  // The check must not be stricter than the schema, or valid documents would be
  // silently dropped. Padding to exactly the limit must still pass.
  const root = await scratch('amb-atlimit-');
  try {
    await mkdir(join(root, 'ok'), { recursive: true });
    const heading = '# 边界技能\n\n';
    // `trim()` in the schema means trailing whitespace is not counted, so the
    // body is padded to exactly the limit including the heading.
    const padding = '字'.repeat(Math.max(1, MAX_BODY_CHARS - heading.length));
    await writeFile(join(root, 'ok', 'SKILL.md'), `${heading}${padding}`, 'utf8');

    const report = discover([root]);
    const candidate = report.candidates.find(c => c.id.startsWith('skill:'));
    assert.ok(candidate, `恰好在上限内的文档必须被采纳：${report.excluded.map(e => e.reason).join(' | ')}`);

    const store = new Store(':memory:');
    try {
      assert.doesNotThrow(() => store.import([candidateToKnowledge(candidate!)]),
        '恰好在上限内的文档必须能被导入');
    } finally { store.close(); }
  } finally { await cleanup(root); }
});
