import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Store } from '../src/store.js';
import { Knowledge, KnowledgeDraft, DomainError } from '../src/schema.js';
import { BACKUP_MARKER } from '../src/backup.js';
import {
  ARCHIVE_EXTENSION, assertSafeEntryName, defaultArchiveName,
  exportArchive, importArchive, inspectArchive,
} from '../src/archive.js';

const roots: string[] = [], stores: Store[] = [];
function root() { const path = mkdtempSync(join(tmpdir(), 'backpack-archive-')); roots.push(path); return path; }
function open() { const directory = root(), path = join(directory, 'knowledge.sqlite'); const store = new Store(path, () => 1000); stores.push(store); return { store, directory, path }; }
function memory(id = 'memory', baseRevision = 0, body = 'Personal knowledge'): KnowledgeDraft {
  return { id, baseRevision, body, kind: 'memory', title: id, scope: { kind: 'global' } };
}
/** A populated store plus a real archive of it, mirroring what a user would carry. */
function populated() {
  const source = open();
  source.store.import([memory()]);
  source.store.import([memory('memory', 1, 'Updated personal knowledge'), memory('retired')]);
  source.store.retire('retired', 1);
  // Named columns on purpose: a positional insert breaks every time a column is
  // added to the task record, which is a test failure that says nothing about the
  // behaviour under test.
  source.store.db.prepare(`INSERT INTO tasks(id,project_id,title,status,summary,notes,knowledge_revision,unfinished,created_at,updated_at,completed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run('task', 'project', 'Task', 'paused', 'Summary', 'Notes', 3, '["next step"]', 1000, 1000, null);
  source.store.db.prepare('INSERT INTO adoptions VALUES(?,?,?,?,?,?,?,?,?)').run('adoption', 'C:/notes/MEMORY.md', 'memory', 'Memory', 'hash', 'memory', 1, 1000, null);
  source.store.submit('principal', { idempotencyKey: 'proposal', projectId: 'project', discovery: 'A discovery' });
  const file = join(root(), `carry${ARCHIVE_EXTENSION}`);
  exportArchive(source.store, { file });
  return { ...source, file };
}
function snapshot(store: Store) {
  return ['knowledge', 'revisions', 'workflow_search', 'tasks', 'adoptions', 'supersessions', 'proposals', 'events', 'meta'].map(table => [table, store.db.prepare(`SELECT * FROM ${table}`).all()]);
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of roots.splice(0)) {
    const rel = relative(resolve(tmpdir()), resolve(path));
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    rmSync(path, { recursive: true, force: true });
  }
});

test('an archive round-trips every authority row, history and search index', () => {
  const source = populated(), destination = open();
  const result = importArchive(destination.store, { file: source.file });
  assert.equal(result.wrote, true);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(snapshot(destination.store), snapshot(source.store));
  assert.deepEqual(destination.store.history('memory'), source.store.history('memory'));
  assert.deepEqual(destination.store.tasks('project'), source.store.tasks('project'));
  assert.equal(destination.store.knowledge('', 'Updated').length, 1);
});

test('the archive is one ordinary gzip file carrying exactly the backup tables', () => {
  const source = populated();
  const raw = readFileSync(source.file);
  // gzip magic, so another tool can open it without this project at all.
  assert.equal(raw[0], 0x1f);
  assert.equal(raw[1], 0x8b);
  const preview = inspectArchive(source.file);
  assert.equal(preview.format, 'agent-memory-backpack-backup-v1');
  assert.equal(preview.version, 1);
  assert.ok(Number.isFinite(Date.parse(String(preview.exportedAt))));
  assert.ok(preview.entries.includes(BACKUP_MARKER));
  assert.deepEqual(preview.entries, [...preview.entries].sort());
  assert.equal(preview.counts.knowledge, (source.store.db.prepare('SELECT COUNT(*) c FROM knowledge').get() as { c: number }).c);
});

test('dry runs write nothing and truthfully predict the real result', () => {
  const source = populated(), destination = open();
  const absent = join(root(), `absent${ARCHIVE_EXTENSION}`);
  const exported = exportArchive(source.store, { file: absent, dryRun: true });
  assert.ok(exported.entries > 0);
  assert.equal(existsSync(absent), false, '干跑不得写出文件');
  const dry = importArchive(destination.store, { file: source.file, dryRun: true });
  assert.equal(dry.wrote, false);
  assert.deepEqual(snapshot(destination.store)[0], ['knowledge', []]);
  const real = importArchive(destination.store, { file: source.file });
  assert.deepEqual({ ...real, wrote: false }, dry);
});

test('a non-archive file and a non-backpack gzip are both refused', () => {
  const destination = open();
  const junk = join(root(), `junk${ARCHIVE_EXTENSION}`);
  writeFileSync(junk, 'this is not a gzip stream');
  assert.throws(() => importArchive(destination.store, { file: junk }), /not a readable backpack file/);
  // A well-formed gzip whose payload is not a backup must not be mistaken for one.
  const empty = join(root(), `empty${ARCHIVE_EXTENSION}`);
  writeFileSync(empty, gzipSync(Buffer.from('plain text, not a tar')));
  assert.throws(() => importArchive(destination.store, { file: empty }), DomainError);
  assert.deepEqual(snapshot(destination.store)[0], ['knowledge', []]);
});

test('a missing archive is reported as not found rather than as an empty import', () => {
  const destination = open();
  const missing = join(root(), `gone${ARCHIVE_EXTENSION}`);
  assert.throws(() => importArchive(destination.store, { file: missing }), /Archive not found/);
  assert.throws(() => inspectArchive(missing), /Archive not found/);
});

test('path traversal in an entry name is refused at the boundary', () => {
  for (const name of ['../escape.json', '/etc/passwd', 'a/../../b.json', 'C:/windows/system32/x', '', 'a//b.json'])
    assert.throws(() => assertSafeEntryName(name), DomainError, `应拒绝 ${JSON.stringify(name)}`);
  assert.equal(assertSafeEntryName('knowledge.json'), 'knowledge.json');
  assert.equal(assertSafeEntryName('sub/leaf.json'), 'sub/leaf.json');
});

test('a tampered archive is refused and leaves the destination untouched', () => {
  const source = populated(), destination = open();
  destination.store.import([memory('local')]);
  const before = snapshot(destination.store);
  // Flip the archive bytes: the gzip stream itself must fail integrity checking.
  const raw = readFileSync(source.file);
  const middle = Math.floor(raw.length / 2);
  raw[middle] = (raw[middle] ?? 0) ^ 0xff;
  writeFileSync(source.file, raw);
  assert.throws(() => importArchive(destination.store, { file: source.file }), DomainError);
  assert.deepEqual(snapshot(destination.store), before);
});

/**
 * Seed a body the way a library written **before ingest-time redaction** holds it.
 *
 * `store.import` now sanitises on the way in, so it cannot create the state this test is about;
 * the export guard's job is to refuse text that is *already* stored, which is a real situation
 * (the live library held 46 such hits when this was measured).
 */
function seedRaw(store: Store, draft: KnowledgeDraft, body: string) {
  store.import([draft]);
  const revision = (draft.baseRevision ?? 0) + 1;
  const row = store.db.prepare('SELECT content FROM revisions WHERE id=? AND revision=?').get(draft.id, revision) as { content: string } | undefined;
  assert.ok(row, `夹具条目 ${draft.id} 应当已写入，否则下面的注入是空操作`);
  const parsed = JSON.parse(row.content) as Record<string, unknown>;
  parsed.body = body;
  store.db.prepare('UPDATE revisions SET content=? WHERE id=? AND revision=?').run(JSON.stringify(parsed), draft.id, revision);
}

test('credential-shaped content is refused on the archive path too', () => {
  const source = open();
  seedRaw(source.store, memory('secret'), 'api_key=sk-abcdefghijklmnopqrstuvwxyz');
  const file = join(root(), `secret${ARCHIVE_EXTENSION}`);
  assert.throws(() => exportArchive(source.store, { file }), /Credential-shaped content/);
  assert.equal(existsSync(file), false, '被拒绝的导出不得留下半个文件');
});

test('repeat import is idempotent and never duplicates history or the ledgers', () => {
  const source = populated(), destination = open();
  importArchive(destination.store, { file: source.file });
  const state = snapshot(destination.store);
  const again = importArchive(destination.store, { file: source.file });
  assert.equal(again.imported, 0);
  assert.equal(again.wrote, false);
  assert.deepEqual(again.conflicts, []);
  assert.deepEqual(snapshot(destination.store), state);
});

test('newer local work survives an import and is reported, not overwritten', () => {
  const source = populated(), destination = open();
  importArchive(destination.store, { file: source.file });
  destination.store.import([memory('memory', 2, 'Newer local work'), memory('local-only')]);
  const before = snapshot(destination.store);
  const result = importArchive(destination.store, { file: source.file });
  assert.ok(result.conflicts.some(c => c.id === 'memory'), '较新的本机版本必须计入冲突');
  assert.deepEqual(snapshot(destination.store), before);
  assert.throws(() => importArchive(destination.store, { file: source.file, onConflict: 'fail' }), /Backup conflicts/);
  assert.deepEqual(snapshot(destination.store), before);
});

test('a failed import rolls back completely, leaving no partial merge', () => {
  const source = populated(), destination = open(), before = snapshot(destination.store);
  destination.store.db.exec("CREATE TRIGGER reject_task BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT, 'Injected late failure'); END");
  assert.throws(() => importArchive(destination.store, { file: source.file }), DomainError);
  assert.deepEqual(snapshot(destination.store), before);
});

test('the archive extension is enforced so a stray name cannot be mistaken for one', () => {
  const source = open();
  assert.throws(() => exportArchive(source.store, { file: join(root(), 'plain.zip') }), /must end with/);
});

test('an existing archive is not overwritten without an explicit opt-in', () => {
  const source = populated();
  // The first export already created the file; a second one to the same path is
  // the case that could destroy another device's only copy.
  assert.throws(() => exportArchive(source.store, { file: source.file }), /Refusing to overwrite/);
  const before = readFileSync(source.file);
  assert.throws(() => exportArchive(source.store, { file: source.file }), DomainError);
  assert.deepEqual(readFileSync(source.file), before, '被拒绝的导出不得改动已有归档');
  // Explicit opt-in replaces it, and the replacement is a real usable archive.
  assert.ok(exportArchive(source.store, { file: source.file, overwrite: true }).bytes > 0);
  assert.equal(inspectArchive(source.file).format, 'agent-memory-backpack-backup-v1');
});

test('the default archive name is dated and carries the expected extension', () => {
  // Built from local components, not an ISO string: the name exists so whoever exported
  // the file can tell it apart from yesterday's, and they read their own clock. With a
  // `Z` input this assertion would silently encode UTC and pass only in UTC.
  const when = new Date(2026, 9, 10, 12, 34, 56);
  const name = defaultArchiveName(when);
  assert.equal(name, 'agent-memory-backpack-20261010-123456.ambpack');
  assert.ok(name.endsWith(ARCHIVE_EXTENSION));
  // Two exports a second apart must not collide into the same default name.
  assert.notEqual(name, defaultArchiveName(new Date(2026, 9, 10, 12, 34, 57)));
});

test('an archive directory entry or link is refused instead of being extracted', () => {
  // Hand-build a tar with a directory typeflag, which the reader must reject:
  // extracting one would let an archive dictate host filesystem structure.
  const block = Buffer.alloc(512);
  Buffer.from('nested/', 'utf8').copy(block, 0);
  block.write('0000644\0', 100, 8, 'ascii');
  block.write('00000000000\0', 124, 12, 'ascii');
  block.write('00000000000\0', 136, 12, 'ascii');
  block.write('        ', 148, 8, 'ascii');
  block.write('5', 156, 1, 'ascii'); // typeflag: directory
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  let sum = 0; for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  const file = join(root(), `dir${ARCHIVE_EXTENSION}`);
  writeFileSync(file, gzipSync(Buffer.concat([block, Buffer.alloc(1024)])));
  const destination = open();
  assert.throws(() => importArchive(destination.store, { file }), /non-file entry/);
  assert.deepEqual(snapshot(destination.store)[0], ['knowledge', []]);
});

test('an archive without a manifest is refused as a foreign file', () => {
  const block = Buffer.alloc(512);
  Buffer.from('random.json', 'utf8').copy(block, 0);
  block.write('0000644\0', 100, 8, 'ascii');
  block.write('00000000002\0', 124, 12, 'ascii');
  block.write('00000000000\0', 136, 12, 'ascii');
  block.write('        ', 148, 8, 'ascii');
  block.write('0', 156, 1, 'ascii');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  let sum = 0; for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  const body = Buffer.from('{}');
  const file = join(root(), `foreign${ARCHIVE_EXTENSION}`);
  writeFileSync(file, gzipSync(Buffer.concat([block, body, Buffer.alloc(510), Buffer.alloc(1024)])));
  assert.throws(() => inspectArchive(file), /missing its manifest/);
});

test('inspect reads the archive without touching either database', () => {
  const source = populated(), destination = open();
  const before = snapshot(destination.store);
  const sourceBefore = snapshot(source.store);
  const preview = inspectArchive(source.file);
  assert.equal(preview.entries.includes(BACKUP_MARKER), true);
  assert.deepEqual(snapshot(destination.store), before);
  assert.deepEqual(snapshot(source.store), sourceBefore);
});
