const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  getEcosystemData: () => ipcRenderer.invoke('get-ecosystem-data')
})
