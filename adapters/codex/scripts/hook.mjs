#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapterLogger } from "./log.mjs";
import { resolveClientConfig } from "./resolve-config.mjs";
import { ensureCoreRunning } from "./ensure-core.mjs";
import { checkShellWriteBypass, decideFromSnapshot, loadSnapshot, operatingMode, saveSnapshot } from "./gate-cache.mjs";
import { checkNodeVersion } from "./node-version.mjs";
import { loadSpool, spoolEnqueue, spoolReplay } from "./spool.mjs";
import { captureFailure, failureCandidate } from "./failure-capture.mjs";
import { captureMaterial, replayMaterials } from "./material-capture.mjs";
import { isContinuationQuery, recallKnowledge } from "./recall.mjs";

const MAX_STDIN_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 4500;
const MAX_REASON_LENGTH = 500;
const PRE_TOOL_USE = "PreToolUse";
/**
 * Marks the origin of injected context.
 *
 * DSH carries the source as a structured field, which a reader can filter on.
 * Codex hooks can only return text, and the host labels it by its own rule, so
 * without a marker an acceptance check cannot tell whether the content came from
 * this plugin or from the model itself. The value matches the DSH source name.
 */
const SOURCE_MARKER = "[agent-memory-backpack]";
const SUPPORTED_EVENTS = new Set([
  "SessionStart",
  "UserPromptSubmit",
  PRE_TOOL_USE,
  "PostToolUse",
  "Stop",
]);

/**
 * This hook is a short-lived process, one per host event, so the logger is created
 * per invocation rather than kept in module scope. It shares the implementation
 * with the DSH adapter (the two files are asserted identical) so a failure looks
 * the same in either host's log.
 */
const logger = createAdapterLogger();

function fail(message) {
  process.stderr.write(`Agent Memory Backpack Codex hook failed: ${message}\n`);
  process.exitCode = 1;
}

async function readInput() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > MAX_STDIN_BYTES) throw new Error("Hook input is too large");
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) throw new Error("Hook input is empty");
  const input = JSON.parse(raw);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Hook input must be a JSON object");
  }
  return input;
}

function readScopeConfig() {
  // Resolution lives in the shared module so both adapters land on the same
  // core and the same database. A stale AMB_CONFIG now falls back to the shared
  // default and reports why, instead of disabling the plugin with no explanation.
  const resolved = resolveClientConfig('codex');
  if (resolved.warning) process.stderr.write(`Agent Memory Backpack: ${resolved.warning}\n`);
  const path = resolved.path;

  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { diagnostic: "client configuration is unavailable or invalid" };
  }

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { diagnostic: "client configuration is unavailable or invalid" };
  }
  if (config.projectRoot !== undefined && config.projectRoot !== null && (typeof config.projectRoot !== "string" || !isAbsolute(config.projectRoot))) {
    return { diagnostic: "client configuration has invalid projectRoot" };
  }

  return { config, projectRoot: (typeof config.projectRoot === "string" && config.projectRoot.trim()) ? config.projectRoot : null, configPath: path };
}

function loadConfig(config, configPath) {
  if (config.autoCaptureMaterial !== undefined && typeof config.autoCaptureMaterial !== 'boolean') {
    throw new Error('autoCaptureMaterial must be a boolean when configured');
  }
  if (config.autoCaptureFailures !== undefined && typeof config.autoCaptureFailures !== 'boolean') {
    throw new Error('autoCaptureFailures must be a boolean when configured');
  }
  if (typeof config.projectId !== "string" || !config.projectId.trim()) {
    throw new Error("Agent Memory Backpack client configuration requires projectId");
  }
  if (typeof config.token !== "string" || !config.token.trim()) {
    throw new Error("Agent Memory Backpack client configuration requires token");
  }
  if (typeof config.endpoint !== "string") {
    throw new Error("Agent Memory Backpack client configuration requires endpoint");
  }

  let endpoint;
  try {
    endpoint = new URL(config.endpoint);
  } catch {
    throw new Error("Agent Memory Backpack endpoint is invalid");
  }
  const hostname = endpoint.hostname.toLowerCase();
  const loopback = hostname === "127.0.0.1";
  if (
    endpoint.protocol !== "http:" ||
    !loopback ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/"
  ) {
    throw new Error("Agent Memory Backpack endpoint must be an HTTP loopback origin");
  }

  return {
    endpoint,
    token: config.token,
    projectId: config.projectId.trim(),
    projectRoot: config.projectRoot,
    autoCaptureFailures: config.autoCaptureFailures !== false,
    autoCaptureMaterial: config.autoCaptureMaterial !== false,
    // The credential's directory is where the shared database lives, which the
    // core needs when it has to be started.
    dataDir: dirname(configPath),
  };
}

/**
 * Start the shared core for this session if nothing is listening yet.
 *
 * Only called on SessionStart. This hook is one short-lived process per event,
 * so spawning on every prompt or tool call would race many attempts at a single
 * port; a session start fires once and early enough that the first tool call
 * already finds the core warm.
 *
 * Failures are logged, never raised: a core that will not start must not look
 * like a broken plugin, and the gate path already reports an unreachable core
 * as a clear refusal.
 */
