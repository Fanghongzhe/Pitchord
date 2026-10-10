export {}

type AnalysisRuntimeStatus = {
  runtimeVersion: string
  source: 'managed' | 'portable' | 'custom' | 'missing'
  path: string
  pythonVersion: string
  root: string
  defaultRoot: string
  runtimePreference: 'managed' | 'custom'
  computeProfile: 'auto' | 'cpu' | 'cuda121'
  detectedGpu: { name: string; driver: string } | null
  packages: { demucs: boolean; torchcrepe: boolean; librosa: boolean; fasterWhisper: boolean; pip: boolean }
  compute: { backend: 'cpu' | 'cuda'; label: string; torchVersion: string; torchBuildCuda: string; cudaAvailable: boolean; cudaDeviceCount: number; cudaDeviceName: string; alignmentCudaAvailable: boolean }
  runtimeReady: boolean
  completeReady: boolean
  mediaTools: { ffmpeg: boolean; ffprobe: boolean }
  separationModels: Array<{ id: string; label: string; description: string; bundled: boolean; ready: boolean; runnable?: boolean; source?: 'recommended' | 'custom'; canDelete?: boolean; provider?: string }>
  harmonyModels: Array<{ id: string; label: string; description: string; ready: boolean; runnable?: boolean; source?: 'recommended' | 'custom'; canDelete?: boolean; provider?: string }>
  pitchMethods: Array<{ id: string; label: string; description: string; ready: boolean; runnable?: boolean; source?: 'recommended' | 'custom'; canDelete?: boolean; provider?: string }>
  alignment: { manual: boolean; pitchMatching: boolean; forcedAlignment: boolean; models: Array<{ id: string; label: string; description: string; ready: boolean }> }
  model: string
  modelReady: boolean
  installSelection: { pitchMethods: Array<'pyin' | 'torchcrepe'>; separationModels: string[]; alignmentModels: string[] }
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
      choosePython: (currentPath?: string) => Promise<string | null>
      chooseAnalysisDirectory: (currentPath?: string) => Promise<string | null>
      configureAnalysisEnvironment: (request: { mode: 'managed'; root: string; computeProfile: 'auto' | 'cpu' | 'cuda121' } | { mode: 'custom'; pythonPath: string }) => Promise<AnalysisRuntimeStatus>
      analysisStatus: () => Promise<AnalysisRuntimeStatus>
      cancelAnalysisTask: (taskId: 'environment' | 'separation' | 'harmony' | 'pitch' | 'alignment') => Promise<boolean>
      analysisStorageStatus: () => Promise<AnalysisStorageStatus>
      removeAnalysisData: (target: 'runtime' | 'models' | 'cache' | 'legacy' | 'all') => Promise<AnalysisStorageStatus>
      prepareBaseRuntime: () => Promise<AnalysisRuntimeStatus>
      installAnalysisRuntime: (request?: { root?: string; computeProfile?: 'auto' | 'cpu' | 'cuda121'; installSelection?: { pitchMethods: Array<'pyin' | 'torchcrepe'>; separationModels: string[]; alignmentModels: string[] } }) => Promise<AnalysisRuntimeStatus>
      prepareAnalysisModel: (model?: string) => Promise<AnalysisRuntimeStatus>
      prepareHarmonyModel: (model: string) => Promise<AnalysisRuntimeStatus>
      removeHarmonyModel: (model: string) => Promise<AnalysisRuntimeStatus>
      prepareAlignmentModel: (model: string) => Promise<AnalysisRuntimeStatus>
      removeAlignmentModel: (model: string) => Promise<AnalysisRuntimeStatus>
      importAnalysisModel: (kind: 'separation' | 'harmony' | 'pitch') => Promise<AnalysisRuntimeStatus | null>
      removeAnalysisModel: (model: string) => Promise<AnalysisRuntimeStatus>
      openAnalysisFolder: () => Promise<string>
      onAnalysisProgress: (callback: (progress: { stage: string; message: string; componentId?: string; componentProgress?: number; overallProgress?: number; detail?: string; components?: Array<{ id: string; label: string; detail: string; status: 'pending' | 'running' | 'complete'; progress: number }>; speedBytesPerSecond?: number; downloadedBytes?: number; totalBytes?: number; etaSeconds?: number; transferState?: 'downloading' | 'cache' | 'installing' }) => void) => () => void
      onTaskProgress: (callback: (progress: { id: string; title: string; status: 'running' | 'success' | 'error' | 'cancelled'; message: string; progress?: number }) => void) => () => void
      projectDefaults: () => Promise<{ parent: string; suggestedName: string }>
      pickProjectParent: () => Promise<string | null>
      createProject: (name: string, parent: string) => Promise<{ directory: string; name: string }>
      openProject: () => Promise<{ directory: string; name: string; content: string } | null>
      saveProject: (content: string) => Promise<string>
      storeLyricsSource: (name: string, content: string) => Promise<string>
      openLyricsFolder: () => Promise<string>
      pickLyricsBackup: () => Promise<{ name: string; content: string } | null>
      storeAsset: (kind: 'media' | 'vocals' | 'harmonies' | 'accompaniment', name: string, data: ArrayBuffer) => Promise<string>
      readProjectAsset: (kind: 'media' | 'vocals' | 'harmonies' | 'accompaniment') => Promise<{ name: string; data: Uint8Array } | null>
      openProjectFolder: () => Promise<string>
      separateVocals: (source: { name: string; data: ArrayBuffer; model?: string }) => Promise<{ vocals: { name: string; path: string; data: Uint8Array }; accompaniment: { name: string; path: string; data: Uint8Array } } | null>
      separateHarmonies: (request: { vocals: string; model: string }) => Promise<{ lead: { name: string; path: string; data: Uint8Array }; harmonies: { name: string; path: string; data: Uint8Array }; modelId: string; modelLabel: string }>
      analyzePitch: (algorithm: 'pyin' | 'torchcrepe', vocals?: string) => Promise<{ algorithm: string; path: string; device: string; points: Array<{ time: number; hz: number; confidence: number; rms: number; voiced: boolean }> }>
      alignLyrics: (request: { segments: import('./lib/lyrics').LyricSegment[]; duration: number; model: string; language: string; vocals?: string; pitchPoints?: import('./lib/pitch').PitchPoint[] }) => Promise<{ segments: import('./lib/lyrics').LyricSegment[]; coverage: number; matchedTokens: number; referenceTokens: number; recognizedTokens: number; lowConfidenceLines: number[]; model: string; language?: string; path: string; input: string }>
      readAnalysisFile: (file: string) => Promise<Uint8Array>
      activateSeparationResult: (result: { vocals: string; accompaniment: string }) => Promise<boolean>
      activateVocalResult: (result: { vocals: string; harmonies?: string }) => Promise<boolean>
      burnSubtitles: (request: { ass: string; outputName: string }) => Promise<{ video: string; subtitle: string }>
    }
  }
}
