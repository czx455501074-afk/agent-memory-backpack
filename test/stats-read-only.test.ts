import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

/**
 * Asking the library how big it is must not make it smaller.
 *
 * `stats()` used to call `cleanup()` on its first line, and both of its callers
 * (`/v1/stats` and `amb status`) are read-only by intent. Retention therefore depended on
 * somebody looking: a library nobody opened expired nothing, and one opened twenty times a
 * day expired things twenty times as often. This pins both halves — the read stays a read,
 * and the explicit call still cleans.
 */
test('stats 是只读的：查看统计不会顺带清理过期数据', () => {
  const start = 1_700_000_000_000;
  let now = start;
  const store = new Store(':memory:', () => now);
  try {
    store.event('dsh', { eventId: 'evt-aging', adapter: 'dsh', projectId: 'p', kind: 'note', summary: '内容' });
    assert.equal(store.stats().events, 1, '先确认事件确实写进去了；否则下面的断言会在空集上通过');

    now = start + 31 * 86_400_000;
    assert.equal(store.stats().events, 1,
      '只读查看不得删除过期事件——清理属于维护周期，不该由“有人看了一眼”触发');

    store.cleanup();
    assert.equal(store.stats().events, 0, '显式清理之后事件才消失');
  } finally { store.close(); }
});
