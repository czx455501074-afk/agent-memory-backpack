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

function identityTag(identity) {
  if (!identity) return '';
  if (typeof identity === 'string') return identity.trim();
  const project = String(identity.projectId ?? '').trim();
  const endpoint = String(identity.endpoint ?? '').trim();
  if (!project && !endpoint) return '';
  return `${project}@${endpoint}`;
}

/**
 * Record what the core last told us.
 *
 * Written on every successful gate, not once: a norm added in the meantime must be
 * reflected, or the cached policy would enforce a stale set of prohibitions.
 * Snapshots bind project and core identity to prevent cross-project policy pollution.
 */
export function saveSnapshot(dir, snapshot, identity) {
  const id = identity ?? { projectId: snapshot?.projectId, endpoint: snapshot?.endpoint };
  const targetTag = identityTag(id);
  const record = {
    projectId: snapshot?.projectId ?? id?.projectId,
    endpoint: snapshot?.endpoint ?? id?.endpoint,
    deniedTools: [...new Set(snapshot?.deniedTools ?? [])],
    revision: snapshot?.revision ?? 0,
    at: snapshot?.at ?? Date.now(),
  };

  const file = snapshotPath(dir);
  let container = {};
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        container = parsed;
      }
    } catch {}
  }

  if (targetTag) {
    if (!container.projects || typeof container.projects !== 'object' || Array.isArray(container.projects)) {
      container.projects = {};
    }
    container.projects[targetTag] = record;
  }

  container.deniedTools = record.deniedTools;
  container.revision = record.revision;
  container.at = record.at;
  if (record.projectId) container.projectId = record.projectId;
  if (record.endpoint) container.endpoint = record.endpoint;

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(container), 'utf8');
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
 * An unreadable, mismatched or over-age snapshot is reported rather than silently absent, so a
 * user asking "why is nothing enforced" gets an answer instead of a shrug.
 */
export function loadSnapshot(dir, identityOrNow, maybeNow) {
  let identity;
  let now = Date.now();
  if (typeof identityOrNow === 'number') {
    now = identityOrNow;
  } else if (identityOrNow !== undefined) {
    identity = identityOrNow;
    if (typeof maybeNow === 'number') now = maybeNow;
  }

  const file = snapshotPath(dir);
  if (!existsSync(file)) return { state: 'absent' };
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { return { state: 'unreadable', detail: error instanceof Error ? error.message : 'parse failed' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'unreadable', detail: 'shape mismatch' };

  const tag = identityTag(identity);
  let record;
  if (tag && parsed.projects && typeof parsed.projects === 'object' && !Array.isArray(parsed.projects) && parsed.projects[tag]) {
    record = parsed.projects[tag];
  } else {
    record = parsed;
  }

  if (!record || !Array.isArray(record.deniedTools)) return { state: 'unreadable', detail: 'shape mismatch' };
  if (typeof record.at !== 'number') return { state: 'unreadable', detail: 'no timestamp' };

  if (identity) {
    const targetProject = typeof identity === 'string' ? identity.trim() : String(identity.projectId ?? '').trim();
    const targetEndpoint = typeof identity === 'object' ? String(identity.endpoint ?? '').trim() : '';

    if (record.projectId && targetProject && record.projectId !== targetProject) {
      return { state: 'mismatched_identity', record, detail: `快照所属项目 (${record.projectId}) 与当前项目 (${targetProject}) 不一致` };
    }
    if (record.endpoint && targetEndpoint && record.endpoint !== targetEndpoint) {
      return { state: 'mismatched_identity', record, detail: `快照所属核心 (${record.endpoint}) 与当前核心 (${targetEndpoint}) 不一致` };
    }
  }

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
export function decideFromSnapshot(record, toolName, identity) {
  const requested = normalise(toolName);
  if (!requested) return 'deny';
  if (!record || !Array.isArray(record.deniedTools)) return 'allow';

  if (identity) {
    const targetProject = typeof identity === 'string' ? identity.trim() : String(identity.projectId ?? '').trim();
    const targetEndpoint = typeof identity === 'object' ? String(identity.endpoint ?? '').trim() : '';
    if (record.projectId && targetProject && record.projectId !== targetProject) {
      return 'allow';
    }
    if (record.endpoint && targetEndpoint && record.endpoint !== targetEndpoint) {
      return 'allow';
    }
  }

  const denied = new Set((record.deniedTools ?? []).map(normalise));
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
  if (snapshot?.state === 'mismatched_identity') {
    return { mode: 'Ungoverned', detail: `核心不可达，且快照身份不匹配（${snapshot.detail}）` };
  }
  if (snapshot?.state === 'expired') return { mode: 'Ungoverned', detail: `核心不可达，且快照已过期（${snapshot.detail}）` };
  if (snapshot?.state === 'unreadable') return { mode: 'Ungoverned', detail: `核心不可达，且快照无法读取（${snapshot.detail}）` };
  return { mode: 'Ungoverned', detail: '核心从未成功应答过，本会话不受规则约束' };
}
