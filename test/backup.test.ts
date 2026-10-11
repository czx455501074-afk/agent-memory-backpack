import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.js';
import { Knowledge, KnowledgeDraft, DomainError } from '../src/schema.js';
import { exportAll, importAll, BACKUP_MARKER } from '../src/backup.js';

const roots: string[] = [], stores: Store[] = [];
function root() { const path = mkdtempSync(join(tmpdir(), 'backpack-backup-')); roots.push(path); return path; }
function open() { const directory = root(), path = join(directory, 'knowledge.sqlite'); const store = new Store(path, () => 1000); stores.push(store); return { store, directory, path }; }
function memory(id = 'memory', baseRevision = 0, body = 'Personal knowledge'): KnowledgeDraft {
  return { id, baseRevision, body, kind: 'memory', title: id, scope: { kind: 'global' } };
}
function populated() {
  const source = open();
  source.store.import([memory()]);
  source.store.import([memory('memory', 1, 'Updated personal knowledge'), memory('retired')]);
  source.store.retire('retired', 1);
  // Named columns, so adding a column to the task record does not break this test.
  source.store.db.prepare(`INSERT INTO tasks(id,project_id,title,status,summary,notes,knowledge_revision,unfinished,created_at,updated_at,completed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run('task', 'project', 'Task', 'paused', 'Summary', 'Notes', 3, '["next step"]', 1000, 1000, null);
  source.store.db.prepare('INSERT INTO adoptions VALUES(?,?,?,?,?,?,?,?,?)').run('adoption', 'C:/notes/MEMORY.md', 'memory', 'Memory', 'hash', 'memory', 1, 1000, null);
  source.store.db.prepare('INSERT INTO supersessions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(1, 'retired', 1, 'memory', 2, 'supplement', 'Reason', 'Evidence', 'user', 0, 1000);
  source.store.submit('principal', { idempotencyKey: 'proposal', projectId: 'project', discovery: 'A discovery' });
  source.store.event('principal', { eventId: 'event', adapter: 'codex', projectId: 'project', kind: 'note', summary: 'Event' });
  source.store.db.prepare("UPDATE meta SET value=? WHERE key='scanRoots'").run('["C:/notes"]');
  const directory = join(root(), 'portable');
  exportAll(source.store, { directory });
  return { ...source, backup: directory };
}
function snapshot(store: Store) {
  return ['knowledge', 'revisions', 'workflow_search', 'tasks', 'adoptions', 'supersessions', 'proposals', 'events', 'meta'].map(table => [table, store.db.prepare(`SELECT * FROM ${table}`).all()]);
}
function bytes(directory: string) { return Object.fromEntries(readdirSync(directory).map(name => [name, readFileSync(join(directory, name)).toString('hex')])); }
function rehash(directory: string, table: string, value: unknown) {
  const text = JSON.stringify(value), name = `${table}.json`;
  writeFileSync(join(directory, name), text);
  const path = join(directory, BACKUP_MARKER), manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.files[name] = createHash('sha256').update(text).digest('hex');
  manifest.counts[table] = (value as unknown[]).length;
  writeFileSync(path, JSON.stringify(manifest));
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of roots.splice(0)) {
    const rel = relative(resolve(tmpdir()), resolve(path));
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    rmSync(path, { recursive: true, force: true });
  }
});

test('full round-trip preserves all authority rows, history, retired heads and search', () => {
  const source = populated(), destination = open();
  const result = importAll(destination.store, { directory: source.backup });
  assert.equal(result.imported, 2); assert.equal(result.wrote, true); assert.deepEqual(result.conflicts, []);
  assert.deepEqual(snapshot(destination.store), snapshot(source.store));
  assert.deepEqual(destination.store.history('memory'), source.store.history('memory'));
  assert.deepEqual(destination.store.tasks('project'), source.store.tasks('project'));
  assert.deepEqual(destination.store.supersessions(), source.store.supersessions());
  assert.equal(destination.store.knowledge('', 'Updated').length, 1);
});
test('dry runs write nothing and predict the real import', () => {
  const source = populated(), destination = open(), directory = join(root(), 'absent');
  const beforeSource = bytes(source.directory), beforeDestination = bytes(destination.directory);
  const exported = exportAll(source.store, { directory, dryRun: true });
  assert.ok(exported.written.length); assert.equal(existsSync(directory), false);
  const dry = importAll(destination.store, { directory: source.backup, dryRun: true });
  assert.equal(dry.wrote, false); assert.equal(dry.imported, 2);
  assert.deepEqual(bytes(source.directory), beforeSource); assert.deepEqual(bytes(destination.directory), beforeDestination);
  const real = importAll(destination.store, { directory: source.backup });
  assert.deepEqual({ ...real, wrote: false }, dry);
});
test('credential-shaped files including nested files are refused', () => {
  const source = populated(), destination = open();
  mkdirSync(join(source.backup, 'nested'));
  writeFileSync(join(source.backup, 'nested', 'codex-client.json'), '{}');
  assert.throws(() => importAll(destination.store, { directory: source.backup }), /Credential-shaped file refused/);
  assert.throws(() => exportAll(source.store, { directory: source.backup }), /Credential-shaped file refused/);
});
test('credential-shaped stored content is refused before export or import', () => {
  const source = open(), directory = join(root(), 'absent');
  source.store.import([memory('secret', 0, 'api_key=sk-abcdefghijklmnopqrstuvwxyz')]);
  assert.throws(() => exportAll(source.store, { directory }), /Credential-shaped content/);
  assert.equal(existsSync(directory), false);
  const clean = populated(), destination = open();
  const rows = JSON.parse(readFileSync(join(clean.backup, 'events.json'), 'utf8'));
  rows[0].payload = '{"token":"secret"}'; rehash(clean.backup, 'events', rows);
  assert.throws(() => importAll(destination.store, { directory: clean.backup }), /Credential-shaped/);
});
test('tampered, missing and mismatched files leave database bytes identical', () => {
  const source = populated(), destination = open();
  destination.store.import([memory('local')]);
  const before = bytes(destination.directory), path = join(source.backup, 'tasks.json'), original = readFileSync(path);
  writeFileSync(path, '[]');
  assert.throws(() => importAll(destination.store, { directory: source.backup }), /hash mismatch/);
  assert.deepEqual(bytes(destination.directory), before);
  rmSync(path);
  assert.throws(() => importAll(destination.store, { directory: source.backup }), /Cannot read backup/);
  assert.deepEqual(bytes(destination.directory), before);
  writeFileSync(path, original);
  const marker = join(source.backup, BACKUP_MARKER), manifest = JSON.parse(readFileSync(marker, 'utf8'));
  manifest.version = 99; writeFileSync(marker, JSON.stringify(manifest));
  assert.throws(() => importAll(destination.store, { directory: source.backup }), /version mismatch/);
  assert.deepEqual(bytes(destination.directory), before);
});
test('newer local revision and local-only entries survive; fail mode is atomic', () => {
  const source = populated(), destination = open();
  importAll(destination.store, { directory: source.backup });
  destination.store.import([memory('memory', 2, 'Newer local work'), memory('local-only')]);
  const before = snapshot(destination.store);
  const result = importAll(destination.store, { directory: source.backup });
  assert.ok(result.conflicts.some(c => c.id === 'memory'));
  assert.deepEqual(snapshot(destination.store), before);
  assert.throws(() => importAll(destination.store, { directory: source.backup, onConflict: 'fail' }), /Backup conflicts/);
  assert.deepEqual(snapshot(destination.store), before);
});
test('repeat import is idempotent and does not duplicate history or ledgers', () => {
  const source = populated(), destination = open();
  importAll(destination.store, { directory: source.backup });
  const state = snapshot(destination.store);
  const result = importAll(destination.store, { directory: source.backup });
  assert.equal(result.imported, 0); assert.equal(result.wrote, false); assert.deepEqual(result.conflicts, []);
  assert.deepEqual(snapshot(destination.store), state);
});
test('unrelated existing directory without the marker is refused', () => {
  const source = open(), directory = root(); writeFileSync(join(directory, 'notes.json'), '{}');
  const before = bytes(directory);
  assert.throws(() => exportAll(source.store, { directory }), /Cannot read backup/);
  assert.throws(() => importAll(source.store, { directory }), /Cannot read backup/);
  assert.deepEqual(bytes(directory), before);
});
test('a late SQL failure rolls the entire import back', () => {
  const source = populated(), destination = open(), before = snapshot(destination.store);
  destination.store.db.exec("CREATE TRIGGER reject_task BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT, 'Injected late failure'); END");
  assert.throws(() => importAll(destination.store, { directory: source.backup }), DomainError);
  assert.deepEqual(snapshot(destination.store), before);
});
test('older matching local history advances without deleting revisions', () => {
  const source = populated(), destination = open(); destination.store.import([memory()]);
  const result = importAll(destination.store, { directory: source.backup });
  assert.ok(result.conflicts.every(c => c.id.startsWith('meta:')));
  assert.equal(destination.store.history('memory').revisions.length, 2);
});
test('equal-number divergent history is preserved and reported', () => {
  const source = populated(), destination = open();
  destination.store.import([memory('memory', 0, 'Independent local branch')]);
  destination.store.import([memory('memory', 1, 'Independent second revision')]);
  const before = destination.store.history('memory');
  const result = importAll(destination.store, { directory: source.backup });
  assert.ok(result.conflicts.some(c => c.id === 'memory'));
  assert.deepEqual(destination.store.history('memory'), before);
});
test('supersession integer-id collisions merge without duplicate ledgers', () => {
  const source = populated(), destination = open();
  destination.store.db.prepare('INSERT INTO supersessions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(1, 'local-old', 1, 'local-new', 1, 'supplement', 'Local reason', 'Local evidence', 'user', 0, 1000);
  importAll(destination.store, { directory: source.backup });
  const before = destination.store.supersessions();
  assert.equal(before.length, 2);
  importAll(destination.store, { directory: source.backup });
  assert.deepEqual(destination.store.supersessions(), before);
});
test('malformed rows are refused in dry run as well as real import', () => {
  const source = populated(), destination = open(), before = bytes(destination.directory);
  const rows = JSON.parse(readFileSync(join(source.backup, 'tasks.json'), 'utf8'));
  rows[0].status = 'invalid'; rehash(source.backup, 'tasks', rows);
  assert.throws(() => importAll(destination.store, { directory: source.backup, dryRun: true }), /Invalid task status/);
  assert.throws(() => importAll(destination.store, { directory: source.backup }), /Invalid task status/);
  assert.deepEqual(snapshot(destination.store)[0], ['knowledge', []]);
  assert.equal(bytes(destination.directory)['knowledge.sqlite'], before['knowledge.sqlite']);
});
