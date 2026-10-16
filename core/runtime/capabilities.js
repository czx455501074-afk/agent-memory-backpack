import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
const DESIGNED = {
    dsh: {
        readNorms: 'yes', autoRetrieve: 'yes', submitCandidate: 'yes',
        collectEvents: 'yes', blockOperations: 'yes', notifyRuleChange: 'yes', linkTask: 'yes',
    },
    codex: {
        readNorms: 'yes', autoRetrieve: 'yes', submitCandidate: 'yes',
        collectEvents: 'yes', blockOperations: 'yes', notifyRuleChange: 'yes',
        // Short-lived hooks persist session state on disk; prepare also associates the
        // session with a task in the shared core. This is a designed capability, not
        // evidence that the current desktop has loaded and exercised these hooks.
        linkTask: 'yes',
    },
};
const NOTES = {
    dsh: [
        '规则门禁按规范化的工具名匹配，不做别名归并：禁止 Bash 不会连带禁止 pwsh。',
        'cwd 不在配置项目范围内时，注入与门禁都会被跳过，这是刻意的范围隔离。',
    ],
    codex: [
        '任务关联由核心任务记录和 hook 的持久会话状态保存；需要宿主提供 sessionId。此处是代码能力，当前会话是否启用须检查实际 hook 与任务回执。',
        '未信任的 hooks 不会执行：桌面信任状态必须人工确认，插件无法代劳也无法探测。',
        '注入文本由宿主标记为 developer，来源标识以文本前缀 [agent-memory-backpack] 呈现。',
    ],
};
/**
 * Validate that a directory is genuinely an installation of this package with a readable manifest.
 * Merely existing as a cache or directory placeholder must never be counted as installed.
 */
function checkManifest(dir) {
    const manifestCandidates = ['package.json', 'plugin.json', join('.codex-plugin', 'plugin.json')];
    for (const rel of manifestCandidates) {
        const file = join(dir, rel);
        if (!existsSync(file))
            continue;
        try {
            const parsed = JSON.parse(readFileSync(file, 'utf8'));
            const name = String(parsed.name ?? parsed.id ?? '');
            const version = String(parsed.version ?? '');
            if (name.includes('agent-memory-backpack') && version && version !== 'unknown') {
                return version;
            }
        }
        catch {
            // Unparseable manifest means the directory is broken or not this package.
        }
    }
    return null;
}
/**
 * The host roots to look under, for each adapter kind.
 *
 * Detection used to derive everything from the user's home directory alone, while
 * the scripts that *deploy* the package honour `DSH_HOME` (`deploy-plugin.mjs`) and
 * `CODEX_HOME` (`amb-install.mjs`). A deployment made through either variable was
 * therefore invisible here: the plugin loaded and worked, and the capability list
 * still answered `installed: false`. Both are read for both kinds so a home
 * relocated through either variable is found.
 *
 * `AMB_PLUGIN_DIR` is a directory the package itself was placed in rather than a
 * host root, so it is handled separately.
 */
