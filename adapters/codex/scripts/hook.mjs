#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapterLogger } from "./log.mjs";
import { resolveClientConfig } from "./resolve-config.mjs";
import { ensureCoreRunning } from "./ensure-core.mjs";

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
  if (typeof config.projectRoot !== "string" || !isAbsolute(config.projectRoot)) {
    return { diagnostic: "client configuration has no absolute projectRoot" };
  }

  return { config, projectRoot: config.projectRoot, configPath: path };
}

function loadConfig(config, configPath) {
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

async function post(config, route, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(new URL(route, config.endpoint), {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
        accept: "application/json",
        "x-amb-protocol": "1",
      },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Agent Memory Backpack service returned HTTP ${response.status}`);

    let value;
    try {
      value = await response.json();
    } catch {
      throw new Error("Agent Memory Backpack service returned invalid JSON");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Agent Memory Backpack service returned an invalid response");
    }
    return value;
  } finally {
    clearTimeout(timeout);
  }
}

function sessionFields(input) {
  return typeof input.session_id === "string" && input.session_id.trim()
    ? { sessionId: input.session_id }
    : {};
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
  const payload = {
    adapter: "codex",
    projectId: config.projectId,
    ...sessionFields(input),
    ...(typeof input.prompt === "string" && input.prompt.trim()
      ? { query: input.prompt.slice(0, 4000) }
      : {}),
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

  emit({
    hookSpecificOutput: {
      hookEventName: input.hook_event_name,
      // The host labels an additionalContext message by its own convention
      // (`developer`), so a reader cannot tell from the transcript alone which
      // source produced it. The marker makes the origin identifiable in the
      // recorded evidence, matching the DSH adapter's structured source field.
      additionalContext: `${SOURCE_MARKER}\n${redact(result.context, config.token)}`,
    },
  });
}

async function gate(input, config) {
  if (typeof input.tool_name !== "string" || !input.tool_name.trim()) {
    deny("Agent Memory Backpack policy check failed: Codex did not provide a tool name.");
    return;
  }

  const result = await post(config, "/v1/gate", {
    adapter: "codex",
    projectId: config.projectId,
    ...sessionFields(input),
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
  if (result.decision === "deny") {
    deny(safeReason(result.reason, config.token));
  } else if (result.context.trim()) {
    emit({
      hookSpecificOutput: {
        hookEventName: PRE_TOOL_USE,
        additionalContext: redact(result.context, config.token),
      },
    });
  }
  // An allow from project policy is not a Codex approval. Empty stdout preserves
  // Codex's normal permission and approval flow.
}

async function recordEvent(input, config) {
  const stopped = input.hook_event_name === "Stop";
  const result = await post(config, "/v1/events", {
    eventId: randomUUID(),
    adapter: "codex",
    projectId: config.projectId,
    ...sessionFields(input),
    kind: stopped ? "turn_stopped" : "tool_completed",
    summary: stopped
      ? "Codex turn stopped."
      : "A supported Codex local tool call finished.",
  });
  if (
    typeof result.id !== "string" ||
    result.stored !== true ||
    typeof result.duplicate !== "boolean"
  ) {
    throw new Error("Agent Memory Backpack event response does not match protocol v1");
  }

  if (stopped) emit({ continue: true });
}

async function main() {
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

  // Plugin hooks may be global. Scope all effects to the configured project;
  // an absent/invalid cwd is unknown scope and therefore produces no action.
  const scope = projectScope(input, scopeConfig.projectRoot);
  if (scope === "outside") return;
  if (scope === "unknown") {
    logger.info("hook.skipped", { event, reason: "unverifiable project cwd" });
    diagnoseSkip("Codex did not provide a verifiable project cwd");
    return;
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
    if (event === "SessionStart") await startCoreIfNeeded(config, logger);
    if (event === "SessionStart" || event === "UserPromptSubmit") {
      await prepare(input, config);
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
    if (event === PRE_TOOL_USE) {
      deny("Agent Memory Backpack policy service is unavailable; this supported tool call was blocked.");
      return;
    }
    fail(message);
  }
}

await main();
