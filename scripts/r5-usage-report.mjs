// What the plugin actually costs and saves on this machine, measured from what it
// wrote down while it worked.
//
// The product promise is "do not feed the agent a lot of context". A promise like
// that is only checkable with numbers, and the numbers have to come from real
// sessions rather than from a fixture that was built to pass.
//
// Two rules from this project's own norms are applied here, because breaking them
// is how a fix gets credited for noise:
//   - compare windows that are actually comparable: align the event types, report
//     ratios rather than absolutes, and check the time distribution before trusting
//     a total;
//   - separate layers before attributing cost (a synchronous endpoint with no model
//     behind it is the control for anything that can call one).
//
// Read-only. It opens the log and the library, and prints; it writes nothing.
//
// Usage: node scripts/r5-usage-report.mjs [--data-dir <dir>] [--tail <n>] [--json]
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const dataDir = flag('data-dir', join(homedir(), '.agent-memory-backpack'));
const tailLines = Number(flag('tail', '4000'));
const asJson = argv.includes('--json');

const percentile = (sorted, fraction) => {
  if (!sorted.length) return null;
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
  return sorted[at];
};
const describe = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0] ?? null,
    median: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    max: sorted[sorted.length - 1] ?? null,
    total: sorted.reduce((sum, value) => sum + value, 0),
  };
};

// ---- the log: what was injected, per turn -------------------------------
const logFile = join(dataDir, 'amb-plugin.log.jsonl');
const injected = [];
const injectedByKind = { pointer: [], full: [] };
if (existsSync(logFile)) {
  const lines = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-tailLines);
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.event !== 'context.injected' || typeof entry.chars !== 'number') continue;
    injected.push({ ts: entry.ts, chars: entry.chars, knowledgeIds: entry.knowledgeIds?.length ?? 0, adapter: entry.adapter });
    // The pointer path reports the same event but a much smaller payload. Splitting
    // by size rather than by a flag keeps this honest if the wording changes.
    (entry.chars <= 200 ? injectedByKind.pointer : injectedByKind.full).push(entry.chars);
  }
}

// ---- the library: what the queue and the tasks look like now ------------
const db = new DatabaseSync(join(dataDir, 'knowledge.sqlite'), { readOnly: true });
const pendingByDay = db.prepare(`SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS day, count(*) AS n
  FROM proposals WHERE state = 'pending' GROUP BY 1 ORDER BY 1 DESC LIMIT 7`).all()
  .map(row => ({ day: row.day, n: row.n }));
const proposalStates = Object.fromEntries(db.prepare('SELECT state, count(*) n FROM proposals GROUP BY 1').all().map(row => [row.state, row.n]));
const taskStates = Object.fromEntries(db.prepare('SELECT status, count(*) n FROM tasks GROUP BY 1').all().map(row => [row.status, row.n]));
const kinds = Object.fromEntries(db.prepare(`SELECT json_extract(r.content, '$.kind') AS kind, count(*) AS n
  FROM knowledge k JOIN revisions r ON r.id = k.id AND r.revision = k.head
  WHERE k.status = 'active' GROUP BY 1 ORDER BY 2 DESC`).all().map(row => [row.kind, row.n]));
const taskScoped = db.prepare(`SELECT count(*) n FROM knowledge k JOIN revisions r ON r.id = k.id AND r.revision = k.head
  WHERE k.status = 'active' AND json_extract(r.content, '$.scope.kind') = 'task'`).get().n;
db.close();

const report = {
  log: {
    file: logFile,
    turnsSeen: injected.length,
    first: injected[0]?.ts ?? null,
    last: injected[injected.length - 1]?.ts ?? null,
    allChars: describe(injected.map(entry => entry.chars)),
    pointerSized: describe(injectedByKind.pointer),
    fullSized: describe(injectedByKind.full),
  },
  library: { proposalStates, pendingByDay, taskStates, taskScopedEntries: taskScoped, activeKinds: kinds },
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const { log, library } = report;
  console.log('这台机器上的真实用量（只读）\n');
  console.log(`日志：${log.file}`);
  console.log(`可分析的注入记录 ${log.turnsSeen} 条，覆盖 ${log.first ?? '—'} → ${log.last ?? '—'}\n`);
  const line = (label, d) => d.n
    ? console.log(`${label.padEnd(14)} n=${String(d.n).padStart(4)}  中位 ${String(d.median).padStart(5)}   p90 ${String(d.p90).padStart(6)}   最大 ${String(d.max).padStart(7)}   合计 ${d.total}`)
    : console.log(`${label.padEnd(14)} 无样本`);
  line('全部注入', log.allChars);
  line('指针级(≤200)', log.pointerSized);
  line('全文级(>200)', log.fullSized);
  if (log.pointerSized.n && log.fullSized.n) {
    const saving = 1 - (log.pointerSized.median / log.fullSized.median);
    console.log(`\n指针级相对全文级的中位节省：${(saving * 100).toFixed(1)}%（${log.fullSized.median} → ${log.pointerSized.median} 字符）`);
    console.log('注意：两者是同一事件的不同规模，不是同一批查询的前后对照；跨窗口比较前先证明窗口可比。');
  }
  console.log(`\n知识库：活跃 ${Object.entries(library.activeKinds).map(([k, n]) => `${k} ${n}`).join(' / ')}`);
  console.log(`任务：${Object.entries(library.taskStates).map(([k, n]) => `${k} ${n}`).join(' / ')}；task 作用域条目 ${library.taskScopedEntries}`);
  console.log(`候选：${Object.entries(library.proposalStates).map(([k, n]) => `${k} ${n}`).join(' / ')}`);
  console.log(`\n待审候选按创建日（最近 7 天）：${library.pendingByDay.map(row => `${row.day} ${row.n}`).join(' | ')}`);
}
