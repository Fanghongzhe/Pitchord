import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import {
  Activity, AlertCircle, AudioLines, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Download,
  FileAudio2, FilePlus2, FileText, FolderOpen, HardDrive, LoaderCircle, Merge, Pause, Play, Plus, Redo2, Save,
  Scissors, Settings2, Square, Trash2, Undo2, Upload, Video,
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
import {
  carryPitchOverrides, clamp, createSegment, formatTime, getAdjacentSelection, lyricUnits, mergeSegments,
  MIN_SPAN, parseLyrics, parseTime, replaceText, retimeSegment, roundTime, splitSegment, suggestSplitOffset,
} from '@/lib/lyrics'
import type { LyricSegment } from '@/lib/lyrics'
import { analyzeAudioBuffer, matchPitchToChars, parsePitchNotation, pitchForChar, pitchNotation, validPitchAnnotation } from '@/lib/pitch'
import type { PitchPoint } from '@/lib/pitch'
import { defaultSubtitleStyle, generatePitchAss, wordTimedSubtitles } from '@/lib/subtitles'
import type { SubtitleStyle } from '@/lib/subtitles'
import { StemMixer } from '@/lib/stem-mixer'
import { resolveRangeConflict } from '@/lib/range-conflict'

type History = { present: LyricSegment[]; past: LyricSegment[][]; future: LyricSegment[][] }
type View = 'lines' | 'chars'
type SeparationResult = { id: string; modelId: string; modelLabel: string; createdAt: string; vocals: string; accompaniment: string }
type PitchResult = { id: string; algorithm: PitchAlgorithm; label: string; createdAt: string; path?: string; device?: string; points: PitchPoint[]; separationResultId?: string }
type AlignmentResult = { id: string; modelId: string; modelLabel: string; createdAt: string; inputResultId?: string; path?: string; coverage: number; lowConfidenceLines?: number[]; segments: LyricSegment[] }
type Draft = { segments: LyricSegment[]; mediaName: string; duration: number; pitchPoints?: PitchPoint[]; separationResults?: SeparationResult[]; activeSeparationResultId?: string; activeVocalResultId?: string; activeAccompanimentResultId?: string; pitchInputResultId?: string; pitchResults?: PitchResult[]; activePitchResultId?: string; alignmentInputResultId?: string; alignmentResults?: AlignmentResult[]; activeAlignmentResultId?: string }
type TrackKind = 'original' | 'vocals' | 'accompaniment'
type TimelinePreview = { id: string; start: number; end: number }
type ContextState = { x: number; y: number; id?: string; time?: number }
type AnalysisEnvironment = {
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
  mediaTools: { ffmpeg: boolean; ffprobe: boolean }
  separationModels: Array<{ id: string; label: string; description: string; bundled: boolean; ready: boolean; runnable?: boolean; source?: 'recommended' | 'custom'; canDelete?: boolean; provider?: string }>
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
  busy: boolean
}
type WorkItem = { id: string; title: string; status: 'running' | 'success' | 'error' | 'cancelled'; message: string; progress?: number; updatedAt: number }
type PitchAlgorithm = 'pyin' | 'torchcrepe'
type AnalysisStorage = {
  root: string
  locations: Record<'baseRuntime' | 'analysisRuntime' | 'models' | 'cache' | 'downloads', string>
  sizes: Record<'baseRuntime' | 'analysisRuntime' | 'models' | 'cache' | 'downloads', number>
  legacyRoot: string
  legacyTotal: number
  total: number
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function readDraft(): Draft | null {
  try {
    const value = JSON.parse(localStorage.getItem('pitchord.draft.v1') ?? 'null') as Draft | null
    return value && Array.isArray(value.segments) && typeof value.mediaName === 'string' && typeof value.duration === 'number' ? value : null
  } catch { return null }
}

const savedDraft = readDraft()
const cancellableTaskIds = new Set(['environment', 'separation', 'pitch', 'alignment'])

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
  const [mediaUrl, setMediaUrl] = useState('')
  const [stemReady, setStemReady] = useState<{ vocals: boolean; accompaniment: boolean }>({ vocals: false, accompaniment: false })
  const [trackEnabled, setTrackEnabled] = useState<Record<TrackKind, boolean>>({ original: true, vocals: false, accompaniment: false })
  const [trackVolume, setTrackVolume] = useState<Record<TrackKind, number>>({ original: 100, vocals: 100, accompaniment: 100 })
  const [masterMuted, setMasterMuted] = useState(false)
  const [masterVolume, setMasterVolume] = useState(100)
  const [mediaName, setMediaName] = useState(savedDraft?.mediaName ?? '')
  const [mediaIsVideo, setMediaIsVideo] = useState(false)
  const [duration, setDuration] = useState(savedDraft?.duration ?? 0)
  const [playhead, setPlayhead] = useState(0)
  const [guideLine, setGuideLine] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [peaks, setPeaks] = useState<number[]>([])
  const [waveformStatus, setWaveformStatus] = useState('导入音频或视频后显示波形')
  const [pitchPoints, setPitchPoints] = useState<PitchPoint[]>([])
  const [pitchStatus, setPitchStatus] = useState('尚未分析音高')
  const [audioReady, setAudioReady] = useState(false)
  const [vocalTrackReady, setVocalTrackReady] = useState(false)
  const [separationStatus, setSeparationStatus] = useState('未运行')
  const [analysisEnvironment, setAnalysisEnvironment] = useState<AnalysisEnvironment | null>(null)
  const [analysisEnvironmentBusy, setAnalysisEnvironmentBusy] = useState(false)
  const [analysisProgress, setAnalysisProgress] = useState('正在检查分析环境…')
  const [storageOpen, setStorageOpen] = useState(false)
  const [analysisStorage, setAnalysisStorage] = useState<AnalysisStorage | null>(null)
  const [cleanupTarget, setCleanupTarget] = useState<'runtime' | 'models' | 'cache' | 'legacy' | 'all' | null>(null)
  const [cleanupBusy, setCleanupBusy] = useState(false)
  const [separationPromptOpen, setSeparationPromptOpen] = useState(false)
  const [repairEnvironmentOpen, setRepairEnvironmentOpen] = useState(false)
  const [environmentMode, setEnvironmentMode] = useState<'managed' | 'custom'>('managed')
  const [environmentRootDraft, setEnvironmentRootDraft] = useState('')
  const [externalPythonDraft, setExternalPythonDraft] = useState('')
  const [computeProfileDraft, setComputeProfileDraft] = useState<'auto' | 'cpu' | 'cuda121'>('auto')
  const [modelManagerOpen, setModelManagerOpen] = useState(false)
  const [pendingModelDownload, setPendingModelDownload] = useState<string | null>(null)
  const [pendingModelRemoval, setPendingModelRemoval] = useState<string | null>(null)
  const [separationModel, setSeparationModel] = useState('htdemucs')
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
  const [subtitleOpen, setSubtitleOpen] = useState(false)
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStyle>(defaultSubtitleStyle)
  const [rerunPrompt, setRerunPrompt] = useState<'separation' | 'pitch' | 'alignment' | null>(null)
  const [workItems, setWorkItems] = useState<WorkItem[]>([])
  const [workCenterOpen, setWorkCenterOpen] = useState(false)
  const [zoom, setZoom] = useState(85)
  const [importOpen, setImportOpen] = useState(false)
  const [importDraft, setImportDraft] = useState('')
  const [splitOpen, setSplitOpen] = useState(false)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [projectDirectory, setProjectDirectory] = useState('')
  const [projectName, setProjectName] = useState('')
  const [projectParent, setProjectParent] = useState('')
  const [newProjectName, setNewProjectName] = useState('')
  const [splitTimeDraft, setSplitTimeDraft] = useState('')
  const [splitOffset, setSplitOffset] = useState('')
  const [textDraft, setTextDraft] = useState('')
  const [startDraft, setStartDraft] = useState('')
  const [endDraft, setEndDraft] = useState('')
  const [pitchNotationEdit, setPitchNotationEdit] = useState<{ id: string; base: string; value: string } | null>(null)
  const [notice, setNotice] = useState(savedDraft?.segments.length ? '已恢复歌词草稿。重新导入同名媒体后即可试听。' : '导入媒体，然后导入 LRC 或粘贴歌词开始编辑。')
  const mediaInputRef = useRef<HTMLInputElement>(null)
  const vocalInputRef = useRef<HTMLInputElement>(null)
  const lyricInputRef = useRef<HTMLInputElement>(null)
  const environmentSetupPromptedRef = useRef(false)
  const projectInputRef = useRef<HTMLInputElement>(null)
  const mediaRef = useRef<HTMLMediaElement | null>(null)
  const mixerRef = useRef<StemMixer | null>(null)
  const mediaFileRef = useRef<File | null>(null)
  const pendingMediaRef = useRef<File | null>(null)
  const audioBufferRef = useRef<AudioBuffer | null>(null)
  const mediaToken = useRef(0)
  const auditionRef = useRef<{ start: number; end: number } | null>(null)
  const timelineSeekRef = useRef(false)
  const lastRangeEdgeRef = useRef<'start' | 'end' | null>(null)
  const rightEdgeAuditionRef = useRef(false)
  const finishRangeAdjustRef = useRef<() => void>(() => undefined)
  const finishCharRangeAdjustRef = useRef<() => void>(() => undefined)
  const togglePlaybackRef = useRef<(createGuideOnPause?: boolean) => Promise<void>>(async () => undefined)
  const getMixer = () => mixerRef.current ?? (mixerRef.current = new StemMixer())
  const activeLine = segments.find(segment => selectedLineIds.includes(segment.id)) ?? null
  const editingLocked = rangeAdjusting || charRangeAdjusting || conflictOpen
  const mergeIndexes = getAdjacentSelection(segments, selectedLineIds)
  const splitBoundaries = useMemo(() => activeLine ? lyricUnits(activeLine.text).slice(0, -1).map(unit => unit.endOffset) : [], [activeLine])
  const pitchMatches = useMemo(() => matchPitchToChars(segments, pitchPoints), [segments, pitchPoints])
  const voicedPitchPoints = useMemo(() => pitchPoints.filter(point => point.voiced && point.hz > 0), [pitchPoints])
  const selectedSeparationModel = analysisEnvironment?.separationModels.find(model => model.id === separationModel)

  const updateWork = useCallback((id: string, title: string, status: WorkItem['status'], message: string, progress?: number) => {
    setWorkItems(current => {
      const previous = current.find(item => item.id === id)
      const next = { id, title, status, message, progress: progress ?? previous?.progress, updatedAt: Date.now() }
      return [next, ...current.filter(item => item.id !== id)].slice(0, 12)
    })
    if (status === 'running') setWorkCenterOpen(true)
  }, [])

  const cancelAnalysisTask = useCallback(async (taskId: 'environment' | 'separation' | 'pitch' | 'alignment') => {
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

  const commit = useCallback((next: LyricSegment[]) => {
    setHistory(current => {
      if (JSON.stringify(current.present) === JSON.stringify(next)) return current
      return { present: next, past: [...current.past, current.present].slice(-100), future: [] }
    })
  }, [])

  const undo = useCallback(() => setHistory(current => {
    if (!current.past.length) return current
    const previous = current.past[current.past.length - 1]
    return { present: previous, past: current.past.slice(0, -1), future: [current.present, ...current.future] }
  }), [])
  const redo = useCallback(() => setHistory(current => {
    if (!current.future.length) return current
    return { present: current.future[0], past: [...current.past, current.present], future: current.future.slice(1) }
  }), [])

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const editable = event.target instanceof HTMLElement && !!event.target.closest('input, textarea, [contenteditable="true"]')
      if (event.key === ' ' && !editable && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); void togglePlaybackRef.current(true); return }
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
    setSelectedLineIds(ids => ids.filter(id => segments.some(segment => segment.id === id)))
    setSelectedCharIds(ids => ids.filter(id => activeLine?.chars.some(char => char.id === id)))
  }, [segments, activeLine])

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
      setExternalPythonDraft(status.runtimePreference === 'custom' ? status.path : '')
      setComputeProfileDraft(status.computeProfile)
      setAnalysisProgress(status.runtimeReady ? '分析环境可用' : '分析环境尚未准备完整')
      const readyCount = [status.mediaTools.ffmpeg && status.mediaTools.ffprobe, status.separationModels.some(model => model.ready), status.pitchMethods.some(method => method.ready), status.alignment.forcedAlignment].filter(Boolean).length
      updateWork('environment-check', '分析环境检测', status.runtimeReady && readyCount >= 4 ? 'success' : 'error', `已完成 4 类检查，${readyCount} 类可用`, 1)
      if (!status.runtimeReady && !environmentSetupPromptedRef.current) {
        environmentSetupPromptedRef.current = true
        setRepairEnvironmentOpen(true)
      }
    }).catch(error => {
      setAnalysisProgress('无法检查分析环境')
      updateWork('environment-check', '分析环境检测', 'error', error instanceof Error ? error.message : '无法检查分析环境')
    })
    const removeProgress = window.pitchordDesktop.onAnalysisProgress(progress => {
      setAnalysisProgress(progress.message)
      if (progress.stage === 'base-runtime' || progress.stage === 'runtime') {
        const percent = progress.message.match(/(\d{1,3})%/)?.[1]
        updateWork('environment', '准备分析环境', 'running', progress.message, percent ? Number(percent) / 100 : undefined)
      }
    })
    const removeTaskProgress = window.pitchordDesktop.onTaskProgress(progress => updateWork(progress.id, progress.title, progress.status, progress.message, progress.progress))
    void window.pitchordDesktop.projectDefaults().then(defaults => { setProjectParent(defaults.parent); setNewProjectName(defaults.suggestedName) }).catch(() => undefined)
    return () => { removeProgress(); removeTaskProgress() }
  }, [updateWork])

  useEffect(() => () => { if (mediaUrl) URL.revokeObjectURL(mediaUrl) }, [mediaUrl])
  useEffect(() => () => { void mixerRef.current?.close() }, [])
  useEffect(() => {
    if (mediaName && duration) localStorage.setItem('pitchord.draft.v1', JSON.stringify({ segments, mediaName, duration, pitchPoints, separationResults, activeSeparationResultId, activeVocalResultId, activeAccompanimentResultId, pitchInputResultId, pitchResults, activePitchResultId, alignmentInputResultId, alignmentResults, activeAlignmentResultId }))
  }, [segments, mediaName, duration, pitchPoints, separationResults, activeSeparationResultId, activeVocalResultId, activeAccompanimentResultId, pitchInputResultId, pitchResults, activePitchResultId, alignmentInputResultId, alignmentResults, activeAlignmentResultId])

  useEffect(() => {
    if (!projectDirectory || !window.pitchordDesktop) return
    const timer = window.setTimeout(() => {
      void window.pitchordDesktop?.saveProject(JSON.stringify({ version: 1, mediaName, duration, segments, pitchPoints, separationResults, activeSeparationResultId, activeVocalResultId, activeAccompanimentResultId, pitchInputResultId, pitchResults, activePitchResultId, alignmentInputResultId, alignmentResults, activeAlignmentResultId })).catch(error => setNotice(`工程自动保存失败：${error instanceof Error ? error.message : String(error)}`))
    }, 600)
    return () => window.clearTimeout(timer)
  }, [projectDirectory, mediaName, duration, segments, pitchPoints, separationResults, activeSeparationResultId, activeVocalResultId, activeAccompanimentResultId, pitchInputResultId, pitchResults, activePitchResultId, alignmentInputResultId, alignmentResults, activeAlignmentResultId])

  const loadMedia = async (file: File, persist = true) => {
    if (!file.type.startsWith('audio/') && !file.type.startsWith('video/')) { setNotice('请选择音频或视频文件。'); updateWork('media-import', '导入媒体', 'error', '文件不是可识别的音频或视频'); return }
    updateWork('media-import', '导入媒体', 'running', `正在读取 ${file.name}…`, 0.05)
    if (persist && window.pitchordDesktop && projectDirectory) {
      try {
        await window.pitchordDesktop.storeAsset('media', file.name, await file.arrayBuffer())
        updateWork('media-import', '导入媒体', 'running', '原媒体已复制到工程，正在解析音轨…', 0.35)
      }
      catch (error) { setNotice(`原媒体保存失败：${error instanceof Error ? error.message : String(error)}`); updateWork('media-import', '导入媒体', 'error', error instanceof Error ? error.message : String(error)); return }
    }
    const reconnect = !mediaUrl && file.name === mediaName && segments.length > 0
    const token = ++mediaToken.current
    mediaRef.current?.pause()
    mixerRef.current?.clear()
    mediaFileRef.current = file
    setStemReady({ vocals: false, accompaniment: false })
    setTrackEnabled({ original: true, vocals: false, accompaniment: false })
    auditionRef.current = null
    setMediaUrl(URL.createObjectURL(file))
    setMediaName(file.name)
    setMediaIsVideo(file.type.startsWith('video/'))
    if (!reconnect) setDuration(0)
    setPlayhead(0)
    setGuideLine(null)
    setPlaying(false)
    setPeaks([])
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
      setSelectedLineIds([])
      setSelectedCharIds([])
    }
    setNotice(reconnect ? '已重新关联媒体，歌词草稿保持原样。' : '媒体已载入。可导入 LRC 或粘贴无时间歌词。')
    if (file.type.startsWith('audio/')) {
      try {
        const audioContext = new AudioContext()
        try {
          const audio = await audioContext.decodeAudioData(await file.arrayBuffer())
          if (token === mediaToken.current) { audioBufferRef.current = audio; setAudioReady(true); setPeaks(samplePeaks(audio)); setWaveformStatus(''); updateWork('media-import', '导入媒体', 'success', `已载入 ${file.name} 并生成波形`, 1) }
          return
        } finally { void audioContext.close() }
      } catch { /* Try the container reader below. */ }
    }
    try {
      const { extractAudioBuffer, extractWaveform } = await import('@/lib/waveform')
      try {
        const audio = await extractAudioBuffer(file, () => token === mediaToken.current)
        if (token === mediaToken.current) { audioBufferRef.current = audio; setAudioReady(true); setPeaks(samplePeaks(audio)); setWaveformStatus(''); updateWork('media-import', '导入媒体', 'success', `已载入 ${file.name} 并提取音轨`, 1) }
      } catch {
        const waveform = await extractWaveform(file, () => token === mediaToken.current)
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
    for (const kind of ['vocals', 'accompaniment'] as const) {
      mixerRef.current?.setGain(kind, trackEnabled[kind] && !masterMuted, trackVolume[kind] * masterVolume / 100)
    }
  }, [trackEnabled, trackVolume, masterMuted, masterVolume, stemReady, mediaUrl])

  const toggleTrack = (kind: TrackKind) => {
    if (kind !== 'original' && !stemReady[kind]) return
    setTrackEnabled(current => ({ ...current, [kind]: !current[kind] }))
  }

  const analyzePitch = async () => {
    const buffer = audioBufferRef.current
    if (!vocalTrackReady || !buffer) { setPitchStatus('请先准备纯人声轨。'); setNotice('音高识别只使用纯人声轨。请先运行人声分离，或导入外部人声结果。'); return }
    const algorithmLabel = pitchAlgorithm === 'pyin' ? 'pYIN' : 'TorchCrepe'
    setPitchStatus(`正在使用 ${algorithmLabel} 分析连续音高…`)
    updateWork('pitch', '连续音高识别', 'running', `正在启动 ${algorithmLabel}…`, 0.02)
    await new Promise<void>(resolve => window.setTimeout(resolve, 0))
    try {
      const desktopResult = window.pitchordDesktop?.analyzePitch && projectDirectory
        ? await window.pitchordDesktop.analyzePitch(pitchAlgorithm)
        : null
      const points = desktopResult?.points ?? analyzeAudioBuffer(buffer)
      setPitchPoints(points)
      const result: PitchResult = {
        id: crypto.randomUUID(), algorithm: pitchAlgorithm, label: algorithmLabel,
        createdAt: new Date().toISOString(), path: desktopResult?.path, device: desktopResult?.device, points,
        separationResultId: pitchInputResultId || undefined,
      }
      setPitchResults(current => [result, ...current])
      setActivePitchResultId(result.id)
      const voiced = points.filter(point => point.voiced)
      const deviceSuffix = desktopResult?.device ? ` · ${desktopResult.device}` : ''
      setPitchStatus(`${algorithmLabel} 已分析 ${points.length} 个时间点，其中 ${voiced.length} 个有声点${deviceSuffix}`)
      updateWork('pitch', '连续音高识别', 'success', `${algorithmLabel} 已生成 ${points.length} 个时间点${deviceSuffix}`, 1)
      setNotice('音高轨已生成。它是人工校对用的连续建议，可在句级和字级范围内复核。')
    } catch (error) {
      const message = error instanceof Error ? error.message : '请换用其他媒体格式。'
      if (taskWasCancelled(error)) {
        setPitchStatus('已取消音高识别')
        updateWork('pitch', '连续音高识别', 'cancelled', '已取消运行')
        return
      }
      setPitchStatus(`音高分析失败：${message}`)
      updateWork('pitch', '连续音高识别', 'error', message)
    }
  }
  const requestPitchAnalysis = () => {
    if (!vocalTrackReady) { if (window.pitchordDesktop?.separateVocals) setSeparationPromptOpen(true); else setNotice('请先导入纯人声轨。'); return }
    if (pitchResults.length && !pitchResults.some(result => result.algorithm === pitchAlgorithm)) { setRerunPrompt('pitch'); return }
    void analyzePitch()
  }

  const loadVocalTrack = async (file: File, persist = true, clearPitch = true) => {
    if (!file.type.startsWith('audio/')) { setNotice('人声分析轨需要音频文件。'); return }
    try {
      if (persist && window.pitchordDesktop && projectDirectory) await window.pitchordDesktop.storeAsset('vocals', file.name, await file.arrayBuffer())
      const audio = await getMixer().load('vocals', file)
      audioBufferRef.current = audio
      setAudioReady(true)
      setVocalTrackReady(true)
      setStemReady(current => ({ ...current, vocals: true }))
      setTrackEnabled({ original: false, vocals: true, accompaniment: false })
      if (clearPitch) {
        setPitchPoints([])
        setActivePitchResultId('')
      }
      setPitchStatus(clearPitch ? `已载入人声分析轨：${file.name}` : pitchStatus)
      setNotice('人声分析轨已载入。点击“识别连续音高”开始匹配。')
    } catch { setNotice('无法解码这个人声分析轨，请换用 WAV、MP3 或浏览器支持的音频格式。') }
  }
  const loadAccompanimentTrack = async (file: File, persist = true) => {
    try {
      if (persist && window.pitchordDesktop && projectDirectory) await window.pitchordDesktop.storeAsset('accompaniment', file.name, await file.arrayBuffer())
      await getMixer().load('accompaniment', file)
      setStemReady(current => ({ ...current, accompaniment: true }))
      setNotice('纯伴奏音轨已载入，可与其他音轨单独或组合试听。')
    } catch { setNotice('无法解码伴奏轨，请换用 WAV 或 MP3。') }
  }
  const runSeparation = async () => {
    if (!window.pitchordDesktop?.separateVocals || !mediaFileRef.current) { setSeparationStatus('需要桌面版和已导入媒体'); setNotice('请先导入原始音频或视频。'); return }
    if (!projectDirectory) { pendingMediaRef.current = mediaFileRef.current; setNotice('请先新建工程，分离结果会保存到工程的 analysis 文件夹。'); void showNewProject(); return }
    setSeparationStatus('正在分离…')
    updateWork('separation', '人声分离', 'running', `正在准备 ${selectedSeparationModel?.label || separationModel}…`, 0.01)
    try {
      const source = await mediaFileRef.current.arrayBuffer()
      const result = await window.pitchordDesktop.separateVocals({ name: mediaFileRef.current.name, data: source, model: separationModel })
      if (!result) { setSeparationStatus('已取消'); return }
      // Copy into a plain ArrayBuffer so the browser File constructor accepts
      // the bytes under TypeScript's stricter SharedArrayBuffer definitions.
      const vocalBytes = new Uint8Array(result.vocals.data.byteLength)
      vocalBytes.set(result.vocals.data)
      const accompanimentBytes = new Uint8Array(result.accompaniment.data.byteLength)
      accompanimentBytes.set(result.accompaniment.data)
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
      setTrackEnabled({ original: false, vocals: true, accompaniment: false })
      setSeparationStatus(`${selectedSeparationModel?.label || separationModel} 已生成纯人声和纯伴奏`)
      void window.pitchordDesktop.analysisStatus().then(setAnalysisEnvironment)
    } catch (error) {
      if (taskWasCancelled(error)) {
        setSeparationStatus('已取消')
        updateWork('separation', '人声分离', 'cancelled', '已取消运行')
        return
      }
      setSeparationStatus('运行失败')
      updateWork('separation', '人声分离', 'error', error instanceof Error ? error.message : '请检查分离模型配置。')
      setNotice(`人声分离失败：${error instanceof Error ? error.message : '请检查 Demucs 和模型配置。'}`)
    }
  }

  const requestSeparation = () => {
    if (separationResults.length && !separationResults.some(result => result.modelId === separationModel)) { setRerunPrompt('separation'); return }
    void runSeparation()
  }

  const selectStemResult = async (kind: 'vocals' | 'accompaniment', id: string, useForPitch = false) => {
    const result = separationResults.find(item => item.id === id)
    if (!result || !window.pitchordDesktop?.readAnalysisFile) return
    try {
      const file = kind === 'vocals' ? result.vocals : result.accompaniment
      const data = await window.pitchordDesktop.readAnalysisFile(file)
      const bytes = new Uint8Array(data.byteLength); bytes.set(data)
      if (kind === 'vocals') {
        await loadVocalTrack(new File([bytes.buffer], file.split(/[\\/]/).at(-1) || 'vocals.wav', { type: 'audio/wav' }), false, false)
        setActiveVocalResultId(id)
        if (useForPitch) setPitchInputResultId(id)
        await window.pitchordDesktop.activateVocalResult({ vocals: result.vocals })
      } else {
        await loadAccompanimentTrack(new File([bytes.buffer], file.split(/[\\/]/).at(-1) || 'accompaniment.wav', { type: 'audio/wav' }), false)
        setActiveAccompanimentResultId(id)
      }
      setActiveSeparationResultId(kind === 'vocals' ? id : activeSeparationResultId)
      setSeparationStatus(`已为${kind === 'vocals' ? '纯人声' : '纯伴奏'}选择 ${result.modelLabel}`)
      setNotice(kind === 'vocals' && useForPitch ? '已切换音高识别输入和纯人声试听轨。' : `已切换${kind === 'vocals' ? '纯人声' : '纯伴奏'}试听结果。`)
    } catch (error) { setNotice(`切换分离结果失败：${error instanceof Error ? error.message : String(error)}`) }
  }

  const selectPitchInput = async (id: string) => {
    await selectStemResult('vocals', id, true)
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

  const runLyricAlignment = async () => {
    if (!window.pitchordDesktop?.alignLyrics || !projectDirectory) { setNotice('歌词时间戳匹配需要先创建工程并使用桌面版。'); return }
    if (!segments.length) { setNotice('请先导入或粘贴歌词。'); return }
    const input = separationResults.find(result => result.id === alignmentInputResultId)
    if (!input) { setNotice('请选择歌词匹配所用的纯人声结果。'); return }
    setAlignmentStatus('正在识别人声并匹配歌词…')
    updateWork('alignment', '歌词时间戳匹配', 'running', '正在准备带字词时间戳的语音识别…', 0.01)
    try {
      const result = await window.pitchordDesktop.alignLyrics({ segments, duration, model: alignmentModel, language: alignmentLanguage, vocals: input.vocals })
      const modelLabel = analysisEnvironment?.alignment.models.find(model => model.id === alignmentModel)?.label || alignmentModel
      const saved: AlignmentResult = {
        id: crypto.randomUUID(), modelId: alignmentModel, modelLabel, createdAt: new Date().toISOString(),
        inputResultId: alignmentInputResultId, path: result.path, coverage: result.coverage, lowConfidenceLines: result.lowConfidenceLines, segments: result.segments,
      }
      setAlignmentResults(current => [saved, ...current])
      setActiveAlignmentResultId(saved.id)
      commit(carryPitchOverrides(result.segments, segments))
      setSelectedLineIds([])
      setSelectedCharIds([])
      const uncertain = result.lowConfidenceLines || []
      setAlignmentStatus(`${modelLabel} 已匹配，覆盖率 ${Math.round(result.coverage * 100)}% · ${uncertain.length} 句建议复核`)
      const reviewLines = uncertain.slice(0, 8).map(index => index + 1).join('、')
      setNotice(`歌词时间建议已应用到句级和字级时间块。${uncertain.length ? `第 ${reviewLines}${uncertain.length > 8 ? ' 等' : ''} 句缺少可靠识别，请重点复核。` : '可立即人工复核。'}撤回会恢复应用前的时间。`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (taskWasCancelled(error)) {
        setAlignmentStatus('已取消歌词时间戳匹配')
        updateWork('alignment', '歌词时间戳匹配', 'cancelled', '已取消运行')
        return
      }
      setAlignmentStatus(`匹配失败：${message}`)
      updateWork('alignment', '歌词时间戳匹配', 'error', message)
    }
  }

  const requestLyricAlignment = () => {
    if (alignmentResults.length && !alignmentResults.some(result => result.modelId === alignmentModel)) { setRerunPrompt('alignment'); return }
    void runLyricAlignment()
  }

  const selectAlignmentResult = (id: string) => {
    const result = alignmentResults.find(item => item.id === id)
    if (!result) return
    setActiveAlignmentResultId(id)
    commit(carryPitchOverrides(result.segments, segments))
    setAlignmentStatus(`${result.modelLabel} 的历史匹配结果已应用，覆盖率 ${Math.round(result.coverage * 100)}% · ${result.lowConfidenceLines?.length || 0} 句建议复核`)
    setNotice('已切换并应用歌词时间戳匹配结果，可通过撤回返回切换前的时间。')
  }

  const openEnvironmentSetup = () => {
    setEnvironmentMode(analysisEnvironment?.runtimePreference || 'managed')
    setEnvironmentRootDraft(analysisEnvironment?.root || analysisEnvironment?.defaultRoot || '')
    setExternalPythonDraft(analysisEnvironment?.runtimePreference === 'custom' ? analysisEnvironment.path : '')
    setComputeProfileDraft(analysisEnvironment?.computeProfile || 'auto')
    setRepairEnvironmentOpen(true)
  }

  const installAnalysisRuntime = async () => {
    if (!window.pitchordDesktop?.installAnalysisRuntime) return
    setAnalysisEnvironmentBusy(true)
    setAnalysisProgress('正在启动环境安装…')
    updateWork('environment', '准备分析环境', 'running', '正在检查并补齐媒体、分离和音高组件…')
    try {
      const status = await window.pitchordDesktop.installAnalysisRuntime({ root: environmentRootDraft, computeProfile: computeProfileDraft })
      setAnalysisEnvironment(status)
      setEnvironmentRootDraft(status.root)
      setAnalysisProgress('独立分析环境已准备完成')
      updateWork('environment', '准备分析环境', 'success', '分析环境已准备完成', 1)
      setNotice('Pitchord 分析环境已准备完成。')
    } catch (error) {
      setAnalysisProgress('环境安装未完成')
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
      setRepairEnvironmentOpen(false)
      const complete = status.runtimeReady && status.packages.fasterWhisper
      updateWork('environment-check', '检测现有 Python', complete ? 'success' : 'error', complete ? '现有 Python 环境可以直接使用' : 'Python 已选定，但仍缺少部分分析组件', 1)
      setNotice(complete ? '已切换到现有 Python 环境。' : '已记录 Python 环境；缺失组件会在分析环境面板中显示。')
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

  const importAnalysisModel = async (kind: 'separation' | 'pitch' = 'separation') => {
    if (!window.pitchordDesktop?.importAnalysisModel) return
    try {
      const status = await window.pitchordDesktop.importAnalysisModel(kind)
      if (!status) return
      setAnalysisEnvironment(status)
      setNotice(`${kind === 'separation' ? '人声分离' : '音高'}模型文件已复制到 Pitchord 的 environment/models。原始文件不会被移动或修改。`)
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
  const playNormally = (time: number, message: string) => {
    const media = mediaRef.current
    if (!media) { setNotice('请先重新导入原媒体，才能试听。'); return }
    auditionRef.current = null
    rightEdgeAuditionRef.current = false
    media.currentTime = time
    setPlayhead(time)
    void media.play()
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
    void media.play()
    setNotice(message)
  }
  async function togglePlayback(createGuideOnPause = false) {
    const media = mediaRef.current
    if (!media) return
    if (!editingLocked) {
      auditionRef.current = null
      rightEdgeAuditionRef.current = false
    }
    if (media.paused) { try { await media.play() } catch { setNotice('媒体无法播放，请确认文件格式受支持。') } }
    else {
      const pausedAt = roundTime(media.currentTime)
      media.pause()
      if (createGuideOnPause) {
        setGuideLine(pausedAt)
        setNotice(`已在 ${formatTime(pausedAt)} 设置辅助线。`)
      }
    }
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
      setSelectedLineIds(backup.segments[0] ? [backup.segments[0].id] : [])
      setSelectedCharIds([])
      setView('lines')
      setNotice(`已恢复 ${selected.name}，可以使用撤回返回恢复前。`)
    } catch (error) { setNotice(`恢复歌词失败：${error instanceof Error ? error.message : String(error)}`) }
  }

  const selectLine = (id: string, additive: boolean, range: boolean) => {
    if (editingLocked) return
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
  const addLine = () => addLineAt(playhead)

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
    const next = segments.map(segment => segment.id === activeLine.id ? replaceText(segment, textDraft) : segment)
    commit(next)
    setNotice('歌词文本已更新；新增或改写的字已生成时间建议，请复核。')
  }

  const updateLineTimes = () => {
    if (editingLocked) return
    if (!activeLine) return
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
    if (editingLocked) return
    if (!segments.length || !duration) return
    const next = segments.map(segment => ({ ...segment, start: segment.start + delta, end: segment.end + delta }))
    const overflow = delta > 0 ? Math.max(0, next.at(-1)!.end - duration) : Math.max(0, -next[0].start)
    if (overflow > 0 && !force) { setPendingShift(delta); setShiftConfirmOpen(true); return }
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
    if (remaining > 0) { setNotice('所有歌词已经压缩到最小范围，无法继续整体移动。'); return }
    setLastShiftBefore(segments)
    commit(segments.map(segment => { const moved = result.find(item => item.id === segment.id)!; return retimeSegment(segment, roundTime(moved.start), roundTime(moved.end)) }))
    setNotice(`歌词已整体${delta > 0 ? '后移' : '前移'} ${Math.abs(delta)} 秒。`)
  }
  const restoreShift = () => { if (!lastShiftBefore || editingLocked) return; commit(lastShiftBefore); setLastShiftBefore(null); setNotice('已还原上一次整体移动。') }

  const openContextMenu = (event: ReactMouseEvent | ReactPointerEvent, id?: string, time?: number) => {
    event.preventDefault()
    event.stopPropagation()
    if (editingLocked) return
    if (id && !selectedLineIds.includes(id)) setSelectedLineIds([id])
    setContextMenu({ x: event.clientX, y: event.clientY, id, time })
  }
  const contextAction = (action: 'add' | 'delete' | 'merge' | 'split') => {
    if (editingLocked) { setContextMenu(null); return }
    const item = contextMenu
    setContextMenu(null)
    if (item?.time !== undefined && action === 'add') { seek(item.time); addLineAt(item.time); return }
    if (item?.id && action === 'delete') { commit(segments.filter(segment => segment.id !== item.id)); setSelectedLineIds([]); setSelectedCharIds([]); if (view === 'chars') setView('lines'); setNotice('已删除选中的歌词标注。'); return }
    if (action === 'merge') mergeSelected()
    if (action === 'split') openSplit()
  }

  const retimeLines = (updates: { id: string; start: number; end: number }[]) => {
    if (!updates.length) return
    const updateMap = new Map(updates.map(update => [update.id, update]))
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
    if (start < lower - 0.001 || end > upper + 0.001 || end - start < MIN_SPAN) return
    commit(segments.map(segment => segment.id === activeLine.id ? {
      ...segment, chars: segment.chars.map(char => char.id === id ? { ...char, start: roundTime(start), end: roundTime(end), origin: 'manual' as const } : char),
    } : segment))
  }
  const retimeChars = (updates: TimelinePreview[]) => {
    if (!activeLine || !updates.length) return
    const updateMap = new Map(updates.map(update => [update.id, update]))
    commit(segments.map(segment => segment.id === activeLine.id ? {
      ...segment, chars: segment.chars.map(char => { const update = updateMap.get(char.id); return update ? { ...char, start: roundTime(update.start), end: roundTime(update.end), origin: 'manual' as const } : char }),
    } : segment))
  }

  const exportLrc = async () => {
    if (!segments.length) return
    const lrc = segments.map(segment => `[${formatTime(segment.start).slice(0, -1)}]${segment.text}`).join('\n') + '\n'
    try {
      if (await download(`${mediaName.replace(/\.[^.]+$/, '') || 'pitchord'}.lrc`, lrc, 'text/plain;charset=utf-8')) setNotice('已导出句级 LRC。')
    } catch { setNotice('保存失败，请检查目标目录是否可写。') }
  }
  const exportWordSubtitles = async (format: 'ass' | 'json') => {
    if (!segments.some(segment => segment.chars.length)) return
    const base = mediaName.replace(/\.[^.]+$/, '') || 'pitchord'
    try {
      if (format === 'ass') {
        const ass = generatePitchAss(segments, pitchPoints, subtitleStyle)
        if (await download(`${base}.word-timed.ass`, ass, 'text/plain;charset=utf-8')) setNotice('已导出字级 ASS 字幕，包含逐字时间、实时音高、色带和强调点。')
      } else {
        const json = JSON.stringify({ version: 1, mediaName, duration, subtitles: wordTimedSubtitles(segments, pitchPoints) }, null, 2)
        if (await download(`${base}.word-timed.json`, json, 'application/json;charset=utf-8')) setNotice('已导出通用字级时间数据。')
      }
    } catch { setNotice('字级字幕保存失败，请检查目标目录是否可写。') }
  }
  const burnSubtitleVideo = async () => {
    if (!window.pitchordDesktop?.burnSubtitles) { setNotice('嵌入视频需要桌面版。'); return }
    if (!mediaIsVideo) { setNotice('当前导入的是音频；请选择视频工程后再嵌入字幕。'); return }
    updateWork('subtitle-render', '嵌入视频字幕', 'running', '正在准备字级字幕…', 0.01)
    try {
      const result = await window.pitchordDesktop.burnSubtitles({ ass: generatePitchAss(segments, pitchPoints, subtitleStyle), outputName: `${mediaName.replace(/\.[^.]+$/, '') || 'pitchord'}-subtitled` })
      setNotice(`带字幕视频已生成：${result.video}`)
      setSubtitleOpen(false)
    } catch (error) {
      updateWork('subtitle-render', '嵌入视频字幕', 'error', error instanceof Error ? error.message : String(error))
      setNotice(`嵌入字幕失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const exportProject = async () => {
    try {
      const content = JSON.stringify({ version: 1, mediaName, duration, segments, pitchPoints, separationResults, activeSeparationResultId, activeVocalResultId, activeAccompanimentResultId, pitchInputResultId, pitchResults, activePitchResultId, alignmentInputResultId, alignmentResults, activeAlignmentResultId }, null, 2)
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
      if (!project.segments.every(segment => typeof segment.id === 'string' && typeof segment.text === 'string' && Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.start >= 0 && segment.end <= project.duration && segment.end > segment.start && Array.isArray(segment.chars) && segment.chars.every(char => typeof char.id === 'string' && typeof char.text === 'string' && Number.isFinite(char.start) && Number.isFinite(char.end) && char.start >= segment.start && char.end <= segment.end && char.end >= char.start && Number.isInteger(char.startOffset) && Number.isInteger(char.endOffset) && (char.pitchOverride === undefined || validPitchAnnotation(char.pitchOverride))))) throw new Error('invalid segments')
      const importedPitch = Array.isArray(project.pitchPoints) && project.pitchPoints.every(point => typeof point.time === 'number' && typeof point.hz === 'number' && typeof point.confidence === 'number' && typeof point.rms === 'number' && typeof point.voiced === 'boolean') ? project.pitchPoints : []
      const importedSeparationResults = Array.isArray(project.separationResults) ? project.separationResults : []
      const importedPitchResults = Array.isArray(project.pitchResults) ? project.pitchResults : []
      const importedAlignmentResults = Array.isArray(project.alignmentResults) ? project.alignmentResults : []
      if (!preserveMedia) {
        mediaRef.current?.pause()
        mediaToken.current++
        setMediaUrl('')
        mixerRef.current?.clear()
        setTrackEnabled({ original: true, vocals: false, accompaniment: false })
        setStemReady({ vocals: false, accompaniment: false })
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
  const importProject = async (file: File) => { await importProjectContent(await file.text()) }
  const resetProjectState = () => {
    mediaRef.current?.pause()
    mediaToken.current++
    auditionRef.current = null
    setMediaUrl('')
    mixerRef.current?.clear()
    setTrackEnabled({ original: true, vocals: false, accompaniment: false })
    setStemReady({ vocals: false, accompaniment: false })
    mediaFileRef.current = null
    setMediaName('')
    setDuration(0)
    setPeaks([])
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
    setPitchStatus('尚未分析音高')
    setSeparationStatus('未运行')
    audioBufferRef.current = null
    setAudioReady(false)
    setVocalTrackReady(false)
    setWaveformStatus('导入音频或视频后显示波形')
    setHistory({ present: [], past: [], future: [] })
    setSelectedLineIds([])
    setSelectedCharIds([])
    setPlayhead(0)
    setGuideLine(null)
    setPlaying(false)
    setView('lines')
    localStorage.removeItem('pitchord.draft.v1')
    setProjectDirectory('')
    setProjectName('')
  }

  const showNewProject = async () => {
    if (window.pitchordDesktop) {
      try { const defaults = await window.pitchordDesktop.projectDefaults(); setProjectParent(defaults.parent); setNewProjectName(defaults.suggestedName) } catch { /* retain current input */ }
    }
    setNewProjectOpen(true)
  }
  const createProject = async () => {
    if (!window.pitchordDesktop) { resetProjectState(); setNewProjectOpen(false); setNotice('已新建空白项目。'); return }
    try {
      const project = await window.pitchordDesktop.createProject(newProjectName.trim(), projectParent)
      const pending = pendingMediaRef.current
      pendingMediaRef.current = null
      resetProjectState()
      setProjectDirectory(project.directory)
      setProjectName(project.name)
      setNewProjectOpen(false)
      setNotice(`工程已创建：${project.directory}`)
      if (pending) {
        await window.pitchordDesktop.storeAsset('media', pending.name, await pending.arrayBuffer())
        await loadMedia(pending, false)
      }
    } catch (error) { setNotice(`新建工程失败：${error instanceof Error ? error.message : String(error)}`) }
  }
  const openProject = async () => {
    if (!window.pitchordDesktop) { projectInputRef.current?.click(); return }
    try {
      const result = await window.pitchordDesktop.openProject()
      if (!result) return
      resetProjectState()
      const media = await window.pitchordDesktop.readProjectAsset('media')
      if (media) await loadMedia(new File([new Uint8Array(media.data).buffer], media.name, { type: /\.(mp4|mov|mkv|webm)$/i.test(media.name) ? 'video/mp4' : 'audio/wav' }), false)
      const vocals = await window.pitchordDesktop.readProjectAsset('vocals')
      const accompaniment = await window.pitchordDesktop.readProjectAsset('accompaniment')
      if (vocals) await loadVocalTrack(new File([new Uint8Array(vocals.data).buffer], vocals.name, { type: 'audio/wav' }), false)
      if (accompaniment) await loadAccompanimentTrack(new File([new Uint8Array(accompaniment.data).buffer], accompaniment.name, { type: 'audio/wav' }), false)
      if (media) setTrackEnabled({ original: !vocals, vocals: !!vocals, accompaniment: false })
      if (await importProjectContent(result.content, !!media)) {
        setProjectDirectory(result.directory)
        setProjectName(result.name)
        if (vocals && accompaniment) setSeparationStatus('已载入纯人声和纯伴奏')
      }
    } catch (error) { setNotice(`打开工程失败：${error instanceof Error ? error.message : String(error)}`) }
  }

  const activateLine = (id: string, beginAdjust = true) => {
    const segment = segments.find(item => item.id === id)
    if (!segment || (editingLocked && rangeDraft?.id !== id)) return
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
      void media.play()
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
    getMixer().attachMedia(media)
  }
  const onMediaMetadata = (media: HTMLMediaElement) => {
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
  const activePitchNotation = activePitchAnnotation ? pitchNotation(activePitchAnnotation) : ''
  const pitchNotationDraft = pitchNotationEdit && pitchNotationEdit.id === activeChar?.id && pitchNotationEdit.base === activePitchNotation ? pitchNotationEdit.value : activePitchNotation
  const savePitchNotation = () => {
    if (!activeChar || editingLocked) return
    if (pitchNotationDraft.trim().replaceAll('♯', '#').toUpperCase() === activePitchNotation.toUpperCase()) { setPitchNotationEdit(null); return }
    const parsed = parsePitchNotation(pitchNotationDraft, activePitchAnnotation ?? undefined)
    if (!parsed) { setNotice('音高格式无效。可输入 E4、E4-F4-E4、E4~，或用 — 表示无音高。'); setPitchNotationEdit(null); return }
    commit(segments.map(segment => segment.id === activeLine?.id ? { ...segment, chars: segment.chars.map(char => char.id === activeChar.id ? { ...char, pitchOverride: parsed } : char) } : segment))
    setPitchNotationEdit(null)
    setNotice(`已保存「${activeChar.text}」的字幕音高；可撤回。`)
  }
  const resetPitchOverride = () => {
    if (!activeChar || editingLocked) return
    commit(segments.map(segment => segment.id === activeLine?.id ? { ...segment, chars: segment.chars.map(char => char.id === activeChar.id ? { ...char, pitchOverride: undefined } : char) } : segment))
    setPitchNotationEdit(null)
    setNotice(`「${activeChar.text}」已恢复模型音高建议。`)
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
    commit(segments.map(segment => segment.id === activeLine?.id ? { ...segment, chars: segment.chars.map(char => char.id === activeChar.id ? { ...char, pitchOverride: updated } : char) } : segment))
    setNotice(`已调整「${activeChar.text}」的换音时间；可撤回。`)
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
    const previews = resolveRangeConflict(activeLine.chars, range, { start: activeLine.start, end: activeLine.end }, strategy)
    if (!previews) return false
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
    setSelectedLineIds([next.id]); setSelectedCharIds([]); seek(next.start)
  }
  const changeView = (next: View) => {
    if (editingLocked || next === view || (next === 'chars' && !activeLine)) return
    setView(next)
    setSelectedCharIds([])
    if (activeLine) seek(activeLine.start)
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

  return <TooltipProvider delayDuration={250}>
    <div className="min-h-screen bg-background text-foreground">
      <nav className="flex h-9 items-center gap-1 border-b border-border bg-card px-2" aria-label="应用菜单">
        <DropdownMenu modal={false}><DropdownMenuTrigger asChild><Button variant="ghost" size="sm" className="h-7 px-3 font-normal">文件</Button></DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuLabel>工程</DropdownMenuLabel><DropdownMenuItem onSelect={() => void showNewProject()}><FilePlus2 />新建项目</DropdownMenuItem><DropdownMenuItem onSelect={() => void openProject()}><FolderOpen />打开项目</DropdownMenuItem><DropdownMenuItem onSelect={() => void exportProject()} disabled={!projectDirectory && !segments.length}><Save />保存项目</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => mediaInputRef.current?.click()}><Upload />导入媒体</DropdownMenuItem><DropdownMenuItem onSelect={() => lyricInputRef.current?.click()} disabled={!mediaUrl}><FileText />导入 LRC</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => void exportLrc()} disabled={!segments.length}><Download />导出句级 LRC</DropdownMenuItem><DropdownMenuItem onSelect={() => window.setTimeout(() => setSubtitleOpen(true), 0)} disabled={!segments.some(segment => segment.chars.length)}><Video />字级字幕与视频</DropdownMenuItem><DropdownMenuSeparator />{projectDirectory && <DropdownMenuItem onSelect={() => void window.pitchordDesktop?.openProjectFolder()}><FolderOpen />打开工程文件夹</DropdownMenuItem>}</DropdownMenuContent></DropdownMenu>
        <DropdownMenu modal={false}><DropdownMenuTrigger asChild><Button variant="ghost" size="sm" className="h-7 px-3 font-normal">设置</Button></DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuItem onSelect={() => window.setTimeout(() => setModelManagerOpen(true), 0)}><Settings2 />模型管理</DropdownMenuItem><DropdownMenuItem onSelect={() => window.setTimeout(openEnvironmentSetup, 0)}><Activity />分析环境</DropdownMenuItem><DropdownMenuItem onSelect={() => window.setTimeout(() => void openStorageManager(), 0)}><HardDrive />存储与环境</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
      </nav>
      <header className="flex min-h-16 flex-wrap items-center justify-between gap-4 border-b border-border bg-card px-6 py-3">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary/15 text-primary"><AudioLines className="size-5" /></div>
          <div><h1 className="text-base font-semibold leading-5">Pitchord</h1><p className="text-xs text-muted-foreground">歌词时间编辑器</p></div>
          <Badge variant="secondary" className="ml-2 max-w-52 truncate">{projectName || '未建工程'}</Badge>
          <Badge variant="outline" className="max-w-52 truncate">{mediaName || '未导入媒体'}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input ref={mediaInputRef} type="file" accept="audio/*,video/*" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) { if (window.pitchordDesktop && !projectDirectory) { pendingMediaRef.current = file; void showNewProject() } else void loadMedia(file) } event.target.value = '' }} />
          <input ref={vocalInputRef} type="file" accept="audio/*" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) void loadVocalTrack(file); event.target.value = '' }} />
          <input ref={lyricInputRef} type="file" accept=".lrc,.txt,text/plain" className="hidden" onChange={async event => { const file = event.target.files?.[0]; if (file) await importLyrics(await file.text(), file.name); event.target.value = '' }} />
          <input ref={projectInputRef} type="file" accept=".pitchord.json,.json,application/json" className="hidden" onChange={async event => { const file = event.target.files?.[0]; if (file) await importProject(file); event.target.value = '' }} />
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
          <Button variant="secondary" size="sm" onClick={() => setSubtitleOpen(true)} disabled={!segments.some(segment => segment.chars.length)}><Video />字级字幕与视频</Button>
        </div>
      </header>

      <main className="mx-auto max-w-[1800px] p-4 md:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
          <div />
          <div className="flex items-center gap-1">
            <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" onClick={undo} disabled={!history.past.length || editingLocked} aria-label="撤回"><Undo2 /></Button></TooltipTrigger><TooltipContent>撤回 Ctrl+Z</TooltipContent></Tooltip>
            <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" onClick={redo} disabled={!history.future.length || editingLocked} aria-label="重做"><Redo2 /></Button></TooltipTrigger><TooltipContent>重做 Ctrl+Shift+Z</TooltipContent></Tooltip>
          </div>
        </div>

        <div className="space-y-4">
            <section className="rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <Button size="icon" onClick={() => void togglePlayback()} disabled={!mediaUrl} aria-label={playing ? '暂停' : '播放'}>{playing ? <Pause /> : <Play />}</Button>
                  <div className="font-mono text-lg tabular-nums">{formatTime(playhead)} <span className="text-sm text-muted-foreground">/ {formatTime(duration)}</span></div>
                </div>
              </div>
              {mediaUrl && <div className="mt-4 overflow-hidden rounded-lg border border-border bg-background">
                {mediaIsVideo ? <video key={mediaUrl} ref={bindMedia} src={mediaUrl} className="max-h-64 w-full bg-black object-contain" onLoadedMetadata={event => onMediaMetadata(event.currentTarget)} onTimeUpdate={event => onMediaTimeUpdate(event.currentTarget)} onPlay={event => onMediaPlay(event.currentTarget)} onPause={onMediaPause} onSeeking={event => onMediaSeeking(event.currentTarget)} onSeeked={event => onMediaSeeked(event.currentTarget)} onRateChange={event => mixerRef.current?.rateChanged(event.currentTarget)} onVolumeChange={event => onMediaVolumeChange(event.currentTarget)} onEnded={onMediaEnded} controls /> : <audio key={mediaUrl} ref={bindMedia} src={mediaUrl} className="w-full" onLoadedMetadata={event => onMediaMetadata(event.currentTarget)} onTimeUpdate={event => onMediaTimeUpdate(event.currentTarget)} onPlay={event => onMediaPlay(event.currentTarget)} onPause={onMediaPause} onSeeking={event => onMediaSeeking(event.currentTarget)} onSeeked={event => onMediaSeeked(event.currentTarget)} onRateChange={event => mixerRef.current?.rateChanged(event.currentTarget)} onVolumeChange={event => onMediaVolumeChange(event.currentTarget)} onEnded={onMediaEnded} controls />}
                <p className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground"><span>播放器的静音与音量是全部已开启音轨的总开关和总响度；下方滑杆调整各音轨的相对响度。</span><span className="font-mono text-foreground" data-master-volume>{masterMuted ? '总音频：静音' : `总音量：${masterVolume}%`}</span></p>
              </div>}
              {!mediaUrl && <div className="mt-4 flex h-28 items-center justify-center gap-3 rounded-lg border border-dashed border-border text-muted-foreground"><FileAudio2 className="size-5" /><span>导入音频或视频以开始</span><Video className="size-5" /></div>}
            </section>

            <section className="rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div><h2 className="font-semibold">音频处理与分析</h2><p className="mt-1 text-xs text-muted-foreground">先处理人声，再从纯人声轨识别连续音高，提升后续歌词匹配的稳定性。</p></div>
                <Badge variant={pitchPoints.length ? 'secondary' : 'outline'}>{pitchStatus}</Badge>
              </div>
              {window.pitchordDesktop && <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3" data-analysis-environment>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-2"><Settings2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><div><p className="text-sm font-medium">分析环境</p><p className="mt-1 text-xs text-muted-foreground">启动时自动检查媒体处理、人声分离、音高识别和歌词对齐能力。</p></div></div>
                  <Badge variant={analysisEnvironment?.runtimeReady ? 'secondary' : 'outline'}>{analysisEnvironment?.runtimeReady ? <CheckCircle2 className="mr-1 size-3" /> : <AlertCircle className="mr-1 size-3" />}{analysisEnvironment?.runtimeReady ? '环境可用' : '需要修复'}</Badge>
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
                  <Button size="sm" variant="secondary" onClick={openEnvironmentSetup} disabled={analysisEnvironmentBusy}>{analysisEnvironment?.runtimeReady ? '检查或更换环境' : '准备分析环境'}</Button>
                  <Button size="sm" variant="outline" onClick={() => void window.pitchordDesktop?.analysisStatus().then(status => { setAnalysisEnvironment(status); setAnalysisProgress('四类关键能力已重新检测'); updateWork('environment-check', '分析环境检测', 'success', '四类关键能力已重新检测', 1) })} disabled={analysisEnvironmentBusy}>重新检测</Button>
                  <Button size="sm" variant="ghost" onClick={() => void window.pitchordDesktop?.openAnalysisFolder()}>打开环境</Button>
                  <Button size="sm" variant="ghost" onClick={() => void openStorageManager()} disabled={analysisEnvironmentBusy}><HardDrive />管理存储</Button>
                  <Button size="sm" variant="ghost" onClick={() => setModelManagerOpen(true)} disabled={analysisEnvironmentBusy}><Settings2 />模型管理</Button>
                </div>
              </div>}
              <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">1. 人声分离</span><Select value={separationModel} onValueChange={setSeparationModel}><SelectTrigger className="w-52"><SelectValue placeholder="选择已安装模型" /></SelectTrigger><SelectContent>{analysisEnvironment?.separationModels.filter(model => model.ready && model.runnable !== false).map(model => <SelectItem key={model.id} value={model.id}>{model.label}</SelectItem>)}</SelectContent></Select><Button size="sm" variant="secondary" onClick={requestSeparation} disabled={!mediaUrl || !selectedSeparationModel?.ready || selectedSeparationModel?.runnable === false || workItems.some(item => item.id === 'separation' && item.status === 'running') || analysisEnvironmentBusy || (window.pitchordDesktop && !analysisEnvironment?.runtimeReady)}>运行人声分离</Button>{workItems.some(item => item.id === 'separation' && item.status === 'running') && <Button size="sm" variant="destructive" onClick={() => void cancelAnalysisTask('separation')}><Square />取消运行</Button>}<Button size="sm" variant="outline" onClick={() => setModelManagerOpen(true)}>模型管理</Button><Button size="sm" variant="ghost" onClick={() => vocalInputRef.current?.click()} disabled={!mediaUrl}>导入外部人声结果</Button><span className="text-xs text-muted-foreground">{separationStatus}</span></div><p className="mt-2 text-xs text-muted-foreground">{selectedSeparationModel?.description || '请先在模型管理中准备或导入模型。'}</p>{separationResults.length > 0 && <p className="mt-2 text-xs text-muted-foreground">已保留 {separationResults.length} 组分离结果。纯人声与纯伴奏可在下方分别选择，不要求来自同一个模型。</p>}{projectDirectory && <p className="mt-2 break-all text-xs text-muted-foreground">工程：{projectDirectory}</p>}</div>
              <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3"><p className="mb-3 text-sm font-medium">试听音轨 <span className="text-xs font-normal text-muted-foreground">可多选叠加，切换时保持同一播放位置</span></p><div className="grid gap-3 sm:grid-cols-3">{(['original', 'vocals', 'accompaniment'] as const).map(kind => {
                const available = kind === 'original' ? !!mediaUrl : !!stemReady[kind]
                const label = kind === 'original' ? '原音频' : kind === 'vocals' ? '纯人声' : '纯伴奏'
                const selectedResultId = kind === 'vocals' ? activeVocalResultId : activeAccompanimentResultId
                return <div key={kind} className="rounded-md border border-border bg-background p-2"><Button size="sm" className="w-full" variant={trackEnabled[kind] ? 'secondary' : 'outline'} aria-pressed={trackEnabled[kind]} onClick={() => toggleTrack(kind)} disabled={!available}>{label} · {trackEnabled[kind] ? '开' : '关'}</Button>{kind !== 'original' && separationResults.length > 0 && <Select value={selectedResultId} onValueChange={value => void selectStemResult(kind, value)}><SelectTrigger className="mt-2 h-8 w-full text-xs"><SelectValue placeholder={`选择${label}结果`} /></SelectTrigger><SelectContent>{separationResults.map(result => <SelectItem key={`${kind}-${result.id}`} value={result.id}>{result.modelLabel} · {new Date(result.createdAt).toLocaleTimeString()}</SelectItem>)}</SelectContent></Select>}<div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><Slider min={0} max={kind === 'original' ? 100 : 200} step={5} value={[trackVolume[kind]]} onValueChange={values => setTrackVolume(current => ({ ...current, [kind]: values[0] }))} disabled={!available} aria-label={`${label}音量`} /><span className="w-9 text-right tabular-nums">{trackVolume[kind]}%</span></div></div>
              })}</div></div>
              <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">2. 音高识别</span><Select value={pitchAlgorithm} onValueChange={value => setPitchAlgorithm(value as PitchAlgorithm)}><SelectTrigger className="w-48"><SelectValue /></SelectTrigger><SelectContent>{analysisEnvironment?.pitchMethods.map(method => <SelectItem key={method.id} value={method.id} disabled={!method.ready || method.runnable === false || !['pyin', 'torchcrepe'].includes(method.id)}>{method.label}{method.ready && method.runnable !== false ? ' · 已就绪' : ' · 尚未可用'}</SelectItem>)}</SelectContent></Select>{separationResults.length > 0 && <Select value={pitchInputResultId} onValueChange={value => void selectPitchInput(value)}><SelectTrigger className="w-64"><SelectValue placeholder="选择音高识别所用纯人声" /></SelectTrigger><SelectContent>{separationResults.map(result => <SelectItem key={`pitch-input-${result.id}`} value={result.id}>输入：{result.modelLabel} · {new Date(result.createdAt).toLocaleTimeString()}</SelectItem>)}</SelectContent></Select>}<Button size="sm" variant="secondary" onClick={requestPitchAnalysis} disabled={!mediaUrl || !vocalTrackReady || !audioReady || workItems.some(item => item.id === 'pitch' && item.status === 'running')} >识别连续音高</Button>{workItems.some(item => item.id === 'pitch' && item.status === 'running') && <Button size="sm" variant="destructive" onClick={() => void cancelAnalysisTask('pitch')}><Square />取消运行</Button>}<Button size="sm" variant="outline" onClick={() => setModelManagerOpen(true)}>模型管理</Button></div><p className="mt-2 text-xs text-muted-foreground">音高识别只读取上面明确选择的纯人声结果。{analysisEnvironment?.pitchMethods.find(method => method.id === pitchAlgorithm)?.description || '浏览器预览使用基础自相关分析。'} {pitchAlgorithm === 'torchcrepe' ? `当前将使用${analysisEnvironment?.compute.cudaAvailable ? ` GPU：${analysisEnvironment.compute.cudaDeviceName}` : ' CPU'}` : 'pYIN 使用 CPU。'}</p>{pitchResults.length > 0 && <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3"><span className="text-xs text-muted-foreground">当前音高结果</span><Select value={activePitchResultId} onValueChange={selectPitchResult}><SelectTrigger className="w-64"><SelectValue /></SelectTrigger><SelectContent>{pitchResults.map(result => <SelectItem key={result.id} value={result.id}>{result.label}{result.device ? ` · ${result.device}` : ''} · {new Date(result.createdAt).toLocaleString()}</SelectItem>)}</SelectContent></Select><span className="text-xs text-muted-foreground">字级匹配和字幕实时使用所选结果</span></div>}</div>
              <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">3. 歌词时间戳匹配</span><Select value={alignmentModel} onValueChange={setAlignmentModel}><SelectTrigger className="w-48"><SelectValue /></SelectTrigger><SelectContent>{analysisEnvironment?.alignment.models.map(model => <SelectItem key={model.id} value={model.id} disabled={!model.ready}>{model.label}{model.ready ? ' · 已就绪' : ' · 未准备'}</SelectItem>)}</SelectContent></Select><Select value={alignmentLanguage} onValueChange={setAlignmentLanguage}><SelectTrigger className="w-32"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="zh">中文</SelectItem><SelectItem value="en">英语</SelectItem><SelectItem value="ja">日语</SelectItem><SelectItem value="ko">韩语</SelectItem></SelectContent></Select>{separationResults.length > 0 && <Select value={alignmentInputResultId} onValueChange={value => void selectAlignmentInput(value)}><SelectTrigger className="w-64"><SelectValue placeholder="选择歌词匹配所用纯人声" /></SelectTrigger><SelectContent>{separationResults.map(result => <SelectItem key={`alignment-input-${result.id}`} value={result.id}>输入：{result.modelLabel} · {new Date(result.createdAt).toLocaleTimeString()}</SelectItem>)}</SelectContent></Select>}<Button size="sm" variant="secondary" onClick={requestLyricAlignment} disabled={!segments.length || !alignmentInputResultId || !analysisEnvironment?.alignment.models.find(model => model.id === alignmentModel)?.ready || workItems.some(item => item.id === 'alignment' && item.status === 'running')}>自动匹配歌词时间</Button>{workItems.some(item => item.id === 'alignment' && item.status === 'running') && <Button size="sm" variant="destructive" onClick={() => void cancelAnalysisTask('alignment')}><Square />取消运行</Button>}<Button size="sm" variant="outline" onClick={() => setModelManagerOpen(true)}>模型管理</Button></div><p className="mt-2 text-xs text-muted-foreground">输入歌词作为最终文本；模型只从所选纯人声中取得字词时间戳，再以单调文本匹配生成句级和字级时间建议。结果应用后仍可撤回和人工调整。当前使用{analysisEnvironment?.compute.alignmentCudaAvailable ? ' GPU' : ' CPU'}。</p><p className="mt-2 text-xs text-muted-foreground">{alignmentStatus}</p>{alignmentResults.length > 0 && <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3"><span className="text-xs text-muted-foreground">已保留结果</span><Select value={activeAlignmentResultId} onValueChange={selectAlignmentResult}><SelectTrigger className="w-72"><SelectValue /></SelectTrigger><SelectContent>{alignmentResults.map(result => <SelectItem key={result.id} value={result.id}>{result.modelLabel} · {Math.round(result.coverage * 100)}% · {new Date(result.createdAt).toLocaleString()}</SelectItem>)}</SelectContent></Select><span className="text-xs text-muted-foreground">选择后应用该版本，可撤回</span></div>}</div>
              {pitchPoints.length > 0 && <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3"><span>有声比例：{Math.round(voicedPitchPoints.length / pitchPoints.length * 100)}%</span><span>音高范围：{voicedPitchPoints.length ? `${Math.round(Math.min(...voicedPitchPoints.map(point => point.hz)))}–${Math.round(Math.max(...voicedPitchPoints.map(point => point.hz)))} Hz` : '无有声帧'}</span><span>当前字匹配：{Object.keys(pitchMatches).length} 个</span></div>}
            </section>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0">

            <section className="rounded-xl border border-border bg-card p-4">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3"><Tabs value={view} onValueChange={value => changeView(value as View)}><TabsList><TabsTrigger value="lines" className="transition-colors duration-100" disabled={editingLocked}>句级编辑</TabsTrigger><TabsTrigger value="chars" className="transition-colors duration-100" disabled={!activeLine || editingLocked}>单字编辑</TabsTrigger></TabsList></Tabs><div><h2 className="font-semibold">{view === 'lines' ? '句级时间轴' : '单字时间轴'}</h2><p className="mt-1 text-xs text-muted-foreground">单击只选中；未选中时双击定位试听、三击进入范围调整；已选中时双击进入调整。</p></div></div>
                {view === 'lines' ? <div className="flex flex-wrap items-center justify-end gap-2">
                  <div className="mr-2 flex w-48 items-center gap-2 text-xs text-muted-foreground"><span>缩放</span><Slider min={40} max={240} step={5} value={[zoom]} onValueChange={values => setZoom(values[0])} disabled={!duration} /><span className="w-7 text-right">{zoom}</span></div>
                  <Button size="sm" variant="secondary" onClick={addLine} disabled={!mediaUrl || editingLocked}><Plus />添加句</Button>
                  <Button size="sm" variant="secondary" onClick={mergeSelected} disabled={!mergeIndexes || editingLocked}><Merge />合并</Button>
                  <Button size="sm" variant="secondary" onClick={openSplit} disabled={!activeLine || !splitBoundaries.length || editingLocked}><Scissors />分割</Button>
                  <Button size="sm" variant="destructive" onClick={deleteSelected} disabled={!selectedLineIds.length || editingLocked}><Trash2 />删除</Button>
                </div> : <div className="flex items-center gap-1"><Button size="icon" variant="ghost" onClick={() => goLine(-1)} disabled={lineIndex <= 0 || editingLocked} aria-label="上一句"><ChevronLeft /></Button><span className="min-w-20 text-center text-xs text-muted-foreground">{lineIndex >= 0 ? `${lineIndex + 1} / ${segments.length}` : '未选中'}</span><Button size="icon" variant="ghost" onClick={() => goLine(1)} disabled={lineIndex < 0 || lineIndex >= segments.length - 1 || editingLocked} aria-label="下一句"><ChevronRight /></Button></div>}
              </div>
              <Timeline mode={view} segments={segments} activeSegment={activeLine} selectedIds={view === 'lines' ? selectedLineIds : selectedCharIds} duration={duration} peaks={peaks} pitchPoints={pitchPoints} zoom={zoom} playhead={playhead} centerRequest={centerRequest} centerTargetId={centerTargetId} seekCenterRequest={seekCenterRequest} guideLine={guideLine} waveformStatus={waveformStatus} onSeekAndPlay={seekAndPlay} onSelect={(id, additive, range) => view === 'lines' ? selectLine(id, additive, range) : selectChar(id, additive, range)} onActivateLine={activateLine} onActivateChar={activateChar} onRetimeLines={retimeLines} onRetimeChar={retimeChar} onRetimeChars={retimeChars} rangeAdjusting={view === 'lines' ? rangeAdjusting : charRangeAdjusting} rangeDraft={view === 'lines' ? rangeDraft : charRangeDraft} onRangePreview={view === 'lines' ? setRangeDraft : setCharRangeDraft} onRangeEdgeChange={view === 'lines' ? setRangeEdge : setCharRangeEdge} onBeginRangeAdjust={() => view === 'lines' ? beginRangeAdjust() : beginCharRangeAdjust()} onSaveRangeAdjust={() => view === 'lines' ? finishRangeAdjust() : finishCharRangeAdjust()} onCancelRangeAdjust={() => view === 'lines' ? cancelRangeAdjust() : cancelCharRangeAdjust()} onContextMenu={view === 'lines' ? (event, time, id) => openContextMenu(event, id, time) : undefined} />
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>{view === 'lines' ? '选择多句' : '选择多个字'}：Ctrl/⌘ 点击；连续选择：Shift 点击</span><span>矩形所指向的音频始终来自原媒体</span></div>
            </section>

            {activeLine && <section className="rounded-xl border border-border bg-card p-4">
              <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">{view === 'lines' ? '句子编辑' : '单字编辑'}</h2>{activeLine && <Badge variant="secondary">第 {lineIndex + 1} 句</Badge>}</div>
              <div className="space-y-4">
                <div><p className="mb-2 text-xs text-muted-foreground">整句内容</p><Textarea value={textDraft} onChange={event => setTextDraft(event.target.value)} onBlur={updateLineText} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) event.currentTarget.blur() }} rows={3} aria-label="歌词文本" disabled={editingLocked} /><p className="mt-1 text-xs text-muted-foreground">失去焦点时保存。新增或改写的字需要复核时间。</p></div>
                <div className="grid grid-cols-2 gap-3"><label className="space-y-2 text-xs text-muted-foreground">开始时间<Input value={startDraft} onChange={event => setStartDraft(event.target.value)} onBlur={updateLineTimes} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} className="font-mono text-foreground" disabled={editingLocked} /></label><label className="space-y-2 text-xs text-muted-foreground">结束时间<Input value={endDraft} onChange={event => setEndDraft(event.target.value)} onBlur={updateLineTimes} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} className="font-mono text-foreground" disabled={editingLocked} /></label></div>
                {view === 'chars' && <Button variant="outline" className="w-full" disabled={editingLocked} onClick={() => changeView('lines')}><ChevronLeft />返回整句编辑</Button>}
                {view === 'chars' && <div className="space-y-2 border-t border-border pt-4">
                  <div className="flex items-center justify-between"><p className="text-sm font-medium">字级范围</p><Badge variant="outline">{activeLine.chars.length} 字/词</Badge></div>
                  <p className="text-xs text-muted-foreground">初始位置为均分建议。拖动上方单字矩形调整；边界不会越出本句。</p>
                  <div className="max-h-56 space-y-1 overflow-y-auto">{activeLine.chars.map(char => { const lockedOut = editingLocked && charRangeDraft?.id !== char.id; const currentPitch = char.pitchOverride ?? pitchMatches[char.id]?.annotation ?? { motion: 'unvoiced' as const, notes: [] }; return <Button key={char.id} type="button" variant="ghost" disabled={lockedOut} onClick={() => { if (editingLocked) return; setSelectedCharIds([char.id]); playNormally(char.start, `已从「${char.text}」起点开始播放；进入范围调整后才会循环试听。`) }} onDoubleClick={() => activateChar(char.id)} className={`flex h-auto w-full items-center justify-start gap-2 px-2 py-1.5 text-left font-normal ${selectedCharIds.includes(char.id) ? 'bg-primary/15' : ''} ${lockedOut ? 'opacity-30' : ''}`}><span className="w-8 truncate font-medium">{char.text}</span><span className="flex-1 font-mono text-xs text-muted-foreground">{formatTime(char.start)} — {formatTime(char.end)}</span><span className="max-w-32 truncate text-right font-mono text-[10px] text-primary" title={pitchNotation(currentPitch)}>{pitchNotation(currentPitch)}</span><span className="text-[10px] text-muted-foreground">{char.pitchOverride ? '人工音高' : pitchPoints.length ? '模型音高' : '待分析'}</span></Button> })}</div>
                  {activeChar && activePitchAnnotation && <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
                    <div className="flex items-center justify-between gap-2"><p className="text-sm font-medium">「{activeChar.text}」字幕音高</p><Badge variant={activeChar.pitchOverride ? 'secondary' : 'outline'}>{activeChar.pitchOverride ? '人工修改' : '模型建议'}</Badge></div>
                    <div className="grid gap-2 text-xs sm:grid-cols-2"><div><p className="text-muted-foreground">模型建议</p><p className="mt-1 font-mono">{activePitchSuggestion ? pitchNotation(activePitchSuggestion) : '—'}</p></div><div><p className="text-muted-foreground">当前字幕</p><p className="mt-1 font-mono text-primary">{pitchNotation(activePitchAnnotation)}</p></div></div>
                    <label className="block space-y-2 text-xs text-muted-foreground">修改音高简写<Input value={pitchNotationDraft} onChange={event => setPitchNotationEdit({ id: activeChar.id, base: activePitchNotation, value: event.target.value })} onBlur={savePitchNotation} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} placeholder="E4 / E4-F4-E4 / E4~" className="font-mono text-foreground" disabled={editingLocked} /></label>
                    <p className="text-xs text-muted-foreground">单音 E4；转音 E4-F4-E4；颤音 E4~；无音高 —。失去焦点时保存，ASS 与字级 JSON 同步使用当前字幕音高。</p>
                    {activePitchAnnotation.notes.length > 1 && <div className="space-y-2 border-t border-border pt-3"><p className="text-xs font-medium">逐音时值</p>{activePitchAnnotation.notes.map((item, index) => { const start = activeChar.start + (activeChar.end - activeChar.start) * item.start; const end = activeChar.start + (activeChar.end - activeChar.start) * item.end; return <div key={`${index}:${item.note}`} className="grid grid-cols-[3rem_1fr_1fr] items-center gap-2 text-xs"><span className="font-mono">{item.note}</span><span className="font-mono text-muted-foreground">{formatTime(start)}</span>{index < activePitchAnnotation.notes.length - 1 ? <Input key={`${activeChar.id}:${index}:${end}`} defaultValue={formatTime(end)} aria-label={`第 ${index + 1} 个音的结束时间`} onBlur={event => { if (event.currentTarget.value !== formatTime(end)) { updatePitchBoundary(index, event.currentTarget.value); event.currentTarget.value = formatTime(end) } }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} className="h-8 font-mono text-xs" disabled={editingLocked} /> : <span className="font-mono text-muted-foreground">{formatTime(end)}</span>}</div> })}<p className="text-xs text-muted-foreground">修改某音结束时间时，下一个音从该时间开始；首尾跟随本字范围。</p></div>}
                    {activeChar.pitchOverride && <Button type="button" size="sm" variant="outline" onClick={resetPitchOverride} disabled={editingLocked}>恢复模型建议</Button>}
                  </div>}
                </div>}
                {view === 'lines' && <Button variant="outline" className="w-full" disabled={editingLocked} onClick={() => changeView('chars')}>进入此句的单字编辑 <ChevronRight /></Button>}
              </div>
            </section>
            }
          </div>

          <aside className="min-w-0 space-y-4">
            <section className="rounded-xl border border-border bg-card p-4">
              <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">歌词列表</h2><Badge variant="secondary">{segments.length} 句</Badge></div>
              <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-border pb-3"><span className="text-xs text-muted-foreground">整体移动</span><Button size="sm" variant="outline" onClick={() => shiftAll(-5)} disabled={!segments.length || editingLocked}>−5s</Button><Button size="sm" variant="outline" onClick={() => shiftAll(-1)} disabled={!segments.length || editingLocked}>−1s</Button><Button size="sm" variant="outline" onClick={() => shiftAll(1)} disabled={!segments.length || editingLocked}>+1s</Button><Button size="sm" variant="outline" onClick={() => shiftAll(5)} disabled={!segments.length || editingLocked}>+5s</Button><Button size="sm" variant="ghost" onClick={restoreShift} disabled={!lastShiftBefore || editingLocked}>还原</Button></div>
              <div className="max-h-72 space-y-1 overflow-auto">
                {segments.map((segment, index) => { const lockedOut = editingLocked && rangeDraft?.id !== segment.id; return <Button key={segment.id} type="button" variant="ghost" disabled={lockedOut} className={`flex h-auto w-full items-center justify-start gap-3 px-3 py-2 text-left font-normal ${selectedLineIds.includes(segment.id) ? 'bg-primary/15 ring-1 ring-primary/60' : ''} ${lockedOut ? 'opacity-30' : ''}`} onContextMenu={event => openContextMenu(event, segment.id)} onClick={event => { if (editingLocked) return; selectLine(segment.id, event.ctrlKey || event.metaKey, event.shiftKey); setSelectedCharIds([]); setCenterTargetId(segment.id); setCenterRequest(value => value + 1); playNormally(segment.start, '已从当前句起点开始播放；进入范围调整后才会循环试听。') }}>
                  <span className="w-6 shrink-0 text-muted-foreground">{index + 1}</span><span className="w-22 shrink-0 font-mono text-xs text-muted-foreground">{formatTime(segment.start)}</span><span className="min-w-0 flex-1 truncate">{segment.text}</span><span className="font-mono text-xs text-muted-foreground">{formatTime(segment.end)}</span>
                </Button> })}
                {!segments.length && <p className="py-8 text-center text-muted-foreground">这里会显示每句歌词，方便快速选择和核对。</p>}
              </div>
            </section>
          </aside>
        </div>
        </div>
      </main>

      <footer className="border-t border-border bg-card px-6 py-3 text-xs text-muted-foreground" role="status">{notice}</footer>

      <Dialog open={importOpen} onOpenChange={setImportOpen}><DialogContent><DialogHeader><DialogTitle>粘贴歌词</DialogTitle><DialogDescription>支持普通歌词或带时间标签的 LRC。普通歌词会均匀排在媒体时长内，随后可逐句调整。</DialogDescription></DialogHeader><Textarea value={importDraft} onChange={event => setImportDraft(event.target.value)} rows={12} placeholder={'[00:12.30]第一句歌词\n[00:17.20]第二句歌词'} /><DialogFooter><Button variant="outline" onClick={() => setImportOpen(false)}>取消</Button><Button onClick={() => void importLyrics(importDraft)} disabled={!importDraft.trim()}>导入歌词</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={newProjectOpen} onOpenChange={setNewProjectOpen}><DialogContent><DialogHeader><DialogTitle>新建工程</DialogTitle><DialogDescription>选择名称和存放位置。原媒体、分离结果及歌词标注会保存在同一个工程文件夹中。</DialogDescription></DialogHeader><div className="space-y-4"><label className="block space-y-2 text-sm">工程名称<Input value={newProjectName} onChange={event => setNewProjectName(event.target.value)} placeholder="例如：歌曲名称" /></label><div className="space-y-2 text-sm"><p>存放位置</p><div className="flex items-center gap-2"><Input value={projectParent} onChange={event => setProjectParent(event.target.value)} className="min-w-0 flex-1" /><Button variant="outline" onClick={async () => { const parent = await window.pitchordDesktop?.pickProjectParent(); if (parent) setProjectParent(parent) }}>选择…</Button></div></div></div><DialogFooter><Button variant="outline" onClick={() => { pendingMediaRef.current = null; setNewProjectOpen(false) }}>取消</Button><Button onClick={() => void createProject()} disabled={!newProjectName.trim() || (window.pitchordDesktop && !projectParent.trim())}>创建工程</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={splitOpen} onOpenChange={setSplitOpen}><DialogContent><DialogHeader><DialogTitle>分割当前歌词</DialogTitle><DialogDescription>先用辅助线确定音频分割位置，再选择文字从哪里断开。左右两句会保留各自的媒体时间范围。</DialogDescription></DialogHeader><div className="space-y-4"><label className="block space-y-2 text-sm">音频分割时间<Input value={splitTimeDraft} onChange={event => setSplitTimeDraft(event.target.value)} className="font-mono" /></label><div className="space-y-2 text-sm"><label>文字分割位置</label><Select value={splitOffset} onValueChange={setSplitOffset}><SelectTrigger><SelectValue placeholder="选择字界" /></SelectTrigger><SelectContent>{splitBoundaries.map(offset => <SelectItem key={offset} value={String(offset)}>{activeLine?.text.slice(0, offset)} ｜ {activeLine?.text.slice(offset)}</SelectItem>)}</SelectContent></Select></div><div className="rounded-md bg-muted p-3 text-xs text-muted-foreground">点击时间轴或按空格暂停可设置辅助线；没有句内辅助线时取句中附近的音量低谷。文字边界优先参考中英文标点和空格，请试听确认。</div></div><DialogFooter><Button variant="outline" onClick={() => setSplitOpen(false)}>取消</Button><Button onClick={confirmSplit}>确认分割</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={conflictOpen} onOpenChange={() => undefined}><DialogContent><DialogHeader><DialogTitle>{charRangeAdjusting ? '单字范围发生冲突' : '句子范围发生冲突'}</DialogTitle><DialogDescription>新的时间范围与相邻{charRangeAdjusting ? '字' : '歌词'}重叠，请选择处理方式后继续。</DialogDescription></DialogHeader><div className="space-y-2 text-sm"><Button className="h-auto w-full justify-start whitespace-normal py-3 text-left" onClick={() => resolveConflict('compress')}>1. 压缩两侧时间块并推动后续块</Button><Button className="h-auto w-full justify-start whitespace-normal py-3 text-left" variant="outline" onClick={() => resolveConflict('push')}>2. 保持其他时间块形状，只推动相邻块</Button><Button className="h-auto w-full justify-start whitespace-normal py-3 text-left" variant="ghost" onClick={() => resolveConflict('discard')}>3. 放弃本次修改</Button></div></DialogContent></Dialog>

      <Dialog open={shiftConfirmOpen} onOpenChange={setShiftConfirmOpen}><DialogContent><DialogHeader><DialogTitle>歌词即将超出媒体范围</DialogTitle><DialogDescription>目前最{pendingShift > 0 ? '后' : '前'}面的歌词时间已经无法继续整体移动。是否继续压缩最外侧句子，并逐步压缩靠里的句子？</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setShiftConfirmOpen(false)}>取消</Button><Button onClick={() => { setShiftConfirmOpen(false); shiftAll(pendingShift, true) }}>继续移动</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={separationPromptOpen} onOpenChange={setSeparationPromptOpen}><DialogContent><DialogHeader><DialogTitle>需要先完成人声分离</DialogTitle><DialogDescription>音高识别和歌词时间戳匹配只读取纯人声结果。Pitchord 会直接处理当前工程中已经导入的媒体，不需要再次选择文件。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setSeparationPromptOpen(false)}>取消</Button><Button onClick={() => { setSeparationPromptOpen(false); requestSeparation() }}>进行人声分离</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={!!rerunPrompt} onOpenChange={open => { if (!open) setRerunPrompt(null) }}><DialogContent><DialogHeader><DialogTitle>该部分任务已经完成</DialogTitle><DialogDescription>是否要尝试其他模型的效果？Pitchord 会同时保留所有模型生成的结果，不会覆盖当前结果。</DialogDescription></DialogHeader><div className="rounded-lg border border-border bg-muted/30 p-3 text-sm"><p>本次将运行：{rerunPrompt === 'separation' ? selectedSeparationModel?.label || separationModel : rerunPrompt === 'alignment' ? analysisEnvironment?.alignment.models.find(model => model.id === alignmentModel)?.label || alignmentModel : pitchAlgorithm === 'pyin' ? 'pYIN' : 'TorchCrepe'}</p><p className="mt-1 text-xs text-muted-foreground">结果文件会加入模型或算法后缀，并可以在试听轨和下游输入中重新选择。</p></div><DialogFooter><Button variant="outline" onClick={() => setRerunPrompt(null)}>取消</Button><Button onClick={() => { const kind = rerunPrompt; setRerunPrompt(null); if (kind === 'separation') void runSeparation(); else if (kind === 'alignment') void runLyricAlignment(); else void analyzePitch() }}>继续运行并保留结果</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={repairEnvironmentOpen} onOpenChange={open => { if (!analysisEnvironmentBusy) setRepairEnvironmentOpen(open) }}><DialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle>{analysisEnvironment?.runtimeReady ? '分析环境设置' : '首次准备分析环境'}</DialogTitle><DialogDescription>环境与模型存放在用户选择的位置，不修改系统 Python 或 PATH。推荐使用 Pitchord 独立环境。</DialogDescription></DialogHeader><div className="space-y-4 text-sm">
        <div className="grid grid-cols-2 gap-2"><Button variant={environmentMode === 'managed' ? 'secondary' : 'outline'} onClick={() => setEnvironmentMode('managed')} disabled={analysisEnvironmentBusy}>创建独立环境</Button><Button variant={environmentMode === 'custom' ? 'secondary' : 'outline'} onClick={() => setEnvironmentMode('custom')} disabled={analysisEnvironmentBusy}>使用现有 Python</Button></div>
        {environmentMode === 'managed' ? <>
          <div className="space-y-2"><p className="font-medium">环境存放位置</p><div className="flex gap-2"><Input value={environmentRootDraft} readOnly className="min-w-0 flex-1 font-mono text-xs" /><Button variant="outline" onClick={async () => { const selected = await window.pitchordDesktop?.chooseAnalysisDirectory(environmentRootDraft); if (selected) setEnvironmentRootDraft(selected) }} disabled={analysisEnvironmentBusy}>选择…</Button></div><div className="flex items-center justify-between gap-2"><p className="text-xs text-muted-foreground">默认放在软件同目录的 environment 文件夹，也可以选择 D 盘等其他位置。</p>{analysisEnvironment?.defaultRoot && environmentRootDraft !== analysisEnvironment.defaultRoot && <Button size="sm" variant="ghost" onClick={() => setEnvironmentRootDraft(analysisEnvironment.defaultRoot)}>恢复默认</Button>}</div></div>
          <label className="block space-y-2"><span className="font-medium">计算环境</span><Select value={computeProfileDraft} onValueChange={value => setComputeProfileDraft(value as 'auto' | 'cpu' | 'cuda121')} disabled={analysisEnvironmentBusy}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="auto">自动选择（推荐）</SelectItem><SelectItem value="cuda121">NVIDIA GPU · CUDA 12.1</SelectItem><SelectItem value="cpu">仅 CPU</SelectItem></SelectContent></Select></label>
          <div className="rounded-lg border border-border bg-muted/30 p-3"><div className="flex items-center justify-between gap-3"><p className="font-medium">设备检测</p><Badge variant={analysisEnvironment?.detectedGpu ? 'secondary' : 'outline'}>{analysisEnvironment?.detectedGpu?.name || '未检测到 NVIDIA GPU'}</Badge></div><p className="mt-1 text-xs text-muted-foreground">{analysisEnvironment?.detectedGpu ? `驱动 ${analysisEnvironment.detectedGpu.driver}。自动模式会先安装 CUDA 12.1 组件，运行检查失败时回退 CPU。` : '自动模式将安装 CPU 组件。'} 首次安装需要联网，GPU 环境通常需要约 4–7 GB 可用空间。</p></div>
          <div className="rounded-lg border border-border bg-muted/30 p-3"><p className="font-medium">独立且可删除</p><p className="mt-1 break-all text-xs text-muted-foreground">Python、依赖、模型和缓存只写入：{environmentRootDraft || '请选择目录'}。删除这个目录即可移除环境。</p></div>
        </> : <>
          <div className="space-y-2"><p className="font-medium">Python 可执行文件</p><div className="flex gap-2"><Input value={externalPythonDraft} readOnly placeholder="选择 python.exe" className="min-w-0 flex-1 font-mono text-xs" /><Button variant="outline" onClick={async () => { const selected = await window.pitchordDesktop?.choosePython(externalPythonDraft); if (selected) setExternalPythonDraft(selected) }} disabled={analysisEnvironmentBusy}>选择…</Button></div><p className="text-xs text-muted-foreground">支持 Python 3.10–3.12。Pitchord 只检测并使用该环境，不会自动安装或删除其中的内容。</p></div>
          <div className="rounded-lg border border-border bg-muted/30 p-3"><p className="font-medium">适合已有环境的用户</p><p className="mt-1 text-xs text-muted-foreground">检测会确认 Demucs、TorchCrepe、librosa 和 faster-whisper。缺失的组件会明确列出，不会静默修改环境。</p></div>
        </>}
      </div><DialogFooter><Button variant="outline" onClick={() => setRepairEnvironmentOpen(false)} disabled={analysisEnvironmentBusy}>稍后设置</Button>{analysisEnvironmentBusy && <Button variant="destructive" onClick={() => void window.pitchordDesktop?.cancelAnalysisTask('environment')}><Square />取消安装</Button>}{environmentMode === 'managed' ? <Button onClick={() => { setRepairEnvironmentOpen(false); void installAnalysisRuntime() }} disabled={analysisEnvironmentBusy || !environmentRootDraft}>下载并准备环境</Button> : <Button onClick={() => void applyExternalPython()} disabled={analysisEnvironmentBusy || !externalPythonDraft}>检测并使用</Button>}</DialogFooter></DialogContent></Dialog>

      <Dialog open={modelManagerOpen} onOpenChange={setModelManagerOpen}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>模型管理</DialogTitle><DialogDescription>功能页只显示已经安装且可以运行的模型。这里可以准备推荐模型，或把自己的模型复制到 Pitchord 环境中统一管理。</DialogDescription></DialogHeader><div className="space-y-3">
        <div className="rounded-lg border border-border bg-muted/30 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium">模型计算设备</p><Badge variant={analysisEnvironment?.compute.cudaAvailable ? 'secondary' : 'outline'}>{analysisEnvironment?.compute.label || '正在检测…'}</Badge></div><p className="mt-1 text-xs text-muted-foreground">支持 CUDA 的 Pitchord 运行环境会自动让 Demucs、MSST 和 TorchCrepe 使用 GPU；pYIN 使用 CPU。歌词识别会单独检测 CTranslate2 的 CUDA 支持，GPU 初始化失败时自动回退 CPU。</p>{analysisEnvironment?.compute.torchVersion && <p className="mt-1 text-xs text-muted-foreground">PyTorch {analysisEnvironment.compute.torchVersion}{analysisEnvironment.compute.torchBuildCuda ? ` · CUDA ${analysisEnvironment.compute.torchBuildCuda}` : ' · CPU 构建'}</p>}</div>
        <p className="text-sm font-medium">人声分离模型</p>{analysisEnvironment?.separationModels.map(model => <div key={model.id} className="rounded-lg border border-border bg-muted/30 p-3"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-medium">{model.label}</p><Badge variant={model.ready ? 'secondary' : 'outline'}>{model.ready ? model.runnable === false ? '已纳入，暂不可运行' : '已安装' : '未安装'}</Badge><Badge variant="outline">{model.source === 'custom' ? '用户模型' : '推荐模型'}</Badge></div><p className="mt-1 text-xs text-muted-foreground">{model.description}</p>{!model.bundled && model.source !== 'custom' && <p className="mt-1 text-xs text-muted-foreground">准备此模型需要联网下载，文件保存在 Pitchord/environment/models。</p>}{model.provider === 'msst' && <p className="mt-1 text-xs text-muted-foreground">MSST `.ckpt` 必须与配套 YAML 一起导入。当前可直接运行 MelBandRoformer 与 BSRoformer，架构会按常见模型文件名识别。</p>}</div><div className="flex shrink-0 gap-2">{!model.ready && model.source !== 'custom' && <Button size="sm" onClick={() => setPendingModelDownload(model.id)} disabled={!analysisEnvironment.runtimeReady}>准备</Button>}{model.canDelete && model.ready && <Button size="sm" variant="outline" onClick={() => setPendingModelRemoval(model.id)}>删除</Button>}</div></div></div>)}
        {!analysisEnvironment?.separationModels.length && <p className="py-6 text-center text-sm text-muted-foreground">正在读取模型目录…</p>}
        <div className="rounded-lg border border-dashed border-border p-3"><p className="text-sm font-medium">导入自己的人声分离模型</p><p className="mt-1 text-xs text-muted-foreground">请一次选择 MSST `.ckpt` 权重和配套 YAML；也兼容 Demucs `.th`。文件会复制到 environment/models/custom，之后删除 Pitchord 中的副本不会影响原文件。可识别的 MelBandRoformer 与 BSRoformer 会立即出现在功能页。</p><Button className="mt-3" size="sm" variant="outline" onClick={() => void importAnalysisModel('separation')}>选择模型文件…</Button></div>
        <p className="pt-2 text-sm font-medium">音高识别模型与算法</p>{analysisEnvironment?.pitchMethods.map(method => <div key={method.id} className="rounded-lg border border-border bg-muted/30 p-3"><div className="flex items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-medium">{method.label}</p><Badge variant={method.ready && method.runnable !== false ? 'secondary' : 'outline'}>{method.ready && method.runnable !== false ? '可运行' : method.ready ? '已纳入，暂不可运行' : '尚未加入'}</Badge></div><p className="mt-1 text-xs text-muted-foreground">{method.description}</p></div>{method.canDelete && <Button size="sm" variant="outline" onClick={() => setPendingModelRemoval(method.id)}>删除</Button>}</div></div>)}<div className="rounded-lg border border-dashed border-border p-3"><p className="text-sm font-medium">导入自己的音高模型</p><p className="mt-1 text-xs text-muted-foreground">权重会复制到 Pitchord 环境。只有识别到匹配的推理提供者后才会出现在可运行算法中。</p><Button className="mt-3" size="sm" variant="outline" onClick={() => void importAnalysisModel('pitch')}>选择音高模型…</Button></div>
        <p className="pt-2 text-sm font-medium">歌词时间戳匹配模型</p>{analysisEnvironment?.alignment.models.map(model => <div key={`alignment-${model.id}`} className="rounded-lg border border-border bg-muted/30 p-3"><div className="flex items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-medium">{model.label}</p><Badge variant={model.ready ? 'secondary' : 'outline'}>{model.ready ? '已安装' : '未安装'}</Badge><Badge variant="outline">faster-whisper</Badge></div><p className="mt-1 text-xs text-muted-foreground">{model.description}</p><p className="mt-1 text-xs text-muted-foreground">模型只保存在 Pitchord/environment/models/whisper，不写入系统目录。首次准备需要联网。</p></div><div className="flex shrink-0 gap-2">{!model.ready ? <Button size="sm" onClick={() => setPendingModelDownload(`alignment:${model.id}`)} disabled={!analysisEnvironment.packages.fasterWhisper}>准备</Button> : <Button size="sm" variant="outline" onClick={() => setPendingModelRemoval(`alignment:${model.id}`)}>删除</Button>}</div></div></div>)}
      </div><DialogFooter><Button variant="outline" onClick={() => void window.pitchordDesktop?.openAnalysisFolder()}>打开模型目录</Button><Button onClick={() => setModelManagerOpen(false)}>完成</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={!!pendingModelDownload} onOpenChange={open => { if (!open) setPendingModelDownload(null) }}><DialogContent><DialogHeader><DialogTitle>准备模型</DialogTitle><DialogDescription>将从模型提供方联网下载所需权重，并保存到 Pitchord 自己的 environment/models 中。不会写入系统模型目录，也不要求填写 HF Token。</DialogDescription></DialogHeader><p className="text-sm">模型：{pendingModelDownload?.startsWith('alignment:') ? analysisEnvironment?.alignment.models.find(model => model.id === pendingModelDownload.slice('alignment:'.length))?.label : analysisEnvironment?.separationModels.find(model => model.id === pendingModelDownload)?.label}</p><DialogFooter><Button variant="outline" onClick={() => setPendingModelDownload(null)}>取消</Button><Button onClick={() => { const id = pendingModelDownload; setPendingModelDownload(null); if (!id) return; if (id.startsWith('alignment:')) void prepareAlignmentModel(id.slice('alignment:'.length)); else void prepareAnalysisModel(id) }}>开始下载</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={!!pendingModelRemoval} onOpenChange={open => { if (!open) setPendingModelRemoval(null) }}><DialogContent><DialogHeader><DialogTitle>删除 Pitchord 中的模型？</DialogTitle><DialogDescription>只删除 Pitchord 环境内管理的副本。用户最初选择的模型文件不会被删除，工程中的历史分析结果也会保留。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setPendingModelRemoval(null)}>取消</Button><Button variant="destructive" onClick={() => { if (!pendingModelRemoval) return; if (pendingModelRemoval.startsWith('alignment:')) void removeAlignmentModel(pendingModelRemoval.slice('alignment:'.length)); else void removeAnalysisModel(pendingModelRemoval) }}>确认删除</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={subtitleOpen} onOpenChange={setSubtitleOpen}><DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle>字级字幕与视频</DialogTitle><DialogDescription>按已经校准的逐字时间生成 ASS。默认样式会高亮当前字、在下方显示“・”，并在字的上方显示字级编辑中确认的音高。</DialogDescription></DialogHeader><div className="grid gap-4 md:grid-cols-2"><div className="space-y-3"><label className="block space-y-2 text-sm">色带<Select value={subtitleStyle.colorBand} onValueChange={value => setSubtitleStyle(current => ({ ...current, colorBand: value as SubtitleStyle['colorBand'] }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="rainbow">音高彩虹</SelectItem><SelectItem value="cool">冷色带</SelectItem><SelectItem value="warm">暖色带</SelectItem><SelectItem value="custom">自定义两端颜色</SelectItem></SelectContent></Select></label><div className="grid grid-cols-2 gap-3"><label className="space-y-2 text-sm">低音颜色<Input type="color" value={subtitleStyle.lowColor} onChange={event => setSubtitleStyle(current => ({ ...current, lowColor: event.target.value }))} /></label><label className="space-y-2 text-sm">高音颜色<Input type="color" value={subtitleStyle.highColor} onChange={event => setSubtitleStyle(current => ({ ...current, highColor: event.target.value }))} /></label><label className="space-y-2 text-sm">普通文字<Input type="color" value={subtitleStyle.baseColor} onChange={event => setSubtitleStyle(current => ({ ...current, baseColor: event.target.value }))} /></label><label className="space-y-2 text-sm">描边<Input type="color" value={subtitleStyle.outlineColor} onChange={event => setSubtitleStyle(current => ({ ...current, outlineColor: event.target.value }))} /></label></div><label className="block space-y-2 text-sm">字体<Input value={subtitleStyle.fontName} onChange={event => setSubtitleStyle(current => ({ ...current, fontName: event.target.value }))} /></label><label className="block space-y-2 text-sm">字号：{subtitleStyle.fontSize}<Slider min={28} max={96} step={2} value={[subtitleStyle.fontSize]} onValueChange={values => setSubtitleStyle(current => ({ ...current, fontSize: values[0] }))} /></label><label className="block space-y-2 text-sm">底部距离：{subtitleStyle.marginBottom}px<Slider min={40} max={240} step={8} value={[subtitleStyle.marginBottom]} onValueChange={values => setSubtitleStyle(current => ({ ...current, marginBottom: values[0] }))} /></label><div className="flex gap-2"><Button size="sm" variant={subtitleStyle.showDot ? 'secondary' : 'outline'} onClick={() => setSubtitleStyle(current => ({ ...current, showDot: !current.showDot }))}>下方强调点</Button><Button size="sm" variant={subtitleStyle.showPitch ? 'secondary' : 'outline'} onClick={() => setSubtitleStyle(current => ({ ...current, showPitch: !subtitleStyle.showPitch }))}>上方音高</Button></div></div><div className="space-y-3"><div className="relative flex min-h-64 items-center justify-center overflow-hidden rounded-lg bg-black p-8 text-center"><div><p className="text-sm font-semibold text-cyan-300">{subtitleStyle.showPitch ? activePitchNotation || '—' : ''}</p><p className="mt-2 text-3xl font-bold" style={{ color: subtitleStyle.baseColor, fontFamily: subtitleStyle.fontName }}><span>示例歌</span><span className="text-cyan-300">词</span></p><p className="text-2xl text-cyan-300">{subtitleStyle.showDot ? '・' : ''}</p></div></div><div className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground"><p>字级时间：{segments.reduce((sum, segment) => sum + segment.chars.length, 0)} 个单位</p><p className="mt-1">音高结果：{pitchPoints.length ? `${pitchPoints.length} 个时间点` : '无；仍可导出逐字时间，颜色保持普通文字色'}</p><p className="mt-1">预览显示当前选中字的音高简写；实际 ASS 按逐音时值依次显示。</p><p className="mt-1">当前字结束到下一字开始之间，会保留该字最后一个音高。</p></div></div></div><DialogFooter><Button variant="outline" onClick={() => void exportWordSubtitles('json')} disabled={!segments.length}><Download />导出字级 JSON</Button><Button variant="outline" onClick={() => void exportWordSubtitles('ass')} disabled={!segments.length}><Download />导出 ASS</Button><Button onClick={() => void burnSubtitleVideo()} disabled={!segments.length || !mediaIsVideo || !projectDirectory}><Video />嵌入视频</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={storageOpen} onOpenChange={open => { if (!cleanupBusy) { setStorageOpen(open); if (!open) setCleanupTarget(null) } }}><DialogContent className="sm:max-w-xl"><DialogHeader><DialogTitle>存储与环境</DialogTitle><DialogDescription>这里只管理 Pitchord 的分析环境、模型和缓存，工程与歌词不会被删除。</DialogDescription></DialogHeader><div className="space-y-3">
        <div className="rounded-lg border border-border bg-muted/30 p-3"><div className="flex items-center justify-between gap-3"><span className="text-sm font-medium">分析运行环境</span><span className="text-sm tabular-nums text-muted-foreground">{analysisStorage ? formatBytes(analysisStorage.sizes.baseRuntime + analysisStorage.sizes.analysisRuntime) : '正在计算…'}</span></div><p className="mt-1 text-xs text-muted-foreground">媒体处理、人声分离和音高识别运行依赖</p><Button className="mt-2" size="sm" variant="outline" onClick={() => setCleanupTarget('runtime')} disabled={cleanupBusy || !analysisStorage || analysisStorage.sizes.baseRuntime + analysisStorage.sizes.analysisRuntime === 0}>删除运行环境</Button></div>
        <div className="rounded-lg border border-border bg-muted/30 p-3"><div className="flex items-center justify-between gap-3"><span className="text-sm font-medium">模型</span><span className="text-sm tabular-nums text-muted-foreground">{analysisStorage ? formatBytes(analysisStorage.sizes.models) : '正在计算…'}</span></div><p className="mt-1 text-xs text-muted-foreground">人声分离及后续分析模型</p><Button className="mt-2" size="sm" variant="outline" onClick={() => setCleanupTarget('models')} disabled={cleanupBusy || !analysisStorage?.sizes.models}>删除模型</Button></div>
        <div className="rounded-lg border border-border bg-muted/30 p-3"><div className="flex items-center justify-between gap-3"><span className="text-sm font-medium">下载与安装缓存</span><span className="text-sm tabular-nums text-muted-foreground">{analysisStorage ? formatBytes(analysisStorage.sizes.cache + analysisStorage.sizes.downloads) : '正在计算…'}</span></div><Button className="mt-2" size="sm" variant="outline" onClick={() => setCleanupTarget('cache')} disabled={cleanupBusy || !analysisStorage || analysisStorage.sizes.cache + analysisStorage.sizes.downloads === 0}>清理缓存</Button></div>
        {!!analysisStorage?.legacyTotal && <div className="rounded-lg border border-border bg-muted/30 p-3"><div className="flex items-center justify-between gap-3"><span className="text-sm font-medium">旧版本分析数据</span><span className="text-sm tabular-nums text-muted-foreground">{formatBytes(analysisStorage.legacyTotal)}</span></div><p className="mt-1 break-all text-xs text-muted-foreground">{analysisStorage.legacyRoot}</p><Button className="mt-2" size="sm" variant="outline" onClick={() => setCleanupTarget('legacy')} disabled={cleanupBusy}>删除旧版本数据</Button></div>}
        {analysisStorage && <p className="break-all text-xs text-muted-foreground">合计 {formatBytes(analysisStorage.total)} · {analysisStorage.root}</p>}
        {cleanupTarget && <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3"><p className="text-sm font-medium">确认删除{cleanupTarget === 'runtime' ? '分析运行环境' : cleanupTarget === 'models' ? '模型' : cleanupTarget === 'cache' ? '缓存' : cleanupTarget === 'legacy' ? '旧版本分析数据' : '全部分析数据'}？</p><p className="mt-1 text-xs text-muted-foreground">需要时可以重新准备。工程和歌词不会被删除。</p><div className="mt-3 flex justify-end gap-2"><Button size="sm" variant="outline" onClick={() => setCleanupTarget(null)} disabled={cleanupBusy}>取消</Button><Button size="sm" variant="destructive" onClick={() => void removeAnalysisData()} disabled={cleanupBusy}><Trash2 />{cleanupBusy ? '正在删除…' : '确认删除'}</Button></div></div>}
      </div><DialogFooter><Button variant="destructive" onClick={() => setCleanupTarget('all')} disabled={cleanupBusy || !analysisStorage?.total}>删除全部分析数据</Button><Button variant="outline" onClick={() => void window.pitchordDesktop?.openAnalysisFolder()}>打开文件夹</Button><Button onClick={() => setStorageOpen(false)} disabled={cleanupBusy}>完成</Button></DialogFooter></DialogContent></Dialog>

      <div className="fixed bottom-4 right-4 z-[70] flex max-w-[calc(100vw-2rem)] flex-col items-end gap-2" data-work-center>
        {workCenterOpen && <section className="w-[360px] max-w-full overflow-hidden rounded-xl border border-border bg-card shadow-2xl" aria-label="任务进度">
          <div className="flex items-center justify-between border-b border-border px-3 py-2"><div className="flex items-center gap-2"><Activity className="size-4 text-primary" /><div><p className="text-sm font-medium">任务进度</p><p className="text-[11px] text-muted-foreground">{workItems.filter(item => item.status === 'running').length ? `${workItems.filter(item => item.status === 'running').length} 项正在执行` : '当前没有运行中的任务'}</p></div></div><div className="flex items-center gap-1"><Button size="sm" variant="ghost" onClick={() => setWorkItems(items => items.filter(item => item.status === 'running'))} disabled={!workItems.some(item => item.status !== 'running')}>清除记录</Button><Button size="icon" variant="ghost" onClick={() => setWorkCenterOpen(false)} aria-label="收起任务进度"><ChevronDown /></Button></div></div>
          <div className="max-h-80 space-y-1 overflow-y-auto p-2">{workItems.map(item => <div key={item.id} className="rounded-lg border border-border bg-background p-2.5"><div className="flex items-start gap-2">{item.status === 'running' ? <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-primary" /> : item.status === 'success' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" /> : item.status === 'cancelled' ? <Square className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> : <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />}<div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><p className="truncate text-xs font-medium">{item.title}</p><div className="flex items-center gap-1"><span className="text-[10px] text-muted-foreground">{item.status === 'running' ? '进行中' : item.status === 'success' ? '完成' : item.status === 'cancelled' ? '已取消' : '失败'}</span>{item.status === 'running' && cancellableTaskIds.has(item.id) && <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => void cancelAnalysisTask(item.id as 'environment' | 'separation' | 'pitch' | 'alignment')}><Square className="size-3" />取消</Button>}</div></div><p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{item.message}</p>{item.status === 'running' && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><div className={`h-full rounded-full bg-primary transition-[width] duration-200 ${item.progress === undefined ? 'w-1/3 animate-pulse' : ''}`} style={item.progress === undefined ? undefined : { width: `${Math.round(clamp(item.progress, 0, 1) * 100)}%` }} /></div>}</div></div></div>)}{!workItems.length && <p className="py-6 text-center text-xs text-muted-foreground">导入、环境与模型、人声分离、音高识别和视频渲染的进度会显示在这里。</p>}</div>
        </section>}
        {!workCenterOpen && <Button className="shadow-lg" variant="secondary" onClick={() => setWorkCenterOpen(true)}><Activity />任务进度{workItems.some(item => item.status === 'running') && <Badge variant="secondary">{workItems.filter(item => item.status === 'running').length}</Badge>}<ChevronUp /></Button>}
      </div>

      {contextMenu && <div className="fixed z-50 min-w-40 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md" style={{ left: contextMenu.x, top: contextMenu.y }} role="menu" onPointerDown={event => event.stopPropagation()}><Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => contextAction('add')}><Plus />添加句</Button><Button variant="ghost" size="sm" className="w-full justify-start" disabled={!mergeIndexes} onClick={() => contextAction('merge')}><Merge />合并</Button><Button variant="ghost" size="sm" className="w-full justify-start" disabled={!activeLine || !splitBoundaries.length} onClick={() => contextAction('split')}><Scissors />分割</Button><Button variant="ghost" size="sm" className="w-full justify-start text-destructive hover:text-destructive" disabled={!contextMenu.id && !selectedLineIds.length} onClick={() => contextAction('delete')}><Trash2 />删除</Button></div>}
    </div>
  </TooltipProvider>
}
