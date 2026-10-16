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
    <button class="tab" data-view="maintenance">后台任务</button>
    <button class="tab" data-view="organization">Skill 整理</button>
  </nav>
  <main class="panel" id="panel"><p class="muted">正在读取核心…</p></main>
  <footer class="statusbar">
    <span>凭据保存在当前标签页的会话存储（sessionStorage）中，关闭标签页时清除；不写入插件配置文件。</span>
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
if (token) {
  try { sessionStorage.setItem('amb_ui_token', token); } catch (e) {}
} else {
  try { token = sessionStorage.getItem('amb_ui_token') || ''; } catch (e) {}
}
if (location.hash) history.replaceState(null, '', location.pathname);

var currentProject = '';
var currentRole = '';
var currentEditingEntry = null;

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
/**
 * Local time with an explicit offset.
 *
 * F09: the page showed local time while the Markdown export showed UTC with no
 * label, so correlating the two timelines was guesswork. Every timestamp now
 * carries its offset, and the export/KPI views borrow this same helper.
 */
function localTime(value) {
  if (value === undefined || value === null || value === '') return '—';
  var d = new Date(value);
  if (isNaN(d.getTime())) return '—';
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var offset = -d.getTimezoneOffset();
  var sign = offset >= 0 ? '+' : '-';
  var abs = Math.abs(offset);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes()) +
    ' UTC' + sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60);
}
/** Trigger a browser download without leaving the page or needing a server round-trip. */
function downloadText(filename, text, mime) {
  try {
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    return true;
  } catch (e) { return false; }
}
function notice(message, info) {
  return '<div class="notice' + (info ? ' notice--info' : '') + '">' + esc(message) + '</div>';
}
function empty(message) { return '<div class="empty">' + esc(message) + '</div>'; }

function getProject() {
  return currentProject || '';
}

