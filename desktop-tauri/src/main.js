// Renderer for the desktop shell.
//
// There is no bundler here: `frontendDist` points straight at this directory, so
// a bare specifier such as `@tauri-apps/api/core` cannot be resolved by the
// webview. `withGlobalTauri: true` in tauri.conf.json injects `window.__TAURI__`,
// and that is what this file uses.

const tauri = window.__TAURI__;
const invoke = tauri && tauri.core ? tauri.core.invoke : null;

const el = (id) => document.getElementById(id);

const coreDot = el('core-dot');
const coreState = el('core-state');
const coreNote = el('core-note');
const actionNote = el('action-note');
const autoLaunchBox = el('auto-launch');
const autoLaunchNote = el('auto-launch-note');
const logList = el('log');

/** Timestamp for the event list. */
function stamp() {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function log(message, tone) {
    if (!logList) return;
    const item = document.createElement('li');
    const time = document.createElement('span');
    time.className = 'log__time';
    time.textContent = stamp();
    const text = document.createElement('span');
    text.textContent = message;
    if (tone) text.dataset.tone = tone;
    item.append(time, text);
    logList.prepend(item);
    while (logList.children.length > 60) logList.lastElementChild.remove();
}

/** Turns a raw value into something a metric card can show. */
function metric(id, value) {
    const node = el(id);
    if (!node) return;
    node.textContent = value === undefined || value === null || value === '' ? '—' : String(value);
}

function localTime(ms, fallback) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return fallback || '—';
    return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function setCoreState(state, text) {
    if (coreDot) coreDot.dataset.state = state;
    if (coreState) coreState.textContent = text;
}

function setNote(node, text, tone) {
    if (!node) return;
    node.textContent = text;
    if (tone) node.dataset.tone = tone;
    else delete node.dataset.tone;
}

/** Unwraps a `BridgeResponse`: `{ok, data}` on success, `{ok:false, code, error}` on failure. */
function payload(entry) {
    if (!entry || entry.ok !== true) return null;
    return entry.data === undefined ? null : entry.data;
}

function failureCode(entry) {
    if (!entry || entry.ok !== false) return null;
    return entry.code || 'core_error';
}

function setBusy(busy) {
    for (const id of ['btn-refresh', 'btn-doctor']) {
        const button = el(id);
        if (button) button.disabled = busy;
    }
}

/** `/v1/stats` carries every counter shown above; field names come from src/server.ts. */
function renderStats(entry) {
    const stats = payload(entry);
    if (!stats) {
        for (const id of ['m-revision', 'm-entries', 'm-pending', 'm-tasks', 'm-outbox', 'm-rescan']) {
            metric(id, null);
        }
        const code = failureCode(entry);
        setNote(coreNote, code
            ? `无法读取核心状态：${code}。核心未启动、凭据缺失或未授权时会这样。`
            : '无法读取核心状态。', 'bad');
        setCoreState('bad', code ? `核心未连接 (${code})` : '核心未连接');
        return;
    }

    metric('m-revision', stats.knowledgeRevision === undefined ? null : `v${stats.knowledgeRevision}`);
    metric('m-entries', stats.entries);
    metric('m-pending', stats.pendingProposals);
    metric('m-tasks', stats.tasks);
    metric('m-rescan', localTime(stats.lastRescanAt));

    const outbox = stats.outbox || null;
    metric('m-outbox', outbox
        ? `${outbox.pending || 0} 待发 / ${outbox.failed || 0} 失败 / ${outbox.abandoned || 0} 放弃`
        : null);

    const pending = Number(stats.pendingProposals || 0);
    setNote(coreNote, pending > 0
        ? `核心已连接；有 ${pending} 条候选等待审阅（候选不会自动生效）。`
        : '核心已连接；当前没有待审候选。', pending > 0 ? 'warn' : 'ok');
    setCoreState('ok', '核心已连接');
}

function renderTarget(target) {
    if (!target) return;
    el('f-endpoint').textContent = target.endpoint || '—';
    el('f-project').textContent = target.projectId || '—';
    el('f-role').textContent = target.role || target.adapter || '—';
}

async function refresh() {
    if (!invoke) return;
    setBusy(true);
    try {
        const overview = await invoke('core_overview');
        const data = payload(overview);
        if (!data) {
            const code = failureCode(overview) || 'unknown';
            setCoreState('bad', `凭据不可用 (${code})`);
            setNote(coreNote, code === 'configuration'
                ? '读取不到凭据配置：请确认 ~/.agent-memory-backpack/admin-client.json 存在，或用 AMB_CONSOLE_CONFIG / AMB_CONFIG 指定路径。'
                : `核心概览请求失败：${code}`, 'bad');
            log(`核心概览失败：${code}`, 'bad');
            return;
        }
        renderTarget(data.target);
        renderStats(data.stats);
        const taskList = payload(data.tasks);
        const taskCount = taskList && Array.isArray(taskList.tasks) ? taskList.tasks.length : null;
        const rescan = payload(data.rescan);
        log(`状态已刷新（任务 ${taskCount === null ? '—' : taskCount} 条；扫描到期：${rescan && rescan.due ? '是' : '否'}）`);
    } catch (error) {
        setCoreState('bad', '核心概览异常');
        log(`核心概览异常：${error}`, 'bad');
    } finally {
        setBusy(false);
    }
}

async function runDoctor() {
    if (!invoke) return;
    setBusy(true);
    try {
        const response = await invoke('doctor');
        const data = payload(response);
        if (!data) {
            log(`检查失败：${failureCode(response) || 'unknown'}`, 'bad');
            return;
        }
        const checks = Array.isArray(data.checks) ? data.checks : [];
        for (const check of checks) {
            log(`[${check.status}] ${check.title} — ${check.detail}`, check.status === 'pass' ? 'ok' : 'warn');
        }
        if (data.coverage) log(`检查覆盖范围：${data.coverage}`);
    } catch (error) {
        log(`检查异常：${error}`, 'bad');
    } finally {
        setBusy(false);
    }
}

/** Reads the real login-item state; the checkbox is never set from a guess. */
async function loadAutoLaunch() {
    if (!invoke || !autoLaunchBox) return;
    try {
        const response = await invoke('auto_launch_status');
        const data = payload(response);
        if (!data) {
            autoLaunchBox.checked = false;
            autoLaunchBox.disabled = true;
            setNote(autoLaunchNote, `读取开机自启状态失败：${failureCode(response) || 'unknown'}`, 'bad');
            return;
        }
        autoLaunchBox.checked = data.enabled === true;
        autoLaunchBox.disabled = false;
        setNote(autoLaunchNote, data.enabled
            ? '开机自启已注册（由系统登录项控制）。'
            : '开机自启未注册。');
    } catch (error) {
        autoLaunchBox.disabled = true;
        setNote(autoLaunchNote, `读取开机自启状态异常：${error}`, 'bad');
    }
}

async function applyAutoLaunch(next) {
    if (!invoke || !autoLaunchBox) return;
    autoLaunchBox.disabled = true;
    try {
        const response = await invoke('set_auto_launch', { enabled: next });
        const data = payload(response);
        if (!data) {
            const code = failureCode(response) || 'unknown';
            log(`切换开机自启失败：${code}`, 'bad');
            setNote(autoLaunchNote, `切换失败：${code}`, 'bad');
        } else {
            log(data.enabled ? '已启用开机自启' : '已禁用开机自启');
        }
    } catch (error) {
        log(`切换开机自启异常：${error}`, 'bad');
    } finally {
        // Always re-read: the OS is the source of truth, not the click.
        await loadAutoLaunch();
        autoLaunchBox.disabled = false;
    }
}

function wireButtons() {
    const refreshButton = el('btn-refresh');
    if (refreshButton) refreshButton.addEventListener('click', () => void refresh());

    const doctorButton = el('btn-doctor');
    if (doctorButton) doctorButton.addEventListener('click', () => void runDoctor());

    const hideButton = el('btn-hide');
    if (hideButton) {
        hideButton.addEventListener('click', () => {
            log('隐藏到托盘（进程仍在运行）');
            void invoke('window_action', { action: 'hide' });
        });
    }

    const quitButton = el('btn-quit');
    if (quitButton) {
        quitButton.addEventListener('click', () => {
            void invoke('window_action', { action: 'quit' });
        });
    }

    if (autoLaunchBox) {
        autoLaunchBox.addEventListener('change', () => {
            void applyAutoLaunch(autoLaunchBox.checked);
        });
    }
}

function wireEvents() {
    if (!tauri || !tauri.event || typeof tauri.event.listen !== 'function') return;
    // Emitted by the tray's "检查核心连接" and by its auto-launch toggle.
    void tauri.event.listen('amb-core-probe', (event) => {
        log(`托盘探针：${event.payload}`);
        void refresh();
    });
    void tauri.event.listen('amb-auto-launch-changed', (event) => {
        log(`托盘切换了开机自启：${event.payload === true ? '已启用' : '已禁用'}`);
        void loadAutoLaunch();
    });
}

async function bootstrap() {
    if (!invoke) {
        setCoreState('bad', '未连接桌面运行时');
        setNote(coreNote, 'window.__TAURI__ 不存在：此页面只在 Tauri 窗口内可用（请通过 npm run dev 或打包后的应用打开）。', 'bad');
        setNote(actionNote, '按钮在桌面壳外不可用。', 'warn');
        return;
    }

    wireButtons();
    wireEvents();
    log('桌面壳已就绪；主窗口由托盘控制');
    await Promise.all([refresh(), loadAutoLaunch()]);
}

void bootstrap();
