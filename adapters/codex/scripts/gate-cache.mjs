import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What the gate can still enforce when the core is unreachable.
 *
 * The design names three operating modes — Managed, ReadOnlySnapshot, Ungoverned —
 * and requires the plugin to degrade visibly rather than either pretend it is
 * enforcing policy or halt everything.
 *
 * That distinction exists because of a real failure. The gate originally denied
 * every tool call whenever the core was down, on the reasoning that an unverifiable
 * policy must not be assumed satisfied. The effect was the opposite of the intent:
 * a knowledge plugin became a single point of failure for the whole agent, so
 * stopping the core locked the user out of reading and editing their own files, and
 * the only way back was to disable the plugin. The design says the hook is not the
 * hard boundary for every operation, and this is what that means in practice.
 *
 * The three modes:
 *
 *   - **Managed**: the core answered. Its decision is enforced as given.
 *   - **ReadOnlySnapshot**: the core is unreachable, but a snapshot taken while it
 *     was reachable is on disk. The recorded prohibitions are still enforced — the
 *     policy does not lapse just because the process did — and nothing new is
 *     learned. Reads and writes outside those prohibitions proceed.
 *   - **Ungoverned**: no core has ever answered. Nothing is enforced and nothing is
 *     claimed; the state is reported loudly so the difference from Managed is
 *     visible rather than assumed.
 *
 * A snapshot is what stops "kill the core" from being a way to shed policy: once
 * the gate has run, its prohibitions survive the process. A fresh install with no
 * core blocks nothing, because there is no policy to uphold yet.
 *
 * An identical copy of this file lives in each adapter package.
 * `test/gate-cache.test.ts` asserts the two are byte-identical.
 */

/** How long a snapshot stays usable. Beyond this it is reported, not enforced. */
export const SNAPSHOT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export const snapshotPath = (dir) => join(dir, 'gate-snapshot.json');

/**
 * Record what the core last told us.
 *
 * Written on every successful gate, not once: a norm added in the meantime must be
 * reflected, or the cached policy would enforce a stale set of prohibitions.
 */
export function saveSnapshot(dir, snapshot) {
  const record = {
    deniedTools: [...new Set(snapshot.deniedTools ?? [])],
    revision: snapshot.revision ?? 0,
    at: snapshot.at ?? Date.now(),
  };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(snapshotPath(dir), JSON.stringify(record), 'utf8');
    return { saved: true, record };
  } catch (error) {
    // A snapshot that cannot be written degrades the next outage to Ungoverned; it
    // must not break the request that is succeeding right now.
    return { saved: false, record, detail: error instanceof Error ? error.message : 'write failed' };
  }
}

/**
 * Read the snapshot, saying why it is unusable when it is.
 *
 * An unreadable or over-age snapshot is reported rather than silently absent, so a
 * user asking "why is nothing enforced" gets an answer instead of a shrug.
 */
export function loadSnapshot(dir, now = Date.now()) {
  const file = snapshotPath(dir);
  if (!existsSync(file)) return { state: 'absent' };
  let record;
  try { record = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { return { state: 'unreadable', detail: error instanceof Error ? error.message : 'parse failed' }; }
  if (!record || !Array.isArray(record.deniedTools)) return { state: 'unreadable', detail: 'shape mismatch' };
  if (typeof record.at !== 'number') return { state: 'unreadable', detail: 'no timestamp' };
  const age = now - record.at;
  if (age > SNAPSHOT_MAX_AGE_MS) {
    return { state: 'expired', record, detail: `${Math.round(age / 86400000)} 天前的快照已超出可用期限` };
  }
  return { state: 'usable', record };
}

/** Normalise a tool name the same way the core does, so the match cannot differ. */
const normalise = (name) => String(name ?? '').trim().toLowerCase();

/**
 * Decide from a snapshot alone.
 *
 * `deny` only for a recorded prohibition; `allow` for anything else. There is no
 * `unknown`: an unlisted tool was not prohibited when the snapshot was taken, and
 * treating it as unknown would restore the halt-everything behaviour under another
 * name.
 */
export function decideFromSnapshot(record, toolName) {
  const requested = normalise(toolName);
  if (!requested) return 'deny';
  const denied = new Set((record?.deniedTools ?? []).map(normalise));
  return denied.has(requested) ? 'deny' : 'allow';
}

/**
 * The mode, from what is known about the core.
 *
 * Kept as one function so both adapters and the self-check describe the same state
 * with the same words; three call sites each deciding what "degraded" means is how
 * a report starts disagreeing with behaviour.
 */
export function operatingMode({ coreReachable, snapshot }) {
  if (coreReachable) return { mode: 'Managed', detail: '核心可达，规则按核心实时裁决' };
  if (snapshot?.state === 'usable') {
    return { mode: 'ReadOnlySnapshot', detail: '核心不可达；按最近一次快照执行已记录的禁止项，不新增知识' };
  }
  if (snapshot?.state === 'expired') return { mode: 'Ungoverned', detail: `核心不可达，且快照已过期（${snapshot.detail}）` };
  if (snapshot?.state === 'unreadable') return { mode: 'Ungoverned', detail: `核心不可达，且快照无法读取（${snapshot.detail}）` };
  return { mode: 'Ungoverned', detail: '核心从未成功应答过，本会话不受规则约束' };
}
