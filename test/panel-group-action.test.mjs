import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPanelAdminParams } from '../adapters/dsh/index.mjs';

/**
 * The panel's group action must reach the core with the signature intact.
 *
 * `buildPanelAdminParams` derives fields for some actions — an approval without an entry
 * gets one fetched and derived from the candidate — and a group action must not pick any of
 * that up: it carries a signature and a decision, nothing else. This is also the only place
 * that can catch a typo in the action name, because the browser half sends a plain string
 * and the mapping table decides where it goes.
 */

const config = { projectId: 'p0', endpoint: 'http://127.0.0.1:47631', token: 'x'.repeat(64) };
const refusingAdmin = { post: async () => { throw new Error('group action must not need an extra read'); } };

test('整组动作原样透传签名与决定', async () => {
  const params = await buildPanelAdminParams('proposal-group', { signature: 'edit::cannot edit', action: 'archive' }, config, refusingAdmin);
  assert.equal(params.signature, 'edit::cannot edit');
  assert.equal(params.action, 'archive');
  assert.equal(params.projectId, 'p0', '缺少 projectId 时必须由配置补齐');
});

test('整组动作不会被采纳分支的参数派生污染', async () => {
  const params = await buildPanelAdminParams('proposal-group', { signature: 'sig', action: 'reject' }, config, refusingAdmin);
  assert.equal(params.entry, undefined, '整组动作不该去取候选、也不该派生 entry');
});

test('projectId 由调用方指定时不被覆盖', async () => {
  const params = await buildPanelAdminParams('proposal-group', { signature: 'sig', action: 'archive', projectId: 'other' }, config, refusingAdmin);
  assert.equal(params.projectId, 'other');
});
