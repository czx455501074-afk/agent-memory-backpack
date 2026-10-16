import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
export const lockPath = (dataDir) => join(dataDir, 'core.lock');
/**
 * Whether a process is alive.
 *
 * Signal 0 performs the permission check without delivering a signal. It throws
 * for a dead process, which is the answer, and also for one owned by another user
 * — treated as alive, because "I cannot signal it" is not "it is gone", and the
 * consequence of guessing wrong is two cores on one port.
 */
export function processAlive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === 'EPERM';
    }
}
/** Read the lock and say whether the core it names is actually running. */
export function inspectLock(dataDir) {
    const file = lockPath(dataDir);
    if (!existsSync(file))
        return { state: 'absent' };
    let info;
    try {
        info = JSON.parse(readFileSync(file, 'utf8'));
    }
    catch (error) {
        return { state: 'unreadable', detail: error instanceof Error ? error.message : 'unknown' };
    }
    return { state: processAlive(info.pid) ? 'held' : 'stale', info };
}
/**
 * Take the lock, or report who holds it.
 *
 * `wx` is the whole mechanism: it fails if the file exists, and the check and the
 * create are one operation, so two processes starting together cannot both win.
 * A stale lock is cleared first — its owner is gone, and refusing to start because
 * of a file a crash left behind would need manual intervention for no reason.
 */
export function acquireLock(dataDir, info) {
    mkdirSync(dataDir, { recursive: true });
    const file = lockPath(dataDir);
    const attempt = () => {
        try {
            const fd = openSync(file, 'wx', 0o600);
            writeSync(fd, JSON.stringify(info));
            closeSync(fd);
            return { acquired: true };
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            const existing = inspectLock(dataDir);
            if (existing.state === 'held')
                return { acquired: false, heldBy: existing.info };
            // Stale or unreadable: neither can be a live core, so it is replaced and the
            // fact reported, rather than left for the user to discover.
            rmSync(file, { force: true });
            try {
                const fd = openSync(file, 'wx', 0o600);
                writeSync(fd, JSON.stringify(info));
                closeSync(fd);
                return { acquired: true, clearedStale: existing.state === 'stale' ? existing.info : undefined };
            }
            catch (retry) {
                if (retry.code === 'EEXIST') {
                    const now = inspectLock(dataDir);
                    return { acquired: false, heldBy: now.state === 'held' ? now.info : undefined };
                }
                throw retry;
            }
        }
    };
    return attempt();
}
export function releaseLock(dataDir, pid = process.pid) {
    const file = lockPath(dataDir);
    const state = inspectLock(dataDir);
    // Only the owner removes it: a second core that failed to acquire must not
    // delete the winner's lock on its way out.
    if (state.state === 'held' && state.info.pid !== pid)
        return;
    if (state.state === 'absent')
        return;
    rmSync(file, { force: true });
}
/** After a crash, one call clears the leftover lock so the next start is clean. */
export function recoverStale(dataDir) {
    const state = inspectLock(dataDir);
    if (state.state !== 'stale')
        return { recovered: false };
    rmSync(lockPath(dataDir), { force: true });
    return { recovered: true, previous: state.info };
}
/**
 * Start the core detached, so it outlives this process and the terminal it ran in.
 *
 * The child is `unref`ed: whoever asked for a resident core should be able to exit
 * without stopping it, which is the difference between a service and a foreground
 * command.
 */
export function startDetached(coreEntry, dataDir, logFile) {
    mkdirSync(join(logFile, '..'), { recursive: true });
    const out = openSync(logFile, 'a');
    const child = spawn(process.execPath, [coreEntry, 'serve', '--data-dir', dataDir], {
        detached: true,
        stdio: ['ignore', out, out],
        windowsHide: true,
    });
    child.unref();
    return { pid: child.pid };
}
/** Stop the core named by the lock, and only that process. */
export function stopFromLock(dataDir) {
    const state = inspectLock(dataDir);
    if (state.state === 'absent')
        return { stopped: false, detail: '没有找到锁文件，核心可能未在运行。' };
    if (state.state === 'stale') {
        rmSync(lockPath(dataDir), { force: true });
        return { stopped: false, detail: '锁是陈旧的，已清理；没有正在运行的核心。' };
    }
    if (state.state === 'unreadable')
        return { stopped: false, detail: `锁文件无法解析：${state.detail}` };
    try {
        process.kill(state.info.pid, 'SIGTERM');
        return { stopped: true, pid: state.info.pid };
    }
    catch (error) {
        return { stopped: false, pid: state.info.pid, detail: error instanceof Error ? error.message : 'unknown' };
    }
}
/**
 * A health probe that does not need the credential.
 *
 * `/health` is deliberately unauthenticated — it exists so liveness can be checked
 * without handing a credential to whoever is asking. The probe therefore tells us
 * the core is up, not that the knowledge is readable; those are different claims.
 *
 * "Is the core up" is narrower than "something answered 200". A redirect or an
 * unrelated local service returning a JSON body was previously taken as a live
 * core, so a mistyped or hijacked endpoint could report healthy while no
 * knowledge plugin was listening at all. The two properties that actually
 * identify the protocol are therefore required together: the version field and
 * the plugin's own status marker, and redirects are refused rather than followed
 * — a redirect means this origin is not the core, so following it would be
 * testing a different machine than the one configured.
 */
