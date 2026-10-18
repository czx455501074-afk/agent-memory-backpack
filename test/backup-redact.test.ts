import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { Store } from '../src/store.js';
import { exportAll, importAll, BACKUP_MARKER } from '../src/backup.js';

/**
 * Exporting a real library failed for a reason the message did not state, and once the
 * position was named, the fix had three parts that pull against each other:
 *
 *   - the strict scan has to see **every** credential-shaped value in a body, not just the
 *     first one (a body that mentions a placeholder early and a key later was cleared on the
 *     strength of the placeholder);
 *   - a library that legitimately *documents* a credential format still has to be
 *     exportable, so refusing cannot be the only outcome;
 *   - whatever the exporter writes, the importer has to accept, or a successful export is
 *     a promise the other half of the pair breaks.
 *
 * The measures below are pinned in both directions on purpose: every relaxation is paired
 * with an assertion that the refusal still happens where it should.
 *
 * **Fixtures go in through the revision row, not through `store.import`.** The write path now
 * redacts credential-shaped values on the way in, so `import` cannot produce the state these
 * tests are about — and that state is real: the live library held 46 such hits when this was
 * measured, all of them written before the rule existed.
 */

const roots: string[] = [];
const stores: Store[] = [];
function open() {
  const directory = mkdtempSync(join(tmpdir(), 'backpack-redact-'));
  roots.push(directory);
  const store = new Store(join(directory, 'knowledge.sqlite'), () => 1000);
  stores.push(store);
  return { store, directory };
}
after(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of roots.splice(0)) {
    const rel = relative(resolve(tmpdir()), resolve(path));
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Windows keeps the database handle open; a leftover temp folder is not a verdict.
    }
  }
});

function memory(id: string, body: string) {
  return { id, baseRevision: 0, kind: 'memory' as const, title: id, body, scope: { kind: 'global' as const } };
}
/**
 * Seed a body the way a library written **before ingest-time redaction** would hold it.
 *
 * The write path sanitises on the way in, so `store.import` can no longer create this state —
 * and it must not: what these tests exercise is the export guard's behaviour on text that is
 * *already* in the library. The fixture therefore goes straight into the revision row, after a
 * normal import has produced a schema-valid record to attach it to.
 */