function hostRoots(kind, home) {
    const roots = new Set();
    const add = (value) => { if (value)
        roots.add(value); };
    if (kind === 'dsh') {
        if (home)
            for (const dir of ['.dsh', '.codex', '.agents'])
                add(join(home, dir));
        add(process.env.DSH_HOME);
    }
    else {
        if (home)
            add(join(home, '.codex'));
        add(process.env.CODEX_HOME);
    }
    return [...roots];
}
/** Find an installed adapter package in the known profile locations. */
function locate(kind, home) {
    if (!home && !process.env.DSH_HOME && !process.env.CODEX_HOME)
        return { location: null, version: null, leftovers: [] };
    if (kind === 'dsh') {
        const leftovers = [];
        /**
         * Every profile is scanned, not just `desktop`.
         *
         * The candidate list used to name `profiles/desktop/node_modules/...` by hand,
         * which had two consequences on a real machine: an install living in any other
         * profile (`headless`, `web`, …) was invisible, and a *stale junction* left in
         * `desktop` after an uninstall was reported as an active installation because
         * the directory still resolved to a readable manifest. Both are the same
         * mistake — answering "is the package installed" from a path's existence
         * instead of from the profile that would load it.
         *
         * A profile counts as an installation only when it both links the package and
         * declares it (a dependency or a bundle entry). A link without a declaration is
         * a leftover from an uninstall: real, worth telling the user about so they can
         * remove it, but not an installation.
         */
        // Every candidate is examined rather than stopping at the first hit. An early
        // return would report the installation and silently drop the leftovers that
        // come later in the scan order — which is precisely how the stale `desktop`
        // link stayed invisible while the report claimed a clean install.
        let installed = null;
        for (const root of hostRoots('dsh', home)) {
            const profilesDir = join(root, 'profiles');
            let profileNames = [];
            try {
                profileNames = readdirSync(profilesDir).sort();
            }
            catch {
                profileNames = [];
            }
            for (const profile of profileNames) {
                for (const packageName of ['dsh-agent-memory-backpack', 'agent-memory-backpack']) {
                    const candidate = join(profilesDir, profile, 'node_modules', packageName);
                    if (!existsSync(candidate))
                        continue;
                    const version = checkManifest(candidate);
                    if (!version)
                        continue;
                    if (declaresPackage(join(profilesDir, profile, 'package.json'), packageName)) {
                        // Keep the first declaring profile as the installation, but keep
                        // scanning so nothing else on disk goes unreported.
                        installed ??= { location: candidate, version };
                    }
                    else {
                        leftovers.push(candidate);
                    }
                }
            }
            // A plugin dropped directly into the host's plugin directory, outside any
            // profile, is still an installation if it carries a valid manifest. This is
            // the location `deploy-plugin.mjs` uses by default.
            const direct = join(root, 'plugins', 'agent-memory-backpack');
            if (existsSync(direct)) {
                const version = checkManifest(direct);
                if (version)
                    installed ??= { location: direct, version };
            }
        }
        // An explicit destination wins over a discovered one: it is where the operator
        // said the package lives, so reporting anything else would contradict the
        // deploy step they just ran.
        const explicit = process.env.AMB_PLUGIN_DIR;
        if (explicit) {
            const version = checkManifest(explicit);
            if (version)
                return { location: explicit, version, leftovers };
        }
        return { location: installed?.location ?? null, version: installed?.version ?? null, leftovers };
    }
    {
        // Codex: direct plugin directory or nested in cache/<marketplace>/agent-memory-backpack/<version>
        for (const root of hostRoots('codex', home)) {
            const direct = join(root, 'plugins', 'agent-memory-backpack');
            if (existsSync(direct)) {
                const version = checkManifest(direct);
                if (version)
                    return { location: direct, version, leftovers: [] };
            }
            const cacheRoot = join(root, 'plugins', 'cache');
            if (!existsSync(cacheRoot))
                continue;
            try {
                const entries = readdirSync(cacheRoot, { withFileTypes: true });
                for (const entry of entries) {
                    if (!entry.isDirectory())
                        continue;
                    const mpDir = join(cacheRoot, entry.name);
                    const ambDir = join(mpDir, 'agent-memory-backpack');
                    if (existsSync(ambDir)) {
                        const vEntries = readdirSync(ambDir, { withFileTypes: true });
                        for (const vEntry of vEntries) {
                            if (!vEntry.isDirectory())
                                continue;
                            const target = join(ambDir, vEntry.name);
                            const version = checkManifest(target);
                            if (version)
                                return { location: target, version, leftovers: [] };
                        }
                    }
                }
            }
            catch {
                // Directory walk failure drops to not found.
            }
        }
    }
    return { location: null, version: null, leftovers: [] };
}
/**
 * Whether a profile manifest actually declares the package.
 *
 * Presence in `dependencies` or in `dsh.profile.bundles` is what makes the host
 * load it. A linked directory alone does not: that is exactly the state an
 * uninstall leaves behind, which is why checking for it here is the difference
 * between reporting an installation and reporting a leftover.
 */
