// W3 read-only replay: what the new queue rules do to a real library's pending list.
//
// This opens the library with `readOnly: true` and never writes: the aggregation is a
// derived view, so measuring it must not change what it measures. The rules are not
// re-implemented here — `autoFailureSignature` and `proposalPriority` are imported from
// the built core, so the numbers below are what the shipped code computes, not a second
// opinion about it.
//
// Usage:
//   node verification/r5/replay-proposal-aggregation.mjs [--db <path>] [--state pending] [--json]
//
// Defaults to the agent memory backpack library under the current user's home. The path
// is never printed: a delivery document must not carry a machine-specific location.

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoFailureSignature, proposalPriority } from '../../dist/src/store.js';

const args = process.argv.slice(2);
const flag = name => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const asJson = args.includes('--json');
const here = dirname(fileURLToPath(import.meta.url));
const dbPath = flag('--db') ?? join(homedir(), '.agent-memory-backpack', 'knowledge.sqlite');
const state = flag('--state') ?? 'pending';

if (!existsSync(dbPath)) {
  console.error(`Library not found at the default location under <USER_HOME> (${join(here, '..', '..')} is the checkout).`);
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  const projects = db.prepare('SELECT project_id, count(*) AS n FROM proposals WHERE state=? GROUP BY project_id ORDER BY n DESC').all(state)
    .map(row => ({ projectId: String(row.project_id), rows: Number(row.n) }));

  const report = { state, generatedAt: new Date().toISOString(), mode: 'read-only', projects: [], totals: {} };
  for (const project of projects) {
    const rows = db.prepare('SELECT id,state,created_at,expires_at,payload FROM proposals WHERE project_id=? AND state=? ORDER BY created_at DESC')
      .all(project.projectId, state);

    const actionable = [];
    const groups = new Map();
    for (const row of rows) {
      let payload = {};
      try { payload = JSON.parse(String(row.payload || '{}')); } catch { payload = {}; }
      const discovery = typeof payload.discovery === 'string' ? payload.discovery : '';
      const classification = payload.classification ?? {};
      const attribution = payload.attribution ?? {};
      const signature = autoFailureSignature(discovery);
      const priority = proposalPriority({
        important: payload.important === true,
        relation: typeof classification.relation === 'string' ? classification.relation : 'unknown',
        needsSplit: classification.needsSplit === true,
        confidence: typeof classification.confidence === 'number' ? classification.confidence : 0,
        hasEvidence: typeof payload.evidence === 'string' && payload.evidence.trim().length > 0,
        attributed: attribution.resolved === true,
        autoFailure: signature !== null,
      });
      const entry = { id: String(row.id), createdAt: Number(row.created_at), priority, signature: signature?.signature ?? null, tool: signature?.tool ?? null };
      if (!signature) { actionable.push(entry); continue; }
      const bucket = groups.get(signature.signature) ?? { tool: signature.tool, members: [] };
      bucket.members.push(entry);
      groups.set(signature.signature, bucket);
    }

    const aggregated = [...groups.entries()].map(([signature, bucket]) => {
      const members = [...bucket.members].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
      return {
        signature, tool: bucket.tool, occurrences: members.length,
        firstSeenAt: members[members.length - 1].createdAt, lastSeenAt: members[0].createdAt,
        band: members[0].priority.band, memberIds: members.map(item => item.id),
      };
    }).sort((a, b) => b.occurrences - a.occurrences || b.lastSeenAt - a.lastSeenAt || a.signature.localeCompare(b.signature));

    const failureMembers = aggregated.reduce((sum, group) => sum + group.occurrences, 0);
    const bandCount = { critical: 0, high: 0, normal: 0, low: 0 };
    for (const item of actionable) bandCount[item.priority.band] += 1;
    for (const group of aggregated) bandCount[group.band] += group.occurrences;

    report.projects.push({
      projectId: project.projectId,
      before: { inState: rows.length },
      after: {
        actionable: actionable.length,
        failureGroups: aggregated.length,
        failureMembers,
        collapsed: failureMembers - aggregated.length,
        defaultView: actionable.length,
        allView: actionable.length + aggregated.length,
        collapseRatio: rows.length ? Number(((failureMembers - aggregated.length) / rows.length).toFixed(4)) : 0,
      },
      bands: bandCount,
      actionablePreview: [...actionable]
        .sort((a, b) => b.priority.score - a.priority.score || b.createdAt - a.createdAt)
        .slice(0, 10)
        .map(item => ({ id: item.id, band: item.priority.band, score: item.priority.score, reasons: item.priority.reasons })),
      topSignatures: aggregated.slice(0, 15).map(group => ({
        signature: group.signature, tool: group.tool, occurrences: group.occurrences,
        firstSeenAt: new Date(group.firstSeenAt).toISOString(), lastSeenAt: new Date(group.lastSeenAt).toISOString(),
        sampleId: group.memberIds[0],
      })),
      singletonSignatures: aggregated.filter(group => group.occurrences === 1).length,
    });
  }

  const total = report.projects.reduce((accumulator, project) => ({
    inState: accumulator.inState + project.before.inState,
    actionable: accumulator.actionable + project.after.actionable,
    failureGroups: accumulator.failureGroups + project.after.failureGroups,
    failureMembers: accumulator.failureMembers + project.after.failureMembers,
    collapsed: accumulator.collapsed + project.after.collapsed,
  }), { inState: 0, actionable: 0, failureGroups: 0, failureMembers: 0, collapsed: 0 });
  report.totals = {
    before: total.inState,
    afterAllView: total.actionable + total.failureGroups,
    collapsed: total.collapsed,
    actionable: total.actionable,
    failureMembers: total.failureMembers,
    failureGroups: total.failureGroups,
  };

  if (asJson) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`state=${state} mode=read-only at ${report.generatedAt}`);
    for (const project of report.projects) {
      console.log(`\nproject ${project.projectId}`);
      console.log(`  before:            ${project.before.inState} 条 pending`);
      console.log(`  after (default):   ${project.after.defaultView} 条（值得审的）`);
      console.log(`  after (all):       ${project.after.allView} 条 = ${project.after.actionable} 人工 + ${project.after.failureGroups} 个失败聚合组`);
      console.log(`  failure members:   ${project.after.failureMembers} 条 → ${project.after.failureGroups} 组（折叠 ${project.after.collapsed} 条重复）`);
      console.log(`  bands:             ${JSON.stringify(project.bands)}`);
      console.log(`  singleton sigs:    ${project.singletonSignatures}`);
      console.log('  top signatures:');
      for (const group of project.topSignatures.slice(0, 8)) console.log(`    ${String(group.occurrences).padStart(3)}x ${group.tool} :: ${group.signature.split('::')[1]?.slice(0, 70)}`);
    }
    console.log(`\ntotals: ${report.totals.before} → ${report.totals.afterAllView} 条（纯重复折叠 ${report.totals.collapsed} 条）`);
  }
} finally {
  db.close();
}
