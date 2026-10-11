/**
 * The management interface, served by the core itself.
 *
 * The design called for a local web page rather than a desktop application
 * ("不重复制造桌面壳"): a page needs no extra runtime, no installer, and no
 * window to keep alive — the core already runs, and the page is another thing it
 * serves.
 *
 * Three responses, so the page can run under a strict Content-Security-Policy
 * with no inline script or style: the shell, a script, and a stylesheet.
 *
 * The credential is read from the URL fragment, which browsers do not transmit,
 * so it never reaches the server's request log. `cli ui` prints the full URL.
 */

/** The page shell. No data and no credential are embedded in it. */
export const UI_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Memory Backpack 知识库</title>
<link rel="stylesheet" href="/ui/app.css">
</head>
<body>
<div class="app">
  <header class="masthead">
    <div>
      <h1>Agent Memory Backpack</h1>
      <p class="sub">本地共享知识库与跨端上下文接续</p>
    </div>
    <dl class="target">
      <div><dt>项目</dt><dd id="t-project">—</dd></div>
      <div><dt>知识版本</dt><dd id="t-revision">—</dd></div>
      <div><dt>状态</dt><dd id="t-connection" class="pill pill--idle">未连接</dd></div>
    </dl>
  </header>
  <nav class="tabs" id="tabs">
    <button class="tab tab--active" data-view="status">总览</button>
    <button class="tab" data-view="manage">综合检索与管理</button>
    <button class="tab" data-view="norms">规范与偏好</button>
    <button class="tab" data-view="proposals">候选审阅</button>
    <button class="tab" data-view="tasks">任务与日记</button>
    <button class="tab" data-view="material">临时资料</button>
    <button class="tab" data-view="history">历史追溯</button>
    <button class="tab" data-view="doctor">自检与平台能力</button>
  </nav>
  <main class="panel" id="panel"><p class="muted">正在读取核心…</p></main>
  <footer class="statusbar">
    <span>凭据仅保存在本页内存中，不写入磁盘，也不出现在请求日志里。</span>
    <button id="refresh" class="ghost">刷新</button>
  </footer>
</div>
<script src="/ui/app.js"></script>
</body>
</html>
`;

/**
 * Stylesheet.
 * Dark, matching the desktop console. Follows prefers-color-scheme.
 */
export const UI_CSS = `:root {
  --bg: #101319; --panel: #171b23; --line: #262c38;
  --text: #e6e9ef; --muted: #98a2b3; --ok: #3fb950; --warn: #d29922; --fail: #f85149;
}
@media (prefers-color-scheme: light) {
  :root { --bg: #f6f7f9; --panel: #fff; --line: #e3e6ea; --text: #1b1f27; --muted: #5c6672; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.55 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
.app { max-width: 1100px; margin: 0 auto; padding: 20px; }
.masthead { display: flex; justify-content: space-between; align-items: flex-start;
  flex-wrap: wrap; gap: 12px; padding-bottom: 14px; border-bottom: 1px solid var(--line); }
h1 { margin: 0; font-size: 19px; font-weight: 650; }
.sub { margin: 2px 0 0; color: var(--muted); font-size: 12px; }
.target { display: flex; gap: 18px; margin: 0; flex-wrap: wrap; }
.target dt { color: var(--muted); font-size: 11px; }
.target dd { margin: 1px 0 0; font-size: 13px; }
.tabs { display: flex; gap: 4px; flex-wrap: wrap; margin: 14px 0; }
.tab { background: none; border: 1px solid transparent; color: var(--muted);
  padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; font-family: inherit; }
.tab:hover { color: var(--text); }
.tab--active { background: var(--panel); border-color: var(--line); color: var(--text); font-weight: 600; }
.panel { min-height: 320px; }
.muted { color: var(--muted); }
.section-title { font-size: 15px; font-weight: 600; margin: 18px 0 10px; display: flex; align-items: center; gap: 8px; }
.metrics { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.metric { background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  padding: 10px 14px; min-width: 110px; flex: 1; }
.metric__label { color: var(--muted); font-size: 11px; }
.metric__value { font-size: 18px; font-weight: 650; margin-top: 2px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  padding: 12px 14px; margin-bottom: 10px; }
.card__head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.card__title { font-weight: 600; }
.card__meta { color: var(--muted); font-size: 11px; margin-top: 4px; }
.card__body { margin: 8px 0 0; white-space: pre-wrap; word-break: break-word; font-size: 13px; }
.card__path { color: var(--muted); font-size: 11px; font-family: ui-monospace, Consolas, monospace; margin-top: 2px; }
.card__actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; align-items: center; }
table { width: 100%; border-collapse: collapse; background: var(--panel);
  border: 1px solid var(--line); border-radius: 8px; overflow: hidden; margin-bottom: 14px; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line);
  font-size: 13px; vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: 11px; }
tr:last-child td { border-bottom: none; }
code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
.pill { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 11px; white-space: nowrap; }
.pill--ok { background: rgba(63,185,80,.16); color: var(--ok); }
.pill--warn { background: rgba(210,153,34,.16); color: var(--warn); }
.pill--fail { background: rgba(248,81,73,.16); color: var(--fail); }
.pill--skip, .pill--idle { background: rgba(152,162,179,.16); color: var(--muted); }
.notice { border-left: 3px solid var(--fail); background: rgba(248,81,73,.08);
  padding: 10px 12px; border-radius: 4px; margin-bottom: 12px; }
.notice--info { border-color: var(--muted); background: rgba(152,162,179,.08); }
.empty { color: var(--muted); padding: 24px 0; text-align: center; }
.toolbar { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; align-items: center; }
input[type=search], input[type=text], textarea, select.select { background: var(--panel); color: var(--text);
  border: 1px solid var(--line); border-radius: 6px; padding: 7px 10px; font-family: inherit; font-size: 13px; }
input[type=search] { flex: 1; min-width: 200px; }
textarea { width: 100%; box-sizing: border-box; resize: vertical; min-height: 80px; }
button.primary { background: #2f6feb; color: #fff; border: 1px solid #2f6feb;
  border-radius: 6px; padding: 6px 12px; cursor: pointer; font-family: inherit; font-size: 13px; font-weight: 500; }
button.primary:hover { background: #388bfd; }
button.ghost { background: none; color: var(--text); border: 1px solid var(--line);
  border-radius: 6px; padding: 6px 12px; cursor: pointer; font-family: inherit; font-size: 13px; }
button.ghost:hover { background: var(--line); }
button.btn-sm { padding: 3px 8px; font-size: 12px; }
button.btn-danger { color: var(--fail); border-color: rgba(248,81,73,.4); }
button.btn-danger:hover { background: rgba(248,81,73,.15); }
button.btn-warn { color: var(--warn); border-color: rgba(210,153,34,.4); }
button:disabled { opacity: .5; cursor: default; }
.pre-box { background: var(--bg); border: 1px solid var(--line); border-radius: 6px;
  padding: 10px; font-family: ui-monospace, Consolas, monospace; font-size: 12px;
  white-space: pre-wrap; word-break: break-all; max-height: 360px; overflow-y: auto; margin: 8px 0; }
.editor-card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; margin-bottom: 14px; }
.form-group { margin-bottom: 10px; }
.form-group label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; font-weight: 500; }
.grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; }
.statusbar { display: flex; justify-content: space-between; align-items: center; gap: 12px;
  flex-wrap: wrap; margin-top: 18px; padding-top: 12px;
  border-top: 1px solid var(--line); color: var(--muted); font-size: 11px; }
