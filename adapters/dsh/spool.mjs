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

  const existingIndex = items.findIndex(item => item.idempotencyKey === key);
  if (existingIndex >= 0) {
    items[existingIndex] = {
      ...items[existingIndex],
      payload: entry.payload,
      lastError: entry.error ? String(entry.error).slice(0, 2000) : items[existingIndex].lastError,
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
    attempts: 0,
    lastAttempt: 0,
    lastError: entry.error ? String(entry.error).slice(0, 2000) : '',
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
        delivered = true;
      } else {
        item.attempts = (item.attempts ?? 0) + 1;
        item.lastAttempt = Date.now();
        item.lastError = msg.slice(0, 1000);
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
  return { replayed: deliveredCount, remaining: remaining.length };
}
