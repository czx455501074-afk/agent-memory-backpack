import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

async function scratch(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}
async function cleanup(dir: string): Promise<void> {
  const rel = relative(resolve(tmpdir()), resolve(dir));
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await rm(dir, { recursive: true, force: true });
}

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Load the adapter's logger.
 *
 * The adapter ships plain JS because it runs inside the host process, so it has
 * no TypeScript declaration. Loading it through Node's real module loader keeps
 * the test honest about the shipped artifact.
 */
interface AdapterLogRecord { ts: string; level: string; event: string; [key: string]: unknown }
interface AdapterLogger {
  file: string;
  isDegraded(): boolean;
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  read(options?: { limit?: number; includeRotated?: boolean }): AdapterLogRecord[];
}
interface LogModule {
  createAdapterLogger(options?: { dir?: string; level?: string; now?: () => number }): AdapterLogger;
  defaultLogPath(env?: Record<string, string | undefined>): string;
}

const require = createRequire(import.meta.url);
/**
 * Repository root, resolved from this file rather than the process cwd.
 *
 * Compiled tests live in `dist/test/`, so a relative path to the adapters would
 * resolve one level too deep. Anchoring on the file's own location keeps the test
 * working from both the compiled output and a direct run.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
let cached: LogModule | undefined;
function loadLog(): LogModule {
  if (!cached) cached = require(join(repoRoot, 'adapters', 'dsh', 'log.mjs')) as LogModule;
  return cached;
}

test('两份适配器日志实现必须逐字一致', async () => {
  // The DSH and Codex adapters each carry their own copy so neither depends on
  // the other being installed. Copies drift, so identity is asserted rather than
  // trusted: a fix applied to one file must reach the other.
  const dsh = await readFile(join(repoRoot, 'adapters', 'dsh', 'log.mjs'), 'utf8');
  const codex = await readFile(join(repoRoot, 'adapters', 'codex', 'scripts', 'log.mjs'), 'utf8');
  assert.equal(sha(dsh), sha(codex), 'adapters/dsh/log.mjs 与 adapters/codex/scripts/log.mjs 必须完全相同');
});

test('适配器日志：结构化、可过滤、带时间戳', async () => {
  const dir = await scratch('amb-alog-');
  try {
    const logger = loadLog().createAdapterLogger({ dir, now: () => Date.UTC(2026, 0, 1) });
    logger.info('adapter.load', { adapter: 'dsh', pluginVersion: '0.1.0-test' });
    logger.warn('tool.out_of_scope', { tool: 'amb_prepare' });
    logger.error('tool.failed', { tool: 'amb_read_stage', ms: 12, message: 'boom' });
    logger.debug('tool.ok', { tool: 'amb_prepare', ms: 3 });

    const records = logger.read();
    assert.equal(records.length, 3, 'debug 在 info 级别应被过滤');
    assert.deepEqual(records.map(r => r.event), ['adapter.load', 'tool.out_of_scope', 'tool.failed']);
    assert.equal(records[0]!.pluginVersion, '0.1.0-test');
    assert.match(String(records[0]!.ts), /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(logger.isDegraded(), false);

    // One JSON object per line.
    for (const line of (await readFile(logger.file, 'utf8')).trim().split('\n')) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
  } finally { await cleanup(dir); }
});

test('适配器日志绝不写入凭据', async () => {
  const dir = await scratch('amb-alog-secret-');
  try {
    const logger = loadLog().createAdapterLogger({ dir });
    logger.error('adapter.config_failed', {
      token: 'dsh-secret-token-value',
      authorization: 'Bearer another-secret',
      nested: { apiKey: 'nested-secret', safe: 'keep-this' },
    });
    const raw = await readFile(logger.file, 'utf8');
    assert.equal(raw.includes('dsh-secret-token-value'), false, 'token 不得落盘');
    assert.equal(raw.includes('another-secret'), false, 'authorization 不得落盘');
    assert.equal(raw.includes('nested-secret'), false, '嵌套 apiKey 不得落盘');
    assert.equal(raw.includes('keep-this'), true, '普通字段必须保留');
  } finally { await cleanup(dir); }
});

test('适配器日志不可写时降级为静默，不抛错', async () => {
  // A read-only data dir must not break every tool call. `isDegraded` surfaces it
  // so diagnostics can report the loss rather than the log lying by omission.
  const dir = await scratch('amb-alog-degraded-');
  try {
    const blocked = join(dir, 'not-a-dir');
    // A regular file where a directory is expected, so mkdir fails.
    await writeFile(blocked, 'x', 'utf8');
    const logger = loadLog().createAdapterLogger({ dir: join(blocked, 'nested') });
    assert.equal(logger.isDegraded(), true);
    assert.doesNotThrow(() => logger.info('anything', { a: 1 }));
    assert.doesNotThrow(() => logger.error('anything', { a: 1 }));
  } finally { await cleanup(dir); }
});

test('日志目录解析：显式目录优先，其次跟随配置位置，最后回落默认目录', () => {
  const { defaultLogPath } = loadLog();
  const explicit = defaultLogPath({ AMB_LOG_DIR: join(tmpdir(), 'explicit-dir') });
  assert.equal(explicit, resolve(tmpdir(), 'explicit-dir'));

  const besideConfig = defaultLogPath({ AMB_DSH_CONFIG: join(tmpdir(), 'cfg', 'dsh-client.json') });
  assert.equal(besideConfig, resolve(tmpdir(), 'cfg'));

  const fallback = defaultLogPath({});
  assert.match(fallback, /\.agent-memory-backpack$/, '无任何配置时应回落到默认数据目录');
});

test('适配器在加载与工具失败路径上确实写日志', async () => {
  // Static assertion that the wiring exists at the single registration point,
  // rather than only in the logger module.
  const source = await readFile(join(repoRoot, 'adapters', 'dsh', 'index.mjs'), 'utf8');
  assert.match(source, /createAdapterLogger\(\)/);
  assert.match(source, /logger\.info\('adapter\.load'/);
  assert.match(source, /logger\.error\('tool\.failed'/);
  assert.match(source, /logger\.warn\('tool\.out_of_scope'/);
  assert.match(source, /logger\.error\('event\.delivery_failed'/);
  assert.match(source, /logger\.error\('adapter\.config_failed'/);
  // The version constant must match the package manifest.
  const manifest = JSON.parse(await readFile(join(repoRoot, 'adapters', 'dsh', 'package.json'), 'utf8'));
  assert.match(source, new RegExp(`PLUGIN_VERSION = '${manifest.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
});
