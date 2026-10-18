import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadClientConfig } from '../adapters/dsh/core-client.mjs';

/**
 * An absent capture setting must mean "do not capture".
 *
 * The parser answered `raw.autoCaptureFailures !== false`, so leaving the field out
 * produced `true`, while every consumer checks `=== true`. The parser won, and an
 * unconfigured install captured every tool failure and every fetched page — measured in one
 * log window: 252 `experience.captured` events, 167 of them duplicates (66%), pending
 * candidates growing ~214/day.
 *
 * A hook triggered by an exit code cannot judge whether a failure taught anything, so the
 * default has to be off. These cases pin the default and both explicit values, because the
 * bug was precisely a disagreement between "not configured" and "configured to false".
 */

const TOKEN = 'x'.repeat(64);

function fixture(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'amb-defaults-'));
  const file = join(dir, 'client.json');
  writeFileSync(file, JSON.stringify({
    endpoint: 'http://127.0.0.1:47631',
    token: TOKEN,
    projectId: 'p0',
    ...extra,
  }));
  return { dir, file };
}

const load = async (file) => loadClientConfig({ AMB_DSH_CONFIG: file });

test('未配置采集开关时两个写库开关关闭，反思提示保持开启', async t => {
  const { dir, file } = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = await load(file);
  assert.equal(config.autoCaptureFailures, false, '未配置不得等于开启：钩子无法判断失败是否值得沉淀');
  assert.equal(config.autoCaptureMaterial, false, '未配置不得等于开启');
  // Reflection writes nothing; it asks the agent for one prompt per turn. Keeping it on is
  // a weaker default than capture, and turning it off by accident showed up as a real
  // failure in dsh-runtime.test.mjs ("business tools trigger at most one reflection").
  assert.equal(config.autoReflect, true, '反思提示不写库，未配置时应保持开启');
});

test('显式 false 与显式 true 都被如实保留', async t => {
  const off = fixture({ autoCaptureFailures: false, autoCaptureMaterial: false, autoReflect: false });
  const on = fixture({ autoCaptureFailures: true, autoCaptureMaterial: true, autoReflect: true });
  t.after(() => {
    rmSync(off.dir, { recursive: true, force: true });
    rmSync(on.dir, { recursive: true, force: true });
  });
  const disabled = await load(off.file);
  assert.deepEqual(
    [disabled.autoCaptureFailures, disabled.autoCaptureMaterial, disabled.autoReflect],
    [false, false, false],
  );
  const enabled = await load(on.file);
  assert.deepEqual(
    [enabled.autoCaptureFailures, enabled.autoCaptureMaterial, enabled.autoReflect],
    [true, true, true],
  );
});

test('非布尔值被拒绝，而不是被当成开启', async t => {
  const { dir, file } = fixture({ autoCaptureFailures: 'yes' });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(() => load(file), /autoCaptureFailures must be a boolean/,
    '字符串既不是 true 也不是 false，静默当成任何一种都会让配置说谎');
});
