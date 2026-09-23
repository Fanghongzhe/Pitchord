const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pitchordDesktop', {
  saveText: (name, content) => ipcRenderer.invoke('pitchord:save-text', { name, content }),
  getPython: () => ipcRenderer.invoke('pitchord:get-python'),
  pickPython: () => ipcRenderer.invoke('pitchord:pick-python'),
  projectDefaults: () => ipcRenderer.invoke('pitchord:project-defaults'),
  pickProjectParent: () => ipcRenderer.invoke('pitchord:pick-project-parent'),
  createProject: (name, parent) => ipcRenderer.invoke('pitchord:create-project', { name, parent }),
  openProject: () => ipcRenderer.invoke('pitchord:open-project'),
  saveProject: content => ipcRenderer.invoke('pitchord:save-project', content),
  storeLyricsSource: (name, content) => ipcRenderer.invoke('pitchord:store-lyrics-source', { name, content }),
  openLyricsFolder: () => ipcRenderer.invoke('pitchord:open-lyrics-folder'),
  pickLyricsBackup: () => ipcRenderer.invoke('pitchord:pick-lyrics-backup'),
  storeAsset: (kind, name, data) => ipcRenderer.invoke('pitchord:store-asset', { kind, name, data }),
  readProjectAsset: kind => ipcRenderer.invoke('pitchord:read-project-asset', kind),
  openProjectFolder: () => ipcRenderer.invoke('pitchord:open-project-folder'),
  separateVocals: (source) => ipcRenderer.invoke('pitchord:separate-vocals', source),
})
