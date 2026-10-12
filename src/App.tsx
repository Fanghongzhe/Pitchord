import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import {
  Activity, AlertCircle, AudioLines, CheckCircle2, CheckSquare2, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, Download,
  FileAudio2, FilePlus2, FileText, FolderOpen, Grid2X2, HardDrive, Home, List, LoaderCircle, Maximize2, Merge, Pause, Pencil,
  MoreHorizontal, Play, Plus, Redo2, RefreshCw, RotateCcw, RotateCw, Save, Scissors, Search, Settings2, SlidersHorizontal, Square, Trash2, Undo2, Upload, Video,
  Volume2, VolumeX, WandSparkles, X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Timeline } from '@/components/Timeline'
import { LiveSubtitlePreview } from '@/components/LiveSubtitlePreview'
import { VideoFrameMirror } from '@/components/VideoFrameMirror'
import { FloatingVideoPreview } from '@/components/FloatingVideoPreview'
import { RepeatedSectionsDialog } from '@/components/RepeatedSectionsDialog'
import { SectionMarkingDialog } from '@/components/SectionMarkingDialog'
import { PitchColorBandEditor } from '@/components/PitchColorBandEditor'
import {
  carryPitchOverrides, clamp, createSegment, formatTime, getAdjacentSelection, lyricUnits, mergeSegments,
  MIN_SPAN, parseLyrics, parseTime, replaceText, retimeSegment, roundTime, splitSegment, suggestSplitOffset,
} from '@/lib/lyrics'
import type { LyricSegment } from '@/lib/lyrics'
import { analyzeAudioBuffer, matchPitchToChars, noteHz, parsePitchNotation, pitchForChar, pitchNotation, validPitchAnnotation } from '@/lib/pitch'
import type { PitchPoint } from '@/lib/pitch'
import { defaultSubtitleStyle, generatePitchAss, pitchColorBandNames, sentenceSrt, wordTimedSubtitles } from '@/lib/subtitles'
import type { SubtitleStyle } from '@/lib/subtitles'
import { StemMixer } from '@/lib/stem-mixer'
import { resolveRangeConflict } from '@/lib/range-conflict'
import { analyzeVocalAcoustics, type AcousticAnalysis } from '@/lib/acoustics'
import { mergeAlignmentKeepingLocks, reapplyUnlockedLine, scoreCharTiming, type BoundaryReview } from '@/lib/alignment-quality'
import { autoPitchViewRange, defaultPitchViewSettings, normalizePitchViewSettings, pitchMidiName, type PitchGuideDensity } from '@/lib/timeline-pitch-view'
import { orderedSections, type RepeatedSection } from '@/lib/repeated-sections'

type History = { present: LyricSegment[]; past: LyricSegment[][]; future: LyricSegment[][] }
type View = 'lines' | 'chars'
type SeparationResult = { id: string; modelId: string; modelLabel: string; createdAt: string; vocals: string; accompaniment: string; harmonies?: string; sourceVocals?: string; sourceResultId?: string; harmonyModelId?: string }
type PitchResult = { id: string; algorithm: PitchAlgorithm; label: string; createdAt: string; path?: string; device?: string; points: PitchPoint[]; separationResultId?: string }
type AlignmentResult = { id: string; modelId: string; modelLabel: string; createdAt: string; inputResultId?: string; path?: string; coverage: number; lowConfidenceLines?: number[]; segments: LyricSegment[] }
type Draft = { projectName?: string; segments: LyricSegment[]; mediaName: string; duration: number; pitchPoints?: PitchPoint[]; separationResults?: SeparationResult[]; activeSeparationResultId?: string; activeVocalResultId?: string; activeAccompanimentResultId?: string; pitchInputResultId?: string; pitchResults?: PitchResult[]; activePitchResultId?: string; alignmentInputResultId?: string; alignmentResults?: AlignmentResult[]; activeAlignmentResultId?: string; harmonyEnabled?: boolean; harmonyModelId?: string; subtitleStyle?: Partial<SubtitleStyle>; repeatedSections?: RepeatedSection[] }
type RecentProject = { name: string; directory: string; updatedAt: string; available?: boolean }
type TrackKind = 'original' | 'vocals' | 'harmonies' | 'accompaniment'
type TimelinePreview = { id: string; start: number; end: number }
type ContextState = { x: number; y: number; id?: string; time?: number; selectedLineIds: string[] }
type InstallSelection = { pitchMethods: PitchAlgorithm[]; separationModels: string[]; harmonyModels: string[]; alignmentModels: string[] }
type AnalysisEnvironment = {
  runtimeVersion: string
  source: 'managed' | 'portable' | 'custom' | 'existing' | 'missing'
  path: string
  pythonVersion: string
  root: string
  defaultRoot: string
  runtimePreference: 'managed' | 'custom' | 'existing'
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
  runtimeDirectory: string
  modelDirectory: string
  baseRuntimeVersion: string
  baseRuntimePath: string
  baseRuntimeReady: boolean
  offlineBundleReady: boolean
  installSelection: InstallSelection
  busy: boolean
}
type WorkItem = { id: string; title: string; status: 'running' | 'success' | 'error' | 'cancelled'; message: string; progress?: number; updatedAt: number }
type PitchAlgorithm = 'pyin' | 'torchcrepe' | 'rmvpe' | 'fcpe'
type AnalysisStorage = {
  root: string
  locations: Record<'baseRuntime' | 'analysisRuntime' | 'models' | 'cache' | 'downloads', string>
  sizes: Record<'baseRuntime' | 'analysisRuntime' | 'models' | 'cache' | 'downloads', number>
  legacyRoot: string
  legacyTotal: number
  total: number
}
type EnvironmentProgressComponent = { id: string; label: string; detail: string; status: 'pending' | 'running' | 'complete'; progress: number }
type EnvironmentProgress = { componentId?: string; componentProgress?: number; overallProgress: number; components: EnvironmentProgressComponent[]; detail?: string; speedBytesPerSecond?: number; downloadedBytes?: number; totalBytes?: number; etaSeconds?: number; transferState?: 'downloading' | 'cache' | 'installing' }

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} 秒`
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟`
  return `${Math.floor(seconds / 3600)} 小时 ${Math.ceil(seconds % 3600 / 60)} 分钟`
}

function readDraft(): Draft | null {
  try {
    const value = JSON.parse(localStorage.getItem('pitchord.draft.v1') ?? 'null') as Draft | null
    return value && Array.isArray(value.segments) && typeof value.mediaName === 'string' && typeof value.duration === 'number' ? value : null
  } catch { return null }
}

function readRecentProjects(): RecentProject[] {
  try {
    const value = JSON.parse(localStorage.getItem('pitchord.recent-projects.v1') ?? '[]') as RecentProject[]
    return Array.isArray(value) ? value.filter(item => item && typeof item.name === 'string' && typeof item.directory === 'string').slice(0, 50) : []
  } catch { return [] }
}

const savedDraft = readDraft()
const cancellableTaskIds = new Set(['environment', 'separation', 'pitch', 'alignment'])
const installPresets: Record<'minimum' | 'recommended' | 'all', InstallSelection> = {
  minimum: { pitchMethods: ['pyin'], separationModels: ['mdx_extra_q'], harmonyModels: [], alignmentModels: ['base'] },
  recommended: { pitchMethods: ['pyin', 'torchcrepe'], separationModels: ['htdemucs'], harmonyModels: [], alignmentModels: ['small'] },
  all: { pitchMethods: ['pyin', 'torchcrepe', 'rmvpe', 'fcpe'], separationModels: ['htdemucs', 'htdemucs_ft', 'mdx_extra_q'], harmonyModels: ['bs-roformer-karaoke-frazer'], alignmentModels: ['small', 'base'] },
}

function readPitchViewSettings() {
  try { return normalizePitchViewSettings(JSON.parse(localStorage.getItem('pitchord.pitch-view.v1') ?? 'null')) }
  catch { return { ...defaultPitchViewSettings } }
}

function readHiddenProjectDirectories(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem('pitchord.hidden-projects.v1') ?? '[]') as unknown
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch { return [] }
}

const installOptionLabels = {
  pitchMethods: { pyin: 'pYIN', torchcrepe: 'TorchCrepe', rmvpe: 'RMVPE', fcpe: 'FCPE' },
  separationModels: { htdemucs: 'HTDemucs', htdemucs_ft: 'HTDemucs FT', mdx_extra_q: 'MDX Extra Q' },
  harmonyModels: { 'bs-roformer-karaoke-frazer': 'BS-RoFormer Karaoke' },
  alignmentModels: { small: 'Whisper Small', base: 'Whisper Base' },
} as const

const installOptionSizes = {
  pitchMethods: { pyin: 120, torchcrepe: 25, rmvpe: 370, fcpe: 45 },
  separationModels: { htdemucs: 85, htdemucs_ft: 330, mdx_extra_q: 170 },
  harmonyModels: { 'bs-roformer-karaoke-frazer': 204 },
  alignmentModels: { small: 470, base: 150 },
} as const

const subtitleStylePresets: Record<string, Partial<SubtitleStyle>> = {
  karaoke: { fontSize: 64, bold: true, italic: false, outline: 4, shadow: 1, backgroundStyle: 'outline', colorBand: 'rainbow', showPitch: true, showDot: true, fadeMs: 80 },
  clean: { fontSize: 54, bold: true, italic: false, outline: 3, shadow: 0, backgroundStyle: 'outline', colorBand: 'cool', showPitch: false, showDot: true, fadeMs: 100 },
  cinema: { fontSize: 52, bold: true, italic: false, outline: 2, shadow: 0, backgroundStyle: 'box', backgroundColor: '#000000', backgroundOpacity: 68, colorBand: 'warm', showPitch: false, showDot: true, fadeMs: 160 },
  minimal: { fontSize: 48, bold: false, italic: false, outline: 0, shadow: 0, backgroundStyle: 'none', colorBand: 'custom', lowColor: '#FFFFFF', highColor: '#FFFFFF', showPitch: false, showDot: true, fadeMs: 60 },
}

function copyInstallSelection(selection: InstallSelection): InstallSelection {
  return { pitchMethods: [...selection.pitchMethods], separationModels: [...selection.separationModels], harmonyModels: [...(selection.harmonyModels ?? [])], alignmentModels: [...selection.alignmentModels] }
}

function subtitleSignature(mediaName: string, segments: LyricSegment[], points: PitchPoint[], style: SubtitleStyle) {
  return JSON.stringify({ mediaName, segments, points, style })
}

function taskWasCancelled(error: unknown) {
  return /任务已取消|cancelled|canceled/i.test(error instanceof Error ? error.message : String(error))
}

