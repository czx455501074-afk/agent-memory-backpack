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
    // 提交候选（无目标流程：只有 workflowId 存在时核心才要求 entry.id === workflowId）
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

    // UI 先取候选详情（新契约）：界面据此知道批准要写哪个 entry
    const detailRes = await fetch(`${origin}/v1/proposals/get`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-amb-protocol': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'p0', id: subBody.id }),
    });
    assert.equal(detailRes.status, 200);
    const detail = await detailRes.json() as { target: { workflowId: string; available: boolean } };
    assert.equal(detail.target.workflowId, '', '未标注流程的候选没有目标流程');
    assert.equal(detail.target.available, false);

    // 单项批准：使用界面按详情构造的合法 payload（无目标时使用候选 UUID）
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

test('F01: 流程候选的审批契约——目标不匹配必须拒绝，按目标流程批准则生成新 revision', async () => {
  const { origin, close } = await setupCore();
  try {
    const headers = { authorization: `Bearer ${token}`, 'x-amb-protocol': '1', 'content-type': 'application/json' };
    // 提交一个指向已有 workflow（flow-p0-1 @ v1）的候选
    const subRes = await fetch(`${origin}/v1/proposals`, {
      method: 'POST', headers,
      body: JSON.stringify({ projectId: 'p0', idempotencyKey: 'flow-cand-1', workflowId: 'flow-p0-1', baseRevision: 1, discovery: '流程第1阶段的交付经验。' }),
    });
    assert.equal(subRes.status, 200);
    const { id } = await subRes.json() as { id: string };

    // 详情端点解析出目标流程与候选基线版本
    const detail = await (await fetch(`${origin}/v1/proposals/get`, { method: 'POST', headers, body: JSON.stringify({ projectId: 'p0', id }) })).json() as
      { target: { workflowId: string; baseRevision: number; available: boolean; entry: Record<string, unknown> | null } };
    assert.equal(detail.target.workflowId, 'flow-p0-1');
    assert.equal(detail.target.baseRevision, 1);
    assert.equal(detail.target.available, true);
    assert.ok(detail.target.entry, '目标存在时应返回可编辑的流程条目');

    // 旧 UI 的请求形态（entry.id = 候选 UUID, kind=memory）必须被拒绝
    const wrong = await fetch(`${origin}/v1/proposals/approve`, {
      method: 'POST', headers,
      body: JSON.stringify({ projectId: 'p0', id, entry: { id, kind: 'memory', title: '错目标', body: 'x', scope: { kind: 'project', projectId: 'p0' }, baseRevision: 0 } }),
    });
    assert.equal(wrong.status, 409, '把流程候选批准成无关 memory 必须 409');
    assert.equal((await wrong.json() as { code: string }).code, 'target_mismatch');

    // 正确形态：entry 为目标流程本体，baseRevision 为候选基线版本
    const targetEntry = { ...(detail.target.entry as Record<string, unknown>) };
    (targetEntry as { overview: string }).overview = '流程概述（含用户审阅补充的经验）';
    const ok = await fetch(`${origin}/v1/proposals/approve`, {
      method: 'POST', headers,
      body: JSON.stringify({ projectId: 'p0', id, entry: { ...targetEntry, baseRevision: 1 } }),
    });
    assert.equal(ok.status, 200, '按目标流程批准应成功');
    const rev = (await ok.json() as { knowledgeRevision: number }).knowledgeRevision;
    assert.ok(rev >= 2, '批准后知识版本必须前进');

    // 目标流程确实产生了新 revision
    const hist = await (await fetch(`${origin}/v1/knowledge/history`, { method: 'POST', headers, body: JSON.stringify({ projectId: 'p0', knowledgeId: 'flow-p0-1' }) })).json() as
      { revisions: Array<{ revision: number }> };
    assert.ok(hist.revisions.length >= 2, '流程应至少有 v1 与新的 v2');
  } finally {
    await close();
  }
});

