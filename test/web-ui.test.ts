import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createCoreServer } from '../src/server.js';

/**
 * The management interface the core serves itself.
 *
 * The design asked for a local web page rather than a desktop shell, so the page
 * ships with the core: no extra runtime, no window to keep alive, and reachable
 * from any browser surface the host already provides — including inside DSH or
 * Codex, which is what "embedded" needs to mean here.
 *
 * The security properties matter as much as the feature. Serving a page means the
 * browser sends `Origin` on same-origin POSTs, so the blanket refusal had to be
 * narrowed — but only to the core's own origin. These tests exist to keep that
 * narrowing from becoming a hole.
 */

const token = 'c'.repeat(64);

async function core() {
  const store = new Store(':memory:', () => 1000);
  store.import([{ id: 'ui-norm', kind: 'norm', title: '界面规范', scope: { kind: 'project', projectId: 'p0' }, baseRevision: 0, body: '正文。', deniedTools: [], hostProvided: false }] as never[]);
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
  return { origin, close };
}

const post = (origin: string, path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-amb-protocol': '1', 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ projectId: 'p0', ...body }),
  });

test('核心提供管理界面，且不需要额外运行时', async () => {
  const { origin, close } = await core();
  try {
    const page = await fetch(`${origin}/ui`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    const html = await page.text();
    assert.match(html, /知识库/, '页面应有标题');
    // No credential and no data in the shell itself.
    assert.equal(html.includes(token), false, '页面外壳不得内嵌凭据');

    // A strict policy, so the page cannot load or run anything from elsewhere.
    const csp = page.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.equal(/'unsafe-inline'/.test(csp), false, '不得允许内联脚本');

    for (const [path, type] of [['/ui/app.js', /javascript/], ['/ui/app.css', /text\/css/]] as const) {
      const asset = await fetch(`${origin}${path}`);
      assert.equal(asset.status, 200, `${path} 应可访问`);
      assert.match(asset.headers.get('content-type') ?? '', type);
    }
  } finally { await close(); }
});

test('同源请求被允许，跨域请求仍被拒绝', async () => {
  const { origin, close } = await core();
  try {
    // The page's own request: same origin, so the browser sends this Origin.
    const sameOrigin = await post(origin, '/v1/stats', {}, { origin });
    assert.equal(sameOrigin.status, 200, '同源页面必须能读取数据');

    // A page on another site: the request carries that origin instead.
    const crossOrigin = await post(origin, '/v1/stats', {}, { origin: 'http://evil.example.com' });
    assert.equal(crossOrigin.status, 403, '跨域页面不得驱动核心');
    assert.equal((await crossOrigin.json() as { code?: string }).code, 'origin_denied');

    // And the page still needs the credential: narrowing the origin check must
    // not have turned into dropping authentication.
    const noAuth = await fetch(`${origin}/v1/stats`, {
      method: 'POST',
      headers: { 'x-amb-protocol': '1', 'content-type': 'application/json', origin },
      body: JSON.stringify({ projectId: 'p0' }),
    });
    assert.equal(noAuth.status, 401, '同源不等于免认证');
  } finally { await close(); }
});

test('静态资源只按精确路径提供，不读文件系统', async () => {
  const { origin, close } = await core();
  try {
    // A path that would be a traversal if assets were resolved from disk.
    for (const path of ['/ui/../core.json', '/ui/app.js/../../core.json', '/core.json']) {
      const response = await fetch(`${origin}${path}`);
      assert.notEqual(response.status, 200, `${path} 不得返回内容`);
    }
  } finally { await close(); }
});

test('stats 回显调用方自己的项目 ID，供界面标注', async () => {
  const { origin, close } = await core();
  try {
    const response = await post(origin, '/v1/stats', {});
    assert.equal(response.status, 200);
    const body = await response.json() as { projectId?: string; entries?: number };
    assert.equal(body.projectId, 'p0', '界面需要知道自己在看哪个项目');
    assert.equal(typeof body.entries, 'number');
  } finally { await close(); }
});

test('界面支持偏好、平台能力清单与历史追溯端点', async () => {
  const { origin, close } = await core();
  try {
    const prefRes = await post(origin, '/v1/preferences', {});
    assert.equal(prefRes.status, 200);
    const prefBody = await prefRes.json() as { preferences?: unknown[] };
    assert.ok(Array.isArray(prefBody.preferences));

    const capRes = await post(origin, '/v1/capabilities', {});
    assert.equal(capRes.status, 200);
    const capBody = await capRes.json() as { adapters?: Array<{ id: string; capabilities: Record<string, string> }>; mode?: string };
    assert.equal(capBody.mode, 'Managed');
    assert.ok(Array.isArray(capBody.adapters));
    assert.equal(capBody.adapters.length, 2);

    const histRes = await post(origin, '/v1/history/recent', {});
    assert.equal(histRes.status, 200);
    const histBody = await histRes.json() as { history?: unknown[] };
    assert.ok(Array.isArray(histBody.history));
  } finally { await close(); }
});

test('界面支持综合检索、手动添加、修改与退役删除端点', async () => {
  const { origin, close } = await core();
  try {
    // 1. 综合检索
    const searchRes = await post(origin, '/v1/knowledge/search-universal', { query: '界面规范', kind: 'norm' });
    assert.equal(searchRes.status, 200);
    const searchBody = await searchRes.json() as { results: Array<{ id: string; title: string }> };
    assert.ok(searchBody.results.length >= 1);
    assert.equal(searchBody.results[0]!.id, 'ui-norm');

    // 2. 手动添加新条目
    const writeRes = await post(origin, '/v1/knowledge/write', {
      entry: {
        id: 'manual-note-1',
        kind: 'memory',
        title: '用户手动沉淀经验',
        body: '这是手动录入的高价值操作结论。',
        scope: { kind: 'project', projectId: 'p0' },
        baseRevision: 0,
        labels: ['manual'],
        provenance: 'user',
        evidence: 'verifiable',
        platforms: [],
      },
    });
    assert.equal(writeRes.status, 200);

    // 3. 读取单条
    const getRes = await post(origin, '/v1/knowledge/get', { id: 'manual-note-1' });
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json() as { id: string; revision: number; content: { title: string } };
    assert.equal(getBody.id, 'manual-note-1');
    assert.equal(getBody.content.title, '用户手动沉淀经验');

    // 4. 手动修改现有条目 (CAS 递增 revision)
    const updateRes = await post(origin, '/v1/knowledge/write', {
      entry: {
        id: 'manual-note-1',
        kind: 'memory',
        title: '用户手动修改后标题',
        body: '正文更新：增加了验证依据。',
        scope: { kind: 'project', projectId: 'p0' },
        baseRevision: getBody.revision,
        labels: ['manual', 'updated'],
        provenance: 'user',
        evidence: 'verifiable',
        platforms: [],
      },
    });
    assert.equal(updateRes.status, 200);

    // 5. 手动删除条目 (退役保留历史)
    const delRes = await post(origin, '/v1/knowledge/delete', { id: 'manual-note-1' });
    assert.equal(delRes.status, 200);

    // 确认已不在活动库检索中
    const checkRes = await post(origin, '/v1/knowledge/search-universal', { query: '用户手动修改后标题' });
    const checkBody = await checkRes.json() as { results: Array<{ id: string }> };
    assert.equal(checkBody.results.some(r => r.id === 'manual-note-1'), false, '已删除条目不得在活跃检索中出现');
  } finally { await close(); }
});