async function download(name: string, content: string, mime: string): Promise<boolean> {
  if (window.pitchordDesktop) return window.pitchordDesktop.saveText(name, content)
  const url = URL.createObjectURL(new Blob([content], { type: mime }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  return true
}

function samplePeaks(buffer: AudioBuffer) {
  const data = buffer.getChannelData(0)
  const count = Math.min(6000, Math.max(600, Math.ceil(buffer.duration * 30)))
  const peaks = new Array<number>(count)
  for (let bin = 0; bin < count; bin++) {
    const from = Math.floor(bin * data.length / count)
    const to = Math.floor((bin + 1) * data.length / count)
    const stride = Math.max(1, Math.floor((to - from) / 60))
    let peak = 0
    for (let index = from; index < to; index += stride) peak = Math.max(peak, Math.abs(data[index]))
    peaks[bin] = peak
  }
  const max = Math.max(...peaks, 0.01)
  return peaks.map(peak => Math.min(1, peak / max))
}

export default function App() {
  const [history, setHistory] = useState<History>({ present: savedDraft?.segments ?? [], past: [], future: [] })
  const segments = history.present
  const [view, setView] = useState<View>('lines')
  const [selectedLineIds, setSelectedLineIds] = useState<string[]>([])
  const [selectedCharIds, setSelectedCharIds] = useState<string[]>([])
  const [repeatedSections, setRepeatedSections] = useState<RepeatedSection[]>(savedDraft?.repeatedSections ?? [])
  const [repeatedSectionsOpen, setRepeatedSectionsOpen] = useState(false)
  const [sectionMarkingOpen, setSectionMarkingOpen] = useState(false)
  const [centerRequest, setCenterRequest] = useState(0)
  const [centerTargetId, setCenterTargetId] = useState<string | null>(null)
  const [seekCenterRequest, setSeekCenterRequest] = useState(0)
  const [contextMenu, setContextMenu] = useState<ContextState | null>(null)
  const [rangeAdjusting, setRangeAdjusting] = useState(false)
  const [rangeDraft, setRangeDraft] = useState<TimelinePreview | null>(null)
  const [rangeEdge, setRangeEdge] = useState<'start' | 'end' | null>(null)
  const [charRangeAdjusting, setCharRangeAdjusting] = useState(false)
  const [charRangeDraft, setCharRangeDraft] = useState<TimelinePreview | null>(null)
  const [charRangeEdge, setCharRangeEdge] = useState<'start' | 'end' | null>(null)
  const [conflictOpen, setConflictOpen] = useState(false)
  const [conflictRange, setConflictRange] = useState<TimelinePreview | null>(null)
  const [shiftConfirmOpen, setShiftConfirmOpen] = useState(false)
  const [pendingShift, setPendingShift] = useState(0)
  const [lastShiftBefore, setLastShiftBefore] = useState<LyricSegment[] | null>(null)
  const [shiftDialogOpen, setShiftDialogOpen] = useState(false)
  const [shiftMode, setShiftMode] = useState<'seconds' | 'first-line'>('seconds')
  const [shiftSecondsDraft, setShiftSecondsDraft] = useState('0')
  const [firstLineStartDraft, setFirstLineStartDraft] = useState('')
  const [mediaUrl, setMediaUrl] = useState('')
  const [stemReady, setStemReady] = useState<{ vocals: boolean; harmonies: boolean; accompaniment: boolean }>({ vocals: false, harmonies: false, accompaniment: false })
  const [trackEnabled, setTrackEnabled] = useState<Record<TrackKind, boolean>>({ original: true, vocals: false, harmonies: false, accompaniment: false })
  const [trackVolume, setTrackVolume] = useState<Record<TrackKind, number>>({ original: 100, vocals: 100, harmonies: 100, accompaniment: 100 })
  const [masterMuted, setMasterMuted] = useState(false)
  const [masterVolume, setMasterVolume] = useState(100)
  const [mediaName, setMediaName] = useState(savedDraft?.mediaName ?? '')
  const [mediaIsVideo, setMediaIsVideo] = useState(false)
  const [videoAspect, setVideoAspect] = useState(16 / 9)
  const [duration, setDuration] = useState(savedDraft?.duration ?? 0)
  const [playhead, setPlayhead] = useState(0)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [timelinePreview, setTimelinePreview] = useState<TimelinePreview[] | null>(null)
  const [guideLine, setGuideLine] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [peaks, setPeaks] = useState<number[]>([])
  const [vocalPeaks, setVocalPeaks] = useState<number[]>([])
  const [acoustics, setAcoustics] = useState<AcousticAnalysis | null>(null)
  const [showSpectrogram, setShowSpectrogram] = useState(true)
  const [pitchViewSettings, setPitchViewSettings] = useState(readPitchViewSettings)
  const [pitchViewOpen, setPitchViewOpen] = useState(false)
  const [floatingVideoUrl, setFloatingVideoUrl] = useState('')
  const [waveformStatus, setWaveformStatus] = useState('导入音频或视频后显示波形')
  const [pitchPoints, setPitchPoints] = useState<PitchPoint[]>([])
  const [pitchStatus, setPitchStatus] = useState('尚未分析音高')
  const [audioReady, setAudioReady] = useState(false)
  const [vocalTrackReady, setVocalTrackReady] = useState(false)
  const [separationStatus, setSeparationStatus] = useState('未运行')
  const [analysisEnvironment, setAnalysisEnvironment] = useState<AnalysisEnvironment | null>(null)
  const [analysisEnvironmentBusy, setAnalysisEnvironmentBusy] = useState(false)
  const [analysisProgress, setAnalysisProgress] = useState('正在检查分析环境…')
  const [environmentProgress, setEnvironmentProgress] = useState<EnvironmentProgress | null>(null)
  const [storageOpen, setStorageOpen] = useState(false)
  const [analysisStorage, setAnalysisStorage] = useState<AnalysisStorage | null>(null)
  const [cleanupTarget, setCleanupTarget] = useState<'runtime' | 'models' | 'cache' | 'legacy' | 'all' | null>(null)
  const [cleanupBusy, setCleanupBusy] = useState(false)
  const [separationPromptOpen, setSeparationPromptOpen] = useState(false)
  const [repairEnvironmentOpen, setRepairEnvironmentOpen] = useState(false)
  const [environmentMode, setEnvironmentMode] = useState<'managed' | 'custom' | 'existing'>('managed')
  const [environmentRootDraft, setEnvironmentRootDraft] = useState('')
  const [existingEnvironmentDraft, setExistingEnvironmentDraft] = useState('')
  const [existingEnvironmentError, setExistingEnvironmentError] = useState('')
  const [externalPythonDraft, setExternalPythonDraft] = useState('')
  const [computeProfileDraft, setComputeProfileDraft] = useState<'auto' | 'cpu' | 'cuda121'>('auto')
  const [installPreset, setInstallPreset] = useState<'minimum' | 'recommended' | 'all' | 'custom'>('recommended')
  const [installSelectionDraft, setInstallSelectionDraft] = useState<InstallSelection>(copyInstallSelection(installPresets.recommended))
  const [modelManagerOpen, setModelManagerOpen] = useState(false)
  const [pendingModelDownload, setPendingModelDownload] = useState<string | null>(null)
  const [pendingModelRemoval, setPendingModelRemoval] = useState<string | null>(null)
  const [separationModel, setSeparationModel] = useState('htdemucs')
  const [harmonyEnabled, setHarmonyEnabled] = useState(savedDraft?.harmonyEnabled ?? false)
  const [harmonyModelId, setHarmonyModelId] = useState(savedDraft?.harmonyModelId ?? 'bs-roformer-karaoke-frazer')
  const [pitchAlgorithm, setPitchAlgorithm] = useState<PitchAlgorithm>('pyin')
  const [separationResults, setSeparationResults] = useState<SeparationResult[]>(savedDraft?.separationResults ?? [])
  const [activeSeparationResultId, setActiveSeparationResultId] = useState(savedDraft?.activeSeparationResultId ?? '')
  const [activeVocalResultId, setActiveVocalResultId] = useState(savedDraft?.activeVocalResultId ?? savedDraft?.activeSeparationResultId ?? '')
  const [activeAccompanimentResultId, setActiveAccompanimentResultId] = useState(savedDraft?.activeAccompanimentResultId ?? savedDraft?.activeSeparationResultId ?? '')
  const [pitchInputResultId, setPitchInputResultId] = useState(savedDraft?.pitchInputResultId ?? savedDraft?.activeVocalResultId ?? savedDraft?.activeSeparationResultId ?? '')
  const [pitchResults, setPitchResults] = useState<PitchResult[]>(savedDraft?.pitchResults ?? [])
  const [activePitchResultId, setActivePitchResultId] = useState(savedDraft?.activePitchResultId ?? '')
  const [alignmentModel, setAlignmentModel] = useState('small')
  const [alignmentLanguage, setAlignmentLanguage] = useState('zh')
  const [alignmentInputResultId, setAlignmentInputResultId] = useState(savedDraft?.alignmentInputResultId ?? savedDraft?.pitchInputResultId ?? savedDraft?.activeVocalResultId ?? '')
  const [alignmentResults, setAlignmentResults] = useState<AlignmentResult[]>(savedDraft?.alignmentResults ?? [])
  const [activeAlignmentResultId, setActiveAlignmentResultId] = useState(savedDraft?.activeAlignmentResultId ?? '')
  const [alignmentStatus, setAlignmentStatus] = useState('尚未匹配')
  const [subtitleStudioOpen, setSubtitleStudioOpen] = useState(false)
  const [pitchColorOpen, setPitchColorOpen] = useState(false)
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStyle>({ ...defaultSubtitleStyle, ...savedDraft?.subtitleStyle })
  const [lastRenderedSignature, setLastRenderedSignature] = useState('')
  const [rerunPrompt, setRerunPrompt] = useState<'separation' | 'pitch' | 'alignment' | null>(null)
  const [workItems, setWorkItems] = useState<WorkItem[]>([])
  const [workCenterOpen, setWorkCenterOpen] = useState(false)
  const [taskAlert, setTaskAlert] = useState<WorkItem | null>(null)
  const [environmentInstallState, setEnvironmentInstallState] = useState<'idle' | 'running' | 'success' | 'error'>('idle')
  const [zoom, setZoom] = useState(85)
  const [importOpen, setImportOpen] = useState(false)
  const [importDraft, setImportDraft] = useState('')
  const [splitOpen, setSplitOpen] = useState(false)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [projectDirectory, setProjectDirectory] = useState('')
  const [projectName, setProjectName] = useState('')
  const [projectParent, setProjectParent] = useState('')
  const [newProjectName, setNewProjectName] = useState('')
  const [workspaceOpen, setWorkspaceOpen] = useState(() => !window.pitchordDesktop && !!savedDraft)
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>(readRecentProjects)
  const [projectNameEditing, setProjectNameEditing] = useState(false)
  const [projectNameDraft, setProjectNameDraft] = useState('')
  const [projectSearch, setProjectSearch] = useState('')
  const [projectGridView, setProjectGridView] = useState(true)
  const [projectSelectionMode, setProjectSelectionMode] = useState(false)
  const [selectedRecentDirectories, setSelectedRecentDirectories] = useState<string[]>([])
  const [duplicateSource, setDuplicateSource] = useState<RecentProject | null>(null)
  const [duplicateName, setDuplicateName] = useState('')
  const [pendingProjectTrash, setPendingProjectTrash] = useState<RecentProject[]>([])
  const [projectActionBusy, setProjectActionBusy] = useState(false)
  const [projectHomeMessage, setProjectHomeMessage] = useState('')
  const [automaticProcessing, setAutomaticProcessing] = useState(false)
  const [splitTimeDraft, setSplitTimeDraft] = useState('')
  const [splitOffset, setSplitOffset] = useState('')
  const [textDraft, setTextDraft] = useState('')
  const [startDraft, setStartDraft] = useState('')
  const [endDraft, setEndDraft] = useState('')
  const [pitchNotationEdit, setPitchNotationEdit] = useState<{ id: string; base: string; value: string } | null>(null)
  const [notice, setNotice] = useState(savedDraft?.segments.length ? '已恢复歌词草稿。重新导入同名媒体后即可试听。' : '导入媒体，然后导入 LRC 或粘贴歌词开始编辑。')
  const mediaInputRef = useRef<HTMLInputElement>(null)
  const pitchEditorRef = useRef<HTMLDivElement>(null)
  const lyricListRef = useRef<HTMLDivElement>(null)
  const lyricListTargetRef = useRef<string | null>(null)
  const vocalInputRef = useRef<HTMLInputElement>(null)
  const lyricInputRef = useRef<HTMLInputElement>(null)
  const environmentSetupPromptedRef = useRef(false)
  const projectInputRef = useRef<HTMLInputElement>(null)
  const mediaRef = useRef<HTMLMediaElement | null>(null)
  const videoPreviewRef = useRef<HTMLDivElement | null>(null)
  const mixerRef = useRef<StemMixer | null>(null)
  const mediaFileRef = useRef<File | null>(null)
  const pendingMediaRef = useRef<File | null>(null)
  const audioBufferRef = useRef<AudioBuffer | null>(null)
  const mediaToken = useRef(0)
  const vocalToken = useRef(0)
  const auditionRef = useRef<{ start: number; end: number } | null>(null)
  const timelineSeekRef = useRef(false)
  const lastRangeEdgeRef = useRef<'start' | 'end' | null>(null)
  const rightEdgeAuditionRef = useRef(false)
  const finishRangeAdjustRef = useRef<() => void>(() => undefined)
  const finishCharRangeAdjustRef = useRef<() => void>(() => undefined)
  const togglePlaybackRef = useRef<() => Promise<void>>(async () => undefined)
  const workflowExecutionRef = useRef<'automatic' | 'separation' | 'harmony' | 'pitch' | 'alignment' | 'render' | null>(null)
  const workStatusRef = useRef(new Map<string, WorkItem['status']>())
  const getMixer = () => mixerRef.current ?? (mixerRef.current = new StemMixer())
  const activeLine = segments.find(segment => selectedLineIds.includes(segment.id)) ?? null
  const orderedRepeatedSections = useMemo(() => orderedSections(repeatedSections, segments), [repeatedSections, segments])
  const repeatedLineLabels = useMemo(() => new Map(orderedRepeatedSections.flatMap(section => section.lineIds.map(id => [id, section.label] as const))), [orderedRepeatedSections])
  const effectiveSegments = useMemo(() => {
    const draft = view === 'lines' && rangeAdjusting ? rangeDraft : view === 'chars' && charRangeAdjusting ? charRangeDraft : null
    const previews = timelinePreview?.length ? timelinePreview : draft ? [draft] : []
    if (!previews.length) return segments
    const updates = new Map(previews.map(item => [item.id, item]))
    return view === 'lines'
      ? segments.map(segment => { const update = updates.get(segment.id); return update ? retimeSegment(segment, update.start, update.end) : segment })
      : segments.map(segment => segment.id === activeLine?.id ? { ...segment, chars: segment.chars.map(char => { const update = updates.get(char.id); return update ? { ...char, start: update.start, end: update.end } : char }) } : segment)
  }, [segments, timelinePreview, view, activeLine?.id, rangeAdjusting, rangeDraft, charRangeAdjusting, charRangeDraft])
  const visibleActiveLine = effectiveSegments.find(segment => selectedLineIds.includes(segment.id)) ?? null
  const fittedPitchRange = useMemo(() => pitchViewSettings.autoFitLine && visibleActiveLine
    ? autoPitchViewRange(pitchPoints, visibleActiveLine.start, visibleActiveLine.end) : null,
  [pitchViewSettings.autoFitLine, visibleActiveLine, pitchPoints])
  const displayedPitchView = useMemo(() => fittedPitchRange
    ? { ...pitchViewSettings, lowMidi: fittedPitchRange[0], highMidi: fittedPitchRange[1] }
    : pitchViewSettings, [pitchViewSettings, fittedPitchRange])
  const editingLocked = rangeAdjusting || charRangeAdjusting || conflictOpen
  const mergeIndexes = getAdjacentSelection(segments, selectedLineIds)
  const splitBoundaries = useMemo(() => activeLine ? lyricUnits(activeLine.text).slice(0, -1).map(unit => unit.endOffset) : [], [activeLine])
  const pitchMatches = useMemo(() => matchPitchToChars(segments, pitchPoints), [segments, pitchPoints])
  const voicedPitchPoints = useMemo(() => pitchPoints.filter(point => point.voiced && point.hz > 0), [pitchPoints])
  const activeAlignment = alignmentResults.find(result => result.id === activeAlignmentResultId)
  const reviewQueue = useMemo(() => {
    const peak = acoustics?.rms.reduce((highest, value) => Math.max(highest, value), 0) ?? 1
    return segments.flatMap((line, lineIndex) => line.chars.map(char => ({ line, char, review: scoreCharTiming(line, char, acoustics, pitchPoints, !!activeAlignment?.lowConfidenceLines?.includes(lineIndex), Math.max(peak, 0.001)) })))
  }, [segments, acoustics, pitchPoints, activeAlignment])
  const timingReviews: BoundaryReview[] = useMemo(() => reviewQueue.filter(item => item.line.id === activeLine?.id).map(item => item.review), [reviewQueue, activeLine?.id])
  const selectedSeparationModel = analysisEnvironment?.separationModels.find(model => model.id === separationModel)
  const selectedHarmonyModel = analysisEnvironment?.harmonyModels?.find(model => model.id === harmonyModelId)
  const selectedHarmonySource = separationResults.find(result => result.id === activeVocalResultId && !result.harmonies)
    ?? separationResults.find(result => result.id === pitchInputResultId && !result.harmonies)
    ?? separationResults.find(result => !result.harmonies)

  const updateWork = useCallback((id: string, title: string, status: WorkItem['status'], message: string, progress?: number) => {
    const previousStatus = workStatusRef.current.get(id)
    workStatusRef.current.set(id, status)
    if (id !== 'environment-check' && previousStatus === 'running' && (status === 'success' || status === 'error')) {
      setTaskAlert({ id, title, status, message, progress, updatedAt: Date.now() })
    }
    setWorkItems(current => {
      const previous = current.find(item => item.id === id)
      const next = { id, title, status, message, progress: progress ?? previous?.progress, updatedAt: Date.now() }
      return [next, ...current.filter(item => item.id !== id)].slice(0, 12)
    })
    if (status === 'running' && id !== 'environment-check') setWorkCenterOpen(true)
  }, [])

  useEffect(() => {
    if (!taskAlert) return
    const timer = window.setTimeout(() => setTaskAlert(current => current?.updatedAt === taskAlert.updatedAt ? null : current), taskAlert.status === 'error' ? 10000 : 6000)
    return () => window.clearTimeout(timer)
  }, [taskAlert])

  const cancelAnalysisTask = useCallback(async (taskId: 'environment' | 'separation' | 'harmony' | 'pitch' | 'alignment') => {
    const item = workItems.find(candidate => candidate.id === taskId)
    if (!item || item.status !== 'running' || !window.pitchordDesktop?.cancelAnalysisTask) return
    updateWork(taskId, item.title, 'running', '正在取消运行…', item.progress)
    try {
      const stopped = await window.pitchordDesktop.cancelAnalysisTask(taskId)
      if (!stopped) updateWork(taskId, item.title, 'cancelled', '任务已经结束，无需取消。')
    } catch (error) {
      updateWork(taskId, item.title, 'error', error instanceof Error ? error.message : String(error))
    }
  }, [workItems, updateWork])

  const commit = useCallback((next: LyricSegment[], preserveShiftBaseline = false) => {
    if (!preserveShiftBaseline) setLastShiftBefore(null)
    setHistory(current => {
      if (JSON.stringify(current.present) === JSON.stringify(next)) return current
      return { present: next, past: [...current.past, current.present].slice(-100), future: [] }
    })
  }, [])

  const undo = useCallback(() => { setLastShiftBefore(null); setHistory(current => {
    if (!current.past.length) return current
    const previous = current.past[current.past.length - 1]
    return { present: previous, past: current.past.slice(0, -1), future: [current.present, ...current.future] }
  }) }, [])
  const redo = useCallback(() => { setLastShiftBefore(null); setHistory(current => {
    if (!current.future.length) return current
    return { present: current.future[0], past: [...current.past, current.present], future: current.future.slice(1) }
  }) }, [])

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const editable = event.target instanceof HTMLElement && !!event.target.closest('input, textarea, [contenteditable="true"]')
      if (event.key === ' ' && !editable && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); if (!event.repeat) void togglePlaybackRef.current(); return }
      if (editingLocked) return
      if (editable || !(event.ctrlKey || event.metaKey)) return
      if (event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo() }
      if (event.key.toLowerCase() === 'y') { event.preventDefault(); redo() }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [undo, redo, editingLocked])

  useEffect(() => {
    const close = () => setContextMenu(null)
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', escape) }
  }, [])

  useEffect(() => {
    const adjusting = view === 'lines' ? rangeAdjusting : charRangeAdjusting
    const draft = view === 'lines' ? rangeDraft : charRangeDraft
    const edge = view === 'lines' ? rangeEdge : charRangeEdge
    if (!adjusting || !draft) {
      lastRangeEdgeRef.current = null
      rightEdgeAuditionRef.current = false
      return
    }
    if (!edge) {
      lastRangeEdgeRef.current = null
      return
    }
    const media = mediaRef.current
    if (!media) return
    if (edge === 'end') {
      const firstMoveInDrag = lastRangeEdgeRef.current !== 'end'
      lastRangeEdgeRef.current = 'end'
      rightEdgeAuditionRef.current = true
      if (!firstMoveInDrag && auditionRef.current) {
        auditionRef.current = { ...auditionRef.current, end: draft.end }
        return
      }
      const loopStart = Math.max(draft.start, draft.end - 1)
      auditionRef.current = { start: loopStart, end: draft.end }
      media.currentTime = loopStart
      void media.play().catch(() => undefined)
      return
    }
    lastRangeEdgeRef.current = 'start'
    rightEdgeAuditionRef.current = false
    auditionRef.current = { start: draft.start, end: draft.end }
    media.currentTime = draft.start
    void media.play().catch(() => undefined)
  }, [view, rangeAdjusting, rangeDraft, rangeEdge, charRangeAdjusting, charRangeDraft, charRangeEdge])

  useEffect(() => {
    setSelectedLineIds(ids => {
      const valid = ids.filter(id => segments.some(segment => segment.id === id))
      return valid.length === ids.length ? ids : valid
    })
    setSelectedCharIds(ids => ids.filter(id => activeLine?.chars.some(char => char.id === id)))
  }, [segments, activeLine])

  useEffect(() => {
    if (!workspaceOpen || view !== 'lines' || !selectedLineIds.length) return
    const list = lyricListRef.current
    if (!list) return
    const targetId = lyricListTargetRef.current && selectedLineIds.includes(lyricListTargetRef.current)
      ? lyricListTargetRef.current : selectedLineIds.at(-1)
    const row = Array.from(list.querySelectorAll<HTMLElement>('[data-line-id]')).find(item => item.dataset.lineId === targetId)
    if (!row) return
    const listBounds = list.getBoundingClientRect()
    const rowBounds = row.getBoundingClientRect()
    const top = list.scrollTop + rowBounds.top - listBounds.top
    const padding = 8
    if (top < list.scrollTop + padding) list.scrollTo({ top: Math.max(0, top - padding), behavior: 'smooth' })
    else if (top + rowBounds.height > list.scrollTop + list.clientHeight - padding) {
      list.scrollTo({ top: top + rowBounds.height - list.clientHeight + padding, behavior: 'smooth' })
    }
  }, [selectedLineIds, view, workspaceOpen])

  useEffect(() => {
    setTextDraft(activeLine?.text ?? '')
    setStartDraft(activeLine ? formatTime(activeLine.start) : '')
    setEndDraft(activeLine ? formatTime(activeLine.end) : '')
  }, [activeLine])

  useEffect(() => {
    if (!window.pitchordDesktop?.getPython) return
    updateWork('environment-check', '分析环境检测', 'running', '正在检查媒体、分离、音高和歌词对齐能力…')
    void window.pitchordDesktop.analysisStatus().then(status => {
      setAnalysisEnvironment(status)
      setEnvironmentMode(status.runtimePreference)
      setEnvironmentRootDraft(status.root)
      setExistingEnvironmentDraft(status.runtimePreference === 'existing' ? status.root : '')
      setExternalPythonDraft(status.runtimePreference === 'custom' ? status.path : '')
      setComputeProfileDraft(status.computeProfile)
      setInstallSelectionDraft(copyInstallSelection(status.installSelection))
      const matchingPreset = (Object.entries(installPresets) as Array<[keyof typeof installPresets, InstallSelection]>).find(([, selection]) => JSON.stringify(selection) === JSON.stringify(status.installSelection))?.[0]
      setInstallPreset(matchingPreset || 'custom')
      setSeparationModel(current => status.separationModels.some(model => model.id === current && model.ready && model.runnable !== false) ? current : status.separationModels.find(model => model.ready && model.runnable !== false)?.id || current)
      setPitchAlgorithm(current => status.pitchMethods.some(method => method.id === current && method.ready && method.runnable !== false) ? current : (status.pitchMethods.find(method => method.ready && method.runnable !== false && ['pyin', 'torchcrepe', 'rmvpe', 'fcpe'].includes(method.id))?.id as PitchAlgorithm | undefined) || current)
      setAlignmentModel(current => status.alignment.models.some(model => model.id === current && model.ready) ? current : status.alignment.models.find(model => model.ready)?.id || current)
      setAnalysisProgress(status.completeReady ? '分析环境与所选模型可用' : '分析环境尚未准备完整')
      const readyCount = [status.mediaTools.ffmpeg && status.mediaTools.ffprobe, status.separationModels.some(model => model.ready), status.pitchMethods.some(method => method.ready), status.alignment.forcedAlignment].filter(Boolean).length
      updateWork('environment-check', '分析环境检测', status.completeReady && readyCount >= 4 ? 'success' : 'error', `已完成 4 类检查，${readyCount} 类可用`, 1)
      if (!status.completeReady && workspaceOpen && !environmentSetupPromptedRef.current) {
        environmentSetupPromptedRef.current = true
        setRepairEnvironmentOpen(true)
      }
    }).catch(error => {
      setAnalysisProgress('无法检查分析环境')
      updateWork('environment-check', '分析环境检测', 'error', error instanceof Error ? error.message : '无法检查分析环境')
    })
    const removeProgress = window.pitchordDesktop.onAnalysisProgress(progress => {
      setAnalysisProgress(progress.message)
      if (typeof progress.overallProgress === 'number' && Array.isArray(progress.components)) {
        const overallProgress = progress.overallProgress
        const components = progress.components
        setEnvironmentProgress(current => ({
          componentId: progress.componentId,
          componentProgress: progress.componentProgress,
          overallProgress,
          components,
          detail: progress.detail,
          transferState: progress.transferState,
          speedBytesPerSecond: progress.speedBytesPerSecond ?? (progress.transferState === 'downloading' ? current?.speedBytesPerSecond : undefined),
          downloadedBytes: progress.downloadedBytes ?? (progress.transferState === 'downloading' ? current?.downloadedBytes : undefined),
          totalBytes: progress.totalBytes ?? (progress.transferState === 'downloading' ? current?.totalBytes : undefined),
          etaSeconds: progress.etaSeconds ?? (progress.transferState === 'downloading' ? current?.etaSeconds : undefined),
        }))
        updateWork('environment', '准备完整分析环境', 'running', progress.message, overallProgress)
      } else if (progress.stage === 'base-runtime' || progress.stage === 'runtime') {
        const percent = progress.message.match(/(\d{1,3})%/)?.[1]
        updateWork('environment', '准备分析环境', 'running', progress.message, percent ? Number(percent) / 100 : undefined)
      }
    })
    const removeTaskProgress = window.pitchordDesktop.onTaskProgress(progress => updateWork(progress.id, progress.title, progress.status, progress.message, progress.progress))
    void window.pitchordDesktop.projectDefaults().then(defaults => { setProjectParent(defaults.parent); setNewProjectName(defaults.suggestedName) }).catch(() => undefined)
    return () => { removeProgress(); removeTaskProgress() }
  }, [updateWork, workspaceOpen])

  useEffect(() => () => { if (mediaUrl) URL.revokeObjectURL(mediaUrl) }, [mediaUrl])
  useEffect(() => () => { void mixerRef.current?.close() }, [])
  useEffect(() => { localStorage.setItem('pitchord.pitch-view.v1', JSON.stringify(pitchViewSettings)) }, [pitchViewSettings])
  const currentProjectData = useCallback(() => ({ version: 1, projectName, mediaName, duration, segments, pitchPoints, separationResults, activeSeparationResultId, activeVocalResultId, activeAccompanimentResultId, pitchInputResultId, pitchResults, activePitchResultId, alignmentInputResultId, alignmentResults, activeAlignmentResultId, harmonyEnabled, harmonyModelId, subtitleStyle, repeatedSections }), [projectName, mediaName, duration, segments, pitchPoints, separationResults, activeSeparationResultId, activeVocalResultId, activeAccompanimentResultId, pitchInputResultId, pitchResults, activePitchResultId, alignmentInputResultId, alignmentResults, activeAlignmentResultId, harmonyEnabled, harmonyModelId, subtitleStyle, repeatedSections])
  useEffect(() => {
    if (mediaName && duration) localStorage.setItem('pitchord.draft.v1', JSON.stringify({ projectName, segments, mediaName, duration, pitchPoints, separationResults, activeSeparationResultId, activeVocalResultId, activeAccompanimentResultId, pitchInputResultId, pitchResults, activePitchResultId, alignmentInputResultId, alignmentResults, activeAlignmentResultId, harmonyEnabled, harmonyModelId, subtitleStyle, repeatedSections }))
  }, [projectName, segments, mediaName, duration, pitchPoints, separationResults, activeSeparationResultId, activeVocalResultId, activeAccompanimentResultId, pitchInputResultId, pitchResults, activePitchResultId, alignmentInputResultId, alignmentResults, activeAlignmentResultId, harmonyEnabled, harmonyModelId, subtitleStyle, repeatedSections])

  useEffect(() => {
    if (!projectDirectory || !window.pitchordDesktop) return
    const timer = window.setTimeout(() => {
      void window.pitchordDesktop?.saveProject(JSON.stringify(currentProjectData())).catch(error => setNotice(`工程自动保存失败：${error instanceof Error ? error.message : String(error)}`))
    }, 600)
    return () => window.clearTimeout(timer)
  }, [projectDirectory, currentProjectData])

  const copyAssetIntoProject = async (kind: 'media' | 'vocals' | 'accompaniment', file: File) => {
    if (!window.pitchordDesktop) throw new Error('当前版本无法保存工程素材。')
    await window.pitchordDesktop.storeAsset(kind, file.name, await file.arrayBuffer())
    const stored = await window.pitchordDesktop.readProjectAsset(kind)
    if (!stored) throw new Error('工程素材复制后无法读取。')
    const bytes = new Uint8Array(stored.data.byteLength)
    bytes.set(stored.data)
    return new File([bytes.buffer], file.name, { type: file.type })
  }

  const loadMedia = async (file: File, persist = true) => {
    if (!file.type.startsWith('audio/') && !file.type.startsWith('video/')) { setNotice('请选择音频或视频文件。'); updateWork('media-import', '导入媒体', 'error', '文件不是可识别的音频或视频'); return }
    updateWork('media-import', '导入媒体', 'running', `正在读取 ${file.name}…`, 0.05)
    let projectFile = file
    if (persist && window.pitchordDesktop && projectDirectory) {
      try {
        projectFile = await copyAssetIntoProject('media', file)
        updateWork('media-import', '导入媒体', 'running', '原媒体已复制到工程，正在解析音轨…', 0.35)
      }
      catch (error) { setNotice(`原媒体保存失败：${error instanceof Error ? error.message : String(error)}`); updateWork('media-import', '导入媒体', 'error', error instanceof Error ? error.message : String(error)); return }
    }
    const reconnect = !mediaUrl && file.name === mediaName && segments.length > 0
    const token = ++mediaToken.current
    mediaRef.current?.pause()
    mixerRef.current?.clear()
    mediaFileRef.current = projectFile
    setStemReady({ vocals: false, harmonies: false, accompaniment: false })
    setTrackEnabled({ original: true, vocals: false, harmonies: false, accompaniment: false })
    auditionRef.current = null
    setMediaUrl(URL.createObjectURL(projectFile))
    setMediaName(file.name)
    setMediaIsVideo(file.type.startsWith('video/'))
    setVideoAspect(16 / 9)
    if (!reconnect) setDuration(0)
    setPlayhead(0)
    setGuideLine(null)
    setPlaying(false)
    setPeaks([])
    setVocalPeaks([])
    setAcoustics(null)
    vocalToken.current++
    setPitchPoints([])
    setPitchStatus('尚未分析音高')
    setSeparationStatus('未运行')
    audioBufferRef.current = null
    setAudioReady(false)
    setVocalTrackReady(false)
    setWaveformStatus(file.type.startsWith('video/') ? '正在提取视频音轨波形…' : '正在解析媒体波形…')
    if (!reconnect) {
      setSeparationResults([])
      setActiveSeparationResultId('')
      setActiveVocalResultId('')
      setActiveAccompanimentResultId('')
      setPitchInputResultId('')
      setPitchResults([])
      setActivePitchResultId('')
      setAlignmentInputResultId('')
      setAlignmentResults([])
      setActiveAlignmentResultId('')
      setAlignmentStatus('尚未匹配')
      setHistory({ present: [], past: [], future: [] })
      setRepeatedSections([])
      setLastShiftBefore(null)
      setSelectedLineIds([])
      setSelectedCharIds([])
    }
    setNotice(reconnect ? '已重新关联媒体，歌词草稿保持原样。' : '媒体已载入。可导入 LRC 或粘贴无时间歌词。')
    if (file.type.startsWith('audio/')) {
      try {
        const audioContext = new AudioContext()
        try {
          const audio = await audioContext.decodeAudioData(await projectFile.arrayBuffer())
          if (token === mediaToken.current) { audioBufferRef.current = audio; setAudioReady(true); setPeaks(samplePeaks(audio)); setWaveformStatus(''); updateWork('media-import', '导入媒体', 'success', `已载入 ${file.name} 并生成波形`, 1) }
          return
        } finally { void audioContext.close() }
      } catch { /* Try the container reader below. */ }
    }
    try {
      const { extractAudioBuffer, extractWaveform } = await import('@/lib/waveform')
      try {
        const audio = await extractAudioBuffer(projectFile, () => token === mediaToken.current)
        if (token === mediaToken.current) { audioBufferRef.current = audio; setAudioReady(true); setPeaks(samplePeaks(audio)); setWaveformStatus(''); updateWork('media-import', '导入媒体', 'success', `已载入 ${file.name} 并提取音轨`, 1) }
      } catch {
        const waveform = await extractWaveform(projectFile, () => token === mediaToken.current)
        if (token === mediaToken.current) setPeaks(waveform)
        if (token === mediaToken.current) {
          setWaveformStatus(waveform.length ? '音高分析需要可解码的音轨。' : '此媒体没有可解码的音轨。')
          updateWork('media-import', '导入媒体', waveform.length ? 'success' : 'error', waveform.length ? `已载入 ${file.name}，波形已生成` : '媒体已载入，但无法提取音轨', 1)
        }
      }
    } catch {
      if (token === mediaToken.current) { setWaveformStatus('可继续播放和编辑；当前环境无法提取该媒体的波形。'); updateWork('media-import', '导入媒体', 'error', '媒体已载入，但波形提取失败') }
    }
  }

  useEffect(() => {
    const media = mediaRef.current
    if (media) {
      if (media.muted !== masterMuted) media.muted = masterMuted
      const volume = masterVolume / 100
      if (Math.abs(media.volume - volume) > 0.001) media.volume = volume
    }
    mixerRef.current?.setGain('original', trackEnabled.original, trackVolume.original)
    for (const kind of ['vocals', 'harmonies', 'accompaniment'] as const) {
      mixerRef.current?.setGain(kind, trackEnabled[kind] && !masterMuted, trackVolume[kind] * masterVolume / 100)
    }
  }, [trackEnabled, trackVolume, masterMuted, masterVolume, stemReady, mediaUrl])

  const toggleTrack = (kind: TrackKind) => {
    if (kind !== 'original' && !stemReady[kind]) return
    setTrackEnabled(current => ({ ...current, [kind]: !current[kind] }))
  }

  const analyzePitch = async (sourceResult: string | SeparationResult = pitchInputResultId, fromPipeline = false): Promise<PitchResult | null> => {
    const sourceResultId = typeof sourceResult === 'string' ? sourceResult : sourceResult.id
    const selectedInput = typeof sourceResult === 'string' ? separationResults.find(result => result.id === sourceResult) : sourceResult
    const buffer = audioBufferRef.current
    if (!buffer) { setPitchStatus('请先准备纯人声轨。'); setNotice('音高识别只使用纯人声轨。请先运行人声分离，或导入外部人声结果。'); return null }
    if (workflowExecutionRef.current && !fromPipeline) { setNotice('已有流程正在运行，请等待当前阶段完成。'); return null }
    const ownsLock = !workflowExecutionRef.current
    if (ownsLock) workflowExecutionRef.current = 'pitch'
    const algorithmLabel = installOptionLabels.pitchMethods[pitchAlgorithm]
    setPitchStatus(`正在使用 ${algorithmLabel} 分析连续音高…`)
    updateWork('pitch', '连续音高识别', 'running', `正在启动 ${algorithmLabel}…`, 0.02)
    await new Promise<void>(resolve => window.setTimeout(resolve, 0))
    try {
      const desktopResult = window.pitchordDesktop?.analyzePitch && projectDirectory
        ? await window.pitchordDesktop.analyzePitch(pitchAlgorithm, selectedInput?.vocals)
        : null
      const points = desktopResult?.points ?? analyzeAudioBuffer(buffer)
      setPitchPoints(points)
      const result: PitchResult = {
        id: crypto.randomUUID(), algorithm: pitchAlgorithm, label: algorithmLabel,
        createdAt: new Date().toISOString(), path: desktopResult?.path, device: desktopResult?.device, points,
        separationResultId: sourceResultId || undefined,
      }
      setPitchResults(current => [result, ...current])
      setActivePitchResultId(result.id)
      const voiced = points.filter(point => point.voiced)
      const deviceSuffix = desktopResult?.device ? ` · ${desktopResult.device}` : ''
      setPitchStatus(`${algorithmLabel} 已分析 ${points.length} 个时间点，其中 ${voiced.length} 个有声点${deviceSuffix}`)
      updateWork('pitch', '连续音高识别', 'success', `${algorithmLabel} 已生成 ${points.length} 个时间点${deviceSuffix}`, 1)
      setNotice('音高轨已生成。它是人工校对用的连续建议，可在句级和字级范围内复核。')
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : '请换用其他媒体格式。'
      if (taskWasCancelled(error)) {
        setPitchStatus('已取消音高识别')
        updateWork('pitch', '连续音高识别', 'cancelled', '已取消运行')
        return null
      }
      setPitchStatus(`音高分析失败：${message}`)
      updateWork('pitch', '连续音高识别', 'error', message)
      return null
    } finally { if (ownsLock) workflowExecutionRef.current = null }
  }
  const requestPitchAnalysis = () => {
    if (!vocalTrackReady) { if (window.pitchordDesktop?.separateVocals) setSeparationPromptOpen(true); else setNotice('请先导入纯人声轨。'); return }
    if (pitchResults.length && !pitchResults.some(result => result.algorithm === pitchAlgorithm)) { setRerunPrompt('pitch'); return }
    void analyzePitch()
  }

  const loadVocalTrack = async (file: File, persist = true, clearPitch = true) => {
    if (!file.type.startsWith('audio/')) { setNotice('人声分析轨需要音频文件。'); return }
    const token = ++vocalToken.current
    let projectFile = file
    if (persist && window.pitchordDesktop && projectDirectory) {
      try { projectFile = await copyAssetIntoProject('vocals', file) }
      catch (error) { setNotice(`人声分析轨复制到工程失败：${error instanceof Error ? error.message : String(error)}`); return }
    }
    try {
      const audio = await getMixer().load('vocals', projectFile)
      if (token !== vocalToken.current) return
      audioBufferRef.current = audio
      setVocalPeaks(samplePeaks(audio))
      setAcoustics(null)
      void analyzeVocalAcoustics(audio).then(result => {
        if (token === vocalToken.current) setAcoustics(result)
      }).catch(() => {
        if (token === vocalToken.current) setNotice('人声已载入；频谱分析暂不可用，时间轴仍可正常编辑。')
      })
      setAudioReady(true)
      setVocalTrackReady(true)
      setStemReady(current => ({ ...current, vocals: true }))
      setTrackEnabled({ original: false, vocals: true, harmonies: false, accompaniment: false })
      if (clearPitch) {
        setPitchPoints([])
        setActivePitchResultId('')
      }
      setPitchStatus(clearPitch ? `已载入人声分析轨：${file.name}` : pitchStatus)
      setNotice('人声分析轨已载入。点击“识别连续音高”开始匹配。')
    } catch { setNotice('无法解码这个人声分析轨，请换用 WAV、MP3 或浏览器支持的音频格式。') }
  }
  const loadAccompanimentTrack = async (file: File, persist = true) => {
    let projectFile = file
    if (persist && window.pitchordDesktop && projectDirectory) {
      try { projectFile = await copyAssetIntoProject('accompaniment', file) }
      catch (error) { setNotice(`伴奏轨复制到工程失败：${error instanceof Error ? error.message : String(error)}`); return }
    }
    try {
      await getMixer().load('accompaniment', projectFile)
      setStemReady(current => ({ ...current, accompaniment: true }))
      setNotice('纯伴奏音轨已载入，可与其他音轨单独或组合试听。')
    } catch { setNotice('无法解码伴奏轨，请换用 WAV 或 MP3。') }
  }
  const clearHarmonyTrack = () => {
    mixerRef.current?.unload('harmonies')
    setStemReady(current => ({ ...current, harmonies: false }))
    setTrackEnabled(current => ({ ...current, harmonies: false }))
  }
  const loadHarmonyTrack = async (file: File) => {
    try {
      await getMixer().load('harmonies', file)
      setStemReady(current => ({ ...current, harmonies: true }))
    } catch { clearHarmonyTrack(); setNotice('和声轨无法解码；主唱轨仍可继续用于音高和歌词对齐。') }
  }
  const runSeparation = async (fromPipeline = false): Promise<SeparationResult | null> => {
    if (!window.pitchordDesktop?.separateVocals || !mediaFileRef.current) { setSeparationStatus('需要桌面版和已导入媒体'); setNotice('请先导入原始音频或视频。'); return null }
    if (!projectDirectory) { pendingMediaRef.current = mediaFileRef.current; setNotice('请先新建工程，分离结果会保存到工程的 analysis 文件夹。'); void showNewProject(); return null }
    if (workflowExecutionRef.current && !fromPipeline) { setNotice('已有流程正在运行，请等待当前阶段完成。'); return null }
    const ownsLock = !workflowExecutionRef.current
    if (ownsLock) workflowExecutionRef.current = 'separation'
    setSeparationStatus('正在分离…')
    updateWork('separation', '人声分离', 'running', `正在准备 ${selectedSeparationModel?.label || separationModel}…`, 0.01)
    try {
      const source = await mediaFileRef.current.arrayBuffer()
      const result = await window.pitchordDesktop.separateVocals({ name: mediaFileRef.current.name, data: source, model: separationModel })
      if (!result) { setSeparationStatus('已取消'); return null }
      // Copy into a plain ArrayBuffer so the browser File constructor accepts
      // the bytes under TypeScript's stricter SharedArrayBuffer definitions.
      const vocalBytes = new Uint8Array(result.vocals.data.byteLength)
      vocalBytes.set(result.vocals.data)
      const accompanimentBytes = new Uint8Array(result.accompaniment.data.byteLength)
      accompanimentBytes.set(result.accompaniment.data)
      clearHarmonyTrack()
      await loadVocalTrack(new File([vocalBytes.buffer], result.vocals.name, { type: 'audio/wav' }), false)
      await loadAccompanimentTrack(new File([accompanimentBytes.buffer], result.accompaniment.name, { type: 'audio/wav' }), false)
      const savedResult: SeparationResult = {
        id: crypto.randomUUID(), modelId: separationModel, modelLabel: selectedSeparationModel?.label || separationModel,
        createdAt: new Date().toISOString(), vocals: result.vocals.path, accompaniment: result.accompaniment.path,
      }
      setSeparationResults(current => [savedResult, ...current])
      setActiveSeparationResultId(savedResult.id)
      setActiveVocalResultId(savedResult.id)
      setActiveAccompanimentResultId(savedResult.id)
      setPitchInputResultId(savedResult.id)
      setAlignmentInputResultId(savedResult.id)
      setTrackEnabled({ original: false, vocals: true, harmonies: false, accompaniment: false })
      setSeparationStatus(`${selectedSeparationModel?.label || separationModel} 已生成纯人声和纯伴奏`)
      updateWork('separation', '人声分离', 'success', `${selectedSeparationModel?.label || separationModel} 已生成纯人声和纯伴奏`, 1)
      void window.pitchordDesktop.analysisStatus().then(setAnalysisEnvironment)
      return savedResult
    } catch (error) {
      if (taskWasCancelled(error)) {
        setSeparationStatus('已取消')
        updateWork('separation', '人声分离', 'cancelled', '已取消运行')
        return null
      }
      setSeparationStatus('运行失败')
      updateWork('separation', '人声分离', 'error', error instanceof Error ? error.message : '请检查分离模型配置。')
      setNotice(`人声分离失败：${error instanceof Error ? error.message : '请检查 Demucs 和模型配置。'}`)
      return null
    } finally { if (ownsLock) workflowExecutionRef.current = null }
  }

  const runHarmonySeparation = async (source: SeparationResult, fromPipeline = false): Promise<SeparationResult | null> => {
    if (!window.pitchordDesktop?.separateHarmonies || !projectDirectory) { setNotice('去和声需要先打开桌面工程。'); return null }
    if (!selectedHarmonyModel?.ready || selectedHarmonyModel.runnable === false) { setNotice('请先在模型管理中准备去和声模型。'); setModelManagerOpen(true); return null }
    if (source.harmonies) { setNotice('这条结果已经分离了和声；请选择未处理的原人声结果重试。'); return null }
    if (workflowExecutionRef.current && !fromPipeline) { setNotice('已有流程正在运行，请等待当前阶段完成。'); return null }
    const ownsLock = !workflowExecutionRef.current
    if (ownsLock) workflowExecutionRef.current = 'harmony'
    updateWork('harmony', '提取主唱并剥离和声', 'running', `正在准备 ${selectedHarmonyModel.label}…`, 0.01)
    try {
      const result = await window.pitchordDesktop.separateHarmonies({ vocals: source.vocals, model: harmonyModelId })
      const leadBytes = new Uint8Array(result.lead.data.byteLength); leadBytes.set(result.lead.data)
      const harmonyBytes = new Uint8Array(result.harmonies.data.byteLength); harmonyBytes.set(result.harmonies.data)
      await loadVocalTrack(new File([leadBytes.buffer], result.lead.name, { type: 'audio/wav' }), false)
      await loadHarmonyTrack(new File([harmonyBytes.buffer], result.harmonies.name, { type: 'audio/wav' }))
      const refined: SeparationResult = {
        id: crypto.randomUUID(), modelId: source.modelId, modelLabel: `${source.modelLabel} · 去和声`,
        createdAt: new Date().toISOString(), vocals: result.lead.path, accompaniment: source.accompaniment,
        harmonies: result.harmonies.path, sourceVocals: source.vocals, sourceResultId: source.id, harmonyModelId: result.modelId,
      }
      setSeparationResults(current => [refined, ...current])
      setHarmonyEnabled(true)
      setActiveSeparationResultId(refined.id)
      setActiveVocalResultId(refined.id)
      setPitchInputResultId(refined.id)
      setAlignmentInputResultId(refined.id)
      setActiveAlignmentResultId('')
      setAlignmentStatus('主唱轨已更新；需要重新匹配歌词时间')
      setSeparationStatus('已提取主唱，和声作为独立试听轨保留')
      updateWork('harmony', '提取主唱并剥离和声', 'success', '主唱已设为音高和歌词对齐输入', 1)
      setNotice('主唱已作为后续分析输入；和声可在试听音轨中单独打开。旧人声结果仍可切回。')
      return refined
    } catch (error) {
      if (taskWasCancelled(error)) updateWork('harmony', '提取主唱并剥离和声', 'cancelled', '已取消运行')
      else { updateWork('harmony', '提取主唱并剥离和声', 'error', error instanceof Error ? error.message : String(error)); setNotice(`去和声失败：${error instanceof Error ? error.message : String(error)}`) }
      return null
    } finally { if (ownsLock) workflowExecutionRef.current = null }
  }

  const requestSeparation = () => {
    if (separationResults.length && !separationResults.some(result => result.modelId === separationModel)) { setRerunPrompt('separation'); return }
    void runSeparation()
  }

  const selectStemResult = async (kind: 'vocals' | 'accompaniment', id: string, useForPitch = false) => {
    const result = separationResults.find(item => item.id === id)
    if (!result || !window.pitchordDesktop?.readAnalysisFile) return false
    try {
      const file = kind === 'vocals' ? result.vocals : result.accompaniment
      const data = await window.pitchordDesktop.readAnalysisFile(file)
      const bytes = new Uint8Array(data.byteLength); bytes.set(data)
      if (kind === 'vocals') {
        await loadVocalTrack(new File([bytes.buffer], file.split(/[\\/]/).at(-1) || 'vocals.wav', { type: 'audio/wav' }), false, false)
        if (result.harmonies) {
          const harmonyData = await window.pitchordDesktop.readAnalysisFile(result.harmonies)
          const harmonyBytes = new Uint8Array(harmonyData.byteLength); harmonyBytes.set(harmonyData)
          await loadHarmonyTrack(new File([harmonyBytes.buffer], result.harmonies.split(/[\\/]/).at(-1) || 'harmonies.wav', { type: 'audio/wav' }))
        } else clearHarmonyTrack()
        setActiveVocalResultId(id)
        if (useForPitch) {
          setPitchInputResultId(id)
          const matchingPitch = pitchResults.find(item => item.id === activePitchResultId && item.separationResultId === id)
            ?? pitchResults.find(item => item.separationResultId === id)
          setPitchPoints(matchingPitch?.points ?? [])
          setActivePitchResultId(matchingPitch?.id ?? '')
          setPitchStatus(matchingPitch ? `当前使用 ${matchingPitch.label} 的 ${matchingPitch.points.length} 个音高时间点` : '当前人声结果尚未分析音高')
        }
        await window.pitchordDesktop.activateVocalResult({ vocals: result.vocals, harmonies: result.harmonies })
      } else {
        await loadAccompanimentTrack(new File([bytes.buffer], file.split(/[\\/]/).at(-1) || 'accompaniment.wav', { type: 'audio/wav' }), false)
        setActiveAccompanimentResultId(id)
      }
      setActiveSeparationResultId(kind === 'vocals' ? id : activeSeparationResultId)
      setSeparationStatus(`已为${kind === 'vocals' ? '纯人声' : '纯伴奏'}选择 ${result.modelLabel}`)
      setNotice(kind === 'vocals' && useForPitch ? '已切换音高识别输入和纯人声试听轨。' : `已切换${kind === 'vocals' ? '纯人声' : '纯伴奏'}试听结果。`)
      return true
    } catch (error) { setNotice(`切换分离结果失败：${error instanceof Error ? error.message : String(error)}`); return false }
  }

  const selectPitchInput = async (id: string) => {
    return selectStemResult('vocals', id, true)
  }

  const selectAlignmentInput = async (id: string) => {
    setAlignmentInputResultId(id)
    await selectStemResult('vocals', id)
  }

  const selectPitchResult = (id: string) => {
    const result = pitchResults.find(item => item.id === id)
    if (!result) return
    setActivePitchResultId(id)
    setPitchPoints(result.points)
    setPitchStatus(`当前使用 ${result.label} 的 ${result.points.length} 个音高时间点`)
    setNotice('已切换音高识别结果，字级匹配和字幕将立即使用该结果。')
  }

  const runLyricAlignment = async (inputOverride?: SeparationResult, pitchOverride?: PitchResult, fromPipeline = false): Promise<AlignmentResult | null> => {
    if (!window.pitchordDesktop?.alignLyrics || !projectDirectory) { setNotice('歌词时间戳匹配需要先创建工程并使用桌面版。'); return null }
    if (!segments.length) { setNotice('请先导入或粘贴歌词。'); return null }
    const input = inputOverride ?? separationResults.find(result => result.id === alignmentInputResultId)
    if (!input) { setNotice('请选择歌词匹配所用的纯人声结果。'); return null }
    if (workflowExecutionRef.current && !fromPipeline) { setNotice('已有流程正在运行，请等待当前阶段完成。'); return null }
    const ownsLock = !workflowExecutionRef.current
    if (ownsLock) workflowExecutionRef.current = 'alignment'
    setAlignmentStatus('正在识别人声并匹配歌词…')
    updateWork('alignment', '歌词时间戳匹配', 'running', '正在准备带字词时间戳的语音识别…', 0.01)
    try {
      const matchingPitch = pitchOverride ?? pitchResults.find(item => item.id === activePitchResultId && item.separationResultId === input.id)
      const result = await window.pitchordDesktop.alignLyrics({ segments, duration, model: alignmentModel, language: alignmentLanguage, vocals: input.vocals, pitchPoints: matchingPitch?.points })
      const modelLabel = analysisEnvironment?.alignment.models.find(model => model.id === alignmentModel)?.label || alignmentModel
      const saved: AlignmentResult = {
        id: crypto.randomUUID(), modelId: alignmentModel, modelLabel, createdAt: new Date().toISOString(),
        inputResultId: input.id, path: result.path, coverage: result.coverage, lowConfidenceLines: result.lowConfidenceLines, segments: result.segments,
      }
      setAlignmentResults(current => [saved, ...current])
      setActiveAlignmentResultId(saved.id)
      commit(mergeAlignmentKeepingLocks(carryPitchOverrides(result.segments, segments), segments))
      setSelectedLineIds([])
      setSelectedCharIds([])
      const uncertain = result.lowConfidenceLines || []
      setAlignmentStatus(`${modelLabel} 已匹配，覆盖率 ${Math.round(result.coverage * 100)}% · ${uncertain.length} 句建议复核`)
      const reviewLines = uncertain.slice(0, 8).map(index => index + 1).join('、')
      setNotice(`歌词时间建议已应用到句级和字级时间块。${uncertain.length ? `第 ${reviewLines}${uncertain.length > 8 ? ' 等' : ''} 句缺少可靠识别，请重点复核。` : '可立即人工复核。'}撤回会恢复应用前的时间。`)
      updateWork('alignment', '歌词时间戳匹配', 'success', `${modelLabel} 已完成匹配，覆盖率 ${Math.round(result.coverage * 100)}%`, 1)
      return saved
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (taskWasCancelled(error)) {
        setAlignmentStatus('已取消歌词时间戳匹配')
        updateWork('alignment', '歌词时间戳匹配', 'cancelled', '已取消运行')
        return null
      }
      setAlignmentStatus(`匹配失败：${message}`)
      updateWork('alignment', '歌词时间戳匹配', 'error', message)
      return null
    } finally { if (ownsLock) workflowExecutionRef.current = null }
  }

  const requestLyricAlignment = () => {
    if (alignmentResults.length && !alignmentResults.some(result => result.modelId === alignmentModel)) { setRerunPrompt('alignment'); return }
    void runLyricAlignment()
  }

  const selectAlignmentResult = (id: string) => {
    const result = alignmentResults.find(item => item.id === id)
    if (!result) return
    setActiveAlignmentResultId(id)
    commit(mergeAlignmentKeepingLocks(carryPitchOverrides(result.segments, segments), segments))
    setAlignmentStatus(`${result.modelLabel} 的历史匹配结果已应用，覆盖率 ${Math.round(result.coverage * 100)}% · ${result.lowConfidenceLines?.length || 0} 句建议复核`)
    setNotice('已切换并应用歌词时间戳匹配结果，可通过撤回返回切换前的时间。')
  }

  const openEnvironmentSetup = () => {
    setEnvironmentInstallState(analysisEnvironmentBusy ? 'running' : 'idle')
    setEnvironmentMode(analysisEnvironment?.runtimePreference || 'managed')
    setEnvironmentRootDraft(analysisEnvironment?.root || analysisEnvironment?.defaultRoot || '')
    setExistingEnvironmentDraft(analysisEnvironment?.runtimePreference === 'existing' ? analysisEnvironment.root : '')
    setExistingEnvironmentError('')
    setExternalPythonDraft(analysisEnvironment?.runtimePreference === 'custom' ? analysisEnvironment.path : '')
    setComputeProfileDraft(analysisEnvironment?.computeProfile || 'auto')
    setRepairEnvironmentOpen(true)
  }

  const applyInstallPreset = (preset: keyof typeof installPresets) => {
    setInstallPreset(preset)
    setInstallSelectionDraft(copyInstallSelection(installPresets[preset]))
  }

  const toggleInstallOption = (group: keyof InstallSelection, id: string) => {
    setInstallPreset('custom')
    setInstallSelectionDraft(current => {
      const values = current[group] as string[]
      return { ...current, [group]: values.includes(id) ? values.filter(value => value !== id) : [...values, id] } as InstallSelection
    })
  }

  const installSelectionComplete = installSelectionDraft.pitchMethods.length > 0 && installSelectionDraft.separationModels.length > 0 && installSelectionDraft.alignmentModels.length > 0
  const estimatedInstallBytes = useMemo(() => {
    const computeMegabytes = computeProfileDraft === 'cuda121' || (computeProfileDraft === 'auto' && !!analysisEnvironment?.detectedGpu) ? 4300 : 1600
    const optionMegabytes = (Object.keys(installSelectionDraft) as Array<keyof InstallSelection>).reduce((sum, group) => sum + (installSelectionDraft[group] as string[]).reduce((groupSum, id) => groupSum + ((installOptionSizes[group] as Record<string, number>)[id] || 0), 0), 0)
    return (computeMegabytes + optionMegabytes) * 1024 * 1024
  }, [analysisEnvironment?.detectedGpu, computeProfileDraft, installSelectionDraft])

  const installAnalysisRuntime = async () => {
    if (!window.pitchordDesktop?.installAnalysisRuntime) return
    setEnvironmentInstallState('running')
    setAnalysisEnvironmentBusy(true)
    setEnvironmentProgress(null)
    setAnalysisProgress('正在规划完整环境安装…')
    updateWork('environment', '准备完整分析环境', 'running', '正在检查 Python、计算组件、分析依赖和推荐模型…', 0)
    try {
      const status = await window.pitchordDesktop.installAnalysisRuntime({ root: environmentRootDraft, computeProfile: computeProfileDraft, installSelection: installSelectionDraft })
      setAnalysisEnvironment(status)
      setEnvironmentInstallState('success')
      setEnvironmentRootDraft(status.root)
      setSeparationModel(current => status.separationModels.some(model => model.id === current && model.ready && model.runnable !== false) ? current : status.separationModels.find(model => model.ready && model.runnable !== false)?.id || current)
      setPitchAlgorithm(current => status.pitchMethods.some(method => method.id === current && method.ready && method.runnable !== false) ? current : (status.pitchMethods.find(method => method.ready && method.runnable !== false && ['pyin', 'torchcrepe', 'rmvpe', 'fcpe'].includes(method.id))?.id as PitchAlgorithm | undefined) || current)
      setAlignmentModel(current => status.alignment.models.some(model => model.id === current && model.ready) ? current : status.alignment.models.find(model => model.ready)?.id || current)
      setAnalysisProgress('完整分析环境与所选模型已准备完成')
      updateWork('environment', '准备完整分析环境', 'success', 'Python、分析依赖、人声模型和歌词模型已全部准备完成', 1)
      setNotice('Pitchord 完整分析环境已准备完成，可直接运行默认流程。')
    } catch (error) {
      setEnvironmentInstallState(taskWasCancelled(error) ? 'idle' : 'error')
      setAnalysisProgress(error instanceof Error ? error.message : String(error))
      updateWork('environment', '准备分析环境', taskWasCancelled(error) ? 'cancelled' : 'error', taskWasCancelled(error) ? '环境准备已取消' : error instanceof Error ? error.message : String(error))
      setNotice(`分析环境安装失败：${error instanceof Error ? error.message : String(error)}`)
    } finally { setAnalysisEnvironmentBusy(false) }
  }

  const applyExternalPython = async () => {
    if (!window.pitchordDesktop?.configureAnalysisEnvironment || !externalPythonDraft) return
    setAnalysisEnvironmentBusy(true)
    updateWork('environment-check', '检测现有 Python', 'running', '正在检查 Python 版本和分析组件…')
    try {
      const status = await window.pitchordDesktop.configureAnalysisEnvironment({ mode: 'custom', pythonPath: externalPythonDraft })
      setAnalysisEnvironment(status)
      setEnvironmentMode(status.runtimePreference)
      setEnvironmentRootDraft(status.root)
      setExistingEnvironmentDraft(status.runtimePreference === 'existing' ? status.root : '')
      setRepairEnvironmentOpen(false)
      const complete = status.completeReady
      updateWork('environment-check', '检测现有 Python', complete ? 'success' : 'error', complete ? '现有分析环境可以直接使用' : 'Python 已选定，但仍缺少部分分析组件或模型', 1)
      setNotice(status.runtimePreference === 'existing' ? `已自动识别并复用整套旧环境：${status.root}。${complete ? '' : '部分组件或模型仍需检查。'}` : complete ? '已切换到现有 Python 环境。' : '已记录 Python 环境；模型仍从当前 environment 目录读取，请检查模型状态。')
    } catch (error) {
      updateWork('environment-check', '检测现有 Python', 'error', error instanceof Error ? error.message : String(error))
      setNotice(`无法使用所选 Python：${error instanceof Error ? error.message : String(error)}`)
    } finally { setAnalysisEnvironmentBusy(false) }
  }

  const prepareAnalysisModel = async (modelId = separationModel) => {
    if (!window.pitchordDesktop?.prepareAnalysisModel) return
    setAnalysisEnvironmentBusy(true)
    setAnalysisProgress('正在启动模型准备…')
    try {
      const model = analysisEnvironment?.separationModels.find(item => item.id === modelId)
      const status = await window.pitchordDesktop.prepareAnalysisModel(modelId)
      setAnalysisEnvironment(status)
      setAnalysisProgress(`${model?.label || modelId} 模型已准备完成`)
      setNotice(`${model?.label || modelId} 已保存到 Pitchord 的模型目录。`)
    } catch (error) {
      setAnalysisProgress('模型准备未完成')
      setNotice(`模型准备失败：${error instanceof Error ? error.message : String(error)}`)
    } finally { setAnalysisEnvironmentBusy(false) }
  }

  const applyExistingEnvironment = async () => {
    if (!window.pitchordDesktop?.configureAnalysisEnvironment || !existingEnvironmentDraft) return
    setExistingEnvironmentError('')
    setAnalysisEnvironmentBusy(true)
    updateWork('environment-check', '复用已有环境', 'running', '正在检查旧环境中的 Python、计算组件和模型…')
    try {
      const status = await window.pitchordDesktop.configureAnalysisEnvironment({ mode: 'existing', root: existingEnvironmentDraft })
      setAnalysisEnvironment(status)
      setEnvironmentMode('existing')
      setEnvironmentRootDraft(status.root)
      setExternalPythonDraft(status.path)
      setInstallSelectionDraft(copyInstallSelection(status.installSelection))
      setSeparationModel(current => status.separationModels.some(model => model.id === current && model.ready) ? current : status.separationModels.find(model => model.ready)?.id || current)
      setPitchAlgorithm(current => status.pitchMethods.some(method => method.id === current && method.ready) ? current : (status.pitchMethods.find(method => method.ready && ['pyin', 'torchcrepe', 'rmvpe', 'fcpe'].includes(method.id))?.id as PitchAlgorithm | undefined) || current)
      setAlignmentModel(current => status.alignment.models.some(model => model.id === current && model.ready) ? current : status.alignment.models.find(model => model.ready)?.id || current)
      updateWork('environment-check', '复用已有环境', status.completeReady ? 'success' : 'error', status.completeReady ? '旧环境中的 Python 和所选模型均可使用' : '已切换目录，但仍有组件或模型未准备好', 1)
      setNotice(status.completeReady ? '已复用整套旧环境，无需重新下载。' : '已切换到旧环境；请查看下方模型检查结果，缺失项可在模型管理中补充。')
      if (status.completeReady) setRepairEnvironmentOpen(false)
    } catch (error) {
      updateWork('environment-check', '复用已有环境', 'error', error instanceof Error ? error.message : String(error))
      setExistingEnvironmentError(error instanceof Error ? error.message : String(error))
      setNotice(`无法复用所选环境：${error instanceof Error ? error.message : String(error)}`)
    } finally { setAnalysisEnvironmentBusy(false) }
  }

  const prepareHarmonyModel = async (modelId = harmonyModelId) => {
    if (!window.pitchordDesktop?.prepareHarmonyModel) return
    setAnalysisEnvironmentBusy(true)
    setAnalysisProgress('正在准备去和声模型…')
    try {
      const status = await window.pitchordDesktop.prepareHarmonyModel(modelId)
      setAnalysisEnvironment(status)
      setAnalysisProgress('去和声模型已准备完成')
      setNotice('去和声模型已保存到 Pitchord 环境；现在可以从现有人声结果提取主唱。')
    } catch (error) {
      setAnalysisProgress('去和声模型准备未完成')
      setNotice(`去和声模型准备失败：${error instanceof Error ? error.message : String(error)}`)
    } finally { setAnalysisEnvironmentBusy(false) }
  }

  const removeHarmonyModel = async (id: string) => {
    if (!window.pitchordDesktop?.removeHarmonyModel) return
    try {
      setAnalysisEnvironment(await window.pitchordDesktop.removeHarmonyModel(id))
      setPendingModelRemoval(null)
      setNotice('去和声模型已从 Pitchord 环境移除；工程中的主唱与和声结果仍保留。')
    } catch (error) { setNotice(`删除去和声模型失败：${error instanceof Error ? error.message : String(error)}`) }
  }

  const prepareAlignmentModel = async (modelId = alignmentModel) => {
    if (!window.pitchordDesktop?.prepareAlignmentModel) return
    setAnalysisEnvironmentBusy(true)
    setAnalysisProgress('正在准备歌词对齐模型…')
    try {
      const model = analysisEnvironment?.alignment.models.find(item => item.id === modelId)
      const status = await window.pitchordDesktop.prepareAlignmentModel(modelId)
      setAnalysisEnvironment(status)
      setAnalysisProgress(`${model?.label || modelId} 已准备完成`)
      setNotice(`${model?.label || modelId} 已保存在 Pitchord/environment/models/whisper。`)
    } catch (error) {
      setAnalysisProgress('歌词对齐模型准备未完成')
      setNotice(`歌词对齐模型准备失败：${error instanceof Error ? error.message : String(error)}`)
    } finally { setAnalysisEnvironmentBusy(false) }
  }

  const removeAlignmentModel = async (id: string) => {
    if (!window.pitchordDesktop?.removeAlignmentModel) return
    try {
      setAnalysisEnvironment(await window.pitchordDesktop.removeAlignmentModel(id))
      setPendingModelRemoval(null)
      setNotice('歌词对齐模型已从 Pitchord 环境中删除。')
    } catch (error) { setNotice(`删除模型失败：${error instanceof Error ? error.message : String(error)}`) }
  }

  const importAnalysisModel = async (kind: 'separation' | 'harmony' | 'pitch' = 'separation') => {
    if (!window.pitchordDesktop?.importAnalysisModel) return
    try {
      const status = await window.pitchordDesktop.importAnalysisModel(kind)
      if (!status) return
      setAnalysisEnvironment(status)
      setNotice(`${kind === 'separation' ? '人声分离' : kind === 'harmony' ? '去和声' : '音高'}模型文件已复制到 Pitchord 的 environment/models。原始文件不会被移动或修改。`)
    } catch (error) { setNotice(`导入模型失败：${error instanceof Error ? error.message : String(error)}`) }
  }

  const removeAnalysisModel = async (id: string) => {
    if (!window.pitchordDesktop?.removeAnalysisModel) return
    try {
      const status = await window.pitchordDesktop.removeAnalysisModel(id)
      setAnalysisEnvironment(status)
      if (separationModel === id) setSeparationModel(status.separationModels.find(model => model.ready && model.runnable !== false)?.id || 'htdemucs')
      setPendingModelRemoval(null)
      setNotice('模型已从 Pitchord 管理的环境中删除，原始导入文件未受影响。')
    } catch (error) { setNotice(`删除模型失败：${error instanceof Error ? error.message : String(error)}`) }
  }

  const openStorageManager = async () => {
    if (!window.pitchordDesktop?.analysisStorageStatus) return
    setStorageOpen(true)
    setCleanupTarget(null)
    try { setAnalysisStorage(await window.pitchordDesktop.analysisStorageStatus()) }
    catch { setNotice('无法读取分析环境占用空间。') }
  }

  const removeAnalysisData = async () => {
    if (!cleanupTarget || !window.pitchordDesktop?.removeAnalysisData) return
    setCleanupBusy(true)
    try {
      const storage = await window.pitchordDesktop.removeAnalysisData(cleanupTarget)
      setAnalysisStorage(storage)
      const status = await window.pitchordDesktop.analysisStatus()
      setAnalysisEnvironment(status)
      setAnalysisProgress(status.runtimeReady ? '分析环境可用' : '分析环境尚未安装')
      setNotice(cleanupTarget === 'all' ? '已删除 Pitchord 管理的分析环境、模型和缓存。歌词工程未受影响。' : '所选分析数据已删除。')
      setCleanupTarget(null)
    } catch (error) { setNotice(`清理失败：${error instanceof Error ? error.message : String(error)}`) }
    finally { setCleanupBusy(false) }
  }

  const seek = (time: number) => {
    auditionRef.current = null
    rightEdgeAuditionRef.current = false
    const next = clamp(time, 0, duration)
    if (mediaRef.current) mediaRef.current.currentTime = next
    setPlayhead(next)
  }
  const skipPlayback = (seconds: number) => seek(playhead + seconds)
  const toggleMasterMute = () => setMasterMuted(current => !current)
  const changeMasterVolume = (value: number) => {
    setMasterVolume(value)
    if (value > 0) setMasterMuted(false)
  }
  const openFullscreenPreview = () => {
    const preview = videoPreviewRef.current
    if (mediaIsVideo && preview?.requestFullscreen) void preview.requestFullscreen().catch(() => setNotice('当前系统无法进入全屏预览。'))
  }
  const seekAndPlay = async (time: number) => {
    const focused = view === 'lines' ? rangeDraft : charRangeDraft
    auditionRef.current = editingLocked && focused ? { start: focused.start, end: focused.end } : null
    const next = focused && editingLocked ? clamp(time, focused.start, focused.end) : clamp(time, 0, duration)
    setGuideLine(next)
    if (mediaRef.current) {
      timelineSeekRef.current = true
      mediaRef.current.currentTime = next
      window.setTimeout(() => { timelineSeekRef.current = false }, 250)
      try { await mediaRef.current.play() } catch { setNotice('媒体无法播放，请确认文件格式受支持。') }
    }
    setPlayhead(next)
  }
  const playMediaSafely = (media: HTMLMediaElement) => {
    void media.play().catch(error => {
      if (error instanceof Error && error.name === 'AbortError') return
      setNotice('媒体无法播放，请确认文件格式受支持。')
    })
  }
  const playNormally = (time: number, message: string) => {
    const media = mediaRef.current
    if (!media) { setNotice('请先重新导入原媒体，才能试听。'); return }
    auditionRef.current = null
    rightEdgeAuditionRef.current = false
    media.currentTime = time
    setPlayhead(time)
    playMediaSafely(media)
    setNotice(message)
  }
  const loopRange = (start: number, end: number, message: string) => {
    const media = mediaRef.current
    if (!media) { setNotice('请先重新导入原媒体，才能试听。'); return }
    rightEdgeAuditionRef.current = false
    lastRangeEdgeRef.current = null
    auditionRef.current = { start, end }
    media.currentTime = start
    setPlayhead(start)
    playMediaSafely(media)
    setNotice(message)
  }
  async function togglePlayback() {
    const media = mediaRef.current
    if (!media) return
    if (!editingLocked) {
      auditionRef.current = null
      rightEdgeAuditionRef.current = false
    }
    if (media.paused) { try { await media.play() } catch { setNotice('媒体无法播放，请确认文件格式受支持。') } }
    else media.pause()
  }
  useEffect(() => { togglePlaybackRef.current = togglePlayback })

  const importLyrics = async (content: string, sourceName = 'pasted.txt') => {
    if (!duration) { setNotice('请先导入媒体，获取时长后再导入歌词。'); return }
    const next = parseLyrics(content, duration)
    if (!next.length) { setNotice('没有识别到歌词行，请检查文本或时间格式。'); return }
    if (projectDirectory && window.pitchordDesktop) {
      try { await window.pitchordDesktop.storeLyricsSource(sourceName, content) }
      catch (error) { setNotice(`歌词原稿备份失败，导入已取消：${error instanceof Error ? error.message : String(error)}`); return }
    }
    commit(next)
    setRepeatedSections([])
    setSelectedLineIds([next[0].id])
    setSelectedCharIds([])
    setImportOpen(false)
    setImportDraft('')
    setNotice(`已导入 ${next.length} 句。请试听并调整每句范围。`)
  }

  const restoreLyricsBackup = async () => {
    if (!window.pitchordDesktop || !projectDirectory) return
    try {
      const selected = await window.pitchordDesktop.pickLyricsBackup()
      if (!selected) return
      const backup = JSON.parse(selected.content) as Draft
      if (!Array.isArray(backup.segments) || !Number.isFinite(backup.duration) || Math.abs(backup.duration - duration) > 0.3 ||
          !backup.segments.every(segment => typeof segment.id === 'string' && typeof segment.text === 'string' && Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.start >= 0 && segment.end <= duration + 0.3 && segment.end > segment.start && Array.isArray(segment.chars))) throw new Error('备份内容与当前媒体不匹配。')
      commit(backup.segments)
      setRepeatedSections(Array.isArray(backup.repeatedSections) ? backup.repeatedSections : [])
      setSelectedLineIds(backup.segments[0] ? [backup.segments[0].id] : [])
      setSelectedCharIds([])
      setView('lines')
      setNotice(`已恢复 ${selected.name}，可以使用撤回返回恢复前。`)
    } catch (error) { setNotice(`恢复歌词失败：${error instanceof Error ? error.message : String(error)}`) }
  }

  const selectLine = (id: string, additive: boolean, range: boolean) => {
    if (editingLocked) return
    lyricListTargetRef.current = id
    setSelectedLineIds(current => {
      if (range && current.length) {
        const anchor = segments.findIndex(segment => segment.id === current[current.length - 1])
        const target = segments.findIndex(segment => segment.id === id)
        if (anchor >= 0 && target >= 0) return segments.slice(Math.min(anchor, target), Math.max(anchor, target) + 1).map(segment => segment.id)
      }
      return additive ? current.includes(id) ? current.filter(item => item !== id) : [...current, id] : [id]
    })
  }
  const selectChar = (id: string, additive: boolean, range: boolean) => {
    if (editingLocked) return
    const chars = activeLine?.chars ?? []
    setSelectedCharIds(current => {
      if (range && current.length) {
        const anchor = chars.findIndex(char => char.id === current[current.length - 1])
        const target = chars.findIndex(char => char.id === id)
        if (anchor >= 0 && target >= 0) return chars.slice(Math.min(anchor, target), Math.max(anchor, target) + 1).map(char => char.id)
      }
      return additive ? current.includes(id) ? current.filter(item => item !== id) : [...current, id] : [id]
    })
  }

  const addLineAt = (at = playhead) => {
    if (editingLocked) return
    if (!duration) { setNotice('请先导入媒体。'); return }
    const ordered = [...segments].sort((a, b) => a.start - b.start)
    const containing = ordered.find(segment => segment.start < at && segment.end > at)
    const previous = containing ?? [...ordered].reverse().find(segment => segment.end <= at)
    const next = ordered.find(segment => segment.start >= at)
    const start = Math.max(at, previous?.end ?? 0)
    const end = Math.min(start + 3, next?.start ?? duration)
    if (end - start < MIN_SPAN) { setNotice('播放头附近没有可用空隙，请先调整相邻句范围。'); return }
    const added = createSegment('新歌词', start, end)
    commit([...segments, added].sort((a, b) => a.start - b.start))
    setSelectedLineIds([added.id])
    setNotice('已添加一句。可修改文本或拖动左右边界。')
  }
  const selectedLineRightEdge = (ids: string[]) => {
    const selected = segments.filter(segment => ids.includes(segment.id))
    return selected.length ? Math.max(...selected.map(segment => segment.end)) : null
  }
  const addLine = () => addLineAt(selectedLineRightEdge(selectedLineIds) ?? playhead)

  const mergeSelected = () => {
    if (editingLocked) return
    if (!mergeIndexes) return
    const merged = mergeSegments(mergeIndexes.map(index => segments[index]))
    if (!merged) return
    const next = [...segments]
    next.splice(mergeIndexes[0], mergeIndexes.length, merged)
    commit(next)
    setSelectedLineIds([merged.id])
    setNotice('已合并相邻歌词，时间范围与字级信息同步保留。')
  }

  const openSplit = () => {
    if (editingLocked) return
    if (!activeLine || !splitBoundaries.length) return
    const markedTime = guideLine !== null && guideLine > activeLine.start + MIN_SPAN && guideLine < activeLine.end - MIN_SPAN ? guideLine : null
    let time = markedTime ?? (playhead > activeLine.start + MIN_SPAN && playhead < activeLine.end - MIN_SPAN ? playhead : (activeLine.start + activeLine.end) / 2)
    if (markedTime === null && time === (activeLine.start + activeLine.end) / 2 && peaks.length && duration) {
      const center = time
      const from = Math.max(activeLine.start + 0.15, center - 0.8)
      const to = Math.min(activeLine.end - 0.15, center + 0.8)
      let best = Number.POSITIVE_INFINITY
      for (let candidate = from; candidate <= to; candidate += 0.025) {
        const index = Math.floor(candidate / duration * peaks.length)
        const energy = (peaks[index - 1] ?? 0) + (peaks[index] ?? 0) + (peaks[index + 1] ?? 0)
        const score = energy + Math.abs(candidate - center) * 0.08
        if (score < best) { best = score; time = candidate }
      }
    }
    const position = (time - activeLine.start) / (activeLine.end - activeLine.start)
    const suggestion = suggestSplitOffset(activeLine.text, splitBoundaries, position) ?? splitBoundaries[0]
    setSplitTimeDraft(formatTime(time))
    setSplitOffset(String(suggestion))
    setSplitOpen(true)
  }
  const confirmSplit = () => {
    if (editingLocked) return
    if (!activeLine) return
    const time = parseTime(splitTimeDraft)
    const result = time === null ? null : splitSegment(activeLine, time, Number(splitOffset))
    if (!result) { setNotice('分割点需位于句内，文字也必须分成两段。'); return }
    const index = segments.findIndex(segment => segment.id === activeLine.id)
    const next = [...segments]
    next.splice(index, 1, ...result)
    commit(next)
    setSelectedLineIds([result[0].id])
    setGuideLine(null)
    setSplitOpen(false)
    setNotice('已按时间和文字边界分割，左右两句可继续调整。')
  }

  const deleteSelected = () => {
    if (editingLocked) return
    if (!selectedLineIds.length) return
    commit(segments.filter(segment => !selectedLineIds.includes(segment.id)))
    setSelectedLineIds([])
    setNotice('已删除选中的歌词标注，原媒体未改变。')
  }

  const updateLineText = () => {
    if (editingLocked) return
    if (!activeLine || textDraft === activeLine.text) return
    const hadLocks = activeLine.chars.some(char => char.startLocked || char.endLocked)
    const next = segments.map(segment => segment.id === activeLine.id ? replaceText(segment, textDraft) : segment)
    commit(next)
    setNotice(`歌词文本已更新；新增或改写的字已生成时间建议，请复核。${hadLocks ? '保留的相同字沿用锁定状态，改写字的锁定状态可能失效。' : ''}`)
  }

  const updateLineTimes = () => {
    if (editingLocked) return
    if (!activeLine) return
    if (activeLine.chars.some(char => char.startLocked || char.endLocked)) { setStartDraft(formatTime(activeLine.start)); setEndDraft(formatTime(activeLine.end)); setNotice('本句含锁定的逐字边界，不能整体移动或缩放；请先解锁。'); return }
    const start = parseTime(startDraft)
    const end = parseTime(endDraft)
    const index = segments.findIndex(segment => segment.id === activeLine.id)
    const min = index > 0 ? segments[index - 1].end : 0
    const max = index < segments.length - 1 ? segments[index + 1].start : duration
    if (start === null || end === null || start < min || end > max || end - start < MIN_SPAN) {
      setStartDraft(formatTime(activeLine.start)); setEndDraft(formatTime(activeLine.end))
      setNotice('时间格式需为 分:秒.毫秒，且不能越过相邻歌词。')
      return
    }
    commit(segments.map(segment => segment.id === activeLine.id ? retimeSegment(segment, start, end) : segment))
  }

  const hasLineConflict = (range: TimelinePreview) => segments.some(segment => segment.id !== range.id && segment.end > range.start && segment.start < range.end)

  const applyRangeResult = (range: TimelinePreview, strategy: 'compress' | 'push') => {
    const previews = resolveRangeConflict(segments, range, { start: 0, end: duration }, strategy)
    if (!previews) return false
    if (segments.some(segment => segment.chars.some(char => char.startLocked || char.endLocked) && previews.some(item => item.id === segment.id && (Math.abs(item.start - segment.start) > 0.001 || Math.abs(item.end - segment.end) > 0.001)))) return false
    commit(segments.map(segment => {
      const next = previews.find(item => item.id === segment.id)!
      return next.start === segment.start && next.end === segment.end ? segment : retimeSegment(segment, roundTime(next.start), roundTime(next.end))
    }))
    return true
  }

  const beginRangeAdjust = (id?: string) => {
    const line = id ? segments.find(segment => segment.id === id) : activeLine
    if (!line || (editingLocked && rangeDraft?.id !== line.id)) return
    if (rangeAdjusting) return
    setContextMenu(null)
    setRangeDraft({ id: line.id, start: line.start, end: line.end })
    setRangeAdjusting(true)
    loopRange(line.start, line.end, '正在循环试听并调整当前句范围。拖动边界后保存，或按 Esc 放弃。')
  }
  const finishRangeAdjust = () => {
    if (!rangeDraft) return
    auditionRef.current = null
    mediaRef.current?.pause()
    setRangeEdge(null)
    if (hasLineConflict(rangeDraft)) { setConflictRange(rangeDraft); setConflictOpen(true); return }
    if (!applyRangeResult(rangeDraft, 'compress')) { setNotice('当前句无法在媒体范围内完成调整。'); return }
    setRangeAdjusting(false)
    setRangeDraft(null)
    setNotice('当前句时间范围已更新。')
  }
  const cancelRangeAdjust = () => { auditionRef.current = null; mediaRef.current?.pause(); setRangeAdjusting(false); setRangeEdge(null); setRangeDraft(null); setConflictRange(null); setConflictOpen(false); setNotice('已放弃本次范围调整。') }
  const resolveConflict = (choice: 'compress' | 'push' | 'discard') => {
    if (choice === 'discard' || !conflictRange) { if (charRangeAdjusting) cancelCharRangeAdjust(); else cancelRangeAdjust(); return }
    const success = charRangeAdjusting ? applyCharRangeResult(conflictRange, choice) : applyRangeResult(conflictRange, choice)
    if (!success) { setNotice(choice === 'push' ? '保持其他时间块形状会越过可用范围，无法执行。' : '相邻时间块已压缩到最小范围，无法继续处理。'); return }
    setConflictOpen(false); setConflictRange(null); setRangeAdjusting(false); setRangeDraft(null); setCharRangeAdjusting(false); setCharRangeDraft(null)
    setNotice(choice === 'push' ? '已保持其他时间块形状并推动相邻块。' : '已压缩相邻时间块并推动后续块。')
  }

  const shiftAll = (delta: number, force = false) => {
    if (editingLocked || !segments.length || !duration) return false
    delta = roundTime(delta)
    if (!Number.isFinite(delta) || Math.abs(delta) < 0.001) { setNotice('请输入非零的整体偏移时间。'); return false }
    if (segments.some(segment => segment.chars.some(char => char.startLocked || char.endLocked))) { setNotice('已有锁定的逐字边界，整体移动可能破坏锚点；请先解锁。'); return false }
    const next = segments.map(segment => ({ ...segment, start: segment.start + delta, end: segment.end + delta }))
    const overflow = delta > 0 ? Math.max(0, next.at(-1)!.end - duration) : Math.max(0, -next[0].start)
    if (overflow > 0 && !force) { setPendingShift(delta); setShiftConfirmOpen(true); return 'pending' }
    const result = next.map(segment => ({ id: segment.id, start: segment.start, end: segment.end }))
    let remaining = overflow
    if (delta > 0) {
      for (let i = result.length - 1; i >= 0 && remaining > 0; i--) {
        const room = Math.max(0, result[i].end - result[i].start - MIN_SPAN)
        const shrink = Math.min(room, remaining)
        result[i].end -= shrink
        remaining -= shrink
      }
    } else {
      for (let i = 0; i < result.length && remaining > 0; i++) {
        const room = Math.max(0, result[i].end - result[i].start - MIN_SPAN)
        const shrink = Math.min(room, remaining)
        result[i].start += shrink
        remaining -= shrink
      }
    }
    if (remaining > 0) { setNotice('所有歌词已经压缩到最小范围，无法继续整体移动。'); return false }
    setLastShiftBefore(current => current ?? segments)
    commit(segments.map(segment => { const moved = result.find(item => item.id === segment.id)!; return retimeSegment(segment, roundTime(moved.start), roundTime(moved.end)) }), true)
    setNotice(`歌词已整体${delta > 0 ? '后移' : '前移'} ${Math.abs(delta)} 秒。`)
    return true
  }
  const restoreShift = () => { if (!lastShiftBefore || editingLocked) return; commit(lastShiftBefore); setShiftDialogOpen(false); setNotice('已恢复到本轮整体偏移前的位置。') }
  const openShiftDialog = () => {
    if (!segments.length || !duration || editingLocked) return
    setShiftMode('seconds')
    setShiftSecondsDraft('0')
    setFirstLineStartDraft(formatTime(segments[0].start))
    setShiftDialogOpen(true)
  }
  const firstLineTarget = parseTime(firstLineStartDraft)
  const shiftDraft = shiftMode === 'first-line'
    ? firstLineTarget === null || !segments.length ? null : roundTime(firstLineTarget - segments[0].start)
    : shiftSecondsDraft.trim() === '' || !Number.isFinite(Number(shiftSecondsDraft)) ? null : roundTime(Number(shiftSecondsDraft))
  const applyShiftDraft = () => {
    if (shiftDraft === null) return
    const applied = shiftAll(shiftDraft)
    if (applied === true || applied === 'pending') setShiftDialogOpen(false)
  }

  const openContextMenu = (event: ReactMouseEvent | ReactPointerEvent, id?: string, time?: number) => {
    event.preventDefault()
    event.stopPropagation()
    if (editingLocked) return
    const selection = id && !selectedLineIds.includes(id) ? [id] : selectedLineIds
    if (selection !== selectedLineIds) setSelectedLineIds(selection)
    setContextMenu({ x: event.clientX, y: event.clientY, id, time, selectedLineIds: selection })
  }
  const contextAction = (action: 'add' | 'delete' | 'merge' | 'split') => {
    if (editingLocked) { setContextMenu(null); return }
    const item = contextMenu
    setContextMenu(null)
    if (action === 'add') {
      const selectedEnd = selectedLineRightEdge(item?.selectedLineIds ?? selectedLineIds)
      const at = selectedEnd ?? item?.time ?? playhead
      if (selectedEnd === null && item?.time !== undefined) seek(at)
      addLineAt(at)
      return
    }
    if (item?.id && action === 'delete') { commit(segments.filter(segment => segment.id !== item.id)); setSelectedLineIds([]); setSelectedCharIds([]); if (view === 'chars') setView('lines'); setNotice('已删除选中的歌词标注。'); return }
    if (action === 'merge') mergeSelected()
    if (action === 'split') openSplit()
  }

  const retimeLines = (updates: { id: string; start: number; end: number }[]) => {
    if (!updates.length) return
    const updateMap = new Map(updates.map(update => [update.id, update]))
    if (segments.some(segment => updateMap.has(segment.id) && segment.chars.some(char => char.startLocked || char.endLocked))) {
      setNotice('该句含已锁定的字边界；请先解锁，再调整整句范围。')
      return
    }
    commit(segments.map(segment => {
      const update = updateMap.get(segment.id)
      return update ? retimeSegment(segment, update.start, update.end) : segment
    }))
  }
  const retimeChar = (id: string, start: number, end: number) => {
    if (!activeLine) return
    const index = activeLine.chars.findIndex(char => char.id === id)
    if (index < 0) return
    const lower = index > 0 ? activeLine.chars[index - 1].end : activeLine.start
    const upper = index < activeLine.chars.length - 1 ? activeLine.chars[index + 1].start : activeLine.end
    if (activeLine.chars[index].startLocked && Math.abs(start - activeLine.chars[index].start) > 0.001 || activeLine.chars[index].endLocked && Math.abs(end - activeLine.chars[index].end) > 0.001) return
    if (start < lower - 0.001 || end > upper + 0.001 || end - start < MIN_SPAN) return
    commit(segments.map(segment => segment.id === activeLine.id ? {
      ...segment, chars: segment.chars.map(char => char.id === id ? { ...char, start: roundTime(start), end: roundTime(end), origin: 'manual' as const } : char),
    } : segment))
  }
  const retimeChars = (updates: TimelinePreview[]) => {
    if (!activeLine || !updates.length) return
    const updateMap = new Map(updates.map(update => [update.id, update]))
    const proposed = activeLine.chars.map(char => updateMap.get(char.id) ?? char)
    if (proposed.some((item, index) => {
      const previous = activeLine.chars[index]
      const minSpan = /[\p{Script=Han}A-Za-z0-9]/u.test(previous.text) ? MIN_SPAN : 0.001
      return item.start < activeLine.start - 0.001 || item.end > activeLine.end + 0.001 || item.end - item.start < minSpan - 0.001 ||
        (index > 0 && item.start < proposed[index - 1].end - 0.001) ||
        (previous.startLocked && Math.abs(item.start - previous.start) > 0.001) ||
        (previous.endLocked && Math.abs(item.end - previous.end) > 0.001)
    })) { setNotice('调整会越过句范围或已锁定边界，未保存；可先解锁或缩小拖动范围。'); return }
    commit(segments.map(segment => segment.id === activeLine.id ? {
      ...segment, chars: segment.chars.map(char => { const update = updateMap.get(char.id); return update ? { ...char, start: roundTime(update.start), end: roundTime(update.end), origin: 'manual' as const } : char }),
    } : segment))
  }
  const toggleCharBoundaryLock = (edge: 'start' | 'end') => {
    if (!activeLine || !activeChar) return
    const index = activeLine.chars.findIndex(char => char.id === activeChar.id)
    if (index < 0) return
    const next = activeLine.chars.map(char => ({ ...char }))
    const key = edge === 'start' ? 'startLocked' : 'endLocked'
    const locked = !next[index][key]
    next[index][key] = locked
    const neighborIndex = edge === 'start' ? index - 1 : index + 1
    const neighborKey = edge === 'start' ? 'endLocked' : 'startLocked'
    if (neighborIndex >= 0 && neighborIndex < next.length && Math.abs(next[index][edge] - next[neighborIndex][edge === 'start' ? 'end' : 'start']) < 0.003) next[neighborIndex][neighborKey] = locked
    commit(segments.map(segment => segment.id === activeLine.id ? { ...segment, chars: next } : segment))
  }
  const reapplyActiveLine = () => {
    if (!activeLine || !activeAlignment) return
    const suggestion = activeAlignment.segments.find(line => line.id === activeLine.id)
    const next = suggestion && reapplyUnlockedLine(activeLine, suggestion)
    if (!next) { setNotice('当前句与保存的对齐版本不兼容，或锁定边界之间空间不足；未改动时间。'); return }
    commit(segments.map(segment => segment.id === activeLine.id ? next : segment))
    setNotice('已按保存的对齐结果局部重排未锁定区间；已确认边界保持不动，可撤回。')
  }

  const exportLrc = async () => {
    if (!segments.length) return
    const lrc = segments.map(segment => `[${formatTime(segment.start).slice(0, -1)}]${segment.text}`).join('\n') + '\n'
    try {
      if (await download(`${mediaName.replace(/\.[^.]+$/, '') || 'pitchord'}.lrc`, lrc, 'text/plain;charset=utf-8')) setNotice('已导出句级 LRC。')
    } catch { setNotice('保存失败，请检查目标目录是否可写。') }
  }
  const exportSrt = async () => {
    if (!segments.length) return
    try {
      if (await download(`${mediaName.replace(/\.[^.]+$/, '') || 'pitchord'}.srt`, sentenceSrt(segments), 'text/plain;charset=utf-8')) setNotice('已导出通用句级 SRT，包含每句开始与结束时间。')
    } catch { setNotice('SRT 保存失败，请检查目标目录是否可写。') }
  }
  const exportWordSubtitles = async (format: 'ass' | 'json') => {
    if (!segments.some(segment => segment.chars.length)) return
    const base = mediaName.replace(/\.[^.]+$/, '') || 'pitchord'
    try {
      if (format === 'ass') {
        const ass = generatePitchAss(segments, pitchPoints, subtitleStyle)
        if (await download(`${base}.word-timed.ass`, ass, 'text/plain;charset=utf-8')) setNotice('已导出字级 ASS 字幕，包含逐字时间、实时音高、色带和强调点。')
      } else {
        const json = JSON.stringify({
          version: 2,
          format: 'pitchord-word-timed',
          mediaName,
          duration,
          style: subtitleStyle,
          subtitles: wordTimedSubtitles(segments, pitchPoints),
        }, null, 2)
        if (await download(`${base}.word-timed.json`, json, 'application/json;charset=utf-8')) setNotice('已导出通用字级时间数据。')
      }
    } catch { setNotice('字级字幕保存失败，请检查目标目录是否可写。') }
  }
  const burnSubtitleVideo = async (segmentsToRender = segments, pitchToRender = pitchPoints, fromPipeline = false) => {
    if (!window.pitchordDesktop?.burnSubtitles) { setNotice('嵌入视频需要桌面版。'); return }
    if (!mediaIsVideo) { setNotice('当前导入的是音频；请选择视频工程后再嵌入字幕。'); return }
    if (workflowExecutionRef.current && !fromPipeline) { setNotice('已有流程正在运行，请等待当前阶段完成。'); return }
    const ownsLock = !workflowExecutionRef.current
    if (ownsLock) workflowExecutionRef.current = 'render'
    updateWork('subtitle-render', '嵌入视频字幕', 'running', '正在准备字级字幕…', 0.01)
    try {
      const result = await window.pitchordDesktop.burnSubtitles({ ass: generatePitchAss(segmentsToRender, pitchToRender, subtitleStyle), outputName: `${mediaName.replace(/\.[^.]+$/, '') || 'pitchord'}-subtitled` })
      updateWork('subtitle-render', '嵌入视频字幕', 'success', '带字幕视频已生成', 1)
      setLastRenderedSignature(subtitleSignature(mediaName, segmentsToRender, pitchToRender, subtitleStyle))
      setNotice(`带字幕视频已生成：${result.video}`)
      setSubtitleStudioOpen(false)
    } catch (error) {
      updateWork('subtitle-render', '嵌入视频字幕', 'error', error instanceof Error ? error.message : String(error))
      setNotice(`嵌入字幕失败：${error instanceof Error ? error.message : String(error)}`)
    } finally { if (ownsLock) workflowExecutionRef.current = null }
  }

  const runAutomaticPipeline = async () => {
    if (automaticProcessing || workflowExecutionRef.current) { setNotice('已有流程正在运行，请等待当前阶段完成。'); return }
    if (!mediaUrl || !mediaFileRef.current) { setNotice('请先导入音频或视频。'); return }
    if (!segments.length) { setNotice('请先导入 LRC、文本歌词或粘贴参考歌词。'); return }
    if (!window.pitchordDesktop) { setNotice('一键自动处理需要桌面版；浏览器预览仍可手动编辑。'); return }
    if (!analysisEnvironment?.runtimeReady || !selectedSeparationModel?.ready || selectedSeparationModel.runnable === false) {
      setNotice('请先在高级设置中准备分析环境与人声分离模型。')
      openEnvironmentSetup()
      return
    }
    if (harmonyEnabled && !selectedHarmonyModel?.ready && !separationResults.some(result => result.modelId === separationModel && result.harmonyModelId === harmonyModelId)) {
      setNotice('已启用去和声；请先在模型管理中准备所选模型。')
      setModelManagerOpen(true)
      return
    }
    workflowExecutionRef.current = 'automatic'
    setAutomaticProcessing(true)
    setNotice('已从当前进度继续自动处理，只运行尚未完成的阶段。')
    try {
      const matchesInput = (result: SeparationResult) => result.modelId === separationModel && (harmonyEnabled ? result.harmonyModelId === harmonyModelId : !result.harmonies)
      let separation = separationResults.find(result => result.id === pitchInputResultId && matchesInput(result)) ?? separationResults.find(matchesInput)
        ?? (harmonyEnabled ? separationResults.find(result => result.id === pitchInputResultId && result.modelId === separationModel && !result.harmonies) ?? separationResults.find(result => result.modelId === separationModel && !result.harmonies) : null) ?? null
      if (separation) {
        const loaded = audioBufferRef.current && pitchInputResultId === separation.id ? true : await selectPitchInput(separation.id)
        if (!loaded) separation = null
      }
      separation ??= await runSeparation(true)
      if (!separation) return
      if (harmonyEnabled && !separation.harmonies) {
        if (!selectedHarmonyModel?.ready || selectedHarmonyModel.runnable === false) { setNotice('一键处理需要先在模型管理中准备去和声模型。'); setModelManagerOpen(true); return }
        separation = await runHarmonySeparation(separation, true)
        if (!separation) return
      }
      let pitch = pitchResults.find(result => result.separationResultId === separation.id && result.algorithm === pitchAlgorithm) ?? null
      if (pitch) {
        setActivePitchResultId(pitch.id)
        setPitchPoints(pitch.points)
        updateWork('pitch', '连续音高识别', 'success', `已复用 ${pitch.label} 的现有结果`, 1)
      } else pitch = await analyzePitch(separation, true)
      if (!pitch) return
      let alignment = alignmentResults.find(result => result.inputResultId === separation.id && result.modelId === alignmentModel) ?? null
      if (alignment) {
        setActiveAlignmentResultId(alignment.id)
        commit(mergeAlignmentKeepingLocks(carryPitchOverrides(alignment.segments, segments), segments))
        updateWork('alignment', '歌词时间戳匹配', 'success', `已复用 ${alignment.modelLabel} 的现有结果`, 1)
      } else alignment = await runLyricAlignment(separation, pitch, true)
      if (!alignment) return
      const finalSegments = mergeAlignmentKeepingLocks(carryPitchOverrides(alignment.segments, segments), segments)
      commit(finalSegments)
      updateWork('subtitle-generate', '生成精准字幕', 'success', '已生成带逐字时间与音高的默认字幕', 1)
      const targetSignature = subtitleSignature(mediaName, finalSegments, pitch.points, subtitleStyle)
      if (mediaIsVideo && lastRenderedSignature !== targetSignature) await burnSubtitleVideo(finalSegments, pitch.points, true)
      else if (mediaIsVideo) setNotice('全部阶段已经完成，现有带字幕视频与当前结果一致。')
      else setNotice('自动处理完成：精准字幕已生成。当前素材为音频，可导出字幕文件。')
    } finally {
      workflowExecutionRef.current = null
      setAutomaticProcessing(false)
    }
  }
  const exportProject = async () => {
    try {
      const content = JSON.stringify(currentProjectData(), null, 2)
      if (projectDirectory && window.pitchordDesktop) {
        const file = await window.pitchordDesktop.saveProject(content)
        setNotice(`工程已保存：${file}`)
      } else if (await download(`${mediaName.replace(/\.[^.]+$/, '') || 'pitchord'}.pitchord.json`, content, 'application/json;charset=utf-8')) setNotice('已导出项目文件。')
    } catch (error) { setNotice(`保存失败：${error instanceof Error ? error.message : String(error)}`) }
  }
  const importProjectContent = async (content: string, preserveMedia = false) => {
    try {
      const project = JSON.parse(content) as Draft & { version?: number }
      if (project.version !== 1 || typeof project.mediaName !== 'string' || !Number.isFinite(project.duration) || project.duration < 0 || !Array.isArray(project.segments)) throw new Error('invalid project')
      if (!project.segments.every(segment => typeof segment.id === 'string' && typeof segment.text === 'string' && Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.start >= 0 && segment.end <= project.duration && segment.end > segment.start && Array.isArray(segment.chars) && segment.chars.every(char => typeof char.id === 'string' && typeof char.text === 'string' && Number.isFinite(char.start) && Number.isFinite(char.end) && char.start >= segment.start && char.end <= segment.end && char.end >= char.start && Number.isInteger(char.startOffset) && Number.isInteger(char.endOffset) && (char.pitchOverride === undefined || validPitchAnnotation(char.pitchOverride)) && (char.pitchPreference === undefined || char.pitchPreference === 'manual' || char.pitchPreference === 'model')))) throw new Error('invalid segments')
      const importedRepeatedSections = Array.isArray(project.repeatedSections) && project.repeatedSections.every(section => typeof section.id === 'string' && /^[A-Z]$/.test(section.family) && Array.isArray(section.lineIds) && section.lineIds.every(id => typeof id === 'string') && Array.isArray(section.lineLinks) && section.lineLinks.every(link => typeof link.targetLineId === 'string' && Array.isArray(link.sourceLineIds) && link.sourceLineIds.every(id => typeof id === 'string') && Array.isArray(link.charLinks) && link.charLinks.every(charLink => typeof charLink.targetCharId === 'string' && Array.isArray(charLink.sourceCharIds) && charLink.sourceCharIds.every(id => typeof id === 'string')))) ? project.repeatedSections : []
      const importedPitch = Array.isArray(project.pitchPoints) && project.pitchPoints.every(point => typeof point.time === 'number' && typeof point.hz === 'number' && typeof point.confidence === 'number' && typeof point.rms === 'number' && typeof point.voiced === 'boolean') ? project.pitchPoints : []
      const importedSeparationResults = Array.isArray(project.separationResults) ? project.separationResults : []
      const importedPitchResults = Array.isArray(project.pitchResults) ? project.pitchResults : []
      const importedAlignmentResults = Array.isArray(project.alignmentResults) ? project.alignmentResults : []
      if (!preserveMedia) {
        vocalToken.current++
        setVocalPeaks([])
        setAcoustics(null)
        mediaRef.current?.pause()
        mediaToken.current++
        setMediaUrl('')
        mixerRef.current?.clear()
        setTrackEnabled({ original: true, vocals: false, harmonies: false, accompaniment: false })
        setStemReady({ vocals: false, harmonies: false, accompaniment: false })
        mediaFileRef.current = null
      }
      setMediaName(project.mediaName)
      setDuration(project.duration)
      setPeaks([])
      setPitchPoints(importedPitch)
      setSeparationResults(importedSeparationResults)
      setActiveSeparationResultId(project.activeSeparationResultId || importedSeparationResults[0]?.id || '')
      setActiveVocalResultId(project.activeVocalResultId || project.activeSeparationResultId || importedSeparationResults[0]?.id || '')
      setActiveAccompanimentResultId(project.activeAccompanimentResultId || project.activeSeparationResultId || importedSeparationResults[0]?.id || '')
      setPitchInputResultId(project.pitchInputResultId || project.activeVocalResultId || project.activeSeparationResultId || importedSeparationResults[0]?.id || '')
      setPitchResults(importedPitchResults)
      setActivePitchResultId(project.activePitchResultId || importedPitchResults[0]?.id || '')
      setAlignmentInputResultId(project.alignmentInputResultId || project.pitchInputResultId || project.activeVocalResultId || importedSeparationResults[0]?.id || '')
      setAlignmentResults(importedAlignmentResults)
      setActiveAlignmentResultId(project.activeAlignmentResultId || importedAlignmentResults[0]?.id || '')
      setSubtitleStyle({ ...defaultSubtitleStyle, ...project.subtitleStyle })
      setRepeatedSections(importedRepeatedSections)
      setHarmonyEnabled(!!project.harmonyEnabled)
      setHarmonyModelId(project.harmonyModelId || 'bs-roformer-karaoke-frazer')
      setLastRenderedSignature('')
      setAlignmentStatus(importedAlignmentResults.length ? `已载入 ${importedAlignmentResults.length} 个歌词匹配结果` : '尚未匹配')
      setPitchStatus(importedPitch.length ? `已载入 ${importedPitch.length} 个音高时间点` : '尚未分析音高')
      if (!preserveMedia) {
        setSeparationStatus('未运行')
        audioBufferRef.current = null
        setAudioReady(false)
        setVocalTrackReady(false)
        setWaveformStatus('重新导入原媒体后显示波形')
      }
      setHistory({ present: project.segments, past: [], future: [] })
      setLastShiftBefore(null)
      setSelectedLineIds(project.segments[0] ? [project.segments[0].id] : [])
      setSelectedCharIds([])
      setPlayhead(0)
      setGuideLine(null)
      setPlaying(false)
      setView('lines')
      setNotice(preserveMedia ? '工程及媒体已载入，可以继续编辑和试听。' : '项目已载入。请重新导入同名原媒体以恢复试听。')
      return true
    } catch { setNotice('项目文件无效或版本不支持，未修改当前编辑内容。'); return false }
  }
  const importProject = async (file: File) => {
    const content = await file.text()
    if (await importProjectContent(content)) {
      const imported = JSON.parse(content) as Draft
      setProjectName(imported.projectName?.trim() || file.name.replace(/\.pitchord\.json$|\.json$/i, '') || '未命名项目')
      setWorkspaceOpen(true)
    }
  }
  const resetProjectState = () => {
    mediaRef.current?.pause()
    mediaToken.current++
    vocalToken.current++
    auditionRef.current = null
    setMediaUrl('')
    mixerRef.current?.clear()
    setTrackEnabled({ original: true, vocals: false, harmonies: false, accompaniment: false })
    setStemReady({ vocals: false, harmonies: false, accompaniment: false })
    mediaFileRef.current = null
    setMediaName('')
    setVideoAspect(16 / 9)
    setDuration(0)
    setPeaks([])
    setVocalPeaks([])
    setAcoustics(null)
    setPitchPoints([])
    setPitchResults([])
    setActivePitchResultId('')
    setSeparationResults([])
    setActiveSeparationResultId('')
    setActiveVocalResultId('')
    setActiveAccompanimentResultId('')
    setPitchInputResultId('')
    setAlignmentInputResultId('')
    setAlignmentResults([])
    setActiveAlignmentResultId('')
    setAlignmentStatus('尚未匹配')
    setSubtitleStyle(defaultSubtitleStyle)
    setLastRenderedSignature('')
    setPitchStatus('尚未分析音高')
    setSeparationStatus('未运行')
    setHarmonyEnabled(false)
    setHarmonyModelId('bs-roformer-karaoke-frazer')
    audioBufferRef.current = null
    setAudioReady(false)
    setVocalTrackReady(false)
    setWaveformStatus('导入音频或视频后显示波形')
    setHistory({ present: [], past: [], future: [] })
    setRepeatedSections([])
    setLastShiftBefore(null)
    setSelectedLineIds([])
    setSelectedCharIds([])
    setPlayhead(0)
    setGuideLine(null)
    setPlaying(false)
    setView('lines')
    localStorage.removeItem('pitchord.draft.v1')
    setProjectDirectory('')
    setProjectName('')
    setProjectNameDraft('')
    setProjectNameEditing(false)
  }

  const rememberProject = (name: string, directory: string) => {
    localStorage.setItem('pitchord.hidden-projects.v1', JSON.stringify(readHiddenProjectDirectories().filter(item => item !== directory)))
    setRecentProjects(previous => {
      const next = [{ name, directory, updatedAt: new Date().toISOString(), available: true }, ...previous.filter(item => item.directory !== directory)].slice(0, 50)
      localStorage.setItem('pitchord.recent-projects.v1', JSON.stringify(next))
      return next
    })
  }

  const removeRecentProjects = (directories: string[]) => {
    const removed = new Set(directories)
    localStorage.setItem('pitchord.hidden-projects.v1', JSON.stringify([...new Set([...readHiddenProjectDirectories(), ...directories])]))
    setRecentProjects(previous => {
      const next = previous.filter(item => !removed.has(item.directory))
      localStorage.setItem('pitchord.recent-projects.v1', JSON.stringify(next))
      return next
    })
    setSelectedRecentDirectories(previous => previous.filter(directory => !removed.has(directory)))
    setProjectHomeMessage(`已从最近项目移除 ${removed.size} 个工程；磁盘文件未删除。`)
  }

  const toggleRecentSelection = (directory: string) => {
    setSelectedRecentDirectories(previous => previous.includes(directory) ? previous.filter(item => item !== directory) : [...previous, directory])
  }

  const refreshRecentProjects = async () => {
    if (!window.pitchordDesktop || projectActionBusy) return
    setProjectActionBusy(true)
    try {
      const refreshed = await window.pitchordDesktop.refreshProjects(recentProjects.map(project => project.directory))
      const previousByDirectory = new Map(recentProjects.map(project => [project.directory, project]))
      const hidden = new Set(readHiddenProjectDirectories())
      const next = refreshed.filter(project => !hidden.has(project.directory)).map(project => project.available ? project : { ...project, name: previousByDirectory.get(project.directory)?.name || project.name, updatedAt: previousByDirectory.get(project.directory)?.updatedAt || project.updatedAt })
      setRecentProjects(next)
      localStorage.setItem('pitchord.recent-projects.v1', JSON.stringify(next))
      setSelectedRecentDirectories(previous => previous.filter(directory => next.some(project => project.directory === directory)))
      setProjectHomeMessage(`已刷新，找到 ${next.filter(project => project.available).length} 个工程${next.some(project => !project.available) ? '；位置已失效的记录仍可从列表移除' : ''}。`)
    } catch (error) {
      setProjectHomeMessage(`刷新失败：${error instanceof Error ? error.message : String(error)}`)
    } finally { setProjectActionBusy(false) }
  }

  const beginProjectDuplicate = (project: RecentProject) => {
    setDuplicateSource(project)
    setDuplicateName(`${project.name} - 副本`)
  }

  const confirmProjectDuplicate = async () => {
    if (!duplicateSource || !window.pitchordDesktop || projectActionBusy) return
    setProjectActionBusy(true)
    try {
      const copy = await window.pitchordDesktop.duplicateProject(duplicateSource.directory, duplicateName.trim())
      rememberProject(copy.name, copy.directory)
      setDuplicateSource(null)
      setProjectHomeMessage(`已复制工程“${copy.name}”，原工程保持不变。`)
    } catch (error) {
      setProjectHomeMessage(`复制失败：${error instanceof Error ? error.message : String(error)}`)
    } finally { setProjectActionBusy(false) }
  }

  const revealRecentProject = async (project: RecentProject) => {
    try { await window.pitchordDesktop?.revealProject(project.directory) }
    catch (error) { setProjectHomeMessage(`无法定位工程：${error instanceof Error ? error.message : String(error)}`) }
  }

  const confirmProjectTrash = async () => {
    if (!pendingProjectTrash.length || !window.pitchordDesktop || projectActionBusy) return
    setProjectActionBusy(true)
    try {
      const result = await window.pitchordDesktop.trashProjects(pendingProjectTrash.map(project => project.directory))
      if (result.trashed.length) {
        const removed = new Set(result.trashed)
        setRecentProjects(previous => {
          const next = previous.filter(item => !removed.has(item.directory))
          localStorage.setItem('pitchord.recent-projects.v1', JSON.stringify(next))
          return next
        })
        setSelectedRecentDirectories(previous => previous.filter(directory => !removed.has(directory)))
      }
      setProjectHomeMessage(result.failed.length
        ? `${result.trashed.length} 个工程已移入回收站；${result.failed.length} 个失败：${result.failed.map(item => item.message).join('；')}`
        : `${result.trashed.length} 个工程已移入系统回收站。`)
      setPendingProjectTrash([])
    } catch (error) {
      setProjectHomeMessage(`删除失败，工程未移入回收站：${error instanceof Error ? error.message : String(error)}`)
    } finally { setProjectActionBusy(false) }
  }

  const closeProjectToHome = async () => {
    if (projectDirectory && window.pitchordDesktop) {
      try {
        await window.pitchordDesktop.saveProject(JSON.stringify(currentProjectData()))
      } catch (error) {
        setNotice(`返回项目列表前保存失败：${error instanceof Error ? error.message : String(error)}`)
        return
      }
    }
    resetProjectState()
    setWorkspaceOpen(false)
    setNotice('已返回所有项目。')
  }

  const beginProjectNameEdit = () => {
    setProjectNameDraft(projectName || '未命名项目')
    setProjectNameEditing(true)
  }

  const saveProjectName = () => {
    const next = projectNameDraft.trim() || '未命名项目'
    setProjectName(next)
    setProjectNameEditing(false)
    if (projectDirectory) rememberProject(next, projectDirectory)
    setNotice(`项目名称已更新为“${next}”。`)
  }

  const showNewProject = async () => {
    if (window.pitchordDesktop) {
      try { const defaults = await window.pitchordDesktop.projectDefaults(); setProjectParent(defaults.parent); setNewProjectName(defaults.suggestedName) } catch { /* retain current input */ }
    }
    setNewProjectOpen(true)
  }
  const createProject = async () => {
    if (!window.pitchordDesktop) {
      const name = newProjectName.trim() || '未命名项目'
      resetProjectState()
      setProjectName(name)
      setWorkspaceOpen(true)
      setNewProjectOpen(false)
      setNotice('已新建空白项目。')
      return
    }
    try {
      const project = await window.pitchordDesktop.createProject(newProjectName.trim(), projectParent)
      const pending = pendingMediaRef.current
      pendingMediaRef.current = null
      resetProjectState()
      setProjectDirectory(project.directory)
      setProjectName(project.name)
      setWorkspaceOpen(true)
      rememberProject(project.name, project.directory)
      setNewProjectOpen(false)
      setNotice(`工程已创建：${project.directory}`)
      if (pending) {
        await loadMedia(await copyAssetIntoProject('media', pending), false)
      }
    } catch (error) { setNotice(`新建工程失败：${error instanceof Error ? error.message : String(error)}`) }
  }
  const openProject = async (recentDirectory?: string) => {
    if (!window.pitchordDesktop) { projectInputRef.current?.click(); return }
    try {
      const result = await window.pitchordDesktop.openProject(recentDirectory)
      if (!result) return
      resetProjectState()
      const media = await window.pitchordDesktop.readProjectAsset('media')
      if (media) await loadMedia(new File([new Uint8Array(media.data).buffer], media.name, { type: /\.(mp4|mov|mkv|webm)$/i.test(media.name) ? 'video/mp4' : 'audio/wav' }), false)
      const vocals = await window.pitchordDesktop.readProjectAsset('vocals')
      const harmonies = await window.pitchordDesktop.readProjectAsset('harmonies')
      const accompaniment = await window.pitchordDesktop.readProjectAsset('accompaniment')
      if (vocals) await loadVocalTrack(new File([new Uint8Array(vocals.data).buffer], vocals.name, { type: 'audio/wav' }), false)
      if (harmonies) await loadHarmonyTrack(new File([new Uint8Array(harmonies.data).buffer], harmonies.name, { type: 'audio/wav' }))
      if (accompaniment) await loadAccompanimentTrack(new File([new Uint8Array(accompaniment.data).buffer], accompaniment.name, { type: 'audio/wav' }), false)
      if (media) setTrackEnabled({ original: !vocals, vocals: !!vocals, harmonies: false, accompaniment: false })
      if (await importProjectContent(result.content, !!media)) {
        setProjectDirectory(result.directory)
        const savedName = (() => { try { return (JSON.parse(result.content) as Draft).projectName?.trim() } catch { return '' } })()
        setProjectName(savedName || result.name)
        setWorkspaceOpen(true)
        rememberProject(savedName || result.name, result.directory)
        if (vocals && accompaniment) setSeparationStatus(harmonies ? '已载入主唱、和声和伴奏' : '已载入纯人声和纯伴奏')
      }
    } catch (error) {
      const message = `打开工程失败：${error instanceof Error ? error.message : String(error)}`
      setNotice(message)
      setTaskAlert({ id: 'project-open', title: '打开项目', status: 'error', message, updatedAt: Date.now() })
    }
  }

  const activateLine = (id: string, beginAdjust = true) => {
    const segment = segments.find(item => item.id === id)
    if (!segment || (editingLocked && rangeDraft?.id !== id)) return
    lyricListTargetRef.current = id
    setSelectedLineIds([id])
    setSelectedCharIds([])
    setCenterTargetId(id)
    setCenterRequest(value => value + 1)
    if (beginAdjust) beginRangeAdjust(id)
    else playNormally(segment.start, '已从当前句起点开始播放；进入范围调整后才会循环试听。')
  }
  const activateChar = (id: string, beginAdjust = true) => {
    if (!activeLine) return
    const char = activeLine.chars.find(item => item.id === id)
    if (!char || (editingLocked && charRangeDraft?.id !== id)) return
    setSelectedCharIds([id])
    setCenterTargetId(id)
    setCenterRequest(value => value + 1)
    if (beginAdjust) beginCharRangeAdjust(id)
    else playNormally(char.start, `已从「${char.text}」起点开始播放；进入范围调整后才会循环试听。`)
  }
  const onMediaTimeUpdate = (media: HTMLMediaElement) => {
    const loop = auditionRef.current
    if (loop && media.currentTime >= loop.end - 0.03) {
      const draft = view === 'lines' ? rangeDraft : charRangeDraft
      const loopStart = rightEdgeAuditionRef.current && draft ? Math.max(draft.start, draft.end - 1) : loop.start
      if (rightEdgeAuditionRef.current && draft) auditionRef.current = { start: loopStart, end: draft.end }
      media.currentTime = loopStart
      setPlayhead(loopStart)
    } else {
      mixerRef.current?.sync(media)
      setPlayhead(media.currentTime)
    }
  }
  const onMediaPlay = (media: HTMLMediaElement) => {
    setPlaying(true)
    if (mixerRef.current) void mixerRef.current.play(media).catch(() => setNotice('无法启动混音器，请重新播放。'))
  }
  const onMediaPause = () => {
    mixerRef.current?.pause()
    setPlaying(false)
  }
  const onMediaSeeking = (media: HTMLMediaElement) => {
    const focused = view === 'lines' ? rangeDraft : charRangeDraft
    if (editingLocked && focused && (media.currentTime < focused.start || media.currentTime > focused.end)) {
      media.currentTime = clamp(media.currentTime, focused.start, focused.end)
      return
    }
    const fromTimeline = timelineSeekRef.current
    timelineSeekRef.current = false
    mixerRef.current?.pause()
    setPlayhead(media.currentTime)
    if (!auditionRef.current && !fromTimeline) setSeekCenterRequest(value => value + 1)
  }
  const onMediaSeeked = (media: HTMLMediaElement) => {
    setPlayhead(media.currentTime)
    if (!media.paused && mixerRef.current) void mixerRef.current.play(media).catch(() => setNotice('无法恢复混音器播放。'))
  }
  const onMediaEnded = () => {
    const loop = auditionRef.current
    const media = mediaRef.current
    if (loop && media) {
      const draft = view === 'lines' ? rangeDraft : charRangeDraft
      const loopStart = rightEdgeAuditionRef.current && draft ? Math.max(draft.start, draft.end - 1) : loop.start
      if (rightEdgeAuditionRef.current && draft) auditionRef.current = { start: loopStart, end: draft.end }
      media.currentTime = loopStart
      setPlayhead(loopStart)
      playMediaSafely(media)
      return
    }
    mixerRef.current?.pause()
    setPlaying(false)
  }
  const onMediaVolumeChange = (media: HTMLMediaElement) => {
    setMasterMuted(media.muted)
    setMasterVolume(Math.round(media.volume * 100))
  }
  const bindMedia = (media: HTMLMediaElement | null) => {
    mediaRef.current = media
    if (!media) return
    media.muted = masterMuted
    media.volume = masterVolume / 100
    media.playbackRate = playbackRate
    getMixer().attachMedia(media)
  }
  const onMediaMetadata = (media: HTMLMediaElement) => {
    if (media instanceof HTMLVideoElement && media.videoWidth > 0 && media.videoHeight > 0) setVideoAspect(media.videoWidth / media.videoHeight)
    if (!Number.isFinite(media.duration) || media.duration <= 0) {
      setNotice('无法读取媒体时长，请换用支持的文件格式。')
      return
    }
    if (segments.length && duration && Math.abs(media.duration - duration) > 0.3) {
      setNotice('该媒体与恢复的草稿时长不一致，请选择原媒体。')
      media.pause()
      mediaToken.current++
      setMediaUrl('')
      setPeaks([])
      return
    }
    setDuration(media.duration)
  }

  const activeChar = activeLine?.chars.find(char => selectedCharIds.includes(char.id)) ?? null
  const activePitchAnnotation = activeChar ? pitchForChar(activeChar, pitchPoints) : null
  const activePitchSuggestion = activeChar ? pitchMatches[activeChar.id]?.annotation : null
  const activeManualPitch = activeChar?.pitchOverride ?? null
  const activePitchPreference = activeManualPitch && activeChar?.pitchPreference !== 'model' ? 'manual' : 'model'
  const activePitchNotation = activePitchAnnotation ? pitchNotation(activePitchAnnotation) : ''
  const pitchNotationDraft = pitchNotationEdit && pitchNotationEdit.id === activeChar?.id && pitchNotationEdit.base === activePitchNotation ? pitchNotationEdit.value : activePitchNotation
  const savePitchNotation = () => {
    if (!activeChar || editingLocked) return
    if (pitchNotationDraft.trim().replaceAll('♯', '#').toUpperCase() === activePitchNotation.toUpperCase()) { setPitchNotationEdit(null); return }
    const parsed = parsePitchNotation(pitchNotationDraft, activePitchAnnotation ?? undefined)
    if (!parsed) { setNotice('音高格式无效。可输入 E4、E4-F4-E4、E4~，或用 — 表示无音高。'); setPitchNotationEdit(null); return }
    commit(segments.map(segment => segment.id === activeLine?.id ? { ...segment, chars: segment.chars.map(char => char.id === activeChar.id ? { ...char, pitchOverride: parsed, pitchPreference: 'manual' as const } : char) } : segment))
    setPitchNotationEdit(null)
    setNotice(`已保存「${activeChar.text}」的字幕音高；可撤回。`)
  }
  const resetPitchOverride = () => {
    if (!activeChar || editingLocked) return
    commit(segments.map(segment => segment.id === activeLine?.id ? { ...segment, chars: segment.chars.map(char => char.id === activeChar.id ? { ...char, pitchOverride: undefined, pitchPreference: undefined } : char) } : segment))
    setPitchNotationEdit(null)
    setNotice(`「${activeChar.text}」的人工音高已删除，当前使用模型建议；可撤回。`)
  }
  const selectPitchPreference = (preference: 'manual' | 'model') => {
    if (!activeChar || !activeLine || editingLocked || preference === 'manual' && !activeChar.pitchOverride) return
    commit(segments.map(segment => segment.id === activeLine.id ? { ...segment, chars: segment.chars.map(char => char.id === activeChar.id ? { ...char, pitchPreference: preference } : char) } : segment))
    setPitchNotationEdit(null)
    setNotice(`「${activeChar.text}」已切换为${preference === 'manual' ? '人工结果' : '模型建议'}优先；另一份结果仍保留。`)
  }
  const updatePitchBoundary = (index: number, input: string) => {
    if (!activeChar || !activePitchAnnotation || editingLocked) return
    const value = parseTime(input)
    const notes = activePitchAnnotation.notes
    const span = activeChar.end - activeChar.start
    if (value === null || span <= 0 || index < 0 || index >= notes.length - 1) { setNotice('换音时间格式无效。'); return }
    const ratio = (value - activeChar.start) / span
    if (ratio <= notes[index].start + 0.005 / span || ratio >= notes[index + 1].end - 0.005 / span) { setNotice('换音点须位于相邻两个音之间。'); return }
    const updated = { ...activePitchAnnotation, notes: notes.map((item, itemIndex) => itemIndex === index ? { ...item, end: ratio } : itemIndex === index + 1 ? { ...item, start: ratio } : item) }
    commit(segments.map(segment => segment.id === activeLine?.id ? { ...segment, chars: segment.chars.map(char => char.id === activeChar.id ? { ...char, pitchOverride: updated, pitchPreference: 'manual' as const } : char) } : segment))
    setNotice(`已调整「${activeChar.text}」的换音时间；可撤回。`)
  }
  const updatePitchNote = (index: number, input: string) => {
    if (!activeChar || !activePitchAnnotation || editingLocked) return
    const name = input.trim().replaceAll('♯', '#').toUpperCase()
    if (noteHz(name) === null) { setNotice('音名格式无效。请使用 E4、F#4 这样的格式。'); return }
    if (activePitchAnnotation.notes[index]?.note === name) return
    const updated = { ...activePitchAnnotation, notes: activePitchAnnotation.notes.map((item, itemIndex) => itemIndex === index ? { ...item, note: name } : item) }
    commit(segments.map(segment => segment.id === activeLine?.id ? { ...segment, chars: segment.chars.map(char => char.id === activeChar.id ? { ...char, pitchOverride: updated, pitchPreference: 'manual' as const } : char) } : segment))
    setNotice(`已修改「${activeChar.text}」的第 ${index + 1} 个音；字幕同步更新。`)
  }
  const lineIndex = activeLine ? segments.findIndex(segment => segment.id === activeLine.id) : -1
  const beginCharRangeAdjust = (id?: string) => {
    const char = id ? activeLine?.chars.find(item => item.id === id) : activeChar
    if (!char || (editingLocked && charRangeDraft?.id !== char.id)) return
    if (charRangeAdjusting) return
    setContextMenu(null)
    setCharRangeDraft({ id: char.id, start: char.start, end: char.end })
    setCharRangeAdjusting(true)
    loopRange(char.start, char.end, `正在循环试听并调整「${char.text}」的范围。拖动边界后保存，或按 Esc 放弃。`)
  }
  const hasCharConflict = (range: TimelinePreview) => !!activeLine?.chars.some(char => char.id !== range.id && char.end > range.start && char.start < range.end)
  const applyCharRangeResult = (range: TimelinePreview, strategy: 'compress' | 'push') => {
    if (!activeLine) return false
    const minimumById = new Map(activeLine.chars.map(char => [char.id, /[\p{Script=Han}A-Za-z0-9]/u.test(char.text) ? MIN_SPAN : 0.001]))
    const previews = resolveRangeConflict(activeLine.chars, range, { start: activeLine.start, end: activeLine.end }, strategy, clip => minimumById.get(clip.id) ?? MIN_SPAN)
    if (!previews) return false
    const index = activeLine.chars.findIndex(char => char.id === range.id)
    if (index > 0 && Math.abs(activeLine.chars[index - 1].end - activeLine.chars[index].start) < 0.003 && previews[index].start !== activeLine.chars[index].start) previews[index - 1].end = previews[index].start
    if (index >= 0 && index + 1 < previews.length && Math.abs(activeLine.chars[index + 1].start - activeLine.chars[index].end) < 0.003 && previews[index].end !== activeLine.chars[index].end) previews[index + 1].start = previews[index].end
    if (previews.some((item, position) => {
      const original = activeLine.chars[position]
      return item.end - item.start < (minimumById.get(original.id) ?? MIN_SPAN) - 0.001 || position > 0 && item.start < previews[position - 1].end - 0.001 ||
        original.startLocked && Math.abs(item.start - original.start) > 0.001 || original.endLocked && Math.abs(item.end - original.end) > 0.001
    })) return false
    const updates = new Map(previews.map(item => [item.id, item]))
    commit(segments.map(segment => segment.id === activeLine.id ? {
      ...segment, chars: segment.chars.map(char => {
        const next = updates.get(char.id)!
        return next.start === char.start && next.end === char.end ? char : { ...char, start: next.start, end: next.end, origin: 'manual' as const }
      }),
    } : segment))
    return true
  }
  const finishCharRangeAdjust = () => {
    if (!activeChar || !charRangeDraft) return
    auditionRef.current = null; mediaRef.current?.pause()
    setCharRangeEdge(null)
    if (hasCharConflict(charRangeDraft)) { setConflictRange(charRangeDraft); setConflictOpen(true); return }
    if (!applyCharRangeResult(charRangeDraft, 'compress')) { setNotice('当前字无法在本句范围内完成调整。'); return }
    setCharRangeAdjusting(false); setCharRangeDraft(null)
    setNotice('当前字的时间范围已更新。')
  }
  const cancelCharRangeAdjust = () => { setCharRangeAdjusting(false); setCharRangeEdge(null); setCharRangeDraft(null); setConflictRange(null); setConflictOpen(false); auditionRef.current = null; mediaRef.current?.pause(); setNotice('已放弃本次字范围调整。') }
  useEffect(() => {
    finishRangeAdjustRef.current = finishRangeAdjust
    finishCharRangeAdjustRef.current = finishCharRangeAdjust
  })
  const goLine = (direction: -1 | 1) => {
    if (editingLocked) return
    const next = segments[lineIndex + direction]
    if (!next) return
    setSelectedLineIds([next.id]); setSelectedCharIds(view === 'chars' && next.chars[0] ? [next.chars[0].id] : []); seek(next.start)
  }
  const changeView = (next: View) => {
    if (editingLocked || next === view || (next === 'chars' && !activeLine)) return
    setView(next)
    setSelectedCharIds(next === 'chars' && activeLine?.chars[0] ? [activeLine.chars[0].id] : [])
    if (activeLine) seek(activeLine.start)
  }
  const openPitchEditor = () => {
    if (editingLocked) return
    const line = activeLine?.chars.length ? activeLine : segments.find(segment => segment.chars.length)
    if (!line) { setNotice('请先导入歌词，生成字级时间范围。'); return }
    setSelectedLineIds([line.id])
    setSelectedCharIds([line.chars[0].id])
    setView('chars')
    setCenterTargetId(line.id)
    setCenterRequest(value => value + 1)
    seek(line.start)
    window.requestAnimationFrame(() => pitchEditorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    setNotice('已打开逐字音高编辑：列表显示每个字实际导出的完整音高序列，点击某字可修改音名及换音时间。')
  }

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && !event.repeat && !conflictOpen) {
        if (charRangeAdjusting) { event.preventDefault(); finishCharRangeAdjustRef.current(); return }
        if (rangeAdjusting) { event.preventDefault(); finishRangeAdjustRef.current(); return }
      }
      if (event.key !== 'Escape' || contextMenu) return
      if (conflictOpen || charRangeAdjusting) {
        event.preventDefault()
        cancelCharRangeAdjust()
        return
      }
      if (rangeAdjusting) {
        event.preventDefault()
        cancelRangeAdjust()
        return
      }
      if (view === 'chars' && selectedCharIds.length) {
        event.preventDefault()
        setSelectedCharIds([])
        return
      }
      if (selectedLineIds.length) {
        event.preventDefault()
        setSelectedLineIds([])
        setSelectedCharIds([])
        if (view === 'chars') setView('lines')
      }
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [contextMenu, conflictOpen, charRangeAdjusting, rangeAdjusting, view, selectedCharIds, selectedLineIds])

  const isRunning = (id: string) => workItems.some(item => item.id === id && item.status === 'running')
  const subtitleReady = !!alignmentResults.length && !!pitchPoints.length && segments.some(segment => segment.chars.length)
  const currentSubtitleSignature = useMemo(() => subtitleSignature(mediaName, segments, pitchPoints, subtitleStyle), [mediaName, segments, pitchPoints, subtitleStyle])
  const videoReady = !!lastRenderedSignature && lastRenderedSignature === currentSubtitleSignature
  const pipelineTaskRunning = automaticProcessing || ['separation', 'harmony', 'pitch', 'alignment', 'subtitle-render'].some(isRunning)
  const workflowSteps = [
    { id: 'import', label: '导入素材', done: !!mediaUrl && !!segments.length, running: isRunning('media-import'), actionLabel: mediaUrl ? '更换' : '导入', action: () => mediaInputRef.current?.click(), disabled: pipelineTaskRunning },
    { id: 'separation', label: '提取人声', done: !!separationResults.length, running: isRunning('separation'), actionLabel: separationResults.length ? '重新运行' : '运行', action: requestSeparation, disabled: !mediaUrl || pipelineTaskRunning },
    ...(harmonyEnabled ? [{ id: 'harmony', label: '提取主唱', done: separationResults.some(result => result.harmonyModelId === harmonyModelId), running: isRunning('harmony'), actionLabel: '运行', action: () => { if (selectedHarmonySource) void runHarmonySeparation(selectedHarmonySource) }, disabled: !selectedHarmonySource || !selectedHarmonyModel?.ready || pipelineTaskRunning }] : []),
    { id: 'pitch', label: '音高识别', done: !!pitchResults.length || !!pitchPoints.length, running: isRunning('pitch'), actionLabel: pitchResults.length ? '重新运行' : '运行', action: requestPitchAnalysis, disabled: !vocalTrackReady || pipelineTaskRunning },
    { id: 'alignment', label: '歌词对齐', done: !!alignmentResults.length, running: isRunning('alignment'), actionLabel: alignmentResults.length ? '重新运行' : '运行', action: requestLyricAlignment, disabled: !alignmentInputResultId || pipelineTaskRunning },
    { id: 'matching', label: '结果匹配', done: !!alignmentResults.length && !!pitchPoints.length, running: false, actionLabel: '自动', action: undefined, disabled: true },
    { id: 'subtitle', label: '生成字幕', done: subtitleReady, running: isRunning('subtitle-generate'), actionLabel: '设置 / 导出', action: () => setSubtitleStudioOpen(true), disabled: !subtitleReady || pipelineTaskRunning },
    { id: 'video', label: '生成视频', done: videoReady, running: isRunning('subtitle-render'), actionLabel: videoReady ? '重新生成' : '设置并生成', action: () => setSubtitleStudioOpen(true), disabled: !subtitleReady || !mediaIsVideo || pipelineTaskRunning },
  ]
  const activeWorkflowIndex = Math.max(0, workflowSteps.findIndex(step => !step.done))
  const remainingWorkflowSteps = workflowSteps.filter(step => !step.done && step.id !== 'import' && (step.id !== 'video' || mediaIsVideo)).length
  const visibleRecentProjects = recentProjects.filter(project => !projectSearch.trim() || project.name.toLowerCase().includes(projectSearch.trim().toLowerCase()))
  const selectedVisibleProjects = visibleRecentProjects.filter(project => selectedRecentDirectories.includes(project.directory))

  return <TooltipProvider delayDuration={250}>
    <div className="min-h-screen bg-background text-foreground">
      <input ref={projectInputRef} type="file" accept=".pitchord.json,.json,application/json" className="hidden" onChange={async event => { const file = event.target.files?.[0]; if (file) await importProject(file); event.target.value = '' }} />
      {!workspaceOpen ? <main className="project-home min-h-screen bg-background">
        <header className="flex h-16 items-center justify-between border-b border-border px-7">
          <div className="flex items-center gap-5">
            <div className="flex items-center gap-2 font-semibold"><AudioLines className="size-5 text-primary" />Pitchord</div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Home className="size-4" /><ChevronRight className="size-3" /><span className="font-medium text-foreground">所有项目</span></div>
            <div className="flex rounded-lg border border-border bg-card p-1">
              <Button size="icon" variant={projectGridView ? 'secondary' : 'ghost'} className="size-8" onClick={() => setProjectGridView(true)} aria-label="网格视图"><Grid2X2 className="size-4" /></Button>
              <Button size="icon" variant={!projectGridView ? 'secondary' : 'ghost'} className="size-8" onClick={() => setProjectGridView(false)} aria-label="列表视图"><List className="size-4" /></Button>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex h-10 w-64 items-center gap-2 rounded-lg border border-border bg-card px-3 text-muted-foreground"><Search className="size-4" /><input value={projectSearch} onChange={event => { setProjectSearch(event.target.value); setSelectedRecentDirectories([]) }} placeholder="搜索项目…" className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none" /></label>
            <Button className="h-10 bg-foreground px-5 text-background hover:bg-foreground/85" onClick={() => void showNewProject()}><Plus />新建项目</Button>
            <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" variant="ghost" aria-label="设置"><Settings2 /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => window.setTimeout(() => setModelManagerOpen(true), 0)}>模型管理</DropdownMenuItem><DropdownMenuItem onSelect={() => window.setTimeout(openEnvironmentSetup, 0)}>分析环境</DropdownMenuItem><DropdownMenuItem onSelect={() => window.setTimeout(() => void openStorageManager(), 0)}>存储与环境</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
          </div>
        </header>
        <section className="p-7">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div><h1 className="text-sm font-semibold">项目</h1><p className="mt-1 text-xs text-muted-foreground">最近打开的工程与默认工程目录 · {recentProjects.filter(project => project.available !== false).length} 个</p></div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => void refreshRecentProjects()} disabled={projectActionBusy || !window.pitchordDesktop}><RefreshCw className={projectActionBusy ? 'animate-spin' : ''} />刷新</Button>
              <Button size="sm" variant={projectSelectionMode ? 'secondary' : 'outline'} onClick={() => { setProjectSelectionMode(!projectSelectionMode); setSelectedRecentDirectories([]) }} disabled={!visibleRecentProjects.length}><CheckSquare2 />{projectSelectionMode ? '完成选择' : '选择'}</Button>
            </div>
          </div>
          {projectHomeMessage && <p className="mb-4 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm" role="status">{projectHomeMessage}</p>}
          {projectSelectionMode && <div className="mb-5 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-2 text-sm">
            <Button size="sm" variant="ghost" onClick={() => setSelectedRecentDirectories(selectedVisibleProjects.length === visibleRecentProjects.length ? [] : visibleRecentProjects.map(project => project.directory))}>{selectedVisibleProjects.length === visibleRecentProjects.length ? '取消全选' : '全选当前结果'}</Button>
            <span className="mr-auto text-xs text-muted-foreground">已选 {selectedVisibleProjects.length} 个</span>
            <Button size="sm" variant="outline" disabled={selectedVisibleProjects.length !== 1 || selectedVisibleProjects[0]?.available === false} onClick={() => void openProject(selectedVisibleProjects[0].directory)}>打开</Button>
            <Button size="sm" variant="outline" disabled={selectedVisibleProjects.length !== 1 || selectedVisibleProjects[0]?.available === false || !window.pitchordDesktop} onClick={() => beginProjectDuplicate(selectedVisibleProjects[0])}><Copy />复制</Button>
            <Button size="sm" variant="outline" disabled={!selectedVisibleProjects.length} onClick={() => removeRecentProjects(selectedVisibleProjects.map(project => project.directory))}>从列表移除</Button>
            <Button size="sm" variant="destructive" disabled={!selectedVisibleProjects.length || selectedVisibleProjects.some(project => project.available === false) || !window.pitchordDesktop} onClick={() => setPendingProjectTrash(selectedVisibleProjects)}><Trash2 />移入回收站</Button>
          </div>}
          <div className={projectGridView ? 'grid max-w-6xl grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3' : 'max-w-5xl space-y-3'}>
            {visibleRecentProjects.map(project => <div key={project.directory} className={projectGridView ? `project-card group relative overflow-hidden rounded-xl border bg-card transition hover:border-primary/50 ${selectedRecentDirectories.includes(project.directory) ? 'border-primary ring-1 ring-primary' : 'border-border'}` : `group flex w-full items-center gap-2 rounded-xl border bg-card p-2 transition hover:border-primary/50 ${selectedRecentDirectories.includes(project.directory) ? 'border-primary ring-1 ring-primary' : 'border-border'}`}>
              {projectSelectionMode && <button type="button" aria-label={`${selectedRecentDirectories.includes(project.directory) ? '取消选择' : '选择'}${project.name}`} aria-pressed={selectedRecentDirectories.includes(project.directory)} onClick={() => toggleRecentSelection(project.directory)} className={projectGridView ? 'absolute left-3 top-3 z-10 flex size-8 items-center justify-center rounded-md bg-background/90 shadow-sm' : 'flex size-9 shrink-0 items-center justify-center rounded-md hover:bg-muted'}>{selectedRecentDirectories.includes(project.directory) ? <CheckSquare2 className="size-5 text-primary" /> : <Square className="size-5 text-muted-foreground" />}</button>}
              <button type="button" onClick={() => projectSelectionMode ? toggleRecentSelection(project.directory) : project.available === false ? setProjectHomeMessage('工程位置已失效。请从最近列表移除，或从文件夹重新打开。') : void openProject(project.directory)} className={projectGridView ? 'block w-full text-left' : 'flex min-w-0 flex-1 items-center gap-4 text-left'}>
                <div className={projectGridView ? 'relative flex aspect-video items-center justify-center bg-neutral-950' : 'flex h-16 w-28 shrink-0 items-center justify-center rounded-lg bg-neutral-950'}><AudioLines className="size-10 text-white/45" />{projectGridView && <span className="absolute bottom-2 right-2 text-[11px] text-white/75">PITCHORD</span>}</div>
                <div className={projectGridView ? 'p-4 pr-12' : 'min-w-0 flex-1'}><p className="truncate font-medium">{project.name}</p><p className="mt-2 truncate text-xs text-muted-foreground">{project.available === false ? '位置已失效' : project.updatedAt ? new Date(project.updatedAt).toLocaleString() : '尚未记录修改时间'}</p></div>
              </button>
              <DropdownMenu modal={false}><DropdownMenuTrigger asChild><Button size="icon" variant="ghost" className={projectGridView ? 'absolute bottom-3 right-3 size-8' : 'size-8 shrink-0'} aria-label={`${project.name}的更多操作`}><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => void openProject(project.directory)} disabled={project.available === false}><FolderOpen />打开工程</DropdownMenuItem><DropdownMenuItem onSelect={() => beginProjectDuplicate(project)} disabled={project.available === false || !window.pitchordDesktop}><Copy />复制工程</DropdownMenuItem><DropdownMenuItem onSelect={() => void revealRecentProject(project)} disabled={project.available === false || !window.pitchordDesktop}><FolderOpen />在文件夹中显示</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => removeRecentProjects([project.directory])}>从最近列表移除</DropdownMenuItem><DropdownMenuItem onSelect={() => setPendingProjectTrash([project])} disabled={project.available === false || !window.pitchordDesktop} className="text-destructive focus:text-destructive"><Trash2 />移入回收站…</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
            </div>)}
            <button type="button" onClick={() => void showNewProject()} className={projectGridView ? 'flex aspect-[16/10] min-h-52 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card/40 text-muted-foreground transition hover:border-primary/60 hover:text-primary' : 'flex w-full items-center gap-3 rounded-xl border border-dashed border-border bg-card/40 p-5 text-muted-foreground hover:border-primary/60 hover:text-primary'}><span className="flex size-11 items-center justify-center rounded-full border border-current"><Plus className="size-5" /></span><span className="font-medium">新建项目</span></button>
          </div>
          {!visibleRecentProjects.length && projectSearch && <p className="mt-8 text-sm text-muted-foreground">没有匹配的最近项目。</p>}
          <Button variant="ghost" className="mt-6" onClick={() => void openProject()}><FolderOpen />从文件夹打开项目</Button>
        </section>
      </main> : <>
      <header className="workspace-header flex h-14 items-center justify-between border-b border-border bg-card px-4">
        <div className="flex min-w-0 items-center gap-3">
          <Button size="icon" variant="ghost" onClick={() => void closeProjectToHome()} aria-label="返回所有项目"><AudioLines className="text-primary" /></Button>
          {projectNameEditing ? <Input autoFocus value={projectNameDraft} onChange={event => setProjectNameDraft(event.target.value)} onBlur={saveProjectName} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') setProjectNameEditing(false) }} className="h-9 w-56 font-semibold" /> : <button type="button" onClick={beginProjectNameEdit} className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-muted"><span className="max-w-64 truncate font-semibold">{projectName || '未命名项目'}</span><Pencil className="size-3.5 text-muted-foreground" /></button>}
          <span className="hidden text-xs text-muted-foreground md:inline">{mediaName || '等待导入素材'}</span>
        </div>
        <div className="flex items-center gap-2">
          <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" size="sm"><Download />导出字幕<ChevronDown className="size-3" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuLabel>通用字幕</DropdownMenuLabel><DropdownMenuItem onSelect={() => void exportLrc()} disabled={!segments.length}>句级 LRC · 开始时间 + 歌词</DropdownMenuItem><DropdownMenuItem onSelect={() => void exportSrt()} disabled={!segments.length}>句级 SRT · 开始/结束时间 + 歌词</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuLabel>精准字幕</DropdownMenuLabel><DropdownMenuItem onSelect={() => void exportWordSubtitles('ass')} disabled={!subtitleReady}>精准 ASS · 字级时间 + 音高 + 完整样式</DropdownMenuItem><DropdownMenuItem onSelect={() => void exportWordSubtitles('json')} disabled={!subtitleReady}>字级 JSON · 结构化时间与音高数据</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => void exportProject()}><Save />保存项目</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
          <Button size="sm" onClick={() => setSubtitleStudioOpen(true)} disabled={!subtitleReady}><Video />生成视频</Button>
          <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" variant="ghost" aria-label="更多设置"><Settings2 /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => window.setTimeout(() => setModelManagerOpen(true), 0)}>模型管理</DropdownMenuItem><DropdownMenuItem onSelect={() => window.setTimeout(openEnvironmentSetup, 0)}>分析环境</DropdownMenuItem><DropdownMenuItem onSelect={() => window.setTimeout(() => void openStorageManager(), 0)}>存储与环境</DropdownMenuItem>{projectDirectory && <><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => void window.pitchordDesktop?.openProjectFolder()}>工程文件夹</DropdownMenuItem><DropdownMenuItem onSelect={() => void window.pitchordDesktop?.openLyricsFolder()}>歌词备份</DropdownMenuItem><DropdownMenuItem onSelect={() => void restoreLyricsBackup()}>恢复歌词</DropdownMenuItem></>}</DropdownMenuContent></DropdownMenu>
        </div>
      </header>
      <nav className="hidden" aria-label="应用菜单">
        <DropdownMenu modal={false}><DropdownMenuTrigger asChild><Button variant="ghost" size="sm" className="h-7 px-3 font-normal">文件</Button></DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuLabel>工程</DropdownMenuLabel><DropdownMenuItem onSelect={() => void showNewProject()}><FilePlus2 />新建项目</DropdownMenuItem><DropdownMenuItem onSelect={() => void openProject()}><FolderOpen />打开项目</DropdownMenuItem><DropdownMenuItem onSelect={() => void exportProject()} disabled={!projectDirectory && !segments.length}><Save />保存项目</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => mediaInputRef.current?.click()}><Upload />导入媒体</DropdownMenuItem><DropdownMenuItem onSelect={() => lyricInputRef.current?.click()} disabled={!mediaUrl}><FileText />导入 LRC</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => void exportLrc()} disabled={!segments.length}><Download />导出句级 LRC</DropdownMenuItem><DropdownMenuItem onSelect={() => window.setTimeout(() => setSubtitleStudioOpen(true), 0)} disabled={!segments.some(segment => segment.chars.length)}><Video />字幕导出与视频生成</DropdownMenuItem><DropdownMenuSeparator />{projectDirectory && <DropdownMenuItem onSelect={() => void window.pitchordDesktop?.openProjectFolder()}><FolderOpen />打开工程文件夹</DropdownMenuItem>}</DropdownMenuContent></DropdownMenu>
        <DropdownMenu modal={false}><DropdownMenuTrigger asChild><Button variant="ghost" size="sm" className="h-7 px-3 font-normal">设置</Button></DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuItem onSelect={() => window.setTimeout(() => setModelManagerOpen(true), 0)}><Settings2 />模型管理</DropdownMenuItem><DropdownMenuItem onSelect={() => window.setTimeout(openEnvironmentSetup, 0)}><Activity />分析环境</DropdownMenuItem><DropdownMenuItem onSelect={() => window.setTimeout(() => void openStorageManager(), 0)}><HardDrive />存储与环境</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
      </nav>
      <header className="hidden">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary/15 text-primary"><AudioLines className="size-5" /></div>
          <div><h1 className="text-base font-semibold leading-5">Pitchord</h1><p className="text-xs text-muted-foreground">歌词时间编辑器</p></div>
          <Badge variant="secondary" className="ml-2 max-w-52 truncate">{projectName || '未建工程'}</Badge>
          <Badge variant="outline" className="max-w-52 truncate">{mediaName || '未导入媒体'}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input ref={mediaInputRef} type="file" accept="audio/*,video/*" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) { if (window.pitchordDesktop && !projectDirectory) { pendingMediaRef.current = file; void showNewProject() } else void loadMedia(file) } event.target.value = '' }} />
          <input ref={vocalInputRef} type="file" accept="audio/*" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) { clearHarmonyTrack(); void loadVocalTrack(file) } event.target.value = '' }} />
          <input ref={lyricInputRef} type="file" accept=".lrc,.txt,text/plain" className="hidden" onChange={async event => { const file = event.target.files?.[0]; if (file) await importLyrics(await file.text(), file.name); event.target.value = '' }} />
          <Button variant="ghost" size="sm" onClick={() => void showNewProject()} disabled={editingLocked}><FilePlus2 />新建项目</Button>
          <Button variant="outline" size="sm" onClick={() => mediaInputRef.current?.click()} disabled={editingLocked}><Upload />导入媒体</Button>
          <Button variant="outline" size="sm" onClick={() => lyricInputRef.current?.click()} disabled={!mediaUrl || editingLocked}><FileText />导入 LRC</Button>
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)} disabled={!mediaUrl || editingLocked}>粘贴歌词</Button>
          <Button variant="outline" size="sm" onClick={() => void openProject()} disabled={editingLocked}><FolderOpen />打开项目</Button>
          {projectDirectory && <Button variant="ghost" size="sm" onClick={() => void window.pitchordDesktop?.openProjectFolder()}><FolderOpen />工程文件夹</Button>}
          {projectDirectory && <Button variant="ghost" size="sm" onClick={() => void window.pitchordDesktop?.openLyricsFolder()}><FileText />歌词备份</Button>}
          {projectDirectory && <Button variant="ghost" size="sm" onClick={() => void restoreLyricsBackup()}><Undo2 />恢复歌词</Button>}
          <Button variant="outline" size="sm" onClick={() => void exportProject()} disabled={!projectDirectory && !segments.length}><Save />保存项目</Button>
          <Button variant="outline" size="sm" onClick={() => void exportLrc()} disabled={!segments.length}><Download />导出 LRC</Button>
          <Button variant="secondary" size="sm" onClick={() => setSubtitleStudioOpen(true)} disabled={!segments.some(segment => segment.chars.length)}><Video />字幕导出与视频生成</Button>
        </div>
      </header>

      <main className="mx-auto max-w-[1900px] p-3 md:p-4">
        <div className="hidden">
          <div />
          <div className="flex items-center gap-1">
            <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" onClick={undo} disabled={!history.past.length || editingLocked} aria-label="撤回"><Undo2 /></Button></TooltipTrigger><TooltipContent>撤回 Ctrl+Z</TooltipContent></Tooltip>
            <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" onClick={redo} disabled={!history.future.length || editingLocked} aria-label="重做"><Redo2 /></Button></TooltipTrigger><TooltipContent>重做 Ctrl+Shift+Z</TooltipContent></Tooltip>
          </div>
        </div>

        <section className="workspace-overview grid gap-3 xl:grid-cols-[300px_minmax(520px,1fr)_320px]">
          <aside className="rounded-xl border border-border bg-card p-3">
            <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">素材</h2><Button size="sm" variant="outline" onClick={() => mediaInputRef.current?.click()}><Upload />导入</Button></div>
            <div className="space-y-2">
              <button type="button" onClick={() => mediaInputRef.current?.click()} className="flex w-full items-center gap-3 rounded-lg border border-border bg-background p-3 text-left hover:border-primary/50"><span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><Video className="size-4" /></span><span className="min-w-0 flex-1"><span className="block text-xs text-muted-foreground">音频 / 视频</span><span className="mt-0.5 block truncate text-sm font-medium">{mediaName || '点击导入素材'}</span></span>{mediaUrl && <CheckCircle2 className="size-4 text-emerald-500" />}</button>
              <button type="button" onClick={() => lyricInputRef.current?.click()} disabled={!mediaUrl} className="flex w-full items-center gap-3 rounded-lg border border-border bg-background p-3 text-left hover:border-primary/50 disabled:opacity-50"><span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><FileText className="size-4" /></span><span className="min-w-0 flex-1"><span className="block text-xs text-muted-foreground">参考歌词</span><span className="mt-0.5 block truncate text-sm font-medium">{segments.length ? `已导入 ${segments.length} 句歌词` : '导入 LRC / TXT'}</span></span>{!!segments.length && <CheckCircle2 className="size-4 text-emerald-500" />}</button>
              <Button variant="ghost" className="w-full justify-start text-muted-foreground" onClick={() => setImportOpen(true)} disabled={!mediaUrl}><FileText />或直接粘贴歌词</Button>
            </div>
            <div className="mt-4 border-t border-border pt-3"><p className="mb-2 text-xs font-medium">试听音轨</p><div className="space-y-2">{(['original', 'vocals', 'harmonies', 'accompaniment'] as const).map(kind => { const available = kind === 'original' ? !!mediaUrl : !!stemReady[kind]; const label = kind === 'original' ? '原始音频' : kind === 'vocals' ? '主唱／人声' : kind === 'harmonies' ? '和声' : '纯伴奏'; return <div key={kind} className="flex items-center gap-2"><Button size="sm" variant={trackEnabled[kind] ? 'secondary' : 'ghost'} className="w-24 justify-start" onClick={() => toggleTrack(kind)} disabled={!available}>{label}</Button><Slider min={0} max={kind === 'original' ? 100 : 200} step={5} value={[trackVolume[kind]]} onValueChange={values => setTrackVolume(current => ({ ...current, [kind]: values[0] }))} disabled={!available} /><span className="w-9 text-right text-[11px] text-muted-foreground">{trackVolume[kind]}%</span></div> })}</div></div>
          </aside>

          <section className="min-w-0 rounded-xl border border-border bg-card p-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 px-1">
              <div><h2 className="text-sm font-semibold">视频与字幕实时预览</h2><p className="text-[11px] text-muted-foreground">这里的字幕样式与最终导出共用，修改后立即更新</p></div>
              <div className="flex flex-wrap gap-2"><Button size="sm" variant={floatingVideoUrl === mediaUrl && mediaIsVideo ? 'secondary' : 'outline'} onClick={() => setFloatingVideoUrl(current => current === mediaUrl ? '' : mediaUrl)} disabled={!mediaUrl || !mediaIsVideo} aria-pressed={floatingVideoUrl === mediaUrl && mediaIsVideo}><Video className="size-4" />{floatingVideoUrl === mediaUrl && mediaIsVideo ? '关闭小窗' : '悬浮小窗'}</Button><Button size="sm" variant="outline" onClick={() => setSubtitleStudioOpen(true)} disabled={!mediaUrl}><SlidersHorizontal className="size-4" />调整字幕样式</Button></div>
            </div>
            <div className="relative flex min-h-64 items-center justify-center overflow-hidden rounded-lg bg-neutral-950">
              {mediaUrl ? mediaIsVideo ? <div ref={videoPreviewRef} className="video-preview-shell relative flex h-[330px] w-full items-center justify-center" style={{ '--video-aspect': videoAspect } as CSSProperties}><div className="video-preview-frame relative max-h-full max-w-full" style={{ width: `min(100%, ${330 * videoAspect}px)`, aspectRatio: videoAspect }}><video key={mediaUrl} ref={bindMedia} src={mediaUrl} className="h-full w-full object-contain" onLoadedMetadata={event => onMediaMetadata(event.currentTarget)} onTimeUpdate={event => onMediaTimeUpdate(event.currentTarget)} onPlay={event => onMediaPlay(event.currentTarget)} onPause={onMediaPause} onSeeking={event => onMediaSeeking(event.currentTarget)} onSeeked={event => onMediaSeeked(event.currentTarget)} onRateChange={event => mixerRef.current?.rateChanged(event.currentTarget)} onVolumeChange={event => onMediaVolumeChange(event.currentTarget)} onEnded={onMediaEnded} /><LiveSubtitlePreview segments={effectiveSegments} points={pitchPoints} style={subtitleStyle} mediaRef={mediaRef} playhead={playhead} /></div></div> : <div className="relative flex min-h-64 w-full flex-col items-center justify-center gap-4 text-white/60"><audio key={mediaUrl} ref={bindMedia} src={mediaUrl} className="hidden" onLoadedMetadata={event => onMediaMetadata(event.currentTarget)} onTimeUpdate={event => onMediaTimeUpdate(event.currentTarget)} onPlay={event => onMediaPlay(event.currentTarget)} onPause={onMediaPause} onSeeking={event => onMediaSeeking(event.currentTarget)} onSeeked={event => onMediaSeeked(event.currentTarget)} onRateChange={event => mixerRef.current?.rateChanged(event.currentTarget)} onVolumeChange={event => onMediaVolumeChange(event.currentTarget)} onEnded={onMediaEnded} /><AudioLines className="size-16" /><span>{mediaName}</span><LiveSubtitlePreview segments={effectiveSegments} points={pitchPoints} style={subtitleStyle} mediaRef={mediaRef} playhead={playhead} /></div> : <button type="button" onClick={() => mediaInputRef.current?.click()} className="flex flex-col items-center gap-3 text-white/55 hover:text-white"><Upload className="size-8" /><span>导入音频或视频开始</span></button>}
            </div>
            <div className="px-1 pt-3"><input type="range" min={0} max={Math.max(duration, 0.01)} step={0.01} value={Math.min(playhead, Math.max(duration, 0.01))} onChange={event => seek(Number(event.target.value))} disabled={!mediaUrl} className="h-1.5 w-full cursor-pointer accent-primary disabled:cursor-default" aria-label="媒体播放进度" /></div>
            <div className="flex items-center justify-between gap-2 px-1 py-2"><span className="w-32 font-mono text-xs tabular-nums text-primary">{formatTime(playhead)} <span className="text-muted-foreground">/ {formatTime(duration)}</span></span><div className="flex items-center gap-1"><Tooltip><TooltipTrigger asChild><Button size="icon" variant="ghost" onClick={() => skipPlayback(-5)} disabled={!mediaUrl} aria-label="后退 5 秒"><RotateCcw /></Button></TooltipTrigger><TooltipContent>后退 5 秒</TooltipContent></Tooltip><Button size="icon" onClick={() => void togglePlayback()} disabled={!mediaUrl} aria-label={playing ? '暂停' : '播放'}>{playing ? <Pause /> : <Play />}</Button><Tooltip><TooltipTrigger asChild><Button size="icon" variant="ghost" onClick={() => skipPlayback(5)} disabled={!mediaUrl} aria-label="前进 5 秒"><RotateCw /></Button></TooltipTrigger><TooltipContent>前进 5 秒</TooltipContent></Tooltip></div><div className="flex items-center justify-end gap-2"><label className="flex items-center gap-1 text-[11px] text-muted-foreground">速度 <select aria-label="播放速度" value={playbackRate} onChange={event => { const rate = Number(event.target.value); setPlaybackRate(rate); if (mediaRef.current) mediaRef.current.playbackRate = rate }} className="rounded border border-border bg-background px-1 py-0.5"><option value={0.5}>0.5×</option><option value={0.75}>0.75×</option><option value={1}>1×</option><option value={1.25}>1.25×</option></select></label><Button size="icon" variant="ghost" onClick={toggleMasterMute} disabled={!mediaUrl} aria-label={masterMuted ? '取消静音' : '静音'}>{masterMuted ? <VolumeX /> : <Volume2 />}</Button><input type="range" min={0} max={100} step={1} value={masterVolume} onChange={event => changeMasterVolume(Number(event.target.value))} disabled={!mediaUrl} className="w-16 accent-primary" aria-label="总音量" />{mediaIsVideo && <Button size="icon" variant="ghost" onClick={openFullscreenPreview} disabled={!mediaUrl} aria-label="全屏预览"><Maximize2 /></Button>}</div></div>
            <div className="flex items-center justify-end gap-1 border-t border-border py-1"><Tooltip><TooltipTrigger asChild><Button size="icon" variant="ghost" onClick={undo} disabled={!history.past.length || editingLocked}><Undo2 /></Button></TooltipTrigger><TooltipContent>撤回</TooltipContent></Tooltip><Tooltip><TooltipTrigger asChild><Button size="icon" variant="ghost" onClick={redo} disabled={!history.future.length || editingLocked}><Redo2 /></Button></TooltipTrigger><TooltipContent>重做</TooltipContent></Tooltip></div>
            <div className="workflow-rail grid grid-cols-7 border-t border-border pt-3">{workflowSteps.map((step, index) => <div key={step.label} className="relative flex min-w-0 flex-col items-center gap-1 text-center"><span className={`z-10 flex size-6 items-center justify-center rounded-full border text-[11px] ${step.done ? 'border-emerald-500 bg-emerald-500 text-white' : step.running || index === activeWorkflowIndex ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-muted-foreground'}`}>{step.done ? <CheckCircle2 className="size-3.5" /> : index + 1}</span><span className={`truncate text-[11px] ${step.done || step.running || index === activeWorkflowIndex ? 'text-foreground' : 'text-muted-foreground'}`}>{step.label}</span>{index < workflowSteps.length - 1 && <span className={`absolute left-[58%] right-[-42%] top-3 h-px ${step.done ? 'bg-emerald-500' : 'bg-border'}`} />}</div>)}</div>
          </section>

          <aside className="rounded-xl border border-border bg-card p-3">
            <h2 className="font-semibold">处理</h2>
            <Button className="mt-3 w-full" onClick={() => void runAutomaticPipeline()} disabled={pipelineTaskRunning || !mediaUrl || !segments.length}><WandSparkles />{automaticProcessing ? '正在继续处理…' : remainingWorkflowSteps < 6 ? `继续一键处理（剩余 ${remainingWorkflowSteps} 步）` : '一键自动处理'}</Button>
            <p className="mt-2 text-center text-[11px] text-muted-foreground">自动复用已有结果，只继续尚未完成的阶段</p>
            <div className="mt-4 space-y-1">{workflowSteps.map((step, index) => <div key={step.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs"><span className={`flex size-5 shrink-0 items-center justify-center rounded-full ${step.done ? 'bg-emerald-100 text-emerald-700' : step.running ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'}`}>{step.done ? <CheckCircle2 className="size-3.5" /> : index + 1}</span><span className="min-w-0 flex-1"><span className="block">{step.label}</span><span className="text-[10px] text-muted-foreground">{step.done ? '已完成' : step.running ? '处理中' : step.id === 'matching' ? '音高与时间结果就绪后自动完成' : '等待中'}</span></span>{step.action && <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2 text-[11px]" onClick={step.action} disabled={step.disabled}>{step.actionLabel}</Button>}</div>)}</div>
            <details className="mt-4 rounded-lg border border-border bg-background">
              <summary className="flex cursor-pointer list-none items-center gap-2 p-3 text-sm font-medium"><SlidersHorizontal className="size-4" />高级设置<ChevronDown className="ml-auto size-4" /></summary>
              <div className="space-y-3 border-t border-border p-3">
                <div className="flex items-center justify-between text-xs"><span>分析环境</span><Badge variant={analysisEnvironment?.completeReady ? 'secondary' : 'outline'}>{analysisEnvironment?.completeReady ? '可用' : '需准备'}</Badge></div>
                <div className="grid grid-cols-2 gap-2"><Button size="sm" variant="outline" onClick={openEnvironmentSetup}>分析环境</Button><Button size="sm" variant="outline" onClick={() => setModelManagerOpen(true)}>模型管理</Button></div>
                <label className="block space-y-1 text-xs text-muted-foreground">人声分离模型<Select value={separationModel} onValueChange={setSeparationModel}><SelectTrigger className="h-9"><SelectValue placeholder="选择模型" /></SelectTrigger><SelectContent>{analysisEnvironment?.separationModels.filter(model => model.ready && model.runnable !== false).map(model => <SelectItem key={model.id} value={model.id}>{model.label}</SelectItem>)}</SelectContent></Select></label>
                <Button size="sm" variant="outline" className="w-full" onClick={requestSeparation} disabled={!mediaUrl || pipelineTaskRunning}>单独运行人声分离</Button>
                <label className="block space-y-1 text-xs text-muted-foreground">音高算法<Select value={pitchAlgorithm} onValueChange={value => setPitchAlgorithm(value as PitchAlgorithm)}><SelectTrigger className="h-9"><SelectValue /></SelectTrigger><SelectContent>{analysisEnvironment?.pitchMethods.map(method => <SelectItem key={method.id} value={method.id} disabled={!method.ready || method.runnable === false || !['pyin', 'torchcrepe', 'rmvpe', 'fcpe'].includes(method.id)}>{method.label}</SelectItem>)}</SelectContent></Select></label>
                <Button size="sm" variant="outline" className="w-full" onClick={requestPitchAnalysis} disabled={!vocalTrackReady || pipelineTaskRunning}>单独运行音高识别</Button>
                <div className="grid grid-cols-2 gap-2"><Select value={alignmentModel} onValueChange={setAlignmentModel}><SelectTrigger className="h-9"><SelectValue /></SelectTrigger><SelectContent>{analysisEnvironment?.alignment.models.map(model => <SelectItem key={model.id} value={model.id} disabled={!model.ready}>{model.label}</SelectItem>)}</SelectContent></Select><Select value={alignmentLanguage} onValueChange={setAlignmentLanguage}><SelectTrigger className="h-9"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="zh">中文</SelectItem><SelectItem value="en">英语</SelectItem><SelectItem value="ja">日语</SelectItem><SelectItem value="ko">韩语</SelectItem></SelectContent></Select></div>
                <Button size="sm" variant="outline" className="w-full" onClick={requestLyricAlignment} disabled={!alignmentInputResultId || pipelineTaskRunning}>单独运行歌词对齐</Button>
                <Button size="sm" variant="ghost" className="w-full" onClick={openPitchEditor} disabled={!segments.some(segment => segment.chars.length)}>打开人工校对</Button>
                <div className="border-t border-border pt-3"><p className="mb-2 text-xs font-medium text-foreground">字幕与视频样式</p><div className="grid grid-cols-2 gap-2"><Button size="sm" variant="outline" onClick={() => setSubtitleStyle(style => ({ ...style, ...subtitleStylePresets.karaoke }))}>卡拉 OK</Button><Button size="sm" variant="outline" onClick={() => setSubtitleStyle(style => ({ ...style, ...subtitleStylePresets.clean }))}>清爽描边</Button><Button size="sm" variant="outline" onClick={() => setSubtitleStyle(style => ({ ...style, ...subtitleStylePresets.cinema }))}>影院底栏</Button><Button size="sm" variant="outline" onClick={() => setSubtitleStyle(style => ({ ...style, ...subtitleStylePresets.minimal }))}>极简文字</Button></div></div>
                <div className="grid grid-cols-2 gap-2"><label className="space-y-1 text-xs text-muted-foreground">垂直位置<Select value={subtitleStyle.verticalPosition} onValueChange={value => setSubtitleStyle(style => ({ ...style, verticalPosition: value as SubtitleStyle['verticalPosition'] }))}><SelectTrigger className="h-9"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="top">顶部</SelectItem><SelectItem value="middle">中央</SelectItem><SelectItem value="bottom">底部</SelectItem></SelectContent></Select></label><label className="space-y-1 text-xs text-muted-foreground">水平位置<Select value={subtitleStyle.horizontalPosition} onValueChange={value => setSubtitleStyle(style => ({ ...style, horizontalPosition: value as SubtitleStyle['horizontalPosition'] }))}><SelectTrigger className="h-9"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="left">左侧</SelectItem><SelectItem value="center">居中</SelectItem><SelectItem value="right">右侧</SelectItem></SelectContent></Select></label></div>
                <label className="block space-y-1 text-xs text-muted-foreground">背景样式<Select value={subtitleStyle.backgroundStyle} onValueChange={value => setSubtitleStyle(style => ({ ...style, backgroundStyle: value as SubtitleStyle['backgroundStyle'] }))}><SelectTrigger className="h-9"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="outline">描边与阴影</SelectItem><SelectItem value="box">半透明底栏</SelectItem><SelectItem value="none">无背景</SelectItem></SelectContent></Select></label>
                <div className="grid grid-cols-2 gap-2"><Button size="sm" variant={subtitleStyle.bold ? 'secondary' : 'outline'} onClick={() => setSubtitleStyle(style => ({ ...style, bold: !style.bold }))}>粗体</Button><Button size="sm" variant={subtitleStyle.italic ? 'secondary' : 'outline'} onClick={() => setSubtitleStyle(style => ({ ...style, italic: !style.italic }))}>斜体</Button></div>
                <label className="block space-y-1 text-xs text-muted-foreground">边缘距离：{subtitleStyle.marginBottom}px<Slider min={24} max={260} step={4} value={[subtitleStyle.marginBottom]} onValueChange={values => setSubtitleStyle(style => ({ ...style, marginBottom: values[0] }))} /></label>
                {subtitleStyle.backgroundStyle === 'box' && <label className="block space-y-1 text-xs text-muted-foreground">底栏透明度：{subtitleStyle.backgroundOpacity}%<Slider min={20} max={100} step={5} value={[subtitleStyle.backgroundOpacity]} onValueChange={values => setSubtitleStyle(style => ({ ...style, backgroundOpacity: values[0] }))} /></label>}
                <div className="relative aspect-video overflow-hidden rounded-md bg-neutral-950"><div className="absolute max-w-[86%] whitespace-nowrap px-2 py-1 text-xs" style={{ left: subtitleStyle.horizontalPosition === 'left' ? '7%' : subtitleStyle.horizontalPosition === 'right' ? '93%' : '50%', top: subtitleStyle.verticalPosition === 'top' ? '14%' : subtitleStyle.verticalPosition === 'middle' ? '50%' : '82%', transform: `translate(${subtitleStyle.horizontalPosition === 'left' ? '0' : subtitleStyle.horizontalPosition === 'right' ? '-100%' : '-50%'}, -50%)`, color: subtitleStyle.baseColor, fontFamily: subtitleStyle.fontName, fontWeight: subtitleStyle.bold ? 700 : 400, fontStyle: subtitleStyle.italic ? 'italic' : 'normal', letterSpacing: subtitleStyle.spacing, backgroundColor: subtitleStyle.backgroundStyle === 'box' ? `rgb(0 0 0 / ${subtitleStyle.backgroundOpacity}%)` : 'transparent', textShadow: subtitleStyle.backgroundStyle === 'outline' ? `0 0 ${Math.max(2, subtitleStyle.outline)}px ${subtitleStyle.outlineColor}` : 'none' }}>示例精准字幕</div></div>
                <Button size="sm" className="w-full" onClick={() => setSubtitleStudioOpen(true)} disabled={!mediaUrl}>调整完整样式、预览或导出</Button>
              </div>
            </details>
          </aside>
        </section>

        <div className="space-y-4">
            <section className="hidden">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <Button size="icon" onClick={() => void togglePlayback()} disabled={!mediaUrl} aria-label={playing ? '暂停' : '播放'}>{playing ? <Pause /> : <Play />}</Button>
                  <div className="font-mono text-lg tabular-nums">{formatTime(playhead)} <span className="text-sm text-muted-foreground">/ {formatTime(duration)}</span></div>
                </div>
              </div>
              {mediaUrl && <div className="mt-4 overflow-hidden rounded-lg border border-border bg-background">
                <span className="sr-only">播放器位于上方主预览区</span>
                <p className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground"><span>播放器的静音与音量是全部已开启音轨的总开关和总响度；下方滑杆调整各音轨的相对响度。</span><span className="font-mono text-foreground" data-master-volume>{masterMuted ? '总音频：静音' : `总音量：${masterVolume}%`}</span></p>
              </div>}
              {!mediaUrl && <div className="mt-4 flex h-28 items-center justify-center gap-3 rounded-lg border border-dashed border-border text-muted-foreground"><FileAudio2 className="size-5" /><span>导入音频或视频以开始</span><Video className="size-5" /></div>}
            </section>

            <section className="hidden">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div><h2 className="font-semibold">音频处理与分析</h2><p className="mt-1 text-xs text-muted-foreground">先处理人声，再从纯人声轨识别连续音高，提升后续歌词匹配的稳定性。</p></div>
                <Badge variant={pitchPoints.length ? 'secondary' : 'outline'}>{pitchStatus}</Badge>
              </div>
              {window.pitchordDesktop && <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3" data-analysis-environment>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-2"><Settings2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><div><p className="text-sm font-medium">分析环境</p><p className="mt-1 text-xs text-muted-foreground">启动时自动检查媒体处理、人声分离、音高识别和歌词对齐能力。</p></div></div>
                  <Badge variant={analysisEnvironment?.completeReady ? 'secondary' : 'outline'}>{analysisEnvironment?.completeReady ? <CheckCircle2 className="mr-1 size-3" /> : <AlertCircle className="mr-1 size-3" />}{analysisEnvironment?.completeReady ? '环境可用' : '需要补齐'}</Badge>
                </div>
                <p className="mt-2 break-all font-mono text-xs text-muted-foreground">位置：{analysisEnvironment?.root || '/environment'}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>计算设备：</span><Badge variant={analysisEnvironment?.compute.cudaAvailable ? 'secondary' : 'outline'}>{analysisEnvironment?.compute.label || '正在检测…'}</Badge>{analysisEnvironment?.compute.cudaAvailable && <span>Demucs、MSST 与 TorchCrepe 自动使用 GPU</span>}{analysisEnvironment && !analysisEnvironment.compute.cudaAvailable && <span>当前运行环境使用 CPU；pYIN 始终使用 CPU</span>}{analysisEnvironment?.compute.alignmentCudaAvailable && <Badge variant="outline">Whisper GPU 可用</Badge>}</div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  {[
                    { label: '媒体音轨提取', ready: !!analysisEnvironment?.mediaTools.ffmpeg && !!analysisEnvironment?.mediaTools.ffprobe, detail: 'FFmpeg / FFprobe' },
                    { label: '人声分离', ready: !!analysisEnvironment?.packages.demucs && !!analysisEnvironment?.separationModels.some(model => model.ready), detail: analysisEnvironment?.separationModels.filter(model => model.ready).map(model => model.label).join('、') || '没有可用模型' },
                    { label: '音高识别', ready: !!analysisEnvironment?.pitchMethods.some(method => method.ready), detail: analysisEnvironment?.pitchMethods.filter(method => method.ready).map(method => method.label).join('、') || '没有可用算法' },
                    { label: '歌词时间对齐', ready: !!analysisEnvironment?.alignment.forcedAlignment, detail: analysisEnvironment?.alignment.forcedAlignment ? `自动对齐已就绪：${analysisEnvironment.alignment.models.filter(model => model.ready).map(model => model.label).join('、')}` : analysisEnvironment?.packages.fasterWhisper ? '组件已安装，尚未准备对齐模型' : '需要补齐 faster-whisper 组件与对齐模型' },
                  ].map(check => <div key={check.label} className="rounded-md border border-border bg-background p-2"><div className="flex items-center justify-between gap-2"><span className="text-xs font-medium">{check.label}</span>{check.ready ? <CheckCircle2 className="size-4 text-primary" /> : <AlertCircle className="size-4 text-destructive" />}</div><p className="mt-1 text-[11px] text-muted-foreground">{check.detail}</p></div>)}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{analysisProgress}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={openEnvironmentSetup} disabled={analysisEnvironmentBusy}>{analysisEnvironment?.completeReady ? '检查或更换环境' : '准备分析环境'}</Button>
                  <Button size="sm" variant="outline" onClick={() => void window.pitchordDesktop?.analysisStatus().then(status => { setAnalysisEnvironment(status); setAnalysisProgress('四类关键能力已重新检测'); updateWork('environment-check', '分析环境检测', 'success', '四类关键能力已重新检测', 1) })} disabled={analysisEnvironmentBusy}>重新检测</Button>
                  <Button size="sm" variant="ghost" onClick={() => void window.pitchordDesktop?.openAnalysisFolder()}>打开环境</Button>
                  <Button size="sm" variant="ghost" onClick={() => void openStorageManager()} disabled={analysisEnvironmentBusy}><HardDrive />管理存储</Button>
                  <Button size="sm" variant="ghost" onClick={() => setModelManagerOpen(true)} disabled={analysisEnvironmentBusy}><Settings2 />模型管理</Button>
                </div>
              </div>}
              <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">1. 人声分离</span><Select value={separationModel} onValueChange={setSeparationModel}><SelectTrigger className="w-52"><SelectValue placeholder="选择已安装模型" /></SelectTrigger><SelectContent>{analysisEnvironment?.separationModels.filter(model => model.ready && model.runnable !== false).map(model => <SelectItem key={model.id} value={model.id}>{model.label}</SelectItem>)}</SelectContent></Select><Button size="sm" variant="secondary" onClick={requestSeparation} disabled={!mediaUrl || !selectedSeparationModel?.ready || selectedSeparationModel?.runnable === false || pipelineTaskRunning || analysisEnvironmentBusy || (window.pitchordDesktop && !analysisEnvironment?.runtimeReady)}>运行人声分离</Button>{workItems.some(item => item.id === 'separation' && item.status === 'running') && <Button size="sm" variant="destructive" onClick={() => void cancelAnalysisTask('separation')}><Square />取消运行</Button>}<Button size="sm" variant="outline" onClick={() => setModelManagerOpen(true)}>模型管理</Button><Button size="sm" variant="ghost" onClick={() => vocalInputRef.current?.click()} disabled={!mediaUrl || pipelineTaskRunning}>导入外部人声结果</Button><span className="text-xs text-muted-foreground">{separationStatus}</span></div><p className="mt-2 text-xs text-muted-foreground">{selectedSeparationModel?.description || '请先在模型管理中准备或导入模型。'}</p>{separationResults.length > 0 && <p className="mt-2 text-xs text-muted-foreground">已保留 {separationResults.length} 组分离结果。纯人声与纯伴奏可在下方分别选择，不要求来自同一个模型。</p>}{projectDirectory && <p className="mt-2 break-all text-xs text-muted-foreground">工程：{projectDirectory}</p>}</div>
              <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">1b. 提取主唱、剥离和声</span><Select value={harmonyModelId} onValueChange={setHarmonyModelId}><SelectTrigger className="w-72"><SelectValue placeholder="选择去和声模型" /></SelectTrigger><SelectContent>{analysisEnvironment?.harmonyModels?.map(model => <SelectItem key={model.id} value={model.id}>{model.label}{model.ready ? '' : ' · 待准备'}</SelectItem>)}</SelectContent></Select><Button size="sm" variant="secondary" onClick={() => { if (selectedHarmonySource) void runHarmonySeparation(selectedHarmonySource) }} disabled={!selectedHarmonySource || !selectedHarmonyModel?.ready || selectedHarmonyModel.runnable === false || pipelineTaskRunning || analysisEnvironmentBusy}>从现有人声提取主唱</Button>{workItems.some(item => item.id === 'harmony' && item.status === 'running') && <Button size="sm" variant="destructive" onClick={() => void cancelAnalysisTask('harmony')}><Square />取消运行</Button>}<Button size="sm" variant="outline" onClick={() => setModelManagerOpen(true)}>准备模型</Button></div><label className="mt-2 flex items-center gap-2 text-xs"><input type="checkbox" checked={harmonyEnabled} onChange={event => setHarmonyEnabled(event.target.checked)} />一键自动处理时也提取主唱，后续音高和歌词对齐只使用主唱轨</label><p className="mt-2 text-xs text-muted-foreground">{selectedHarmonySource ? `当前输入：${selectedHarmonySource.modelLabel}。` : '请先完成人声分离。'} 原人声结果不会覆盖；剥离出的和声作为独立音轨保留，暂不标注歌词。CPU 处理整首歌可能较慢。{selectedHarmonyModel?.description || ''}</p></div>
              <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3"><p className="mb-3 text-sm font-medium">试听音轨 <span className="text-xs font-normal text-muted-foreground">可多选叠加，切换时保持同一播放位置</span></p><div className="grid gap-3 sm:grid-cols-4">{(['original', 'vocals', 'harmonies', 'accompaniment'] as const).map(kind => {
                const available = kind === 'original' ? !!mediaUrl : !!stemReady[kind]
                const label = kind === 'original' ? '原音频' : kind === 'vocals' ? '主唱／人声' : kind === 'harmonies' ? '和声／残留' : '纯伴奏'
                const selectedResultId = kind === 'vocals' ? activeVocalResultId : activeAccompanimentResultId
                return <div key={kind} className="rounded-md border border-border bg-background p-2"><Button size="sm" className="w-full" variant={trackEnabled[kind] ? 'secondary' : 'outline'} aria-pressed={trackEnabled[kind]} onClick={() => toggleTrack(kind)} disabled={!available}>{label} · {trackEnabled[kind] ? '开' : '关'}</Button>{kind !== 'original' && kind !== 'harmonies' && separationResults.length > 0 && <Select value={selectedResultId} onValueChange={value => void selectStemResult(kind, value)}><SelectTrigger className="mt-2 h-8 w-full text-xs"><SelectValue placeholder={`选择${label}结果`} /></SelectTrigger><SelectContent>{separationResults.map(result => <SelectItem key={`${kind}-${result.id}`} value={result.id}>{result.modelLabel} · {new Date(result.createdAt).toLocaleTimeString()}</SelectItem>)}</SelectContent></Select>}<div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><Slider min={0} max={kind === 'original' ? 100 : 200} step={5} value={[trackVolume[kind]]} onValueChange={values => setTrackVolume(current => ({ ...current, [kind]: values[0] }))} disabled={!available} aria-label={`${label}音量`} /><span className="w-9 text-right tabular-nums">{trackVolume[kind]}%</span></div></div>
              })}</div></div>
              <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">2. 音高识别</span><Select value={pitchAlgorithm} onValueChange={value => setPitchAlgorithm(value as PitchAlgorithm)}><SelectTrigger className="w-48"><SelectValue /></SelectTrigger><SelectContent>{analysisEnvironment?.pitchMethods.map(method => <SelectItem key={method.id} value={method.id} disabled={!method.ready || method.runnable === false || !['pyin', 'torchcrepe', 'rmvpe', 'fcpe'].includes(method.id)}>{method.label}{method.ready && method.runnable !== false ? ' · 已就绪' : ' · 尚未可用'}</SelectItem>)}</SelectContent></Select>{separationResults.length > 0 && <Select value={pitchInputResultId} onValueChange={value => void selectPitchInput(value)}><SelectTrigger className="w-64"><SelectValue placeholder="选择音高识别所用纯人声" /></SelectTrigger><SelectContent>{separationResults.map(result => <SelectItem key={`pitch-input-${result.id}`} value={result.id}>输入：{result.modelLabel} · {new Date(result.createdAt).toLocaleTimeString()}</SelectItem>)}</SelectContent></Select>}<Button size="sm" variant="secondary" onClick={requestPitchAnalysis} disabled={!mediaUrl || !vocalTrackReady || !audioReady || workItems.some(item => item.id === 'pitch' && item.status === 'running')} >识别连续音高</Button>{workItems.some(item => item.id === 'pitch' && item.status === 'running') && <Button size="sm" variant="destructive" onClick={() => void cancelAnalysisTask('pitch')}><Square />取消运行</Button>}<Button size="sm" variant="outline" onClick={() => setModelManagerOpen(true)}>模型管理</Button></div><p className="mt-2 text-xs text-muted-foreground">音高识别只读取上面明确选择的纯人声结果。{analysisEnvironment?.pitchMethods.find(method => method.id === pitchAlgorithm)?.description || '浏览器预览使用基础自相关分析。'} {pitchAlgorithm === 'pyin' || pitchAlgorithm === 'rmvpe' ? '当前使用 CPU。' : `当前将使用${analysisEnvironment?.compute.cudaAvailable ? ` GPU：${analysisEnvironment.compute.cudaDeviceName}` : ' CPU'}`}</p>{pitchResults.length > 0 && <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3"><span className="text-xs text-muted-foreground">当前音高结果</span><Select value={activePitchResultId} onValueChange={selectPitchResult}><SelectTrigger className="w-64"><SelectValue /></SelectTrigger><SelectContent>{pitchResults.map(result => <SelectItem key={result.id} value={result.id}>{result.label}{result.device ? ` · ${result.device}` : ''} · {new Date(result.createdAt).toLocaleString()}</SelectItem>)}</SelectContent></Select><span className="text-xs text-muted-foreground">字级匹配和字幕实时使用所选结果</span></div>}</div>
              <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">3. 歌词时间戳匹配</span><Select value={alignmentModel} onValueChange={setAlignmentModel}><SelectTrigger className="w-48"><SelectValue /></SelectTrigger><SelectContent>{analysisEnvironment?.alignment.models.map(model => <SelectItem key={model.id} value={model.id} disabled={!model.ready}>{model.label}{model.ready ? ' · 已就绪' : ' · 未准备'}</SelectItem>)}</SelectContent></Select><Select value={alignmentLanguage} onValueChange={setAlignmentLanguage}><SelectTrigger className="w-32"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="zh">中文</SelectItem><SelectItem value="en">英语</SelectItem><SelectItem value="ja">日语</SelectItem><SelectItem value="ko">韩语</SelectItem></SelectContent></Select>{separationResults.length > 0 && <Select value={alignmentInputResultId} onValueChange={value => void selectAlignmentInput(value)}><SelectTrigger className="w-64"><SelectValue placeholder="选择歌词匹配所用纯人声" /></SelectTrigger><SelectContent>{separationResults.map(result => <SelectItem key={`alignment-input-${result.id}`} value={result.id}>输入：{result.modelLabel} · {new Date(result.createdAt).toLocaleTimeString()}</SelectItem>)}</SelectContent></Select>}<Button size="sm" variant="secondary" onClick={requestLyricAlignment} disabled={!segments.length || !alignmentInputResultId || !analysisEnvironment?.alignment.models.find(model => model.id === alignmentModel)?.ready || workItems.some(item => item.id === 'alignment' && item.status === 'running')}>自动匹配歌词时间</Button>{workItems.some(item => item.id === 'alignment' && item.status === 'running') && <Button size="sm" variant="destructive" onClick={() => void cancelAnalysisTask('alignment')}><Square />取消运行</Button>}<Button size="sm" variant="outline" onClick={() => setModelManagerOpen(true)}>模型管理</Button></div><p className="mt-2 text-xs text-muted-foreground">输入歌词作为最终文本；模型只从所选纯人声中取得字词时间戳，再以单调文本匹配生成句级和字级时间建议。结果应用后仍可撤回和人工调整。当前使用{analysisEnvironment?.compute.alignmentCudaAvailable ? ' GPU' : ' CPU'}。</p><p className="mt-2 text-xs text-muted-foreground">{alignmentStatus}</p>{alignmentResults.length > 0 && <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3"><span className="text-xs text-muted-foreground">已保留结果</span><Select value={activeAlignmentResultId} onValueChange={selectAlignmentResult}><SelectTrigger className="w-72"><SelectValue /></SelectTrigger><SelectContent>{alignmentResults.map(result => <SelectItem key={result.id} value={result.id}>{result.modelLabel} · {Math.round(result.coverage * 100)}% · {new Date(result.createdAt).toLocaleString()}</SelectItem>)}</SelectContent></Select><span className="text-xs text-muted-foreground">选择后应用该版本，可撤回</span></div>}</div>
              <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">4. 逐字音高与字幕校对</span><Button size="sm" variant="secondary" onClick={openPitchEditor} disabled={!segments.some(segment => segment.chars.length) || editingLocked}>打开逐字音高编辑</Button></div><p className="mt-2 text-xs text-muted-foreground">逐字查看将导出的完整音高序列；选中字后可对照模型建议，修改音名、转音或颤音，并精确调整每个换音点。完成音高识别后即可编辑，歌词时间匹配结果也会同步更新。</p></div>
              {pitchPoints.length > 0 && <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3"><span>有声比例：{Math.round(voicedPitchPoints.length / pitchPoints.length * 100)}%</span><span>音高范围：{voicedPitchPoints.length ? `${Math.round(Math.min(...voicedPitchPoints.map(point => point.hz)))}–${Math.round(Math.max(...voicedPitchPoints.map(point => point.hz)))} Hz` : '无有声帧'}</span><span>当前字匹配：{Object.keys(pitchMatches).length} 个</span></div>}
            </section>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0">

            <section className="rounded-xl border border-border bg-card p-4">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3"><Tabs value={view} onValueChange={value => changeView(value as View)}><TabsList><TabsTrigger value="lines" className="transition-colors duration-100" disabled={editingLocked}>句级编辑</TabsTrigger><TabsTrigger value="chars" className="transition-colors duration-100" disabled={!activeLine || editingLocked}>单字时间与音高</TabsTrigger></TabsList></Tabs><div><h2 className="font-semibold">{view === 'lines' ? '句级时间轴' : '单字时间轴'}</h2><p className="mt-1 text-xs text-muted-foreground">单击只选中；未选中时双击定位试听、三击进入范围调整；已选中时双击进入调整。</p></div></div>
                {view === 'lines' ? <div className="flex flex-wrap items-center justify-end gap-2">
                  <div className="mr-2 flex w-48 items-center gap-2 text-xs text-muted-foreground"><span>缩放</span><Slider min={40} max={240} step={5} value={[zoom]} onValueChange={values => setZoom(values[0])} disabled={!duration} /><span className="w-7 text-right">{zoom}</span></div>
                  <Button size="sm" variant={showSpectrogram ? 'secondary' : 'outline'} onClick={() => setShowSpectrogram(value => !value)} disabled={!acoustics} title={!acoustics ? '请先准备纯人声轨' : undefined}>频谱</Button>
                  <Button size="sm" variant="secondary" onClick={addLine} disabled={!mediaUrl || editingLocked}><Plus />添加句</Button>
                  <Button size="sm" variant="secondary" onClick={mergeSelected} disabled={!mergeIndexes || editingLocked}><Merge />合并</Button>
                  <Button size="sm" variant="secondary" onClick={openSplit} disabled={!activeLine || !splitBoundaries.length || editingLocked}><Scissors />分割</Button>
                  <Button size="sm" variant="destructive" onClick={deleteSelected} disabled={!selectedLineIds.length || editingLocked}><Trash2 />删除</Button>
                </div> : <div className="flex flex-wrap items-center gap-2">
                  <label className="flex w-36 items-center gap-2 text-xs text-muted-foreground">缩放<Slider min={40} max={320} step={5} value={[zoom]} onValueChange={values => setZoom(values[0])} /></label>
                  <Button size="sm" variant={showSpectrogram ? 'secondary' : 'outline'} onClick={() => setShowSpectrogram(value => !value)} disabled={!acoustics} title={!acoustics ? '请先准备纯人声轨' : undefined}>频谱</Button>
                  <Button size="sm" variant={pitchViewOpen ? 'secondary' : 'outline'} onClick={() => setPitchViewOpen(value => !value)} aria-expanded={pitchViewOpen}>音高视图</Button>
                  <Button size="sm" variant="outline" onClick={reapplyActiveLine} disabled={!activeAlignment || editingLocked}>局部重排未锁定区间</Button>
                  <Button size="icon" variant="ghost" onClick={() => goLine(-1)} disabled={lineIndex <= 0 || editingLocked} aria-label="上一句"><ChevronLeft /></Button>
                  <span className="min-w-20 text-center text-xs text-muted-foreground">{lineIndex >= 0 ? `${lineIndex + 1} / ${segments.length}` : '未选中'}</span>
                  <Button size="icon" variant="ghost" onClick={() => goLine(1)} disabled={lineIndex < 0 || lineIndex >= segments.length - 1 || editingLocked} aria-label="下一句"><ChevronRight /></Button>
                </div>}
              </div>
              {view === 'chars' && pitchViewOpen && <div className="mb-3 grid gap-3 rounded-lg border border-border bg-muted/30 p-3 text-xs sm:grid-cols-2 lg:grid-cols-4" aria-label="音高视图设置">
                <div className="space-y-2"><Button size="sm" variant={pitchViewSettings.guides ? 'secondary' : 'outline'} onClick={() => setPitchViewSettings(current => ({ ...current, guides: !current.guides }))} aria-pressed={pitchViewSettings.guides}>音名辅助线 · {pitchViewSettings.guides ? '开' : '关'}</Button><p className="text-muted-foreground">只用于时间轴校对，不进入视频。</p></div>
                <label className="space-y-1.5 text-muted-foreground">辅助线密度<Select value={pitchViewSettings.density} onValueChange={value => setPitchViewSettings(current => ({ ...current, density: value as PitchGuideDensity }))}><SelectTrigger aria-label="音高辅助线密度"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="semitone">每半音</SelectItem><SelectItem value="natural">自然音名</SelectItem><SelectItem value="whole">每全音</SelectItem><SelectItem value="octave">每八度</SelectItem></SelectContent></Select></label>
                  <div className="space-y-2 text-muted-foreground"><span>F0 显示范围：{pitchMidiName(displayedPitchView.lowMidi)}–{pitchMidiName(displayedPitchView.highMidi)}</span><Button size="sm" variant={pitchViewSettings.autoFitLine ? 'secondary' : 'outline'} onClick={() => setPitchViewSettings(current => ({ ...current, autoFitLine: !current.autoFitLine }))} aria-pressed={pitchViewSettings.autoFitLine}>实时适配每句音高范围 · {pitchViewSettings.autoFitLine ? '开' : '关'}</Button><label className="flex items-center gap-2">低音<Slider min={36} max={pitchViewSettings.highMidi - 4} step={1} value={[pitchViewSettings.lowMidi]} onValueChange={values => setPitchViewSettings(current => ({ ...current, lowMidi: values[0] }))} disabled={pitchViewSettings.autoFitLine} aria-label="F0 显示下限" /></label><label className="flex items-center gap-2">高音<Slider min={pitchViewSettings.lowMidi + 4} max={96} step={1} value={[pitchViewSettings.highMidi]} onValueChange={values => setPitchViewSettings(current => ({ ...current, highMidi: values[0] }))} disabled={pitchViewSettings.autoFitLine} aria-label="F0 显示上限" /></label><div className="flex gap-1"><Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={() => { if (!activeLine) return; const range = autoPitchViewRange(pitchPoints, activeLine.start, activeLine.end); if (range) setPitchViewSettings(current => ({ ...current, autoFitLine: false, lowMidi: range[0], highMidi: range[1] })); else setNotice('当前句没有可用的连续音高，无法自动适配显示范围。') }}>适配本句</Button><Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={() => setPitchViewSettings(current => ({ ...current, autoFitLine: false, lowMidi: 36, highMidi: 85 }))}>恢复范围</Button></div><span className="block">开启实时适配后，切句、合并、拆分或调整句范围都会重算；无有效 F0 时沿用手动范围。</span></div>
                  <label className="space-y-2 text-muted-foreground">音高轨窗口高度：{pitchViewSettings.trackHeight}px<Slider min={112} max={480} step={8} value={[pitchViewSettings.trackHeight]} onValueChange={values => setPitchViewSettings(current => ({ ...current, trackHeight: values[0] }))} aria-label="音高轨窗口高度" /><span className="block">拉高时间轴，扩大音高曲线的纵向间距，不改变音高数据。</span></label>
                  <label className="space-y-2 text-muted-foreground">纯人声波形显示增益：{pitchViewSettings.waveformGain.toFixed(1)} 倍<Slider min={1} max={8} step={0.25} value={[pitchViewSettings.waveformGain]} onValueChange={values => setPitchViewSettings(current => ({ ...current, waveformGain: values[0] }))} disabled={!vocalPeaks.length} aria-label="纯人声波形显示增益" /><span className="block">仅放大波形的画面高度。</span></label>
              </div>}
              <Timeline mode={view} segments={segments} activeSegment={activeLine} selectedIds={view === 'lines' ? selectedLineIds : selectedCharIds} duration={duration} peaks={peaks} vocalPeaks={vocalPeaks} acoustics={acoustics} showSpectrogram={showSpectrogram} reviews={timingReviews} pitchPoints={pitchPoints} pitchView={displayedPitchView} zoom={zoom} playhead={playhead} centerRequest={centerRequest} centerTargetId={centerTargetId} seekCenterRequest={seekCenterRequest} guideLine={guideLine} waveformStatus={waveformStatus} onSeekAndPlay={seekAndPlay} onSelect={(id, additive, range) => view === 'lines' ? selectLine(id, additive, range) : selectChar(id, additive, range)} onActivateLine={activateLine} onActivateChar={activateChar} onRetimeLines={retimeLines} onRetimeChar={retimeChar} onRetimeChars={retimeChars} onClipPreview={setTimelinePreview} rangeAdjusting={view === 'lines' ? rangeAdjusting : charRangeAdjusting} rangeDraft={view === 'lines' ? rangeDraft : charRangeDraft} onRangePreview={view === 'lines' ? setRangeDraft : setCharRangeDraft} onRangeEdgeChange={view === 'lines' ? setRangeEdge : setCharRangeEdge} onBeginRangeAdjust={() => view === 'lines' ? beginRangeAdjust() : beginCharRangeAdjust()} onSaveRangeAdjust={() => view === 'lines' ? finishRangeAdjust() : finishCharRangeAdjust()} onCancelRangeAdjust={() => view === 'lines' ? cancelRangeAdjust() : cancelCharRangeAdjust()} onContextMenu={view === 'lines' ? (event, time, id) => openContextMenu(event, id, time) : undefined} />
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>{view === 'lines' ? '选择多句' : '选择多个字'}：Ctrl/⌘ 点击；连续选择：Shift 点击</span><span>{view === 'chars' ? '紫线是声学变化候选，不参与自动逐字划分；拖动字边界靠近时吸附，按 Alt 临时关闭。' : vocalPeaks.length ? '句级波形与频谱均来自当前纯人声轨。' : '纯人声轨尚未准备；当前波形仅用于原媒体定位。'}</span></div>
            </section>

            {activeLine && <section className="rounded-xl border border-border bg-card p-4">
              <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">{view === 'lines' ? '句子编辑' : '单字时间与音高编辑'}</h2>{activeLine && <Badge variant="secondary">第 {lineIndex + 1} 句</Badge>}</div>
              <div className="space-y-4">
                <div><p className="mb-2 text-xs text-muted-foreground">整句内容</p><Textarea value={textDraft} onChange={event => setTextDraft(event.target.value)} onBlur={updateLineText} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) event.currentTarget.blur() }} rows={3} aria-label="歌词文本" disabled={editingLocked} /><p className="mt-1 text-xs text-muted-foreground">失去焦点时保存。新增或改写的字需要复核时间。</p></div>
                <div className="grid grid-cols-2 gap-3"><label className="space-y-2 text-xs text-muted-foreground">开始时间<Input value={startDraft} onChange={event => setStartDraft(event.target.value)} onBlur={updateLineTimes} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} className="font-mono text-foreground" disabled={editingLocked} /></label><label className="space-y-2 text-xs text-muted-foreground">结束时间<Input value={endDraft} onChange={event => setEndDraft(event.target.value)} onBlur={updateLineTimes} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} className="font-mono text-foreground" disabled={editingLocked} /></label></div>
                {view === 'chars' && <Button variant="outline" className="w-full" disabled={editingLocked} onClick={() => changeView('lines')}><ChevronLeft />返回整句编辑</Button>}
                {view === 'chars' && <div ref={pitchEditorRef} className="space-y-2 border-t border-border pt-4">
                  <div className="flex items-center justify-between"><p className="text-sm font-medium">逐字时间与完整音高序列</p><Badge variant="outline">{activeLine.chars.length} 字/词</Badge></div>
                  <p className="text-xs text-muted-foreground">右侧音高序列就是字幕实际使用的结果。点击某字可修改；拖动上方矩形调整字级时间边界。</p>
                  {timingReviews.some(item => item.score >= 25) && <div className="rounded-md border border-orange-400/50 bg-orange-400/5 p-2"><p className="mb-2 text-xs font-medium">建议优先复核的字（规则评分，仅作提示）</p><div className="flex flex-wrap gap-1">{timingReviews.filter(item => item.score >= 25).sort((a, b) => b.score - a.score).slice(0, 12).map(review => { const char = activeLine.chars.find(item => item.id === review.charId)!; return <Button key={review.charId} size="sm" variant="outline" title={review.reasons.join('、')} onClick={() => { setSelectedCharIds([char.id]); seek(char.start); setCenterTargetId(char.id); setCenterRequest(value => value + 1) }}>{char.text} · {review.score}</Button> })}</div></div>}
                  <div className="max-h-72 space-y-1 overflow-y-auto">{activeLine.chars.map(char => { const lockedOut = editingLocked && charRangeDraft?.id !== char.id; const currentPitch = pitchForChar(char, pitchPoints); return <Button key={char.id} type="button" variant="ghost" disabled={lockedOut} onClick={() => { if (editingLocked) return; setSelectedCharIds([char.id]); playNormally(char.start, `已从「${char.text}」起点开始播放；进入范围调整后才会循环试听。`) }} onDoubleClick={() => activateChar(char.id)} className={`flex h-auto w-full items-center justify-start gap-2 px-2 py-1.5 text-left font-normal ${selectedCharIds.includes(char.id) ? 'bg-primary/15' : ''} ${lockedOut ? 'opacity-30' : ''}`}><span className="w-8 shrink-0 truncate font-medium">{char.text}</span><span className="min-w-0 flex-1 font-mono text-xs text-muted-foreground">{formatTime(char.start)} — {formatTime(char.end)}</span><span className="max-w-[45%] break-all text-right font-mono text-xs text-primary" title={pitchNotation(currentPitch)}>{pitchNotation(currentPitch)}</span><span className="shrink-0 text-[10px] text-muted-foreground">{char.pitchOverride && char.pitchPreference !== 'model' ? '人工优先' : char.pitchOverride ? '模型优先' : pitchPoints.length ? '模型音高' : '待分析'}</span></Button> })}</div>
                  {activeChar && activePitchAnnotation && <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
                    <div className="flex items-center justify-between gap-2"><p className="text-sm font-medium">「{activeChar.text}」字幕音高</p><Badge variant={activePitchPreference === 'manual' ? 'secondary' : 'outline'}>{activePitchPreference === 'manual' ? '人工结果优先' : '模型建议优先'}</Badge></div>
                    <div className="flex flex-wrap gap-2"><Button size="sm" variant={activeChar.startLocked ? 'secondary' : 'outline'} onClick={() => toggleCharBoundaryLock('start')} disabled={editingLocked}>{activeChar.startLocked ? '已锁定起点' : '锁定起点'}</Button><Button size="sm" variant={activeChar.endLocked ? 'secondary' : 'outline'} onClick={() => toggleCharBoundaryLock('end')} disabled={editingLocked}>{activeChar.endLocked ? '已锁定终点' : '锁定终点'}</Button><span className="self-center text-xs text-muted-foreground">相邻字共用的边界会一起锁定。</span></div>
                    {timingReviews.find(item => item.charId === activeChar.id)?.reasons.length ? <p className="text-xs text-orange-600">复核提示：{timingReviews.find(item => item.charId === activeChar.id)?.reasons.join('、')}</p> : null}
                    <div className="grid gap-2 text-xs sm:grid-cols-2"><div className="rounded-md border border-border bg-background p-2"><p className="text-muted-foreground">模型建议 · 随字界重新计算</p><p className="mt-1 min-h-5 break-all font-mono">{activePitchSuggestion ? pitchNotation(activePitchSuggestion) : '—'}</p><Button size="sm" variant={activePitchPreference === 'model' ? 'secondary' : 'outline'} className="mt-2" onClick={() => selectPitchPreference('model')} disabled={editingLocked}>以模型为主</Button></div><div className="rounded-md border border-border bg-background p-2"><p className="text-muted-foreground">人工结果 · 独立保留</p><p className="mt-1 min-h-5 break-all font-mono text-primary">{activeManualPitch ? pitchNotation(activeManualPitch) : '尚未设置'}</p><Button size="sm" variant={activePitchPreference === 'manual' ? 'secondary' : 'outline'} className="mt-2" onClick={() => selectPitchPreference('manual')} disabled={editingLocked || !activeManualPitch}>以人工为主</Button></div></div>
                    <label className="block space-y-2 text-xs text-muted-foreground">修改音高简写<Input value={pitchNotationDraft} onChange={event => setPitchNotationEdit({ id: activeChar.id, base: activePitchNotation, value: event.target.value })} onBlur={savePitchNotation} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} placeholder="E4 / E4-F4-E4 / E4~" className="font-mono text-foreground" disabled={editingLocked} /></label>
                    <p className="text-xs text-muted-foreground">单音 E4；转音 E4-F4-E4；颤音 E4~；无音高 —。失去焦点时保存，ASS 与字级 JSON 同步使用当前字幕音高。</p>
                    {activePitchAnnotation.notes.length > 0 && <div className="space-y-2 border-t border-border pt-3"><p className="text-xs font-medium">逐音音名与时值</p>{activePitchAnnotation.notes.map((item, index) => { const start = activeChar.start + (activeChar.end - activeChar.start) * item.start; const end = activeChar.start + (activeChar.end - activeChar.start) * item.end; return <div key={`${index}:${item.note}`} className="grid grid-cols-[4.5rem_1fr_1fr] items-center gap-2 text-xs"><Input key={`${activeChar.id}:${index}:${item.note}`} defaultValue={item.note} aria-label={`第 ${index + 1} 个音的音名`} onBlur={event => { if (event.currentTarget.value !== item.note) { updatePitchNote(index, event.currentTarget.value); event.currentTarget.value = item.note } }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} className="h-8 font-mono text-xs" disabled={editingLocked} /><span className="font-mono text-muted-foreground">{formatTime(start)}</span>{index < activePitchAnnotation.notes.length - 1 ? <Input key={`${activeChar.id}:${index}:${end}`} defaultValue={formatTime(end)} aria-label={`第 ${index + 1} 个音的结束时间`} onBlur={event => { if (event.currentTarget.value !== formatTime(end)) { updatePitchBoundary(index, event.currentTarget.value); event.currentTarget.value = formatTime(end) } }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} className="h-8 font-mono text-xs" disabled={editingLocked} /> : <span className="font-mono text-muted-foreground">{formatTime(end)}</span>}</div> })}<p className="text-xs text-muted-foreground">每行可直接改音名；修改结束时间会同步改变下一音的开始时间。首尾跟随本字范围。</p></div>}
                    {activeChar.pitchOverride && <Button type="button" size="sm" variant="outline" onClick={resetPitchOverride} disabled={editingLocked}>删除人工结果</Button>}
                  </div>}
                </div>}
                {view === 'lines' && <Button variant="outline" className="w-full" disabled={editingLocked} onClick={() => changeView('chars')}>校对本句的单字时间与音高 <ChevronRight /></Button>}
              </div>
            </section>
            }
          </div>

          <aside className="min-w-0 space-y-4">
            <section className="rounded-xl border border-border bg-card p-4">
              <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">歌词列表</h2><Badge variant="secondary">{segments.length} 句</Badge></div>
              <div className="mb-3 flex items-center justify-between gap-2 border-b border-border pb-3"><span className="text-xs text-muted-foreground">逐句时间</span><Button size="sm" variant="outline" onClick={openShiftDialog} disabled={!segments.length || !duration || editingLocked}><SlidersHorizontal className="size-4" />整体偏移</Button></div>
              <div className="mb-3 flex flex-wrap items-center gap-1.5"><Button size="sm" variant="outline" onClick={() => setSectionMarkingOpen(true)} disabled={!segments.length || editingLocked}>标记段落</Button><Button size="sm" variant="outline" onClick={() => setRepeatedSectionsOpen(true)} disabled={orderedRepeatedSections.length < 2 || editingLocked}>核对同类段落 · {orderedRepeatedSections.length}</Button></div>
              <div ref={lyricListRef} className="max-h-72 space-y-1 overflow-auto">
                {segments.map((segment, index) => { const lockedOut = editingLocked && rangeDraft?.id !== segment.id; return <Button key={segment.id} data-line-id={segment.id} type="button" variant="ghost" disabled={lockedOut} className={`flex h-auto w-full items-center justify-start gap-3 px-3 py-2 text-left font-normal ${selectedLineIds.includes(segment.id) ? 'bg-primary/15 ring-1 ring-primary/60' : ''} ${lockedOut ? 'opacity-30' : ''}`} onContextMenu={event => openContextMenu(event, segment.id)} onClick={event => { if (editingLocked) return; selectLine(segment.id, event.ctrlKey || event.metaKey, event.shiftKey); setSelectedCharIds(view === 'chars' && segment.chars[0] ? [segment.chars[0].id] : []); setCenterTargetId(segment.id); setCenterRequest(value => value + 1); playNormally(segment.start, '已从当前句起点开始播放；进入范围调整后才会循环试听。') }}>
                  <span className="w-6 shrink-0 text-muted-foreground">{index + 1}</span>{repeatedLineLabels.has(segment.id) && <Badge variant="outline" className="shrink-0 text-[10px]">{repeatedLineLabels.get(segment.id)}</Badge>}<span className="w-22 shrink-0 font-mono text-xs text-muted-foreground">{formatTime(segment.start)}</span><span className="min-w-0 flex-1 truncate">{segment.text}</span><span className="font-mono text-xs text-muted-foreground">{formatTime(segment.end)}</span>
                </Button> })}
                {!segments.length && <p className="py-8 text-center text-muted-foreground">这里会显示每句歌词，方便快速选择和核对。</p>}
              </div>
            </section>
            {reviewQueue.some(item => item.review.score >= 25) && <section className="rounded-xl border border-orange-400/40 bg-card p-4"><div className="mb-2 flex items-center justify-between"><h2 className="font-semibold">优先复核</h2><Badge variant="outline">{reviewQueue.filter(item => item.review.score >= 25).length} 处</Badge></div><p className="mb-3 text-xs text-muted-foreground">规则评分用于安排校对顺序，并非自动认定错误。</p><div className="max-h-64 space-y-1 overflow-y-auto">{reviewQueue.filter(item => item.review.score >= 25).sort((a, b) => b.review.score - a.review.score).slice(0, 12).map(item => <Button key={item.char.id} size="sm" variant="ghost" className="h-auto w-full justify-start gap-2 text-left" title={item.review.reasons.join('、')} disabled={editingLocked} onClick={() => { setView('chars'); setSelectedLineIds([item.line.id]); setSelectedCharIds([item.char.id]); seek(item.char.start); setCenterTargetId(item.char.id); setCenterRequest(value => value + 1) }}><span className="w-8 shrink-0 font-medium text-orange-500">{item.review.score}</span><span className="w-8 shrink-0 truncate">{item.char.text}</span><span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{item.review.reasons[0]}</span><span className="font-mono text-[10px] text-muted-foreground">{formatTime(item.char.start)}</span></Button>)}</div></section>}
          </aside>
        </div>
        </div>
      </main>

      {mediaIsVideo && mediaUrl && floatingVideoUrl === mediaUrl && <FloatingVideoPreview mediaRef={mediaRef} segments={effectiveSegments} points={pitchPoints} style={subtitleStyle} playhead={playhead} duration={duration} playing={playing} aspect={videoAspect} onSeek={seek} onTogglePlayback={() => void togglePlayback()} onClose={() => setFloatingVideoUrl('')} />}
      <footer className="flex items-center justify-between border-t border-border bg-card px-4 py-2 text-xs text-muted-foreground" role="status"><span>{notice}</span><span className="flex items-center gap-3"><span className="text-emerald-600">● 本地处理 · 文件不会上传</span><span>项目自动保存</span></span></footer>
      </>}

      {sectionMarkingOpen && <SectionMarkingDialog open={sectionMarkingOpen} onOpenChange={setSectionMarkingOpen} segments={segments} sections={repeatedSections} onSectionsChange={setRepeatedSections} initialLineIds={selectedLineIds} onReview={() => setRepeatedSectionsOpen(true)} />}
      <RepeatedSectionsDialog open={repeatedSectionsOpen} onOpenChange={setRepeatedSectionsOpen} segments={segments} points={pitchPoints} sections={repeatedSections} onSectionsChange={setRepeatedSections} onApply={next => { commit(next); setNotice('同类段落已同步；时间和人工音高可撤回。') }} duration={duration} playhead={playhead} onSeek={seek} />

      <Dialog open={importOpen} onOpenChange={setImportOpen}><DialogContent><DialogHeader><DialogTitle>粘贴歌词</DialogTitle><DialogDescription>支持普通歌词或带时间标签的 LRC。普通歌词会均匀排在媒体时长内，随后可逐句调整。</DialogDescription></DialogHeader><Textarea value={importDraft} onChange={event => setImportDraft(event.target.value)} rows={12} placeholder={'[00:12.30]第一句歌词\n[00:17.20]第二句歌词'} /><DialogFooter><Button variant="outline" onClick={() => setImportOpen(false)}>取消</Button><Button onClick={() => void importLyrics(importDraft)} disabled={!importDraft.trim()}>导入歌词</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={newProjectOpen} onOpenChange={setNewProjectOpen}><DialogContent><DialogHeader><DialogTitle>新建工程</DialogTitle><DialogDescription>选择名称和存放位置。原媒体、分离结果及歌词标注会保存在同一个工程文件夹中。</DialogDescription></DialogHeader><div className="space-y-4"><label className="block space-y-2 text-sm">工程名称<Input value={newProjectName} onChange={event => setNewProjectName(event.target.value)} placeholder="例如：歌曲名称" /></label><div className="space-y-2 text-sm"><p>存放位置</p><div className="flex items-center gap-2"><Input value={projectParent} onChange={event => setProjectParent(event.target.value)} className="min-w-0 flex-1" /><Button variant="outline" onClick={async () => { const parent = await window.pitchordDesktop?.pickProjectParent(); if (parent) setProjectParent(parent) }}>选择…</Button></div></div></div><DialogFooter><Button variant="outline" onClick={() => { pendingMediaRef.current = null; setNewProjectOpen(false) }}>取消</Button><Button onClick={() => void createProject()} disabled={!newProjectName.trim() || (window.pitchordDesktop && !projectParent.trim())}>创建工程</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={!!duplicateSource} onOpenChange={open => { if (!open && !projectActionBusy) setDuplicateSource(null) }}><DialogContent><DialogHeader><DialogTitle>复制工程</DialogTitle><DialogDescription>复制完整工程文件夹，包括媒体、歌词和分析结果。副本与原工程相互独立，保存在原工程旁边。</DialogDescription></DialogHeader><label className="block space-y-2 text-sm">副本名称<Input autoFocus value={duplicateName} onChange={event => setDuplicateName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void confirmProjectDuplicate() }} /></label><p className="break-all text-xs text-muted-foreground">原工程：{duplicateSource?.directory}</p><DialogFooter><Button variant="outline" onClick={() => setDuplicateSource(null)} disabled={projectActionBusy}>取消</Button><Button onClick={() => void confirmProjectDuplicate()} disabled={!duplicateName.trim() || projectActionBusy}>{projectActionBusy ? '正在复制…' : '创建副本'}</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={pendingProjectTrash.length > 0} onOpenChange={open => { if (!open && !projectActionBusy) setPendingProjectTrash([]) }}><DialogContent><DialogHeader><DialogTitle>将工程移入回收站？</DialogTitle><DialogDescription>这会移动选中的整个工程文件夹，包括原媒体、分析结果和歌词备份。与“从最近列表移除”不同；在清空系统回收站前通常可以恢复。</DialogDescription></DialogHeader><div className="max-h-36 space-y-1 overflow-y-auto rounded-lg border border-border bg-muted/30 p-3 text-sm">{pendingProjectTrash.map(project => <p key={project.directory} className="truncate" title={project.directory}>{project.name}</p>)}</div><DialogFooter><Button variant="outline" onClick={() => setPendingProjectTrash([])} disabled={projectActionBusy}>取消</Button><Button variant="destructive" onClick={() => void confirmProjectTrash()} disabled={projectActionBusy}>{projectActionBusy ? '正在移动…' : `将 ${pendingProjectTrash.length} 个工程移入回收站`}</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={splitOpen} onOpenChange={setSplitOpen}><DialogContent><DialogHeader><DialogTitle>分割当前歌词</DialogTitle><DialogDescription>先用辅助线确定音频分割位置，再选择文字从哪里断开。左右两句会保留各自的媒体时间范围。</DialogDescription></DialogHeader><div className="space-y-4"><label className="block space-y-2 text-sm">音频分割时间<Input value={splitTimeDraft} onChange={event => setSplitTimeDraft(event.target.value)} className="font-mono" /></label><div className="space-y-2 text-sm"><label>文字分割位置</label><Select value={splitOffset} onValueChange={setSplitOffset}><SelectTrigger><SelectValue placeholder="选择字界" /></SelectTrigger><SelectContent>{splitBoundaries.map(offset => <SelectItem key={offset} value={String(offset)}>{activeLine?.text.slice(0, offset)} ｜ {activeLine?.text.slice(offset)}</SelectItem>)}</SelectContent></Select></div><div className="rounded-md bg-muted p-3 text-xs text-muted-foreground">点击时间轴可设置辅助线；空格只控制播放和暂停。没有句内辅助线时取句中附近的音量低谷。文字边界优先参考中英文标点和空格，请试听确认。</div></div><DialogFooter><Button variant="outline" onClick={() => setSplitOpen(false)}>取消</Button><Button onClick={confirmSplit}>确认分割</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={conflictOpen} onOpenChange={() => undefined}><DialogContent><DialogHeader><DialogTitle>{charRangeAdjusting ? '单字范围发生冲突' : '句子范围发生冲突'}</DialogTitle><DialogDescription>新的时间范围与相邻{charRangeAdjusting ? '字' : '歌词'}重叠，请选择处理方式后继续。</DialogDescription></DialogHeader><div className="space-y-2 text-sm"><Button className="h-auto w-full justify-start whitespace-normal py-3 text-left" onClick={() => resolveConflict('compress')}>1. 压缩两侧时间块并推动后续块</Button><Button className="h-auto w-full justify-start whitespace-normal py-3 text-left" variant="outline" onClick={() => resolveConflict('push')}>2. 保持其他时间块形状，只推动相邻块</Button><Button className="h-auto w-full justify-start whitespace-normal py-3 text-left" variant="ghost" onClick={() => resolveConflict('discard')}>3. 放弃本次修改</Button></div></DialogContent></Dialog>

      <Dialog open={shiftConfirmOpen} onOpenChange={setShiftConfirmOpen}><DialogContent><DialogHeader><DialogTitle>歌词即将超出媒体范围</DialogTitle><DialogDescription>目前最{pendingShift > 0 ? '后' : '前'}面的歌词时间已经无法继续整体移动。是否继续压缩最外侧句子，并逐步压缩靠里的句子？</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setShiftConfirmOpen(false)}>取消</Button><Button onClick={() => { setShiftConfirmOpen(false); shiftAll(pendingShift, true) }}>继续移动</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={shiftDialogOpen} onOpenChange={setShiftDialogOpen}><DialogContent><DialogHeader><DialogTitle>整体偏移歌词</DialogTitle><DialogDescription>所有句子及其逐字时间一起移动；音高轨迹保持原位。改完可立即试听和预览。</DialogDescription></DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="grid grid-cols-2 gap-2"><Button type="button" variant={shiftMode === 'seconds' ? 'secondary' : 'outline'} onClick={() => setShiftMode('seconds')}>指定偏移</Button><Button type="button" variant={shiftMode === 'first-line' ? 'secondary' : 'outline'} onClick={() => setShiftMode('first-line')}>按第一句校准</Button></div>
          {shiftMode === 'seconds' ? <div className="space-y-3">
            <label className="block space-y-1.5">偏移秒数（负数提前，正数延后）<Input type="number" step="0.01" value={shiftSecondsDraft} onChange={event => setShiftSecondsDraft(event.target.value)} aria-label="整体偏移秒数" className="font-mono" /></label>
            <div className="flex flex-wrap gap-2">{[-5, -1, 1, 5].map(amount => <Button key={amount} type="button" size="sm" variant="outline" onClick={() => setShiftSecondsDraft(String(roundTime((Number(shiftSecondsDraft) || 0) + amount)))}>{amount > 0 ? '+' : ''}{amount}s</Button>)}</div>
          </div> : <div className="space-y-3">
            <p className="rounded-md bg-muted/50 p-2 text-xs">第一句「{segments[0]?.text || '—'}」目前开始于 <span className="font-mono font-medium">{segments[0] ? formatTime(segments[0].start) : '—'}</span></p>
            <label className="block space-y-1.5">调整第一句的开始时间<Input value={firstLineStartDraft} onChange={event => setFirstLineStartDraft(event.target.value)} placeholder="00:12.345" aria-label="第一句目标开始时间" className="font-mono" /></label>
            <div className="space-y-1"><Slider min={Math.max(0, (segments[0]?.start ?? 0) - 5)} max={Math.min(duration, (segments[0]?.start ?? 0) + 5)} step={0.01} value={[clamp(firstLineTarget ?? segments[0]?.start ?? 0, Math.max(0, (segments[0]?.start ?? 0) - 5), Math.min(duration, (segments[0]?.start ?? 0) + 5))]} onValueChange={values => setFirstLineStartDraft(formatTime(values[0]))} /><p className="text-[11px] text-muted-foreground">拖动可在原起点前后 5 秒内微调；更大的偏移可直接输入时间。</p></div>
            <div className="flex flex-wrap gap-2">{[-1, -0.1, 0.1, 1].map(amount => <Button key={amount} type="button" size="sm" variant="outline" onClick={() => setFirstLineStartDraft(formatTime(Math.max(0, roundTime((firstLineTarget ?? segments[0]?.start ?? 0) + amount))))}>{amount > 0 ? '+' : ''}{amount}s</Button>)}<Button type="button" size="sm" variant="ghost" onClick={() => { if (firstLineTarget !== null) playNormally(firstLineTarget, '正在试听第一句的目标起点。') }} disabled={firstLineTarget === null || !mediaUrl}>试听目标位置</Button></div>
            <p className="text-xs text-muted-foreground">先试听并修改第一句起点；应用时用它与原起点的差值移动全部歌词，不会只改第一句。</p>
          </div>}
          <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs">{shiftDraft === null ? '请输入有效的时间。' : <>预计整体{shiftDraft < 0 ? '提前' : '延后'} <span className="font-mono font-semibold">{Math.abs(shiftDraft).toFixed(3)} 秒</span>{segments[0] && <span className="ml-2 text-muted-foreground">第一句将从 {formatTime(segments[0].start)} 移至 {formatTime(segments[0].start + shiftDraft)}</span>}</>}</div>
          <div className="flex items-center justify-between border-t border-border pt-3"><p className="max-w-[70%] text-xs text-muted-foreground">恢复会撤销本轮连续的整体偏移；若中途单独修改歌词，请使用撤销记录。</p><Button type="button" size="sm" variant="ghost" onClick={restoreShift} disabled={!lastShiftBefore || editingLocked}><RotateCcw className="size-4" />恢复原偏移</Button></div>
        </div>
        <DialogFooter><Button variant="outline" onClick={() => setShiftDialogOpen(false)}>取消</Button><Button onClick={applyShiftDraft} disabled={shiftDraft === null || Math.abs(shiftDraft) < 0.001 || editingLocked}>应用到全部歌词</Button></DialogFooter>
      </DialogContent></Dialog>

      <Dialog open={separationPromptOpen} onOpenChange={setSeparationPromptOpen}><DialogContent><DialogHeader><DialogTitle>需要先完成人声分离</DialogTitle><DialogDescription>音高识别和歌词时间戳匹配只读取纯人声结果。Pitchord 会直接处理当前工程中已经导入的媒体，不需要再次选择文件。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setSeparationPromptOpen(false)}>取消</Button><Button onClick={() => { setSeparationPromptOpen(false); requestSeparation() }}>进行人声分离</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={!!rerunPrompt} onOpenChange={open => { if (!open) setRerunPrompt(null) }}><DialogContent><DialogHeader><DialogTitle>该部分任务已经完成</DialogTitle><DialogDescription>是否要尝试其他模型的效果？Pitchord 会同时保留所有模型生成的结果，不会覆盖当前结果。</DialogDescription></DialogHeader><div className="rounded-lg border border-border bg-muted/30 p-3 text-sm"><p>本次将运行：{rerunPrompt === 'separation' ? selectedSeparationModel?.label || separationModel : rerunPrompt === 'alignment' ? analysisEnvironment?.alignment.models.find(model => model.id === alignmentModel)?.label || alignmentModel : installOptionLabels.pitchMethods[pitchAlgorithm]}</p><p className="mt-1 text-xs text-muted-foreground">结果文件会加入模型或算法后缀，并可以在试听轨和下游输入中重新选择。</p></div><DialogFooter><Button variant="outline" onClick={() => setRerunPrompt(null)}>取消</Button><Button onClick={() => { const kind = rerunPrompt; setRerunPrompt(null); if (kind === 'separation') void runSeparation(); else if (kind === 'alignment') void runLyricAlignment(); else void analyzePitch() }}>继续运行并保留结果</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={repairEnvironmentOpen} onOpenChange={setRepairEnvironmentOpen}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{environmentInstallState === 'success' ? '分析环境安装完成' : environmentInstallState === 'running' ? '正在准备分析环境' : analysisEnvironment?.completeReady ? '分析环境设置' : '首次准备分析环境'}</DialogTitle><DialogDescription>{environmentInstallState === 'success' ? '所选运行组件和模型已通过检查，可以开始使用。' : '选择一套方案即可同时准备 Python、计算组件和所需模型；也可以按需要自定义。安装可在后台继续，关闭此窗口不会取消任务。'}</DialogDescription></DialogHeader>
      {environmentInstallState === 'success' && <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-5 text-sm" role="status"><div className="flex items-center gap-2 font-semibold text-emerald-700"><CheckCircle2 className="size-5" />所选分析环境已准备完成</div><p className="mt-2 text-muted-foreground">现在可以创建或打开项目，开始人声分离、音高识别和歌词对齐。需要调整模型时，可随时从“分析环境”或“模型管理”重新进入。</p></div>}
      {environmentInstallState === 'error' && <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive" role="alert">安装未完成：{analysisProgress}。请查看任务提示或重试。</div>}
      <div className={environmentInstallState === 'success' ? 'hidden' : 'space-y-4 text-sm'}>
        <div className="grid grid-cols-3 gap-2"><Button variant={environmentMode === 'managed' ? 'secondary' : 'outline'} onClick={() => setEnvironmentMode('managed')} disabled={analysisEnvironmentBusy}>创建独立环境</Button><Button variant={environmentMode === 'existing' ? 'secondary' : 'outline'} onClick={() => setEnvironmentMode('existing')} disabled={analysisEnvironmentBusy}>复用整套环境</Button><Button variant={environmentMode === 'custom' ? 'secondary' : 'outline'} onClick={() => setEnvironmentMode('custom')} disabled={analysisEnvironmentBusy}>仅使用 Python</Button></div>
        {environmentMode === 'managed' ? <>
          <div className="space-y-2"><p className="font-medium">环境存放位置</p><div className="flex gap-2"><Input value={environmentRootDraft} readOnly className="min-w-0 flex-1 font-mono text-xs" /><Button variant="outline" onClick={async () => { const selected = await window.pitchordDesktop?.chooseAnalysisDirectory(environmentRootDraft); if (selected) setEnvironmentRootDraft(selected) }} disabled={analysisEnvironmentBusy}>选择…</Button></div><div className="flex items-center justify-between gap-2"><p className="text-xs text-muted-foreground">默认放在软件同目录的 environment 文件夹，也可以选择 D 盘等其他位置。</p>{analysisEnvironment?.defaultRoot && environmentRootDraft !== analysisEnvironment.defaultRoot && <Button size="sm" variant="ghost" onClick={() => setEnvironmentRootDraft(analysisEnvironment.defaultRoot)}>恢复默认</Button>}</div></div>
          <label className="block space-y-2"><span className="font-medium">计算环境</span><Select value={computeProfileDraft} onValueChange={value => setComputeProfileDraft(value as 'auto' | 'cpu' | 'cuda121')} disabled={analysisEnvironmentBusy}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="auto">自动选择（推荐）</SelectItem><SelectItem value="cuda121">NVIDIA GPU · CUDA 12.1</SelectItem><SelectItem value="cpu">仅 CPU</SelectItem></SelectContent></Select></label>
          <div className="rounded-lg border border-border bg-muted/30 p-3"><div className="flex items-center justify-between gap-3"><p className="font-medium">设备检测</p><Badge variant={analysisEnvironment?.detectedGpu ? 'secondary' : 'outline'}>{analysisEnvironment?.detectedGpu?.name || '未检测到 NVIDIA GPU'}</Badge></div><p className="mt-1 text-xs text-muted-foreground">{analysisEnvironment?.detectedGpu ? `驱动 ${analysisEnvironment.detectedGpu.driver}。自动模式会先安装 CUDA 12.1 组件，运行检查失败时回退 CPU。` : '自动模式将安装 CPU 组件。'} 首次安装需要联网，完整 GPU 环境与推荐模型通常需要约 5–8 GB 可用空间。</p></div>
          <div className="rounded-xl border border-border p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-medium">选择安装内容</p><p className="mt-1 text-xs text-muted-foreground">音高、人声分离和歌词对齐各选至少一项；提取主唱模型可选。后续仍可在模型管理中增删。</p></div><Badge variant="outline">预计下载约 {formatBytes(estimatedInstallBytes)}</Badge></div>
            <div className="mt-3 grid grid-cols-3 gap-2"><Button type="button" size="sm" variant={installPreset === 'minimum' ? 'secondary' : 'outline'} onClick={() => applyInstallPreset('minimum')} disabled={analysisEnvironmentBusy}>轻量</Button><Button type="button" size="sm" variant={installPreset === 'recommended' ? 'secondary' : 'outline'} onClick={() => applyInstallPreset('recommended')} disabled={analysisEnvironmentBusy}>推荐</Button><Button type="button" size="sm" variant={installPreset === 'all' ? 'secondary' : 'outline'} onClick={() => applyInstallPreset('all')} disabled={analysisEnvironmentBusy}>全部</Button></div>
            <div className="mt-4 grid gap-4 md:grid-cols-3">
              <div><p className="mb-2 text-xs font-medium">音高识别</p><div className="space-y-2">{(['pyin', 'torchcrepe', 'rmvpe', 'fcpe'] as PitchAlgorithm[]).map(id => <label key={id} className="flex cursor-pointer items-start gap-2 rounded-md bg-muted/40 p-2 text-xs"><input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={installSelectionDraft.pitchMethods.includes(id)} onChange={() => toggleInstallOption('pitchMethods', id)} disabled={analysisEnvironmentBusy} /><span><span className="font-medium">{installOptionLabels.pitchMethods[id]}{id === 'rmvpe' || id === 'fcpe' ? ' · 可选' : ''}</span><span className="mt-0.5 block text-[11px] text-muted-foreground">{id === 'pyin' ? '轻量，适合干净人声' : id === 'torchcrepe' ? '复杂唱法与弱基频；支持 GPU' : id === 'rmvpe' ? '歌声专用，10ms 轨迹；额外下载约 360 MB，CPU 推理' : '歌声快速模型，10ms 轨迹；额外安装约 40 MB，支持 GPU'}</span></span></label>)}</div></div>
              <div><p className="mb-2 text-xs font-medium">人声分离</p><div className="space-y-2">{(['htdemucs', 'htdemucs_ft', 'mdx_extra_q'] as const).map(id => <label key={id} className="flex cursor-pointer items-start gap-2 rounded-md bg-muted/40 p-2 text-xs"><input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={installSelectionDraft.separationModels.includes(id)} onChange={() => toggleInstallOption('separationModels', id)} disabled={analysisEnvironmentBusy} /><span><span className="font-medium">{installOptionLabels.separationModels[id]}</span><span className="mt-0.5 block text-[11px] text-muted-foreground">{id === 'htdemucs' ? '默认平衡方案' : id === 'htdemucs_ft' ? '更高质量，速度较慢' : '体积较小，速度较快'}</span></span></label>)}</div></div>
              <div><p className="mb-2 text-xs font-medium">歌词对齐</p><div className="space-y-2">{(['small', 'base'] as const).map(id => <label key={id} className="flex cursor-pointer items-start gap-2 rounded-md bg-muted/40 p-2 text-xs"><input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={installSelectionDraft.alignmentModels.includes(id)} onChange={() => toggleInstallOption('alignmentModels', id)} disabled={analysisEnvironmentBusy} /><span><span className="font-medium">{installOptionLabels.alignmentModels[id]}</span><span className="mt-0.5 block text-[11px] text-muted-foreground">{id === 'small' ? '精度与体积均衡' : '下载更小、运行更快'}</span></span></label>)}</div></div>
            </div>
            <div className="mt-4 border-t border-border pt-3"><p className="mb-2 text-xs font-medium">可选 · 提取主唱、剥离和声（第二阶段）</p><label className="flex cursor-pointer items-start gap-2 rounded-md bg-muted/40 p-2 text-xs"><input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={installSelectionDraft.harmonyModels.includes('bs-roformer-karaoke-frazer')} onChange={() => toggleInstallOption('harmonyModels', 'bs-roformer-karaoke-frazer')} disabled={analysisEnvironmentBusy} /><span><span className="font-medium">BS-RoFormer Karaoke</span><span className="mt-0.5 block text-[11px] text-muted-foreground">先用上方模型分离人声，再提取主唱并保留和声／残留轨。额外下载约 204 MB；“轻量”“推荐”默认不选，“全部”会选中。</span></span></label></div>
            {!installSelectionComplete && <p className="mt-3 text-xs font-medium text-destructive">音高识别、人声分离和歌词对齐必须各保留至少一项。</p>}
          </div>
          <div className="rounded-lg border border-border bg-muted/30 p-3"><p className="font-medium">自动加速、可复用缓存</p><p className="mt-1 break-all text-xs text-muted-foreground">Python、依赖、模型和缓存只写入：{environmentRootDraft || '请选择目录'}。高速安装工具已随 Windows 版提供，无需单独下载。Python 依赖与 PyTorch 会在官方线路和清华 TUNA / 上海交大 SJTUG 国内线路间自动测速；Whisper 会在 Hugging Face 官方与国内模型线路间实测下载速度，失败时保留进度并切换备用线路。</p></div>
          {environmentProgress && <div className="rounded-xl border border-primary/30 bg-primary/5 p-4" aria-label="完整环境安装进度">
            <div className="flex items-center justify-between gap-3"><div><p className="font-medium">完整环境安装</p><p className="mt-1 text-xs text-muted-foreground">共 {environmentProgress.components.length} 项，关闭窗口后仍会在任务进度中继续。</p></div><span className="font-mono text-lg font-semibold text-primary">{Math.round(environmentProgress.overallProgress * 100)}%</span></div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${Math.round(environmentProgress.overallProgress * 100)}%` }} /></div>
            <div className="mt-3 space-y-2">{environmentProgress.components.map(component => <div key={component.id} className="flex items-start gap-2 rounded-md bg-background/80 px-3 py-2"><span className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full ${component.status === 'complete' ? 'bg-emerald-100 text-emerald-700' : component.status === 'running' ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'}`}>{component.status === 'complete' ? <CheckCircle2 className="size-3.5" /> : component.status === 'running' ? <LoaderCircle className="size-3.5 animate-spin" /> : <span className="size-1.5 rounded-full bg-current" />}</span><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><p className="text-xs font-medium">{component.label}</p><span className="text-[11px] text-muted-foreground">{component.status === 'complete' ? '完成' : component.status === 'running' ? `${Math.round(component.progress * 100)}%` : '等待'}</span></div><p className="mt-0.5 text-[11px] text-muted-foreground">{component.detail}</p></div></div>)}</div>
            <p className="mt-3 text-xs font-medium">{analysisProgress}</p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">{environmentProgress.transferState === 'downloading' && <><span>{environmentProgress.speedBytesPerSecond ? `当前网速 ${formatBytes(environmentProgress.speedBytesPerSecond)}/s` : '正在等待下载数据…'}</span>{environmentProgress.downloadedBytes !== undefined && <span>{formatBytes(environmentProgress.downloadedBytes)}{environmentProgress.totalBytes ? ` / ${formatBytes(environmentProgress.totalBytes)}` : ' 已下载'}</span>}{environmentProgress.etaSeconds !== undefined && <span>预计剩余 {formatDuration(environmentProgress.etaSeconds)}</span>}</>}{environmentProgress.transferState === 'cache' && <span>已复用本地下载缓存</span>}{environmentProgress.transferState === 'installing' && <span>下载完成或无需下载，正在安装与校验</span>}</div>
            {environmentProgress.detail && <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={environmentProgress.detail}>当前明细：{environmentProgress.detail}</p>}
          </div>}
        </> : environmentMode === 'existing' ? <>
          <div className="space-y-2"><p className="font-medium">旧版 environment 文件夹</p><div className="flex gap-2"><Input value={existingEnvironmentDraft} readOnly placeholder="选择旧版 Pitchord 的 environment 文件夹" className="min-w-0 flex-1 font-mono text-xs" aria-label="已有环境目录" /><Button variant="outline" onClick={async () => { const selected = await window.pitchordDesktop?.chooseExistingAnalysisDirectory(existingEnvironmentDraft || analysisEnvironment?.root); if (selected) { setExistingEnvironmentDraft(selected); setExistingEnvironmentError('') } }} disabled={analysisEnvironmentBusy}>选择文件夹…</Button></div><p className="text-xs text-muted-foreground">请选择包含 base-runtime 和 models 的整个 environment 文件夹，不是里面的 python.exe。会一起使用旧环境中的人声、音高、去和声和歌词对齐模型；不会复制、移动或重新下载文件。复用期间请保留旧文件夹；以后在模型管理中增删模型会影响共用此目录的旧版软件。</p></div>
          {existingEnvironmentError && <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive" role="alert">{existingEnvironmentError}</p>}
          {analysisEnvironment?.runtimePreference === 'existing' && analysisEnvironment.root === existingEnvironmentDraft && <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs"><p className="font-medium">当前已复用此目录</p><p className="mt-1 break-all text-muted-foreground">Python：{analysisEnvironment.path}</p><p className="mt-1">Whisper Small：{analysisEnvironment.alignment.models.find(model => model.id === 'small')?.ready ? '已识别' : '未识别'} · 人声模型：{analysisEnvironment.separationModels.filter(model => model.ready).length} 个 · 音高方法：{analysisEnvironment.pitchMethods.filter(method => method.ready).length} 个</p>{!analysisEnvironment.completeReady && <p className="mt-1 text-orange-600">此目录已切换，但所选组件并非全部可用。请在模型管理中查看缺失项。</p>}</div>}
        </> : <>
          <div className="space-y-2"><p className="font-medium">Python 可执行文件</p><div className="flex gap-2"><Input value={externalPythonDraft} readOnly placeholder="选择 python.exe" className="min-w-0 flex-1 font-mono text-xs" /><Button variant="outline" onClick={async () => { const selected = await window.pitchordDesktop?.choosePython(externalPythonDraft); if (selected) setExternalPythonDraft(selected) }} disabled={analysisEnvironmentBusy}>选择…</Button></div><p className="text-xs text-muted-foreground">支持 Python 3.10–3.12。Pitchord 只检测并使用该环境，不会自动安装或删除其中的内容。</p></div>
          <div className="rounded-lg border border-border bg-muted/30 p-3"><p className="font-medium">只切换 Python</p><p className="mt-1 text-xs text-muted-foreground">模型通常仍从当前 environment 目录读取。若所选 python.exe 位于 Pitchord 的 environment/base-runtime 中，软件会自动识别并切换整套环境；更推荐直接使用“复用整套环境”。</p></div>
        </>}
      </div><DialogFooter>{environmentInstallState === 'success' ? <Button onClick={() => setRepairEnvironmentOpen(false)}>完成，开始使用</Button> : <><Button variant="outline" onClick={() => setRepairEnvironmentOpen(false)}>{analysisEnvironmentBusy ? '后台继续' : analysisEnvironment?.completeReady ? '关闭' : '稍后设置'}</Button>{analysisEnvironmentBusy && environmentMode === 'managed' && <Button variant="destructive" onClick={() => void window.pitchordDesktop?.cancelAnalysisTask('environment')}><Square />取消安装</Button>}{environmentMode === 'managed' ? <Button onClick={() => void installAnalysisRuntime()} disabled={analysisEnvironmentBusy || !environmentRootDraft || !installSelectionComplete}>{analysisEnvironmentBusy ? '正在准备所选环境…' : analysisEnvironment?.completeReady ? '重新准备所选环境' : '下载并准备所选环境'}</Button> : environmentMode === 'existing' ? <Button onClick={() => void applyExistingEnvironment()} disabled={analysisEnvironmentBusy || !existingEnvironmentDraft}>{analysisEnvironmentBusy ? '正在检查…' : '检查并复用此环境'}</Button> : <Button onClick={() => void applyExternalPython()} disabled={analysisEnvironmentBusy || !externalPythonDraft}>检测并使用</Button>}</>}</DialogFooter></DialogContent></Dialog>

      <Dialog open={modelManagerOpen} onOpenChange={setModelManagerOpen}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>模型管理</DialogTitle><DialogDescription>功能页只显示已经安装且可以运行的模型。这里可以准备推荐模型，或把自己的模型复制到 Pitchord 环境中统一管理。</DialogDescription></DialogHeader><div className="space-y-3">
        <Button size="sm" variant="outline" onClick={() => { setModelManagerOpen(false); window.setTimeout(openEnvironmentSetup, 0) }}><SlidersHorizontal className="size-4" />选择并准备音高识别模型</Button>
        <div className="rounded-lg border border-border bg-muted/30 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium">模型计算设备</p><Badge variant={analysisEnvironment?.compute.cudaAvailable ? 'secondary' : 'outline'}>{analysisEnvironment?.compute.label || '正在检测…'}</Badge></div><p className="mt-1 text-xs text-muted-foreground">CUDA 环境可让 Demucs、MSST、TorchCrepe 和 FCPE 使用 GPU；pYIN 与当前 RMVPE ONNX 推理使用 CPU。歌词识别单独检测 CTranslate2 的 CUDA 支持。</p>{analysisEnvironment?.compute.torchVersion && <p className="mt-1 text-xs text-muted-foreground">PyTorch {analysisEnvironment.compute.torchVersion}{analysisEnvironment.compute.torchBuildCuda ? ` · CUDA ${analysisEnvironment.compute.torchBuildCuda}` : ' · CPU 构建'}</p>}</div>
        <p className="text-sm font-medium">人声分离模型</p>{analysisEnvironment?.separationModels.map(model => <div key={model.id} className="rounded-lg border border-border bg-muted/30 p-3"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-medium">{model.label}</p><Badge variant={model.ready ? 'secondary' : 'outline'}>{model.ready ? model.runnable === false ? '已纳入，暂不可运行' : '已安装' : '未安装'}</Badge><Badge variant="outline">{model.source === 'custom' ? '用户模型' : '推荐模型'}</Badge></div><p className="mt-1 text-xs text-muted-foreground">{model.description}</p>{!model.bundled && model.source !== 'custom' && <p className="mt-1 text-xs text-muted-foreground">准备此模型需要联网下载，文件保存在 Pitchord/environment/models。</p>}{model.provider === 'msst' && <p className="mt-1 text-xs text-muted-foreground">MSST `.ckpt` 必须与配套 YAML 一起导入。当前可直接运行 MelBandRoformer 与 BSRoformer，架构会按常见模型文件名识别。</p>}</div><div className="flex shrink-0 gap-2">{!model.ready && model.source !== 'custom' && <Button size="sm" onClick={() => setPendingModelDownload(model.id)} disabled={!analysisEnvironment.runtimeReady}>准备</Button>}{model.canDelete && model.ready && <Button size="sm" variant="outline" onClick={() => setPendingModelRemoval(model.id)}>删除</Button>}</div></div></div>)}
        {!analysisEnvironment?.separationModels.length && <p className="py-6 text-center text-sm text-muted-foreground">正在读取模型目录…</p>}
        <div className="rounded-lg border border-dashed border-border p-3"><p className="text-sm font-medium">导入自己的人声分离模型</p><p className="mt-1 text-xs text-muted-foreground">请一次选择 MSST `.ckpt` 权重和配套 YAML；也兼容 Demucs `.th`。文件会复制到 environment/models/custom，之后删除 Pitchord 中的副本不会影响原文件。可识别的 MelBandRoformer 与 BSRoformer 会立即出现在功能页。</p><Button className="mt-3" size="sm" variant="outline" onClick={() => void importAnalysisModel('separation')}>选择模型文件…</Button></div>
        <p className="pt-2 text-sm font-medium">主唱与和声分离模型（第二阶段）</p>{analysisEnvironment?.harmonyModels?.map(model => <div key={`harmony-${model.id}`} className="rounded-lg border border-border bg-muted/30 p-3"><div className="flex items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-medium">{model.label}</p><Badge variant={model.ready ? 'secondary' : 'outline'}>{model.ready ? model.runnable === false ? '暂不可运行' : '已安装' : '未安装'}</Badge><Badge variant="outline">{model.source === 'custom' ? '用户模型' : '推荐模型'}</Badge></div><p className="mt-1 text-xs text-muted-foreground">{model.description}</p>{model.source !== 'custom' && <p className="mt-1 text-xs text-muted-foreground">首次准备约下载 204 MB，权重来自模型作者的 Hugging Face 仓库并进行 SHA-256 校验；不会随安装包分发。</p>}</div><div className="flex shrink-0 gap-2">{!model.ready && model.source !== 'custom' && <Button size="sm" onClick={() => setPendingModelDownload(`harmony:${model.id}`)} disabled={!analysisEnvironment.runtimeReady}>准备</Button>}{model.canDelete && model.ready && <Button size="sm" variant="outline" onClick={() => setPendingModelRemoval(model.source === 'custom' ? model.id : `harmony:${model.id}`)}>删除</Button>}</div></div></div>)}
        <div className="rounded-lg border border-dashed border-border p-3"><p className="text-sm font-medium">导入自己的 MSST 去和声模型</p><p className="mt-1 text-xs text-muted-foreground">请同时选择 `.ckpt` 与配套 YAML；当前支持输出 Vocals（主唱）和其余人声的 RoFormer 配置。模型只作用于已分离的人声，不会替代第一阶段。</p><Button className="mt-3" size="sm" variant="outline" onClick={() => void importAnalysisModel('harmony')}>选择模型文件…</Button></div>
        <p className="pt-2 text-sm font-medium">音高识别模型与算法</p>{analysisEnvironment?.pitchMethods.map(method => <div key={method.id} className="rounded-lg border border-border bg-muted/30 p-3"><div className="flex items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-medium">{method.label}</p><Badge variant={method.ready && method.runnable !== false ? 'secondary' : 'outline'}>{method.ready && method.runnable !== false ? '可运行' : method.ready ? '已纳入，暂不可运行' : '尚未加入'}</Badge></div><p className="mt-1 text-xs text-muted-foreground">{method.description}</p></div>{method.canDelete && <Button size="sm" variant="outline" onClick={() => setPendingModelRemoval(method.id)}>删除</Button>}</div></div>)}<div className="rounded-lg border border-dashed border-border p-3"><p className="text-sm font-medium">导入自己的音高模型</p><p className="mt-1 text-xs text-muted-foreground">权重会复制到 Pitchord 环境。只有识别到匹配的推理提供者后才会出现在可运行算法中。</p><Button className="mt-3" size="sm" variant="outline" onClick={() => void importAnalysisModel('pitch')}>选择音高模型…</Button></div>
        <p className="pt-2 text-sm font-medium">歌词时间戳匹配模型</p>{analysisEnvironment?.alignment.models.map(model => <div key={`alignment-${model.id}`} className="rounded-lg border border-border bg-muted/30 p-3"><div className="flex items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-medium">{model.label}</p><Badge variant={model.ready ? 'secondary' : 'outline'}>{model.ready ? '已安装' : '未安装'}</Badge><Badge variant="outline">faster-whisper</Badge></div><p className="mt-1 text-xs text-muted-foreground">{model.description}</p><p className="mt-1 text-xs text-muted-foreground">模型只保存在 Pitchord/environment/models/whisper，不写入系统目录。首次准备需要联网。</p></div><div className="flex shrink-0 gap-2">{!model.ready ? <Button size="sm" onClick={() => setPendingModelDownload(`alignment:${model.id}`)} disabled={!analysisEnvironment.packages.fasterWhisper}>准备</Button> : <Button size="sm" variant="outline" onClick={() => setPendingModelRemoval(`alignment:${model.id}`)}>删除</Button>}</div></div></div>)}
      </div><DialogFooter><Button variant="outline" onClick={() => void window.pitchordDesktop?.openAnalysisFolder()}>打开模型目录</Button><Button onClick={() => setModelManagerOpen(false)}>完成</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={!!pendingModelDownload} onOpenChange={open => { if (!open) setPendingModelDownload(null) }}><DialogContent><DialogHeader><DialogTitle>准备模型</DialogTitle><DialogDescription>将从模型提供方联网下载所需权重，并保存到 Pitchord 自己的 environment/models 中。不会写入系统模型目录，也不要求填写 HF Token。</DialogDescription></DialogHeader><p className="text-sm">模型：{pendingModelDownload?.startsWith('alignment:') ? analysisEnvironment?.alignment.models.find(model => model.id === pendingModelDownload.slice('alignment:'.length))?.label : pendingModelDownload?.startsWith('harmony:') ? analysisEnvironment?.harmonyModels?.find(model => model.id === pendingModelDownload.slice('harmony:'.length))?.label : analysisEnvironment?.separationModels.find(model => model.id === pendingModelDownload)?.label}</p><DialogFooter><Button variant="outline" onClick={() => setPendingModelDownload(null)}>取消</Button><Button onClick={() => { const id = pendingModelDownload; setPendingModelDownload(null); if (!id) return; if (id.startsWith('alignment:')) void prepareAlignmentModel(id.slice('alignment:'.length)); else if (id.startsWith('harmony:')) void prepareHarmonyModel(id.slice('harmony:'.length)); else void prepareAnalysisModel(id) }}>开始下载</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={!!pendingModelRemoval} onOpenChange={open => { if (!open) setPendingModelRemoval(null) }}><DialogContent><DialogHeader><DialogTitle>删除 Pitchord 中的模型？</DialogTitle><DialogDescription>只删除 Pitchord 环境内管理的副本。用户最初选择的模型文件不会被删除，工程中的历史分析结果也会保留。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setPendingModelRemoval(null)}>取消</Button><Button variant="destructive" onClick={() => { if (!pendingModelRemoval) return; if (pendingModelRemoval.startsWith('alignment:')) void removeAlignmentModel(pendingModelRemoval.slice('alignment:'.length)); else if (pendingModelRemoval.startsWith('harmony:')) void removeHarmonyModel(pendingModelRemoval.slice('harmony:'.length)); else void removeAnalysisModel(pendingModelRemoval) }}>确认删除</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={subtitleStudioOpen} onOpenChange={open => { setSubtitleStudioOpen(open); if (!open) setPitchColorOpen(false) }}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>字幕样式、预览与导出</DialogTitle>
            <DialogDescription>左侧调整后，右侧立即显示当前视频画面上的字幕；导出时使用同一套设置。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(300px,.85fr)]">
            <div className="space-y-5">
              <section className="space-y-2">
                <p className="text-sm font-medium">样式预设</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {([
                    ['karaoke', '卡拉 OK'],
                    ['clean', '清爽描边'],
                    ['cinema', '影院底栏'],
                    ['minimal', '极简文字'],
                  ] as const).map(([id, label]) => <Button key={id} size="sm" variant="outline" onClick={() => setSubtitleStyle(style => ({ ...style, ...subtitleStylePresets[id] }))}>{label}</Button>)}
                </div>
              </section>

              <section className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <p className="text-sm font-medium">字幕位置</p>
                  <div className="grid grid-cols-3 gap-1.5 rounded-xl border border-border bg-muted/20 p-2">
                    {(['top', 'middle', 'bottom'] as const).flatMap(vertical => (['left', 'center', 'right'] as const).map(horizontal => {
                      const selected = subtitleStyle.verticalPosition === vertical && subtitleStyle.horizontalPosition === horizontal
                      const label = `${vertical === 'top' ? '上' : vertical === 'middle' ? '中' : '下'}${horizontal === 'left' ? '左' : horizontal === 'center' ? '中' : '右'}`
                      return <button key={`${vertical}-${horizontal}`} type="button" aria-label={label} title={label} onClick={() => setSubtitleStyle(style => ({ ...style, verticalPosition: vertical, horizontalPosition: horizontal }))} className={`flex h-10 items-center justify-center rounded-md border text-xs transition ${selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background text-muted-foreground hover:border-primary/60'}`}><span className={`size-2 rounded-full ${selected ? 'bg-primary-foreground' : 'bg-current'}`} /></button>
                    }))}
                  </div>
                  <label className="block space-y-2 text-xs text-muted-foreground">边缘距离：{subtitleStyle.marginHorizontal}px<Slider min={24} max={240} step={8} value={[subtitleStyle.marginHorizontal]} onValueChange={values => setSubtitleStyle(style => ({ ...style, marginHorizontal: values[0] }))} /></label>
                  <label className="block space-y-2 text-xs text-muted-foreground">垂直距离：{subtitleStyle.marginBottom}px<Slider min={32} max={280} step={8} value={[subtitleStyle.marginBottom]} onValueChange={values => setSubtitleStyle(style => ({ ...style, marginBottom: values[0] }))} /></label>
                </div>
                <div className="space-y-3">
                  <p className="text-sm font-medium">文字</p>
                  <label className="block space-y-1.5 text-xs text-muted-foreground">字体<Input value={subtitleStyle.fontName} onChange={event => setSubtitleStyle(style => ({ ...style, fontName: event.target.value }))} /></label>
                  <label className="block space-y-2 text-xs text-muted-foreground">字号：{subtitleStyle.fontSize}<Slider min={28} max={96} step={2} value={[subtitleStyle.fontSize]} onValueChange={values => setSubtitleStyle(style => ({ ...style, fontSize: values[0] }))} /></label>
                  <label className="block space-y-2 text-xs text-muted-foreground">字间距：{subtitleStyle.spacing}<Slider min={-2} max={12} step={1} value={[subtitleStyle.spacing]} onValueChange={values => setSubtitleStyle(style => ({ ...style, spacing: values[0] }))} /></label>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant={subtitleStyle.bold ? 'secondary' : 'outline'} onClick={() => setSubtitleStyle(style => ({ ...style, bold: !style.bold }))}>粗体</Button>
                    <Button size="sm" variant={subtitleStyle.italic ? 'secondary' : 'outline'} onClick={() => setSubtitleStyle(style => ({ ...style, italic: !style.italic }))}>斜体</Button>
                    <Button size="sm" variant={subtitleStyle.showPitch ? 'secondary' : 'outline'} onClick={() => setSubtitleStyle(style => ({ ...style, showPitch: !style.showPitch }))}>显示音高</Button>
                    <Button size="sm" variant={subtitleStyle.showDot ? 'secondary' : 'outline'} onClick={() => setSubtitleStyle(style => ({ ...style, showDot: !style.showDot }))}>强调点</Button>
                  </div>
                  {subtitleStyle.showPitch && <label className="block space-y-1.5 text-xs text-muted-foreground">唱过后保留的音高标记<Select value={subtitleStyle.retainedPitchLabel} onValueChange={value => setSubtitleStyle(style => ({ ...style, retainedPitchLabel: value as SubtitleStyle['retainedPitchLabel'] }))}><SelectTrigger aria-label="唱过后保留的音高标记"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="last">最后音高（推荐）</SelectItem><SelectItem value="lowest">最低音高</SelectItem><SelectItem value="highest">最高音高</SelectItem><SelectItem value="longest">时值最长的音高</SelectItem></SelectContent></Select><span className="block leading-relaxed">每个唱过的字都会留下一个标记；歌词字色保留该字音高序列中最后一音的颜色。右上角原始 F0 仅供校对，不参与字幕标记。</span></label>}
                  <div className="space-y-3 rounded-lg border border-border p-3">
                    <div className="flex items-center justify-between gap-3"><div><p className="text-xs font-medium">原始人声音高标记</p><p className="mt-1 text-xs text-muted-foreground">独立于人工修正的逐字音高；颜色共用歌词色带。</p></div><Button size="sm" variant={subtitleStyle.embedRawPitch ? 'secondary' : 'outline'} aria-label="将原始 F0 嵌入视频" aria-pressed={subtitleStyle.embedRawPitch} onClick={() => setSubtitleStyle(style => ({ ...style, embedRawPitch: !style.embedRawPitch }))}>{subtitleStyle.embedRawPitch ? '已嵌入' : '嵌入视频'}</Button></div>
                    {subtitleStyle.embedRawPitch && <><div className="space-y-1.5"><p className="text-xs text-muted-foreground">嵌入位置</p><div className="grid max-w-44 grid-cols-3 gap-1.5">{(['top', 'middle', 'bottom'] as const).flatMap(vertical => (['left', 'center', 'right'] as const).map(horizontal => {
                      const selected = subtitleStyle.rawPitchVerticalPosition === vertical && subtitleStyle.rawPitchHorizontalPosition === horizontal
                      const label = `原始 F0 ${vertical === 'top' ? '上' : vertical === 'middle' ? '中' : '下'}${horizontal === 'left' ? '左' : horizontal === 'center' ? '中' : '右'}`
                      return <button key={`${vertical}-${horizontal}`} type="button" aria-label={label} title={label} onClick={() => setSubtitleStyle(style => ({ ...style, rawPitchVerticalPosition: vertical, rawPitchHorizontalPosition: horizontal }))} className={`flex h-8 items-center justify-center rounded-md border transition ${selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background text-muted-foreground hover:border-primary/60'}`}><span className={`size-2 rounded-full ${selected ? 'bg-primary-foreground' : 'bg-current'}`} /></button>
                    }))}</div></div>
                      <label className="block space-y-2 text-xs text-muted-foreground">标记字号：{subtitleStyle.rawPitchFontSize}px<Slider min={20} max={96} step={2} value={[subtitleStyle.rawPitchFontSize]} onValueChange={values => setSubtitleStyle(style => ({ ...style, rawPitchFontSize: values[0] }))} /></label>
                      <label className="block space-y-2 text-xs text-muted-foreground">边缘距离：{subtitleStyle.rawPitchMargin}px<Slider min={8} max={160} step={4} value={[subtitleStyle.rawPitchMargin]} onValueChange={values => setSubtitleStyle(style => ({ ...style, rawPitchMargin: values[0] }))} /></label>
                    </>}
                  </div>
                </div>
              </section>

              <section className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="space-y-1.5 text-xs text-muted-foreground">普通文字<Input type="color" value={subtitleStyle.baseColor} onChange={event => setSubtitleStyle(style => ({ ...style, baseColor: event.target.value }))} /></label>
                  <label className="space-y-1.5 text-xs text-muted-foreground">描边颜色<Input type="color" value={subtitleStyle.outlineColor} onChange={event => setSubtitleStyle(style => ({ ...style, outlineColor: event.target.value }))} /></label>
                  <label className="space-y-1.5 text-xs text-muted-foreground">背景颜色<Input type="color" value={subtitleStyle.backgroundColor} onChange={event => setSubtitleStyle(style => ({ ...style, backgroundColor: event.target.value }))} /></label>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block space-y-1.5 text-xs text-muted-foreground">背景方式<Select value={subtitleStyle.backgroundStyle} onValueChange={value => setSubtitleStyle(style => ({ ...style, backgroundStyle: value as SubtitleStyle['backgroundStyle'] }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="outline">描边</SelectItem><SelectItem value="box">半透明底框</SelectItem><SelectItem value="none">无背景</SelectItem></SelectContent></Select></label>
                  <div className="space-y-1.5 text-xs text-muted-foreground"><p>歌词音高色带</p><Button type="button" className="w-full justify-between" variant="outline" onClick={() => setPitchColorOpen(true)}><span>{pitchColorBandNames[subtitleStyle.colorBand] ?? pitchColorBandNames.rainbow}</span><SlidersHorizontal className="size-4" /></Button></div>
                </div>
                <div className="rounded-lg border border-border p-3">
                  <p className="mb-3 text-xs font-medium">当前字强调点</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block space-y-2 text-xs text-muted-foreground">圆点直径：{Math.round(subtitleStyle.dotSize / 4)}px<Slider min={12} max={72} step={4} value={[subtitleStyle.dotSize]} onValueChange={values => setSubtitleStyle(style => ({ ...style, dotSize: values[0] }))} /></label>
                    <label className="block space-y-2 text-xs text-muted-foreground">垂直偏移：{subtitleStyle.dotOffset}px<Slider min={-20} max={40} step={2} value={[subtitleStyle.dotOffset]} onValueChange={values => setSubtitleStyle(style => ({ ...style, dotOffset: values[0] }))} /></label>
                    <label className="block space-y-1.5 text-xs text-muted-foreground">点的颜色<Select value={subtitleStyle.dotColorMode} onValueChange={value => setSubtitleStyle(style => ({ ...style, dotColorMode: value as SubtitleStyle['dotColorMode'] }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="pitch">跟随字的音高</SelectItem><SelectItem value="custom">自定义</SelectItem></SelectContent></Select></label>
                    {subtitleStyle.dotColorMode === 'custom' && <label className="space-y-1.5 text-xs text-muted-foreground">自定义点颜色<Input type="color" value={subtitleStyle.dotColor} onChange={event => setSubtitleStyle(style => ({ ...style, dotColor: event.target.value }))} /></label>}
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block space-y-2 text-xs text-muted-foreground">描边宽度：{subtitleStyle.outline}<Slider min={0} max={8} step={1} value={[subtitleStyle.outline]} onValueChange={values => setSubtitleStyle(style => ({ ...style, outline: values[0] }))} /></label>
                  <label className="block space-y-2 text-xs text-muted-foreground">阴影：{subtitleStyle.shadow}<Slider min={0} max={8} step={1} value={[subtitleStyle.shadow]} onValueChange={values => setSubtitleStyle(style => ({ ...style, shadow: values[0] }))} /></label>
                  <label className="block space-y-2 text-xs text-muted-foreground">背景不透明度：{subtitleStyle.backgroundOpacity}%<Slider min={0} max={100} step={5} value={[subtitleStyle.backgroundOpacity]} onValueChange={values => setSubtitleStyle(style => ({ ...style, backgroundOpacity: values[0] }))} /></label>
                  <label className="block space-y-2 text-xs text-muted-foreground">淡入淡出：{subtitleStyle.fadeMs}ms<Slider min={0} max={500} step={20} value={[subtitleStyle.fadeMs]} onValueChange={values => setSubtitleStyle(style => ({ ...style, fadeMs: values[0] }))} /></label>
                </div>
              </section>
            </div>

            <div className="space-y-4">
              <div className="space-y-3 lg:sticky lg:top-0 lg:z-10 lg:rounded-xl lg:bg-background lg:p-2">
              <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-xl bg-neutral-950 shadow-inner">
                <div className="relative max-h-full max-w-full" style={{ aspectRatio: mediaIsVideo ? videoAspect : 16 / 9, width: mediaIsVideo && videoAspect >= 16 / 9 ? '100%' : undefined, height: !mediaIsVideo || videoAspect < 16 / 9 ? '100%' : undefined }}>
                  {mediaIsVideo && <VideoFrameMirror mediaRef={mediaRef} />}
                  <LiveSubtitlePreview segments={effectiveSegments} points={pitchPoints} style={subtitleStyle} mediaRef={mediaRef} playhead={playhead} />
                </div>
              </div>
              <div className="space-y-2">
                <input type="range" min={0} max={Math.max(duration, 0.01)} step={0.01} value={Math.min(playhead, Math.max(duration, 0.01))} onChange={event => seek(Number(event.target.value))} disabled={!mediaUrl} className="h-1.5 w-full cursor-pointer accent-primary disabled:cursor-default" aria-label="字幕预览播放进度" />
                <div className="flex items-center justify-between gap-2"><span className="font-mono text-xs tabular-nums text-muted-foreground">{formatTime(playhead)} / {formatTime(duration)}</span><Button size="sm" variant="outline" onClick={() => void togglePlayback()} disabled={!mediaUrl}>{playing ? <Pause className="size-4" /> : <Play className="size-4" />}{playing ? '暂停预览' : '播放预览'}</Button></div>
              </div>
              <p className="text-xs text-muted-foreground">{!effectiveSegments.some(segment => segment.chars.length) ? '导入并完成逐字歌词后，此处会显示字幕；现在也可以先调整样式。' : subtitleStyle.embedRawPitch ? '可拖动上方进度查看任意位置。原始 F0 标记会随字幕一同嵌入视频；它不改变人工修正的逐字音高。字体细节以最终导出为准。' : '可拖动上方进度查看任意位置。右上角 F0 小窗仅供校对，不会嵌入视频；字体细节以最终导出为准。'}</p>
              </div>
              <div className="space-y-2">
                <div className="rounded-lg border border-border p-3"><p className="text-sm font-medium">LRC</p><p className="mt-1 text-xs text-muted-foreground">每句开始时间与歌词；适合音乐播放器，不含结束时间、字级时间和样式。</p></div>
                <div className="rounded-lg border border-border p-3"><p className="text-sm font-medium">SRT</p><p className="mt-1 text-xs text-muted-foreground">每句开始/结束时间与歌词；兼容性最好，不含字级音高和视觉样式。</p></div>
                <div className="rounded-lg border border-primary/40 bg-primary/5 p-3"><p className="text-sm font-medium">ASS（推荐用于其他视频）</p><p className="mt-1 text-xs text-muted-foreground">包含逐字时间、音高、位置、颜色、描边和动画。目标设备仍需安装所选字体。</p></div>
                <div className="rounded-lg border border-border p-3"><p className="text-sm font-medium">JSON</p><p className="mt-1 text-xs text-muted-foreground">保留结构化逐字时间、音高切片和完整样式，方便二次开发，不是播放器通用字幕。</p></div>
              </div>
            </div>
          </div>
          <DialogFooter className="flex-wrap">
            <Button variant="outline" onClick={() => void exportLrc()} disabled={!segments.length}>导出 LRC</Button>
            <Button variant="outline" onClick={() => void exportSrt()} disabled={!segments.length}>导出 SRT</Button>
            <Button variant="outline" onClick={() => void exportWordSubtitles('json')} disabled={!subtitleReady}>导出 JSON</Button>
            <Button variant="outline" onClick={() => void exportWordSubtitles('ass')} disabled={!subtitleReady}>导出 ASS</Button>
            <Button onClick={() => void burnSubtitleVideo()} disabled={!subtitleReady || !mediaIsVideo || !projectDirectory || pipelineTaskRunning}><Video />生成带字幕视频</Button>
          </DialogFooter>
          <PitchColorBandEditor open={pitchColorOpen} onOpenChange={setPitchColorOpen} style={subtitleStyle} onChange={setSubtitleStyle} points={pitchPoints} />
        </DialogContent>
      </Dialog>

      <Dialog open={storageOpen} onOpenChange={open => { if (!cleanupBusy) { setStorageOpen(open); if (!open) setCleanupTarget(null) } }}><DialogContent className="sm:max-w-xl"><DialogHeader><DialogTitle>存储与环境</DialogTitle><DialogDescription>这里只管理 Pitchord 的分析环境、模型和缓存，工程与歌词不会被删除。</DialogDescription></DialogHeader><div className="space-y-3">
        <div className="rounded-lg border border-border bg-muted/30 p-3"><div className="flex items-center justify-between gap-3"><span className="text-sm font-medium">分析运行环境</span><span className="text-sm tabular-nums text-muted-foreground">{analysisStorage ? formatBytes(analysisStorage.sizes.baseRuntime + analysisStorage.sizes.analysisRuntime) : '正在计算…'}</span></div><p className="mt-1 text-xs text-muted-foreground">媒体处理、人声分离和音高识别运行依赖</p><Button className="mt-2" size="sm" variant="outline" onClick={() => setCleanupTarget('runtime')} disabled={cleanupBusy || !analysisStorage || analysisStorage.sizes.baseRuntime + analysisStorage.sizes.analysisRuntime === 0}>删除运行环境</Button></div>
        <div className="rounded-lg border border-border bg-muted/30 p-3"><div className="flex items-center justify-between gap-3"><span className="text-sm font-medium">模型</span><span className="text-sm tabular-nums text-muted-foreground">{analysisStorage ? formatBytes(analysisStorage.sizes.models) : '正在计算…'}</span></div><p className="mt-1 text-xs text-muted-foreground">人声分离及后续分析模型</p><Button className="mt-2" size="sm" variant="outline" onClick={() => setCleanupTarget('models')} disabled={cleanupBusy || !analysisStorage?.sizes.models}>删除模型</Button></div>
        <div className="rounded-lg border border-border bg-muted/30 p-3"><div className="flex items-center justify-between gap-3"><span className="text-sm font-medium">下载与安装缓存</span><span className="text-sm tabular-nums text-muted-foreground">{analysisStorage ? formatBytes(analysisStorage.sizes.cache + analysisStorage.sizes.downloads) : '正在计算…'}</span></div><Button className="mt-2" size="sm" variant="outline" onClick={() => setCleanupTarget('cache')} disabled={cleanupBusy || !analysisStorage || analysisStorage.sizes.cache + analysisStorage.sizes.downloads === 0}>清理缓存</Button></div>
        {!!analysisStorage?.legacyTotal && <div className="rounded-lg border border-border bg-muted/30 p-3"><div className="flex items-center justify-between gap-3"><span className="text-sm font-medium">旧版本分析数据</span><span className="text-sm tabular-nums text-muted-foreground">{formatBytes(analysisStorage.legacyTotal)}</span></div><p className="mt-1 break-all text-xs text-muted-foreground">{analysisStorage.legacyRoot}</p><Button className="mt-2" size="sm" variant="outline" onClick={() => setCleanupTarget('legacy')} disabled={cleanupBusy}>删除旧版本数据</Button></div>}
        {analysisStorage && <p className="break-all text-xs text-muted-foreground">合计 {formatBytes(analysisStorage.total)} · {analysisStorage.root}</p>}
        {cleanupTarget && <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3"><p className="text-sm font-medium">确认删除{cleanupTarget === 'runtime' ? '分析运行环境' : cleanupTarget === 'models' ? '模型' : cleanupTarget === 'cache' ? '缓存' : cleanupTarget === 'legacy' ? '旧版本分析数据' : '全部分析数据'}？</p><p className="mt-1 text-xs text-muted-foreground">需要时可以重新准备。工程和歌词不会被删除。</p><div className="mt-3 flex justify-end gap-2"><Button size="sm" variant="outline" onClick={() => setCleanupTarget(null)} disabled={cleanupBusy}>取消</Button><Button size="sm" variant="destructive" onClick={() => void removeAnalysisData()} disabled={cleanupBusy}><Trash2 />{cleanupBusy ? '正在删除…' : '确认删除'}</Button></div></div>}
      </div><DialogFooter><Button variant="destructive" onClick={() => setCleanupTarget('all')} disabled={cleanupBusy || !analysisStorage?.total}>删除全部分析数据</Button><Button variant="outline" onClick={() => void window.pitchordDesktop?.openAnalysisFolder()}>打开文件夹</Button><Button onClick={() => setStorageOpen(false)} disabled={cleanupBusy}>完成</Button></DialogFooter></DialogContent></Dialog>

      {workspaceOpen && <div className="fixed bottom-4 right-4 z-[70] flex max-w-[calc(100vw-2rem)] flex-col items-end gap-2" data-work-center>
        {workCenterOpen && <section className="w-[360px] max-w-full overflow-hidden rounded-xl border border-border bg-card shadow-2xl" aria-label="任务进度">
          <div className="flex items-center justify-between border-b border-border px-3 py-2"><div className="flex items-center gap-2"><Activity className="size-4 text-primary" /><div><p className="text-sm font-medium">任务进度</p><p className="text-[11px] text-muted-foreground">{workItems.filter(item => item.status === 'running').length ? `${workItems.filter(item => item.status === 'running').length} 项正在执行` : '当前没有运行中的任务'}</p></div></div><div className="flex items-center gap-1"><Button size="sm" variant="ghost" onClick={() => setWorkItems(items => items.filter(item => item.status === 'running'))} disabled={!workItems.some(item => item.status !== 'running')}>清除记录</Button><Button size="icon" variant="ghost" onClick={() => setWorkCenterOpen(false)} aria-label="收起任务进度"><ChevronDown /></Button></div></div>
          <div className="max-h-80 space-y-1 overflow-y-auto p-2">{workItems.map(item => <div key={item.id} className="rounded-lg border border-border bg-background p-2.5"><div className="flex items-start gap-2">{item.status === 'running' ? <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-primary" /> : item.status === 'success' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" /> : item.status === 'cancelled' ? <Square className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> : <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />}<div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><p className="truncate text-xs font-medium">{item.title}</p><div className="flex items-center gap-1"><span className="text-[10px] text-muted-foreground">{item.status === 'running' ? '进行中' : item.status === 'success' ? '完成' : item.status === 'cancelled' ? '已取消' : '失败'}</span>{item.status === 'running' && cancellableTaskIds.has(item.id) && <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => void cancelAnalysisTask(item.id as 'environment' | 'separation' | 'pitch' | 'alignment')}><Square className="size-3" />取消</Button>}</div></div><p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{item.message}</p>{item.status === 'running' && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><div className={`h-full rounded-full bg-primary transition-[width] duration-200 ${item.progress === undefined ? 'w-1/3 animate-pulse' : ''}`} style={item.progress === undefined ? undefined : { width: `${Math.round(clamp(item.progress, 0, 1) * 100)}%` }} /></div>}</div></div></div>)}{!workItems.length && <p className="py-6 text-center text-xs text-muted-foreground">导入、环境与模型、人声分离、音高识别和视频渲染的进度会显示在这里。</p>}</div>
        </section>}
        {!workCenterOpen && <Button className="shadow-lg" variant="secondary" onClick={() => setWorkCenterOpen(true)}><Activity />任务进度{workItems.some(item => item.status === 'running') && <Badge variant="secondary">{workItems.filter(item => item.status === 'running').length}</Badge>}<ChevronUp /></Button>}
      </div>}

      {taskAlert && <div className={`fixed right-4 top-4 z-[90] flex w-[360px] max-w-[calc(100vw-2rem)] items-start gap-3 rounded-xl border bg-card p-3 shadow-2xl ${taskAlert.status === 'error' ? 'border-destructive/60' : 'border-emerald-500/50'}`} role={taskAlert.status === 'error' ? 'alert' : 'status'} aria-live={taskAlert.status === 'error' ? 'assertive' : 'polite'}>
        {taskAlert.status === 'error' ? <AlertCircle className="mt-0.5 size-5 shrink-0 text-destructive" /> : <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" />}
        <div className="min-w-0 flex-1"><p className="text-sm font-semibold">{taskAlert.title}{taskAlert.status === 'error' ? '失败' : '完成'}</p><p className="mt-1 break-words text-xs text-muted-foreground">{taskAlert.message}</p></div>
        <Button size="icon" variant="ghost" className="size-7 shrink-0" onClick={() => setTaskAlert(null)} aria-label="关闭任务提示"><X className="size-4" /></Button>
      </div>}

      {contextMenu && <div className="fixed z-50 min-w-40 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md" style={{ left: contextMenu.x, top: contextMenu.y }} role="menu" onPointerDown={event => event.stopPropagation()}><Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => contextAction('add')}><Plus />添加句</Button><Button variant="ghost" size="sm" className="w-full justify-start" disabled={!mergeIndexes} onClick={() => contextAction('merge')}><Merge />合并</Button><Button variant="ghost" size="sm" className="w-full justify-start" disabled={!activeLine || !splitBoundaries.length} onClick={() => contextAction('split')}><Scissors />分割</Button><Button variant="ghost" size="sm" className="w-full justify-start text-destructive hover:text-destructive" disabled={!contextMenu.id && !selectedLineIds.length} onClick={() => contextAction('delete')}><Trash2 />删除</Button></div>}
    </div>
  </TooltipProvider>
}
