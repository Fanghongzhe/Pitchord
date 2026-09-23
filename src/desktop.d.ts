export {}

type AnalysisRuntimeStatus = {
  runtimeVersion: string
  source: 'managed' | 'portable' | 'custom' | 'missing'
  path: string
  pythonVersion: string
  packages: { demucs: boolean; torchcrepe: boolean; pip: boolean }
  runtimeReady: boolean
  model: string
  modelReady: boolean
  runtimeDirectory: string
  modelDirectory: string
  busy: boolean
}

declare global {
  interface Window {
    pitchordDesktop?: {
      saveText: (name: string, content: string) => Promise<boolean>
      getPython: () => Promise<string | null>
      pickPython: () => Promise<string | null>
      analysisStatus: () => Promise<AnalysisRuntimeStatus>
      installAnalysisRuntime: () => Promise<AnalysisRuntimeStatus>
      prepareAnalysisModel: () => Promise<AnalysisRuntimeStatus>
      openAnalysisFolder: () => Promise<string>
      onAnalysisProgress: (callback: (progress: { stage: string; message: string }) => void) => () => void
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
      separateVocals: (source: { name: string; data: ArrayBuffer }) => Promise<{ vocals: { name: string; path: string; data: Uint8Array }; accompaniment: { name: string; path: string; data: Uint8Array } } | null>
    }
  }
}
