import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { failureCandidate, captureFailure } from '../adapters/dsh/failure-capture.mjs'
import { loadSpool } from '../adapters/dsh/spool.mjs'

const base = { adapter: 'dsh', projectId: 'shared', sessionId: 'session-a', tool: 'shell' }
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
  const config = { projectId: 'shared', dataDir, token: 'secret' }
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
