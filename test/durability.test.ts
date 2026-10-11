import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { Store } from '../src/store.js';
import type { Knowledge, KnowledgeDraft } from '../src/schema.js';

async function scratch(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}
async function cleanup(dir: string): Promise<void> {
  const rel = relative(resolve(tmpdir()), resolve(dir));
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await rm(dir, { recursive: true, force: true });
}

const norm = (id: string, body: string, base = 0): KnowledgeDraft => ({
  id, kind: 'norm', title: `规范 ${id}`, scope: { kind: 'global' },
  baseRevision: base, body, deniedTools: [], hostProvided: false,
} as KnowledgeDraft);

// `readKnowledge` only serves skills and memories, so durable-body checks use a
// memory. The entry kind is irrelevant to what is being tested (that a rejected or
// interrupted write leaves nothing behind).
const memory = (id: string, body: string, base = 0): KnowledgeDraft => ({
  id, kind: 'memory', title: `记忆 ${id}`, scope: { kind: 'global' },
  baseRevision: base, body,
} as KnowledgeDraft);

/**
 * Durability, which the earlier audit noted had no test at all.
 *
 * The claim being checked is narrow and specific: a rejected write leaves nothing
 * behind, and a database reopened after a hard kill still reads as a consistent
 * state. Broader crash scenarios (power loss mid-fsync) cannot be staged from a
 * test and are not claimed here.
 */

test('被拒绝的写入不留下任何痕迹', async () => {
  const dir = await scratch('amb-rollback-');
  try {
    const s = new Store(join(dir, 'k.sqlite'));
    try {
      s.import([memory('a', '第一条。')]);
      const before = { revision: s.revision, entries: s.allEntries().length };

      // A conflicting write: the base revision no longer matches.
      assert.throws(() => s.import([memory('a', '基于过期版本的写入。', 0)]), /Revision changed/);

      assert.equal(s.revision, before.revision, '被拒绝的写入不得推进版本');
      assert.equal(s.allEntries().length, before.entries, '被拒绝的写入不得新增条目');
      // The stored body is still the original, not a partial write.
      assert.equal(s.readKnowledge('', 'a', false).body ?? '', '第一条。');
      // No orphan revision row.
      assert.equal(s.history('a').revisions.length, 1, '不得留下孤立的修订');
    } finally { s.close(); }
  } finally { await cleanup(dir); }
});

test('批次中途失败时整批回滚，不留半写', async () => {
  const dir = await scratch('amb-batch-rollback-');
  try {
    const s = new Store(join(dir, 'k.sqlite'));
    try {
      s.import([norm('existing', '既有条目。')]);
      const before = s.revision;

      // A batch whose second entry conflicts: nothing from the batch may persist.
      assert.throws(() => s.import([
        norm('fresh', '本该写入的新条目。'),
        norm('existing', '基于过期版本。', 0),
      ]), /Revision changed/);

      assert.equal(s.revision, before, '失败批次不得推进版本');
      assert.equal(s.allEntries().some(e => e.id === 'fresh'), false, '批次中的第一个条目也必须回滚');
    } finally { s.close(); }
  } finally { await cleanup(dir); }
});

test('进程被强制终止后数据库仍可读且一致', async () => {
  // A hard kill (SIGKILL-equivalent) while the store is open. WAL keeps a
  // committed transaction readable; whatever is recovered must still satisfy the
  // invariants, and must not report a revision it did not actually write.
  const dir = await scratch('amb-kill-');
  try {
    const db = join(dir, 'k.sqlite');
    const seed = new Store(db);
    seed.import([memory('committed', '已提交的内容。')]);
    const committedRevision = seed.revision;
    seed.close();

    // A child holds the database open with an uncommitted transaction, then dies.
    const child = spawn(process.execPath, ['-e', `
      const { Store } = require(${JSON.stringify(resolve('dist/src/store.js'))});
      const s = new Store(${JSON.stringify(db)});
      // Begin a transaction and never commit it, then exit without closing.
      s.db.exec('BEGIN IMMEDIATE');
      s.db.prepare("INSERT INTO knowledge(id,kind,head,status) VALUES('half','norm',1,'active')").run();
      process.exit(9);
    `], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    await new Promise<void>(done => child.once('close', () => done()));

    assert.equal(existsSync(db), true, '硬终止后数据库文件必须仍存在');

    const reopened = new Store(db);
    try {
      // The committed entry survives; the uncommitted one must not appear.
      assert.equal(reopened.readKnowledge('', 'committed', false).body ?? '', '已提交的内容。');
      assert.equal(reopened.allEntries().some(e => e.id === 'half'), false,
        '未提交的写入不得在重启后出现（半写必须被回滚）');
      assert.equal(reopened.revision, committedRevision, '版本必须与最后一次成功提交一致');
      // And the database is usable afterwards.
      assert.doesNotThrow(() => reopened.import([norm('after', '恢复后写入。', 0)]));
    } finally { reopened.close(); }
  } finally { await cleanup(dir); }
});
