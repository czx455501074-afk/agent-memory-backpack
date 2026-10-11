import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { Logger } from '../src/log.js';
import { doctor, compareHostVersion, pluginVersion, summarizeDoctor } from '../src/doctor.js';
import { exportSkills, renderSkill, EXPORT_MARKER } from '../src/export-skills.js';
import { Store } from '../src/store.js';
import { knowledgeSchema, type Knowledge, type KnowledgeDraft } from '../src/schema.js';

async function scratch(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}
async function cleanup(dir: string): Promise<void> {
  const rel = relative(resolve(tmpdir()), resolve(dir));
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Run log
// ---------------------------------------------------------------------------

test('运行日志：结构化可读、按级别过滤，并携带版本信息', async () => {
  let now = Date.UTC(2026, 0, 1);
  const dir = await scratch('amb-log-');
  try {
    const logger = new Logger(dir, { now: () => now });
    logger.stamp({ pluginVersion: '0.1.0-test', nodeVersion: process.versions.node, scanRoots: ['/a'] });
    logger.info('core.listening', { port: 47631, knowledgeRevision: 3 });
    logger.warn('rescan.slow', { ms: 900 });
    logger.error('rescan.failed', { message: 'boom' });
    logger.debug('noise', { detail: 'should be filtered at info level' });

    const all = logger.read();
    assert.equal(all.length, 4, 'debug 在 info 级别应被过滤');
    assert.deepEqual(all.map(r => r.event), ['run.start', 'core.listening', 'rescan.slow', 'rescan.failed']);
    // Version stamps are what make an old log interpretable after an update.
    assert.equal(all[0]!.pluginVersion, '0.1.0-test');
    assert.equal(all[0]!.level, 'info');
    assert.match(String(all[0]!.ts), /^\d{4}-\d{2}-\d{2}T/);

    // Level filter and event filter both work.
    assert.equal(logger.read({ level: 'warn' }).length, 2);
    assert.equal(logger.read({ event: 'rescan' }).length, 2);
    assert.equal(logger.read({ limit: 1 }).length, 1);
    assert.equal(logger.isDegraded, false);

    // One JSON object per line, so ordinary tools can read it.
    const raw = await readFile(logger.file, 'utf8');
    for (const line of raw.trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line));
  } finally { await cleanup(dir); }
});

test('运行日志绝不写入凭据，即使调用方传了', async () => {
  const dir = await scratch('amb-log-secret-');
  try {
    const logger = new Logger(dir);
    logger.info('adapter.request', {
      token: 'super-secret-token-value',
      authorization: 'Bearer also-secret',
      nested: { apiKey: 'nested-secret', ok: 'visible' },
      safe: 'this one is fine',
    });
    const raw = await readFile(logger.file, 'utf8');
    assert.equal(raw.includes('super-secret-token-value'), false, 'token 值不得落盘');
    assert.equal(raw.includes('also-secret'), false, 'authorization 值不得落盘');
    assert.equal(raw.includes('nested-secret'), false, '嵌套 apiKey 不得落盘');
    assert.equal(raw.includes('[redacted]'), true, '被脱敏的字段必须留下痕迹');
    assert.equal(raw.includes('this one is fine'), true, '普通字段必须保留');
  } finally { await cleanup(dir); }
});

test('运行日志轮转，且写失败不抛错', async () => {
  const dir = await scratch('amb-log-rotate-');
  try {
    const logger = new Logger(dir, { maxBytes: 500, keep: 2 });
    for (let index = 0; index < 40; index += 1) logger.info('tick', { index });
    const files = await readdir(dir);
    assert.ok(files.some(name => name === 'amb.log.jsonl'), '当前日志必须存在');
    assert.ok(files.some(name => name.endsWith('.1')), '轮转文件必须产生');
    assert.equal(files.some(name => name.endsWith('.4')), false, '不得超过保留份数');
    // Rotated files are opt-in when reading.
    assert.ok(logger.read().length < logger.read({ includeRotated: true }).length);
  } finally { await cleanup(dir); }
});

// ---------------------------------------------------------------------------
// Self-check
// ---------------------------------------------------------------------------

test('自检：无配置时给出可操作结论，且不打印凭据', async () => {
  const dir = await scratch('amb-doctor-');
  try {
    const report = await doctor({ dataDir: dir, offline: true });
    assert.equal(report.ok, false, '缺配置必须判为有问题');
    const configCheck = report.checks.find(c => c.id === 'client-config-present');
    assert.equal(configCheck?.status, 'fail');
    assert.ok(configCheck?.hint, '失败项必须给建议');
    assert.match(summarizeDoctor(report), /^PROBLEMS/);

    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes('"token"'), false, '自检输出不得包含凭据字段值');
  } finally { await cleanup(dir); }
});