`;

/**
 * Page script.
 * Reads the credential from URL fragment and keeps it in memory only.
 */
export const UI_JS = `'use strict';
var panel = document.getElementById('panel');
var tabs = document.getElementById('tabs');

var token = decodeURIComponent((location.hash || '').replace(/^#/, ''));
if (location.hash) history.replaceState(null, '', location.pathname);

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function notice(message, info) {
  return '<div class="notice' + (info ? ' notice--info' : '') + '">' + esc(message) + '</div>';
}
function empty(message) { return '<div class="empty">' + esc(message) + '</div>'; }

function getProject() {
  return document.getElementById('t-project').textContent.trim() || 'p0';
}

function post(path, body) {
  var envelope = Object.assign({ projectId: getProject() }, body || {});
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, 'x-amb-protocol': '1' },
    body: JSON.stringify(envelope),
  }).then(function (response) {
    return response.json().catch(function () { return {}; }).then(function (data) {
      if (!response.ok) throw new Error(data.message || ('HTTP ' + response.status));
      return data;
    });
  });
}

function setConnection(ok) {
  var node = document.getElementById('t-connection');
  node.textContent = ok ? '已连接' : '无法连接';
  node.className = 'pill ' + (ok ? 'pill--ok' : 'pill--fail');
}
function metrics(pairs) {
  return '<div class="metrics">' + pairs.map(function (pair) {
    return '<div class="metric"><div class="metric__label">' + esc(pair[0]) +
      '</div><div class="metric__value">' + esc(pair[1]) + '</div></div>';
  }).join('') + '</div>';
}

function renderStatus() {
  return Promise.all([
    post('/v1/stats'),
    post('/v1/rescan/state'),
    post('/v1/material/list', { limit: 1 }).catch(function () { return { material: [], stats: {} }; })
  ]).then(function (out) {
    var s = out[0], r = out[1], m = out[2];
    document.getElementById('t-project').textContent = s.projectId || '—';
    document.getElementById('t-revision').textContent = String(s.knowledgeRevision);
    var matStats = m.stats || {};
    panel.innerHTML = metrics([
      ['生效条目', s.entries],
      ['待审阅候选', s.pendingProposals],
      ['已采纳技能', s.adoptions],
      ['取代记录', s.supersessions],
      ['任务记录', s.tasks],
      ['临时资料', (matStats.total || 0) + ' 条（' + (matStats.expiredUnpurged || 0) + ' 条已过期）'],
    ]) +
      '<div class="card"><div class="card__head"><span class="card__title">定期同步与生命周期</span>' +
      '<span class="card__meta">' + (r.due ? '已到期待扫描' : '正常周期内') + '</span></div>' +
      '<p class="card__body">上次扫描：' + esc(r.lastRescanAt ? new Date(r.lastRescanAt).toLocaleString() : '从未') +
      '　扫描周期：' + esc(r.intervalMs ? Math.round(r.intervalMs / 3600000) + ' 小时' : '—') + '</p></div>' +
      notice('候选不会自动生效；推翻或补充经验必须附理由与证据，旧版本始终保留在历史中。临时资料具备 90 天到期控制。', true);
  });
}

