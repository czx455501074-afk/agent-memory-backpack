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
    if (request.url === '/v1/knowledge/search-universal') return json(response, 200, { results: [], knowledgeRevision: 7 });
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
  assert.equal(service.requests.length, 2);
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

test('Codex real core: prompt automatically reads body and Stop saves one unverified journal with a retrievable receipt', async () => {
  const { Store } = await import('../dist/src/store.js');
  const { createCoreServer } = await import('../dist/src/server.js');
  const store = new Store(':memory:');
  const body = 'Resolve foobar by checking its installed path before retrying.';
  store.import([{ id: 'recall-fixture', kind: 'memory', title: 'foobar recovery', scope: { kind: 'global' },
    baseRevision: 0, provenance: 'user', body }]);
  const server = createCoreServer(store, { protocolVersion: 1, port: 47631,
    clients: [{ id: 'codex', token: TEST_TOKEN, projectId: 'project-fixture' }] });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  servers.add(server);
  const config = await createConfig(`http://127.0.0.1:${server.address().port}`, { projectRoot: null });
  const env = { AMB_LOG_DIR: dirname(config) };
  const prompt = await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'automatic-loop', prompt: 'foobar' }, config, env);
  assert.match(parseStdout(prompt).hookSpecificOutput.additionalContext, new RegExp(body.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const continued = await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'automatic-loop', prompt: '继续' }, config, env);
  assert.match(parseStdout(continued).hookSpecificOutput.additionalContext, /checking its installed path/,
    'A short continuation recalls the previous meaningful task query');
  const unbound = await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'fresh-unbound', prompt: '好的' }, config, env);
  assert.doesNotMatch(parseStdout(unbound).hookSpecificOutput.additionalContext, /recall-fixture|checking its installed path|AMB 自动检索并读取/,
    'An unbound confirmation must inject only standing norms, never arbitrary library contents');
  const stop = { hook_event_name: 'Stop', session_id: 'automatic-loop' };
  assert.equal((await runHook(stop, config, env)).status, 0);
  const first = store.searchUniversal('project-fixture', '', 'journal');
  assert.equal(first.length, 1);
  assert.equal(store.readKnowledge('project-fixture', first[0].id).outcome, 'unverified');
  const revision = store.revision;
  assert.equal((await runHook(stop, config, env)).status, 0);
  assert.equal(store.revision, revision, 'Repeated Stop of one turn must not create new journal revisions');
  const log = readFileSync(join(dirname(config), 'amb-plugin.log.jsonl'), 'utf8');
  assert.match(log, /knowledge.auto_recall/);
  assert.match(log, /readIds.*recall-fixture/);
  assert.match(log, /journal.persisted/);
  assert.doesNotMatch(log, new RegExp(TEST_TOKEN));
  store.close();
});

