const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('opcaiDesktop', {
  pickFile: () => ipcRenderer.invoke('opcai:pick-file'),
  openExternal: (url) => ipcRenderer.invoke('opcai:open-external', url),
});
