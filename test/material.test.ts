import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { MATERIAL_TTL_DAYS, expiryFrom, isLive, normalizeUrl, fingerprintOf } from '../src/material.js';

/**
 * Temporary material and its two-layer expiry.
 *
 * The design makes short-lived material the one knowledge type that is supposed to
 * disappear, and requires two independent mechanisms: retrieval must exclude
 * lapsed items even before any cleanup has run, and a persistent job must then
 * reclaim the space. Testing only the second would miss the case that actually
 * protects a reader — a core that has been idle long enough for the purge to fall
 * behind, still answering from an expired page.
 *
 * Time is injected throughout, so a ninety-day behaviour is asserted in
 * milliseconds rather than simulated by waiting.
 */

const DAY = 86_400_000;

/** A store whose clock the test controls. */
function storeAt(clock: { now: number }) {
  return new Store(':memory:', () => clock.now);
}

function save(s: Store, id: string, url: string, summary = '页面摘要', body = '正文') {
  return s.saveMaterial({ id, title: `资料 ${id}`, url, summary, body, provenance: 'external' });
}

test('保存的资料在有效期内可检索，到期后立刻消失', () => {
  const clock = { now: 1_000_000 };
  const s = storeAt(clock);
  try {
    save(s, 'm1', 'https://example.com/a');
    assert.equal(s.liveMaterial().length, 1, '刚保存的资料应可见');

    // Just before expiry: still live.
    clock.now += MATERIAL_TTL_DAYS * DAY - 1000;
    assert.equal(s.liveMaterial().length, 1, '到期前应仍可见');

    // Past expiry, and crucially *before* any cleanup runs.
    clock.now += 2000;
    assert.equal(s.liveMaterial().length, 0,
      '到期后即使清理任务尚未运行，也不得被检索到（第一层）');
    // The row still exists, which is what makes the two layers distinguishable.
    assert.equal(s.materialStats().expired, 1, '到期条目在清理前应仍存在，只是不可检索');
  } finally { s.close(); }
});

test('清理任务删除到期资料，并使它彻底不可检索', () => {
  const clock = { now: 1_000_000 };
  const s = storeAt(clock);
  try {
    save(s, 'm1', 'https://example.com/a');
    save(s, 'm2', 'https://example.com/b');

    // Expire only the first.
    clock.now += MATERIAL_TTL_DAYS * DAY + 1;
    s.db.prepare("UPDATE meta SET value=value").run();
    const fresh = save(s, 'm3', 'https://example.com/c');
    assert.ok(fresh.expiresAt > clock.now, '新资料应在未来到期');

    const purged = s.purgeExpiredMaterial();
    assert.deepEqual(purged.purged.sort(), ['m1', 'm2'], '到期资料应被清理');
    assert.deepEqual(purged.failed, [], '正常情况下不应有失败项');
    assert.equal(s.materialStats().total, 1, '只有未到期的资料留下');
    assert.equal(s.liveMaterial()[0]!.id, 'm3');
  } finally { s.close(); }
});

test('清理失败可重试，且失败项被明确报出而不是静默吞掉', () => {
  const clock = { now: 1_000_000 };
  const s = storeAt(clock);
  try {
    save(s, 'm1', 'https://example.com/a');
    clock.now += MATERIAL_TTL_DAYS * DAY + 1;

    // A trigger that rejects the retirement makes one item fail.
    s.db.exec("CREATE TRIGGER block_retire BEFORE UPDATE ON knowledge WHEN NEW.status='retired' BEGIN SELECT RAISE(ABORT, 'injected'); END");
    const first = s.purgeExpiredMaterial();
    assert.equal(first.purged.length, 0, '全部失败时不应报告已清理');
    assert.equal(first.failed.length, 1, '失败项必须被报出');
    assert.equal(first.failed[0]!.id, 'm1', '失败项应点名到具体条目');

    // Removing the obstruction lets a retry succeed — the design requires retry.
    s.db.exec('DROP TRIGGER block_retire');
    const second = s.purgeExpiredMaterial();
    assert.deepEqual(second.purged, ['m1'], '重试应当成功');
    assert.deepEqual(second.failed, []);
  } finally { s.close(); }
});

test('普通读取不续期；只有明确续期才延长，且必须给理由', () => {
  const clock = { now: 1_000_000 };
  const s = storeAt(clock);
  try {
    const saved = save(s, 'm1', 'https://example.com/a');
    const original = saved.expiresAt;

    // Reading, repeatedly, must not move the date.
    for (let i = 0; i < 5; i += 1) { clock.now += DAY; s.liveMaterial(); }
    assert.equal(s.liveMaterial()[0]!.expiresAt, original, '普通读取不得延长到期时间');

    // Renewal without a reason is refused.
    assert.throws(() => s.renewMaterial('m1', '   '), /reason/i, '续期必须给理由');

    const renewed = s.renewMaterial('m1', '这份资料下个季度还要用');
    assert.ok(renewed.expiresAt > clock.now, '明确续期后应仍在有效期内');
    assert.match(renewed.renewalReason, /下个季度/, '续期理由被记录');
  } finally { s.close(); }
});

test('同一页面重复保存被识别，且不延长原有时限', () => {
  const clock = { now: 1_000_000 };
  const s = storeAt(clock);
  try {
    const first = save(s, 'm1', 'https://example.com/a');
    clock.now += 10 * DAY;
    const again = save(s, 'm2', 'https://example.com/a');
    assert.equal(again.duplicate, true, '同一页面应被识别为重复');
    assert.equal(again.id, first.id, '应指向既有条目');
    assert.equal(again.expiresAt, first.expiresAt,
      '重复保存不是保留决定，不得延长原有时限');
    assert.equal(s.materialStats().live, 1, '不应产生第二条记录');
  } finally { s.close(); }
});

test('URL 规范化只去掉不影响内容的部分', () => {
  // A fragment never reaches the server, so two links differing there are one page.
  assert.equal(normalizeUrl('https://a.com/x#top'), normalizeUrl('https://a.com/x'));
  assert.equal(normalizeUrl('https://a.com'), 'https://a.com/');

  // Query parameters are kept: many sites put the page identity in them, and
  // treating two different pages as one is worse than storing a duplicate.
  assert.notEqual(normalizeUrl('https://a.com/x?v=1'), normalizeUrl('https://a.com/x?v=2'));
  assert.notEqual(normalizeUrl('https://a.com/x?id=7'), normalizeUrl('https://a.com/x'));

  // The fingerprint follows the same rule.
  assert.equal(fingerprintOf('https://a.com/x#a', '摘要'), fingerprintOf('https://a.com/x#b', '摘要'));
  assert.notEqual(fingerprintOf('https://a.com/x', '摘要一'), fingerprintOf('https://a.com/x', '摘要二'));
});

test('到期时间随保存时间固定，不随保留期调整而回溯改变', () => {
  const savedAt = 1_700_000_000_000;
  const expires = expiryFrom(savedAt);
  assert.equal(expires, savedAt + MATERIAL_TTL_DAYS * DAY, '默认 90 天');
  assert.equal(isLive(expires, expires - 1), true, '到期前一毫秒仍有效');
  assert.equal(isLive(expires, expires), false, '到期时刻即失效');

  // Stored, so a different retention passed at save time is what governs.
  assert.equal(expiryFrom(savedAt, 7), savedAt + 7 * DAY, '可按条目指定不同期限');
});
