const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),

  // Auto-updater controls (renderer → main)
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.send('updater:install'),

  // Auto-updater events (main → renderer)
  onUpdateStatus: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('updater:status', handler);
    // Return cleanup function
    return () => ipcRenderer.removeListener('updater:status', handler);
  },

  // Silent printing: renders the given HTML off-screen and prints it to the OS default printer
  // with no dialog. Used as the POS's last-resort receipt fallback when no ESC/POS printer is
  // configured (or direct printing to one failed) — see server/printing/transport.ts for the
  // normal, already-silent path via network/USB.
  printSilent: (html) => ipcRenderer.invoke('print:silent-html', { html }),
});
