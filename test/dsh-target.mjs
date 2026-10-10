import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Version policy for the host runtime used by the integration tests.
 *
 * The adapter is not pinned to one build: a host upgrade must not brick it, and
 * a host downgrade must not silently run against an untested contract either.
 * So the tests accept any version inside the supported range and treat the
 * version actually exercised as the *verified* one, reporting a mismatch as a
 * warning rather than a failure.
 */
export const verifiedVersion = '0.2.0-rc.2';
/** Range the adapter is expected to work with; see adapters/dsh/package.json. */
export const supportedRange = { min: '0.2.0-rc.1', max: '0.3.0' };

export const runtimeRoot = process.env.DSH_PROFILE_NODE_MODULES ?? resolve(
  dirname(fileURLToPath(import.meta.url)), '../.local/dsh-runtime-0.2.0-rc.2/node_modules',
);

const REQUIRED = ['dsh-agent', 'dsh-tools', 'dsh-system-prompt', 'dsh-llm', 'dsh-app-boot'];

/**
 * Parse a semver-ish version, including prerelease tags like `0.2.0-rc.2`.
 *
 * Compared as (major, minor, patch, prerelease). A prerelease sorts below its
 * release, so `0.2.0-rc.1 < 0.2.0`, which matches semver precedence.
 */
export function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(value).trim());
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ?? '' };
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return undefined;
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  // A release outranks any prerelease of the same numbers.
  if (!a.pre && !b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre === b.pre ? 0 : (a.pre < b.pre ? -1 : 1);
}

export function isSupported(version, range = supportedRange) {
  const low = compareVersions(version, range.min);
  const high = compareVersions(version, range.max);
  if (low === undefined || high === undefined) return undefined;
  return low >= 0 && high < 0;
}

/**
 * Probe the isolated runtime fixture without throwing.
 *
 * A clone of this repository has no extracted desktop runtime, so host tests
 * skip with an explicit reason instead of failing at import time. A runtime
 * outside the supported range still fails loudly: running the integration tests
 * against an untested contract would produce misleading passes.
 */
export function inspectRuntime() {
  for (const name of REQUIRED) {
    const file = resolve(runtimeRoot, '@deepseek-ai', name, 'package.json');
    if (!existsSync(file)) {
      return {
        available: false,
        reason: `Exact desktop runtime not extracted: ${file}. Run scripts/extract-dsh-runtime.py against an installed desktop app, or set DSH_PROFILE_NODE_MODULES to a directory holding @deepseek-ai/* ${verifiedVersion}.`,
      };
    }
  }

  let version;
  for (const name of REQUIRED) {
    const file = resolve(runtimeRoot, '@deepseek-ai', name, 'package.json');
    let manifest;
    try { manifest = JSON.parse(readFileSync(file, 'utf8')); }
    catch { return { available: false, reason: `Unreadable runtime manifest: ${file}` }; }
    version = manifest.version;
    const supported = isSupported(version);
    if (supported === undefined) {
      return { available: false, reason: `Unparseable runtime version for ${name}: ${String(version)}` };
    }
    if (!supported) {
      throw new Error(
        `Unsupported DSH runtime: ${name} ${version}; adapter supports >=${supportedRange.min} <${supportedRange.max}. `
        + `Fix the adapter or extract a supported runtime.`,
      );
    }
  }

  return {
    available: true,
    reason: '',
    version,
    verified: version === verifiedVersion,
    note: version === verifiedVersion
      ? `runtime ${version} matches the verified build`
      : `runtime ${version} is inside the supported range but differs from the verified ${verifiedVersion}`,
  };
}

export function requireRuntime() {
  const probe = inspectRuntime();
  if (!probe.available) throw new Error(probe.reason);
  return runtimeRoot;
}
