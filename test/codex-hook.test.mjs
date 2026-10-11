import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

const hookPath = fileURLToPath(new URL("../adapters/codex/scripts/hook.mjs", import.meta.url));
const fixtureDirs = new Set();
const servers = new Set();
const TEST_TOKEN = "test-secret-token-should-never-leak";

async function createConfig(endpoint, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "amb-codex-hook-"));
  fixtureDirs.add(dir);
  const projectRoot = join(dir, "project");
  await mkdir(projectRoot);
  const path = join(dir, "client.json");
  await writeFile(
    path,
    JSON.stringify({
      endpoint,
      token: TEST_TOKEN,
      projectId: "project-fixture",
      projectRoot,
      ...overrides,
    }),
    "utf8",
  );
  return path;
}

async function startServer(handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const record = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      authorization: request.headers.authorization,
      bodyText,
      body: bodyText ? JSON.parse(bodyText) : undefined,
    };
    requests.push(record);
    await handler(record, response);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.add(server);
  const { port } = server.address();
  return { endpoint: `http://127.0.0.1:${port}`, requests };
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function runHook(input, configPath, envOverrides = {}) {
  if (configPath && !Object.hasOwn(input, "cwd")) {
    input = { ...input, cwd: join(dirname(configPath), "project") };
  }
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...envOverrides };
    if (configPath) env.AMB_CONFIG = configPath;
    else delete env.AMB_CONFIG;
    const child = spawn(process.execPath, [hookPath], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill(), 10_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      resolve({ status, signal, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function parseStdout(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.trim(), "expected JSON output on stdout");
  return JSON.parse(result.stdout);
}

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) => new Promise((resolve) => server.close(resolve)),
    ),
  );
  servers.clear();
  await Promise.all([...fixtureDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  fixtureDirs.clear();
});

test("prepare rejects a degraded mode and a non-integer revision", async () => {
  // The DSH adapter requires mode === 'Managed' and a safe-integer revision.
  // Codex previously accepted any string mode and any finite number, so an
  // 'Ungoverned' reply was treated as normal operation with a fractional
  // revision. Both ends must now agree on what a usable response is.
  const cases = [
    ["Ungoverned mode", { protocolVersion: 1, knowledgeRevision: 1, mode: "Ungoverned", norms: [], workflows: [], context: "x" }],
    ["ReadOnlySnapshot mode", { protocolVersion: 1, knowledgeRevision: 1, mode: "ReadOnlySnapshot", norms: [], workflows: [], context: "x" }],
    ["fractional revision", { protocolVersion: 1, knowledgeRevision: 1.5, mode: "Managed", norms: [], workflows: [], context: "x" }],
    ["negative revision", { protocolVersion: 1, knowledgeRevision: -3, mode: "Managed", norms: [], workflows: [], context: "x" }],
    ["knowledge not an array", { protocolVersion: 1, knowledgeRevision: 1, mode: "Managed", norms: [], workflows: [], knowledge: {}, context: "x" }],
  ];
  for (const [label, body] of cases) {
    const service = await startServer((_request, response) => json(response, 200, body));
    const config = await createConfig(service.endpoint);
    const result = await runHook({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "q" }, config);
    assert.notEqual(result.status, 0, `${label} 必须被判为失败`);
    assert.equal(
      (result.stdout ?? "").includes("additionalContext"),
      false,
      `${label} 不得注入上下文`,
    );
  }
});

test("prepare accepts a managed response with an empty context", async () => {
  // Empty context is legitimate (nothing to inject yet); the rule now matches DSH.
  const service = await startServer((_request, response) => {
    json(response, 200, { protocolVersion: 1, knowledgeRevision: 1, mode: "Managed", norms: [], workflows: [], context: "" });
  });
  const config = await createConfig(service.endpoint);
  const result = await runHook({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "q" }, config);
  assert.equal(result.status, 0);
});