test('自检：配置合法时报告凭据形态而非内容，并核对核心可达与协议', async () => {
  const dir = await scratch('amb-doctor-ok-');
  try {
    const token = 'f'.repeat(64);
    await writeFile(join(dir, 'client.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:9', token, projectId: 'p0' }));
    const report = await doctor({
      dataDir: dir, clientPath: join(dir, 'client.json'),
      fetchImpl: async () => new Response(JSON.stringify({ protocolVersion: 1, status: 'ok', phase: 'P0' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    });
    assert.equal(report.checks.find(c => c.id === 'client-config-shape')?.status, 'pass');
    assert.equal(report.checks.find(c => c.id === 'protocol-match')?.status, 'pass');
    assert.equal(report.checks.find(c => c.id === 'core-reachable')?.status, 'pass');

    // The credential shape is reported; the value never is.
    const credential = report.checks.find(c => c.id === 'credential-shape');
    assert.match(credential!.detail, /64 characters/);
    assert.equal(JSON.stringify(report).includes(token), false, '自检输出不得包含凭据原文');
    assert.equal(report.ok, true);
  } finally { await cleanup(dir); }
});

test('自检：核心不可达时报失败并给出启动建议，协议不符报失败', async () => {
  const dir = await scratch('amb-doctor-down-');
  try {
    const token = 'a'.repeat(64);
    await writeFile(join(dir, 'client.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:9', token, projectId: 'p0' }));

    const down = await doctor({
      dataDir: dir, clientPath: join(dir, 'client.json'),
      fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); },
    });
    assert.equal(down.checks.find(c => c.id === 'core-reachable')?.status, 'fail');
    assert.match(down.checks.find(c => c.id === 'core-reachable')!.hint!, /serve/);
    assert.equal(down.ok, false);

    const stale = await doctor({
      dataDir: dir, clientPath: join(dir, 'client.json'),
      fetchImpl: async () => new Response(JSON.stringify({ protocolVersion: 2, status: 'ok' }), { status: 200 }),
    });
    const protocol = stale.checks.find(c => c.id === 'protocol-match');
    assert.equal(protocol?.status, 'fail', '协议不一致必须判为失败');
  } finally { await cleanup(dir); }
});

test('版本探测在仓库布局与产物布局下都能读出真实版本', () => {
  // The packaged artifact places the compiled core at `core/runtime/`, where the
  // manifest sits one level up rather than two. A single hardcoded path reported
  // "unknown" in the artifact, which is the one field a user needs when reporting
  // a problem against a specific release.
  const version = pluginVersion();
  assert.notEqual(version, 'unknown', '必须能从当前布局读出插件版本');
  assert.match(version, /^\d+\.\d+\.\d+/, `版本号格式应可读，实际：${version}`);
});

test('版本比较：区间内为通过，主版本差异只警告不失败', () => {
  assert.equal(compareHostVersion('0.2.0-rc.2').status, 'pass');
  assert.equal(compareHostVersion('0.2.9').status, 'warn', '同主版本的更新应被接受，仅提示');
  assert.equal(compareHostVersion('0.3.0').status, 'warn');
  assert.equal(compareHostVersion('1.0.0').status, 'warn', '主版本差异不得直接判失败');
  assert.equal(compareHostVersion('not-a-version').status, 'skip');
  // A warned version still carries a hint, and never reads as a hard failure.
  assert.ok(compareHostVersion('0.2.9').hint);
});

test('自检报告插件日志状态：缺失时提示，存在时给出大小', async () => {
  const dir = await scratch('amb-doctor-pluginlog-');
  try {
    const token = 'c'.repeat(64);
    await writeFile(join(dir, 'client.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:9', token, projectId: 'p0' }));
    const options = { dataDir: dir, clientPath: join(dir, 'client.json'), offline: true };

    const before = await doctor(options);
    const missing = before.checks.find(c => c.id === 'plugin-log-present');
    assert.equal(missing?.status, 'warn', '插件日志尚未生成时应提示而非失败');
    assert.ok(missing?.hint, '提示必须说明如何让它出现');

    // Once the adapter has run, the check reports the file rather than warning.
    await writeFile(join(dir, 'amb-plugin.log.jsonl'), '{"ts":"x","level":"info","event":"adapter.load"}\n', 'utf8');
    const after = await doctor(options);
    const present = after.checks.find(c => c.id === 'plugin-log-present');
    assert.equal(present?.status, 'pass');
    assert.match(present!.detail, /amb-plugin\.log\.jsonl/);
  } finally { await cleanup(dir); }
});

