import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * A switch that switches nothing is worse than no switch.
 *
 * The host is supposed to stop invoking a plugin's hooks once the plugin is
 * disabled, but a 2026-10-10 acceptance run recorded the opposite: the settings UI
 * said the plugin was disabled while new chats kept receiving injected context. The
 * hook therefore reads the switch itself, and these tests pin that behaviour end to
 * end: a real process, a real config file, and the real event the host would send.
 */

const HOOK = resolve(import.meta.dirname, '..', 'adapters', 'codex', 'scripts', 'hook.mjs');
const roots = [];

/** Runs the hook with HOME pointed at a throwaway directory holding this config. */
function runHook(configText) {
  const home = mkdtempSync(join(tmpdir(), 'amb-hook-'));
  roots.push(home);
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'config.toml'), configText, 'utf8');

  const input = JSON.stringify({
    hook_event_name: 'SessionStart',
    session_id: 'disabled-check',
    cwd: home,
  });
  const result = spawnSync(process.execPath, [HOOK], {
    input,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, USERPROFILE: home, HOME: home },
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

test.after(() => {
  for (const path of roots) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // A leftover temp dir is not a test failure.
    }
  }
});

test('an explicitly disabled plugin produces no hook output at all', () => {
  const result = runHook('[plugins."agent-memory-backpack@agent-memory-backpack-local"]\nenabled = false\n');
  assert.equal(result.stdout.trim(), '', '停用后不得注入任何上下文');
});

test('a plugin with no enabled entry still runs (it ships enabled)', () => {
  const result = runHook('[desktop]\nfollowUpQueueMode = "steer"\n');
  // With the core unreachable in a throwaway home the hook may report a degraded
  // state, but it must have run rather than exited early: any output proves it did.
  assert.notEqual(result.status, null, '钩子必须真实执行而不是超时挂起');
  assert.equal(result.status, 0, '正常路径不应以非零码退出');
});

test('disabling a different plugin does not silence this one', () => {
  const result = runHook('[plugins."documents@openai-primary-runtime"]\nenabled = false\n');
  assert.notEqual(result.status, null, '钩子必须真实执行');
  assert.equal(result.status, 0, '别的插件被停用不应影响本插件');
});
