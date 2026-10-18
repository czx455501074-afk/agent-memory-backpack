import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { Store } from '../src/store.js';

/**
 * Retrieved library content is wrapped as **data**, and the norms deliberately are not.
 *
 * A memory that records a rule is written like a rule ("必须先用 X 重试"), so a model handed a
 * block of retrieved text with no boundary reads it as something to obey — the same failure
 * class as a prompt-injection payload arriving through a search result. The wrapper is cheap.
 *
 * The interesting half is what stays *outside* it: a norm is an instruction, and the gate exists
 * to decide which norms apply. Wrapping them in "this is only data" would quietly undo the one
 * thing this project is built around, so that direction is pinned too — and so is the empty
 * case, because a wrapper emitted around nothing teaches the reader to ignore the marker.
 */

const roots: string[] = [];
const stores: Store[] = [];
function open() {
  const directory = mkdtempSync(join(tmpdir(), 'backpack-data-boundary-'));
  roots.push(directory);
  const store = new Store(join(directory, 'knowledge.sqlite'), () => 1000);
  stores.push(store);
  return store;
}
after(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of roots.splice(0)) {
    const rel = relative(resolve(tmpdir()), resolve(path));
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Windows keeps the handle open; leftover temp is not the verdict.
    }
  }
});

const OPEN = '<memory-data>';
const CLOSE = '</memory-data>';

test('retrieved library content travels inside the data boundary, with a statement of what it is', () => {
  const store = open();
  store.import([{
    id: 'memory:boundary', baseRevision: 0, kind: 'memory', title: '托盘图标',
    body: '托盘图标丢失时，先重启 explorer 而不是重装。', scope: { kind: 'global' },
  }]);
  // `selectionSource: 'model'` mirrors the production path: the model chose this entry, so the
  // local-evidence floor does not apply — without it the entry would be filtered out and the
  // assertions below would run against an empty block.
  const prepared = store.prepare('p0-workflow', '托盘图标', { selectedIds: ['memory:boundary'], selectionSource: 'model' });
  const context = String(prepared.context);
  assert.ok(context.includes(OPEN), '库内容必须落在数据边界内');
  assert.ok(context.includes(CLOSE), '边界必须有结束标记，否则后面的一切都被读成数据');
  const inner = context.slice(context.indexOf(OPEN), context.indexOf(CLOSE));
  assert.ok(inner.includes('memory:boundary'), '被检索到的条目应当就在边界内（否则这条断言是空检查）');
  assert.ok(inner.includes('数据'), '边界内要有一句说明它是什么');
});

test('the norms and the version line stay outside the data boundary', () => {
  const store = open();
  store.import([{
    id: 'memory:boundary', baseRevision: 0, kind: 'memory', title: '托盘图标',
    body: '托盘图标丢失时，先重启 explorer。', scope: { kind: 'global' },
  }]);
  const prepared = store.prepare('p0-workflow', '托盘图标', { selectedIds: ['memory:boundary'], selectionSource: 'model' });
  const context = String(prepared.context);
  const inner = context.slice(context.indexOf(OPEN), context.indexOf(CLOSE));
  assert.ok(!inner.includes('当前知识版本'), '版本行是元信息，不能被标成"只是数据"');
  // A norm is an instruction: if one were inside the wrapper, the gate's whole point ("this rule
  // applies to you") would be contradicted by the marker around it.
  assert.ok(!inner.includes('规范 '), '规范属于指令，必须在边界之外');
});

test('nothing is wrapped when there is no library content to wrap', () => {
  // The counter-direction. A wrapper emitted around an empty block teaches the reader that the
  // marker means nothing, which is worse than not having it.
  const store = open();
  const prepared = store.prepare('empty-project', '一个这个库里完全没有的主题');
  assert.ok(!String(prepared.context).includes(OPEN), '没有内容时不得出现空的数据边界');
});
