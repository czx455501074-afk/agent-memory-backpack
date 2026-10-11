import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What each adapter can actually do, and in which mode.
 *
 * The design requires the two ends to be marked separately on seven capabilities —
 * reading current norms, triggering retrieval automatically, submitting candidates,
 * collecting which events, blocking which operations, notifying a rule change, and
 * associating a task reliably — and requires the UI to show the verified
 * capabilities and versions per end.
 *
 * It also requires that a capability shortfall be *displayed as a downgrade* rather
 * than reported as "everything synced". That is the same class of mistake as the
 * gate that denied everything while the core was down: a status surface that
 * overstates what is enforced is worse than no status surface, because a user
 * cannot tell which of their protections are real.
 *
 * So this module reports what is verifiable from the artefacts on disk, and says
 * `unknown` where it is not. A capability is never assumed from the presence of an
 * adapter package: having the code loaded is not the same as having the capability
 * exercised.
 */

export type CapabilityState = 'yes' | 'no' | 'unknown';

export interface AdapterCapability {
  id: 'dsh' | 'codex';
  /** Whether the adapter package is actually installed in a profile. */
  installed: boolean;
  /** Where it is installed, when it is. */
  location: string | null;
  version: string | null;
  capabilities: {
    readNorms: CapabilityState;
    autoRetrieve: CapabilityState;
    submitCandidate: CapabilityState;
    collectEvents: CapabilityState;
    /** Blocking is scoped to names the user listed; never "all operations". */
    blockOperations: CapabilityState;
    notifyRuleChange: CapabilityState;
    linkTask: CapabilityState;
  };
  notes: string[];
}

/**
 * What each adapter is built to do.
 *
 * These are properties of the adapter code, established by its implementation and
 * its tests, not observations about a running host. A capability listed as `yes`
 * here means the adapter implements it; whether the host exercised it in this
 * session is a separate question, and the notes say so where that matters.
 *
 * `blockOperations` is deliberately `partial` in prose rather than in type: the
 * gate matches normalised tool names and does not fold aliases, so it blocks the
 * names a user listed and nothing that merely resembles them. Claiming more would
 * be the overstatement this module exists to avoid.
 */
const DESIGNED: Record<'dsh' | 'codex', AdapterCapability['capabilities']> = {
  dsh: {
    readNorms: 'yes', autoRetrieve: 'yes', submitCandidate: 'yes',
    collectEvents: 'yes', blockOperations: 'yes', notifyRuleChange: 'yes', linkTask: 'yes',
  },
  codex: {
    readNorms: 'yes', autoRetrieve: 'yes', submitCandidate: 'yes',
    collectEvents: 'yes', blockOperations: 'yes', notifyRuleChange: 'yes',
    // Codex has no session-scoped task association: its hooks are one process per
    // event, so there is no place to hold "which task is this session doing". The
    // honest value is `no`, with the workaround named — not `yes` because the API
    // exists on the core.
    linkTask: 'no',
  },
};

const NOTES: Record<'dsh' | 'codex', string[]> = {
  dsh: [
    '规则门禁按规范化的工具名匹配，不做别名归并：禁止 Bash 不会连带禁止 pwsh。',
    'cwd 不在配置项目范围内时，注入与门禁都会被跳过，这是刻意的范围隔离。',
  ],
  codex: [
    'hook 每个事件是一个短进程，因此无法保存"本会话属于哪个任务"；任务关联需要在会话开始时显式调用。',
    '未信任的 hooks 不会执行：桌面信任状态必须人工确认，插件无法代劳也无法探测。',
    '注入文本由宿主标记为 developer，来源标识以文本前缀 [agent-memory-backpack] 呈现。',
  ],
};

/** Find an installed adapter package in the known profile locations. */
function locate(kind: 'dsh' | 'codex', home: string) {
  const candidates = kind === 'dsh'
    ? ['.dsh', '.codex', '.agents'].flatMap(dir => [
        join(home, dir, 'plugins', 'agent-memory-backpack'),
        join(home, dir, 'profiles', 'desktop', 'node_modules', 'dsh-agent-memory-backpack'),
      ])
    : [join(home, '.codex', 'plugins', 'cache')];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    // The version is read from the package manifest rather than assumed, so an
    // upgraded install cannot be reported as the old version.
    const manifest = kind === 'dsh' ? join(candidate, 'package.json') : null;
    if (manifest && existsSync(manifest)) {
      try { return { location: candidate, version: String(JSON.parse(readFileSync(manifest, 'utf8')).version ?? 'unknown') }; }
      catch { return { location: candidate, version: 'unknown' }; }
    }
    return { location: candidate, version: 'unknown' };
  }
  return { location: null, version: null };
}

/**
 * The capability manifest for both ends.
 *
 * `installed` is what the filesystem says; `capabilities` is what the adapter code
 * implements. Keeping those two apart is the point: a package that is present but
 * never loaded still has capabilities, and a capability that exists is not evidence
 * that a host exercised it.
 */
export function capabilityManifest(home = process.env.USERPROFILE ?? process.env.HOME ?? ''): AdapterCapability[] {
  return (['dsh', 'codex'] as const).map(kind => {
    const found = locate(kind, home);
    return {
      id: kind,
      installed: found.location !== null,
      location: found.location,
      version: found.version,
      capabilities: DESIGNED[kind],
      notes: NOTES[kind],
    };
  });
}

/**
 * The operating mode of the gate, from what is on disk.
 *
 * Mirrors `gate-cache.operatingMode` so the CLI, the page and the adapter describe
 * the same state in the same words. Computing it separately in three places is how
 * a status report starts disagreeing with behaviour.
 */
export function operatingModeFromDisk(dataDir: string, coreReachable: boolean) {
  // The snapshot file name is duplicated from the adapters' `gate-cache.mjs`
  // deliberately: the core cannot import from a package the host installs, and a
  // shared location would make one of them depend on the other's layout. A test
  // asserts the two names agree, so the duplication cannot drift unnoticed.
  const file = join(dataDir, 'gate-snapshot.json');
  if (coreReachable) return { mode: 'Managed' as const, detail: '核心可达，规则按核心实时裁决', snapshotAt: null as number | null };
  if (!existsSync(file)) {
    return { mode: 'Ungoverned' as const, detail: '核心不可达，且从未留下规则快照：本会话不受规则约束', snapshotAt: null };
  }
  try {
    const record = JSON.parse(readFileSync(file, 'utf8')) as { deniedTools?: unknown; at?: unknown };
    const at = typeof record.at === 'number' ? record.at : null;
    const count = Array.isArray(record.deniedTools) ? record.deniedTools.length : 0;
    // The 30-day window matches the adapter's; a snapshot older than that is
    // reported rather than enforced, because the prohibition may no longer be current.
    if (at === null || Date.now() - at > 30 * 86_400_000) {
      return { mode: 'Ungoverned' as const, detail: '核心不可达，且快照已过期或损坏：本会话不受规则约束', snapshotAt: at };
    }
    return {
      mode: 'ReadOnlySnapshot' as const,
      detail: `核心不可达；按最近一次快照执行 ${count} 条已记录的禁止项，不新增知识`,
      snapshotAt: at,
    };
  } catch {
    return { mode: 'Ungoverned' as const, detail: '核心不可达，且快照无法读取：本会话不受规则约束', snapshotAt: null };
  }
}