function renderManage(searchQuery, kindFilter) {
  var q = searchQuery !== undefined ? searchQuery : (document.getElementById('u-query') ? document.getElementById('u-query').value : '');
  var k = kindFilter !== undefined ? kindFilter : (document.getElementById('u-kind-filter') ? document.getElementById('u-kind-filter').value : 'all');
  return post('/v1/knowledge/search-universal', { query: q, kind: k, limit: 100 }).then(function (data) {
    var items = data.results || [];
    var kinds = [
      ['all', '全部类型'],
      ['norm', '规范 (norm)'],
      ['preference', '偏好 (preference)'],
      ['memory', '记忆 (memory)'],
      ['skill', '技能 (skill)'],
      ['journal', '日记 (journal)'],
      ['workflow', '流程 (workflow)'],
      ['material', '资料 (material)'],
    ];

    var toolbar = '<div class="toolbar">' +
      '<input type="search" id="u-query" placeholder="综合检索规范、日记、知识、技能与经验…" value="' + esc(q) + '">' +
      '<select id="u-kind-filter" class="select">' +
      kinds.map(function (pair) {
        return '<option value="' + esc(pair[0]) + '"' + (pair[0] === k ? ' selected' : '') + '>' + esc(pair[1]) + '</option>';
      }).join('') +
      '</select>' +
      '<button class="primary" id="u-search-btn">检索</button>' +
      '<button class="ghost" id="u-create-toggle">+ 手动新建条目</button>' +
      '</div>' +
      '<div id="u-editor-container"></div>';

    var table = '';
    if (!items.length) {
      table = empty(q ? '没有匹配的条目。' : '当前类型下暂无条目。可点击上方按钮手动新建。');
    } else {
      table = '<table><thead><tr><th>ID / 标题</th><th>类型</th><th>版本</th><th>作用范围</th><th>摘要预览</th><th>操作</th></tr></thead><tbody>' +
        items.map(function (item) {
          var sc = item.scope ? (item.scope.kind === 'global' ? '全局' : ('项目: ' + (item.scope.projectId || '当前'))) : '—';
          return '<tr><td><div><strong>' + esc(item.title) + '</strong></div><div class="card__path">' + esc(item.id) + '</div></td>' +
            '<td><span class="pill pill--ok">' + esc(item.kind) + '</span></td>' +
            '<td><code>v' + esc(item.revision) + '</code></td>' +
            '<td>' + esc(sc) + '</td>' +
            '<td>' + esc(item.excerpt) + (item.why && item.why.matched ? '<div class="card__path">命中: ' + esc(item.why.matched.join(',')) + '</div>' : '') + '</td>' +
            '<td><div class="card__actions" style="margin:0;">' +
            '<button class="ghost btn-sm u-edit-btn" data-id="' + esc(item.id) + '">编辑修改</button>' +
            '<button class="ghost btn-sm btn-danger u-delete-btn" data-id="' + esc(item.id) + '" data-rev="' + esc(item.revision) + '">删除</button>' +
            '</div></td></tr>';
        }).join('') + '</tbody></table>';
    }

    panel.innerHTML = toolbar + table;
  });
}

function showEditor(entryToEdit) {
  var container = document.getElementById('u-editor-container');
  if (!container) return;
  var isEdit = Boolean(entryToEdit);
  var raw = entryToEdit ? (entryToEdit.rawContent || {}) : {};
  var id = entryToEdit ? entryToEdit.id : ('k-' + Date.now().toString(36));
  var title = raw.title || '';
  var kind = raw.kind || 'memory';
  var body = raw.body !== undefined ? raw.body : (raw.overview !== undefined ? raw.overview : (raw.did !== undefined ? raw.did : ''));
  var scopeKind = raw.scope && raw.scope.kind === 'global' ? 'global' : 'project';
  var baseRevision = entryToEdit ? entryToEdit.revision : 0;

  container.innerHTML = '<div class="editor-card">' +
    '<div class="card__head" style="margin-bottom:12px;">' +
    '<span class="card__title">' + (isEdit ? '编辑条目: ' + esc(id) : '手动添加新知识条目') + '</span>' +
    '<button class="ghost btn-sm" id="u-editor-cancel">取消</button>' +
    '</div>' +
    '<div class="grid-2">' +
    '<div class="form-group"><label>条目 ID (唯一标识)</label>' +
    '<input type="text" id="ed-id" value="' + esc(id) + '"' + (isEdit ? ' readonly style="opacity:0.7;"' : '') + ' style="width:100%;"></div>' +
    '<div class="form-group"><label>内容类型 (Kind)</label>' +
    '<select id="ed-kind" class="select" style="width:100%;"' + (isEdit ? ' disabled' : '') + '>' +
    '<option value="memory"' + (kind === 'memory' ? ' selected' : '') + '>记忆 (memory)</option>' +
    '<option value="norm"' + (kind === 'norm' ? ' selected' : '') + '>规范 (norm)</option>' +
    '<option value="preference"' + (kind === 'preference' ? ' selected' : '') + '>偏好 (preference)</option>' +
    '<option value="skill"' + (kind === 'skill' ? ' selected' : '') + '>技能 (skill)</option>' +
    '</select></div>' +
    '</div>' +
    '<div class="grid-2">' +
    '<div class="form-group"><label>标题</label>' +
    '<input type="text" id="ed-title" value="' + esc(title) + '" placeholder="简明清晰的标题" style="width:100%;"></div>' +
    '<div class="form-group"><label>作用范围</label>' +
    '<select id="ed-scope" class="select" style="width:100%;">' +
    '<option value="project"' + (scopeKind === 'project' ? ' selected' : '') + '>当前项目专属</option>' +
    '<option value="global"' + (scopeKind === 'global' ? ' selected' : '') + '>全局共享</option>' +
    '</select></div>' +
    '</div>' +
    '<div class="form-group"><label>正文内容</label>' +
    '<textarea id="ed-body" rows="6" placeholder="输入完整的知识或规则正文…">' + esc(body) + '</textarea></div>' +
    '<div class="card__actions">' +
    '<button class="primary" id="u-editor-save" data-edit="' + (isEdit ? '1' : '0') + '" data-baserev="' + esc(baseRevision) + '">保存生效</button>' +
    '</div>' +
    '</div>';
}

