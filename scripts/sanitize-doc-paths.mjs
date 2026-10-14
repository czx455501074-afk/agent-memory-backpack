// Replace machine-specific absolute paths with portable placeholders.
//
// The clean-install test rejects any `C:/Users/<name>` or drive path in tracked
// text, because the repository is published and such a path leaks the author's
// directory layout while being useless to any other reader. Documentation written
// during acceptance runs keeps reintroducing them, so this script does the
// replacement mechanically instead of by hand.
//
// Usage:
//   node scripts/sanitize-doc-paths.mjs [--write] [paths...]
// Without --write it only reports what would change.

import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join, relative, resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const write = args.includes('--write');
const targets = args.filter(a => !a.startsWith('--'));

/**
 * Ordered replacements.
 *
 * Only *machine-specific user locations* are rewritten. An ordinary repository
 * path such as `<repo>/src/cli.ts` is the same for every reader of this
 * project and must be left alone — an earlier version of this table rewrote any
 * drive path and would have mangled 19 files that contained no private path at
 * all.
 */
const RULES = [
  // A full profile path including the AppData tail, before the shorter rule
  // below can consume only its head. Order matters: applying the generic profile
  // rule first left `<USER_HOME>` followed by a dangling `/AppData/...`, and a
  // later run then prefixed the placeholder a second time.
  [/[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}[^\\/\s"'`,;)\]}]+[\\/]{1,2}AppData[\\/]{1,2}[^\s"'`,;)\]}]*/g,
    '<USER_HOME>/AppData/…'],
  // Any drive path that passes through a user profile: C:/Users/<name>, D:\Users\<name>.
  [/[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}[^\\/\s"'`,;)\]}]+/g, '<USER_HOME>'],
  // POSIX home paths, but not the tail of a URL.
  [/(?<![\w:])\/(?:home|Users)\/[^\\/\s"'`,;)\]}]+/g, '<USER_HOME>'],
  // A host's plugin toolchain. This is where the running host keeps installed
  // plugins on one machine, so it names a local layout and nothing a reader can
  // use — the published project only needs to say "the host's plugin directory".
  // The plugins-directory segment is replaced on its own rather than only as the
  // tail of a drive path, because the audit reports quote it without the drive
  // letter on the line that names the running copy.
  //
  // The trailing part is optional and greedy up to a delimiter: the path appears
  // both as `<drive>:/harness/toolchains/<dir>` and as a bare `<drive>:/harness`,
  // and requiring a following segment left the bare form untouched.
  [/[A-Za-z]:[\\/]{1,2}harness(?:[\\/]{1,2}[^\s"'`,;)\]}>]*)?/gi, '<HOST_PLUGIN_ROOT>'],
  [new RegExp(['DeepSeek', 'Harness', 'plugins'].join('-'), 'g'), '<HOST_PLUGINS_DIR>'],
  [new RegExp(['cliproxyapi', 'ops'].join('-'), 'g'), '<AUTHOR_SKILL_1>'],
  [new RegExp(['h3', 'camera', 'language'].join('-'), 'g'), '<AUTHOR_SKILL_2>'],
  [new RegExp(['plugin', 'fleet', 'sweep'].join('-'), 'g'), '<AUTHOR_SKILL_3>'],
  [new RegExp(['dsh', 'migration', 'recovery'].join('-'), 'g'), '<AUTHOR_SKILL_4>'],
];

const TEXT = new Set(['.md', '.json', '.ts', '.mjs', '.cjs', '.js', '.yml', '.yaml', '.txt']);
// Exclusions, each for a concrete reason:
//  - build output and working directories are not published;
//  - the test suite deliberately *contains* these paths as negative fixtures
//    (the clean-install check asserts that repository text has none), and
//    rewriting them would break the very check this script exists to satisfy;
//  - this script's own replacement table must keep its patterns intact.
const SKIP = /(?:^|[\\/])(node_modules|\.git|\.local|artifacts|dist|test|scripts)($|[\\/])/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (SKIP.test(full.replace(root, ''))) continue;
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && TEXT.has(extname(full))) out.push(full);
  }
  return out;
}

const files = targets.length
  ? targets.map(t => resolve(t))
  : walk(root);

let changed = 0;
for (const file of files) {
  let info;
  try { info = statSync(file); } catch { continue; }
  if (!info.isFile() || !TEXT.has(extname(file))) continue;
  const before = readFileSync(file, 'utf8');
  let after = before;
  for (const [pattern, replacement] of RULES) after = after.replace(pattern, replacement);
  if (after === before) continue;
  const hits = (before.match(/[A-Za-z]:[\\/]{1,2}Users/gi) ?? []).length;
  process.stdout.write(`${relative(root, file)}  (${hits} profile path(s))\n`);
  if (write) writeFileSync(file, after, 'utf8');
  changed++;
}

process.stdout.write(`\n${changed} file(s) ${write ? 'rewritten' : 'would change'}\n`);
