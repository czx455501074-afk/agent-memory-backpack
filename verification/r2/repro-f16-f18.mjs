/**
 * Reproduce the store-side defects this round fixes, against a compiled build.
 *
 * Usage: node verification/r2/repro-f16-f18.mjs <buildDir>
 *
 * Isolation: in-memory SQLite only, synthetic principals, no host contact.
 *
 * Each check prints BEFORE/AFTER-agnostic facts; run it once on the pre-fix
 * build to capture the failure and once on the post-fix build to show it is gone.
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const buildDir = process.argv[2] ?? '.r2-build';
const { Store } = await import(pathToFileURL(resolve(buildDir, 'src/store.js')).href);

const out = [];
const record = (id, requirement, detail) => out.push({ id, requirement, detail });

function workflow(id, projectId, overrides = {}) {
  return {
    id, kind: 'workflow', title: `${id} title`, scope: { kind: 'project', projectId },
    baseRevision: 0, overview: 'overview text', triggers: ['trigger'],
    categories: [['cat']], preconditions: ['precondition'],
    stages: [{ id: 'stage-1', title: 'stage one', instructions: 'do the thing', checks: ['checked'], dependencies: [] }],
    completion: ['complete'], recovery: 'recovery text', ...overrides,
  };
}

// ── F16 store side: a same-key retry must not be hidden by a moved base ───────
{
  const store = new Store(':memory:');
  store.import([workflow('alpha-flow', 'alpha')]);
  const payload = {
    idempotencyKey: 'retry-after-move', projectId: 'alpha',
    workflowId: 'alpha-flow', baseRevision: 1, discovery: '回执与重试都不该被前面的校验挡住。',
  };
  const first = store.submit('dsh', payload);

  // The workflow moves on while the candidate waits: this is exactly the state
  // that used to make a legitimate retry look like a stale-base write.
  store.import([workflow('alpha-flow', 'alpha', { baseRevision: 1, title: 'moved on' })]);

  let retry;
  try {
    retry = store.submit('dsh', payload);
  } catch (error) {
    retry = `THREW ${error.code} ${error.status} ${error.message}`;
  }
  const stillThere = store.listProposals('alpha', 'pending').length;
  record('F16-store', '同 principal 同幂等键的重试必须先返回既有收据，不得被 workflow/baseRevision 校验遮挡（F16）',
    `首提=${JSON.stringify(first)}；重试=${JSON.stringify(retry)}；pending 数=${stillThere}`);

  // A same-key submission with different content is still an idempotency conflict.
  let conflict;
  try {
    conflict = store.submit('dsh', { ...payload, discovery: '不同内容' });
  } catch (error) {
    conflict = `THREW ${error.code} ${error.status}`;
  }
  record('F16-store-conflict', '同 key 不同 payload 仍必须 409（幂等冲突而非重试）',
    `结果=${JSON.stringify(conflict)}`);
  store.close();
}

// ── F18: stage attribution fields, validation and visibility ─────────────────
{
  const store = new Store(':memory:');
  store.import([workflow('flow-a', 'alpha')]);

  let unknownStage;
  try {
    unknownStage = store.submit('dsh', {
      idempotencyKey: 'bad-stage', projectId: 'alpha', workflowId: 'flow-a', stageId: 'nope',
      discovery: '归属到不存在的步骤应明确失败。',
    });
  } catch (error) {
    unknownStage = `THREW ${error.code} ${error.status}`;
  }
  record('F18-validation', '给 workflowId 时 stageId 必须是该 workflow 的真实 stage（F18）',
    `未知 stage 结果=${JSON.stringify(unknownStage)}`);

  const good = store.submit('dsh', {
    idempotencyKey: 'good-stage', projectId: 'alpha', workflowId: 'flow-a', stageId: 'stage-1',
    discovery: '归属到真实步骤的候选。',
  });
  const listed = store.listProposals('alpha', 'pending').find(p => p.id === good.id);
  record('F18-visibility', '候选列表/详情能看出归属哪个流程的哪一步（F18）',
    `列表项 attribution=${JSON.stringify(listed?.attribution ?? null)}`);
  store.close();
}

// ── F17: persistent outbox ──────────────────────────────────────────────────
{
  const store = new Store(':memory:');
  const hasOutbox = typeof store.enqueue === 'function';
  record('F17-store', '存在可持久化的 outbox 服务端入口与查询（F17）',
    `store.enqueue=${hasOutbox}`);
  if (hasOutbox) {
    const enqueued = store.enqueue('dsh', {
      kind: 'candidate', projectId: 'alpha', idempotencyKey: 'cand-1',
      payload: { idempotencyKey: 'cand-1', projectId: 'alpha', discovery: '离线时候的候选。' },
      error: 'fetch failed',
    });
    store.enqueue('dsh', {
      kind: 'event', projectId: 'alpha', idempotencyKey: 'evt-1',
      payload: { eventId: 'evt-1', adapter: 'dsh', projectId: 'alpha', kind: 'turn_stopped', summary: 's' },
    });
    const status = store.outboxStatus('alpha');
    record('F17-status', 'outbox 状态可查询（待发条数、失败原因、尝试次数）（F17）',
      `enqueued=${JSON.stringify(enqueued)} status=${JSON.stringify(status)}`);
  }
  store.close();
}

for (const r of out) process.stdout.write(`${r.id}: ${r.detail}\n  <- ${r.requirement}\n`);
process.stdout.write(`\n${out.length} probes\n`);