function renderNorms() {
  return Promise.all([
    post('/v1/norms'),
    post('/v1/preferences').catch(function () { return { preferences: [] }; })
  ]).then(function (out) {
    var norms = (out[0].norms || []).filter(function (e) { return e.content && e.content.kind === 'norm'; });
    var prefs = (out[1].preferences || []).filter(function (e) { return e.content && e.content.kind === 'preference'; });

    var html = '<div class="section-title">当前生效规范（Norms）</div>';
    if (!norms.length) {
      html += empty('没有生效中的规范。');
    } else {
      html += '<table><thead><tr><th>ID</th><th>标题</th><th>版本</th><th>来源</th><th>禁止工具</th><th>摘要</th></tr></thead><tbody>' +
        norms.map(function (e) {
          var c = e.content || {};
          var denied = (c.deniedTools || []).join(', ') || '—';
          return '<tr><td><code>' + esc(e.id) + '</code></td><td>' + esc(c.title) +
            '</td><td><code>v' + esc(e.revision) + '</code></td><td>' +
            (c.hostProvided ? '<span class="pill pill--skip">宿主加载</span>' : '<span class="pill pill--ok">插件注入</span>') +
            '</td><td><code>' + esc(denied) + '</code></td><td>' + esc(c.body ? c.body.slice(0, 80) : '') + '</td></tr>';
        }).join('') + '</tbody></table>';
    }

    html += '<div class="section-title">用户与环境偏好（Preferences）</div>';
    if (!prefs.length) {
      html += empty('暂无记录的偏好。');
    } else {
      html += '<table><thead><tr><th>ID</th><th>标题</th><th>版本</th><th>偏好来源</th><th>作用范围</th><th>偏好内容</th></tr></thead><tbody>' +
        prefs.map(function (e) {
          var c = e.content || {};
          var statedPill = c.stated
            ? '<span class="pill pill--ok">用户明确陈述</span>'
            : '<span class="pill pill--warn">系统推断偏好</span>';
          var scope = c.scope && c.scope.kind === 'global' ? '全局' : ('项目 (' + (c.scope && c.scope.projectId ? c.scope.projectId : '当前') + ')');
          return '<tr><td><code>' + esc(e.id) + '</code></td><td>' + esc(c.title) +
            '</td><td><code>v' + esc(e.revision) + '</code></td><td>' + statedPill +
            '</td><td>' + esc(scope) + '</td><td>' + esc(c.body ? c.body.slice(0, 80) : '') + '</td></tr>';
        }).join('') + '</tbody></table>';
    }
    panel.innerHTML = html;
  });
}

function renderProposals(filterState) {
  var state = filterState || 'pending';
  return post('/v1/proposals/list', { state: state }).then(function (data) {
    var items = data.proposals || [];
    var filterBar = '<div class="toolbar">' +
      '<span class="muted">状态筛选：</span>' +
      '<select id="prop-filter" class="select">' +
      '<option value="pending"' + (state === 'pending' ? ' selected' : '') + '>待审阅 (pending)</option>' +
      '<option value="needs_evidence"' + (state === 'needs_evidence' ? ' selected' : '') + '>需补证 (needs_evidence)</option>' +
      '<option value="archived"' + (state === 'archived' ? ' selected' : '') + '>已归档 (archived)</option>' +
      '<option value="rejected"' + (state === 'rejected' ? ' selected' : '') + '>已拒收 (rejected)</option>' +
      '</select>' +
      (state === 'pending' ?
        '<button class="ghost btn-sm" id="batch-select-all">全选</button>' +
        '<button class="ghost btn-sm" id="batch-reject">批量拒收</button>' +
        '<button class="ghost btn-sm" id="batch-archive">批量归档</button>' +
        '<button class="ghost btn-sm btn-warn" id="batch-evidence">批量需补证</button>' : '') +
      '</div>';

    if (!items.length) {
      panel.innerHTML = filterBar + empty('当前状态下没有候选。');
      return;
    }

    var listHtml = items.map(function (item) {
      var payload = item.payload || {};
      var review = payload.review || {};
      var tierPill = '';
      if (review.tier === 'auto') tierPill = '<span class="pill pill--ok">自动级别</span>';
      else if (review.tier === 'review') tierPill = '<span class="pill pill--warn">需审阅</span>';
      else if (review.tier === 'user') tierPill = '<span class="pill pill--fail">需用户决策</span>';

      var statePill = '<span class="pill pill--warn">' + esc(item.state) + '</span>';
      if (item.state === 'needs_evidence') statePill = '<span class="pill pill--warn">需补证</span>';
      else if (item.state === 'archived') statePill = '<span class="pill pill--idle">已归档</span>';
      else if (item.state === 'rejected') statePill = '<span class="pill pill--fail">已拒收</span>';

      var actions = '';
      if (item.state === 'pending' || item.state === 'needs_evidence') {
        actions = '<div class="card__actions">' +
          '<button class="primary btn-sm action-approve" data-id="' + esc(item.id) + '">批准生效</button>' +
          '<button class="ghost btn-sm action-evidence" data-id="' + esc(item.id) + '">要求补证</button>' +
          '<button class="ghost btn-sm action-archive" data-id="' + esc(item.id) + '">移出归档</button>' +
          '<button class="ghost btn-sm btn-danger action-reject" data-id="' + esc(item.id) + '">拒收</button>' +
          '</div>';
      }

      return '<div class="card">' +
        '<div class="card__head">' +
        '<label style="display:flex;align-items:center;gap:6px;font-weight:600;cursor:pointer;">' +
        '<input type="checkbox" class="prop-checkbox" data-id="' + esc(item.id) + '"> ' +
        '<span>' + esc(payload.discovery ? String(payload.discovery).slice(0, 60) : item.id) + '</span>' +
        '</label>' +
        '<div>' + tierPill + ' ' + statePill + '</div>' +
        '</div>' +
        '<div class="card__meta">ID: <code>' + esc(item.id) + '</code>　来源 ' + esc(item.principal) +
        '　提交 ' + esc(new Date(item.createdAt).toLocaleString()) +
        (item.expiresAt ? '　到期 ' + esc(new Date(item.expiresAt).toLocaleDateString()) : '') +
        (review.reason ? '　分级策略：' + esc(review.reason) : '') +
        '</div>' +
        (payload.workflowId ? '<div class="card__path">关联流程 ' + esc(payload.workflowId) + '</div>' : '') +
        '<p class="card__body">' + esc(payload.discovery || '') + '</p>' +
        actions +
        '</div>';
    }).join('');

    panel.innerHTML = filterBar + listHtml;
  });
}