test('Codex retries queued delivery in the same session after the initial startup replay', async () => {
  let replayed = 0;
  const service = await startServer((request, response) => {
    if (request.url === '/health') return json(response, 200, { status: 'ok', protocolVersion: 1 });
    if (request.url === '/v1/outbox/replay') { replayed++; return json(response, 200, { attempted: replayed === 1 ? 0 : 1, delivered: [], failed: [] }); }
    if (request.url === '/v1/prepare') return json(response, 200, { protocolVersion: 1, knowledgeRevision: 1,
      mode: 'Managed', norms: [], workflows: [], context: '' });
    if (request.url === '/v1/events') return json(response, 503, { message: 'transient' });
    if (request.url === '/v1/outbox/enqueue') return json(response, 200, { id: 'outbox-1', queued: true });
    if (request.url === '/v1/knowledge/search-universal') return json(response, 200, { results: [] });
    json(response, 404, { message: 'missing' });
  });
  const config = await createConfig(service.endpoint);
  const session_id = 'same-session-recovery';
  assert.equal((await runHook({ hook_event_name: 'SessionStart', session_id }, config)).status, 0);
  assert.equal(replayed, 1);
  assert.equal((await runHook({ hook_event_name: 'PostToolUse', session_id, tool_name: 'read' }, config)).status, 0);
  assert.equal((await runHook({ hook_event_name: 'UserPromptSubmit', session_id, prompt: 'continue' }, config)).status, 0);
  assert.equal(replayed, 2, 'A completed startup replay must not permanently suppress future retries');
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

test('global Codex hook captures structured failure, with stable retry key and no raw output', async () => {
  const service = await startServer((request, response) => {
    if (request.url === '/v1/proposals') return json(response, 200, { id: 'captured', state: 'pending', duplicate: false });
    return json(response, 200, { id: 'event', stored: true, duplicate: false });
  });
  const config = await createConfig(service.endpoint, { projectRoot: null });
  const input = { hook_event_name: 'PostToolUse', cwd: tmpdir(), session_id: 'outside-project',
    tool_name: 'Bash', tool_response: { exit_code: 2, output: 'PRIVATE OUTPUT' } };
  for (let i = 0; i < 2; i++) {
    const result = await runHook(input, config);
    assert.equal(result.status, 0, result.stderr);
  }
  const proposals = service.requests.filter(r => r.url === '/v1/proposals');
  assert.equal(proposals.length, 2);
  assert.equal(proposals[0].body.idempotencyKey, proposals[1].body.idempotencyKey);
  assert.match(proposals[0].body.discovery, /exit_code=2/);
  assert.doesNotMatch(proposals[0].body.discovery, /PRIVATE OUTPUT/);
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

test("Stop files the task diary once per turn through the idempotent archive endpoint", async () => {
  const service = await startServer((request, response) => {
    if (request.url === "/v1/events") {
      return json(response, 200, {
        id: "event-fixture", stored: true, duplicate: false,
        taskId: "task-fixture", journalId: "journal-task-fixture", revision: 1, outcome: "unverified",
      });
    }
    if (request.url === "/v1/tasks/archive") {
      return json(response, 200, {
        taskId: request.body.taskId, projectId: request.body.projectId,
        knowledgeId: `journal-task-${request.body.taskId}`, revision: 1,
        replaced: false, unchanged: false, archivedAt: 1,
      });
    }
    json(response, 404, { message: "missing" });
  });
  const config = await createConfig(service.endpoint);
  const stop = { hook_event_name: "Stop", session_id: "thread-archive", turn_id: "turn-archive" };
  const archives = () => service.requests.filter((entry) => entry.url === "/v1/tasks/archive");

  assert.deepEqual(parseStdout(await runHook(stop, config)), { continue: true });
  assert.equal(archives().length, 1, "会话结束必须发起一次归档");
  assert.deepEqual(archives()[0].body, { projectId: "project-fixture", taskId: "task-fixture" });
  assert.equal(archives()[0].headers["x-amb-protocol"], "1", "归档调用必须带 x-amb-protocol: 1");

  // Idempotent at this end: a Stop retried for the same turn asks nothing again.
  assert.equal((await runHook(stop, config)).status, 0);
  assert.equal(archives().length, 1, "同一回合的重复 Stop 不得重复归档");

  // A later turn may file again; a duplicate cannot appear, because the core
  // answers `unchanged` for content that has not moved.
  const nextTurn = { ...stop, turn_id: "turn-archive-2" };
  assert.equal((await runHook(nextTurn, config)).status, 0);
  assert.equal(archives().length, 2, "新回合结束应再次归档，重复写入由 core 的内容幂等兜住");
});

test("Stop survives an unavailable archive and retries it on the next Stop", async () => {
  let archiveCalls = 0;
  const service = await startServer((request, response) => {
    if (request.url === "/v1/events") {
      return json(response, 200, {
        id: "event-fixture", stored: true, duplicate: false,
        taskId: "task-fixture", journalId: "journal-task-fixture", revision: 1, outcome: "unverified",
      });
    }
    if (request.url === "/v1/tasks/archive") {
      archiveCalls += 1;
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unavailable" }));
      return;
    }
    json(response, 404, { message: "missing" });
  });
  const config = await createConfig(service.endpoint);
  const stop = { hook_event_name: "Stop", session_id: "thread-archive-fail", turn_id: "turn-1" };

  const first = await runHook(stop, config);
  assert.equal(first.status, 0, "归档失败不得让 Stop 退出失败");
  assert.deepEqual(parseStdout(first), { continue: true });
  assert.equal(archiveCalls, 1);

  const retry = await runHook(stop, config);
  assert.equal(retry.status, 0);
  assert.equal(archiveCalls, 2, "失败的归档必须留待下次重试，而不是被记为已完成");
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
    // Both variables, because `homedir()` reads USERPROFILE on Windows and HOME
    // elsewhere. Setting only USERPROFILE left the real HOME in place on Linux and
    // macOS — `runHook` spreads the process environment — so the hook resolved the
    // operator's own data directory instead of this fixture and the assertion below
    // tested the wrong home. `adapter-config.test.ts` already sets both.
    { USERPROFILE: dir, HOME: dir },
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

test("F06: Codex hook 透传核心结构化错误（code + 业务 message），并剥离凭据类内容", async () => {
  // F06 covered the DSH adapter and the Codex hook alike; the hook change was
  // otherwise untested. A structured 4xx must reach the adapter log with its
  // controlled code and its actionable message, so a later diagnosis can tell a
  // missing dependency from a transient fault.
  //
  // The message survives only after sanitizing: credential-shaped content (the
  // configured token, a Bearer header, `password=`/`token=` pairs, long base64 or
  // hex blobs) is replaced with [redacted], because the log and the host's stderr
  // are read by people and by later agents.
  const service = await startServer((_request, response) =>
    json(response, 409, {
      code: "dependency_unavailable",
      message: `Required dependency realistic-prerequisite@1 is not current; Bearer ${"c".repeat(48)} token=${TEST_TOKEN}`,
    }),
  );
  const config = await createConfig(service.endpoint);
  const result = await runHook(
    { hook_event_name: "PreToolUse", tool_name: "Bash" },
    config,
  );
  // A structured 4xx is not a request to allow: the policy could not be checked,
  // so the hook records the real reason rather than fabricating a decision.
  assert.equal(result.stdout.includes('"permissionDecision":"allow"'), false, "未能核对策略时不得声称放行");

  const logPath = join(dirname(config), "amb-plugin.log.jsonl");
  assert.ok(existsSync(logPath), "适配器必须写出日志文件");
  const logText = readFileSync(logPath, "utf8");
  assert.match(logText, /dependency_unavailable/, "错误日志必须保留受控的核心错误码");
  assert.match(logText, /realistic-prerequisite@1/, "错误日志必须保留可执行的缺失依赖信息");
  assert.match(logText, /\[redacted\]/, "凭据类内容必须替换为占位符");
  assert.doesNotMatch(logText, /c{40}/, "长 base64 串严禁写入日志");
  assert.doesNotMatch(logText, new RegExp(TEST_TOKEN), "配置 token 严禁写入日志");
  assert.doesNotMatch(result.stdout + result.stderr, /c{40}/, "长 base64 串严禁回显到宿主输出");
});

test("prepare carries the revision the session already holds and sends nothing on a first turn", async () => {
  // R5 W6-1. The core suppresses the repeated normative prose only when the caller says
  // which revision it already has; without that field every turn re-sent the whole text.
  // The value comes from the same session state the gate path below writes, so a session
  // that has been through one tool call can dedup, while a brand-new session still sends
  // nothing — a guessed version would make the core suppress norms it never delivered.
  const service = await startServer((request, response) => {
    if (request.url === "/v1/gate") {
      return json(response, 200, { decision: "allow", reason: "", knowledgeRevision: 7, context: "gate context" });
    }
    if (request.url === "/v1/prepare") {
      return json(response, 200, {
        protocolVersion: 1, knowledgeRevision: 7, mode: "Managed", norms: [], workflows: [], context: "ctx",
      });
    }
    return json(response, 404, { error: "not found" });
  });
  const config = await createConfig(service.endpoint);
  const session = "dedup-session";

  const first = await runHook({ hook_event_name: "UserPromptSubmit", session_id: session, prompt: "first" }, config);
  assert.equal(first.status, 0, first.stderr);
  const gate = await runHook({ hook_event_name: "PreToolUse", session_id: session, tool_name: "read", tool_input: {} }, config);
  assert.equal(gate.status, 0, gate.stderr);
  const second = await runHook({ hook_event_name: "UserPromptSubmit", session_id: session, prompt: "second" }, config);
  assert.equal(second.status, 0, second.stderr);

  const prepares = service.requests.filter((request) => request.url === "/v1/prepare");
  assert.ok(prepares.length >= 2, `期望至少两次 prepare，实际 ${prepares.length}`);
  assert.equal(Object.hasOwn(prepares[0].body, "knowledgeRevision"), false,
    "首次 prepare 不得携带版本，否则核心会以为正文已经发过");
  assert.equal(prepares.at(-1).body.knowledgeRevision, 7, "之后每次 prepare 都必须带上会话已知版本");
});