export async function probeHealth(endpoint, timeoutMs = 1500) {
    try {
        const response = await fetch(`${endpoint.replace(/\/$/, '')}/health`, {
            signal: AbortSignal.timeout(timeoutMs),
            // Refused, not followed: the configured endpoint is the core, and a
            // redirect proves it is not.
            redirect: 'error',
        });
        if (!response.ok)
            return { healthy: false, detail: `HTTP ${response.status}` };
        let body;
        try {
            body = await response.json();
        }
        catch {
            return { healthy: false, detail: '响应不是 JSON，不是本插件核心' };
        }
        if (body.protocolVersion !== 1)
            return { healthy: false, detail: `协议版本不符：${String(body.protocolVersion)}` };
        // The core's own marker. Without it, any local service that answers with a
        // numeric `protocolVersion` would be reported as this core.
        if (body.status !== 'ok')
            return { healthy: false, detail: `状态标识不符：${String(body.status)}` };
        return { healthy: true, detail: `协议 v${body.protocolVersion}，状态 ${String(body.status)}` };
    }
    catch (error) {
        return { healthy: false, detail: error instanceof Error ? error.message : 'unreachable' };
    }
}
/**
 * Login startup, as a per-user `Run` entry.
 *
 * A scheduled task was tried first and removed, because it does not work for the
 * user this plugin is for. `schtasks /Create /SC ONLOGON` failed with access
 * denied on a real machine: creating a logon-triggered task requires elevation,
 * and the design says user-level — a plugin that needs administrator rights to
 * install is not one a user can install.
 *
 * `HKCU\...\Run` is the mechanism that matches the requirement. It applies to the
 * current user only, needs no elevation, is queryable, and is removed by deleting
 * one value — which matters because the uninstaller is expected to undo it.
 *
 * The identifier is spelled out in the value name so a user browsing their own
 * startup entries can tell what put it there.
 */
export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const RUN_VALUE = 'AgentMemoryBackpackCore';
/**
 * The key the startup entry is written under.
 *
 * Normally the per-user `Run` key. `AMB_RUN_KEY` overrides it so a test can
 * register, query and remove against a scratch key instead of the user's live
 * startup list — which matters because the entry is a real registry write, and
 * the only honest alternative to a scratch key is an exact save-and-restore of
 * whatever the user already had there. Targeting another key deliberately is
 * also what an operator packaging a non-standard install would need.
 */
function runKey() {
    const override = (process.env.AMB_RUN_KEY ?? '').trim();
    return override || RUN_KEY;
}
export function loginStartupSupported() { return process.platform === 'win32'; }
export function registerLoginStartup(coreEntry, dataDir) {
    if (!loginStartupSupported())
        return { ok: false, detail: '登录启动目前只为 Windows 实现。' };
    // Quoted so a path containing a space survives; the launcher passes this string
    // to the shell at logon, which is why it is built rather than passed as argv.
    const command = `"${process.execPath}" "${coreEntry}" serve --data-dir "${dataDir}"`;
    const result = spawnSync('reg', ['add', runKey(), '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', command, '/f'], {
        encoding: 'utf8', windowsHide: true,
    });
    if (result.status !== 0) {
        // Reported verbatim: a startup entry that was not created is something the
        // user would otherwise discover at the next logon, long after the moment they
        // could have been told.
        return { ok: false, detail: (result.stderr || result.stdout || 'reg add failed').trim() };
    }
    return { ok: true, detail: `已注册登录启动（当前用户 Run 键，无需管理员权限）。` };
}
export function unregisterLoginStartup() {
    if (!loginStartupSupported())
        return { ok: true, detail: '非 Windows，无需清理。' };
    // Checked first rather than matched against the error text. `reg delete` fails
    // when the value is absent, and its message is printed in the console code page —
    // on a Chinese Windows the output is bytes this process cannot match against any
    // English or Chinese pattern, so a text-based test reported a clean uninstall as
    // a failure. Querying is deterministic and locale-independent.
    if (!loginStartupStatus().registered)
        return { ok: true, detail: '登录启动本来就没有注册。' };
    const result = spawnSync('reg', ['delete', runKey(), '/v', RUN_VALUE, '/f'], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0)
        return { ok: false, detail: (result.stderr || result.stdout || 'reg delete failed').trim() };
    return { ok: true, detail: '已移除登录启动。' };
}
export function loginStartupStatus() {
    if (!loginStartupSupported())
        return { registered: false, detail: '非 Windows。' };
    // Existence is taken from the exit code, not from parsing the output: `reg query`
    // prints in the console code page, and a Chinese Windows would return bytes this
    // process cannot match against an English pattern.
    const result = spawnSync('reg', ['query', runKey(), '/v', RUN_VALUE], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0)
        return { registered: false, detail: '未注册登录启动。' };
    const command = /REG_SZ\s+(.+)/.exec(result.stdout ?? '')?.[1]?.trim();
    return { registered: true, detail: command ? `已注册登录启动：${command}` : '已注册登录启动。' };
}
