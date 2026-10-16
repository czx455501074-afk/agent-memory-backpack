import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Script } from 'node:vm';
import { spawnSync } from 'node:child_process';
import { validateDshClient } from '../scripts/validate-dsh-client.mjs';

const root = resolve(import.meta.dirname, '..');

test('DSH browser bundle compiles and registers through the classic script loader', () => {
  let registration;
  new Script(readFileSync(join(root, 'adapters/dsh/client.js'), 'utf8')).runInNewContext({
    window: { __ModuleLoader__: { load(value) { registration = value; } } },
  });
  assert.equal(registration.id, 'dsh-agent-memory-backpack');
  const exported = registration.factory(name => {
    assert.equal(name, 'react');
    return {};
  });
  assert.equal(typeof exported.apply, 'function');
});

test('the panel reads the host JSON endpoints instead of an embedded page address', () => {
  // The earlier revision asked the host for a page address and embedded that
  // document. The native panel reads JSON only, so this client must never ask
  // for an address again: an address request here would mean the embedded path
  // came back. The full panel contract lives in dsh-client-surface.test.mjs.
  const clientSource = readFileSync(join(root, 'adapters/dsh/client.js'), 'utf8');
  assert.equal(clientSource.includes('/amb/ui-url'), false, '面板不得再请求页面地址端点');
  assert.equal(/iframe/i.test(clientSource), false, '面板不得嵌入外部文档');
  for (const endpoint of ['/amb/summary', '/amb/search', '/amb/task']) {
    assert(clientSource.includes(endpoint), `面板必须读取 ${endpoint}`);
  }
  let registration;
  new Script(clientSource).runInNewContext({
    window: { __ModuleLoader__: { load(value) { registration = value; } } },
  });
  const exported = registration.factory(() => ({}));
  assert.equal(typeof exported.apply, 'function');
});

test('invalid artifact is rejected before deploy or update can change the installation', t => {
  const directory = mkdtempSync(join(tmpdir(), 'amb-client-syntax-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const artifact = join(directory, 'artifact'), plugin = join(artifact, 'dsh-plugin');
  const target = join(directory, 'installed');
  mkdirSync(plugin, { recursive: true });
  mkdirSync(target);
  writeFileSync(join(plugin, 'client.js'), 'var endpoint = value.replace(/' + '\\'.repeat(2) + '/ui$/, "");');
  writeFileSync(join(plugin, 'ensure-core.mjs'), '// sentinel');
  writeFileSync(join(target, 'sentinel.txt'), 'existing installation');
  assert.throws(() => validateDshClient(plugin), /Invalid regular expression flags/);
  for (const [script, option] of [['deploy-plugin.mjs', '--target'], ['update-installed.mjs', '--dsh-dir']]) {
    const result = spawnSync(process.execPath, [join(root, 'scripts', script), '--artifact', artifact, option, target], {
      encoding: 'utf8', windowsHide: true,
    });
    assert.notEqual(result.status, 0, script);
    assert.match(result.stderr, /Invalid regular expression flags/);
    assert.equal(readFileSync(join(target, 'sentinel.txt'), 'utf8'), 'existing installation');
  }
});