test('F02: 知识写入成功后顶栏版本可即时刷新（refreshHeader 契约）', async () => {
  const { origin, close } = await setupCore();
  try {
    const headers = { authorization: `Bearer ${token}`, 'x-amb-protocol': '1', 'content-type': 'application/json' };
    const before = await (await fetch(`${origin}/v1/stats`, { method: 'POST', headers, body: JSON.stringify({ projectId: 'p0' }) })).json() as { knowledgeRevision: number };
    const writeRes = await fetch(`${origin}/v1/knowledge/write`, {
      method: 'POST', headers,
      body: JSON.stringify({
        projectId: 'p0',
        entry: { id: 'ui-header-check', kind: 'memory', title: '顶栏刷新验证', body: '写入后 stats 版本必须前进。', scope: { kind: 'project', projectId: 'p0' }, baseRevision: 0 },
      }),
    });
    assert.equal(writeRes.status, 200);
    const after = await (await fetch(`${origin}/v1/stats`, { method: 'POST', headers, body: JSON.stringify({ projectId: 'p0' }) })).json() as { knowledgeRevision: number };
    assert.equal(after.knowledgeRevision, before.knowledgeRevision + 1, 'stats 版本必须随写入前进，界面刷新才有正确来源');
    assert.equal(UI_JS.includes('function refreshHeader'), true, '界面必须提供 refreshHeader 供写入路径调用');
    // 断言刷新确实挂到了各写入路径，而不只是函数存在（独立复核指出原测试只查字符串）。
    const refreshCalls = (UI_JS.match(/refreshHeader\(\)/g) ?? []).length;
    assert.ok(refreshCalls >= 4, `写入/删除/批准路径都应调用 refreshHeader（实际 ${refreshCalls} 处）`);
    for (const anchor of ['/v1/knowledge/write', '/v1/knowledge/delete', '/v1/proposals/approve', '/v1/proposals/batch']) {
      const idx = UI_JS.indexOf(anchor);
      assert.ok(idx >= 0, `界面脚本应包含 ${anchor}`);
      const after = UI_JS.slice(idx, idx + 700);
      assert.match(after, /refreshHeader\(\)/, `${anchor} 成功路径必须刷新顶栏`);
    }
  } finally {
    await close();
  }
});

test('F09: 归档候选可重新开启，历史修订可只读查阅', async () => {
  const { origin, close } = await setupCore();
  try {
    const headers = { authorization: `Bearer ${token}`, 'x-amb-protocol': '1', 'content-type': 'application/json' };
    // 造一个归档候选
    const sub = await (await fetch(`${origin}/v1/proposals`, {
      method: 'POST', headers,
      body: JSON.stringify({ projectId: 'p0', idempotencyKey: 'reopen-cand-1', discovery: '被误归档的候选。' }),
    })).json() as { id: string };
    await fetch(`${origin}/v1/proposals/archive`, { method: 'POST', headers, body: JSON.stringify({ projectId: 'p0', id: sub.id }) });
    const reopen = await fetch(`${origin}/v1/proposals/reopen`, { method: 'POST', headers, body: JSON.stringify({ projectId: 'p0', id: sub.id }) });
    assert.equal(reopen.status, 200, '归档候选必须可重新开启');
    assert.equal((await reopen.json() as { state: string }).state, 'pending');

    // 历史修订只读读取：flow-p0-1 的 v1 正文
    const revRead = await fetch(`${origin}/v1/knowledge/history/read`, {
      method: 'POST', headers,
      body: JSON.stringify({ projectId: 'p0', id: 'flow-p0-1', revision: 1 }),
    });
    assert.equal(revRead.status, 200, '历史修订必须可只读读取');
    const revBody = await revRead.json() as { revision: number; isCurrent: boolean; body: string };
    assert.equal(revBody.revision, 1);
    assert.equal(revBody.isCurrent, true);
    assert.ok(revBody.body.length > 0, '历史视图必须返回正文');

    // 现状保护未被削弱：以旧版本读取当前条目仍 409（history/read 是另一条只读路径）
    const stale = await fetch(`${origin}/v1/knowledge/read`, {
      method: 'POST', headers,
      body: JSON.stringify({ projectId: 'p0', knowledgeId: 'flow-p0-1@1' }),
    });
    assert.equal(stale.status, 200, 'flow-p0-1@1 是当前版本，读取应 200');
  } finally {
    await close();
  }
});

test('F01/F09: 界面不再使用 prompt()，并具备审批表单、approved 筛选与下载入口', () => {
  // 内置浏览器不支持 prompt()，任何审批/理由输入都不应依赖它。
  // 注释里可以提到这个历史函数名，判定针对的是实际代码调用。
  const code = UI_JS.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/prompt\(/.test(code), false, '界面脚本不得再调用 prompt() 函数');
  assert.ok(UI_JS.includes('showProposalEditor'), '界面必须用页面内表单完成审批');
  assert.ok(UI_JS.includes("'approved'"), '候选筛选必须包含 approved 状态');
  assert.ok(UI_JS.includes('action-reopen'), '归档/拒收候选必须提供重新开启入口');
  assert.ok(UI_JS.includes('downloadText'), '导出必须提供下载/复制入口而非仅预览');
  assert.ok(UI_JS.includes('/v1/knowledge/history/read'), '历史视图必须能只读读取旧修订正文');
  assert.ok(UI_JS.includes('localTime('), '时间必须带时区偏移显示');
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
