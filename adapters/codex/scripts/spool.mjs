import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Bounded local disk spool for the adapters.
 *
 * Buffers outgoing candidates and events when the core service or its outbox
 * endpoint is unreachable, preventing unrecoverable loss of user work during outages.
 *
 * Constraints & Invariants:
 *  - Bounded size: at most 500 items, at most 4 MiB total payload.
 *  - Expiration: TTL of 7 days; items older than 7 days are pruned.
 *  - Retry limit: at most 12 replay attempts per item.
 *  - Safe fallback: spool errors never throw to the host agent or block execution.
 *  - Subordinate role: the spool is strictly an entry buffer; once delivered to the core,
 *    items are removed immediately so the core outbox remains the single authority.
 */

export const SPOOL_MAX_ITEMS = 500;
export const SPOOL_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB
export const SPOOL_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const SPOOL_MAX_ATTEMPTS = 12;

/**
 * Failure kinds a later attempt may still survive.
 *
 * The distinction is the whole point of keeping structured metadata: a refusal
 * the core repeated on purpose (4xx, 426, a protocol mismatch, a cancellation)
 * can never succeed by being sent again, so replaying it only burns the retry
 * budget and hides a real error behind an ever-growing queue. Only a transient
 * fault is worth another attempt. `unknown` stays retryable because an item
 * written by an earlier build carries no kind, and discarding user work on a
 * guess is worse than one wasted attempt.
 */
const RETRYABLE_FAILURE_KINDS = new Set(['timeout', 'network', 'transport', 'http5xx', 'capacity', 'unknown']);

function statusToKind(status) {
  if (status === 507) return 'capacity';
  return status >= 500 ? 'http5xx' : 'http4xx';
}

/**
 * The failure kind of a queued item, from its structured record or, for entries
 * written by an earlier build, from the legacy `lastError` string.
 */
export function failureKindOf(item) {
  const structured = typeof item?.failure?.kind === 'string' && item.failure.kind;
  if (structured) return item.failure.kind;
  const status = Number(item?.failure?.status);
  if (Number.isFinite(status)) return statusToKind(status);
  const text = typeof item?.lastError === 'string' ? item.lastError : '';
  const match = /\bHTTP\s*(\d{3})\b/.exec(text);
  if (match) return statusToKind(Number(match[1]));
  if (/protocol version mismatch|invalid_response|invalid response/i.test(text)) return 'protocol';
  return 'unknown';
}

/** Whether replaying this item is worth another attempt. */
export function isRetryableItem(item) {
  return RETRYABLE_FAILURE_KINDS.has(failureKindOf(item));
}

/** Normalize the failure metadata an enqueue caller supplied. */
function normalizeFailure(entry) {
  const source = entry.failure && typeof entry.failure === 'object' ? entry.failure : undefined;
  const reason = String(source?.reason ?? entry.error ?? '').slice(0, 2000);
  if (!source && !reason) return undefined;
  const failure = {
    kind: typeof source?.kind === 'string' && source.kind ? source.kind : 'unknown',
    at: Number.isFinite(source?.at) ? Number(source.at) : Date.now(),
  };
  if (typeof source?.code === 'string' && source.code) failure.code = source.code;
  if (Number.isFinite(source?.status)) failure.status = Number(source.status);
  if (reason) failure.reason = reason;
  return failure;
}

/** Structured failure metadata for an error raised while replaying. */
function failureMetaFromError(error, message) {
  const failure = { at: Date.now() };
  const reason = String(message ?? '').slice(0, 1000);
  const status = Number(error?.status ?? error?.statusCode);
  // The kind comes from the error when it has one. An error raised by an older
  // build carries neither kind nor status, so its `HTTP <n>` message is read
  // instead - otherwise a legacy 4xx would look transient and be replayed until
  // the attempt cap.
  const fromMessage = /\bHTTP\s*(\d{3})\b/.exec(reason);
  failure.kind = typeof error?.kind === 'string' && error.kind
    ? error.kind
    : Number.isFinite(status) ? statusToKind(status)
      : fromMessage ? statusToKind(Number(fromMessage[1])) : 'unknown';
  if (typeof error?.code === 'string' && error.code) failure.code = error.code;
  if (Number.isFinite(status)) failure.status = status;
  else if (fromMessage) failure.status = Number(fromMessage[1]);
  if (reason) failure.reason = reason;
  return failure;
}

export function spoolFilePath(dataDir) {
  return join(dataDir, 'adapter-spool.json');
}

export function loadSpool(dataDir) {
  if (!dataDir) return [];
  const file = spoolFilePath(dataDir);
  if (!existsSync(file)) return [];
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.items)) {
      try { renameSync(file, `${file}.corrupt-${Date.now()}`); } catch {}
      return [];
    }
    const now = Date.now();
    // Prune expired items
    return parsed.items.filter(item => {
      if (!item || typeof item !== 'object') return false;
      const age = now - (Number(item.createdAt) || 0);
      return age >= 0 && age <= SPOOL_TTL_MS && (item.attempts ?? 0) < SPOOL_MAX_ATTEMPTS;
    });
  } catch {
    try { renameSync(file, `${file}.corrupt-${Date.now()}`); } catch {}
    return [];
  }
}

