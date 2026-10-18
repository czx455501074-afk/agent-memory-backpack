/**
 * Why does the same event key carry "different content"?
 *
 * Every abandoned delivery in the real library says so, and the answer decides the fix:
 * if the payloads differ in a field the adapter adds per attempt, the key is wrong; if they
 * differ in a field the core recomputes, replay must send what the core stored. This prints
 * only field names and short value summaries — never the bodies — so it can be read in a
 * report without leaking a session.
 *
 * Usage: node verification/r6/idem-conflict-diff.mjs [--source <db>] [--limit 3]
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const value = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const limit = Number(value('--limit') ?? 3);
const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
const source = resolve(value('--source') ?? join(home, '.agent-memory-backpack', 'knowledge.sqlite'));
if (!existsSync(source)) throw new Error(`找不到要测量的库：${source}`);
const work = mkdtempSync(join(tmpdir(), 'amb-idem-'));
const copy = join(work, 'knowledge.sqlite');

const brief = (input) => {
  if (input === undefined) return '(missing)';
  if (input === null) return 'null';
  if (typeof input === 'string') return `string(${input.length})`;
  if (typeof input === 'number' || typeof input === 'boolean') return String(input);
  if (Array.isArray(input)) return `array(${input.length})`;
  return `object{${Object.keys(input).join(',')}}`;
};

try {
  const live = new DatabaseSync(source, { readOnly: true });
  live.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
  live.close();
  const db = new DatabaseSync(copy, { readOnly: true });

  const rows = db.prepare(`SELECT principal, idem, payload, last_error FROM outbox
      WHERE status='abandoned' AND kind='event' LIMIT ?`).all(limit);
  if (rows.length === 0) throw new Error('没有可对照的 abandoned 事件');

  let checked = 0;
  let reconstructed = 0;
  for (const row of rows) {
    let queued;
    try { queued = JSON.parse(String(row.payload)); } catch { continue; }
    const stored = db.prepare('SELECT payload FROM events WHERE principal=? AND event_id=?')
      .get(row.principal, queued.eventId);
    if (!stored) { console.log(`- ${queued.eventId}: 库内无同键事件（不是内容冲突）`); continue; }
    let here;
    try { here = JSON.parse(String(stored.payload)); } catch { continue; }
    checked += 1;
    const keys = [...new Set([...Object.keys(queued), ...Object.keys(here)])].sort();
    const differing = keys.filter(key => JSON.stringify(queued[key]) !== JSON.stringify(here[key]));
    console.log(`\n## ${queued.eventId}（键 ${keys.length} 个，差异 ${differing.length} 个）`);
    for (const key of differing) console.log(`- ${key}: 队列 ${brief(queued[key])} ≠ 库内 ${brief(here[key])}`);
    if (differing.length === 0) {
      // Same content but the core still refused: then the fingerprint the core compares
      // cannot be a hash of this payload, and that is a different bug.
      reconstructed += 1;
      console.log('- 两份内容逐字段相同：冲突不是内容造成的');
    }
  }
  console.log(`\n结论：对照 ${checked} 条，内容确实不同 ${checked - reconstructed} 条，内容相同却被拒 ${reconstructed} 条`);
  db.close();
} finally {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { rmSync(work, { recursive: true, force: true, maxRetries: 3 }); break; }
    catch { await new Promise(done => setTimeout(done, 200)); }
  }
}