test("UserPromptSubmit sends the configured project and returns official hook context output", async () => {
  const service = await startServer((request, response) => {
    assert.equal(request.url, "/v1/prepare");
    json(response, 200, {
      protocolVersion: 1,
      knowledgeRevision: 7,
      mode: "Managed",
      norms: [],
      workflows: [],
      context: "Use workflow alpha.",
    });
  });
  const config = await createConfig(service.endpoint);
  const result = await runHook(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "thread-fixture",
      prompt: "Find the right workflow",
    },
    config,
  );
  const output = parseStdout(result);

  // Injected context is prefixed with a source marker. Codex hooks can only
  // return text and the host labels it by its own convention, so without the
  // marker an acceptance run cannot tell this plugin's content from the model's
  // own words. The name matches the DSH adapter's structured source field.
  assert.deepEqual(output, {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: "[agent-memory-backpack]\nUse workflow alpha.",
    },
  });
  assert.equal(service.requests.length, 1);
  assert.equal(service.requests[0].headers["x-amb-protocol"], "1");
  assert.equal(service.requests[0].authorization, `Bearer ${TEST_TOKEN}`);
  assert.deepEqual(service.requests[0].body, {
    adapter: "codex",
    projectId: "project-fixture",
      sessionId: "thread-fixture",
    query: "Find the right workflow",
  });
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(TEST_TOKEN));
});

test("prepare truncates retrieval text to 4000 characters while preserving session identity", async () => {
  const service = await startServer((_request, response) => {
    json(response, 200, { protocolVersion: 1, knowledgeRevision: 1, mode: "Managed", norms: [], workflows: [], context: "Ready." });
  });
  const config = await createConfig(service.endpoint);
  await runHook({ hook_event_name: "UserPromptSubmit", session_id: "session-only", prompt: "q".repeat(5000) }, config);
  assert.equal(service.requests[0].body.query.length, 4000);
  assert.equal(service.requests[0].body.sessionId, "session-only");
  assert.equal("taskId" in service.requests[0].body, false);
});

test("PreToolUse maps a policy denial to Codex permissionDecision deny and redacts tokens", async () => {
  const service = await startServer((request, response) => {
    json(response, 200, {
      decision: "deny",
      reason: `Blocked by policy. Bearer ${TEST_TOKEN}`,
      knowledgeRevision: 8,
      context: "",
    });
  });
  const config = await createConfig(service.endpoint);
  const result = await runHook(
    {
    hook_event_name: "PreToolUse",
    session_id: "thread-fixture",
    adapter: "dsh",
    projectId: "attacker-controlled-project",
    tool_name: "Bash",
      tool_input: { command: "echo safe" },
    },
    config,
  );
  const output = parseStdout(result);

  assert.deepEqual(output, {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Blocked by policy. Bearer [redacted]",
    },
  });
  assert.equal(service.requests[0].url, "/v1/gate");
  assert.equal(service.requests[0].headers["x-amb-protocol"], "1");
  assert.deepEqual(service.requests[0].body, {
    adapter: "codex",
    projectId: "project-fixture",
    sessionId: "thread-fixture",
    toolName: "Bash",
  });
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(TEST_TOKEN));
});

test("PreToolUse adds current norm context without approving the tool", async () => {
  const service = await startServer((_request, response) => {
    json(response, 200, { decision: "allow", reason: "", knowledgeRevision: 9, context: "Current project norm: preserve the migration log." });
  });
  const config = await createConfig(service.endpoint);
  const result = await runHook({ hook_event_name: "PreToolUse", session_id: "session-fixture", tool_name: "Bash" }, config);
  assert.deepEqual(parseStdout(result), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: "Current project norm: preserve the migration log.",
    },
  });
  assert.equal("permissionDecision" in JSON.parse(result.stdout).hookSpecificOutput, false);
  assert.equal(service.requests[0].body.sessionId, "session-fixture");
});

