import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { clientSchema } from './config.js';
export function isWithinProject(projectRoot, cwd) {
    if (typeof cwd !== 'string' || !isAbsolute(cwd))
        return false;
    try {
        const root = realpathSync(projectRoot);
        const current = realpathSync(cwd);
        const rel = relative(root, current);
        return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    }
    catch {
        return false;
    }
}
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
const CORE_PATH = /^\/v1\/[a-z]+(?:\/[a-z-]+)*$/;
export class CoreClientError extends Error {
    kind;
    code;
    status;
    constructor(message, kind, code, status, cause) {
        super(message, { cause });
        this.kind = kind;
        this.code = code;
        this.status = status;
        this.name = 'CoreClientError';
    }
}
export class CoreClient {
    adapter;
    config;
    constructor(config, adapter = 'codex') {
        this.adapter = adapter;
        this.config = clientSchema.parse(config);
    }
    get projectId() { return this.config.projectId; }
    /** Role of this credential, so a caller can tell whether review is permitted. */
    get role() { return this.config.role; }
    /**
     * Shape of the configured credential, for diagnostics.
     *
     * Only the length is exposed. A short prefix would still be part of the secret
     * and would make "this report contains no credential value" untrue; length is
     * enough to tell a configured token from an empty or truncated one.
     */
    get tokenShape() { return `${this.config.token.length} characters; value not printed`; }
    async post(path, body, signal) {
        if (!CORE_PATH.test(path))
            throw new Error('Unsupported core path');
        /**
         * No `cwd ⊆ projectRoot` check here, and the absence is deliberate.
         *
         * The Codex MCP server is launched by the host from the plugin directory —
         * `.mcp.json` declares `"cwd": "."` — so gating requests on the process working
         * directory refused every legitimate call and made the packaged smoke test fail
         * with "Connection closed". Measured with that gate removed, the core's own
         * enforcement is complete on its own: a credential for one project reads its own
         * entries (200) and cannot reach another's by naming its id (404), by claiming
         * its project in the envelope (403), through its norm list, through search, or by
         * submitting into it (403). The project is pinned by the credential and checked
         * server-side on every request, so cwd adds no protection to this path while
         * creating a false refusal.
         *
         * The Codex *hook* keeps its own cwd check (`projectScope` in `hook.mjs`): there
         * the working directory comes from the tool-invocation payload and is meaningful.
         * DSH likewise checks its session cwd. Those are not affected by this change.
         */
        const timeoutSignal = AbortSignal.timeout(4500);
        const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
        let response;
        try {
            response = await fetch(`${this.config.endpoint.replace(/\/$/, '')}${path}`, {
                method: 'POST', redirect: 'error', signal: requestSignal,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.token}`, 'x-amb-protocol': '1' },
                body: JSON.stringify({
                    ...body,
                    projectId: this.config.projectId,
                }),
            });
        }
        catch (cause) {
            const name = cause instanceof Error ? cause.name : '';
            const kind = name === 'TimeoutError' && timeoutSignal.aborted && timeoutSignal.reason === cause
                ? 'timeout'
                : name === 'AbortError' && signal?.aborted
                    ? 'cancelled'
                    : cause instanceof TypeError ? 'network' : 'transport';
            const code = kind === 'timeout' ? 'request_timeout'
                : kind === 'cancelled' ? 'request_cancelled'
                    : kind === 'network' ? 'network_error' : 'transport_error';
            throw new CoreClientError('Agent Memory Backpack core unavailable. Governance could not be checked.', kind, code, undefined, cause);
        }
        let result;
        try {
            result = await response.json();
        }
        catch (cause) {
            throw new CoreClientError(`Agent Memory Backpack core returned an invalid response (${response.status}, invalid_response)`, 'protocol', 'invalid_response', response.status, cause);
        }
        if (!response.ok) {
            const structuredCode = typeof result.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(result.code)
                ? result.code : undefined;
            const code = structuredCode ?? (response.status === 507 ? 'capacity_exhausted' : response.status >= 500 ? 'http5xx' : 'http4xx');
            const kind = response.status === 507
                ? 'capacity' : response.status >= 500 ? 'http5xx' : 'http4xx';
            throw new CoreClientError(`Agent Memory Backpack request rejected (${response.status}, ${code})`, kind, code, response.status);
        }
        return result;
    }
}
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
/** A revision must be a non-negative safe integer; -3 is safe but impossible. */
const isRevision = (value) => Number.isSafeInteger(value) && value >= 0;
/**
 * Validate a `/v1/prepare` response.
 *
 * Without this the MCP adapter would hand `200 {}` to the model as success while
 * the DSH and Codex adapters rejected the same body, so a broken core could feed
 * invalid knowledge in silently through one door. The rules match the DSH
 * adapter: the operating mode must be the verified one, the revision must be a
 * real non-negative integer, and the collections must be present.
 */
export function assertPrepareResponse(value) {
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
export function assertGateResponse(value) {
    if (!isRecord(value) || (value.decision !== 'allow' && value.decision !== 'deny')
        || typeof value.reason !== 'string' || !isRevision(value.knowledgeRevision)
        || typeof value.context !== 'string') {
        throw new Error('Agent Memory Backpack core returned an invalid gate response.');
    }
    return value;
}
