import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { skillSchema } from '../src/schema.js';
import { createMaintenanceWorker } from '../src/maintenance.js';
import { enqueueWorkflowDraft } from '../src/workflow-organization.js';
import { workflowSourceHash } from '../src/workflow-draft.js';

/**
 * Production-sized population of pending skills.
 *
 * The reported freeze came from a library with 149 such skills: every tick
 * decoded the whole table once to iterate them and once more per skill to
 * resolve the source of the draft it queued.
 */
const SKILL_COUNT = 120;
const PROJECT = 'p0';

/** Count real `scopedEntries` calls, which is what a full table decode costs. */
function scopedEntryCounter(store: Store) {
  const original = store.scopedEntries.bind(store);
  const state = { calls: 0 };
  Object.defineProperty(store, 'scopedEntries', {
    configurable: true,
    writable: true,
    value: (projectId: string) => { state.calls += 1; return original(projectId); },
  });
  return state;
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'amb-maintenance-'));
  const store = new Store(join(dir, 'knowledge.sqlite'));
  store.import(Array.from({ length: SKILL_COUNT }, (_, index) => skillSchema.parse({
    id: `skill-${index}`, kind: 'skill', title: `Skill ${index}`,
    scope: { kind: 'project', projectId: PROJECT },
    baseRevision: 0, body: `# Skill ${index}\n\nStep: run check ${index}.`,
  })));
  return { store, dir };
}

test('one maintenance tick decodes the scoped table once instead of once per pending skill', async () => {
  const f = fixture();
  try {
    const worker = createMaintenanceWorker(f.store, f.dir, [PROJECT]);
    await worker.tick();
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS total FROM workflow_drafts').get()!.total, SKILL_COUNT,
      '一次 tick 必须为每个 needsStructure skill 入队一个 draft');

    // Freeze the queue so the measured tick isolates the enqueue phase. What is
    // left of `jobs.run` is bounded by its own claim limit, not by skill count.
    f.store.db.prepare("UPDATE maintenance_jobs SET status='completed',lease_until=0").run();

    const measured = scopedEntryCounter(f.store);
    await worker.tick();
    const fixedCalls = measured.calls;

    // Control: the exact pre-fix loop, which re-asked the store for the source
    // of every skill it had just decoded.
    measured.calls = 0;
    for (const entry of f.store.scopedEntries(PROJECT))
      if (entry.content.kind === 'skill' && entry.content.needsStructure) enqueueWorkflowDraft(f.store, PROJECT, entry.id);
    const legacyCalls = measured.calls;

    assert.ok(fixedCalls <= 3, `tick 的 scopedEntries 调用必须是常数级，实测 ${fixedCalls}`);
    assert.ok(legacyCalls >= SKILL_COUNT, `修复前每条 pending skill 回查一次全表，实测 ${legacyCalls}`);
    assert.ok(fixedCalls * 10 < legacyCalls, `修复后必须低一个量级，实测 ${fixedCalls} vs ${legacyCalls}`);

    // Behaviour is unchanged: every pending skill still has a draft bound to its
    // current source, and the result does not depend on the new argument.
    let enqueued = 0;
    for (const entry of f.store.scopedEntries(PROJECT)) {
      if (entry.content.kind !== 'skill' || !entry.content.needsStructure) continue;
      const expectedHash = workflowSourceHash({ skillId: entry.id, skillRevision: entry.revision, skill: entry.content });
      const withEntry = enqueueWorkflowDraft(f.store, PROJECT, entry.id, false, entry);
      const withoutEntry = enqueueWorkflowDraft(f.store, PROJECT, entry.id);
      assert.equal(withEntry.id, `structure:${PROJECT}:${expectedHash}`);
      assert.equal(withoutEntry.id, withEntry.id, '传 entry 与不传 entry 必须得到同一 draft id');
      const stored = f.store.db.prepare('SELECT source_hash FROM workflow_drafts WHERE id=?').get(withEntry.id) as { source_hash: string };
      assert.equal(stored.source_hash, expectedHash, '传 entry 与不传 entry 必须绑定同一 source hash');
      enqueued += 1;
    }
    assert.equal(enqueued, SKILL_COUNT, 'tick 必须为每个 needsStructure=true 的 skill 入队 draft');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS total FROM workflow_drafts').get()!.total, SKILL_COUNT,
      '不得产生多余 draft');
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