function renderTasks() {
  return post('/v1/tasks/list').then(function (data) {
    var tasks = data.tasks || [];
    if (!tasks.length) { panel.innerHTML = empty('暂无任务记录。'); return; }
    var labels = {
      in_progress: ['进行中', 'warn'], paused: ['已暂停', 'skip'],
      completed: ['已完成', 'ok'], cancelled: ['已取消', 'skip'], failed: ['失败', 'fail']
    };
    panel.innerHTML = '<div class="section-title">任务记录与跨端日记</div>' +
      '<table><thead><tr><th>任务名称</th><th>状态</th><th>验证情况</th><th>摘要</th><th>操作</th></tr></thead><tbody>' +
      tasks.map(function (task) {
        var state = labels[task.status] || [task.status, 'skip'];
        var verPill = task.verified
          ? '<span class="pill pill--ok">已验证</span>'
          : '<span class="pill pill--idle">未独立核验</span>';
        return '<tr><td><div><strong>' + esc(task.title) + '</strong></div><div class="card__path">' + esc(task.id) + '</div></td>' +
          '<td><span class="pill pill--' + state[1] + '">' + esc(state[0]) + '</span></td>' +
          '<td>' + verPill + '</td>' +
          '<td>' + esc(task.summary || '—') + '</td>' +
          '<td><div class="card__actions" style="margin:0;">' +
          '<button class="ghost btn-sm task-view-journal" data-id="' + esc(task.id) + '">查看日记</button>' +
          '<button class="ghost btn-sm task-handoff-btn" data-id="' + esc(task.id) + '">跨端接续</button>' +
          '<button class="ghost btn-sm task-export-md" data-id="' + esc(task.id) + '">导出 MD</button>' +
          '<button class="ghost btn-sm task-export-json" data-id="' + esc(task.id) + '">导出 JSON</button>' +
          '</div></td></tr>';
      }).join('') + '</tbody></table><div id="task-detail-box"></div>';
  });
}

function renderMaterial() {
  return post('/v1/material/list', { limit: 100 }).then(function (data) {
    var items = data.material || [];
    var stats = data.stats || {};
    var head = metrics([
      ['生效中资料', items.length],
      ['已到期未清理', stats.expiredUnpurged || 0],
      ['到期保留期', '90 天']
    ]) +
      '<div class="toolbar">' +
      '<span class="muted">临时资料 90 天到期控制：到期后立刻退出普通检索，清理任务可随时执行物理抹除。</span>' +
      '<div style="flex:1;"></div>' +
      '<button class="ghost btn-sm btn-danger" id="material-purge">立即清理已到期资料</button>' +
      '</div>';

    if (!items.length) {
      panel.innerHTML = head + empty('暂无保存的临时资料。');
      return;
    }

    var table = '<table><thead><tr><th>标题 / 来源</th><th>摘要</th><th>录入来源</th><th>到期日期</th><th>操作</th></tr></thead><tbody>' +
      items.map(function (mat) {
        var daysLeft = Math.ceil((mat.expiresAt - Date.now()) / 86400000);
        var statePill = daysLeft > 0
          ? '<span class="pill pill--ok">生效中 (' + daysLeft + '天)</span>'
          : '<span class="pill pill--fail">已过期</span>';
        return '<tr><td><div><strong>' + esc(mat.title) + '</strong></div>' +
          '<div class="card__path">' + esc(mat.url) + '</div></td>' +
          '<td>' + esc(mat.summary || '—') + '</td>' +
          '<td><span class="pill pill--skip">' + esc(mat.provenance) + '</span></td>' +
          '<td><div>' + esc(new Date(mat.expiresAt).toLocaleDateString()) + '</div>' + statePill + '</td>' +
          '<td><button class="ghost btn-sm material-renew" data-id="' + esc(mat.id) + '">延长90天</button></td></tr>';
      }).join('') + '</tbody></table>';

    panel.innerHTML = head + table;
  });
}

