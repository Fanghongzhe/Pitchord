const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pitchordDesktop', {
  saveText: (name, content) => ipcRenderer.invoke('pitchord:save-text', { name, content }),
  getPython: () => ipcRenderer.invoke('pitchord:get-python'),
  pickPython: () => ipcRenderer.invoke('pitchord:pick-python'),
  analysisStatus: () => ipcRenderer.invoke('pitchord:analysis-status'),
  analysisStorageStatus: () => ipcRenderer.invoke('pitchord:analysis-storage-status'),
  removeAnalysisData: target => ipcRenderer.invoke('pitchord:remove-analysis-data', target),
  prepareBaseRuntime: () => ipcRenderer.invoke('pitchord:prepare-base-runtime'),
  installAnalysisRuntime: () => ipcRenderer.invoke('pitchord:install-analysis-runtime'),
  prepareAnalysisModel: model => ipcRenderer.invoke('pitchord:prepare-analysis-model', model),
  importAnalysisModel: kind => ipcRenderer.invoke('pitchord:import-analysis-model', kind),
  removeAnalysisModel: model => ipcRenderer.invoke('pitchord:remove-analysis-model', model),
  openAnalysisFolder: () => ipcRenderer.invoke('pitchord:open-analysis-folder'),
  onAnalysisProgress: callback => {
    const listener = (_event, progress) => callback(progress)
    ipcRenderer.on('pitchord:analysis-progress', listener)
    return () => ipcRenderer.removeListener('pitchord:analysis-progress', listener)
  },
  onTaskProgress: callback => {
    const listener = (_event, progress) => callback(progress)
    ipcRenderer.on('pitchord:task-progress', listener)
    return () => ipcRenderer.removeListener('pitchord:task-progress', listener)
  },
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
  separateVocals: source => ipcRenderer.invoke('pitchord:separate-vocals', source),
  analyzePitch: algorithm => ipcRenderer.invoke('pitchord:analyze-pitch', algorithm),
  readAnalysisFile: file => ipcRenderer.invoke('pitchord:read-analysis-file', file),
  activateSeparationResult: result => ipcRenderer.invoke('pitchord:activate-separation-result', result),
  burnSubtitles: request => ipcRenderer.invoke('pitchord:burn-subtitles', request),
})
