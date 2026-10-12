import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Where an adapter finds its credential, and where the shared data lives.
 *
 * Both adapters must resolve to the same core and the same database, so that a
 * user's knowledge is genuinely shared rather than split across two libraries.
 * One rule produces that for every user:
 *
 *   the default is `<home>/.agent-memory-backpack`, and each adapter reads its
 *   own credential file there — `dsh-client.json` for DSH, `codex-client.json`
 *   for Codex. The files differ; the endpoint and project they name do not.
 *
 * An explicit environment variable overrides that default, which is what tests
 * and isolated runs need. But the override wins **only when it names a file that
 * exists**:
 *
 *   a stale pointer used to disable the plugin outright. A leftover AMB_CONFIG
 *   from an earlier test run then looked exactly like a broken install, and
 *   nothing in the output said why. Now the stale value is reported and the
 *   shared default is used, so a bad pointer is a warning instead of an outage.
 *
 * An identical copy of this file lives in each adapter package.
 * `test/adapter-config.test.ts` asserts the two are byte-identical, so the
 * sharing rule cannot drift between them.
 */

export const DEFAULT_DATA_DIR = () => join(homedir(), '.agent-memory-backpack');

/**
 * Environment variables that may name a credential file, most specific first.
 *
 * DSH has always accepted AMB_CONFIG as well as its own name, so both are read;
 * the adapter-specific one wins when both are set.
 */
function explicitCandidates(adapterId, env) {
  const candidates = [];
  if (adapterId === 'dsh' && env.AMB_DSH_CONFIG?.trim()) {
    candidates.push({ name: 'AMB_DSH_CONFIG', value: env.AMB_DSH_CONFIG.trim() });
  }
  if (env.AMB_CONFIG?.trim()) {
    candidates.push({ name: 'AMB_CONFIG', value: env.AMB_CONFIG.trim() });
  }
  return candidates;
}

/**
 * Resolve which credential file an adapter should read.
 *
 * Returns `{ path, source, envVar, warning }` where `source` is one of:
 *   'env'      an explicit variable named a file that exists
 *   'default'  the shared data directory
 *   'fallback' an explicit variable was set but unusable; the default is used
 *   'missing'  nothing was found; the caller reports how to create one
 */
export function resolveClientConfig(adapterId, env = process.env) {
  const dataDir = DEFAULT_DATA_DIR();
  const own = join(dataDir, `${adapterId}-client.json`);
  // Older installs wrote the Codex credential to a bare `client.json`.
  const legacy = join(dataDir, 'client.json');

  for (const candidate of explicitCandidates(adapterId, env)) {
    const path = resolve(candidate.value);
    if (existsSync(path)) {
      return Object.freeze({ path, source: 'env', envVar: candidate.name, warning: null });
    }
    const fallback = existsSync(own) ? own : legacy;
    const usable = existsSync(fallback);
    return Object.freeze({
      path: fallback,
      source: usable ? 'fallback' : 'missing',
      envVar: candidate.name,
      warning: `${candidate.name} points at ${path}, which does not exist; using ${fallback} instead.`,
    });
  }

  if (existsSync(own)) return Object.freeze({ path: own, source: 'default', envVar: null, warning: null });
  // Adopting the legacy shared file is a degraded resolution, so it is never silent:
  // that file was written for the other adapter and carries its project and role, so
  // this end could act under an identity that is not its own. Kept for installs that
  // predate the per-adapter files, but with the same visibility the explicit-pointer
  // case above has. `source` stays 'default' because the location is the shared data
  // directory; the warning is what marks the degradation.
  if (existsSync(legacy)) {
    return Object.freeze({
      path: legacy,
      source: 'default',
      envVar: null,
      warning: `No ${adapterId}-client.json in ${dataDir}; using the legacy shared client.json, which an older install wrote for the other adapter. This end may then act under that file's project or role. Run init to write a dedicated credential.`,
    });
  }
  return Object.freeze({ path: own, source: 'missing', envVar: null, warning: null });
}