function renderHistory() {
  return post('/v1/history/recent', { limit: 50 }).then(function (data) {
    var chain = data.history || [];
    var head = '<div class="toolbar">' +
      '<input type="text" id="hist-id-input" placeholder="输入条目 ID 查询完整版本链…" style="flex:1;">' +
      '<button class="primary" id="hist-query-btn">查阅单条历史</button>' +
      '</div><div id="hist-single-box"></div>';

    var table = '<div class="section-title">最近知识变更与取代记录（Supersession Ledger）</div>';
    if (!chain.length) {
      table += empty('暂无知识变更记录。知识采用不可变版本，每次更正或补充均保留历史链路。');
    } else {
      table += '<table><thead><tr><th>动作</th><th>原版本 → 新版本</th><th>原因与证据</th><th>发起者</th><th>时间</th></tr></thead><tbody>' +
        chain.map(function (item) {
          var actPill = item.action === 'supersede'
            ? '<span class="pill pill--fail">推翻旧版</span>'
            : '<span class="pill pill--ok">补充新知</span>';
          return '<tr><td>' + actPill + '</td>' +
            '<td><code>' + esc(item.oldKnowledgeId) + ' v' + esc(item.oldRevision) + '</code> →<br><code>' +
            esc(item.newKnowledgeId) + ' v' + esc(item.newRevision) + '</code></td>' +
            '<td><div><strong>原因:</strong> ' + esc(item.reason) + '</div>' +
            '<div class="muted">证据: ' + esc(item.evidence) + '</div></td>' +
            '<td><span class="pill pill--skip">' + esc(item.origin) + '</span></td>' +
            '<td>' + esc(new Date(item.createdAt).toLocaleString()) + '</td></tr>';
        }).join('') + '</tbody></table>';
    }

    panel.innerHTML = head + table;
  });
}

function renderDoctor() {
  return Promise.all([
    post('/v1/stats'),
    post('/v1/capabilities').catch(function () { return { adapters: [], mode: 'Managed', detail: '核心运行中' }; })
  ]).then(function (out) {
    var s = out[0], cap = out[1];
    var modePill = cap.mode === 'Managed' ? '<span class="pill pill--ok">Managed (受控管理)</span>'
      : (cap.mode === 'ReadOnlySnapshot' ? '<span class="pill pill--warn">ReadOnlySnapshot (只读快照)</span>'
      : '<span class="pill pill--fail">Ungoverned (未受约束)</span>');

    var adaptersHtml = (cap.adapters || []).map(function (ad) {
      var caps = ad.capabilities || {};
      var renderRow = function (name, val) {
        var pill = val === 'yes' ? '<span class="pill pill--ok">支持</span>'
          : (val === 'no' ? '<span class="pill pill--fail">不支持</span>' : '<span class="pill pill--skip">未确定</span>');
        return '<tr><td>' + esc(name) + '</td><td>' + pill + '</td></tr>';
      };
      return '<div class="card">' +
        '<div class="card__head"><span class="card__title">' + esc(ad.id.toUpperCase()) + ' 适配器</span>' +
        (ad.installed ? '<span class="pill pill--ok">已安装 v' + esc(ad.version) + '</span>' : '<span class="pill pill--skip">未安装</span>') +
        '</div>' +
        '<div class="card__meta">' + (ad.location ? '路径: <code>' + esc(ad.location) + '</code>' : '未检测到配置位置') + '</div>' +
        '<table style="margin-top:8px;"><tbody>' +
        renderRow('读取当前规范', caps.readNorms) +
        renderRow('自动触发检索', caps.autoRetrieve) +
        renderRow('主动提交候选', caps.submitCandidate) +
        renderRow('采集事件', caps.collectEvents) +
        renderRow('阻止违规操作', caps.blockOperations) +
        renderRow('通知规则变更', caps.notifyRuleChange) +
        renderRow('可靠关联任务', caps.linkTask) +
        '</tbody></table>' +
        (ad.notes && ad.notes.length ? '<div class="muted" style="font-size:12px;margin-top:6px;">' +
          ad.notes.map(function (n) { return '• ' + esc(n); }).join('<br>') + '</div>' : '') +
        '</div>';
    }).join('');

    panel.innerHTML = metrics([
      ['知识版本', s.knowledgeRevision],
      ['生效条目', s.entries],
      ['待审候选', s.pendingProposals],
      ['事件记录', s.events]
    ]) +
      '<div class="card">' +
      '<div class="card__head"><span class="card__title">当前核心运行模式</span>' + modePill + '</div>' +
      '<p class="card__body">' + esc(cap.detail) + '</p>' +
      '</div>' +
      '<div class="section-title">平台适配器能力清单与边界</div>' +
      '<div class="grid-2">' + adaptersHtml + '</div>';
  });
}

function reportError(error) {
  setConnection(false);
  panel.innerHTML = notice(error && error.message ? error.message : '请求失败');
}

var RENDERERS = {
  status: renderStatus,
  manage: function () { return renderManage('', 'all'); },
  norms: renderNorms,
  proposals: function () { return renderProposals('pending'); },
  tasks: renderTasks,
  material: renderMaterial,
  history: renderHistory,
  doctor: renderDoctor,
};

function show(name) {
  var list = tabs.querySelectorAll('.tab');
  for (var i = 0; i < list.length; i += 1) {
    list[i].classList.toggle('tab--active', list[i].dataset.view === name);
  }
  panel.innerHTML = '<p class="muted">正在读取核心…</p>';
  var renderer = RENDERERS[name] || renderStatus;
  renderer().then(function () { setConnection(true); }, reportError);
}

tabs.addEventListener('click', function (event) {
  var tab = event.target.closest ? event.target.closest('.tab') : null;
  if (tab) show(tab.dataset.view);
});
document.getElementById('refresh').addEventListener('click', function () {
  var active = tabs.querySelector('.tab--active');
  show(active ? active.dataset.view : 'status');
});

