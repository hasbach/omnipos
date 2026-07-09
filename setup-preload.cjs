const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronSetup', {
  scanNetwork: () => ipcRenderer.invoke('setup:scan-network'),
  saveConfig: (config) => ipcRenderer.invoke('setup:save-config', config),
  close: () => ipcRenderer.send('setup:close'),
});