export function saveSpool(dataDir, items) {
  if (!dataDir) return;
  const file = spoolFilePath(dataDir);
  if (!items || items.length === 0) {
    if (existsSync(file)) {
      try { rmSync(file, { force: true }); } catch {}
    }
    return;
  }
  const payload = JSON.stringify({ version: 1, items });
  mkdirSync(dataDir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, payload, 'utf8');
  renameSync(tmp, file);
}

export function spoolEnqueue(dataDir, entry) {
  if (!dataDir || !entry) return { enqueued: false, reason: 'missing_arguments' };
  const items = loadSpool(dataDir);

  const key = entry.idempotencyKey || entry.payload?.idempotencyKey || entry.payload?.eventId;
  if (!key) {
    return { enqueued: false, reason: 'missing_idempotency_key', error: 'Spool entry requires idempotencyKey or eventId' };
  }

  const failure = normalizeFailure(entry);
  const lastError = failure?.reason ?? (entry.error ? String(entry.error).slice(0, 2000) : '');

  const existingIndex = items.findIndex(item => item.idempotencyKey === key);
  if (existingIndex >= 0) {
    const existing = items[existingIndex];
    items[existingIndex] = {
      ...existing,
      payload: entry.payload,
      // `createdAt` and `attempts` are carried over on purpose: a duplicate
      // arrival is the same pending work seen twice, not a fresh item, and
      // resetting them would restart the TTL and hand back a retry budget this
      // item already spent.
      ...(failure ? { failure } : {}),
      lastError: lastError || existing.lastError,
    };
    saveSpool(dataDir, items);
    return { enqueued: true, key, updated: true };
  }

  if (items.length >= SPOOL_MAX_ITEMS) {
    return { enqueued: false, reason: 'capacity_exceeded', error: `Spool capacity limit exceeded (max ${SPOOL_MAX_ITEMS} items)` };
  }

  const currentBytes = Buffer.byteLength(JSON.stringify(items), 'utf8');
  const entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8');
  if (currentBytes + entryBytes > SPOOL_MAX_BYTES) {
    return { enqueued: false, reason: 'size_limit_exceeded', error: `Spool byte size limit exceeded (max 4MiB)` };
  }

  items.push({
    idempotencyKey: key,
    kind: entry.kind === 'event' ? 'event' : 'candidate',
    projectId: entry.projectId,
    payload: entry.payload,
    createdAt: Date.now(),
    // A first failure is recorded, never counted: `attempts` is the budget replay
    // spends, so it starts at zero even though delivery already failed once.
    attempts: 0,
    lastAttempt: 0,
    lastError,
    ...(failure ? { failure } : {}),
  });

  saveSpool(dataDir, items);
  return { enqueued: true, key };
}

export async function spoolReplay(dataDir, client, logger) {
  if (!dataDir) return { replayed: 0, remaining: 0 };
  const items = loadSpool(dataDir);
  if (items.length === 0) return { replayed: 0, remaining: 0 };

  const remaining = [];
  let deliveredCount = 0;
  let rejectedCount = 0;

  for (const item of items) {
    let delivered = false;
    try {
      if (item.kind === 'candidate') {
        await client.post('/v1/proposals', item.payload);
        delivered = true;
      } else if (item.kind === 'event') {
        await client.post('/v1/events', item.payload);
        delivered = true;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('duplicate') || msg.includes('idempotency_conflict')) {
        // The core already has it: the write succeeded on an earlier attempt.
        delivered = true;
      } else {
        const failure = failureMetaFromError(err, msg);
        item.failure = failure;
        item.lastAttempt = Date.now();
        item.lastError = failure.reason ?? msg.slice(0, 1000);
        if (!isRetryableItem(item)) {
          // A permanent refusal: another attempt can only fail the same way, so the
          // item leaves the queue instead of being retried up to the cap. Only the
          // key, kind and controlled code are logged - never the payload.
          rejectedCount += 1;
          if (logger) logger.warn('spool.rejected', {
            key: item.idempotencyKey, kind: item.kind,
            failureKind: failure.kind, code: failure.code, status: failure.status,
          });
          continue;
        }
        item.attempts = (item.attempts ?? 0) + 1;
      }
    }

    if (delivered) {
      deliveredCount += 1;
      if (logger) logger.info('spool.delivered', { key: item.idempotencyKey, kind: item.kind });
    } else {
      if ((item.attempts ?? 0) < SPOOL_MAX_ATTEMPTS) {
        remaining.push(item);
      } else {
        if (logger) logger.warn('spool.abandoned', { key: item.idempotencyKey, kind: item.kind, attempts: item.attempts });
      }
    }
  }

  saveSpool(dataDir, remaining);
  return { replayed: deliveredCount, remaining: remaining.length, rejected: rejectedCount };
}
