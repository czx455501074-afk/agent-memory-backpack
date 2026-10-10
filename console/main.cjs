// Electron main process, CommonJS on purpose.
//
// An ESM named import from 'electron' fails under Electron's loader (the
// specifier resolves to the npm wrapper, which has no named exports), so the
// main process uses require(). The core client is TypeScript/ESM output, which
// is loaded with a dynamic import below.
//
// The adapter token stays in this process and is never handed to the renderer.
// The renderer asks for named views over IPC and receives only the data, so a
// compromised page cannot read the credential, and the core keeps its existing
// rule of refusing browser-origin requests.
//
// The same boundary covers data migration: file dialogs and the core calls they
// lead to run here, so the page never names a path to write to or merge from and
// never holds a path the user did not pick.

const electron = require('electron');
const { readFileSync, existsSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { pathToFileURL } = require('node:url');

// When ELECTRON_RUN_AS_NODE is set, Electron degrades to plain Node and
// `require('electron')` yields the executable path instead of the API. That
// produces a confusing "cannot read whenReady" crash far from the cause, so it
// is diagnosed here and reported as what it is.
if (typeof electron !== 'object' || typeof electron.app?.whenReady !== 'function') {
  const detail = process.env.ELECTRON_RUN_AS_NODE
    ? 'ELECTRON_RUN_AS_NODE is set, which makes Electron run as plain Node. Unset it before launching the console.'
    : `require('electron') did not return the Electron API (got ${typeof electron}).`;
  process.stderr.write(`Console cannot start: ${detail}\n`);
  process.exit(1);
}

const { app, BrowserWindow, dialog, ipcMain, shell } = electron;

let config;
let client;
let adapter = 'codex';
let window;
/** Resolved at startup; the self-check needs both after the client is built. */
let runtimeBase = '';
let configPath = '';
/**
 * Archive paths remembered between the IPC calls of one migration.
 *
 * The page gets the results only, so it cannot ask this process to write to, or
 * merge from, a path it invented: it can only continue the file the user picked
 * in a native dialog here. A failed inspect clears the pending file, so a file
 * the core refused to read can never be imported.
 */
let lastExportFile = '';
let pendingImportFile = '';

const ARCHIVE_FILTERS = [{ name: 'Agent Memory Backpack 归档', extensions: ['ambpack'] }];

/**
 * Local-time stamp for the default file name: 2026-10-10 21:07 -> 20261010-2107.
 *
 * Not the core's `defaultArchiveName()`, which stamps UTC: the save dialog shows
 * local time, so a UTC name would look hours stale and can even name the wrong
 * day either side of midnight.
 */
function archiveStamp(now = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function defaultArchivePath() {
  return `agent-memory-backpack-${archiveStamp()}.ambpack`;
}

/** Ensure the chosen path has the correct extension. */
function ensureArchiveExtension(path) {
  return path.toLowerCase().endsWith('.ambpack') ? path : `${path}.ambpack`;
}

/**
 * Turn a core rejection into something the user can act on.
 *
 * The core's own message is the useful part of a rejection (`... (403, forbidden):
 * ...`), so it is kept verbatim; only a plain-language prefix naming the action is
 * added. The admin-only rule is called out explicitly because an adapter
 * credential is refused for exactly this reason and the fix is to point the
 * console at admin-client.json, which the raw HTTP line does not say.
 */
function describeBackupError(error, action) {
  const message = error instanceof Error ? error.message : '核心未返回原因';
  if (/\(403[,)]/.test(message)) {
    return `${action}被核心拒绝（403）：导出与导入只接受 admin 凭据，适配器凭据会被拒绝。请把控制台指向 admin-client.json 后重试。核心信息：${message}`;
  }
  return `${action}失败：${message}`;
}

/**
 * Locate the compiled core client.
 *
 * Two layouts must work: the repository (`<root>/console` beside `<root>/dist/src`)
 * and the packaged artifact (`<out>/console` beside `<out>/core/runtime`). The
 * console probes known locations rather than hardcoding one, otherwise the
 * packaged app would only run from a development checkout.
 */
function resolveRuntime() {
  const candidates = [
    join(__dirname, '..', 'dist', 'src'),
    join(__dirname, '..', 'core', 'runtime'),
    join(__dirname, '..', 'runtime'),
    join(__dirname, '..', '..', 'dist', 'src'),
  ];
  for (const base of candidates) {
    if (existsSync(join(base, 'client.js'))) return base;
  }
  throw new Error(`Cannot find the core runtime. Looked in: ${candidates.join(', ')}`);
}

function resolveConfigPath() {
  const fromArgv = process.argv.find(arg => arg.startsWith('--config='))?.slice('--config='.length);
  const path = fromArgv || process.env.AMB_CONSOLE_CONFIG || process.env.AMB_CONFIG;
  if (!path) throw new Error('Set AMB_CONSOLE_CONFIG (or AMB_CONFIG) to an adapter client.json path, or pass --config=PATH.');
  // Checked rather than left to readFileSync: a raw ENOENT does not tell the user
  // which setting was wrong or what to do about it.
  if (!existsSync(path)) {
    throw new Error(`Adapter config not found: ${path}. Generate one with "cli init", or point AMB_CONSOLE_CONFIG at an existing client.json.`);
  }
  return path;
}

/**
 * Named data views the renderer may request.
 *
 * An explicit allowlist rather than a generic proxy: the page cannot ask the
 * main process to call an arbitrary core path with the credential attached.
 */
const VIEWS = {
  status: () => client.post('/v1/stats', {}),
  norms: () => client.post('/v1/norms', {}),
  proposals: () => client.post('/v1/proposals/list', { state: 'pending' }),
  workflows: args => client.post('/v1/search', { query: String(args?.query ?? '') }),
  tasks: () => client.post('/v1/tasks/list', {}),
  unstructured: () => client.post('/v1/knowledge/unstructured', {}),
  knowledge: args => client.post('/v1/knowledge/read', {
    knowledgeId: String(args?.knowledgeId ?? ''),
    includeLeaves: args?.includeLeaves === true,
  }),
  history: args => client.post('/v1/knowledge/history', { knowledgeId: String(args?.knowledgeId ?? '') }),
  rescanState: () => client.post('/v1/rescan/state', {}),
};

/**
 * The core matches a request's adapter id against the credential's own id, so the
 * console must speak as the identity whose config it was given.
 *
 * The console is the human's review surface, so it is normally pointed at
 * `admin-client.json`: approving and rejecting are admin-only operations, and an
 * adapter credential would be correctly refused. The adapter names are still
 * accepted so the console can be used to inspect a single adapter's view.
 */
function adapterFromPath(path) {
  const name = path.replace(/\\/g, '/').split('/').pop() || '';
  if (name.startsWith('dsh-')) return 'dsh';
  if (name.startsWith('codex-')) return 'codex';
  if (name.startsWith('admin-')) return 'admin';
  return 'codex';
}

function registerIpc() {
  ipcMain.handle('amb:view', async (_event, name, args) => {
    const view = VIEWS[name];
    if (!view) return { ok: false, error: `Unknown view: ${String(name)}` };
    try {
      return { ok: true, data: await view(args) };
    } catch (error) {
      // Only the message travels; the adapter token is never part of it.
      return { ok: false, error: error instanceof Error ? error.message : 'Core request failed' };
    }
  });

  /**
   * Self-check, run in the main process.
   *
   * The console already holds the config path, so a desktop user gets the same
   * diagnosis as `cli doctor` without a terminal. The report never contains a
   * credential, so returning it to the page is safe.
   */
  ipcMain.handle('amb:doctor', async () => {
    try {
      const { doctor, summarizeDoctor, pluginVersion } = await import(pathToFileURL(join(runtimeBase, 'doctor.js')).href);
      const report = await doctor({ dataDir: dirname(configPath), clientPath: configPath });
      return { ok: true, data: report, summary: summarizeDoctor(report), pluginVersion: pluginVersion() };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Self-check failed' };
    }
  });

  // Non-secret context for the header. The token is deliberately absent.
  ipcMain.handle('amb:target', () => ({
    endpoint: new URL(config.endpoint).origin,
    projectId: config.projectId,
    adapter,
  }));

  /**
   * Migration, one handler per user-visible step.
   *
   * Every one of these opens its own dialog and calls the core itself, so no IPC
   * message carries a filesystem path: the page names neither where an archive is
   * written nor which file is merged in, and can only continue a file the user
   * actually picked here. Export and import are admin-only in the core, so a
   * rejection is reported as such instead of looking like a broken panel.
   */
  ipcMain.handle('amb:backupExport', async () => {
    const chosen = await dialog.showSaveDialog(window, {
      title: '导出全部数据',
      defaultPath: defaultArchivePath(),
      filters: ARCHIVE_FILTERS,
      // Windows-only properties; ignored elsewhere. Creating a folder and
      // confirming an overwrite are both safer than discovering the mistake later.
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    // Cancelling is a normal outcome, not a failure: the panel says so quietly.
    if (chosen.canceled || !chosen.filePath) return { ok: true, data: { canceled: true } };
    const file = ensureArchiveExtension(chosen.filePath);
    // A save dialog that returned a path which already exists means the user
    // answered "replace" in the native confirmation. The core cannot see that
    // dialog, so its own guard refuses an existing file; passing `overwrite` only
    // in this case is what carries the user's answer across. Checking here rather
    // than always sending true keeps the guard meaningful for any caller that did
    // not ask a human first.
    const overwrite = existsSync(file);
    try {
      const data = await client.post('/v1/backup/export', { file, dryRun: false, overwrite });
      lastExportFile = typeof data?.file === 'string' && data.file ? data.file : file;
      return { ok: true, data: { canceled: false, replaced: overwrite, ...data } };
    } catch (error) {
      return { ok: false, error: describeBackupError(error, '导出') };
    }
  });

  /**
   * Read the chosen archive and report what is inside it, without merging anything.
   *
   * The path is remembered only if the core agreed to read it, so a file the core
   * refuses can never be imported by a later confirmation.
   */
  ipcMain.handle('amb:backupInspect', async () => {
    const chosen = await dialog.showOpenDialog(window, {
      title: '选择要导入的归档',
      properties: ['openFile'],
      filters: ARCHIVE_FILTERS,
    });
    if (chosen.canceled || !chosen.filePaths?.length) return { ok: true, data: { canceled: true } };
    const file = chosen.filePaths[0];
    try {
      const data = await client.post('/v1/backup/inspect', { file });
      pendingImportFile = file;
      return { ok: true, data: { canceled: false, ...data } };
    } catch (error) {
      pendingImportFile = '';
      return { ok: false, error: describeBackupError(error, '检查归档') };
    }
  });

  /**
   * Merge the archive the user inspected and confirmed.
   *
   * `onConflict: 'skip'` is the panel's contract: the merge only ever adds, and
   * anything newer or divergent locally is kept and reported instead of failing
   * the whole import. The pending path is cleared afterwards so one confirmation
   * cannot be repeated into a second merge.
   */
  ipcMain.handle('amb:backupImport', async () => {
    if (!pendingImportFile) return { ok: false, error: '尚未选择归档文件，请先「从文件导入」并确认内容。' };
    const file = pendingImportFile;
    try {
      const data = await client.post('/v1/backup/import', { file, dryRun: false, onConflict: 'skip' });
      pendingImportFile = '';
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: describeBackupError(error, '导入') };
    }
  });

  /** Show the archive the user just exported in the file manager. */
  ipcMain.handle('amb:revealExport', () => {
    if (!lastExportFile) return { ok: false, error: '本次会话还没有导出过归档文件。' };
    // Checked first: showItemInFolder is silent about a file that moved or was
    // deleted, and a button that does nothing is worse than a message.
    if (!existsSync(lastExportFile)) return { ok: false, error: `归档文件已不在原位：${lastExportFile}` };
    shell.showItemInFolder(lastExportFile);
    return { ok: true, data: { file: lastExportFile } };
  });
}

// Disable hardware acceleration to prevent GPU process crashes on some systems
app.disableHardwareAcceleration();

function createWindow() {
  window = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#101319',
    title: 'Agent Memory Backpack 知识控制台',
    show: false,
    webPreferences: {
      // The page gets no Node access; the only bridge is the narrow IPC surface.
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' }; });
  window.loadFile(join(__dirname, 'renderer', 'index.html'));
}

/**
 * Dump mode, for verifying every panel without a human looking at each one.
 *
 * Set AMB_CONSOLE_DUMP=PATH to visit each panel in turn, capture the rendered
 * text, and write it as JSON. This checks that every view produces real content
 * rather than an error banner or a stuck loading placeholder — something a single
 * screenshot cannot establish for the panels no one opened.
 */
async function maybeDump() {
  const target = process.env.AMB_CONSOLE_DUMP;
  if (!target) return false;
  const views = ['status', 'proposals', 'norms', 'unstructured', 'tasks', 'workflows', 'doctor', 'migrate'];
  const results = {};
  for (const view of views) {
    await window.webContents.executeJavaScript(`
      (() => {
        const tab = document.querySelector('.tab[data-view=${JSON.stringify(view)}]');
        if (tab) tab.click();
        return Boolean(tab);
      })()
    `);
    // Wait on a condition, not a fixed delay: under parallel test load an IPC
    // round trip can exceed any sleep short enough to keep the suite fast, and a
    // fixed sleep then captures the loading placeholder and fails intermittently.
    await waitForPanelSettled(view);
    results[view] = await window.webContents.executeJavaScript(`
      (() => {
        const panel = document.getElementById('panel');
        return {
          text: (panel.innerText || '').slice(0, 4000),
          // Only a failure notice counts: informational notices are expected on
          // several panels and must not be mistaken for a rendering error.
          hasError: Boolean(panel.querySelector('.notice:not(.notice--info)')),
          rows: panel.querySelectorAll('tbody tr').length,
          cards: panel.querySelectorAll('.card').length,
        };
      })()
    `);
  }
  require('node:fs').writeFileSync(target, JSON.stringify(results, null, 2));
  process.stdout.write(`dump: ${target}\n`);
  return true;
}

/**
 * Resolve once the panel has left its loading placeholder.
 *
 * Polls the rendered DOM instead of sleeping. Falls through after the timeout so
 * a genuinely stuck panel is still captured (and then reported as a failure by
 * the caller) rather than hanging the diagnostic.
 */
async function waitForPanelSettled(view, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const settled = await window.webContents.executeJavaScript(`
      (() => {
        const panel = document.getElementById('panel');
        if (!panel) return false;
        const text = panel.innerText || '';
        if (text.includes('正在读取核心')) return false;
        // A tab switch clears the panel; wait until it holds something again.
        return text.trim().length > 0;
      })()
    `);
    if (settled) return true;
    if (Date.now() > deadline) {
      process.stderr.write(`dump: panel ${view} did not settle within ${timeoutMs}ms\n`);
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/**
 * Screenshot mode, for diagnosing what the console actually shows.
 *
 * Set AMB_CONSOLE_SCREENSHOT=PATH to render once, write a PNG, and exit.
 * AMB_CONSOLE_THEME=light|dark forces a colour scheme so both can be checked
 * without changing the OS setting. This is a diagnostic, not a normal mode: it
 * writes no plugin data and leaves the knowledge base untouched.
 */
async function maybeScreenshot() {
  const target = process.env.AMB_CONSOLE_SCREENSHOT;
  if (!target) return false;
  const theme = process.env.AMB_CONSOLE_THEME;
  if (theme === 'light' || theme === 'dark') {
    await window.webContents.executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; true`);
  }
  // Optionally switch to a named tab before capturing, so any panel can be
  // inspected from the outside rather than only the default one.
  const requestedView = process.env.AMB_CONSOLE_VIEW;
  if (requestedView) {
    await window.webContents.executeJavaScript(`
      (() => {
        const tab = document.querySelector('.tab[data-view=${JSON.stringify(requestedView)}]');
        if (tab) tab.click();
        return Boolean(tab);
      })()
    `);
  }
  // Wait on the panel actually holding content, not on a fixed delay, so a slow
  // IPC round trip under load cannot be captured as the loading placeholder.
  await waitForPanelSettled(requestedView ?? 'status');
  const image = await window.webContents.capturePage();
  require('node:fs').writeFileSync(target, image.toPNG());
  process.stdout.write(`screenshot: ${target}\n`);
  return true;
}

app.whenReady().then(async () => {
  try {
    const resolvedConfigPath = resolveConfigPath();
    configPath = resolvedConfigPath;
    // Loaded dynamically: the core is ESM output, this file is CommonJS.
    runtimeBase = resolveRuntime();
    const [{ CoreClient }, { clientSchema }] = await Promise.all([
      import(pathToFileURL(join(runtimeBase, 'client.js')).href),
      import(pathToFileURL(join(runtimeBase, 'config.js')).href),
    ]);
    config = clientSchema.parse(JSON.parse(readFileSync(resolvedConfigPath, 'utf8')));
    adapter = adapterFromPath(resolvedConfigPath);
    client = new CoreClient(config, adapter);
    registerIpc();
    createWindow();

    // Diagnostic modes: visit what was asked for, then quit. Dump and screenshot
    // are mutually exclusive; dump is checked first because it covers more panels.
    if (await maybeDump()) { app.quit(); return; }
    if (await maybeScreenshot()) app.quit();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Console failed to start'}\n`);
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());