function seedRaw(store: Store, id: string, body: string) {
  store.import([memory(id, body)]);
  const row = store.db.prepare('SELECT content FROM revisions WHERE id=? AND revision=1').get(id) as { content: string } | undefined;
  assert.ok(row, `夹具条目 ${id} 应当已写入，否则下面的注入是空操作`);
  const parsed = JSON.parse(row.content) as Record<string, unknown>;
  parsed.body = body;
  store.db.prepare('UPDATE revisions SET content=? WHERE id=? AND revision=1').run(JSON.stringify(parsed), id);
}
/** DDL copied from the import path: a fresh library has no draft table until one is used. */
function ensureDrafts(store: Store) {
  store.db.exec('CREATE TABLE IF NOT EXISTS workflow_drafts(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,skill_id TEXT NOT NULL,'
    + 'source_hash TEXT NOT NULL,state TEXT NOT NULL,result TEXT,updated_at INTEGER NOT NULL)');
}
function exportWith(store: Store, directory: string, redactCredentials = false) {
  return exportAll(store, { directory: join(directory, 'out'), redactCredentials });
}
function readJson(directory: string, table: string) {
  return JSON.parse(readFileSync(join(directory, 'out', `${table}.json`), 'utf8'));
}
function manifest(directory: string) {
  return JSON.parse(readFileSync(join(directory, 'out', BACKUP_MARKER), 'utf8'));
}
function fail(store: Store, directory: string, redactCredentials = false) {
  try {
    exportWith(store, directory, redactCredentials);
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// A body that teaches the format first and carries the real thing afterwards. The order is
// the point: the placeholder is matched first, so a scan that stops at its first hit clears
// this string while the redacting rewrite (which walks all hits) still edits it.
const TEACH_THEN_KEY = '写法是 `api_key=<key>`；而这一条是形状完整的 api_key=sk-ant-api03-A1b2C3d4E5f6G7h8I9j0';

test('the strict scan refuses on the second hit, not only the first, and says where', () => {
  const { store, directory } = open();
  seedRaw(store, 'memory:probe', TEACH_THEN_KEY);
  const message = fail(store, directory);
  assert.match(message, /Credential-shaped content refused/);
  assert.match(message, /revisions:memory:probe\.content/, '定位必须指到表与行，否则用户只能靠猜或削弱检查');
  assert.match(message, /凭据字段赋值/, '规则名要说清是哪一类形状');
  assert.ok(!message.includes('sk-ant-api03'), '报错不得回显命中的值本身');
});

test('a bare token prefix is named as such, and the value still never appears', () => {
  const { store, directory } = open();
  // No `Bearer` and no setting name in front, so the token-prefix branch is what fires -
  // and that is the branch whose strictness depends on length, which is easy to break.
  seedRaw(store, 'memory:probe', '这一串是 sk-ant-api03-Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2 的形状');
  const message = fail(store, directory);
  assert.match(message, /sk- 前缀/);
  assert.ok(!message.includes('Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2'), '报错不得回显命中的值本身');
});

test('the redacting export writes a package whose bytes do not carry the value', () => {
  const { store, directory } = open();
  seedRaw(store, 'memory:probe', TEACH_THEN_KEY);
  const result = exportWith(store, directory, true);
  const revisionText = JSON.stringify(readJson(directory, 'revisions'));
  assert.ok(revisionText.includes('REDACTED-CREDENTIAL'), '被替换的位置必须留痕，读者才知道这里曾有内容');
  assert.ok(!revisionText.includes('sk-ant-api03-A1b2C3d4E5f6G7h8I9j0'), '凭据形状的字节不得进包');
  assert.ok((result.redactions?.length ?? 0) > 0, '替换必须逐处记录（空数组会把这个断言变成空检查）');
  for (const item of result.redactions!) {
    assert.ok(item.where && item.rule, '每条替换记录都要带位置与规则');
    assert.ok(!item.where.includes('sk-ant'), '记录里不能出现值本身');
  }
  assert.ok((manifest(directory).redacted?.length ?? 0) > 0, '归档要能解释自己：位置进 manifest');
});

test('rows the redactor never had to touch keep their exact bytes', () => {
  // The control group: a library with nothing to redact must export identically in both
  // modes. Without this, "redaction works" could hide a rewrite of the whole library.
  const clean = open();
  clean.store.import([memory('memory:clean', '一段普通正文，没有任何凭据形状的内容。')]);
  exportWith(clean.store, clean.directory, true);
  const redactedBytes = readFileSync(join(clean.directory, 'out', 'revisions.json'), 'utf8');
  const after2 = mkdtempSync(join(tmpdir(), 'backpack-redact-plain-'));
  roots.push(after2);
  exportWith(clean.store, after2, false);
  const plainBytes = readFileSync(join(after2, 'out', 'revisions.json'), 'utf8');
  assert.equal(redactedBytes, plainBytes, '未命中的行必须逐字节不变');
});

test('a draft bound to a rewritten revision is left out, while one bound to untouched text travels', () => {
  // Both directions in one export: the strict path refuses a library carrying the value, so
  // there is no "without redaction" reference to compare against. The control is therefore a
  // second draft in the same package whose source the redactor never had to touch — without
  // it, "the draft is gone" would also pass if the filter dropped every draft.
  const { store, directory } = open();
  ensureDrafts(store);
  seedRaw(store, 'memory:probe', TEACH_THEN_KEY);
  store.import([memory('memory:clean', '一段干净正文')]);
  const bind = (id: string, skillId: string) => store.db.prepare(
    'INSERT INTO workflow_drafts(id,project_id,skill_id,source_hash,state,result,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(id, 'project', skillId, 'a'.repeat(64), 'needs_evidence',
      JSON.stringify({ source: { skillId, revision: 1, hash: 'a'.repeat(64) } }), 1000);
  bind('structure:on-probe', 'memory:probe');
  bind('structure:on-clean', 'memory:clean');

  const result = exportWith(store, directory, true);
  assert.deepEqual(readJson(directory, 'workflow_drafts').map((row: { id: string }) => row.id), ['structure:on-clean'],
    '来源被改写的草案不得随包；来源未动的草案必须照常随包');
  const recorded = result.skipped.filter(item => item.id === 'structure:on-probe');
  assert.equal(recorded.length, 1, '剔除必须如实记录，而不是静默少一行');
  assert.match(recorded[0]!.reason, /绑定/);
});

test('index rows the authority tables cannot justify are not carried', () => {
  const { store, directory } = open();
  store.import([memory('memory:kept', '正常条目')]);
  // A search row with no active, non-norm entry behind it: the live library had 81 of these
  // (7 norms, 74 retired entries), and the import side refuses them, so shipping them made
  // a package that could be written and never read.
  store.db.prepare("INSERT INTO workflow_search(id, terms) VALUES('norm:stale','stale terms')").run();
  const result = exportWith(store, directory);
  const carried = readJson(directory, 'workflow_search').map((row: { id: string }) => row.id);
  assert.ok(!carried.includes('norm:stale'), '没有生效条目支撑的索引行不得随包');
  assert.ok(carried.includes('memory:kept'), '有支撑的索引行必须照常随包（否则这条断言会被"全删"通过）');
  assert.ok(result.skipped.some(item => item.id === 'workflow_search'), '过滤要如实记录');
});

test('what the exporter writes, the importer accepts', () => {
  const source = open();
  ensureDrafts(source.store);
  seedRaw(source.store, 'memory:probe', TEACH_THEN_KEY);
  source.store.import([memory('memory:kept', '正常条目')]);
  source.store.db.prepare("INSERT INTO workflow_search(id, terms) VALUES('norm:stale','stale terms')").run();
  const hash = 'b'.repeat(64);
  source.store.db.prepare('INSERT INTO workflow_drafts(id,project_id,skill_id,source_hash,state,result,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run('structure:bound', 'project', 'memory:probe', hash, 'needs_evidence',
      JSON.stringify({ source: { skillId: 'memory:probe', revision: 1, hash } }), 1000);
  exportWith(source.store, source.directory, true);

  const destination = open();
  const imported = importAll(destination.store, { directory: join(source.directory, 'out'), dryRun: false });
  assert.ok(imported.imported > 0, '导入条数为零时后面的断言全是空检查，所以先断言它非空');
  const counted = destination.store.db.prepare('SELECT count(*) n FROM knowledge').get() as { n: number } | undefined;
  assert.equal(Number(counted?.n ?? -1), 2);
  assert.equal(imported.conflicts.length, 0);
});
