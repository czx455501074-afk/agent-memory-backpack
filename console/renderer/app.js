// Renderer logic. No Node access: every data request goes through the narrow
// `window.amb` bridge installed by the preload script.

const panel = document.getElementById('panel');
const tabs = document.getElementById('tabs');

const escapeHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function notice(message, kind = 'fail') {
  return `<div class="notice${kind === 'info' ? ' notice--info' : ''}">${escapeHtml(message)}</div>`;
}

function empty(message) { return `<div class="empty">${escapeHtml(message)}</div>`; }

/** Run one named view and surface either the data or the error, never a blank screen. */
async function view(name, args) {
  const result = await window.amb.view(name, args);
  return result;
}

function metrics(pairs) {
  return `<div class="metrics">${pairs.map(([label, value]) => `
    <div class="metric"><div class="metric__label">${escapeHtml(label)}</div>
    <div class="metric__value">${escapeHtml(value)}</div></div>`).join('')}</div>`;
}

// --- views ------------------------------------------------------------------

async function renderStatus() {
  const [status, rescan] = await Promise.all([view('status'), view('rescanState')]);
  if (!status.ok) { panel.innerHTML = notice(status.error); setConnection(false); return; }
  setConnection(true);
  const data = status.data;
  const rescanData = rescan.ok ? rescan.data : {};
  panel.innerHTML = [
    metrics([
      ['知识版本', String(data.knowledgeRevision ?? '—')],
      ['生效条目', String(data.entries ?? '—')],
      ['待审阅候选', String(data.pendingProposals ?? '—')],
      ['已采纳', String(data.adoptions ?? '—')],
      ['取代记录', String(data.supersessions ?? '—')],
      ['任务记录', String(data.tasks ?? '—')],
    ]),
    `<div class="card"><div class="card__head"><span class="card__title">定期同步</span>
      <span class="card__meta">${escapeHtml(rescanData.due === true ? '已到期，等待本轮扫描' : '尚未到期')}</span></div>
      <p class="card__body">上次同步：${escapeHtml(rescanData.lastRescanAt ? new Date(rescanData.lastRescanAt).toLocaleString() : '从未')}
      　周期：${escapeHtml(rescanData.intervalMs ? Math.round(rescanData.intervalMs / 3600000) + ' 小时' : '—')}</p></div>`,
    `<div class="notice notice--info">候选不会自动生效；推翻或补充经验必须附理由与证据，旧版本始终保留在历史中。</div>`,
  ].join('');
  await refreshCounts();
}

async function renderProposals() {
  const result = await view('proposals');
  if (!result.ok) { panel.innerHTML = notice(result.error); return; }
  const items = result.data.proposals ?? [];
  if (!items.length) { panel.innerHTML = empty('没有待审阅的候选。'); return; }
  panel.innerHTML = items.map(item => {
    const payload = item.payload ?? {};
    return `<div class="card">
      <div class="card__head">
        <span class="card__title">${escapeHtml(payload.discovery ? payload.discovery.slice(0, 80) : '(无描述)')}</span>
        <span class="pill pill--warn">待审阅</span>
      </div>
      <div class="card__meta">来源 ${escapeHtml(item.principal)}　提交 ${escapeHtml(new Date(item.createdAt).toLocaleString())}</div>
      ${payload.workflowId ? `<div class="card__path">关联流程 ${escapeHtml(payload.workflowId)}@${escapeHtml(payload.baseRevision ?? '?')}</div>` : ''}
      <p class="card__body">${escapeHtml(payload.discovery ?? '')}</p>
    </div>`;
  }).join('');
}

