/**
 * Knowledge normalization census: is this library storing *knowledge*, or raw text?
 *
 * A library that accepts raw material — a session transcript, a pasted tool log, a whole
 * skill body — pays for it twice. Retrieval ranks that text against real entries (it is
 * long, so it accumulates query terms), and injection then spends its character budget on
 * prose nobody can reuse. The fix is not a bigger budget; it is that what lands in the
 * library is a *normalized description* written by the agent before the write, not the
 *原文 it was read from.
 *
 * This script is the machine-checkable half of that rule. It does not rewrite anything and
 * does not gate a release by itself: it reports the shape of the library so the rule can be
 * applied to new writes and the backlog can be sized with numbers instead of impressions.
 *
 * Usage: node verification/knowledge-normalization.mjs [--data-dir DIR] [--json] [--limit N]
 * Exit: always 0 — this is a census. Add nothing here that fails a build on old data.
 */
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const dataDir = flag('data-dir', join(homedir(), '.agent-memory-backpack'));
const asJson = argv.includes('--json');
const limit = Number(flag('limit', '10'));

/**
 * Signals that what was stored is a transcript rather than a description.
 *
 * Each one is a property a *normalized* entry would not have: a description has a claim as
 * its title, states when it applies, and points at its evidence instead of embedding it.
 */
const SIGNALS = [
  ['transcript-prefix', (text) => /^\s*(?:\[\d{1,2}:\d{2}\]|\[\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2})/.test(text),
    '以流水时间戳开头：这是一条记录，不是一个结论'],
  ['tool-output', (text) => ((text.match(/exit_code=|✔|✖|stdout:|stderr:/g) ?? []).length >= 3),
    '正文里贴了整段工具输出'],
  ['first-person-log', (text) => ((text.match(/本轮|我上一轮|我们这次|我刚才|这次我又|随后我/g) ?? []).length >= 3),
    '逐轮自述过程而不是给出结论'],
  ['dense-local-paths', (text) => text.length > 2000 && ((text.match(/[A-Za-z]:\\[\\\w.-]{3,}/g) ?? []).length >= 3),
    '长正文里密集出现本机绝对路径'],
  ['code-dominant', (text) => {
    const fences = (text.match(/```/g) ?? []).length;
    return text.length > 2000 && fences >= 4 && text.length / Math.max(1, fences) < 1500;
  }, '以代码块为主体，等于把源文件搬了进来'],
  ['oversize-no-pointer', (text) => text.length > 8000 && !/amb_read_knowledge|详见|参见|完整内容/.test(text),
    '超长且没有指向完整内容的指针：读者只能全读或全不读'],
];

const db = new DatabaseSync(join(dataDir, 'knowledge.sqlite'), { readOnly: true });
const rows = db.prepare(`SELECT k.id, k.kind, k.status, k.head, r.content
  FROM knowledge k JOIN revisions r ON r.id=k.id AND r.revision=k.head`).all();

function bodyOf(content) {
  const parsed = JSON.parse(content);
  if (parsed.kind === 'journal') return `${parsed.did ?? ''}\n${parsed.problems ?? ''}`;
  if (typeof parsed.body === 'string') return parsed.body;
  if (Array.isArray(parsed.leaves)) return parsed.leaves.map(leaf => leaf.body ?? '').join('\n');
  return JSON.stringify(parsed);
}

const perKind = new Map();
const offenders = [];
for (const row of rows) {
  const text = bodyOf(String(row.content));
  const hits = SIGNALS.filter(([, test]) => test(text)).map(([name]) => name);
  const key = `${row.kind}${row.status === 'active' ? '' : '(retired)'}`;
  const bucket = perKind.get(key) ?? { n: 0, raw: 0, chars: 0, rawChars: 0 };
  bucket.n++; bucket.chars += text.length;
  // Two signals is the threshold, and it is deliberately two: one signal can be a false
  // positive (a legitimate entry may quote one command), two describe the same text twice.
  if (hits.length >= 2) { bucket.raw++; bucket.rawChars += text.length; offenders.push({ id: row.id, kind: row.kind, status: row.status, len: text.length, hits }); }
  perKind.set(key, bucket);
}
const table = [...perKind.entries()].map(([kind, value]) => ({
  kind, entries: value.n, rawShaped: value.raw,
  medianChars: 0, totalChars: value.chars, rawChars: value.rawChars,
  rawSharePct: value.n ? Math.round(value.raw / value.n * 1000) / 10 : 0,
})).sort((a, b) => b.entries - a.entries);
offenders.sort((a, b) => b.len - a.len);

if (asJson) {
  console.log(JSON.stringify({ dataDir, scanned: rows.length, table, offenders: offenders.slice(0, limit) }, null, 2));
} else {
  console.log(`知识库规范化普查（只读）：${dataDir}`);
  console.log(`扫描 ${rows.length} 条。判据：命中两条及以上"原文特征"即视为原文型。\n`);
  console.log('kind            条目   原文型  占比     其中字符数');
  for (const row of table)
    console.log(`${row.kind.padEnd(15)} ${String(row.entries).padStart(4)} ${String(row.rawShaped).padStart(7)}  ${String(row.rawSharePct).padStart(5)}%  ${String(row.rawChars).padStart(9)}`);
  const total = table.reduce((sum, row) => sum + row.entries, 0);
  const raw = table.reduce((sum, row) => sum + row.rawShaped, 0);
  console.log(`\n合计 ${total} 条，原文型 ${raw} 条（${(raw / Math.max(1, total) * 100).toFixed(1)}%）。`);
  console.log(`\n最需要改写的 ${Math.min(limit, offenders.length)} 条：`);
  for (const item of offenders.slice(0, limit))
    console.log(`  ${item.id}  ${item.len} 字符  ${item.kind}${item.status === 'active' ? '' : '（已退役）'}\n      ${item.hits.join('、')}`);
  console.log('\n这不是门禁：它不判定旧数据有罪，只把"要改写多少"变成可核对的数字。');
}
db.close();
