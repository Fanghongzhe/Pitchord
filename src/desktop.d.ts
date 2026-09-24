export {}

type AnalysisRuntimeStatus = {
  runtimeVersion: string
  source: 'managed' | 'portable' | 'custom' | 'missing'
  path: string
  pythonVersion: string
  root: string
  packages: { demucs: boolean; torchcrepe: boolean; librosa: boolean; pip: boolean }
  runtimeReady: boolean
  mediaTools: { ffmpeg: boolean; ffprobe: boolean }
  separationModels: Array<{ id: string; label: string; description: string; bundled: boolean; ready: boolean }>
  pitchMethods: Array<{ id: string; label: string; description: string; ready: boolean }>
  alignment: { manual: boolean; pitchMatching: boolean; forcedAlignment: boolean }
  model: string
  modelReady: boolean
  runtimeDirectory: string
  modelDirectory: string
  baseRuntimeVersion: string
  baseRuntimePath: string
  baseRuntimeReady: boolean
  offlineBundleReady: boolean
  busy: boolean
}

type AnalysisStorageStatus = {
  root: string
  locations: Record<'baseRuntime' | 'analysisRuntime' | 'models' | 'cache' | 'downloads', string>
  sizes: Record<'baseRuntime' | 'analysisRuntime' | 'models' | 'cache' | 'downloads', number>
  legacyRoot: string
  legacyTotal: number
  total: number
}

declare global {
  interface Window {
    pitchordDesktop?: {
      saveText: (name: string, content: string) => Promise<boolean>
      getPython: () => Promise<string | null>
      pickPython: () => Promise<string | null>
      analysisStatus: () => Promise<AnalysisRuntimeStatus>
      analysisStorageStatus: () => Promise<AnalysisStorageStatus>
      removeAnalysisData: (target: 'runtime' | 'models' | 'cache' | 'legacy' | 'all') => Promise<AnalysisStorageStatus>
      prepareBaseRuntime: () => Promise<AnalysisRuntimeStatus>
      installAnalysisRuntime: () => Promise<AnalysisRuntimeStatus>
      prepareAnalysisModel: (model?: string) => Promise<AnalysisRuntimeStatus>
      openAnalysisFolder: () => Promise<string>
      onAnalysisProgress: (callback: (progress: { stage: string; message: string }) => void) => () => void
      onTaskProgress: (callback: (progress: { id: string; title: string; status: 'running' | 'success' | 'error'; message: string; progress?: number }) => void) => () => void
      projectDefaults: () => Promise<{ parent: string; suggestedName: string }>
      pickProjectParent: () => Promise<string | null>
      createProject: (name: string, parent: string) => Promise<{ directory: string; name: string }>
      openProject: () => Promise<{ directory: string; name: string; content: string } | null>
      saveProject: (content: string) => Promise<string>
      storeLyricsSource: (name: string, content: string) => Promise<string>
      openLyricsFolder: () => Promise<string>
      pickLyricsBackup: () => Promise<{ name: string; content: string } | null>
      storeAsset: (kind: 'media' | 'vocals' | 'accompaniment', name: string, data: ArrayBuffer) => Promise<string>
      readProjectAsset: (kind: 'media' | 'vocals' | 'accompaniment') => Promise<{ name: string; data: Uint8Array } | null>
      openProjectFolder: () => Promise<string>
      separateVocals: (source: { name: string; data: ArrayBuffer; model?: string }) => Promise<{ vocals: { name: string; path: string; data: Uint8Array }; accompaniment: { name: string; path: string; data: Uint8Array } } | null>
      analyzePitch: (algorithm: 'pyin' | 'torchcrepe') => Promise<{ algorithm: string; path: string; points: Array<{ time: number; hz: number; confidence: number; rms: number; voiced: boolean }> }>
    }
  }
}
