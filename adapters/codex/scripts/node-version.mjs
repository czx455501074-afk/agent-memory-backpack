/**
 * Shared Node version validation for Codex adapter entry points (MCP & hooks).
 *
 * package.json engines specifies "node": ">=24.13.0 <25".
 * If the runtime Node version falls outside this range, the adapter must fail explicitly
 * with actionable guidance rather than executing under an unsupported environment.
 */

export function parseNodeVersion(versionString) {
  const raw = String(versionString ?? '').trim().replace(/^v/, '');
  const match = raw.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw,
  };
}

export function checkNodeVersion(versionOverride) {
  const versionString = versionOverride || process.env.AMB_TEST_NODE_VERSION || process.versions.node;
  const parsed = parseNodeVersion(versionString);
  if (!parsed) {
    return {
      ok: false,
      version: String(versionString),
      error: `Agent Memory Backpack: 无法解析 Node 版本 "${versionString}"。需要 Node >=24.13.0 <25。`,
    };
  }

  // Supported range: >=24.13.0 <25
  const isSupported = parsed.major === 24 && parsed.minor >= 13;
  if (!isSupported) {
    return {
      ok: false,
      version: parsed.raw,
      error: `Agent Memory Backpack 需要 Node 24.x（>=24.13.0 <25），当前运行版本为 v${parsed.raw}。请让宿主使用支持的 Node 24 运行时启动。`,
    };
  }

  return { ok: true, version: parsed.raw };
}

export function assertSupportedNodeVersion(versionOverride) {
  const check = checkNodeVersion(versionOverride);
  if (!check.ok) {
    throw new Error(check.error);
  }
}
