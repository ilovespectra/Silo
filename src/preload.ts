const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  getFiles: (dirPath) => ipcRenderer.invoke('get-files', dirPath),
  getFilePreview: (filePath) => ipcRenderer.invoke('get-file-preview', filePath),
  isDev: () => ipcRenderer.invoke('is-dev'),
});
