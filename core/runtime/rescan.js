import { discover, rescanDiff, summarizeRescan } from './discovery.js';
/**
 * Periodic rescan orchestration.
 *
 * Kept out of the store so the decision "what should change" is testable without
 * a database, and out of the CLI so the running core can apply the same rule on
 * a timer. Policy applied here:
 *
 *  - A source whose content changed is refreshed: the newest text wins.
 *  - A newly appearing source is adopted.
 *  - A vanished source is only reported. A path can be temporarily absent
 *    (unmounted drive, renamed folder); retiring the user's knowledge on that
 *    basis would be destructive, so removal stays a deliberate act.
 */
/**
 * Convert a discovered candidate into a knowledge entry, preserving text verbatim.
 *
 * Provenance and evidence are recorded from what the scan actually did rather than
 * defaulted: these documents are the user's own files, and the plugin read their
 * bytes itself. Recording anything weaker (or stronger) would misstate the basis
 * on which the entry is trusted — the design requires those two facts to be
 * distinguishable, and a scan is the one place they are known for certain.
 */
export function candidateToKnowledge(candidate) {
    const base = {
        id: candidate.id, title: candidate.title, scope: { kind: 'global' }, baseRevision: 0,
        labels: [], provenance: 'user', evidence: 'observed', platforms: [],
    };
    if (candidate.kind === 'skill') {
        return {
            ...base, kind: 'skill', body: candidate.body,
            leaves: (candidate.leaves ?? []).map(leaf => ({ path: leaf.path, hash: leaf.hash, body: leaf.body })),
            needsStructure: true,
        };
    }
    if (candidate.kind === 'memory')
        return { ...base, kind: 'memory', body: candidate.body };
    // A dated file the user wrote themselves. Stored as a journal rather than as a
    // generic memory so its nature is visible: what happened on a day is a record,
    // not a durable fact about the project, and the two are read differently.
    if (candidate.kind === 'journal') {
        return {
            ...base, kind: 'journal',
            did: candidate.body,
            problems: '', experienceLanded: [], outcome: 'unverified', unfinished: [],
        };
    }
    // A stated working preference, distinct from a rule the user must obey.
    if (candidate.kind === 'preference') {
        return { ...base, kind: 'preference', body: candidate.body, stated: true };
    }
    return { ...base, kind: 'norm', body: candidate.body, deniedTools: [], hostProvided: candidate.hostProvided };
}
/**
 * Compare sources against the ledger and apply the newest-record rule.
 *
 * Each source is applied independently: one unreadable or conflicting file must
 * not abort the rest of the scan, so failures are collected rather than thrown.
 */
export function applyRescan(store, roots) {
    const report = rescanDiff(discover(roots), store.adoptions());
    const refreshed = [];
    const errors = [];
    const toAdopt = [];
    for (const entry of report.entries) {
        if (entry.status === 'changed') {
            try {
                const result = store.refreshAdoption({
                    sourcePath: entry.source.path, kind: entry.kind, title: entry.title,
                    source: { hash: entry.source.hash }, knowledge: candidateToKnowledge(entry),
                    reason: '来源内容已更新，以最新记录为准', origin: 'rescan',
                });
                refreshed.push({ source: entry.source.path, knowledgeId: result.knowledgeId, replacedLocalEdit: result.replacedLocalEdit });
            }
            catch (error) {
                errors.push({ source: entry.source.path, message: error instanceof Error ? error.message : 'refresh failed' });
            }
        }
        else if (entry.status === 'new') {
            toAdopt.push({
                source: { path: entry.source.path, hash: entry.source.hash },
                kind: entry.kind, title: entry.title, knowledge: candidateToKnowledge(entry),
            });
        }
    }
    let adopted = 0;
    let adoptedAt;
    if (toAdopt.length) {
        try {
            const batch = store.adopt(toAdopt);
            adopted = batch.count;
            adoptedAt = batch.adoptedAt;
        }
        catch (error) {
            errors.push({ source: `${toAdopt.length} new sources`, message: error instanceof Error ? error.message : 'adoption failed' });
        }
    }
    const state = store.markRescanned();
    return {
        report, summary: summarizeRescan(report), refreshed, adopted, adoptedAt, errors,
    };
}
