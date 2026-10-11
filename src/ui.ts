/**
 * The management interface, served by the core itself.
 *
 * The design called for a local web page rather than a desktop application
 * ("不重复制造桌面壳"): a page needs no extra runtime, no installer, and no
 * window to keep alive — the core already runs, and the page is another thing it
 * serves. The Electron console required a separately downloaded binary, and on
 * this machine its GPU process exited before the window painted anything.
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
      <p class="sub">本地共享知识库</p>
    </div>
    <dl class="target">
      <div><dt>项目</dt><dd id="t-project">—</dd></div>
      <div><dt>知识版本</dt><dd id="t-revision">—</dd></div>
      <div><dt>状态</dt><dd id="t-connection" class="pill pill--idle">未连接</dd></div>
    </dl>
  </header>
  <nav class="tabs" id="tabs">
    <button class="tab tab--active" data-view="status">总览</button>
    <button class="tab" data-view="norms">规范</button>
    <button class="tab" data-view="proposals">候选审阅</button>
    <button class="tab" data-view="knowledge">技能与记忆</button>
    <button class="tab" data-view="tasks">任务</button>
    <button class="tab" data-view="doctor">自检</button>
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
 *
 * Dark, matching the desktop console so the two do not look like different
 * products. Colours follow `prefers-color-scheme`, so a light desktop is not
 * forced into a dark page.
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
.metrics { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.metric { background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  padding: 10px 14px; min-width: 110px; }
.metric__label { color: var(--muted); font-size: 11px; }
.metric__value { font-size: 20px; font-weight: 650; margin-top: 2px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  padding: 12px 14px; margin-bottom: 10px; }
.card__head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
.card__title { font-weight: 600; }
.card__meta { color: var(--muted); font-size: 11px; }
.card__body { margin: 8px 0 0; white-space: pre-wrap; word-break: break-word; }
.card__path { color: var(--muted); font-size: 11px; font-family: ui-monospace, Consolas, monospace; }
table { width: 100%; border-collapse: collapse; background: var(--panel);
  border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line);
  font-size: 13px; vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: 11px; }
tr:last-child td { border-bottom: none; }
code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
.pill { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 11px; }
.pill--ok { background: rgba(63,185,80,.16); color: var(--ok); }
.pill--warn { background: rgba(210,153,34,.16); color: var(--warn); }
.pill--fail { background: rgba(248,81,73,.16); color: var(--fail); }
.pill--skip, .pill--idle { background: rgba(152,162,179,.16); color: var(--muted); }
.notice { border-left: 3px solid var(--fail); background: rgba(248,81,73,.08);
  padding: 10px 12px; border-radius: 4px; margin-bottom: 12px; }
.notice--info { border-color: var(--muted); background: rgba(152,162,179,.08); }
.empty { color: var(--muted); padding: 24px 0; text-align: center; }
.toolbar { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
input[type=search] { flex: 1; min-width: 200px; background: var(--panel); color: var(--text);
  border: 1px solid var(--line); border-radius: 6px; padding: 7px 10px; font-family: inherit; font-size: 13px; }
button.primary { background: #2f6feb; color: #fff; border: 1px solid #2f6feb;
  border-radius: 6px; padding: 7px 14px; cursor: pointer; font-family: inherit; font-size: 13px; }
button.ghost { background: none; color: var(--text); border: 1px solid var(--line);
  border-radius: 6px; padding: 6px 12px; cursor: pointer; font-family: inherit; font-size: 13px; }
button:disabled { opacity: .5; cursor: default; }
.statusbar { display: flex; justify-content: space-between; align-items: center; gap: 12px;
  flex-wrap: wrap; margin-top: 18px; padding-top: 12px;
  border-top: 1px solid var(--line); color: var(--muted); font-size: 11px; }
`;

/**
 * Page script.
 *
 * Reads the credential from the URL fragment and keeps it in memory only — no
 * storage, so closing the tab ends the session and nothing is left behind on a
 * shared machine.
 */
