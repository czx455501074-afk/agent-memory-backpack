/**
 * Did the pointer-level injection ever actually happen in the real host?
 *
 * The adapter keeps a per-agent WeakMap of the knowledge revision the session already
 * holds, so a repeat turn should receive a pointer instead of ~9,000 characters of
 * normative prose. A WeakMap keyed by the agent object is exactly the kind of cache that
 * silently misses when the host passes a fresh object each turn — and then the optimisation
 * exists in the code and never in production.
 *
 * The plugin's own log records `context.injected` with `knowledgeRevision` and `chars`, so
 * this reads the logs (never the library) and compares the first injection of each session
 * with its later ones. Numbers only: no session ids, no text.
 *
 * Usage: node verification/r6/injection-log.mjs [--dir <plugin log dir>]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const value = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const dir = value('--dir') ?? join(process.env.USERPROFILE ?? homedir(), '.agent-memory-backpack');
if (!existsSync(dir)) throw new Error(`找不到数据目录：${dir}`);

const files = readdirSync(dir)
  .filter(name => name.startsWith('amb-plugin.log.jsonl'))
  .map(name => join(dir, name))
  .sort();
if (files.length === 0) throw new Error('没有插件日志文件');

const records = [];
for (const file of files) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    // The log writer nests the payload under `data` on some lines and spreads it on others.
    const data = entry?.data && typeof entry.data === 'object' ? entry.data : entry;
    if (data?.event !== 'context.injected') continue;
    // The log writer stamps `ts` as an ISO string; `Number('2026-…')` is NaN, and an
    // earlier version of this script silently dropped every record because of it.
    const at = Number(entry?.at ?? entry?.time ?? 0) || Date.parse(String(entry?.ts ?? ''));
    if (!Number.isFinite(at) || at <= 0) continue;
    records.push({
      at,
      session: String(data.sessionId ?? ''),
      chars: Number(data.chars ?? 0),
      revision: Number(data.knowledgeRevision ?? 0),
      source: String(data.adapter ?? ''),
    });
  }
}
if (records.length === 0) throw new Error('日志里没有 context.injected 记录（可能尚未产生注入）');

records.sort((a, b) => a.at - b.at);
const chars = records.map(r => r.chars).sort((a, b) => a - b);
const median = chars[Math.floor(chars.length / 2)];
const small = chars.filter(n => n < 2000).length;
console.log(`# context.injected 共 ${records.length} 次（${files.length} 个日志文件）`);
console.log(`- 字符数：中位 ${median}，最小 ${chars[0]}，最大 ${chars[chars.length - 1]}`);
console.log(`- 小于 2000 字符（疑似指针级）的注入：${small} 次`);

const bySession = new Map();
for (const record of records) {
  if (!record.session) continue;
  const list = bySession.get(record.session) ?? [];
  list.push(record);
  bySession.set(record.session, list);
}
const multi = [...bySession.values()].filter(list => list.length >= 2);
console.log(`\n## 多轮会话：${multi.length} 个（共 ${bySession.size} 个有记录的会话）`);
let firstFull = 0, laterPointer = 0, laterFull = 0, laterRepeatedSameRevision = 0;
for (const list of multi) {
  if (list[0].chars > 2000) firstFull += 1;
  for (const later of list.slice(1)) {
    if (later.chars < 2000) laterPointer += 1;
    else {
      laterFull += 1;
      if (later.revision === list[0].revision) laterRepeatedSameRevision += 1;
    }
  }
}
console.log(`- 首轮为全文（>2000 字符）：${firstFull} / ${multi.length}`);
console.log(`- 后续轮为指针（<2000 字符）：${laterPointer}`);
console.log(`- 后续轮仍为全文：${laterFull}，其中版本未变（说明版本没送到核心）：${laterRepeatedSameRevision}`);

// The decisive number: how many characters could have been saved.
const saved = records.filter(r => r.chars < 2000).length * (median - 925);
console.log(`\n## 估算：若每次注入都走指针，可再省约 ${Math.max(0, Math.round(saved / 1000))}k 字符（按中位 ${median} 与指针 925 计）`);
