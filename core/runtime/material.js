import { createHash } from 'node:crypto';
/**
 * Temporary material and its two-layer expiry.
 *
 * The design treats short-lived material — a URL, its summary, and a body only
 * when needed — as a type of its own, because it is the one kind of knowledge that
 * is *supposed* to disappear. Two mechanisms keep that promise, and both are
 * required: the first is the one that actually protects a reader, and the second is
 * the one that reclaims the space.
 *
 *   1. **Filter on read.** Every retrieval excludes expired material by its stored
 *      expiry time, so a lapsed item cannot be recalled even if the cleanup job has
 *      never run — a core that has been idle for a month still must not answer from
 *      a month-old page.
 *   2. **Purge persistently.** A cleanup pass removes the bodies, summaries and
 *      index rows, leaves a record of having done so, and can be retried.
 *
 * Two properties are easy to get wrong and are fixed here:
 *
 *   - **Reading does not renew.** Only an explicit renewal moves the date, and it
 *     must carry a reason. Sliding expiry on access would make the retention period
 *     meaningless for exactly the items a user opens most.
 *   - **Expiry is stored, not computed.** A later change to the retention period
 *     then cannot silently extend the life of material saved under the old one.
 */
/** Default retention, in days. Stored per entry so a change cannot retroact. */
export const MATERIAL_TTL_DAYS = 90;
const DAY_MS = 86_400_000;
/**
 * Normalise a URL for duplicate detection.
 *
 * Conservative on purpose. The design warns against stripping parameters that
 * could change what the page shows — `?v=` and `?id=` are load-bearing on many
 * sites, and treating two different pages as one is worse than storing a duplicate.
 * So only what cannot affect content is removed: the fragment (never sent to the
 * server) and a trailing slash on an otherwise empty path.
 */
export function normalizeUrl(raw) {
    let url;
    try {
        url = new URL(raw.trim());
    }
    catch {
        return raw.trim();
    }
    // A fragment is client-side only, so two links differing there are one page.
    url.hash = '';
    // `https://host` and `https://host/` are the same resource.
    if (url.pathname === '')
        url.pathname = '/';
    // Default ports are already removed by the URL parser.
    return url.toString();
}
/**
 * A content fingerprint for duplicate detection.
 *
 * Built from the normalised URL and the summary rather than the full body: the body
 * is optional and often empty, and two captures of one page with different
 * boilerplate should still be recognised as the same material.
 */
export function fingerprintOf(url, summary) {
    return createHash('sha256').update(`${normalizeUrl(url)}\n${summary.trim()}`).digest('hex');
}
/**
 * When material saved now should expire.
 *
 * `now` is injected so tests can move time without waiting, and so a caller replaying
 * an import can preserve an original date instead of restarting the clock.
 */
export function expiryFrom(savedAt, ttlDays = MATERIAL_TTL_DAYS) {
    return savedAt + ttlDays * DAY_MS;
}
/**
 * Build a material entry.
 *
 * A page fetched by an agent is `external` provenance by default: imperative prose
 * on a page must never be mistaken for the user's own instruction, and the design
 * calls that out as a specific hazard.
 */
export function materialEntry(input, now = Date.now()) {
    const savedAt = input.savedAt ?? now;
    return {
        id: input.id,
        kind: 'material',
        title: input.title,
        // The scope is the caller's, not a constant: a project's short-lived reference
        // must not become readable by every other project just because it is temporary.
        scope: input.scope ?? { kind: 'global' },
        baseRevision: 0,
        labels: [],
        provenance: input.provenance ?? 'external',
        evidence: 'verifiable',
        platforms: [],
        url: normalizeUrl(input.url),
        fingerprint: fingerprintOf(input.url, input.summary),
        summary: input.summary,
        body: input.body ?? '',
        savedAt,
        expiresAt: input.expiresAt ?? expiryFrom(savedAt, input.ttlDays),
        ...(input.taskId ? { taskId: input.taskId } : {}),
    };
}
/** Whether material is still current at `now`. The read-time gate. */
export function isLive(expiresAt, now = Date.now()) {
    return expiresAt > now;
}
/**
 * An explicit renewal.
 *
 * Requires a reason, per the design: ordinary reading must not extend a lifetime,
 * and a deliberate extension has to say what justified it. The reason is returned
 * rather than stored here so the caller writes it with the rest of the record.
 */
export function renew(entry, reason, now = Date.now(), ttlDays = MATERIAL_TTL_DAYS) {
    const text = reason.trim();
    if (!text)
        throw new Error('Renewal requires a reason');
    return {
        savedAt: entry.savedAt,
        expiresAt: expiryFrom(now, ttlDays),
        renewalReason: text.slice(0, 500),
    };
}
/**
 * What a cleanup pass should remove.
 *
 * Returns ids rather than deleting, so the caller can run it inside its own
 * transaction and record the outcome. A pass that fails midway must be retryable,
 * which means the decision of *what* to remove has to be separate from the removal.
 */
export function expiredIds(entries, now = Date.now()) {
    return entries.filter(entry => !isLive(entry.expiresAt, now)).map(entry => entry.id);
}
