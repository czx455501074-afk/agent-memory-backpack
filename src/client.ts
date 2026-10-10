import { clientSchema, type ClientConfig } from './config.js';

/**
 * Core paths this client may call.
 *
 * The whitelist exists to stop a caller from aiming the credentialed client at
 * an arbitrary URL. It must still cover every real endpoint, including nested
 * ones: an earlier single-segment pattern silently blocked 14 of 22 endpoints
 * (`/v1/knowledge/*`, `/v1/proposals/*`, `/v1/rescan/*`, `/v1/tasks/*`), which
 * made half the tool surface fail at runtime instead of at review time.
 *
 * Segments are restricted to lowercase words so a path can never introduce a
 * traversal, a query, or an absolute URL.
 */
const CORE_PATH = /^\/v1\/[a-z]+(?:\/[a-z]+)*$/;

export class CoreClient {
  private readonly config: ClientConfig;
  constructor(config: ClientConfig, readonly adapter: 'codex' | 'dsh' | 'admin' = 'codex') { this.config = clientSchema.parse(config); }
  get projectId() { return this.config.projectId; }
  /** Role of this credential, so a caller can tell whether review is permitted. */
  get role(): 'adapter' | 'admin' { return this.config.role; }
  /**
   * Shape of the configured credential, for diagnostics.
   *
   * Only the length is exposed. A short prefix would still be part of the secret
   * and would make "this report contains no credential value" untrue; length is
   * enough to tell a configured token from an empty or truncated one.
   */
  get tokenShape() { return `${this.config.token.length} characters; value not printed`; }
  async post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!CORE_PATH.test(path)) throw new Error('Unsupported core path');
    let response: Response;
    try {
      response = await fetch(`${this.config.endpoint.replace(/\/$/, '')}${path}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4500),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.token}`, 'x-amb-protocol': '1' },
        body: JSON.stringify({ ...body, projectId: this.config.projectId }),
      });
    } catch { throw new Error('Agent Memory Backpack core unavailable. Governance could not be checked.'); }
    let result: Record<string, unknown>;
    try { result = await response.json() as Record<string, unknown>; } catch { throw new Error('Agent Memory Backpack core returned an invalid response'); }
    if (!response.ok) {
      // The core's message is carried through when present. A bare status code
      // leaves an agent with nothing to act on, and for a refusal such as
      // "this needs the admin credential, submit a candidate instead" the message
      // *is* the guidance.
      const code = String(result.code ?? 'unknown');
      const detail = typeof result.message === 'string' && result.message ? `: ${result.message}` : '';
      throw new Error(`Agent Memory Backpack request rejected (${response.status}, ${code})${detail}`);
    }
    return result;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A revision must be a non-negative safe integer; -3 is safe but impossible. */
const isRevision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/**
 * Validate a `/v1/prepare` response.
 *
 * Without this the MCP adapter would hand `200 {}` to the model as success while
 * the DSH and Codex adapters rejected the same body, so a broken core could feed
 * invalid knowledge in silently through one door. The rules match the DSH
 * adapter: the operating mode must be the verified one, the revision must be a
 * real non-negative integer, and the collections must be present.
 */
export function assertPrepareResponse(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || value.protocolVersion !== 1 || !isRevision(value.knowledgeRevision)
    || value.mode !== 'Managed' || !Array.isArray(value.norms) || !Array.isArray(value.workflows)
    || typeof value.context !== 'string') {
    throw new Error('Agent Memory Backpack core returned an invalid prepare response.');
  }
  if (value.knowledge !== undefined && !Array.isArray(value.knowledge)) {
    throw new Error('Agent Memory Backpack core returned an invalid prepare response.');
  }
  return value;
}

/** Validate a `/v1/gate` response so a malformed verdict is never read as "allow". */
export function assertGateResponse(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || (value.decision !== 'allow' && value.decision !== 'deny')
    || typeof value.reason !== 'string' || !isRevision(value.knowledgeRevision)
    || typeof value.context !== 'string') {
    throw new Error('Agent Memory Backpack core returned an invalid gate response.');
  }
  return value;
}