test("PreToolUse degrades instead of blocking everything when the core is unavailable", async () => {
  // This case used to assert that the hook blocks every tool call while the core is
  // down. That was the lockout: an optional knowledge service, when unreachable,
  // stopped the agent from reading or editing anything, and the only way back was to
  // disable the plugin. The design requires degrading visibly instead, so with no
  // snapshot there is nothing to enforce and the call proceeds — while still not
  // leaking anything the core said.
  const service = await startServer((_request, response) => {
    response.writeHead(503, { "content-type": "text/plain" });
    response.end(`temporary failure ${TEST_TOKEN}`);
  });
  const config = await createConfig(service.endpoint);
  const result = await runHook(
    { hook_event_name: "PreToolUse", tool_name: "mcp__amb__amb_prepare" },
    config,
  );

  // Nothing is claimed as governed, and nothing is blocked.
  assert.equal(result.stdout.trim().includes("permissionDecision"), false,
    "无快照时不得声称受规则约束，也不得阻断调用");
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(TEST_TOKEN),
    "不得把核心的响应内容泄漏出去");
});

test("PreToolUse still enforces a recorded prohibition while the core is down", async () => {
  // The complement of the case above: once the gate has run, its prohibitions
  // survive the process, so killing the core is not a way to shed policy.
  const service = await startServer((_request, response) => {
    response.writeHead(503, { "content-type": "text/plain" });
    response.end("down");
  });
  const config = await createConfig(service.endpoint);
  const dataDir = dirname(config);
  await writeFile(join(dataDir, "gate-snapshot.json"),
    JSON.stringify({ deniedTools: ["mcp__amb__amb_prepare"], revision: 4, at: Date.now() }), "utf8");

  const result = await runHook(
    { hook_event_name: "PreToolUse", tool_name: "mcp__amb__amb_prepare" },
    config,
  );
  const output = parseStdout(result);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny",
    "快照记录的禁止项在核心不可达时仍须执行");

  // A tool the snapshot did not prohibit still proceeds.
  const allowed = await runHook(
    { hook_event_name: "PreToolUse", tool_name: "some_other_tool" },
    config,
  );
  assert.equal(allowed.stdout.trim().includes("permissionDecision"), false,
    "快照未禁止的工具不得被牵连阻断");
});

test("non-gating hook failures exit unsuccessfully and never claim success", async () => {
  const service = await startServer((_request, response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: TEST_TOKEN }));
  });
  const config = await createConfig(service.endpoint);
  const result = await runHook(
    {
      hook_event_name: "UserPromptSubmit",
      prompt: `private prompt ${TEST_TOKEN}`,
    },
    config,
  );

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /HTTP 503/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(TEST_TOKEN));
});

test("PostToolUse records a short event without forwarding tool input or output", async () => {
  const service = await startServer((_request, response) => {
    json(response, 200, { id: "event-fixture", stored: true, duplicate: false });
  });
  const config = await createConfig(service.endpoint);
  const result = await runHook(
    {
      hook_event_name: "PostToolUse",
      session_id: "thread-fixture",
      tool_name: "Bash",
      tool_input: { command: `echo ${TEST_TOKEN}` },
      tool_response: { output: TEST_TOKEN },
    },
    config,
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(service.requests.length, 1);
  assert.equal(service.requests[0].url, "/v1/events");
  assert.equal(service.requests[0].headers["x-amb-protocol"], "1");
  assert.match(service.requests[0].body.eventId, /^[0-9a-f-]{36}$/i);
  assert.equal(service.requests[0].body.adapter, "codex");
  assert.equal(service.requests[0].body.projectId, "project-fixture");
  assert.equal(service.requests[0].body.sessionId, "thread-fixture");
  assert.equal(service.requests[0].body.kind, "tool_completed");
  assert.equal(service.requests[0].body.summary, "A supported Codex local tool call finished.");
  assert.doesNotMatch(service.requests[0].bodyText, new RegExp(TEST_TOKEN));
});

test("Stop records only turn_stopped and returns no task completion claim", async () => {
  const service = await startServer((request, response) => {
    json(response, 200, { id: "event-fixture", stored: true, duplicate: false });
  });
  const config = await createConfig(service.endpoint);
  const result = await runHook(
    { hook_event_name: "Stop", session_id: "thread-fixture", turn_id: "turn-fixture" },
    config,
  );
  const output = parseStdout(result);

  assert.deepEqual(output, { continue: true });
  assert.equal(service.requests.length, 1);
  assert.equal(service.requests[0].url, "/v1/events");
  assert.equal(service.requests[0].headers["x-amb-protocol"], "1");
  assert.equal(service.requests[0].body.kind, "turn_stopped");
  assert.doesNotMatch(JSON.stringify(service.requests[0].body), /completed|task_completed/i);
  assert.equal(service.requests[0].body.summary, "Codex turn stopped.");
});

test("Stop service failure exits unsuccessfully without an apparent stop success", async () => {
  const service = await startServer((_request, response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: TEST_TOKEN }));
  });
  const config = await createConfig(service.endpoint);
  const result = await runHook({ hook_event_name: "Stop" }, config);

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /HTTP 503/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(TEST_TOKEN));
  assert.equal(service.requests[0].body.kind, "turn_stopped");
});

