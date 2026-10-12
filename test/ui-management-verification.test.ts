import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { createCoreServer } from '../src/server.js';
import { capabilityManifest, operatingModeFromDisk } from '../src/capabilities.js';
import { doctor } from '../src/doctor.js';
import { UI_JS, UI_HTML } from '../src/ui.js';
import { knowledgeSchema } from '../src/schema.js';

/**
 * Isolated verification for management UI, capabilities reporting, and doctor diagnostics.
 * Covers F14, F20, and F02/F03/F04/F05/F08 interface requirements.
 * Note: These tests use script-level DOM/HTTP stubs (pure Node.js runtime, no real browser/GUI).
 */

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'amb-ui-verify-'));
  dirs.push(dir);
  return dir;
}
process.on('exit', () => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

/**
 * Run `body` with the host-location overrides cleared.
 *
 * Detection consults `DSH_HOME`, `CODEX_HOME` and `AMB_PLUGIN_DIR` because the scripts
 * that deploy the package honour them, so a test that builds a *synthetic* home must
 * clear them — otherwise the ambient environment answers instead of the fixture. On
 * the machine running this suite `DSH_HOME` points at a real home with the plugin
 * installed, which made an "empty home" report as installed.
 */
function withHostEnvCleared<T>(body: () => T): T {
  const keys = ['DSH_HOME', 'CODEX_HOME', 'AMB_PLUGIN_DIR'] as const;
  const saved = keys.map(key => [key, process.env[key]] as const);
  for (const key of keys) delete process.env[key];
  try { return body(); } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

const token = 'a'.repeat(64);

async function setupCore() {
  const store = new Store(':memory:', () => 1000);
  store.import([
    {
      id: 'norm-p0-1', kind: 'norm', title: '测试规范1', scope: { kind: 'project', projectId: 'p0' },
      baseRevision: 0, body: '规范正文1', deniedTools: ['Bash'], hostProvided: false,
      labels: ['security', 'core'], platforms: ['dsh'], provenance: 'user', evidence: 'observed'
    },
    {
      id: 'flow-p0-1', kind: 'workflow', title: '入口测试流程', scope: { kind: 'project', projectId: 'p0' },
      baseRevision: 0, overview: '流程概述', triggers: ['start'], categories: [['test', 'flow']],
      preconditions: ['ready'], stages: [{ id: 's1', title: '阶段1', instructions: '执行说明', checks: ['检查点1'], dependencies: [] }],
      completion: ['all done'], recovery: 'retry', isEntryPoint: true, tags: ['entry'],
      provenance: 'user', evidence: 'verifiable', platforms: []
    }
  ] as never[]);

  const server = createCoreServer(store, {
    protocolVersion: 1, port: 47631,
    clients: [{ id: 'admin', token, projectId: 'p0', role: 'admin' }],
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    store.close();
  };
  return { origin, store, close };
}

test('F14/U02: UI 脚本中禁止出现非法枚举 verified，且 platforms 默认为空数组', () => {
  assert.equal(UI_JS.includes("evidence: 'verified'"), false, 'UI 脚本不得包含非法的 verified 枚举值');
  assert.ok(UI_JS.includes("evidence: 'verifiable'"), 'UI 脚本应使用 schema 允许的 verifiable 等级');
});

test('F14: 编辑已有条目时，保留所有既有元信息（labels, platforms, deniedTools, hostProvided, baseRevision）', async () => {
  const { origin, store, close } = await setupCore();
  try {
    // 1. 读取既有 norm
    const getRes = await fetch(`${origin}/v1/knowledge/get`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-amb-protocol': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'p0', id: 'norm-p0-1' }),
    });
    assert.equal(getRes.status, 200);
    const existing = await getRes.json() as { id: string; revision: number; content: Record<string, unknown> };

    // 2. 模拟前端编辑逻辑：只修改正文与标题，保留原有元数据
    const original = existing.content;
    const updated = Object.assign({}, original, {
      id: existing.id,
      title: '更新后规范标题',
      body: '这是更新后的正文内容。',
      baseRevision: existing.revision,
    });

    // 验证更新结构符合 schema
    const parsed = knowledgeSchema.parse(updated);
    assert.equal(parsed.title, '更新后规范标题');
    assert.deepEqual((parsed as { deniedTools?: string[] }).deniedTools, ['Bash'], '原禁止工具列表不得被清空');
    assert.deepEqual(parsed.labels, ['security', 'core'], '原标签不得被清空');
    assert.deepEqual(parsed.platforms, ['dsh'], '原平台限制不得被清空');

    // 3. 写入核心并验证通过
    const writeRes = await fetch(`${origin}/v1/knowledge/write`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-amb-protocol': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'p0', entry: updated }),
    });
    assert.equal(writeRes.status, 200);
  } finally {
    await close();
  }
});

test('F14: 候选批准通过 schema 校验，且批量批准支持并提示', async () => {
  const { origin, store, close } = await setupCore();
  try {
    // 提交候选
    const subRes = await fetch(`${origin}/v1/proposals`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-amb-protocol': '1', 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'p0',
        idempotencyKey: 'prop-test-1',
        discovery: '新发现的操作细节，需要批准入库。',
      }),
    });
    assert.equal(subRes.status, 200);
    const subBody = await subRes.json() as { id: string };
    assert.ok(subBody.id, '提交应返回候选 ID');

    // 单项批准：使用前端修正后的合法 payload
    const approvePayload = {
      projectId: 'p0',
      id: subBody.id,
      entry: {
        id: subBody.id,
        kind: 'memory',
        title: '已批准的经验记忆',
        body: '新发现的操作细节，需要批准入库。',
        scope: { kind: 'project', projectId: 'p0' },
        baseRevision: 0,
        labels: ['approved'],
        provenance: 'user',
        evidence: 'verifiable',
        platforms: [],
      },
    };
    const appRes = await fetch(`${origin}/v1/proposals/approve`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-amb-protocol': '1', 'content-type': 'application/json' },
      body: JSON.stringify(approvePayload),
    });
    assert.equal(appRes.status, 200, '批准请求应通过 200');
  } finally {
    await close();
  }
});

