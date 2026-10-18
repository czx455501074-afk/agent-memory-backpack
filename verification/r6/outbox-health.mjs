/**
 * Why did 1,170 outbound deliveries get abandoned, and is anything still recoverable?
 *
 * The outbox is the automation's lifeline: a candidate or an event that could not be
 * delivered is retried until its deadline. On the real library nearly half of all
 * deliveries end as `abandoned`, and no surface shows that number — so this reads the
 * shared library through a read-only snapshot and reports the composition, not the prose.
 *
 * What the numbers decide:
 *   - a single dominant error means one bug, not a flaky network;
 *   - attempts at the redelivery ceiling means the retry policy gave up rather than the
 *     content being wrong;
 *   - a payload still present means `abandoned` is a label, not a deletion, so recovery is
 *     possible without inventing data.
 *
 * Usage: node verification/r6/outbox-health.mjs [--source <db>]
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const value = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
const source = resolve(value('--source') ?? join(home, '.agent-memory-backpack', 'knowledge.sqlite'));
if (!existsSync(source)) throw new Error(`找不到要测量的库：${source}`);
const work = mkdtempSync(join(tmpdir(), 'amb-outbox-'));
const copy = join(work, 'knowledge.sqlite');

try {
  const live = new DatabaseSync(source, { readOnly: true });
  live.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
  live.close();
  const db = new DatabaseSync(copy, { readOnly: true });
  const all = (sql, params = []) => db.prepare(sql).all(...params);

  const totals = all('SELECT status, count(*) AS n FROM outbox GROUP BY status ORDER BY n DESC');
  const sum = totals.reduce((acc, row) => acc + Number(row.n), 0);
  console.log(`# outbox 共 ${sum} 条`);
  for (const row of totals) console.log(`- ${row.status}: ${row.n}（${(Number(row.n) / sum * 100).toFixed(1)}%）`);

  console.log('\n## 按类型 × 状态');
  for (const row of all('SELECT kind, status, count(*) AS n FROM outbox GROUP BY kind, status ORDER BY n DESC')) {
    console.log(`- ${row.kind} / ${row.status}: ${row.n}`);
  }

  console.log('\n## 被放弃的投递：错误分布（前 8）');
  for (const row of all(`SELECT substr(last_error, 1, 70) AS error, count(*) AS n
      FROM outbox WHERE status='abandoned' GROUP BY error ORDER BY n DESC LIMIT 8`)) {
    console.log(`- ${row.n}｜${row.error || '(空)'}`);
  }

  console.log('\n## 重试次数分布');
  for (const row of all("SELECT attempts, count(*) AS n FROM outbox WHERE status='abandoned' GROUP BY attempts ORDER BY attempts")) {
    console.log(`- attempts=${row.attempts}: ${row.n}`);
  }

  console.log('\n## 投递窗口（expires_at - created_at）分布');
  for (const row of all(`SELECT CAST((expires_at - created_at) / 86400000 AS INTEGER) AS days, count(*) AS n
      FROM outbox WHERE status='abandoned' GROUP BY days ORDER BY n DESC LIMIT 6`)) {
    console.log(`- ${row.days} 天: ${row.n}`);
  }

  console.log('\n## 时间分布（按天，最近 8 天）');
  for (const row of all(`SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS day, status, count(*) AS n
      FROM outbox GROUP BY day, status ORDER BY day DESC, n DESC LIMIT 12`)) {
    console.log(`- ${row.day} ${row.status}: ${row.n}`);
  }

  const recoverable = all(`SELECT count(*) AS n, sum(length(payload)) AS bytes
      FROM outbox WHERE status='abandoned' AND payload <> '' AND payload <> '{}'`)[0];
  console.log(`\n## 可恢复性：被放弃但 payload 仍在 ${recoverable.n} 条，共 ${(Number(recoverable.bytes ?? 0) / 1024).toFixed(0)} KiB`);
  console.log('（`abandoned` 只是状态，正文没有被删除；恢复与否是策略问题，不是数据丢失）');

  /**
   * The shape of the key that collided.
   *
   * `dsh-end:` keys are derived (`sha256(sessionId, turnId)`), every other key is a fresh
   * uuid. If the abandoned rows are overwhelmingly derived keys, the defect is in the
   * derivation — one key reused for different content — and not in random collisions.
   */
  console.log('\n## eventId 形态（abandoned）');
  for (const row of all(`SELECT CASE WHEN json_extract(payload,'$.eventId') LIKE 'dsh-end:%' THEN 'derived dsh-end:' ELSE 'uuid' END AS shape,
        count(*) AS n FROM outbox WHERE status='abandoned' AND kind='event'
        GROUP BY shape ORDER BY n DESC`)) {
    console.log(`- ${row.shape}: ${row.n}`);
  }

  console.log('\n## 冲突键在库内是否已存在');
  const collisions = all(`SELECT json_extract(payload,'$.eventId') AS eventId, count(*) AS n,
        count(DISTINCT payload) AS distinct_payloads
      FROM outbox WHERE status='abandoned' AND kind='event'
      GROUP BY eventId ORDER BY n DESC LIMIT 5`);
  for (const row of collisions) {
    const existing = row.eventId
      ? db.prepare('SELECT count(*) AS n FROM events WHERE event_id=?').get(row.eventId).n
      : 0;
    console.log(`- ${String(row.eventId).slice(0, 40)}… 出现 ${row.n} 次（不同 payload ${row.distinct_payloads} 种）；库内同键事件 ${existing} 条`);
  }

  console.log('\n## 同一会话的 turn/end 事件在库里有多少');
  for (const row of all(`SELECT json_extract(payload,'$.sessionId') AS sessionId,
        count(*) AS n, count(DISTINCT event_id) AS distinct_keys
      FROM events WHERE json_extract(payload,'$.kind')='turn_stopped'
      GROUP BY sessionId ORDER BY n DESC LIMIT 4`)) {
    console.log(`- ${String(row.sessionId).slice(0, 20)}… 共 ${row.n} 条，不同 event_id ${row.distinct_keys} 个`);
  }
  db.close();
} finally {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { rmSync(work, { recursive: true, force: true, maxRetries: 3 }); break; }
    catch { await new Promise(done => setTimeout(done, 200)); }
  }
}