async function renderNorms() {
  const result = await view('norms');
  if (!result.ok) { panel.innerHTML = notice(result.error); return; }
  const norms = (result.data.norms ?? []).filter(entry => entry.content?.kind === 'norm');
  if (!norms.length) { panel.innerHTML = empty('没有生效中的规范。'); return; }
  panel.innerHTML = `<table><thead><tr><th>ID</th><th>标题</th><th>版本</th><th>来源</th></tr></thead><tbody>${
    norms.map(entry => `<tr>
      <td><code>${escapeHtml(entry.id)}</code></td>
      <td>${escapeHtml(entry.content.title)}</td>
      <td><code>v${escapeHtml(entry.revision)}</code></td>
      <td>${entry.content.hostProvided ? '<span class="pill pill--skip">宿主自行加载</span>' : '<span class="pill pill--ok">插件注入</span>'}</td>
    </tr>`).join('')}</tbody></table>`;
}

async function renderUnstructured() {
  const result = await view('unstructured');
  if (!result.ok) { panel.innerHTML = notice(result.error); return; }
  const skills = result.data.skills ?? [];
  if (!skills.length) { panel.innerHTML = empty('没有待结构化的技能。'); return; }
  panel.innerHTML = [
    notice('这些技能保留原文，在完成结构化之前不会被当作已核实的完整方法。', 'info'),
    ...skills.map(skill => `<div class="card">
      <div class="card__head"><span class="card__title">${escapeHtml(skill.title)}</span>
      <span class="pill pill--warn">待结构化</span></div>
      <div class="card__meta">${escapeHtml(skill.id)}@${escapeHtml(skill.revision)}　参考文档 ${escapeHtml(skill.leafCount)} 个　正文 ${escapeHtml(skill.bodyChars)} 字符</div>
    </div>`),
  ].join('');
}

async function renderTasks() {
  const result = await view('tasks');
  if (!result.ok) { panel.innerHTML = notice(result.error); return; }
  const tasks = result.data.tasks ?? [];
  if (!tasks.length) { panel.innerHTML = empty('暂无任务记录。'); return; }
  const state = { in_progress: ['进行中', 'warn'], paused: ['已暂停', 'skip'], completed: ['已完成', 'ok'], cancelled: ['已取消', 'skip'], failed: ['失败', 'fail'] };
  panel.innerHTML = `<table><thead><tr><th>任务</th><th>状态</th><th>摘要</th><th>更新时间</th></tr></thead><tbody>${
    tasks.map(task => {
      const [label, tone] = state[task.status] ?? [task.status, 'skip'];
      return `<tr>
        <td><div>${escapeHtml(task.title)}</div><div class="card__path">${escapeHtml(task.id)}</div></td>
        <td><span class="pill pill--${tone}">${escapeHtml(label)}</span></td>
        <td>${escapeHtml(task.summary || '—')}</td>
        <td><code>${escapeHtml(new Date(task.updatedAt).toLocaleString())}</code></td>
      </tr>`;
    }).join('')}</tbody></table>`;
}

async function renderWorkflows(query = '') {
  const result = await view('workflows', { query });
  if (!result.ok) { panel.innerHTML = notice(result.error); return; }
  const workflows = result.data.workflows ?? [];
  panel.innerHTML = [
    `<div class="toolbar">
      <input type="search" id="wf-query" placeholder="按关键词检索完整流程…" value="${escapeHtml(query)}">
      <button class="primary" id="wf-go">检索</button>
    </div>`,
    workflows.length === 0 ? empty('没有匹配的完整流程。') : `<table><thead><tr><th>ID</th><th>标题</th><th>版本</th><th>状态</th></tr></thead><tbody>${
      workflows.map(flow => `<tr>
        <td><code>${escapeHtml(flow.id)}</code></td>
        <td><div>${escapeHtml(flow.title)}</div><div class="card__path">${escapeHtml(flow.overview ?? '')}</div></td>
        <td><code>v${escapeHtml(flow.revision)}</code></td>
        <td>${flow.ready ? '<span class="pill pill--ok">可用</span>' : `<span class="pill pill--fail">依赖缺失</span>`}</td>
      </tr>`).join('')}</tbody></table>`,
  ].join('');
  const input = document.getElementById('wf-query');
  const go = () => renderWorkflows(input.value);
  document.getElementById('wf-go').addEventListener('click', go);
  input.addEventListener('keydown', event => { if (event.key === 'Enter') go(); });
}