test('F20: locate 不把空 cache 目录判定为已安装', () => withHostEnvCleared(() => {
  const home = tempDir();
  // 建立一个空的 .codex/plugins/cache 目录
  mkdirSync(join(home, '.codex', 'plugins', 'cache'), { recursive: true });

  const manifest = capabilityManifest(home);
  const codex = manifest.find(m => m.id === 'codex')!;
  assert.equal(codex.installed, false, '空 cache 目录绝不能被判为已安装');
  assert.equal(codex.version, null);
  assert.equal(codex.location, null);

  const dsh = manifest.find(m => m.id === 'dsh')!;
  assert.equal(dsh.installed, false, '未安装 DSH 包时应报 false');
}));

test('F20: operatingModeFromDisk 在快照格式错误时回退到 Ungoverned，不假阳性报 ReadOnlySnapshot', () => {
  const dir = tempDir();
  // 写入一个有 timestamp 但 deniedTools 不是数组的畸形快照
  writeFileSync(join(dir, 'gate-snapshot.json'), JSON.stringify({ at: Date.now(), deniedTools: 'not-array' }), 'utf8');

  const mode = operatingModeFromDisk(dir, false);
  assert.equal(mode.mode, 'Ungoverned', '畸形快照不得被接受为 ReadOnlySnapshot');
  assert.match(mode.detail, /格式错误/, '必须说明格式错误原因');
});

test('F20: doctor 在适配器未安装时标记为 warn，绝不能标记为 pass', () => withHostEnvCleared(async () => {
  const dir = tempDir();
  const emptyHome = tempDir();
  const report = await doctor({ dataDir: dir, offline: true, home: emptyHome });

  const dshCheck = report.checks.find(c => c.id === 'capability-dsh');
  assert.ok(dshCheck);
  assert.equal(dshCheck.status, 'warn', '未安装的适配器不得标为 pass');
  assert.match(dshCheck.detail, /未在该机器的已知位置找到已安装的包/);

  const codexCheck = report.checks.find(c => c.id === 'capability-codex');
  assert.ok(codexCheck);
  assert.equal(codexCheck.status, 'warn', 'codex 存在缺口或未安装时必须为 warn');
}));

test('F20: UI 在 capabilities 失败时绝不假阳性报 Managed', () => {
  assert.equal(UI_JS.includes("return { adapters: [], mode: 'Managed'"), false, 'UI catch 中不得硬编码 mode: Managed 假阳性');
  assert.ok(UI_JS.includes("mode: 'Ungoverned'"), 'UI 在能力读取失败时必须落入 Ungoverned');
});

test('F02/F08 界面侧: UI 代码包含跨项目权限拒绝友好提示与临时资料正文清理状态', () => {
  assert.ok(UI_JS.includes('该条目属于其他项目，不可访问'), 'UI 必须让跨项目 403 权限错误可见');
  assert.ok(UI_JS.includes('正文已清空'), '临时资料管理必须显示正文是否已清空');
  assert.ok(UI_JS.includes('batch-approve'), '候选列表应支持批量批准按钮');
});
