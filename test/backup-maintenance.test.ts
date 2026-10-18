import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { Store } from '../src/store.js';
import { initializeMaintenance } from '../src/maintenance.js';
import { exportAll, importAll, BACKUP_MARKER } from '../src/backup.js';

test('portable backup preserves model review and checkpoint receipts without reviving device jobs', () => {
  const root = mkdtempSync(join(tmpdir(), 'amb-backup-maintenance-'));
  const source = new Store(join(root, 'source.sqlite'));
  const target = new Store(join(root, 'target.sqlite'));
  try {
    const jobs = initializeMaintenance(source);
    const proposal = source.submit('codex', { projectId: 'shared', idempotencyKey: 'experience', discovery: 'Observed useful experience for review' });
    source.db.prepare('INSERT INTO model_reviews VALUES(?,?,?,?)').run(proposal.id, 'shared', JSON.stringify({ status: 'awaiting_model', analysis: null }), 1);
    const checkpointKey = `checkpoint:${'a'.repeat(64)}`;
    source.db.prepare('INSERT INTO meta VALUES(?,?)').run(checkpointKey, JSON.stringify({ stored: true, journalId: 'journal-safe' }));
    jobs.enqueue('export', 'device-export', { directory: 'C:/private-device/export', revision: 0 });
    source.db.prepare('INSERT INTO revision_notifications VALUES(?,?,?)').run(0, '{"revision":0}', 1);
    const directory = join(root, 'backup');
    const exported = exportAll(source, { directory });
    const marker = JSON.parse(readFileSync(join(directory, BACKUP_MARKER), 'utf8'));
    assert.equal(marker.counts.model_reviews, 1);
    assert.equal(marker.files['maintenance_jobs.json'], undefined);
    assert.equal(marker.files['revision_notifications.json'], undefined);
    assert.ok(exported.skipped.some(item => item.id === 'maintenance_jobs' && /Device-local/.test(item.reason)));
    // `model_reviews` now exists from the moment the store opens — it is part of the schema,
    // because `cleanup()` prunes orphaned reviews and cannot run against a table that may not
    // be there. So the assertion is about *content*, not existence: a dry run must not fill
    // it, and a real import must produce exactly the source's rows.
    const reviewCount = () => Number(target.db.prepare('SELECT count(*) AS n FROM model_reviews').get()!.n);
    assert.equal(reviewCount(), 0, '目标库打开后该表存在但为空');
    importAll(target, { directory, dryRun: true });
    assert.equal(reviewCount(), 0, 'dry run must not import rows');
    importAll(target, { directory });
    assert.deepEqual(target.db.prepare('SELECT * FROM model_reviews').all(), source.db.prepare('SELECT * FROM model_reviews').all());
    assert.deepEqual(target.db.prepare('SELECT value FROM meta WHERE key=?').get(checkpointKey), source.db.prepare('SELECT value FROM meta WHERE key=?').get(checkpointKey));
    assert.equal(target.db.prepare('SELECT count(*) AS n FROM maintenance_jobs').get()!.n, 0, 'restoration must not revive source executable jobs');
    assert.equal(importAll(target, { directory }).wrote, false, 'repeat restore stays idempotent');
  } finally {
    source.close(); target.close();
    const rel = relative(resolve(tmpdir()), resolve(root));
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    rmSync(root, { recursive: true, force: true });
  }
});
