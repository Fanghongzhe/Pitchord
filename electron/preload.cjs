const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pitchordDesktop', {
  saveText: (name, content) => ipcRenderer.invoke('pitchord:save-text', { name, content }),
  getPython: () => ipcRenderer.invoke('pitchord:get-python'),
  pickPython: () => ipcRenderer.invoke('pitchord:pick-python'),
  choosePython: currentPath => ipcRenderer.invoke('pitchord:choose-python', currentPath),
  chooseAnalysisDirectory: currentPath => ipcRenderer.invoke('pitchord:choose-analysis-directory', currentPath),
  configureAnalysisEnvironment: request => ipcRenderer.invoke('pitchord:configure-analysis-environment', request),
  analysisStatus: () => ipcRenderer.invoke('pitchord:analysis-status'),
  cancelAnalysisTask: taskId => ipcRenderer.invoke('pitchord:cancel-analysis-task', taskId),
  analysisStorageStatus: () => ipcRenderer.invoke('pitchord:analysis-storage-status'),
  removeAnalysisData: target => ipcRenderer.invoke('pitchord:remove-analysis-data', target),
  prepareBaseRuntime: () => ipcRenderer.invoke('pitchord:prepare-base-runtime'),
  installAnalysisRuntime: request => ipcRenderer.invoke('pitchord:install-analysis-runtime', request),
  prepareAnalysisModel: model => ipcRenderer.invoke('pitchord:prepare-analysis-model', model),
  prepareHarmonyModel: model => ipcRenderer.invoke('pitchord:prepare-harmony-model', model),
  removeHarmonyModel: model => ipcRenderer.invoke('pitchord:remove-harmony-model', model),
  prepareAlignmentModel: model => ipcRenderer.invoke('pitchord:prepare-alignment-model', model),
  removeAlignmentModel: model => ipcRenderer.invoke('pitchord:remove-alignment-model', model),
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
  openProject: directory => ipcRenderer.invoke('pitchord:open-project', directory),
  refreshProjects: directories => ipcRenderer.invoke('pitchord:refresh-projects', directories),
  duplicateProject: (directory, name) => ipcRenderer.invoke('pitchord:duplicate-project', directory, name),
  revealProject: directory => ipcRenderer.invoke('pitchord:reveal-project', directory),
  trashProjects: directories => ipcRenderer.invoke('pitchord:trash-projects', directories),
  saveProject: content => ipcRenderer.invoke('pitchord:save-project', content),
  storeLyricsSource: (name, content) => ipcRenderer.invoke('pitchord:store-lyrics-source', { name, content }),
  openLyricsFolder: () => ipcRenderer.invoke('pitchord:open-lyrics-folder'),
  pickLyricsBackup: () => ipcRenderer.invoke('pitchord:pick-lyrics-backup'),
  storeAsset: (kind, name, data) => ipcRenderer.invoke('pitchord:store-asset', { kind, name, data }),
  readProjectAsset: kind => ipcRenderer.invoke('pitchord:read-project-asset', kind),
  openProjectFolder: () => ipcRenderer.invoke('pitchord:open-project-folder'),
  separateVocals: source => ipcRenderer.invoke('pitchord:separate-vocals', source),
  separateHarmonies: request => ipcRenderer.invoke('pitchord:separate-harmonies', request),
  analyzePitch: (algorithm, vocals) => ipcRenderer.invoke('pitchord:analyze-pitch', algorithm, vocals),
  alignLyrics: request => ipcRenderer.invoke('pitchord:align-lyrics', request),
  readAnalysisFile: file => ipcRenderer.invoke('pitchord:read-analysis-file', file),
  activateSeparationResult: result => ipcRenderer.invoke('pitchord:activate-separation-result', result),
  activateVocalResult: result => ipcRenderer.invoke('pitchord:activate-vocal-result', result),
  burnSubtitles: request => ipcRenderer.invoke('pitchord:burn-subtitles', request),
})