// Event delegation on panel for interactive actions without inline scripts
panel.addEventListener('click', function (event) {
  var target = event.target;

  // Universal search & management
  if (target.id === 'u-search-btn') {
    renderManage().catch(reportError);
    return;
  }

  if (target.id === 'u-create-toggle') {
    showEditor(null);
    return;
  }

  if (target.id === 'u-editor-cancel') {
    var c = document.getElementById('u-editor-container');
    if (c) c.innerHTML = '';
    return;
  }

  if (target.id === 'u-editor-save') {
    var id = (document.getElementById('ed-id') || {}).value;
    var title = (document.getElementById('ed-title') || {}).value;
    var kind = (document.getElementById('ed-kind') || {}).value;
    var body = (document.getElementById('ed-body') || {}).value;
    var scopeKind = (document.getElementById('ed-scope') || {}).value;
    var baseRev = Number(target.dataset.baserev || 0);

    if (!id || !title || !body) { alert('ID、标题与正文均为必填项！'); return; }

    var scope = scopeKind === 'global' ? { kind: 'global' } : { kind: 'project', projectId: getProject() };
    var entry = {
      id: id.trim(),
      kind: kind,
      title: title.trim(),
      scope: scope,
      baseRevision: baseRev,
      labels: [],
      provenance: 'user',
      evidence: 'verified',
      platforms: [],
    };
    if (kind === 'norm') {
      entry.body = body.trim();
      entry.deniedTools = [];
      entry.hostProvided = false;
    } else if (kind === 'preference') {
      entry.body = body.trim();
      entry.stated = true;
    } else if (kind === 'skill') {
      entry.body = body.trim();
      entry.leaves = [];
      entry.needsStructure = true;
    } else {
      entry.body = body.trim();
    }

    post('/v1/knowledge/write', { entry: entry }).then(function (res) {
      alert('保存成功！' + (res.note || ''));
      renderManage();
    }).catch(reportError);
    return;
  }

  if (target.classList.contains('u-edit-btn')) {
    var editId = target.dataset.id;
    post('/v1/knowledge/get', { id: editId }).then(function (res) {
      showEditor({ id: res.id, revision: res.revision, rawContent: res.content });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }).catch(reportError);
    return;
  }

  if (target.classList.contains('u-delete-btn')) {
    var delId = target.dataset.id;
    var delRev = Number(target.dataset.rev || 0);
    if (!confirm('确定退役删除条目 ' + delId + '？历史版本将完整保留可追溯。')) return;
    post('/v1/knowledge/delete', { id: delId, baseRevision: delRev }).then(function () {
      alert('条目已成功删除！');
      renderManage();
    }).catch(reportError);
    return;
  }

  // Proposals single actions
  if (target.classList.contains('action-approve')) {
    var pId = target.dataset.id;
    var pTitle = prompt('请输入批准后的条目标题：', '经验记录');
    if (!pTitle) return;
    post('/v1/proposals/approve', {
      id: pId,
      entry: {
        id: pId,
        kind: 'memory',
        title: pTitle,
        body: target.closest('.card').querySelector('.card__body').textContent,
        scope: { kind: 'project', projectId: getProject() },
        baseRevision: 0,
        labels: [],
        provenance: 'user',
        evidence: 'verified',
        platforms: []
      }
    }).then(function () {
      alert('已成功批准条目入库！');
      var filter = document.getElementById('prop-filter');
      renderProposals(filter ? filter.value : 'pending');
    }).catch(reportError);
    return;
  }

  if (target.classList.contains('action-reject')) {
    if (!confirm('确定拒收该候选条目？记录将保留 90 天供查阅。')) return;
    post('/v1/proposals/reject', { id: target.dataset.id }).then(function () {
      var filter = document.getElementById('prop-filter');
      renderProposals(filter ? filter.value : 'pending');
    }).catch(reportError);
    return;
  }

  if (target.classList.contains('action-evidence')) {
    var reason = prompt('请输入需要补充的证据要求（必填）：', '缺少实际命令运行输出或独立测试验证产物');
    if (!reason) return;
    post('/v1/proposals/request-evidence', { id: target.dataset.id, reason: reason }).then(function () {
      var filter = document.getElementById('prop-filter');
      renderProposals(filter ? filter.value : 'pending');
    }).catch(reportError);
    return;
  }

  if (target.classList.contains('action-archive')) {
    post('/v1/proposals/archive', { id: target.dataset.id }).then(function () {
      var filter = document.getElementById('prop-filter');
      renderProposals(filter ? filter.value : 'pending');
    }).catch(reportError);
    return;
  }

  // Proposals batch actions
  if (target.id === 'batch-select-all') {
    var cbs = panel.querySelectorAll('.prop-checkbox');
    var allChecked = Array.prototype.every.call(cbs, function (cb) { return cb.checked; });
    cbs.forEach(function (cb) { cb.checked = !allChecked; });
    return;
  }

  var getCheckedIds = function () {
    var checked = panel.querySelectorAll('.prop-checkbox:checked');
    return Array.prototype.map.call(checked, function (cb) { return cb.dataset.id; });
  };

  if (target.id === 'batch-reject') {
    var rejectIds = getCheckedIds();
    if (!rejectIds.length) { alert('请先勾选要批量拒收的候选！'); return; }
    if (!confirm('确定批量拒收选中的 ' + rejectIds.length + ' 条候选？')) return;
    post('/v1/proposals/batch', { action: 'reject', ids: rejectIds }).then(function () {
      renderProposals('pending');
    }).catch(reportError);
    return;
  }

  if (target.id === 'batch-archive') {
    var arcIds = getCheckedIds();
    if (!arcIds.length) { alert('请先勾选要批量归档的候选！'); return; }
    post('/v1/proposals/batch', { action: 'archive', ids: arcIds }).then(function () {
      renderProposals('pending');
    }).catch(reportError);
    return;
  }

  if (target.id === 'batch-evidence') {
    var evIds = getCheckedIds();
    if (!evIds.length) { alert('请先勾选要要求补证的候选！'); return; }
    var evReason = prompt('请输入统一补证要求：', '需补充验证输出，30天未补证将自动归档');
    if (!evReason) return;
    post('/v1/proposals/batch', { action: 'request-evidence', ids: evIds, reason: evReason }).then(function () {
      renderProposals('pending');
    }).catch(reportError);
    return;
  }

  // Tasks actions
  if (target.classList.contains('task-view-journal')) {
    var taskId = target.dataset.id;
    post('/v1/tasks/export', { taskId: taskId, format: 'markdown' }).then(function (res) {
      var box = document.getElementById('task-detail-box');
      if (box) box.innerHTML = '<div class="card"><div class="card__head"><span class="card__title">任务日记：' + esc(taskId) + '</span></div>' +
        '<div class="pre-box">' + esc(res.markdown || '无日记内容') + '</div></div>';
    }).catch(reportError);
    return;
  }

  if (target.classList.contains('task-handoff-btn')) {
    var hTaskId = target.dataset.id;
    post('/v1/tasks/handoff', { taskId: hTaskId }).then(function (res) {
      var box = document.getElementById('task-detail-box');
      if (box) {
        var filesList = (res.files || []).length
          ? res.files.map(function (f) { return '• 待核对文件: <code>' + esc(f) + '</code>'; }).join('<br>')
          : '无明确指定的文件清单';
        box.innerHTML = '<div class="card">' +
          '<div class="card__head"><span class="card__title">跨端接续信息：' + esc(hTaskId) + '</span>' +
          '<span class="pill pill--ok">知识版本 v' + esc(res.knowledgeRevision) + '</span></div>' +
          '<p class="card__body"><strong>建议下一步：</strong>' + esc(res.suggestion) + '<br><br>' +
          '<strong>待核对环境与文件：</strong><br>' + filesList + '<br><br>' +
          '<span class="muted" style="font-size:12px;">' + esc(res.caveat) + '</span></p>' +
          '</div>';
      }
    }).catch(reportError);
    return;
  }

  if (target.classList.contains('task-export-md')) {
    post('/v1/tasks/export', { taskId: target.dataset.id, format: 'markdown' }).then(function (res) {
      var box = document.getElementById('task-detail-box');
      if (box) box.innerHTML = '<div class="card"><div class="card__head"><span class="card__title">Markdown 导出预览</span></div>' +
        '<div class="pre-box">' + esc(res.markdown || '') + '</div></div>';
    }).catch(reportError);
    return;
  }

  if (target.classList.contains('task-export-json')) {
    post('/v1/tasks/export', { taskId: target.dataset.id, format: 'json' }).then(function (res) {
      var box = document.getElementById('task-detail-box');
      if (box) box.innerHTML = '<div class="card"><div class="card__head"><span class="card__title">JSON 导出预览</span></div>' +
        '<div class="pre-box">' + esc(JSON.stringify(res.task || {}, null, 2)) + '</div></div>';
    }).catch(reportError);
    return;
  }

  // Material actions
  if (target.classList.contains('material-renew')) {
    var matId = target.dataset.id;
    var rReason = prompt('请输入续期 90 天的明确理由（必填）：', '项目周期延长，该外部资料仍有参考价值');
    if (!rReason) return;
    post('/v1/material/renew', { id: matId, reason: rReason }).then(function () {
      alert('续期成功！到期时间已延长 90 天。');
      renderMaterial();
    }).catch(reportError);
    return;
  }

  if (target.id === 'material-purge') {
    if (!confirm('确定清理所有已到期的临时资料？此操作将物理删除已过期的正文与索引。')) return;
    post('/v1/material/purge').then(function (res) {
      alert('清理完成！清理数量：' + (res.purged ? res.purged.length : 0));
      renderMaterial();
    }).catch(reportError);
    return;
  }

  // History single query
  if (target.id === 'hist-query-btn') {
    var kId = (document.getElementById('hist-id-input') || {}).value;
    if (!kId) { alert('请输入知识条目 ID！'); return; }
    post('/v1/knowledge/history', { knowledgeId: kId.trim() }).then(function (res) {
      var hBox = document.getElementById('hist-single-box');
      if (!hBox) return;
      var cur = res.current ? '当前版本: v' + esc(res.current.revision) + ' [' + esc(res.current.status) + ']' : '（已退役或不存在）';
      var revs = (res.revisions || []).map(function (r) {
        return '• v' + esc(r.revision) + '　创建时间: ' + esc(new Date(r.createdAt).toLocaleString());
      }).join('<br>');
      hBox.innerHTML = '<div class="card"><div class="card__head"><span class="card__title">条目完整版本历史: ' + esc(kId) + '</span>' +
        '<span class="pill pill--ok">' + cur + '</span></div>' +
        '<div class="card__body">' + (revs || '无版本历史') + '</div></div>';
    }).catch(reportError);
    return;
  }
});

// Select change listener
panel.addEventListener('change', function (event) {
  if (event.target.id === 'prop-filter') {
    renderProposals(event.target.value).catch(reportError);
  }
  if (event.target.id === 'u-kind-filter') {
    renderManage(undefined, event.target.value).catch(reportError);
  }
});

panel.addEventListener('keydown', function (event) {
  if (event.key === 'Enter' && event.target.id === 'u-query') {
    renderManage(event.target.value, undefined).catch(reportError);
  }
  if (event.key === 'Enter' && event.target.id === 'hist-id-input') {
    var btn = document.getElementById('hist-query-btn');
    if (btn) btn.click();
  }
});

if (!token) {
  panel.innerHTML = notice('缺少凭据。请用 node dist/src/cli.js ui 生成带凭据的地址后打开。');
  setConnection(false);
} else {
  show('status');
}
`;