/**
 * Self-check panel.
 *
 * Mirrors `cli doctor` so a desktop user does not need a terminal to find out why
 * something is not working. The report is produced in the main process and the
 * token never appears in it, so rendering it here is safe.
 */
async function renderDoctor() {
  const result = await window.amb.doctor();
  if (!result.ok) { panel.innerHTML = notice(result.error); return; }
  const { data, summary } = result;
  const tone = { pass: 'ok', warn: 'warn', fail: 'fail', skip: 'skip' };
  const label = { pass: '通过', warn: '留意', fail: '失败', skip: '跳过' };
  const failures = data.checks.filter(c => c.status === 'fail').length;

  panel.innerHTML = [
    notice(
      data.ok
        ? `自检未发现阻塞问题。插件版本 ${result.pluginVersion}`
        : `自检发现 ${failures} 项阻塞问题，请按下面的建议处理。插件版本 ${result.pluginVersion}`,
      data.ok ? 'info' : 'fail',
    ),
    `<table><thead><tr><th>检查</th><th>结果</th><th>说明</th></tr></thead><tbody>${
      data.checks.map(check => `<tr>
        <td>${escapeHtml(check.title)}</td>
        <td><span class="pill pill--${tone[check.status] ?? 'skip'}">${escapeHtml(label[check.status] ?? check.status)}</span></td>
        <td><div>${escapeHtml(check.detail)}</div>${
          check.hint ? `<div class="card__path">建议：${escapeHtml(check.hint)}</div>` : ''
        }</td>
      </tr>`).join('')}</tbody></table>`,
    `<p class="card__path">${escapeHtml(summary)}</p>`,
  ].join('');
}

// --- Migration panel --------------------------------------------------------

