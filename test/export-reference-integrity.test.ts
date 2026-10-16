import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { Store } from '../src/store.js';
import { exportSkills, EXPORT_MARKER } from '../src/export-skills.js';
import { knowledgeSchema } from '../src/schema.js';

function fixture(run: (store: Store, out: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'amb-reference-integrity-'));
  const store = new Store(join(root, 'knowledge.sqlite'));
  try { run(store, join(root, 'out')); }
  finally {
    store.close();
    const rel = relative(resolve(tmpdir()), resolve(root));
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    rmSync(root, { recursive: true, force: true });
  }
}
const skill = (paths: string[]) => knowledgeSchema.parse({
  id: 'reference-skill', kind: 'skill', title: '参考完整性', scope: { kind: 'global' },
  body: '---\nname: example\n---\n# Example\n[a](references/a/readme.md)\n[b](references/b/readme.md)',
  leaves: paths.map((path, index) => ({ path, hash: String(index), body: `body ${index}` })),
});

test('skill export preserves nested reference paths, links and frontmatter', () => fixture((store, out) => {
  store.import([skill(['references/a/readme.md', 'references/b/readme.md'])]);
  const result = exportSkills(store, { directory: out });
  assert.equal(result.skipped.length, 0);
  const marker = JSON.parse(readFileSync(join(out, EXPORT_MARKER), 'utf8'));
  const folder = join(out, Object.keys(marker.skills)[0]!);
  assert.equal(readFileSync(join(folder, 'references/a/readme.md'), 'utf8'), 'body 0');
  assert.equal(readFileSync(join(folder, 'references/b/readme.md'), 'utf8'), 'body 1');
  assert.ok(readFileSync(join(folder, 'SKILL.md'), 'utf8').startsWith('---\nname: example'));
  assert.match(readFileSync(join(folder, 'SKILL.md'), 'utf8'), /\[a\]\(references\/a\/readme.md\)/);
  assert.equal(exportSkills(store, { directory: out }).written.length, 0);
}));

test('adopted absolute references are relocated against the source skill directory', () => fixture((store, out) => {
  const entry = skill(['C:\\original\\example\\references\\a\\readme.md', 'C:\\original\\example\\references\\b\\readme.md']);
  store.adopt([{ source: { path: 'C:\\original\\example\\SKILL.md', hash: 'main' }, kind: 'skill', title: entry.title, knowledge: entry }]);
  const result = exportSkills(store, { directory: out });
  assert.equal(result.skipped.length, 0);
  assert.equal(result.written.length, 3);
  assert.ok(result.written.some(path => path.endsWith(join('references', 'a', 'readme.md'))));
  assert.ok(result.written.some(path => path.endsWith(join('references', 'b', 'readme.md'))));
}));

test('unsafe paths, case collisions and unknown absolute origins are explicitly skipped', () => {
  for (const paths of [['../escaped.md'], ['references/Case.md', 'references/case.md'], ['C:\\unknown\\file.md'], ['SKILL.md'], ['references/CON.md']]) {
    fixture((store, out) => {
      store.import([skill(paths)]);
      const result = exportSkills(store, { directory: out });
      assert.equal(result.skipped.length, 1, paths.join(','));
      assert.equal(result.written.length, 0);
      assert.equal(existsSync(join(out, 'escaped.md')), false);
    });
  }
});
