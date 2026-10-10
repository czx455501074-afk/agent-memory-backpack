import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

/**
 * Make sure the shared core is running, starting it when it is not.
 *
 * The core is a local HTTP service, but a user should never have to know that.
 * Requiring a separate terminal turns a plugin into an operation, and the
 * failure mode is the worst kind: the adapter loads, every tool call fails, and
 * nothing says why. So an adapter starts the core itself.
 *
 * Three rules keep that from becoming its own problem:
 *
 *   - **Probe first.** Another adapter, an earlier session, or the console may
 *     already have started it. Starting a second core would fail on the port, so
 *     the first step is always a health request.
 *   - **Detached and unref'd.** The core outlives the adapter that started it,
 *     because the other desktop still needs it. It is a shared service, not a
 *     child of one plugin.
 *   - **Never throw.** A core that will not start is reported to the caller to
 *     log, not raised into the host's plugin loader. Rethrowing would make one
 *     missing file look like a broken plugin, and the adapter's own tools
 *     already report an unreachable core clearly.
 *
 * An identical copy of this file lives in each adapter package.
 * `test/adapter-core.test.ts` asserts the two are byte-identical and exercises
 * the start path against a real core.
 */

/** A health request must be quick: this runs on a user's first tool call. */
const PROBE_TIMEOUT_MS = 1_000;
/** How long to wait for a core we started ourselves to report healthy. */
const READY_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 250;

function delay(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

/** True when something at this endpoint answers the health check. */
export async function coreIsRunning(endpoint, fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    const response = await fetchImpl(`${endpoint}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Ensure a core is listening, starting one if necessary.
 *
 * `signal` cancels the wait. The caller ties it to the plugin's lifecycle, so an
 * unloaded plugin stops waiting — a poll that outlives its plugin is both a leak
 * and, in tests, an asynchronous activity reported after the test ended.
 *
 * Returns `{ started, reason, detail? }`. `reason` is one of:
 *   'already-running'  nothing to do
 *   'started'          we launched it and it became healthy
 *   'not-initialized'  no core.json, so serving would fail immediately
 *   'core-entry-missing' the packaged runtime is absent
 *   'spawn-failed'     the process could not be created
 *   'exited'           the process we started died
 *   'cancelled'        the caller disposed while we were waiting
 *   'timeout'          launched, but it never reported healthy
 */
export async function ensureCoreRunning(options) {
  const { endpoint, dataDir, coreEntry, fetchImpl = fetch, signal } = options;

  if (await coreIsRunning(endpoint, fetchImpl)) {
    return { started: false, reason: 'already-running' };
  }
  // Checked before spawning: `serve` reads core.json and exits without it, so
  // launching would produce a confusing timeout instead of a clear cause.
  if (!existsSync(join(dataDir, 'core.json'))) {
    return { started: false, reason: 'not-initialized', detail: dataDir };
  }
  if (!existsSync(coreEntry)) {
    return { started: false, reason: 'core-entry-missing', detail: coreEntry };
  }

  let child;
  try {
    child = spawn(process.execPath, [coreEntry, 'serve', '--data-dir', dataDir], {
      // Detached so it survives this adapter, and silent because its own log is
      // the record — see `log.js` in the core.
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch (error) {
    return { started: false, reason: 'spawn-failed', detail: error instanceof Error ? error.message : 'unknown' };
  }

  // Poll rather than sleep a fixed amount: a warm start is much faster than a
  // cold one, and a fixed wait makes the first tool call feel slow for no reason.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) return { started: false, reason: 'cancelled' };
    await delay(POLL_INTERVAL_MS);
    // Another adapter may win the race and bind the port; that is a success for
    // us too, which is why this re-probes instead of checking our own child.
    if (await coreIsRunning(endpoint, fetchImpl)) return { started: true, reason: 'started' };
    // If our child died, more waiting cannot help — unless another one took over,
    // which the probe above would already have caught.
    if (child.exitCode !== null && child.exitCode !== 0) {
      return { started: false, reason: 'exited', detail: `exit code ${child.exitCode}` };
    }
  }
  return { started: false, reason: 'timeout' };
}