async function renderMigrate() {
  panel.innerHTML = [
    notice('导出文件包含全部知识、历史版本与任务记录，不含任何凭据（凭据永不进入归档）。导入是合并式，不会删除本机数据。', 'info'),
    `<div class="card">
      <div class="card__head"><span class="card__title">导出全部数据</span></div>
      <p class="card__body">导出当前所有知识、版本历史、任务与候选队列为单个归档文件，可在另一台设备导入。</p>
      <div class="toolbar"><button class="primary" id="migrate-export">导出全部数据</button></div>
      <div id="export-result"></div>
    </div>`,
    `<div class="card">
      <div class="card__head"><span class="card__title">从文件导入</span></div>
      <p class="card__body">选择一个 .ambpack 归档文件，检查其内容后确认导入。导入只增不删，本地更新或分叉的内容不会被覆盖。</p>
      <div class="toolbar"><button class="primary" id="migrate-inspect">从文件导入</button></div>
      <div id="import-inspect"></div>
      <div id="import-confirm" style="display:none;">
        <div class="toolbar"><button class="primary" id="migrate-import">确认导入</button></div>
      </div>
      <div id="import-result"></div>
    </div>`,
  ].join('');

  document.getElementById('migrate-export').addEventListener('click', async () => {
    const btn = document.getElementById('migrate-export');
    const resultNode = document.getElementById('export-result');
    btn.disabled = true;
    resultNode.innerHTML = '<p class="card__body">正在导出…</p>';
    try {
      const result = await window.amb.backupExport();
      if (!result.ok) {
        // A failed core call is evidence the core is not talking to us, so the
        // header must stop claiming "已连接". Previously only the status panel
        // ever updated that indicator, so a user who stopped the core and then
        // used this panel saw a stale "connected" while every action failed.
        setConnection(false);
        resultNode.innerHTML = notice(result.error);
        return;
      }
      // Cancelling is not a connection outcome, so it must be handled before the
      // indicator is touched; otherwise cancelling a dialog would report the core
      // as reachable when no request was ever sent.
      if (result.data.canceled) {
        resultNode.innerHTML = '<p class="card__body">已取消。</p>';
        return;
      }
      setConnection(true);
      const data = result.data;
      const bytes = data.bytes && data.bytes > 0 ? formatBytes(data.bytes) : '未知大小';
      const counts = data.counts || {};
      // Say when an existing file was replaced: the user answered a confirmation
      // dialog, and a silent overwrite would look identical to a first export.
      const replaced = data.replaced === true
        ? '<div class="notice notice--info" style="margin-top:10px;">已替换同名的既有归档（你在保存对话框里确认过）。</div>'
        : '';
      resultNode.innerHTML = `
        <div class="card__meta" style="margin-top:10px;">导出完成</div>
        <p class="card__path">${escapeHtml(data.file)}</p>
        <p class="card__body">文件大小：${escapeHtml(bytes)}　条目：知识 ${escapeHtml(counts.knowledge || 0)}、版本 ${escapeHtml(counts.revisions || 0)}、任务 ${escapeHtml(counts.tasks || 0)}、候选 ${escapeHtml(counts.proposals || 0)}</p>
        ${replaced}
        <div class="toolbar"><button class="ghost" id="reveal-export">打开所在文件夹</button></div>
      `;
      document.getElementById('reveal-export').addEventListener('click', async () => {
        const r = await window.amb.revealExport();
        if (!r.ok) resultNode.innerHTML += notice(r.error);
      });
    } catch (error) {
      setConnection(false);
      resultNode.innerHTML = notice(error instanceof Error ? error.message : '导出失败');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('migrate-inspect').addEventListener('click', async () => {
    const btn = document.getElementById('migrate-inspect');
    const inspectNode = document.getElementById('import-inspect');
    const confirmNode = document.getElementById('import-confirm');
    const resultNode = document.getElementById('import-result');
    btn.disabled = true;
    inspectNode.innerHTML = '<p class="card__body">正在读取归档…</p>';
    confirmNode.style.display = 'none';
    resultNode.innerHTML = '';
    try {
      const result = await window.amb.backupInspect();
      if (!result.ok) {
        setConnection(false);
        inspectNode.innerHTML = notice(result.error);
        return;
      }
      if (result.data.canceled) {
        inspectNode.innerHTML = '<p class="card__body">已取消。</p>';
        return;
      }
      const data = result.data;
      const counts = data.counts || {};
      const bytes = data.bytes && data.bytes > 0 ? formatBytes(data.bytes) : '未知';
      const exported = data.exportedAt ? new Date(data.exportedAt).toLocaleString() : '未知';
      inspectNode.innerHTML = `
        <div class="card__meta" style="margin-top:10px;">归档内容</div>
        <p class="card__path">${escapeHtml(data.file)}</p>
        <p class="card__body">导出时间：${escapeHtml(exported)}　格式版本：${escapeHtml(data.version)}　文件大小：${escapeHtml(bytes)}</p>
        <p class="card__body">包含条目：知识 ${escapeHtml(counts.knowledge || 0)}、版本 ${escapeHtml(counts.revisions || 0)}、任务 ${escapeHtml(counts.tasks || 0)}、候选 ${escapeHtml(counts.proposals || 0)}</p>
      `;
      confirmNode.style.display = 'block';
      setConnection(true);
    } catch (error) {
      setConnection(false);
      inspectNode.innerHTML = notice(error instanceof Error ? error.message : '读取归档失败');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('migrate-import').addEventListener('click', async () => {
    const btn = document.getElementById('migrate-import');
    const resultNode = document.getElementById('import-result');
    btn.disabled = true;
    resultNode.innerHTML = '<p class="card__body">正在导入…</p>';
    try {
      const result = await window.amb.backupImport();
      if (!result.ok) {
        setConnection(false);
        resultNode.innerHTML = notice(result.error);
        return;
      }
      setConnection(true);
      const data = result.data;
      // `conflicts` is always stated exactly once, including the empty case.
      //
      // Hiding it when empty made the panel silently omit one of the three
      // numbers the migration flow is supposed to report, so a user could not
      // tell "no conflicts" from "this build does not check conflicts". Stating
      // it in a separate line *and* in the empty-case paragraph printed the zero
      // twice, so the count lives in the branch that already needs to say it.
      const conflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
      const conflictReport = conflicts.length > 0
        ? `<p class="card__body">冲突条目：${escapeHtml(conflicts.length)}（本地版本更新或分叉，已保留本地，未覆盖）</p>`
          + `<ul style="margin:0;padding-left:20px;font-size:12px;">${conflicts.map(c => `<li><code>${escapeHtml(c.id)}</code>：${escapeHtml(c.reason)}</li>`).join('')}</ul>`
        : '<p class="card__body">冲突条目：0（本机没有更新或分叉的同名内容）</p>';
      // `skipped` counts rows across every table, not just knowledge entries, so
      // labelling it "已存在或冲突" overstated what the number means: importing an
      // archive into the very library it came from skips every bookkeeping row
      // and reports a large number while nothing about the knowledge changed.
      resultNode.innerHTML = `
        <div class="card__meta" style="margin-top:10px;">导入完成</div>
        <p class="card__body">新增知识条目：${escapeHtml(data.imported ?? 0)}　跳过条目：${escapeHtml(data.skipped ?? 0)}（重复或已存在，含历史与登记表）</p>
        ${conflictReport}
        <div class="notice notice--info" style="margin-top:10px;">导入是合并式：只新增，不删除。本机已有的、更新的、分叉的内容不会被覆盖。</div>
      `;
      document.getElementById('import-confirm').style.display = 'none';
    } catch (error) {
      resultNode.innerHTML = notice(error instanceof Error ? error.message : '导入失败');
    } finally {
      btn.disabled = false;
    }
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// --- shell ------------------------------------------------------------------

function setConnection(connected) {
  const node = document.getElementById('target-connection');
  node.textContent = connected ? '已连接' : '无法连接';
  node.className = `pill ${connected ? 'pill--ok' : 'pill--fail'}`;
}

async function refreshCounts() {
  const [proposals, unstructured, doctorReport] = await Promise.all([
    view('proposals'), view('unstructured'), window.amb.doctor(),
  ]);
  document.getElementById('count-proposals').textContent = proposals.ok ? String((proposals.data.proposals ?? []).length) : '';
  document.getElementById('count-unstructured').textContent = unstructured.ok ? String((unstructured.data.skills ?? []).length) : '';
  // The badge shows blocking problems only, so a clean check shows nothing.
  const failures = doctorReport.ok
    ? (doctorReport.data.checks ?? []).filter(c => c.status === 'fail').length
    : 1;
  document.getElementById('count-doctor').textContent = failures > 0 ? String(failures) : '';
}

const RENDERERS = {
  status: renderStatus,
  proposals: renderProposals,
  norms: renderNorms,
  unstructured: renderUnstructured,
  tasks: renderTasks,
  workflows: renderWorkflows,
  doctor: renderDoctor,
  migrate: renderMigrate,
};

async function show(viewName) {
  for (const tab of tabs.querySelectorAll('.tab')) {
    tab.classList.toggle('tab--active', tab.dataset.view === viewName);
  }
  panel.innerHTML = '<div class="placeholder">正在读取核心…</div>';
  try {
    await RENDERERS[viewName]();
  } catch (error) {
    panel.innerHTML = notice(error instanceof Error ? error.message : '渲染失败');
    setConnection(false);
  }
}

tabs.addEventListener('click', event => {
  const tab = event.target.closest('.tab');
  if (tab) show(tab.dataset.view);
});

document.getElementById('refresh').addEventListener('click', () => {
  const active = tabs.querySelector('.tab--active');
  show(active ? active.dataset.view : 'status');
});

async function boot() {
  const target = await window.amb.target();
  document.getElementById('target-project').textContent = target.projectId;
  document.getElementById('target-adapter').textContent = target.adapter;
  document.getElementById('target-endpoint').textContent = target.endpoint;
  await show('status');
}

boot();