function declaresPackage(manifestPath, packageName) {
    if (!existsSync(manifestPath))
        return false;
    try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (manifest.dependencies && packageName in manifest.dependencies)
            return true;
        const bundles = manifest.dsh?.profile?.bundles;
        return Array.isArray(bundles) && bundles.includes(packageName);
    }
    catch {
        // An unreadable manifest cannot be shown to declare anything.
        return false;
    }
}
/**
 * The capability manifest for both ends.
 *
 * `installed` is what the filesystem says; `capabilities` is what the adapter code
 * implements. Keeping those two apart is the point: a package that is present but
 * never loaded still has capabilities, and a capability that exists is not evidence
 * that a host exercised it.
 */
export function capabilityManifest(home = process.env.USERPROFILE ?? process.env.HOME ?? '') {
    return ['dsh', 'codex'].map(kind => {
        const found = locate(kind, home);
        const notes = [...NOTES[kind]];
        if (!found.location) {
            notes.push(`未在宿主已知位置检测到有效的 ${kind} 适配器安装清单。`);
        }
        // A leftover is reported separately rather than folded into `installed`. It is
        // a real thing on disk the user may want to clean up, and saying nothing about
        // it is how a stale link stays behind for months; calling it an installation
        // would be the overstatement this module exists to prevent.
        if (found.leftovers.length) {
            notes.push(`发现 ${found.leftovers.length} 处残留的插件链接（已无 profile 声明，不会被加载）：`
                + `${found.leftovers.join('、')}。可在确认后删除。`);
        }
        return {
            id: kind,
            installed: found.location !== null,
            location: found.location,
            version: found.version,
            capabilities: DESIGNED[kind],
            notes,
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
export function operatingModeFromDisk(dataDir, coreReachable) {
    // The snapshot file name is duplicated from the adapters' `gate-cache.mjs`
    // deliberately: the core cannot import from a package the host installs, and a
    // shared location would make one of them depend on the other's layout. A test
    // asserts the two names agree, so the duplication cannot drift unnoticed.
    const file = join(dataDir, 'gate-snapshot.json');
    if (coreReachable)
        return { mode: 'Managed', detail: '核心可达，规则按核心实时裁决', snapshotAt: null };
    if (!existsSync(file)) {
        return { mode: 'Ungoverned', detail: '核心不可达，且从未留下规则快照：本会话不受规则约束', snapshotAt: null };
    }
    try {
        const record = JSON.parse(readFileSync(file, 'utf8'));
        // Shape mismatch must not be accepted as a valid snapshot; mirrors loadSnapshot shape checks.
        if (!record || typeof record !== 'object' || !Array.isArray(record.deniedTools) || typeof record.at !== 'number') {
            return { mode: 'Ungoverned', detail: '核心不可达，且快照格式错误：本会话不受规则约束', snapshotAt: null };
        }
        const at = record.at;
        const count = record.deniedTools.length;
        // The 30-day window matches the adapter's; a snapshot older than that is
        // reported rather than enforced, because the prohibition may no longer be current.
        if (Date.now() - at > 30 * 86_400_000) {
            return { mode: 'Ungoverned', detail: '核心不可达，且快照已过期或损坏：本会话不受规则约束', snapshotAt: at };
        }
        return {
            mode: 'ReadOnlySnapshot',
            detail: `核心不可达；按最近一次快照执行 ${count} 条已记录的禁止项，不新增知识`,
            snapshotAt: at,
        };
    }
    catch {
        return { mode: 'Ungoverned', detail: '核心不可达，且快照无法读取：本会话不受规则约束', snapshotAt: null };
    }
}
