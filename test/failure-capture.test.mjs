import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { failureCandidate, captureFailure, classifyFailureOrigin, FAILURE_ORIGINS, FAILURE_ORIGIN_MARKER } from '../adapters/dsh/failure-capture.mjs'
import { classifyFailureOrigin as codexClassify } from '../adapters/codex/scripts/failure-capture.mjs'
import { loadSpool } from '../adapters/dsh/spool.mjs'

const base = { adapter: 'dsh', projectId: 'shared', sessionId: 'session-a', tool: 'shell' }
test('W14：捕获时按来源分类，且两侧适配器与核心判定器结果一致', async () => {
  /**
   * One fixture table, three implementations: the DSH adapter, the Codex adapter and the
   * compiled core classifier. The adapter ships as a standalone plugin copy with no
   * access to the core build, so the rule table exists twice — this test is what makes a
   * drift between them a failure instead of a silent difference in how the same error is
   * filed depending on which host captured it.
   *
   * Every expected value is a shape this library's own queue contains, measured with
   * `verification/r5/replay-failure-origin.mjs`.
   */
  const cases = [
    ['old_string was not found in "D:\\huange-skill\\src\\refine.ts"', 'tool_collision'],
    ['cannot edit "D:\\p\\recall.mjs": file changed since it was read — re-read the file, then retry', 'tool_collision'],
    ['ReplaceFileW EIO (Win32 1175)', 'environment'],
    ['tool call timed out after 30000ms', 'environment'],
    ['EPERM: operation not permitted', 'environment'],
    ['listen EADDRINUSE: address already in use 127.0.0.1:8787', 'environment'],
    ['tool call aborted', 'environment'],
    // Not a collision and not an accident: the callers' own argument/staleness errors and
    // ordinary tool failures stay in the sampled population.
    ['cannot modify "D:\\p\\a.ts": file has not been read — read the file, then retry', 'task_failure'],
    ['exit_code=1', 'task_failure'],
    ['pwsh: stderr: ENOENT: configuration file missing', 'task_failure'],
    ['read: cannot read "D:\\p\\missing.ts": not found', 'task_failure'],
  ]
  const { classifyFailureOrigin: coreClassify } = await import('../dist/src/refine.js')
  for (const [observation, expected] of cases) {
    assert.equal(classifyFailureOrigin(observation).origin, expected, `dsh 侧：${observation}`)
    assert.equal(codexClassify(observation).origin, expected, `codex 侧：${observation}`)
    assert.equal(coreClassify(observation).origin, expected, `核心侧：${observation}`)
    assert.deepEqual(classifyFailureOrigin(observation), codexClassify(observation), '两侧规则表必须同判')
    assert.deepEqual(classifyFailureOrigin(observation), coreClassify(observation), '适配器与核心必须同判')
  }
  assert.equal(FAILURE_ORIGINS.length, 3)

  // The class the host decided is written into the row, and the idempotency key — the
  // thing that stops a re-capture from creating a second candidate — is not derived from
  // it. These two hex values were recorded from the *pre-change* adapter at HEAD and must
  // still hold: a different key would re-file every existing failure as new on upgrade.
  const collision = failureCandidate({ ...base, tool: 'edit', result: { isError: true, error: 'old_string was not found in "D:\\p\\a.ts"' } })
  assert.match(collision.discovery, /失败来源类别：tool_collision；判据：concurrent_edit_target_missing。/)
  assert.equal(collision.idempotencyKey, 'failure:388559f20202d0a78d9de51580572a23')
  const generic = failureCandidate({ ...base, tool: 'pwsh', result: { exit_code: 1, stderr: 'ENOENT: configuration file missing' } })
  assert.match(generic.discovery, /失败来源类别：task_failure；判据：default。/)
  assert.equal(generic.idempotencyKey, 'failure:9e7e38e05c7b116af93e336c433edb46')
  // The marker sits outside the text `autoFailureSignature` reads as the observation, so
  // it cannot change the signature a row groups under.
  const observationOf = (discovery) => /观察：([\s\S]*?)(?:\n信息不足：|\n根因与修复：|$)/.exec(discovery)[1].trim()
  assert.equal(observationOf(collision.discovery), 'old_string was not found in "D:\\p\\a.ts"')
  assert.equal(FAILURE_ORIGIN_MARKER, '失败来源类别：')
})