// ---------------------------------------------------------------------------
// Skill export: usable without the plugin
// ---------------------------------------------------------------------------

function workflowFixture(id: string): Knowledge {
  // Parsed, because `renderSkill` consumes a stored entry: the parse is what fills
  // the defaulted metadata, and it is also what the store does before writing.
  return knowledgeSchema.parse({
    id, kind: 'workflow', title: `流程 ${id}`, scope: { kind: 'global' }, baseRevision: 0,
    overview: '完整流程概览。', triggers: ['需要执行时'], categories: [['测试']], tags: [], isEntryPoint: true,
    preconditions: ['已确认环境'],
    stages: [{ id: 'step', title: '第一步', instructions: '执行并核对。', checks: ['结果可核对'], dependencies: [] }],
    completion: ['全部检查通过'], recovery: '失败时停止并记录。',
  });
}

test('导出为普通 SKILL.md：脱离插件仍是标准文档', async () => {
  const dataDir = await scratch('amb-export-db-');
  const target = await scratch('amb-export-out-');
  try {
    const store = new Store(join(dataDir, 'k.sqlite'));
    try {
      store.import([workflowFixture('wf-export')]);
      const result = exportSkills(store, { directory: target });
      assert.equal(result.written.length, 1);
      assert.equal(existsSync(join(target, EXPORT_MARKER)), true, '必须写归属标记');

      const markdown = await readFile(result.written[0]!, 'utf8');
      // Plain Markdown with no plugin-only front matter: the host can read it as-is.
      assert.equal(markdown.startsWith('# '), true);
      assert.equal(/^---/.test(markdown), false, '不得添加插件专有的 front matter');
      assert.match(markdown, /## 触发条件/);
      assert.match(markdown, /## 步骤/);
      assert.match(markdown, /## 完成判据/);
      assert.match(markdown, /## 失败处理/);
      assert.match(markdown, /执行并核对/);

      // A standalone reader needs no amb code to understand it.
      assert.equal(typeof renderSkill(workflowFixture('x')), 'string');
    } finally { store.close(); }
  } finally { await cleanup(dataDir); await cleanup(target); }
});

test('导出幂等：内容未变时不重写文件', async () => {
  const dataDir = await scratch('amb-export-idem-');
  const target = await scratch('amb-export-idem-out-');
  try {
    const store = new Store(join(dataDir, 'k.sqlite'));
    try {
      store.import([workflowFixture('wf-idem')]);
      const first = exportSkills(store, { directory: target });
      assert.equal(first.written.length, 1);
      const second = exportSkills(store, { directory: target });
      assert.equal(second.written.length, 0, '内容未变不得重写');
      assert.equal(second.unchanged.length, 1);
    } finally { store.close(); }
  } finally { await cleanup(dataDir); await cleanup(target); }
});

test('导出拒绝写入非自己所属的目录，避免覆盖用户手写技能', async () => {
  const dataDir = await scratch('amb-export-guard-');
  const foreign = await scratch('amb-export-foreign-');
  try {
    // A directory with unrelated content but no export marker.
    await mkdir(join(foreign, 'my-own-skill'), { recursive: true });
    await writeFile(join(foreign, 'my-own-skill', 'SKILL.md'), '# 用户手写的技能\n\n不得被覆盖。\n');

    const store = new Store(join(dataDir, 'k.sqlite'));
    try {
      store.import([workflowFixture('wf-guard')]);
      assert.throws(
        () => exportSkills(store, { directory: foreign }),
        /no agent-memory-backpack-export\.json marker/,
        '未声明归属的目录必须被拒绝',
      );
      // The user's file is untouched.
      const preserved = await readFile(join(foreign, 'my-own-skill', 'SKILL.md'), 'utf8');
      assert.match(preserved, /不得被覆盖/);
    } finally { store.close(); }
  } finally { await cleanup(dataDir); await cleanup(foreign); }
});

test('导出干跑不写任何文件', async () => {
  const dataDir = await scratch('amb-export-dry-');
  const target = await scratch('amb-export-dry-out-');
  try {
    const store = new Store(join(dataDir, 'k.sqlite'));
    try {
      store.import([workflowFixture('wf-dry')]);
      const result = exportSkills(store, { directory: target, dryRun: true });
      assert.equal(result.written.length, 1, '干跑仍应报告将写入的内容');
      assert.equal(existsSync(join(target, EXPORT_MARKER)), false, '干跑不得写入标记');
      assert.equal((await readdir(target)).length, 0, '干跑不得写入任何文件');
    } finally { store.close(); }
  } finally { await cleanup(dataDir); await cleanup(target); }
});