test("the default config path is ~/.agent-memory-backpack/client.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "amb-codex-no-config-"));
  fixtureDirs.add(dir);
  const homeConfigDir = join(dir, ".agent-memory-backpack");
  await mkdir(homeConfigDir, { recursive: true });
  const config = join(homeConfigDir, "client.json");
  await writeFile(
    config,
    JSON.stringify({ endpoint: "http://127.0.0.1:1", token: TEST_TOKEN, projectId: "project-fixture", projectRoot: dir }),
    "utf8",
  );
  const result = await runHook(
    { hook_event_name: "PreToolUse", tool_name: "Bash", cwd: dir },
    undefined,
    { USERPROFILE: dir },
  );

  // The subject is "was the default path found and used", asserted through the
  // plugin's own log rather than through a deny verdict. The deny used to be the
  // signal, but refusing every call while the core is down was the lockout this
  // project had to fix; the endpoint here is deliberately dead.
  const logFile = join(homeConfigDir, "amb-plugin.log.jsonl");
  assert.equal(existsSync(logFile), true, "插件应在默认数据目录写日志");
  const entries = readFileSync(logFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const configEvent = entries.find(entry => entry.event === "adapter.config" || entry.event === "hook.start"
    || entry.event === "hook.degraded" || entry.event === "hook.failed");
  assert.ok(configEvent, `日志应记录使用了该配置：${JSON.stringify(entries.slice(-3))}`);

  // And the unreachable core still must not leak anything it was told.
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(TEST_TOKEN));
});

test("missing or outside project cwd skips hooks without blocking or sending requests", async () => {
  const service = await startServer((_request, response) => {
    json(response, 200, { decision: "deny", reason: "should not run", knowledgeRevision: 1, context: "" });
  });
  const config = await createConfig(service.endpoint);
  const outside = await mkdtemp(join(tmpdir(), "amb-codex-outside-"));
  fixtureDirs.add(outside);

  for (const cwd of [null, outside]) {
    const result = await runHook({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd }, config);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  }
  assert.equal(service.requests.length, 0);
});

test("invalid endpoint or token is ignored outside scope and denied inside scope", async () => {
  const outside = await mkdtemp(join(tmpdir(), "amb-codex-other-project-"));
  fixtureDirs.add(outside);
  const cases = [
    { endpoint: "https://example.com" },
    { endpoint: "http://127.0.0.1:47631", token: "" },
  ];

  for (const overrides of cases) {
    const config = await createConfig("http://127.0.0.1:47631", overrides);
    const outsideResult = await runHook(
      { hook_event_name: "PreToolUse", tool_name: "Bash", cwd: outside },
      config,
    );
    assert.equal(outsideResult.status, 0, outsideResult.stderr);
    assert.equal(outsideResult.stdout, "");
    assert.equal(outsideResult.stderr, "");

    const insideResult = await runHook(
      { hook_event_name: "PreToolUse", tool_name: "Bash", cwd: join(dirname(config), "project") },
      config,
    );
    const output = parseStdout(insideResult);
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /configuration|endpoint/i);
  }
});

test("non-loopback endpoints are rejected before any request", async () => {
  const config = await createConfig("http://example.com");
  const result = await runHook(
    { hook_event_name: "PreToolUse", tool_name: "Bash" },
    config,
  );
  const output = parseStdout(result);

  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /loopback/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(TEST_TOKEN));
});
