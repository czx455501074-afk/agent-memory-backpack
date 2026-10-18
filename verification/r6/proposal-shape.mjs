/**
 * What pending candidates actually look like, so "why must I type a title" is answered
 * with data instead of a guess.
 *
 * The panel seeds the compose title from `payload.discovery`, falls back to nothing, and
 * keeps the confirm button disabled while the field is empty. Whether that lands on a
 * blank field depends entirely on which fields stored candidates carry — and on the real
 * library most of them were written before the classifier verdict existed. This prints
 * the distribution, on a read-only snapshot, with the exact sizes that matter.
 *
 * Usage: node verification/r6/proposal-shape.mjs [--source <db>] [--sample 5]
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const value = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const sampleLimit = Number(value('--sample') ?? 5);
const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
const source = resolve(value('--source') ?? join(home, '.agent-memory-backpack', 'knowledge.sqlite'));
if (!existsSync(source)) throw new Error(`找不到要测量的库：${source}`);

const work = mkdtempSync(join(tmpdir(), 'amb-proposal-shape-'));
const copy = join(work, 'knowledge.sqlite');
const firstLine = (text) => String(text ?? '').split('\n').map(line => line.trim()).filter(Boolean)[0] ?? '';

try {
  const live = new DatabaseSync(source, { readOnly: true });
  live.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
  live.close();
  const db = new DatabaseSync(copy, { readOnly: true });
  const rows = db.prepare(`SELECT id, state, payload, created_at FROM proposals
      WHERE state IN ('pending','needs_evidence') ORDER BY created_at DESC`).all();

  const stats = {
    total: rows.length,
    withTopLevelDiscovery: 0, withPayloadDiscovery: 0, withTitle: 0,
    blankFirstLine: 0, hasClassification: 0, autoPromotableTrue: 0, autoPromotableFalse: 0, missingVerdict: 0,
  };
  const samples = [];
  for (const row of rows) {
    const payload = (() => { try { return JSON.parse(String(row.payload)); } catch { return {}; } })();
    const top = typeof payload.discovery === 'string' ? payload.discovery : '';
    const nested = payload.payload && typeof payload.payload.discovery === 'string' ? payload.payload.discovery : '';
    const discovery = top || nested;
    if (top) stats.withTopLevelDiscovery += 1;
    if (nested) stats.withPayloadDiscovery += 1;
    if (typeof payload.title === 'string' && payload.title.trim()) stats.withTitle += 1;
    if (!firstLine(discovery)) stats.blankFirstLine += 1;
    const classification = payload.classification;
    if (classification && typeof classification === 'object') {
      stats.hasClassification += 1;
      if (classification.autoPromotable === true) stats.autoPromotableTrue += 1;
      else if (classification.autoPromotable === false) stats.autoPromotableFalse += 1;
      else stats.missingVerdict += 1;
    } else stats.missingVerdict += 1;
    if (samples.length < sampleLimit) {
      samples.push({
        id: row.id, state: row.state,
        discoveryHead: firstLine(discovery).slice(0, 60) || '(首行为空)',
        classificationKind: classification?.kind ?? null,
        autoPromotable: classification?.autoPromotable ?? null,
        scope: classification?.scope ?? null,
        bytes: String(row.payload).length,
      });
    }
  }
  console.log(`# 待审候选 ${stats.total} 条（pending + needs_evidence）\n`);
  console.log('## 字段分布');
  for (const [key, label] of [
    ['withTopLevelDiscovery', 'payload 顶层有 discovery'],
    ['withPayloadDiscovery', 'payload.payload 内嵌 discovery'],
    ['withTitle', 'payload 里已有 title'],
    ['blankFirstLine', '正文首行为空（面板预填会是空串）'],
    ['hasClassification', '有 classification 判定'],
    ['autoPromotableTrue', '可一键采纳（autoPromotable=true）'],
    ['autoPromotableFalse', '明确不得自动升格（false）'],
    ['missingVerdict', '无判定或判定缺 autoPromotable（面板会打开表单）'],
  ]) console.log(`- ${label}: ${stats[key]}`);

  console.log('\n## 样例');
  for (const sample of samples) console.log(`- ${JSON.stringify(sample)}`);

  /**
   * Candidates that name a workflow can only be approved against that workflow's current
   * revision. If the target moved on (or vanished) the approval is refused with
   * `revision_conflict` / `target_mismatch`, which is the one kind of pending row that a
   * reviewer can never adopt by clicking — it needs a fresh comparison, not a retry.
   */
  const named = db.prepare(`SELECT p.id, json_extract(p.payload,'$.workflowId') AS workflowId,
        json_extract(p.payload,'$.baseRevision') AS baseRevision, k.head AS head, k.status AS targetStatus
      FROM proposals p LEFT JOIN knowledge k ON k.id = json_extract(p.payload,'$.workflowId')
      WHERE p.state IN ('pending','needs_evidence')`).all();
  const withTarget = named.filter(row => row.workflowId);
  const conflict = withTarget.filter(row => !row.head || row.head !== row.baseRevision);
  console.log('\n## 目标流程状态（决定“点了也采纳不了”的那一类）');
  console.log(`- 标注了目标流程的候选: ${withTarget.length} / ${named.length}`);
  console.log(`- 目标已移动或不存在（会 revision_conflict / target_mismatch）: ${conflict.length}`);
  for (const row of conflict.slice(0, 8)) {
    console.log(`  - ${row.id}: workflowId=${row.workflowId} baseRevision=${row.baseRevision} head=${row.head ?? '(不存在)'}`);
  }
  db.close();
} finally {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { rmSync(work, { recursive: true, force: true, maxRetries: 3 }); break; }
    catch { await new Promise(done => setTimeout(done, 200)); }
  }
}