function post(path, body) {
  var envelope = Object.assign({}, body || {});
  // Use the verified caller project identity when established.
  if (currentProject && !envelope.projectId) {
    envelope.projectId = currentProject;
  }
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, 'x-amb-protocol': '1' },
    body: JSON.stringify(envelope),
  }).then(function (response) {
    return response.json().catch(function () { return {}; }).then(function (data) {
      if (!response.ok) {
        var err = new Error(data.message || ('HTTP ' + response.status));
        err.status = response.status;
        err.code = data.code;
        // Scope and access control errors are surfaced explicitly rather than as generic noise
        if (response.status === 403 && (data.code === 'scope_denied' || /scope|project|credential/i.test(data.message || ''))) {
          err.friendlyMessage = '该条目属于其他项目，不可访问（权限拒绝）';
        } else if (response.status === 404) {
          err.friendlyMessage = '该条目不存在或属于其他项目，不可访问';
        }
        throw err;
      }
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

function renderTokenPrompt() {
  panel.innerHTML = '<div class="card" style="max-width:520px;margin:40px auto;padding:24px;text-align:center;">' +
    '<h2>连接到知识库</h2>' +
    '<p class="muted" style="margin:12px 0 20px;">未检测到访问凭据，请输入凭据令牌（Token）：</p>' +
    '<input id="token-input" type="password" placeholder="粘贴 token（可在 ~/.agent-memory-backpack/*.json 查看）" style="width:100%;box-sizing:border-box;padding:8px 12px;margin-bottom:16px;border-radius:4px;border:1px solid var(--border,#333);background:var(--bg-input,#181c24);color:#fff;" />' +
    '<button id="token-save-btn" class="primary" style="padding:8px 24px;cursor:pointer;">连接并保存</button>' +
    '<p class="muted" style="margin-top:16px;font-size:12px;">凭据使用当前标签页的会话存储（sessionStorage），关闭标签页时清除。</p>' +
    '</div>';
  var btn = document.getElementById('token-save-btn');
  if (btn) {
    btn.onclick = function() {
      var val = (document.getElementById('token-input').value || '').trim();
      if (!val) return;
      token = val;
      try { sessionStorage.setItem('amb_ui_token', token); } catch (e) {}
      show('status');
    };
  }
}

function ensureIdentity() {
  if (!token) {
    renderTokenPrompt();
    return Promise.reject(new Error('未配置凭据'));
  }
  if (currentProject) return Promise.resolve(currentProject);
  return post('/v1/stats', {}).then(function (s) {
    if (s.projectId) {
      currentProject = s.projectId;
      var pNode = document.getElementById('t-project');
      if (pNode) pNode.textContent = currentProject;
    }
    if (s.role) currentRole = s.role;
    return currentProject;
  });
}

/**
 * Refresh the masthead's knowledge version and project from the core.
 *
 * F02: only the status view wrote t-revision, so a knowledge write that called
 * renderManage() left the header showing the previous revision even though the
 * table and the core had moved on. Every write path now calls this, so the
 * header cannot disagree with the data beneath it.
 */
function refreshHeader() {
  return post('/v1/stats').then(function (s) {
    if (s.projectId) {
      currentProject = s.projectId;
      var pNode = document.getElementById('t-project');
      if (pNode) pNode.textContent = currentProject;
    }
    if (s.role) currentRole = s.role;
    var revNode = document.getElementById('t-revision');
    if (revNode) revNode.textContent = String(s.knowledgeRevision);
    return s;
  });
}

function renderStatus() {
  return refreshHeader().then(function (s) {
    return Promise.all([
      Promise.resolve(s),
      post('/v1/rescan/state').catch(function () { return {}; }),
      post('/v1/material/list', { limit: 1 }).catch(function () { return { material: [], stats: {} }; })
    ]);
  }).then(function (out) {
    var s = out[0], r = out[1], m = out[2];
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
      '<p class="card__body">上次扫描：' + esc(localTime(r.lastRescanAt)) +
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
          var pills = '<span class="pill pill--ok">' + esc(item.kind) + '</span>';
          if (item.kind === 'workflow' && item.isEntryPoint) {
            pills += ' <span class="pill pill--ok">EntryPoint</span>';
          }
          var extraMeta = [];
          if (item.platforms && item.platforms.length) {
            extraMeta.push('平台: ' + item.platforms.join('/'));
          }
          return '<tr><td><div><strong>' + esc(item.title) + '</strong></div><div class="card__path">' + esc(item.id) + '</div></td>' +
            '<td>' + pills + '</td>' +
            '<td><code>v' + esc(item.revision) + '</code></td>' +
            '<td>' + esc(sc) + (extraMeta.length ? '<div class="card__meta">' + esc(extraMeta.join(' | ')) + '</div>' : '') + '</td>' +
            '<td>' + esc(item.excerpt) + (item.why && item.why.matched ? '<div class="card__path">命中: ' + esc(item.why.matched.join(',')) + '</div>' : '') + '</td>' +
            '<td><div class="card__actions" style="margin:0;">' +
            '<button class="ghost btn-sm u-edit-btn" data-id="' + esc(item.id) + '">编辑修改</button>' +
            '<button class="ghost btn-sm u-history-btn" data-id="' + esc(item.id) + '">历史</button>' +
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
  currentEditingEntry = isEdit ? entryToEdit : null;
  var raw = entryToEdit ? (entryToEdit.rawContent || entryToEdit.content || {}) : {};
  var id = entryToEdit ? entryToEdit.id : ('k-' + Date.now().toString(36));
  var title = raw.title || '';
  var kind = raw.kind || 'memory';
  var body = raw.body !== undefined ? raw.body : (raw.overview !== undefined ? raw.overview : (raw.did !== undefined ? raw.did : ''));
  var scopeKind = raw.scope && raw.scope.kind === 'global' ? 'global' : 'project';
  var baseRevision = entryToEdit ? (entryToEdit.revision || 0) : 0;

  var allKinds = [
    ['memory', '记忆 (memory)'],
    ['norm', '规范 (norm)'],
    ['preference', '偏好 (preference)'],
    ['skill', '技能 (skill)'],
    ['journal', '日记 (journal)'],
    ['workflow', '流程 (workflow)'],
    ['material', '临时资料 (material)'],
  ];

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
    allKinds.map(function (k) {
      return '<option value="' + esc(k[0]) + '"' + (kind === k[0] ? ' selected' : '') + '>' + esc(k[1]) + '</option>';
    }).join('') +
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
    '<div class="form-group"><label>正文内容' + (isEdit && kind === 'workflow' ? ' (流程概述)' : (isEdit && kind === 'journal' ? ' (工作摘要)' : '')) + '</label>' +
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
      '<option value="approved"' + (state === 'approved' ? ' selected' : '') + '>已生效 (approved)</option>' +
      '<option value="archived"' + (state === 'archived' ? ' selected' : '') + '>已归档 (archived)</option>' +
      '<option value="rejected"' + (state === 'rejected' ? ' selected' : '') + '>已拒收 (rejected)</option>' +
      '</select>' +
      (state === 'pending' || state === 'needs_evidence' ?
        '<button class="ghost btn-sm" id="batch-select-all">全选</button>' +
        '<button class="primary btn-sm" id="batch-approve">批量批准</button>' +
        '<button class="ghost btn-sm" id="batch-reject">批量拒收</button>' +
        '<button class="ghost btn-sm" id="batch-archive">批量归档</button>' +
        '<button class="ghost btn-sm btn-warn" id="batch-evidence">批量需补证</button>' : '') +
      '</div>';

    if (!items.length) {
      panel.innerHTML = filterBar + '<div id="prop-editor-box"></div>' + empty('当前状态下没有候选。');
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
      else if (item.state === 'approved') statePill = '<span class="pill pill--ok">已生效</span>';

      var actions = '';
      if (item.state === 'pending' || item.state === 'needs_evidence') {
        actions = '<div class="card__actions">' +
          '<button class="primary btn-sm action-approve" data-id="' + esc(item.id) + '">批准生效</button>' +
          '<button class="ghost btn-sm action-evidence" data-id="' + esc(item.id) + '">要求补证</button>' +
          '<button class="ghost btn-sm action-archive" data-id="' + esc(item.id) + '">移出归档</button>' +
          '<button class="ghost btn-sm btn-danger action-reject" data-id="' + esc(item.id) + '">拒收</button>' +
          '</div>';
      } else if (item.state === 'archived' || item.state === 'rejected' || item.state === 'expired') {
        actions = '<div class="card__actions">' +
          '<button class="ghost btn-sm action-reopen" data-id="' + esc(item.id) + '">重新开启审阅</button>' +
          '</div>';
      }

      var decision = payload.decision || {};
      var decisionLine = decision.state
        ? '<div class="card__meta">审阅决定：' + esc(decision.action || decision.state) +
          '　操作者 ' + esc(decision.actor || '未署名') + '　时间 ' + esc(localTime(decision.at)) + '</div>'
        : '';

      return '<div class="card">' +
        '<div class="card__head">' +
        '<label style="display:flex;align-items:center;gap:6px;font-weight:600;cursor:pointer;">' +
        '<input type="checkbox" class="prop-checkbox" data-id="' + esc(item.id) + '"> ' +
        '<span>' + esc(payload.discovery ? String(payload.discovery).slice(0, 60) : item.id) + '</span>' +
        '</label>' +
        '<div>' + tierPill + ' ' + statePill + '</div>' +
        '</div>' +
        '<div class="card__meta">ID: <code>' + esc(item.id) + '</code>　来源 ' + esc(item.principal) +
        '　提交 ' + esc(localTime(item.createdAt)) +
        (item.expiresAt ? '　到期 ' + esc(localTime(item.expiresAt)) : '') +
        (review.reason ? '　分级策略：' + esc(review.reason) : '') +
        '</div>' +
        (payload.workflowId ? '<div class="card__path">关联流程 ' + esc(payload.workflowId) +
          (payload.baseRevision !== undefined && payload.baseRevision !== null ? ' @ 基线版本 v' + esc(payload.baseRevision) : '') + '</div>' : '') +
        decisionLine +
        '<p class="card__body">' + esc(payload.discovery || '') + '</p>' +
        actions +
        '</div>';
    }).join('');

    panel.innerHTML = filterBar + '<div id="prop-editor-box"></div>' + listHtml;
  });
}

/**
 * The approval form for one candidate.
 *
 * F01: approving used to call window.prompt() and send the candidate's own id as
 * the entry id. The embedded browser has no prompt(), and the core refuses a
 * workflow-bearing candidate whose entry id is not that workflow, so the path
 * could not work for the case it most needed to. This form resolves the target
 * server-side, shows the workflow and its current revision, and lets the reviewer
 * edit the prose (or a whole workflow entry as JSON) before approving.
 *
 * The same page-form pattern replaces every other prompt() in this file, because
 * the environment that exposes the weakness is the one the interface is opened
 * in, not a property of one button.
 */
function showProposalEditor(proposalId) {
  var box = document.getElementById('prop-editor-box');
  if (box) box.innerHTML = '<p class="muted">正在读取候选与目标流程…</p>';
  post('/v1/proposals/get', { id: proposalId }).then(function (detail) {
    if (!box) return;
    var target = detail.target || {};
    var scopeKind = detail.payload && detail.payload.scope && detail.payload.scope.kind === 'global' ? 'global' : 'project';
    var targetLine = target.available
      ? '<div class="card__path">目标流程：<code>' + esc(target.workflowId) + '</code>' +
        (target.baseRevision !== null && target.baseRevision !== undefined ? '（候选基于 v' + esc(target.baseRevision) + '，当前 v' + esc(target.currentRevision !== null && target.currentRevision !== undefined ? target.currentRevision : '—') + '）' : '') + '</div>'
      : '<div class="card__path">' + esc(target.reason || '无目标流程') + '</div>';
    var needsEvidence = detail.review && detail.review.constraint
      ? '<div class="card__meta">分级约束：' + esc(detail.review.constraint) + '</div>' : '';
    var modelReview = detail.modelReview || { status: 'awaiting_model' };
    var analysis = modelReview.analysis || {};
    var modelLine = '<div class="card__meta">分析来源：' + esc(modelReview.mode === 'model' ? ('模型 ' + modelReview.model) : '规则分析；等待模型') +
      '；仅供审阅参考，不代表批准。</div>' + (analysis.summary ? '<p>' + esc(analysis.summary) + '</p>' : '') +
      (analysis.reasoning ? '<p class="muted">' + esc(analysis.reasoning) + '</p>' : '');

    var body = '';
    var formBody = '';
    if (target.available && target.entry && target.entry.kind === 'workflow') {
      // A workflow entry is structured; editing it as JSON is the honest surface
      // rather than inventing fields for triggers/stages/checks.
      body = JSON.stringify(target.entry, null, 2);
      formBody =
        '<div class="form-group"><label>完整流程条目（JSON，可编辑后批准；修订号由核心按 CAS 递增）</label>' +
        '<textarea id="pe-entry-json" rows="14" style="font-family:ui-monospace,Consolas,monospace;">' + esc(body) + '</textarea></div>';
    } else {
      body = (detail.discovery || '');
      formBody =
        '<div class="form-group"><label>条目 ID' + (detail.payload && detail.payload.workflowId ? '（必须等于目标流程 ID）' : '（默认使用候选 UUID）') + '</label>' +
        '<input type="text" id="pe-id" value="' + esc(detail.payload && detail.payload.workflowId ? detail.payload.workflowId : detail.id) + '"></div>' +
        '<div class="form-group"><label>标题</label>' +
        '<input type="text" id="pe-title" value="' + esc((detail.discovery || '').slice(0, 40) || '经验记录') + '"></div>' +
        '<div class="form-group"><label>正文</label>' +
        '<textarea id="pe-body" rows="6">' + esc(body) + '</textarea></div>';
    }

    box.innerHTML = '<div class="editor-card">' +
      '<div class="card__head" style="margin-bottom:10px;">' +
      '<span class="card__title">审阅候选：' + esc(detail.id) + '</span>' +
      '<button class="ghost btn-sm" id="pe-cancel">取消</button>' +
      '</div>' +
      targetLine + needsEvidence + modelLine +
      '<p class="card__body">' + esc(detail.discovery || '') + '</p>' +
      formBody +
      '<div class="form-group"><label>作用范围</label>' +
      '<select id="pe-scope" class="select">' +
      '<option value="project"' + (scopeKind === 'project' ? ' selected' : '') + '>项目专属（默认，最窄）</option>' +
      '<option value="global"' + (scopeKind === 'global' ? ' selected' : '') + '>全局共享（将应用到所有项目）</option>' +
      '</select></div>' +
      '<div class="card__actions">' +
      '<button class="primary" id="pe-approve" data-id="' + esc(detail.id) + '" data-target="' + esc(target.available ? target.workflowId : '') + '">批准并生效</button>' +
      '<span class="muted" style="font-size:12px;">批准后目标流程产生新 revision；DSH 下一轮检索即可读到。</span>' +
      '</div>' +
      '</div>';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }).catch(function (error) {
    if (box) box.innerHTML = notice((error && (error.friendlyMessage || error.message)) || '读取候选失败');
  });
}

/**
 * Build the entry an approval will write.
 *
 * For a workflow-bearing candidate the entry must be the target workflow itself
 * (the core enforces this), and its baseRevision is forced to the revision the
 * candidate was based on so the core's re-comparison check stays meaningful. The
 * reviewer may edit the prose; the structural fields are preserved around it.
 */
function buildApprovalEntry(detail) {
  var target = detail.target || {};
  var scopeKind = (document.getElementById('pe-scope') || {}).value === 'global' ? 'global' : 'project';
  var scope = scopeKind === 'global' ? { kind: 'global' } : { kind: 'project', projectId: getProject() };
  if (target.available && target.entry && target.entry.kind === 'workflow') {
    var raw = (document.getElementById('pe-entry-json') || {}).value || '{}';
    var entry;
    try { entry = JSON.parse(raw); } catch (e) { throw new Error('流程 JSON 解析失败：' + e.message); }
    entry.id = target.workflowId;
    entry.kind = 'workflow';
    entry.scope = scopeKind === 'global' ? { kind: 'global' } : (target.entry.scope && target.entry.scope.kind === 'project' ? target.entry.scope : scope);
    entry.baseRevision = target.baseRevision !== null && target.baseRevision !== undefined ? target.baseRevision : (target.entry.baseRevision || 0);
    return { entry: entry, allowGlobalScope: scopeKind === 'global' };
  }
  var id = ((document.getElementById('pe-id') || {}).value || '').trim();
  var title = ((document.getElementById('pe-title') || {}).value || '').trim();
  var body = ((document.getElementById('pe-body') || {}).value || '').trim();
  if (!id) throw new Error('条目 ID 必填');
  if (target.available && id !== target.workflowId) throw new Error('该候选关联流程 ' + target.workflowId + '，条目 ID 必须与之一致');
  return {
    entry: {
      id: id,
      kind: 'memory',
      title: title || '经验记录',
      body: body,
      scope: scope,
      baseRevision: 0,
      labels: ['approved'],
      provenance: 'user',
      evidence: 'verifiable',
      platforms: [],
    },
    allowGlobalScope: scopeKind === 'global',
  };
}

/**
 * The approval entry for a candidate the reviewer did not open a form for.
 *
 * Batch approval reads each candidate's resolved target and builds the entry the
 * core will accept: the target workflow itself when there is one (its base
 * revision preserved so the stale-proposal check still applies), otherwise a
 * fresh memory carrying the candidate's own text. This is the same rule the
 * single-candidate form follows, minus the editable fields.
 */
function programmaticApproval(detail) {
  var target = detail.target || {};
  var scope = { kind: 'project', projectId: getProject() };
  if (target.available && target.entry && target.entry.kind === 'workflow') {
    var entry = JSON.parse(JSON.stringify(target.entry));
    entry.baseRevision = target.baseRevision !== null && target.baseRevision !== undefined ? target.baseRevision : (target.entry.baseRevision || 0);
    return { entry: entry, allowGlobalScope: false };
  }
  return {
    entry: {
      id: detail.id,
      kind: 'memory',
      title: (detail.discovery || '经验记录').slice(0, 40),
      body: detail.discovery || '',
      scope: scope,
      baseRevision: 0,
      labels: ['approved'],
      provenance: 'user',
      evidence: 'verifiable',
      platforms: [],
    },
    allowGlobalScope: false,
  };
}

function approveProposalForm(proposalId) {
  return post('/v1/proposals/get', { id: proposalId }).then(function (detail) {
    var built;
    try { built = buildApprovalEntry(detail); } catch (e) { throw e; }
    return post('/v1/proposals/approve', {
      id: proposalId,
      entry: built.entry,
      allowGlobalScope: built.allowGlobalScope,
    }).then(function (res) {
      return refreshHeader().then(function () {
        alert('候选已批准生效！知识版本 v' + res.knowledgeRevision + (res.note ? '\\n' + res.note : ''));
        var filter = document.getElementById('prop-filter');
        renderProposals(filter ? filter.value : 'pending');
      });
    });
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
    var totalChars = items.reduce(function (sum, m) { return sum + (m.body ? m.body.length : 0); }, 0);
    var head = metrics([
      ['生效中资料', items.length],
      ['已到期未清理', stats.expiredUnpurged || 0],
      ['占用总大小', totalChars + ' 字符'],
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

    var table = '<table><thead><tr><th>标题 / 来源</th><th>摘要与大小</th><th>录入来源</th><th>到期与正文状态</th><th>操作</th></tr></thead><tbody>' +
      items.map(function (mat) {
        var daysLeft = Math.ceil((mat.expiresAt - Date.now()) / 86400000);
        var statePill = daysLeft > 0
          ? '<span class="pill pill--ok">生效中 (' + daysLeft + '天)</span>'
          : '<span class="pill pill--fail">已过期</span>';
        var bodyStatus = (mat.body && mat.body.length > 0)
          ? '<span class="pill pill--warn">正文保留 (' + mat.body.length + ' 字符)</span>'
          : '<span class="pill pill--ok">正文已清空</span>';
        return '<tr><td><div><strong>' + esc(mat.title) + '</strong></div>' +
          '<div class="card__path">' + esc(mat.url) + '</div></td>' +
          '<td>' + esc(mat.summary || '—') + '<div class="card__meta">正文大小: ' + (mat.body ? mat.body.length + ' 字符' : '0') + '</div></td>' +
          '<td><span class="pill pill--skip">' + esc(mat.provenance) + '</span></td>' +
          '<td><div>' + esc(localTime(mat.expiresAt)) + '</div>' + statePill + ' ' + bodyStatus + '</td>' +
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
            '<td>' + esc(localTime(item.createdAt)) + '</td></tr>';
        }).join('') + '</tbody></table>';
    }

    panel.innerHTML = head + table;
  });
}

function renderDoctor() {
  return Promise.all([
    post('/v1/stats'),
    post('/v1/capabilities').catch(function () {
      // Capability check failure must never report Managed; fall back honestly to Ungoverned
      return { adapters: [], mode: 'Ungoverned', detail: '核心能力接口不可达或调用失败，状态降级为未受规则约束' };
    })
  ]).then(function (out) {
    var s = out[0], cap = out[1];
    var modePill = cap.mode === 'Managed' ? '<span class="pill pill--ok">Managed (受控管理)</span>'
      : (cap.mode === 'ReadOnlySnapshot' ? '<span class="pill pill--warn">ReadOnlySnapshot (只读快照保护)</span>'
      : '<span class="pill pill--fail">Ungoverned (未受约束)</span>');
    /**
     * F07: state what is actually enforced when the core is unreachable, and when
     * the snapshot was taken, rather than telling the user all protection is gone.
     * A ReadOnlySnapshot still enforces the recorded prohibitions; only judgments
     * that were never recorded are unknown.
     */
    var modeExplain = cap.mode === 'ReadOnlySnapshot'
      ? '核心当前不可达；本机最近一次规则快照仍在执行已记录的禁止（只读快照）。快照之后新增或修改的规则无从核对，属于未知边界。'
      : (cap.mode === 'Managed'
        ? '核心可达，规则按核心实时裁决。'
        : '核心不可达且没有可用的规则快照：没有可执行的已记录禁止，但这不代表环境安全，只是无从核对。');

    var adaptersHtml = (cap.adapters || []).map(function (ad) {
      var caps = ad.capabilities || {};
      var renderRow = function (name, val) {
        var pill = val === 'yes' ? '<span class="pill pill--ok">支持</span>'
          : (val === 'no' ? '<span class="pill pill--fail">不支持</span>' : '<span class="pill pill--skip">未确定</span>');
        return '<tr><td>' + esc(name) + '</td><td>' + pill + '</td></tr>';
      };
      return '<div class="card">' +
        '<div class="card__head"><span class="card__title">' + esc(ad.id.toUpperCase()) + ' 适配器</span>' +
        (ad.installed ? '<span class="pill pill--ok">已安装 v' + esc(ad.version) + '</span>' : '<span class="pill pill--warn">未安装或未找到清单</span>') +
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
      '<div class="card__head"><span class="card__title">当前核心运行模式</span>' +
      '<div>' + modePill + ' <button class="ghost btn-sm" id="doctor-reconnect">手动重新检测</button></div></div>' +
      '<p class="card__body">' + esc(cap.detail) + '</p>' +
      '<p class="card__body muted" style="font-size:12px;">' + esc(modeExplain) +
      (cap.snapshotAt ? '（快照时间：' + esc(localTime(cap.snapshotAt)) + '）' : '') + '</p>' +
      '</div>' +
      '<div class="section-title">平台适配器能力清单与边界</div>' +
      '<div class="grid-2">' + adaptersHtml + '</div>';
  });
}

function reportError(error) {
  setConnection(false);
  var msg = (error && (error.friendlyMessage || error.message)) ? (error.friendlyMessage || error.message) : '请求失败';
  /**
   * F07: the offline copy claimed every protection degrades to "未受规则约束",
   * while the observed behaviour is that a recent rule snapshot still blocks
   * prohibited tools (LocalGuarded/ReadOnlySnapshot). The wording now names the
   * actual states and what is and is not known, instead of asserting the weaker
   * claim as fact.
   */
  panel.innerHTML = notice(msg) +
    '<div class="card" style="margin-top:14px;">' +
    '<div class="card__head"><span class="card__title">核心状态：无法读取（离线）</span>' +
    '<button class="primary btn-sm" id="err-retry-btn">重新连接</button></div>' +
    '<p class="card__body">核心服务可能未启动或当前凭据已被撤销。若曾成功连接过，本机保留的最近规则快照仍会执行已记录的禁止（只读快照保护）；未记录过的判断则无从核对，属于未知边界，不等于“无风险”。<br>' +
    '启动核心命令（在已安装插件的运行时目录执行，或直接重新打开本页触发重试）：<code>node runtime/cli.js serve --data-dir &lt;数据目录&gt;</code></p>' +
    '</div>';
}

function renderOrganization() {
  return post('/v1/workflow-drafts/list', {}).then(function(data) {
    panel.innerHTML = '<h2>Skill 整理</h2><p class="muted">模型依据原文和参考文档生成完整流程草稿。缺少依据的步骤保留待补；批准前核对适用条件与检查项。原 skill 继续同步，来源更新后旧流程停止执行并等待复核。</p>' +
      '<div class="card"><select id="organize-skill">' + (data.skills || []).map(function(s) { return '<option value="'+esc(s.id)+'">'+esc(s.title)+' @'+esc(s.revision)+'</option>'; }).join('') + '</select> <button id="organize-generate">生成或查看整理任务</button></div>' +
      (data.drafts || []).map(function(d) { return '<div class="card"><strong>'+esc(d.title || d.skillId)+'</strong> <span class="pill">流程：'+esc(d.workflowStatus || d.state)+'</span> <span class="pill">摘要：'+esc(d.digestStatus || (d.digest?'ready':'pending'))+'</span><p>'+esc((d.digest&&d.digest.summary)||'尚无检索摘要')+'</p><p class="muted">摘要与流程分别整理；摘要仅用于检索，流程状态须单独复核。 '+esc(d.digestError || d.workflowError || '')+'</p><p>'+esc((d.missing || []).join('；'))+'</p><button class="draft-open" data-id="'+esc(d.id)+'">原文与草稿对照</button></div>'; }).join('');
    panel.querySelector('#organize-generate').addEventListener('click',function() {
      var select=panel.querySelector('#organize-skill'); if(!select.value)return;
      post('/v1/workflow-drafts/generate',{skillId:select.value}).then(renderOrganization).catch(reportError);
    });
    panel.querySelectorAll('.draft-open').forEach(function(button) { button.addEventListener('click',function() {
      post('/v1/workflow-drafts/get',{id:button.dataset.id}).then(function(d) {
        var result=d.result || {};
        var digest=result.digest || {};
        var digestHtml='<section class="card"><h3>检索辅助归纳</h3><p class="muted">用于寻找相关知识，非已采纳流程；适用条件仍须核对原文。</p><p><strong>摘要：</strong>'+esc(digest.summary || '尚无归纳')+'</p>' +
          [['适用场景',digest.whenToUse],['排除条件',digest.exclusions],['别名',digest.aliases],['适用版本',digest.versions]].map(function(row){return '<p><strong>'+esc(row[0])+'：</strong>'+esc((Array.isArray(row[1])?row[1]:[]).join('；') || '未提供')+'</p>';}).join('')+'</section>';
        panel.innerHTML='<h2>流程草稿对照</h2><p>流程状态：'+esc(d.workflowStatus||d.state)+'；摘要状态：'+esc(d.digestStatus|| (digest.summary?'ready':'pending'))+'。'+(d.state==='approved'?'已审阅采纳，执行前仍须核对来源版本。':'模型结果尚未生效。')+'</p>'+digestHtml+'<h3>完整流程</h3><pre>'+esc(JSON.stringify(result.workflow || null,null,2))+'</pre><h3>逐项来源</h3><pre>'+esc(JSON.stringify(result.grounding || [],null,2))+'</pre><h3>缺项</h3><p>'+esc((result.missing || []).join('；'))+'</p><details><summary>源 skill 与全部参考正文</summary><pre>'+esc(JSON.stringify(d.source,null,2))+'</pre></details><button id="draft-back">返回</button> '+(d.state==='ready_for_review'?'<button class="primary" id="draft-approve">确认已审阅并采纳流程</button>':'');
        panel.querySelector('#draft-back').addEventListener('click',renderOrganization);
        if(d.state!=='approved' && d.state!=='stale' && d.result) {
          var editor=document.createElement('div');
          editor.innerHTML='<h3>修订抽取内容</h3><p class="muted">只填写有原文依据的流程与引文；缺失条件保留在 missing 中。保存后会重新校验。</p><textarea id="draft-edit" rows="18"></textarea><button id="draft-save">保存并重新校验</button>';
          panel.appendChild(editor);
          editor.querySelector('#draft-edit').value=JSON.stringify({workflow:result.workflow,grounding:result.grounding||[],missing:result.missing||[]},null,2);
          editor.querySelector('#draft-save').addEventListener('click',function() {
            try {var revised=JSON.parse(editor.querySelector('#draft-edit').value);
              post('/v1/workflow-drafts/revise',{id:d.id,draft:revised}).then(renderOrganization).catch(reportError);
            }catch(error){reportError(error);}
          });
        }
        var approve=panel.querySelector('#draft-approve');if(approve)approve.addEventListener('click',function() {
          post('/v1/workflow-drafts/approve',{id:d.id}).then(renderOrganization).catch(reportError);
        });
      }).catch(reportError);
    }); });
  });
}
function renderMaintenance() {
  return post('/v1/maintenance/status', {}).then(function (data) {
    var rows = (data.jobs || []).map(function (job) {
      return '<tr><td>' + esc(job.kind) + '</td><td>' + esc(job.status) + '</td><td>' + esc(job.attempts) + '</td><td>' + esc(job.error || '—') + '</td><td><button class="job-retry" data-id="' + esc(job.id) + '">重试</button></td></tr>';
    }).join('');
    panel.innerHTML = '<h2>后台任务</h2><p class="muted">模型分析、文档导出与版本通知的持久记录。awaiting_model 表示模型尚未完成分析。</p>' +
      '<table><thead><tr><th>类型</th><th>状态</th><th>尝试次数</th><th>等待或失败原因</th></tr></thead><tbody>' + rows + '</tbody></table>';
    panel.querySelectorAll('.job-retry').forEach(function (button) {
      button.addEventListener('click', function () {
        post('/v1/maintenance/retry', { id: button.dataset.id }).then(renderMaintenance).catch(reportError);
      });
    });
  });
}
var RENDERERS = {
  organization: renderOrganization,
  maintenance: renderMaintenance,
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
  // Returned so a caller can chain after the view has rendered (e.g. the manage
  // table's "历史" button jumps to the history tab and then fills the query).
  return ensureIdentity()
    .then(function () { return renderer(); })
    .then(function () { setConnection(true); }, reportError);
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

  if (target.id === 'err-retry-btn' || target.id === 'doctor-reconnect') {
    show(tabs.querySelector('.tab--active') ? tabs.querySelector('.tab--active').dataset.view : 'status');
    return;
  }

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
    currentEditingEntry = null;
    return;
  }

  if (target.id === 'u-editor-save') {
    var id = (document.getElementById('ed-id') || {}).value;
    var title = (document.getElementById('ed-title') || {}).value;
    var kind = (document.getElementById('ed-kind') || {}).value;
    var body = (document.getElementById('ed-body') || {}).value;
    var scopeKind = (document.getElementById('ed-scope') || {}).value;
    var isEdit = target.dataset.edit === '1' && currentEditingEntry !== null;

    if (!id || !title || !body) { alert('ID、标题与正文均为必填项！'); return; }

    var entry;
    if (isEdit && currentEditingEntry) {
      // Preserve existing metadata to prevent erasure of labels, platforms, provenance or kind structures
      var original = currentEditingEntry.rawContent || currentEditingEntry.content || {};
      entry = Object.assign({}, original);
      entry.id = currentEditingEntry.id;
      entry.kind = original.kind || kind;
      entry.title = title.trim();
      entry.baseRevision = currentEditingEntry.revision;
      entry.labels = Array.isArray(original.labels) ? original.labels : [];
      entry.provenance = original.provenance || 'user';
      entry.evidence = (original.evidence && original.evidence !== 'verified') ? original.evidence : 'verifiable';
      entry.platforms = Array.isArray(original.platforms) ? original.platforms : [];
      if (scopeKind === 'global') {
        entry.scope = { kind: 'global' };
      } else {
        entry.scope = (original.scope && original.scope.kind === 'project')
          ? original.scope
          : { kind: 'project', projectId: getProject() };
      }

      if (entry.kind === 'norm') {
        entry.body = body.trim();
        entry.deniedTools = Array.isArray(original.deniedTools) ? original.deniedTools : [];
        entry.hostProvided = Boolean(original.hostProvided);
      } else if (entry.kind === 'preference') {
        entry.body = body.trim();
        entry.stated = original.stated !== undefined ? original.stated : true;
      } else if (entry.kind === 'skill') {
        entry.body = body.trim();
        entry.leaves = Array.isArray(original.leaves) ? original.leaves : [];
        entry.needsStructure = original.needsStructure !== undefined ? original.needsStructure : true;
      } else if (entry.kind === 'journal') {
        entry.did = body.trim();
        entry.problems = original.problems || '';
        entry.experienceLanded = Array.isArray(original.experienceLanded) ? original.experienceLanded : [];
        entry.outcome = original.outcome || 'unverified';
        entry.unfinished = Array.isArray(original.unfinished) ? original.unfinished : [];
      } else if (entry.kind === 'workflow') {
        entry.overview = body.trim();
      } else if (entry.kind === 'material') {
        entry.body = body.trim();
      } else {
        entry.body = body.trim();
      }
    } else {
      var scope = scopeKind === 'global' ? { kind: 'global' } : { kind: 'project', projectId: getProject() };
      entry = {
        id: id.trim(),
        kind: kind,
        title: title.trim(),
        scope: scope,
        baseRevision: 0,
        labels: [],
        provenance: 'user',
        evidence: 'verifiable',
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
      } else if (kind === 'journal') {
        entry.did = body.trim();
        entry.problems = '';
        entry.experienceLanded = [];
        entry.outcome = 'unverified';
        entry.unfinished = [];
      } else {
        entry.body = body.trim();
      }
    }

    post('/v1/knowledge/write', { entry: entry }).then(function (res) {
      alert('保存成功！' + (res.note || ''));
      currentEditingEntry = null;
      // F02: the header's version must move with the data, not only when the
      // status tab is opened.
      refreshHeader().catch(function () {});
      renderManage();
    }).catch(reportError);
    return;
  }

  if (target.classList.contains('u-edit-btn')) {
    var editId = target.dataset.id;
    post('/v1/knowledge/get', { id: editId }).then(function (res) {
      currentEditingEntry = { id: res.id, revision: res.revision, content: res.content };
      showEditor(currentEditingEntry);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }).catch(reportError);
    return;
  }

  if (target.classList.contains('u-history-btn')) {
    // Reuse the history tab's single-query flow: jump there and prefill the id.
    show('history').then(function () {
      var input = document.getElementById('hist-id-input');
      if (input) { input.value = target.dataset.id; }
      var btn = document.getElementById('hist-query-btn');
      if (btn) btn.click();
    });
    return;
  }

  if (target.classList.contains('u-delete-btn')) {
    var delId = target.dataset.id;
    var delRev = Number(target.dataset.rev || 0);
    if (!confirm('确定退役删除条目 ' + delId + '？历史版本将完整保留可追溯。')) return;
    post('/v1/knowledge/delete', { id: delId, baseRevision: delRev }).then(function () {
      alert('条目已成功删除！');
      refreshHeader().catch(function () {});
      renderManage();
    }).catch(reportError);
    return;
  }

  // Proposals single actions
  if (target.classList.contains('action-approve')) {
    showProposalEditor(target.dataset.id);
    return;
  }

  if (target.id === 'pe-cancel') {
    var peBox = document.getElementById('prop-editor-box');
    if (peBox) peBox.innerHTML = '';
    return;
  }

  if (target.id === 'pe-approve') {
    approveProposalForm(target.dataset.id).catch(function (error) {
      alert((error && (error.friendlyMessage || error.message)) || '批准失败');
    });
    return;
  }

  if (target.classList.contains('action-reopen')) {
    post('/v1/proposals/reopen', { id: target.dataset.id }).then(function () {
      alert('候选已回到待审队列，可重新审阅。');
      renderProposals('pending');
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
    // Inline required-reason form instead of window.prompt() (F01's environment).
    var evBox = document.getElementById('prop-editor-box');
    if (evBox) {
      evBox.innerHTML = '<div class="editor-card">' +
        '<div class="card__head" style="margin-bottom:10px;"><span class="card__title">要求补证：' + esc(target.dataset.id) + '</span>' +
        '<button class="ghost btn-sm" id="pe-cancel">取消</button></div>' +
        '<div class="form-group"><label>需要补充的证据要求（必填）</label>' +
        '<textarea id="req-evidence-reason" rows="3">缺少实际命令运行输出或独立测试验证产物</textarea></div>' +
        '<button class="primary" id="req-evidence-submit" data-id="' + esc(target.dataset.id) + '">提交补证要求</button>' +
        '</div>';
    }
    return;
  }

  if (target.id === 'req-evidence-submit') {
    var evReason = ((document.getElementById('req-evidence-reason') || {}).value || '').trim();
    if (!evReason) { alert('补证要求为必填项。'); return; }
    post('/v1/proposals/request-evidence', { id: target.dataset.id, reason: evReason }).then(function () {
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

  if (target.id === 'batch-approve') {
    var approveIds = getCheckedIds();
    if (!approveIds.length) { alert('请先勾选要批量批准的候选！'); return; }
    if (!confirm('确定批量批准选中的 ' + approveIds.length + ' 条候选？\\n关联流程的候选将按各自目标流程生成新 revision。')) return;
    /**
     * Resolve each candidate's own target before approving.
     *
     * A single hand-written memory entry per id (the previous behaviour) is
     * exactly the shape F01 rejects: it turns a workflow candidate into an
     * unrelated memory, and the core refuses it with target_mismatch. Each id is
     * therefore read back and given the entry its target actually requires.
     */
    Promise.all(approveIds.map(function (id) {
      return post('/v1/proposals/get', { id: id }).then(function (detail) {
        return { id: id, built: programmaticApproval(detail) };
      });
    })).then(function (resolved) {
      var entriesMap = {};
      resolved.forEach(function (item) { entriesMap[item.id] = item.built.entry; });
      return post('/v1/proposals/batch', {
        action: 'approve',
        ids: approveIds,
        entries: entriesMap
      });
    }).then(function (res) {
      return refreshHeader().then(function () {
        if (res.failed && res.failed.length) {
          alert('部分候选批准未完成（' + res.failed.length + ' 条）：\\n' +
            res.failed.map(function (f) { return f.id + ': ' + f.reason; }).join('\\n'));
        } else {
          alert('选中的 ' + approveIds.length + ' 条候选已全部批准入库！');
        }
        renderProposals('pending');
      });
    }).catch(reportError);
    return;
  }

  if (target.id === 'batch-reject') {
    var rejectIds = getCheckedIds();
    if (!rejectIds.length) { alert('请先勾选要批量拒收的候选！'); return; }
    if (!confirm('确定批量拒收选中的 ' + rejectIds.length + ' 条候选？')) return;
    post('/v1/proposals/batch', { action: 'reject', ids: rejectIds }).then(function (res) {
      if (res.failed && res.failed.length) {
        alert('部分候选拒收未完成（' + res.failed.length + ' 条）：\\n' +
          res.failed.map(function (f) { return f.id + ': ' + f.reason; }).join('\\n'));
      }
      renderProposals('pending');
    }).catch(reportError);
    return;
  }

  if (target.id === 'batch-archive') {
    var arcIds = getCheckedIds();
    if (!arcIds.length) { alert('请先勾选要批量归档的候选！'); return; }
    post('/v1/proposals/batch', { action: 'archive', ids: arcIds }).then(function (res) {
      if (res.failed && res.failed.length) {
        alert('部分候选归档未完成（' + res.failed.length + ' 条）：\\n' +
          res.failed.map(function (f) { return f.id + ': ' + f.reason; }).join('\\n'));
      }
      renderProposals('pending');
    }).catch(reportError);
    return;
  }

  if (target.id === 'batch-evidence') {
    var evIds = getCheckedIds();
    if (!evIds.length) { alert('请先勾选要要求补证的候选！'); return; }
    var evBatchBox = document.getElementById('prop-editor-box');
    if (evBatchBox) {
      evBatchBox.innerHTML = '<div class="editor-card">' +
        '<div class="card__head" style="margin-bottom:10px;"><span class="card__title">批量要求补证（' + evIds.length + ' 条）</span>' +
        '<button class="ghost btn-sm" id="pe-cancel">取消</button></div>' +
        '<div class="form-group"><label>统一补证要求（必填）</label>' +
        '<textarea id="req-evidence-batch-reason" rows="3">需补充验证输出，30天未补证将自动归档</textarea></div>' +
        '<button class="primary" id="req-evidence-batch-submit">提交补证要求</button>' +
        '</div>';
    }
    return;
  }

  if (target.id === 'req-evidence-batch-submit') {
    var batchReason = ((document.getElementById('req-evidence-batch-reason') || {}).value || '').trim();
    var batchIds = getCheckedIds();
    if (!batchReason) { alert('补证要求为必填项。'); return; }
    if (!batchIds.length) { alert('请先勾选要要求补证的候选！'); return; }
    post('/v1/proposals/batch', { action: 'request-evidence', ids: batchIds, reason: batchReason }).then(function (res) {
      if (res.failed && res.failed.length) {
        alert('部分候选要求补证未完成（' + res.failed.length + ' 条）：\\n' +
          res.failed.map(function (f) { return f.id + ': ' + f.reason; }).join('\\n'));
      }
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
      window.__ambExport = { filename: target.dataset.id + '.md', text: res.markdown || '', mime: 'text/markdown;charset=utf-8' };
      var box = document.getElementById('task-detail-box');
      if (box) box.innerHTML = '<div class="card"><div class="card__head"><span class="card__title">Markdown 预览（可下载）</span>' +
        '<button class="primary btn-sm" id="export-download">下载 .md 文件</button></div>' +
        '<div class="pre-box">' + esc(res.markdown || '') + '</div>' +
        '<p class="muted" style="font-size:12px;">预览中的时间为 UTC；页面其它处时间为本地时间（含偏移）。</p></div>';
    }).catch(reportError);
    return;
  }

  if (target.classList.contains('task-export-json')) {
    post('/v1/tasks/export', { taskId: target.dataset.id, format: 'json' }).then(function (res) {
      var pretty = JSON.stringify(res.task || {}, null, 2);
      window.__ambExport = { filename: target.dataset.id + '.json', text: pretty, mime: 'application/json;charset=utf-8' };
      var box = document.getElementById('task-detail-box');
      if (box) box.innerHTML = '<div class="card"><div class="card__head"><span class="card__title">JSON 预览（可下载）</span>' +
        '<button class="primary btn-sm" id="export-download">下载 .json 文件</button></div>' +
        '<div class="pre-box">' + esc(pretty) + '</div></div>';
    }).catch(reportError);
    return;
  }

  if (target.id === 'export-download') {
    var payload = window.__ambExport;
    if (!payload) { alert('没有可下载的内容。'); return; }
    if (downloadText(payload.filename, payload.text, payload.mime)) {
      alert('已开始下载：' + payload.filename);
    } else {
      alert('当前浏览器不允许直接下载，请手动复制预览内容。');
    }
    return;
  }

  // Material actions
  if (target.classList.contains('material-renew')) {
    var matId = target.dataset.id;
    var matBox = document.getElementById('mat-form-box');
    if (!matBox) {
      var head = panel.querySelector('.toolbar');
      if (head) { matBox = document.createElement('div'); matBox.id = 'mat-form-box'; head.parentNode.insertBefore(matBox, head.nextSibling); }
    }
    if (matBox) {
      matBox.innerHTML = '<div class="editor-card">' +
        '<div class="card__head" style="margin-bottom:10px;"><span class="card__title">续期 90 天：' + esc(matId) + '</span>' +
        '<button class="ghost btn-sm" id="mat-renew-cancel">取消</button></div>' +
        '<div class="form-group"><label>续期的明确理由（必填）</label>' +
        '<textarea id="mat-renew-reason" rows="3">项目周期延长，该外部资料仍有参考价值</textarea></div>' +
        '<button class="primary" id="mat-renew-submit" data-id="' + esc(matId) + '">确认续期</button>' +
        '</div>';
    }
    return;
  }

  if (target.id === 'mat-renew-cancel') {
    var cancelBox = document.getElementById('mat-form-box');
    if (cancelBox) cancelBox.innerHTML = '';
    return;
  }

  if (target.id === 'mat-renew-submit') {
    var renewReason = ((document.getElementById('mat-renew-reason') || {}).value || '').trim();
    if (!renewReason) { alert('续期理由为必填项。'); return; }
    post('/v1/material/renew', { id: target.dataset.id, reason: renewReason }).then(function () {
      alert('续期成功！到期时间已延长 90 天。');
      renderMaterial();
    }).catch(reportError);
    return;
  }

  if (target.id === 'material-purge') {
    if (!confirm('确定清理所有已到期的临时资料？此操作将物理删除已过期的正文与索引。')) return;
    post('/v1/material/purge').then(function (res) {
      var purgedCount = res.purged ? res.purged.length : 0;
      var failedCount = res.failed ? res.failed.length : 0;
      var msg = '清理完成！已清理 ' + purgedCount + ' 条资料。';
      if (failedCount > 0) {
        msg += '\\n警告：' + failedCount + ' 条资料清理失败：\\n' +
          res.failed.map(function (f) { return f.id + ': ' + f.reason; }).join('\\n');
      }
      alert(msg);
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
      /**
       * Every revision is now readable in place (F09): each line carries a
       * read-only fetch that renders the old prose below, so the viewer never has
       * to treat the current-version guard as an obstacle to history.
       */
      var revs = (res.revisions || []).map(function (r) {
        var isCurrent = res.current && Number(res.current.revision) === Number(r.revision);
        return '<div style="margin:4px 0;">• <code>v' + esc(r.revision) + '</code>　' + esc(localTime(r.createdAt)) +
          (isCurrent ? '　<span class="pill pill--ok">当前版本</span>' : '') +
          '　<button class="ghost btn-sm hist-rev-btn" data-id="' + esc(kId.trim()) + '" data-rev="' + esc(r.revision) + '">只读查看此版本</button>' +
          '</div>';
      }).join('');
      hBox.innerHTML = '<div class="card"><div class="card__head"><span class="card__title">条目完整版本历史: ' + esc(kId) + '</span>' +
        '<span class="pill pill--ok">' + cur + '</span></div>' +
        '<div class="card__body">' + (revs || '无版本历史') + '</div>' +
        '<div id="hist-rev-body"></div></div>';
    }).catch(reportError);
    return;
  }

  if (target.classList.contains('hist-rev-btn')) {
    var hrId = target.dataset.id;
    var hrRev = Number(target.dataset.rev);
    post('/v1/knowledge/history/read', { id: hrId, revision: hrRev }).then(function (res) {
      var bodyBox = document.getElementById('hist-rev-body');
      if (!bodyBox) return;
      bodyBox.innerHTML = '<div class="pre-box">' +
        '【历史只读视图】' + esc(res.id) + ' @ v' + esc(res.revision) +
        (res.isCurrent ? '（当前版本）' : '（非当前版本，不可作为现行规范使用）') + '\\n' +
        '标题: ' + esc(res.title) + '\\n' +
        '范围: ' + esc(res.scope && res.scope.kind === 'global' ? '全局' : '项目 ' + (res.scope && res.scope.projectId ? res.scope.projectId : '')) + '\\n' +
        '来源: ' + esc(res.provenance) + '　证据等级: ' + esc(res.evidence) + '　创建: ' + esc(localTime(res.createdAt)) + '\\n\\n' +
        esc(res.body || '') + '</div>';
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
  panel.innerHTML = notice('缺少凭据。请用已安装插件的运行时执行 node runtime/cli.js ui --data-dir <数据目录>（源码目录则为 node dist/src/cli.js ui）生成带凭据的地址后打开；凭据保存在当前标签页会话存储（sessionStorage）中。') +
    '<div class="card"><div class="card__head"><span class="card__title">如何取得带凭据的地址</span></div>' +
    '<p class="card__body">在插件运行时目录（例如 <code>.dsh/plugins/agent-memory-backpack-test-20261013/runtime</code>）执行：<br>' +
    '<code>node cli.js ui --data-dir &lt;数据目录&gt;</code><br>' +
    '命令会打印一个包含凭据 fragment 的本地地址，用浏览器打开即可。数据目录即核心启动时使用的目录（与 core.json 同处）。</p></div>';
  setConnection(false);
} else {
  show('status');
}
`;
