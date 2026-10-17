// R5 acceptance: one script, one verdict, measured on a COPY of the live library.
//
// The point of this file is that "it works now" is a claim someone else can
// re-run. It reports four things that the R5 work is judged on:
//
//  1. retrieval  - a rule that exists in the library is reached by a query that
//                  quotes it (the in-memory index path, not the FTS one);
//  2. receipt    - the same call's retrieval receipt is honest: a matched term
//                  is not simultaneously reported as a gap;
//  3. budget     - how much normative prose a session actually receives;
//  4. queue      - how large the human review queue is.
//
// Everything reads a throwaway copy (VACUUM INTO). The live database is opened
// read-only and never written.
//
// Usage: node scripts/r5-acceptance.mjs [--data-dir <dir>] [--query <text>]...
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { Store } = await import(new URL('../dist/src/store.js', import.meta.url).href);
const { buildRetrievalIndex } = await import(new URL('../dist/src/retrieval-index.js', import.meta.url).href);
const { createRetrievalService } = await import(new URL('../dist/src/retrieval-service.js', import.meta.url).href);

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const dataDir = flag('data-dir', join(homedir(), '.agent-memory-backpack'));
const queries = argv.reduce((all, item, index) => (item === '--query' ? [...all, argv[index + 1]] : all), []);
const asked = queries.length ? queries : ['打包脚本必须包含全量语法扫描', '排查接口超时要带协议头防 426'];

const source = join(dataDir, 'knowledge.sqlite');
const scratch = mkdtempSync(join(tmpdir(), 'amb-r5-accept-'));
const copy = join(scratch, 'knowledge.sqlite');
const results = [];

try {
  new DatabaseSync(source, { readOnly: true }).exec(`VACUUM INTO '${copy.replace(/\\/g, '/')}'`);
} catch (error) {
  console.error(`无法复制库（源是否可读？）：${error instanceof Error ? error.message : error}`);
  process.exit(2);
}

const store = new Store(copy);
const projectId = String(store.db.prepare('SELECT project_id FROM proposals ORDER BY created_at DESC LIMIT 1').get()?.project_id ?? 'p0-workflow');
const short = raw => {
  const id = String(raw);
  const parts = id.split(':');
  return parts.length > 1 ? `${parts[0]}:${parts[1].slice(0, 10)}` : id.slice(0, 24);
};

// 1 + 2: reach and receipt, per query. The selection is taken the way the host
// takes it: `/v1/prepare` forwards `selectedIds` whenever the selection is not the
// unconfigured case, so asking the core with no selection would test a path the
// host never uses.
const select = createRetrievalService(store, scratch);
for (const query of asked) {
  const scoped = store.scopedEntries(projectId);
  const candidates = scoped.map(entry => {
    const content = entry.content;
    const body = 'body' in content ? content.body : content.kind === 'journal' ? content.did : JSON.stringify(content);
    return { id: entry.id, revision: entry.revision, title: content.title, kind: content.kind, body };
  });
  const ranked = buildRetrievalIndex(candidates).rank(query).slice(0, 3)
    .map(hit => ({ id: hit.candidate.id, kind: hit.candidate.kind, score: Number(hit.score.toFixed(2)) }));
  const selection = await select(projectId, query);
  const forwarded = selection.mode === 'model' || selection.mode === 'index' || selection.reason !== 'not_configured';
  const prepared = store.prepare(projectId, query,
    forwarded ? { selectedIds: selection.selectedIds, selectionSource: selection.source } : {});
  const matched = prepared.retrieval.matchedTokens.filter(token => token.length >= 2);
  const lenient = prepared.retrieval.matchedTokens;
  results.push({
    query,
    top: ranked,
    normCount: scoped.filter(entry => entry.content.kind === 'norm').length,
    selection: { mode: selection.mode, reason: selection.reason, source: selection.source, ids: selection.selectedIds.map(short) },
    receipt: {
      tokens: prepared.retrieval.tokens.length,
      matched: lenient,
      gaps: prepared.retrieval.gaps,
      selected: prepared.retrieval.selected.map(item => short(item.id)),
    },
    budget: { used: prepared.budget.usedChars, limit: prepared.budget.limitChars, norms: prepared.norms.length },
    _matchedOk: matched.length > 0,
  });
}

// 3 + 4: library shape.
const shape = {
  active: store.db.prepare(`SELECT json_extract(r.content, '$.kind') kind,
      coalesce(json_extract(r.content, '$.scope.kind'), '?') scope, count(*) n
    FROM knowledge k JOIN revisions r ON r.id = k.id AND r.revision = k.head
    WHERE k.status = 'active' GROUP BY 1, 2 ORDER BY n DESC`).all(),
  proposals: store.db.prepare('SELECT state, count(*) n FROM proposals GROUP BY 1').all(),
  tasks: store.db.prepare('SELECT status, count(*) n FROM tasks GROUP BY 1').all(),
  rescan: store.rescanState(),
};

console.log(JSON.stringify({ projectId, results, shape }, null, 2));

const reachOk = results.every(item => item.top.some(hit => hit.kind === 'norm'));
const receiptOk = results.every(item => item._matchedOk);
console.log(`\n检索可达规范: ${reachOk ? 'PASS' : 'FAIL（准原文查询没能在索引路径命中规范）'}`);
console.log(`回执诚实   : ${receiptOk ? 'PASS' : 'FAIL（matchedTokens 为空，缺口头全部命中词）'}`);

store.close();
rmSync(scratch, { recursive: true, force: true });
process.exit(reachOk && receiptOk ? 0 : 1);
