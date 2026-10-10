// Preload bridge: the only surface the renderer may use to reach the main process.
//
// Deliberately narrow — two named calls, no generic invoke, and no access to the
// adapter credential. `contextBridge` deep-copies the object into the page, so
// nothing from the main process leaks by reference.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('amb', {
  /** Fetch one named view. Returns `{ ok, data }` or `{ ok: false, error }`. */
  view: (name, args) => ipcRenderer.invoke('amb:view', name, args),
  /** Run the self-check in the main process. The report holds no credential. */
  doctor: () => ipcRenderer.invoke('amb:doctor'),
  /** Non-secret target context (endpoint origin, project, adapter). No token. */
  target: () => ipcRenderer.invoke('amb:target'),
  /** Data migration: export all data to a user-chosen .ambpack file. */
  backupExport: () => ipcRenderer.invoke('amb:backupExport'),
  /** Data migration: choose an archive file and inspect its contents. */
  backupInspect: () => ipcRenderer.invoke('amb:backupInspect'),
  /** Data migration: merge the inspected archive (must call backupInspect first). */
  backupImport: () => ipcRenderer.invoke('amb:backupImport'),
  /** Data migration: open the last exported file in the file manager. */
  revealExport: () => ipcRenderer.invoke('amb:revealExport'),
});