test('structured failures only, bounded evidence, secret removal and session deduplication', () => {
  assert.equal(failureCandidate({ ...base, result: { output: 'error: just a diagnostic', exit_code: 0 } }), null)
  const input = { ...base, result: { isError: true, error: { message: 'ENOENT token=hidden-secret-value Bearer another-secret-value' }, output: 'DO NOT STORE OUTPUT' } }
  const candidate = failureCandidate(input)
  assert.match(candidate.discovery, /ENOENT/)
  assert.doesNotMatch(candidate.discovery, /hidden-secret-value|another-secret-value|DO NOT STORE/)
  assert.match(candidate.discovery, /待核实/)
  assert.equal(candidate.idempotencyKey, failureCandidate(input).idempotencyKey)
  assert.notEqual(candidate.idempotencyKey, failureCandidate({ ...input, sessionId: 'session-b' }).idempotencyKey)
  assert.equal(failureCandidate({ ...input, tool: 'amb_read_knowledge' }), null)
  assert.equal(failureCandidate({ ...input, sessionId: '' }), null)
  assert.match(failureCandidate({ ...base, result: { value: { exitCode: 7 } } }).discovery, /exit_code=7/)
  assert.equal(readFileSync(new URL('../adapters/dsh/failure-capture.mjs', import.meta.url), 'utf8'),
    readFileSync(new URL('../adapters/codex/scripts/failure-capture.mjs', import.meta.url), 'utf8'))
})
test('outage preserves candidate locally, 4xx is not queued, disable is respected', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'amb-capture-'))
  const records = []
  const logger = { info: (...args) => records.push(args), warn: (...args) => records.push(args) }
  // Capture is opt-in now; this suite tests the capture path, so it switches it on by name. The
  // opt-out assertion below still pins the opposite direction.
  const config = { projectId: 'shared', dataDir, token: 'secret', autoCaptureFailures: true }
  const options = { ...base, result: { isError: true, error: 'missing binary' } }
  try {
    const client = { post: async () => { throw new Error('unavailable') } }
    const receipt = await captureFailure(options, { config, client, logger })
    assert.equal(receipt.state, 'queued_local')
    assert.equal(loadSpool(dataDir).length, 1)
    const reject = { post: async () => { throw Object.assign(new Error('refused'), { status: 403 }) } }
    await captureFailure({ ...options, sessionId: 'other' }, { config, client: reject, logger })
    assert.equal(loadSpool(dataDir).length, 1)
    assert.equal(await captureFailure(options, { config: { ...config, autoCaptureFailures: false }, client, logger }), null)
    assert(records.some(([event]) => event === 'experience.queued'))
    assert(records.some(([event]) => event === 'experience.rejected'))
  } finally { rmSync(dataDir, { recursive: true, force: true }) }
})

test('same-session exit1 failures with different structured stderr remain distinct; exact retries deduplicate', () => {
  const a = { ...base, result: { value: { exitCode: 1, stderr: 'ENOENT: configuration file missing' } } }
  const b = { ...base, result: { exit_code: 1, stderr: 'EACCES: directory permission denied' } }
  assert.notEqual(failureCandidate(a).idempotencyKey, failureCandidate(b).idempotencyKey)
  assert.equal(failureCandidate(a).idempotencyKey, failureCandidate(a).idempotencyKey)
  assert.match(failureCandidate(a).discovery, /ENOENT/)
  assert.match(failureCandidate(b).discovery, /EACCES/)
  const genericError = { ...base, result: { isError: true, error: 'process failed', stderr: 'Missing import' } }
  assert.notEqual(failureCandidate(genericError).idempotencyKey,
    failureCandidate({ ...genericError, result: { ...genericError.result, stderr: 'Network timeout' } }).idempotencyKey)
})

test('stderr evidence is bounded and redacted, with no raw command or success-keyword capture', () => {
  const candidate = failureCandidate({ ...base, secret: 'known-secret', command: 'DO_NOT_STORE_COMMAND', arguments: ['DO_NOT_STORE_ARGUMENT'],
    result: { exit_code: 1, stderr: 'ENOENT token=hidden-token password=hidden-password {"api_key":"json-secret"} Bearer bearer-value ghp_privategithubtoken known-secret ' + 'x '.repeat(600),
      stdout: 'DO_NOT_STORE_STDOUT', command: 'DO_NOT_STORE_COMMAND', arguments: ['DO_NOT_STORE_ARGUMENT'] } })
  assert.match(candidate.discovery, /ENOENT/)
  assert.doesNotMatch(candidate.discovery, /hidden-token|hidden-password|json-secret|bearer-value|ghp_privategithubtoken|known-secret|DO_NOT_STORE/)
  assert.ok(candidate.discovery.split('观察：')[1].split('\n')[0].length <= 500)
  assert.equal(failureCandidate({ ...base, result: { exit_code: 0, stderr: 'error ENOENT failure', stdout: 'fatal error' } }), null)
  assert.equal(failureCandidate({ ...base, result: { stderr: 'error ENOENT failure' } }), null)
  assert.match(failureCandidate({ ...base, result: { exit_code: 1 } }).discovery, /信息不足/)
  assert.match(failureCandidate({ ...base, result: { exit_code: 1 } }).discovery, /exit_code=1/)
})
