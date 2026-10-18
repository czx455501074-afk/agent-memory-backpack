import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, isRetryableClientError, isExplicitClientRejection } from '../adapters/dsh/core-client.mjs';
import { loadSpool, saveSpool, spoolFilePath, SPOOL_TTL_MS } from '../adapters/dsh/spool.mjs';

/**
 * Two ways a piece of work could vanish, and the guards for both.
 *
 * 1. Rate limiting and request timeouts were classified as final decisions. 429 means "not
 *    now" and 408 means "I stopped waiting" — neither says the content was refused, but both
 *    landed in `http4xx`, so the adapter threw and the candidate went to neither the outbox
 *    nor the spool. A user's finished thought disappeared because the core was busy.
 * 2. The spool filtered expired entries out of its *return value* only. They stayed in the
 *    file, were re-filtered on every load, and were never sent again — with no log line and
 *    no counter. The file shrank only when some later save happened to run.
 */

const config = {
  endpoint: 'http://127.0.0.1:47631', token: 'x'.repeat(64), projectId: 'p0',
  autoCaptureFailures: false, autoCaptureMaterial: false, autoReflect: true,
  projectRoot: null, dataDir: tmpdir(),
};

// A body must parse: an empty one lands in the `protocol` branch (a core that answered in
// the wrong shape), which is a different outcome from "the core said 429".
const clientThatAnswers = (status) => createClient(config, async () => new Response('{"code":"test","message":"test"}', {
  status, headers: { 'content-type': 'application/json' },
}));

test('限流与超时是可重试的，不是拒绝', async () => {
  for (const status of [429, 408]) {
    const client = clientThatAnswers(status);
    await assert.rejects(
      () => client.post('/v1/stats', {}),
      (error) => {
        assert.equal(isRetryableClientError(error), true,
          `${status} 必须可重试：否则限流期间用户写完的候选既不进 outbox 也不进 spool`);
        assert.equal(isExplicitClientRejection(error), false,
          `${status} 不得被当成“核心明确拒绝”而直接抛出`);
        return true;
      },
    );
  }
});

test('真正的拒绝仍然是拒绝', async () => {
  for (const status of [400, 403, 409, 426]) {
    const client = clientThatAnswers(status);
    await assert.rejects(
      () => client.post('/v1/stats', {}),
      (error) => {
        assert.equal(isRetryableClientError(error), false,
          `${status} 是决定而非故障，排队只会重放同一结果`);
        assert.equal(isExplicitClientRejection(error), true);
        return true;
      },
    );
  }
});

test('只带状态码的旧错误也按同一规则判断', () => {
  assert.equal(isRetryableClientError({ status: 429 }), true);
  assert.equal(isRetryableClientError({ status: 408 }), true);
  assert.equal(isRetryableClientError({ status: 503 }), true);
  assert.equal(isRetryableClientError({ status: 409 }), false);
});

test('spool 丢弃过期条目时同时把它们从文件里删掉', () => {
  const dir = mkdtempSync(join(tmpdir(), 'amb-spool-prune-'));
  try {
    const now = Date.now();
    saveSpool(dir, [
      { id: 'stale', createdAt: now - SPOOL_TTL_MS - 60_000, attempts: 0 },
      { id: 'fresh', createdAt: now, attempts: 0 },
      { id: 'future', createdAt: now + 86_400_000, attempts: 0 },
    ]);

    const kept = loadSpool(dir);
    assert.deepEqual(kept.map(item => item.id), ['fresh'], '只有未过期的条目应被返回');

    const onDisk = JSON.parse(readFileSync(spoolFilePath(dir), 'utf8'));
    assert.ok(Array.isArray(onDisk.items), '文件仍应是合法 spool');
    assert.deepEqual(onDisk.items.map(item => item.id), ['fresh'],
      '过期与时钟回拨的条目必须从文件里消失，而不是只在返回值里被过滤掉');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