async function startCoreIfNeeded(config, logger) {
  const coreEntry = [join(dirname(fileURLToPath(import.meta.url)), "..", "runtime", "cli.js")]
    .find((path) => existsSync(path));
  try {
    const outcome = await ensureCoreRunning({
      endpoint: config.endpoint.origin,
      dataDir: config.dataDir,
      coreEntry: coreEntry ?? join(dirname(fileURLToPath(import.meta.url)), "..", "runtime", "cli.js"),
    });
    if (outcome.started) logger.info("core.started", { endpoint: config.endpoint.origin });
    else if (outcome.reason !== "already-running") {
      logger.warn("core.start_failed", { reason: outcome.reason, detail: outcome.detail ?? "" });
    }
  } catch (error) {
    logger.warn("core.start_failed", { reason: "unexpected", detail: error instanceof Error ? error.message : "unknown" });
  }
}

function projectScope(input, projectRoot) {
  if (typeof input.cwd !== "string" || !isAbsolute(input.cwd)) return "unknown";
  try {
    const root = realpathSync(projectRoot);
    const cwd = realpathSync(input.cwd);
    const pathFromRoot = relative(root, cwd);
    return pathFromRoot === "" ||
      (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
      ? "inside"
      : "outside";
  } catch {
    return "unknown";
  }
}

function diagnoseSkip(message) {
  process.stderr.write(`Agent Memory Backpack Codex hook skipped: ${message}.\n`);
}

/**
 * A knowledge revision must be a non-negative safe integer.
 *
 * `Number.isSafeInteger(-3)` is true, so a bare safe-integer check let a
 * negative revision through — a value the core can never produce. Rejecting it
 * here means a malformed response fails visibly instead of being used.
 */
function isRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function redact(value, token) {
  let text = String(value ?? "");
  if (token) text = text.split(token).join("[redacted]");
  return text.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]");
}

function safeReason(value, token) {
  const reason = redact(
    typeof value === "string" ? value : "The project policy denied this tool call.",
    token,
  )
    .replace(/[\r\n\t]/g, " ")
    .trim()
    .slice(0, MAX_REASON_LENGTH);
  return reason || "The project policy denied this tool call.";
}

/**
 * Every failure this hook raises, carrying what a caller must branch on.
 *
 * Mirrors the DSH adapter's `CoreClientError` (adapters/dsh/core-client.mjs) so a
 * failure looks the same in either host: `kind` names the class, `code` is the
 * controlled machine-readable reason, and `status` is the HTTP status when there
 * was one. The message is a fixed template plus that status and code only - the
 * core's free-form `message` is never copied in, because a hook error reaches the
 * adapter log and the host's stderr and server text may echo a payload or a path.
 */
