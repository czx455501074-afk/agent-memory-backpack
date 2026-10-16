import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { exportAll } from '../src/backup.js';

/**
 * The export guard has to hold two things at once, and each one is easy to lose
 * while fixing the other:
 *
 *   - a library that *documents* an API must still be exportable, because the
 *     bytes being refused are the instruction, not a secret;
 *   - a library that leaked a real credential must still be refused, because a
 *     guard that allowlists too widely protects nothing.
 *
 * These tests pin both directions. If someone later widens the placeholder rule to
 * make an export pass, the second test goes red.
 */

const roots: string[] = [];
function makeStore() {
  const directory = mkdtempSync(join(tmpdir(), 'backpack-guard-'));
  roots.push(directory);
  const store = new Store(join(directory, 'knowledge.sqlite'), () => 1000);
  return { store, directory };
}
test.after(() => {
  for (const path of roots) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // On Windows the database handle may still be open, which makes the temp
      // directory undeletable. A leftover temp folder is not a test failure - the
      // assertions above are the verdict, and failing the run over cleanup would
      // hide them.
    }
  }
});

function seed(store: Store, id: string, body: string) {
  store.import([{ id, baseRevision: 0, kind: 'memory', title: id, body, scope: { kind: 'global' } }]);
}

function exportInto(source: { store: Store }, targetDir: string) {
  return exportAll(source.store, { directory: join(targetDir, 'out') });
}

/** Exports a one-note library and reports whether the guard let it through. */
function exportWith(body: string): { ok: boolean; reason: string } {
  const { store, directory } = makeStore();
  seed(store, 'memory:probe', body);
  try {
    exportInto({ store }, directory);
    return { ok: true, reason: '' };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

// --- placeholder forms seen in real documentation: export must succeed ---

for (const { label, body } of [
  { label: 'an ellipsis value', body: 'Set it with API_KEY=... and restart.' },
  { label: 'an angle-bracket placeholder', body: 'Pass it as `api-key: <key>` in the request.' },
  { label: 'a named-placeholder value', body: 'Export API_KEY=your_key before running.' },
  { label: 'a bearer placeholder', body: 'The header is "Bearer sk-xxx".' },
  { label: 'an environment reference', body: 'Reads api_key=$RUNPOD_API_KEY from the shell.' },
  { label: 'a docs-only mention of a bearer token', body: 'Send a Bearer token with each call.' },
  { label: 'a shell-variable interpolation', body: 'access_token: ${{ secrets.TOKEN }}' },
  { label: 'an upper-case placeholder constant', body: 'Set API_KEY=REPLACE_ME first.' },
  { label: 'this system\'s own database file name', body: 'The records live in knowledge.sqlite under the data directory.' },
  { label: 'a private-key header written as a pattern', body: 'The rule matches -----BEGIN .*PRIVATE KEY----- anywhere in the text.' },
  { label: 'a note naming the credential file', body: 'The credential lives in admin-client.json, next to core.json, in the data directory.' },
]) {
  test(`export succeeds when the note contains ${label}`, () => {
    const result = exportWith(body);
    assert.equal(result.ok, true, `expected the export to pass, but the guard refused: ${result.reason}`);
  });
}

// --- real credentials: export must still be refused ---

for (const { label, body } of [
  { label: 'an anthropic-style live key', body: 'Use api_key=sk-ant-api03-AbCdEf1234567890XyZ for the call.' },
  { label: 'a github token', body: 'token: ghp_AbCdEfGhIjKlMnOpQrStUvWxYz012345' },
  { label: 'a bearer value that is not a placeholder', body: 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' },
  { label: 'a literal password', body: 'password=hunter2correct' },
  { label: 'a private key header', body: '-----BEGIN RSA PRIVATE KEY-----' },
  { label: 'an access token value', body: 'access_token: 8f3c9d2e7b1a4f6c0e5d8b3a9c2f7e1d' },
  // Regression: a long all-letter value after a *token prefix* is a key, not prose.
  // "The value has no digits" reads as documentation only after a setting name.
  { label: 'a key-shaped all-letter value after a token prefix', body: 'Set api_key=sk-abcdefghijklmnopqrstuvwxyz before running.' },
  { label: 'an all-letter bearer value', body: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz' },
]) {
  test(`export is refused when the note contains ${label}`, () => {
    const result = exportWith(body);
    assert.equal(result.ok, false, 'expected the guard to refuse a real credential');
    assert.match(result.reason, /Credential-shaped/);
  });
}
