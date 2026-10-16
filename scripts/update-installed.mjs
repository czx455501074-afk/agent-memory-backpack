// Apply only package-owned, hash-verified files. Never remove a directory or copy credentials.
import { readFileSync, existsSync, realpathSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { validateDshClient } from './validate-dsh-client.mjs';
const { values } = parseArgs({ options: {
  artifact: { type: 'string' }, 'dsh-dir': { type: 'string' }, 'codex-dir': { type: 'string' },
  backup: { type: 'string' }, apply: { type: 'boolean', default: false },
} });
if (!values.artifact || (!values['dsh-dir'] && !values['codex-dir'])) throw new Error('--artifact and an installed --dsh-dir or --codex-dir are required');
const artifact = realpathSync(resolve(values.artifact));
if (values['dsh-dir']) validateDshClient(join(artifact, 'dsh-plugin'));
const manifest = JSON.parse(readFileSync(join(artifact, 'artifact-manifest.json'), 'utf8'));
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const contained = (base, file) => {
  const path = resolve(base, file), rel = relative(base, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Package path escaped its root');
  // Existing junctions must also remain within the checked installation root.
  if (existsSync(path)) {
    const realRel = relative(base, realpathSync(path));
    if (realRel.startsWith('..') || isAbsolute(realRel)) throw new Error('Package file resolves outside installation');
  }
  return path;
};
const changes = [];
for (const [name, option] of [['dsh-plugin', 'dsh-dir'], ['codex-plugin', 'codex-dir']]) {
  if (!values[option]) continue;
  const target = realpathSync(resolve(values[option]));
  const installed = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
  if (!String(installed.name).includes('agent-memory-backpack')) throw new Error('Target is not an AMB installation');
  for (const [key, expected] of Object.entries(manifest.artifactFiles)) {
    if (!key.startsWith(`${name}/`)) continue;
    const file = key.slice(name.length + 1);
    if (/(^|\/)(?:node_modules|client\.json|core\.json|model-review\.json|maintenance\.json|\.env)(\/|$)/i.test(file)) throw new Error('Refusing private or dependency file');
    const source = contained(artifact, key), dest = contained(target, file);
    if (hash(source) !== expected) throw new Error(`Artifact hash mismatch: ${file}`);
    const before = existsSync(dest) ? hash(dest) : null;
    if (before !== expected) changes.push({ name, file, source, dest, before, after: expected });
  }
}
if (!values.apply) console.log(JSON.stringify({ changes: changes.map(({ name, file }) => ({ name, file })), applied: false }));
else {
  const backup = resolve(values.backup ?? join('.local', 'installed-backups', String(Date.now())));
  mkdirSync(backup, { recursive: true });
  if (existsSync(join(backup, 'manifest.json'))) throw new Error('Backup directory already used');
  writeFileSync(join(backup, 'manifest.json'), JSON.stringify({ artifact, changes }, null, 2));
  // Complete every backup before the first mutation.
  for (const item of changes) if (item.before) {
    const saved = contained(backup, `${item.name}/${item.file}`);
    mkdirSync(dirname(saved), { recursive: true }); copyFileSync(item.dest, saved);
  }
  // Importers are copied after their helpers; app activation is a separate operation.
  changes.sort((a, b) => Number(/(?:index|hook)\.(?:js|mjs)$/.test(a.file)) - Number(/(?:index|hook)\.(?:js|mjs)$/.test(b.file)));
  for (const item of changes) {
    mkdirSync(dirname(item.dest), { recursive: true }); copyFileSync(item.source, item.dest);
    if (hash(item.dest) !== item.after) throw new Error(`Installed hash mismatch: ${item.file}`);
  }
  console.log(JSON.stringify({ changed: changes.length, backup, verified: true, hostReloaded: false }));
}