class CoreClientError extends Error {
  constructor(message, kind, code, status, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CoreClientError";
    this.kind = kind;
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/** Kinds a later attempt may still survive, and which may therefore be queued. */
const RETRYABLE_KINDS = new Set(["timeout", "network", "transport", "http5xx", "capacity"]);

/**
 * Whether a failed delivery is worth queueing or replaying.
 *
 * `http4xx` (including 426), `protocol` and `cancelled` are decisions rather than
 * faults: queueing one guarantees a replay that fails the same way. Errors with no
 * `kind` fall back to their status, then to their message.
 */
function isRetryableClientError(error) {
  if (!error) return false;
  if (typeof error.kind === "string") return RETRYABLE_KINDS.has(error.kind);
  if (error.name === "AbortError") return false;
  const status = error.status ?? error.statusCode;
  if (typeof status === "number") return status === 507 || status >= 500;
  const message = error instanceof Error ? error.message : String(error);
  return !(/\bHTTP\s*4\d\d\b/.test(message) || message.includes("protocol version mismatch"));
}

/** Whether the caller (or hook teardown) withdrew the request. */
function isCancelledClientError(error) {
  if (!error) return false;
  return error.kind === "cancelled" || error.name === "AbortError";
}

/**
 * Failure metadata kept with a spooled item: kind, code, status, reason, at.
 *
 * `reason` is this hook's own template message, never a server-supplied string, so
 * the spool file cannot become a place where a payload or a path is written.
 */
/** Map an HTTP status to the kind that describes it (507 is capacity). */
function statusKind(status) {
  return status === 507 ? "capacity" : status >= 500 ? "http5xx" : "http4xx";
}

function clientFailureMeta(error) {
  const status = Number(error?.status ?? error?.statusCode);
  const reason = String(error instanceof Error ? error.message : error ?? "").slice(0, 2000);
  const fromMessage = /\bHTTP\s*(\d{3})\b/.exec(reason);
  const meta = {
    // An error from an older build carries neither kind nor status, so its
    // `HTTP <n>` message is read instead: a legacy 4xx must still be recognised as
    // permanent by the replay logic rather than retried until the attempt cap.
    kind: typeof error?.kind === "string" && error.kind
      ? error.kind
      : Number.isFinite(status) && status > 0 ? statusKind(status)
        : fromMessage ? statusKind(Number(fromMessage[1])) : "unknown",
    at: Date.now(),
  };
  if (typeof error?.code === "string" && error.code) meta.code = error.code;
  if (Number.isFinite(status) && status > 0) meta.status = status;
  else if (fromMessage) meta.status = Number(fromMessage[1]);
  meta.reason = reason;
  return meta;
}

/** Cap on the core's message that is carried into an error. */
const MAX_SERVER_MESSAGE_CHARS = 500;

/**
 * The core's own message, made safe to carry.
 *
 * The server's text is the actionable half of a refusal: it names the missing
 * dependency, the conflicting key or the field that was wrong. It is therefore
 * kept, not dropped. What is removed is anything credential-shaped - this hook's
 * own token, a `Bearer` header, a `password=`/`api_key=` pair, a long base64 or hex
 * blob, and a body that is nothing but a JSON dump - because a hook error reaches
 * the adapter log and the host's stderr. The result is capped so a chatty core
 * cannot push the error into unbounded output.
 */
function sanitizeServerMessage(value, token) {
  if (typeof value !== "string") return "";
  let text = value;
  if (typeof token === "string" && token) text = text.split(token).join("[redacted]");
  text = text
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|authorization)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1$2[redacted]")
    .replace(/[A-Za-z0-9+/=_-]{40,}/g, "[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  if (!text) return "";
  // A body that is nothing but a JSON dump is a payload echo, not guidance.
  if (/^[[{]/.test(text) && text.length > 200) return "[redacted-json]";
  return text.slice(0, MAX_SERVER_MESSAGE_CHARS);
}

async function post(config, route, payload, options = {}) {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const requestSignal = options.signal
    ? AbortSignal.any([timeoutSignal, options.signal])
    : timeoutSignal;
  let response;
  try {
    response = await fetch(new URL(route, config.endpoint), {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
        accept: "application/json",
        "x-amb-protocol": "1",
      },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: requestSignal,
    });
  } catch (cause) {
    // Only a deadline this hook raised itself is a timeout; when the caller's own
    // signal is the reason the call was withdrawn, and a TypeError means the core
    // was never reached at all.
    const name = cause instanceof Error ? cause.name : "";
    const kind = name === "TimeoutError" && timeoutSignal.aborted && timeoutSignal.reason === cause
      ? "timeout"
      : options.signal?.aborted ? "cancelled"
        : cause instanceof TypeError ? "network" : "transport";
    const code = kind === "timeout" ? "request_timeout"
      : kind === "cancelled" ? "request_cancelled"
        : kind === "network" ? "network_error" : "transport_error";
    throw new CoreClientError(
      "Agent Memory Backpack core unavailable. Governance could not be checked.",
      kind, code, undefined, cause,
    );
  }

  let result;
  try {
    result = await response.json();
  } catch (cause) {
    // A body that will not parse is a protocol fault, not a transport one: the core
    // answered, but not in the shape this hook was built against.
    throw new CoreClientError(
      `Agent Memory Backpack core returned an invalid response (HTTP ${response.status}, invalid_response).`,
      "protocol", "invalid_response", response.status, cause,
    );
  }
  if (!response.ok) {
    const status = response.status;
    // Only the core's controlled `code` is kept: it matches a lowercase-word shape,
    // so a buggy or hostile body cannot inject arbitrary text into a log line or
    // the host's stderr. `code` plus `status` is what a caller needs to decide
    // between fixing and retrying, and it is what the spool stores.
    const structuredCode = typeof result?.code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(result.code)
      ? result.code : undefined;
    const code = structuredCode ?? (status === 507 ? "capacity_exhausted" : status >= 500 ? "http5xx" : "http4xx");
    const kind = statusKind(status);
    // The core's message is the actionable half of a refusal: it names the missing
    // dependency, the conflicting key or the field that was wrong. It is kept -
    // sanitized and capped - while `code` and `status` stay the fields a caller
    // branches on.
    const detail = sanitizeServerMessage(result?.message, config.token);
    const err = new CoreClientError(
      `Agent Memory Backpack request rejected (HTTP ${status}, ${code}).${detail ? ` Detail: ${detail}` : ""}`,
      kind, code, status,
    );
    err.coreStatus = status;
    err.retryable = isRetryableClientError(err);
    throw err;
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new CoreClientError(
      `Agent Memory Backpack core returned an invalid response (HTTP ${response.status}, invalid_response).`,
      "protocol", "invalid_response", response.status,
    );
  }
  return result;
}

/**
 * Whether this failure is a decision the caller must act on, not a fault to queue.
 *
 * Defined as the complement of `isRetryableClientError` so the two can never drift
 * apart: `http4xx` (including 426), `protocol` and `cancelled` are explicit
 * rejections, and queueing one would only replay a guaranteed failure.
 */
function isExplicitClientRejection(error) {
  if (!error) return false;
  return !isRetryableClientError(error);
}

function sessionStatePath(dataDir, sessionId) {
  const hash = createHash("sha256").update(String(sessionId ?? ""), "utf8").digest("hex").slice(0, 16);
  return join(dataDir, `codex-session-${hash}.json`);
}

function loadSessionState(dataDir, sessionId) {
  if (!sessionId) return undefined;
  try {
    const file = sessionStatePath(dataDir, sessionId);
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function saveSessionState(dataDir, sessionId, updates) {
  if (!sessionId) return;
  try {
    const file = sessionStatePath(dataDir, sessionId);
    const existing = loadSessionState(dataDir, sessionId) || {};
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, JSON.stringify({ ...existing, ...updates, at: Date.now() }), "utf8");
  } catch {}
}

function sessionFields(input, config) {
  const fields = {};
  const sessionId = typeof input.session_id === "string" && input.session_id.trim()
    ? input.session_id.trim()
    : undefined;
  if (sessionId) fields.sessionId = sessionId;

  let rawTask = input.task_id ?? input.taskId;
  if (typeof rawTask === "string" && rawTask.trim()) {
    fields.taskId = rawTask.trim();
  } else if (sessionId && config?.dataDir) {
    const state = loadSessionState(config.dataDir, sessionId);
    if (typeof state?.taskId === "string" && state.taskId.trim()) {
      fields.taskId = state.taskId.trim();
    }
  }
  if (!fields.taskId && process.env.AMB_TASK_ID?.trim()) {
    fields.taskId = process.env.AMB_TASK_ID.trim();
  }

  if (sessionId && fields.taskId && config?.dataDir) {
    saveSessionState(config.dataDir, sessionId, { taskId: fields.taskId });
  }

  return fields;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function deny(reason) {
  emit({
    hookSpecificOutput: {
      hookEventName: PRE_TOOL_USE,
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

async function prepare(input, config) {
  const sessionInfo = sessionFields(input, config);
  let query = typeof input.prompt === 'string' ? input.prompt.trim().slice(0, 4000) : '';
  if (isContinuationQuery(query)) {
    query = loadSessionState(config.dataDir, sessionInfo.sessionId)?.lastMeaningfulQuery || '';
    if (!query && sessionInfo.sessionId) {
      try {
        const activity = await post(config, '/v1/tasks/activity', { projectId: config.projectId, ...sessionInfo });
        const task = activity?.task;
        if (task && !isContinuationQuery(task.title)) query = [task.title, task.summary].filter(Boolean).join(' ').slice(0, 4000);
      } catch { /* no linked task means norms only */ }
    }
  } else if (query && sessionInfo.sessionId) {
    saveSessionState(config.dataDir, sessionInfo.sessionId, { lastMeaningfulQuery: query });
  }
  if (input.hook_event_name === 'UserPromptSubmit' && sessionInfo.sessionId) {
    saveSessionState(config.dataDir, sessionInfo.sessionId, { turnKey: input.turn_id || randomUUID() });
  }
  const payload = {
    adapter: "codex",
    projectId: config.projectId,
    ...sessionInfo,
    ...(query ? { query } : {}),
  };
  const result = await post(config, "/v1/prepare", payload);
  // Rules match the DSH adapter exactly, so the two ends cannot disagree about
  // whether a response is usable. In particular `mode` must be the verified
  // 'Managed' state: accepting any string would let an 'Ungoverned' reply be
  // treated as normal operation, which contradicts the requirement that a loss
  // of governance be visible.
  if (
    result.protocolVersion !== 1 ||
    !isRevision(result.knowledgeRevision) ||
    result.mode !== "Managed" ||
    !Array.isArray(result.norms) ||
    !Array.isArray(result.workflows) ||
    (result.knowledge !== undefined && !Array.isArray(result.knowledge)) ||
    typeof result.context !== "string"
  ) {
    throw new Error("Agent Memory Backpack prepare response does not match protocol v1");
  }

  let handoffBlock = "";
  if (sessionInfo.taskId && sessionInfo.sessionId) {
    try {
      const handoff = await post(config, "/v1/tasks/handoff", {
        projectId: config.projectId,
        taskId: sessionInfo.taskId,
      });
function toTaskRecord(rawTask, extraSessionId) {
  if (!rawTask || typeof rawTask !== 'object') {
    throw new Error('Invalid task object passed to toTaskRecord');
  }
  const existingSessions = Array.isArray(rawTask.sessionIds) ? rawTask.sessionIds : [];
  const sessionIds = (extraSessionId && !existingSessions.includes(extraSessionId))
    ? [...existingSessions, extraSessionId]
    : [...existingSessions];

  const record = {
    id: String(rawTask.id ?? ''),
    title: String(rawTask.title ?? ''),
    status: rawTask.status,
    summary: typeof rawTask.summary === 'string' ? rawTask.summary : '',
    notes: typeof rawTask.notes === 'string' ? rawTask.notes : '',
    unfinished: Array.isArray(rawTask.unfinished) ? rawTask.unfinished.map(String) : [],
    sessionIds,
    relatedExperiences: Array.isArray(rawTask.relatedExperiences) ? rawTask.relatedExperiences.map(String) : [],
    relatedProposals: Array.isArray(rawTask.relatedProposals) ? rawTask.relatedProposals.map(String) : [],
    files: Array.isArray(rawTask.files) ? rawTask.files.map(String) : [],
    fileStates: Array.isArray(rawTask.fileStates) ? rawTask.fileStates : [],
    verified: typeof rawTask.verified === 'string' ? rawTask.verified : '',
    evidence: typeof rawTask.evidence === 'string' ? rawTask.evidence : 'self-reported',
  };
  if (typeof rawTask.startedAt === 'number' && Number.isFinite(rawTask.startedAt) && rawTask.startedAt >= 0) {
    record.startedAt = Math.floor(rawTask.startedAt);
  }
  return record;
}

      if (handoff?.task) {
        const existingSessions = Array.isArray(handoff.task.sessionIds) ? handoff.task.sessionIds : [];
        if (!existingSessions.includes(sessionInfo.sessionId)) {
          await post(config, "/v1/tasks/record", {
            projectId: config.projectId,
            task: toTaskRecord(handoff.task, sessionInfo.sessionId),
          });
        }
        const task = handoff.task;
        const unfinishedStr = Array.isArray(task.unfinished) && task.unfinished.length ? task.unfinished.join('；') : '无';
        const filesStr = Array.isArray(handoff.files) && handoff.files.length ? handoff.files.join('；') : '未记录';
        const relatedWfs = Array.isArray(handoff.workflows) && handoff.workflows.length ? handoff.workflows.map(w => w.id).join(', ') : '无';
        handoffBlock = [
          '[Task Handoff]',
          `Task: ${task.id} "${task.title}"`,
          `Status: ${task.status}`,
          `Knowledge: version ${handoff.knowledgeRevision ?? 0}`,
          `Related Workflows: ${relatedWfs}`,
          `Important: ${unfinishedStr}`,
          `Files: ${filesStr}`,
          `Suggestion: ${handoff.suggestion ?? ''}`,
          `Caveat: ${handoff.caveat || '接收端需重新确认文件与环境状态；本交接不迁移运行中的进程、凭据或工具权限。上面的 files 只是需要核对的清单，不代表已经核对过。'}`,
        ].filter(Boolean).join('\n');
      }
    } catch (err) {
      logger.warn("handoff.failed", { message: err instanceof Error ? err.message : "failed to fetch handoff" });
    }
  }

  logger.info("context.injected", { adapter: "codex", sessionId: sessionInfo.sessionId,
    knowledgeRevision: result.knowledgeRevision, chars: result.context.length,
    knowledgeIds: (result.knowledge ?? []).map(item => item.id) });
  const recalled = await recallKnowledge({ client: { post: (route, payload, options) => post(config, route, payload, options) },
    config, logger, adapter: 'codex', sessionId: sessionInfo.sessionId, query, trigger: 'task' });
  const finalContext = [handoffBlock, redact(result.context, config.token), redact(recalled.context, config.token)].filter(Boolean).join("\n\n");
  emit({
    hookSpecificOutput: {
      hookEventName: input.hook_event_name,
      // The host labels an additionalContext message by its own convention
      // (`developer`), so a reader cannot tell from the transcript alone which
      // source produced it. The marker makes the origin identifiable in the
      // recorded evidence, matching the DSH adapter's structured source field.
      additionalContext: `${SOURCE_MARKER}\n${finalContext}`,
    },
  });
}

async function gate(input, config) {
  if (typeof input.tool_name !== "string" || !input.tool_name.trim()) {
    deny("Agent Memory Backpack policy check failed: Codex did not provide a tool name.");
    return;
  }

  const sessionInfo = sessionFields(input, config);
  const result = await post(config, "/v1/gate", {
    adapter: "codex",
    projectId: config.projectId,
    ...sessionInfo,
    toolName: input.tool_name,
  });
  if (
    (result.decision !== "allow" && result.decision !== "deny") ||
    typeof result.knowledgeRevision !== "number" ||
    !Number.isFinite(result.knowledgeRevision) ||
    typeof result.context !== "string"
  ) {
    throw new Error("Agent Memory Backpack gate response does not match protocol v1");
  }
  const identity = { projectId: config.projectId, endpoint: config.endpoint };
  saveSnapshot(config.dataDir, {
    projectId: config.projectId,
    endpoint: config.endpoint,
    deniedTools: Array.isArray(result.deniedTools) ? result.deniedTools : [],
    revision: result.knowledgeRevision,
    at: Date.now(),
  }, identity);
  if (result.decision === "deny") {
    deny(safeReason(result.reason, config.token));
    return;
  }
  const cmd = (input.tool_input && typeof input.tool_input === 'object' ? input.tool_input.command : '')
    || (typeof input.tool_input === 'string' ? input.tool_input : '')
    || (typeof input.command === 'string' ? input.command : '');
  const bypass = checkShellWriteBypass(input.tool_name, cmd, result.deniedTools);
  if (bypass.denied) {
    deny(safeReason(bypass.reason, config.token));
    return;
  }
  if (result.context.trim()) {
    const sessionId = sessionInfo.sessionId;
    const lastRev = loadSessionState(config.dataDir, sessionId)?.revision;
    if (lastRev !== result.knowledgeRevision) {
      saveSessionState(config.dataDir, sessionId, { revision: result.knowledgeRevision });
      emit({
        hookSpecificOutput: {
          hookEventName: PRE_TOOL_USE,
          additionalContext: redact(result.context, config.token),
        },
      });
    }
  }
  // An allow from project policy is not a Codex approval. Empty stdout preserves
  // Codex's normal permission and approval flow.
}

async function replayOutboxIfNeeded(input, config) {
  const sessionInfo = sessionFields(input, config);
  const sessionId = sessionInfo.sessionId;
  if (sessionId && config?.dataDir) {
    const state = loadSessionState(config.dataDir, sessionId);
    if (state?.outboxReplayed && !state?.pendingDelivery && loadSpool(config.dataDir).length === 0) return;
  }
  try {
    const replayRes = await post(config, "/v1/outbox/replay", {
      projectId: config.projectId,
    });
    logger.info("outbox.replay", {
      sessionId: sessionId || "unknown",
      attempted: replayRes?.attempted ?? 0,
      delivered: Array.isArray(replayRes?.delivered) ? replayRes.delivered : [],
      failed: Array.isArray(replayRes?.failed) ? replayRes.failed : [],
      abandoned: Array.isArray(replayRes?.abandoned) ? replayRes.abandoned : [],
    });
    if (sessionId && config?.dataDir) {
      saveSessionState(config.dataDir, sessionId, { outboxReplayed: true,
        pendingDelivery: Array.isArray(replayRes?.failed) && replayRes.failed.length > 0 });
    }
  } catch (error) {
    saveSessionState(config.dataDir, sessionInfo.sessionId, { pendingDelivery: true });
    // Best-effort: failures to replay must never block session startup or prepare
    logger.warn("outbox.replay_failed", {
      sessionId: sessionId || "unknown",
      failureKind: error?.kind,
      code: error?.code,
      status: error?.status,
      message: error instanceof Error ? error.message : "unknown",
    });
  }
  try {
    const clientAdapter = {
      post: (path, body) => post(config, path, body),
    };
    const spoolOutcome = await spoolReplay(config.dataDir, clientAdapter, logger);
    await replayMaterials({ config, client: clientAdapter, logger });
    if (spoolOutcome.replayed > 0 || spoolOutcome.rejected > 0) {
      // Categorized counts only: a replayed item was delivered, a rejected one was
      // refused permanently and dropped. The payload is never logged.
      logger.info("spool.replay", {
        sessionId: sessionId || "unknown",
        replayed: spoolOutcome.replayed,
        rejected: spoolOutcome.rejected ?? 0,
        remaining: spoolOutcome.remaining,
      });
    }
  } catch (spoolError) {
    logger.warn("spool.replay_failed", {
      sessionId: sessionId || "unknown",
      failureKind: spoolError?.kind,
      code: spoolError?.code,
      message: spoolError instanceof Error ? spoolError.message : String(spoolError),
    });
  }
}

async function recordEvent(input, config) {
  const stopped = input.hook_event_name === "Stop";
  const sessionInfo = sessionFields(input, config);
  const state = loadSessionState(config.dataDir, sessionInfo.sessionId) ?? {};
  const stopTurnKey = input.turn_id || state.turnKey || 'session-stop';
  const stopTaskId = state.stopTurnKey === stopTurnKey ? state.stopTaskId : sessionInfo.taskId;
  if (stopped && state.stopTurnKey !== stopTurnKey) {
    saveSessionState(config.dataDir, sessionInfo.sessionId, { stopTurnKey, stopTaskId: stopTaskId ?? null });
  }
  let recalled;
  if (!stopped) {
    await captureMaterial({ adapter: 'codex', sessionId: sessionInfo.sessionId, taskId: sessionInfo.taskId,
      tool: input.tool_name, result: input.tool_response ?? input.tool_result },
    { config, client: { post: (route, payload) => post(config, route, payload) }, logger });
    await captureFailure({ adapter: "codex", sessionId: sessionInfo.sessionId,
      tool: input.tool_name, result: input.tool_response ?? input.tool_result },
    { config, client: { post: (route, payload) => post(config, route, payload) }, logger });
    const failure = failureCandidate({ adapter: 'codex', projectId: config.projectId, sessionId: sessionInfo.sessionId,
      tool: input.tool_name, result: input.tool_response ?? input.tool_result, secret: config.token });
    if (failure) recalled = await recallKnowledge({ client: { post: (route, payload, options) => post(config, route, payload, options) },
      config, logger, adapter: 'codex', sessionId: sessionInfo.sessionId,
      query: failure.discovery.match(/观察：(.*)/)?.[1] ?? input.tool_name, trigger: 'failure' });
  }
  const eventPayload = {
    eventId: stopped && sessionInfo.sessionId
      ? `stop:${createHash('sha256').update(JSON.stringify([sessionInfo.sessionId, stopTurnKey])).digest('hex')}`
      : randomUUID(),
    adapter: "codex",
    projectId: config.projectId,
    // Snapshot the task id once per turn: learning it from a stop receipt must
    // not change a retried event, while an explicitly linked task is preserved.
    ...(stopped ? { sessionId: sessionInfo.sessionId, ...(stopTaskId ? { taskId: stopTaskId } : {}) } : sessionInfo),
    kind: stopped ? "turn_stopped" : "tool_completed",
    summary: stopped
      ? "Codex turn stopped."
      : "A supported Codex local tool call finished.",
  };
  try {
    const result = await post(config, "/v1/events", eventPayload);
    if (
      typeof result.id !== "string" ||
      result.stored !== true ||
      typeof result.duplicate !== "boolean"
    ) {
      throw new Error("Agent Memory Backpack event response does not match protocol v1");
    }
    if (result.journalId) {
      saveSessionState(config.dataDir, sessionInfo.sessionId, { taskId: result.taskId, journalId: result.journalId });
      logger.info('journal.persisted', { adapter: 'codex', sessionId: sessionInfo.sessionId,
        taskId: result.taskId, journalId: result.journalId, revision: result.revision, outcome: result.outcome });
    }
    if (recalled?.context) emit({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `${SOURCE_MARKER}\n${redact(recalled.context, config.token)}` } });
    if (stopped) emit({ continue: true });
  } catch (error) {
    // An `http4xx` refusal, a protocol mismatch or a withdrawn call is a decision
    // to report, never a queue entry: replaying it would fail the same way.
    if (isExplicitClientRejection(error)) {
      throw error;
    }
    saveSessionState(config.dataDir, sessionInfo.sessionId, { pendingDelivery: true });
    // Network / timeout / 5xx: enqueue full payload into persistent outbox
    /**
     * Whether the core has this event — either it accepted the delivery, or its own
     * outbox did. That is what decides whether the hook may report success, because the
     * host reads the exit code as "the turn was recorded".
     *
     * The local spool is deliberately a different thing and does not set this. Writing the
     * event to disk means it will be delivered *later*, not that it was delivered now;
     * treating the two as equivalent made a failed delivery look like a successful one,
     * with the hook exiting 0 and saying nothing about the core being unreachable. The
     * stop-event contract forbids exactly that, so the flag is named for what it means
     * rather than for the step that happened to set it.
     */
    let deliveredToCore = false;
    try {
      await post(config, "/v1/outbox/enqueue", {
        kind: "event",
        idempotencyKey: eventPayload.eventId,
        projectId: config.projectId,
        payload: eventPayload,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
        attempts: 1,
      });
      logger.info("outbox.enqueued", { kind: "event", idempotencyKey: eventPayload.eventId });
      deliveredToCore = true;
    } catch (enqueueErr) {
      logger.warn("outbox.enqueue_failed", {
        kind: "event",
        idempotencyKey: eventPayload.eventId,
        failureKind: enqueueErr?.kind,
        code: enqueueErr?.code,
        status: enqueueErr?.status,
        message: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
      });
      try {
        const outcome = spoolEnqueue(config.dataDir, {
          kind: "event",
          idempotencyKey: eventPayload.eventId,
          projectId: config.projectId,
          payload: eventPayload,
          error: (enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr)).slice(0, 2000),
          // Structured kind/code/status/reason: replay must tell a transient fault
          // (worth another attempt) from a permanent refusal (drop) without parsing
          // text, and these fields are what the adapter log reports.
          failure: clientFailureMeta(enqueueErr),
        });
        if (outcome.enqueued) {
          // Saved for replay on the next session. Note that `deliveredToCore` stays false:
          // the event is preserved, the turn is still unrecorded, and the two must not be
          // conflated.
          logger.info("spool.enqueued", { kind: "event", idempotencyKey: eventPayload.eventId });
        } else {
          logger.warn("spool.enqueue_refused", { kind: "event", idempotencyKey: eventPayload.eventId, reason: outcome.reason });
        }
      } catch (spoolErr) {
        logger.warn("spool.enqueue_failed", {
          kind: "event",
          idempotencyKey: eventPayload.eventId,
          message: spoolErr instanceof Error ? spoolErr.message : String(spoolErr),
        });
      }
    }

    if (stopped) {
      if (deliveredToCore) {
        emit({ continue: true });
      } else {
        // Neither direct delivery nor the core's own outbox took it. The event is safe on
        // disk and will be replayed, but this turn is not recorded, and the host has to be
        // able to see that: an exit of 0 here would be an apparent stop success.
        throw error;
      }
    }
  }
}

/**
 * A plugin the user switched off must stay off.
 *
 * Codex records the switch as `[plugins."<name>@<marketplace>"] enabled = false` in
 * `~/.codex/config.toml`, and that file is the only durable place the decision
 * lives. The host is supposed to stop invoking these hooks once a plugin is
 * disabled, but a 2026-10-10 acceptance run recorded exactly the opposite: the
 * settings UI said the plugin was disabled while new chats kept receiving injected
 * context. Reading the flag here makes the promise hold regardless of which side
 * forgets it - and a switch that switches nothing is worse than no switch at all.
 *
 * Only an explicit `false` stops the hook: a missing entry means "never switched
 * off" (the plugin ships enabled), and anything unreadable fails open, because a
 * config we cannot parse must not silently turn memory capture off.
 */
function pluginExplicitlyDisabled() {
  try {
    const path = join(homedir(), '.codex', 'config.toml');
    if (!existsSync(path)) return false;
    const text = readFileSync(path, 'utf8');
    // Section headers read like: [plugins."agent-memory-backpack@agent-memory-backpack-local"]
    const sections = text.split(/^[ \t]*\[/m);
    for (const section of sections) {
      const end = section.indexOf(']');
      if (end === -1) continue;
      if (!/^plugins\.["']agent-memory-backpack@/i.test(section.slice(0, end))) continue;
      const body = section.slice(end + 1);
      const match = /^[ \t]*enabled[ \t]*=[ \t]*(true|false)[ \t]*$/im.exec(body);
      if (match && match[1].toLowerCase() === 'false') return true;
    }
    return false;
  } catch {
    // Failing open is deliberate: a hook that cannot read the config should keep
    // working, not silently stop serving knowledge.
    return false;
  }
}

async function main() {
  // Checked before stdin is read: a disabled plugin should produce no output at all,
  // which also keeps it from claiming a status line in the host's UI.
  if (pluginExplicitlyDisabled()) return;

  let input;
  try {
    input = await readInput();
  } catch (error) {
    logger.error("hook.input_invalid", { message: error instanceof Error ? error.message : "unknown" });
    fail(error instanceof SyntaxError ? "Hook input is invalid JSON" : error.message);
    return;
  }

  const event = input.hook_event_name;
  if (!SUPPORTED_EVENTS.has(event)) {
    logger.warn("hook.unsupported_event", { event: String(event) });
    fail("Unsupported Codex hook event");
    return;
  }

  const versionCheck = checkNodeVersion();
  if (!versionCheck.ok) {
    logger.error("hook.unsupported_node", { version: versionCheck.version, error: versionCheck.error });
    if (event === PRE_TOOL_USE) {
      deny(versionCheck.error);
      return;
    }
    fail(versionCheck.error);
    return;
  }

  let scopeConfig;
  try {
    scopeConfig = readScopeConfig();
  } catch (error) {
    logger.error("hook.config_unreadable", { event });
    diagnoseSkip("client configuration could not be read");
    return;
  }
  if (scopeConfig.diagnostic) {
    logger.info("hook.skipped", { event, reason: scopeConfig.diagnostic });
    diagnoseSkip(scopeConfig.diagnostic);
    return;
  }

  // Plugin hooks may be global. If projectRoot is configured, scope effects to that project;
  // otherwise operate in shared library mode for all project sessions.
  if (scopeConfig.projectRoot) {
    const scope = projectScope(input, scopeConfig.projectRoot);
    if (scope === "outside") return;
    if (scope === "unknown") {
      logger.info("hook.skipped", { event, reason: "unverifiable project cwd" });
      diagnoseSkip("Codex did not provide a verifiable project cwd");
      return;
    }
  }

  let config;
  try {
    config = loadConfig(scopeConfig.config, scopeConfig.configPath);
  } catch (error) {
    logger.error("hook.config_load_failed", { event, message: error.message });
    if (event === PRE_TOOL_USE) {
      deny(safeReason(error.message));
      return;
    }
    fail(error.message);
    return;
  }

  logger.info("hook.start", { event, projectId: config.projectId, sessionId: String(input.session_id ?? "") });
  const started = Date.now();
  try {
    // Starting the core belongs to SessionStart only. This hook is a short-lived
    // process per event, so firing a spawn on every prompt or tool call would
    // race many attempts at one port; a new session is once, and early enough
    // that the first tool call already finds a warm core.
    if (event === "SessionStart") {
      await startCoreIfNeeded(config, logger);
      await replayOutboxIfNeeded(input, config);
    }
    if (event === "SessionStart" || event === "UserPromptSubmit") {
      await prepare(input, config);
      if (event === 'UserPromptSubmit') {
        const state = loadSessionState(config.dataDir, input.session_id);
        if (state?.pendingDelivery || loadSpool(config.dataDir).length > 0) await replayOutboxIfNeeded(input, config);
      }
    } else if (event === PRE_TOOL_USE) {
      await gate(input, config);
    } else {
      await recordEvent(input, config);
    }
    logger.debug("hook.ok", { event, ms: Date.now() - started });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown service error";
    // Recorded before the host is told: the log is what makes a later report
    // actionable, and it is the only place the real cause is kept.
    logger.error("hook.failed", { event, ms: Date.now() - started, message });
    if (error?.status === 426 || error?.code === "protocol_mismatch" || message.includes("HTTP 426")) {
      if (event === PRE_TOOL_USE) {
        deny("Agent Memory Backpack protocol version mismatch (HTTP 426); tool execution blocked.");
        return;
      }
      fail(message);
      return;
    }
    if (event === PRE_TOOL_USE) {
      // The service being unreachable is not the same as "this call is denied".
      //
      // Denying here blocked every tool whenever the core was down, which made an
      // optional knowledge service a single point of failure for the whole agent.
      // The design requires degrading visibly: enforce what a snapshot still knows,
      // and otherwise step back and say so.
      const identity = { projectId: config.projectId, endpoint: config.endpoint };
      const snapshot = loadSnapshot(config.dataDir, identity);
      const { mode } = operatingMode({ coreReachable: false, snapshot });
      if (mode === "ReadOnlySnapshot") {
        if (decideFromSnapshot(snapshot.record, input.tool_name, identity) === "deny") {
          deny(`${input.tool_name} is prohibited by the last policy snapshot; the core is currently unreachable.`);
          return;
        }
        const cmd = (input.tool_input && typeof input.tool_input === 'object' ? input.tool_input.command : '')
          || (typeof input.tool_input === 'string' ? input.tool_input : '')
          || (typeof input.command === 'string' ? input.command : '');
        const bypass = checkShellWriteBypass(input.tool_name, cmd, snapshot.record?.deniedTools);
        if (bypass.denied) {
          deny(bypass.reason);
          return;
        }
        logger.warn("hook.degraded", { mode, detail: snapshot.detail ?? "" });
        return;
      }
      logger.warn("hook.degraded", { mode, detail: snapshot?.detail ?? "" });
      return;
    }
    fail(message);
  }
}

await main();