export const UI_JS = `'use strict';
var panel = document.getElementById('panel');
var tabs = document.getElementById('tabs');

// The fragment is not sent to the server, so the credential never appears in its
// request log. It is cleared from the address bar immediately after reading, so
// it does not linger in a screenshot or a shared URL.
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

function post(path, body) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, 'x-amb-protocol': '1' },
    body: JSON.stringify(body || {}),
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
  return Promise.all([post('/v1/stats'), post('/v1/rescan/state')]).then(function (out) {
    var s = out[0], r = out[1];
    document.getElementById('t-project').textContent = s.projectId || '—';
    document.getElementById('t-revision').textContent = String(s.knowledgeRevision);
    panel.innerHTML = metrics([
      ['生效条目', s.entries], ['待审阅候选', s.pendingProposals],
      ['已采纳', s.adoptions], ['取代记录', s.supersessions], ['任务记录', s.tasks],
    ]) +
      '<div class="card"><div class="card__head"><span class="card__title">定期同步</span>' +
      '<span class="card__meta">' + (r.due ? '已到期' : '尚未到期') + '</span></div>' +
      '<p class="card__body">上次同步：' + esc(r.lastRescanAt ? new Date(r.lastRescanAt).toLocaleString() : '从未') +
      '　周期：' + esc(r.intervalMs ? Math.round(r.intervalMs / 3600000) + ' 小时' : '—') + '</p></div>' +
      notice('候选不会自动生效；推翻或补充经验必须附理由与证据，旧版本始终保留在历史中。', true);
  });
}

function renderNorms() {
  return post('/v1/norms').then(function (data) {
    var norms = (data.norms || []).filter(function (e) { return e.content && e.content.kind === 'norm'; });
    if (!norms.length) { panel.innerHTML = empty('没有生效中的规范。'); return; }
    panel.innerHTML = '<table><thead><tr><th>ID</th><th>标题</th><th>版本</th><th>来源</th></tr></thead><tbody>' +
      norms.map(function (e) {
        return '<tr><td><code>' + esc(e.id) + '</code></td><td>' + esc(e.content.title) +
          '</td><td><code>v' + esc(e.revision) + '</code></td><td>' +
          (e.content.hostProvided ? '<span class="pill pill--skip">宿主自行加载</span>' : '<span class="pill pill--ok">插件注入</span>') +
          '</td></tr>';
      }).join('') + '</tbody></table>';
  });
}

function renderProposals() {
  return post('/v1/proposals/list', { state: 'pending' }).then(function (data) {
    var items = data.proposals || [];
    if (!items.length) { panel.innerHTML = empty('没有待审阅的候选。'); return; }
    panel.innerHTML = items.map(function (item) {
      var payload = item.payload || {};
      return '<div class="card"><div class="card__head"><span class="card__title">' +
        esc(payload.discovery ? String(payload.discovery).slice(0, 80) : '(无描述)') +
        '</span><span class="pill pill--warn">待审阅</span></div>' +
        '<div class="card__meta">来源 ' + esc(item.principal) + '　提交 ' +
        esc(new Date(item.createdAt).toLocaleString()) + '</div>' +
        (payload.workflowId ? '<div class="card__path">关联流程 ' + esc(payload.workflowId) + '</div>' : '') +
        '<p class="card__body">' + esc(payload.discovery || '') + '</p></div>';
    }).join('') +
      notice('批准需要人工判断内容与证据；本页只做展示，批准请用控制台或 CLI，因为那一步要求管理凭据与明确决策。', true);
  });
}

function renderKnowledge(query) {
  var path = query ? '/v1/search' : '/v1/knowledge/unstructured';
  var body = query ? { query: query } : { limit: 200 };
  return post(path, body).then(function (data) {
    var items = data.workflows || data.skills || [];
    var head = '<div class="toolbar"><input type="search" id="k-query" placeholder="按关键词检索技能与记忆…" value="' +
      esc(query || '') + '"><button class="primary" id="k-go">检索</button></div>';
    if (!items.length) {
      panel.innerHTML = head + empty(query ? '没有匹配的条目。' : '知识库为空。先用 discover/adopt 同步本地已有知识。');
    } else {
      panel.innerHTML = head + '<table><thead><tr><th>标题</th><th>类型</th><th>规模</th><th>状态</th></tr></thead><tbody>' +
        items.map(function (item) {
          var kind = item.needsStructure === undefined && item.ready !== undefined ? '完整流程' : (item.kind === 'memory' ? '记忆' : '技能');
          var state = item.ready === false ? '<span class="pill pill--fail">依赖缺失</span>'
            : item.needsStructure ? '<span class="pill pill--warn">待结构化</span>'
            : '<span class="pill pill--ok">可用</span>';
          var size = item.leafCount !== undefined ? '参考 ' + item.leafCount + ' 份 / 正文 ' + item.chars + ' 字符'
            : (item.overview ? String(item.overview).slice(0, 60) : '—');
          return '<tr><td><div>' + esc(item.title) + '</div><div class="card__path">' + esc(item.id) + '</div></td>' +
            '<td>' + esc(kind) + '</td><td>' + esc(size) + '</td><td>' + state + '</td></tr>';
        }).join('') + '</tbody></table>';
    }
    var input = document.getElementById('k-query');
    var go = function () { renderKnowledge(input.value).catch(reportError); };
    document.getElementById('k-go').addEventListener('click', go);
    input.addEventListener('keydown', function (event) { if (event.key === 'Enter') go(); });
  });
}

function renderTasks() {
  return post('/v1/tasks/list').then(function (data) {
    var tasks = data.tasks || [];
    if (!tasks.length) { panel.innerHTML = empty('暂无任务记录。'); return; }
    var labels = { in_progress: ['进行中', 'warn'], paused: ['已暂停', 'skip'],
      completed: ['已完成', 'ok'], cancelled: ['已取消', 'skip'], failed: ['失败', 'fail'] };
    panel.innerHTML = '<table><thead><tr><th>任务</th><th>状态</th><th>摘要</th><th>更新时间</th></tr></thead><tbody>' +
      tasks.map(function (task) {
        var state = labels[task.status] || [task.status, 'skip'];
        return '<tr><td><div>' + esc(task.title) + '</div><div class="card__path">' + esc(task.id) + '</div></td>' +
          '<td><span class="pill pill--' + state[1] + '">' + esc(state[0]) + '</span></td>' +
          '<td>' + esc(task.summary || '—') + '</td><td><code>' +
          esc(new Date(task.updatedAt).toLocaleString()) + '</code></td></tr>';
      }).join('') + '</tbody></table>';
  });
}

function renderDoctor() {
  return post('/v1/stats').then(function (s) {
    // The self-check the CLI runs needs the data directory, which only the host
    // knows. What the page can confirm is what the core reports about itself.
    panel.innerHTML = metrics([['知识版本', s.knowledgeRevision], ['生效条目', s.entries],
      ['候选', s.pendingProposals], ['事件', s.events]]) +
      '<div class="card"><div class="card__head"><span class="card__title">核心可达</span>' +
      '<span class="pill pill--ok">正常</span></div><p class="card__body">本页由核心自身提供，' +
      '因此它能显示内容就说明核心在运行。完整的十一项自检请运行：' +
      'node dist/src/cli.js doctor</p></div>';
  });
}

function reportError(error) {
  setConnection(false);
  panel.innerHTML = notice(error && error.message ? error.message : '请求失败');
}

var RENDERERS = { status: renderStatus, norms: renderNorms, proposals: renderProposals,
  knowledge: function () { return renderKnowledge(''); }, tasks: renderTasks, doctor: renderDoctor };

function show(name) {
  var list = tabs.querySelectorAll('.tab');
  for (var i = 0; i < list.length; i += 1) {
    list[i].classList.toggle('tab--active', list[i].dataset.view === name);
  }
  panel.innerHTML = '<p class="muted">正在读取核心…</p>';
  RENDERERS[name]().then(function () { setConnection(true); }, reportError);
}

tabs.addEventListener('click', function (event) {
  var tab = event.target.closest ? event.target.closest('.tab') : null;
  if (tab) show(tab.dataset.view);
});
document.getElementById('refresh').addEventListener('click', function () {
  var active = tabs.querySelector('.tab--active');
  show(active ? active.dataset.view : 'status');
});

// A missing credential is the one failure the page can name precisely.
if (!token) {
  panel.innerHTML = notice('缺少凭据。请用 node dist/src/cli.js ui 生成带凭据的地址后打开。');
  setConnection(false);
} else {
  show('status');
}
`;
