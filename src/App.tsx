import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import {
  AlertCircle, AudioLines, CheckCircle2, ChevronLeft, ChevronRight, Download, FileAudio2, FilePlus2, FileText, Merge,
  FolderOpen, HardDrive, Pause, Play, Plus, Redo2, Save, Scissors, Settings2, Trash2, Undo2, Upload, Video,
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
import { Timeline } from '@/components/Timeline'
import {
  clamp, createSegment, formatTime, getAdjacentSelection, lyricUnits, mergeSegments,
  MIN_SPAN, parseLyrics, parseTime, replaceText, retimeSegment, roundTime, splitSegment, suggestSplitOffset,
} from '@/lib/lyrics'
import type { LyricSegment } from '@/lib/lyrics'
import { analyzeAudioBuffer, matchPitchToChars, noteName } from '@/lib/pitch'
import type { PitchPoint } from '@/lib/pitch'
import { StemMixer } from '@/lib/stem-mixer'
import { resolveRangeConflict } from '@/lib/range-conflict'

type History = { present: LyricSegment[]; past: LyricSegment[][]; future: LyricSegment[][] }
type View = 'lines' | 'chars'
type Draft = { segments: LyricSegment[]; mediaName: string; duration: number; pitchPoints?: PitchPoint[] }
type TrackKind = 'original' | 'vocals' | 'accompaniment'
type TimelinePreview = { id: string; start: number; end: number }
type ContextState = { x: number; y: number; id?: string; time?: number }
type AnalysisEnvironment = {
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
  baseRuntimeVersion: string
  baseRuntimePath: string
  baseRuntimeReady: boolean
  busy: boolean
}

function readDraft(): Draft | null {
  try {
    const value = JSON.parse(localStorage.getItem('pitchord.draft.v1') ?? 'null') as Draft | null
    return value && Array.isArray(value.segments) && typeof value.mediaName === 'string' && typeof value.duration === 'number' ? value : null
  } catch { return null }
}

const savedDraft = readDraft()

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
  const [pythonPath, setPythonPath] = useState('')
  const [analysisEnvironment, setAnalysisEnvironment] = useState<AnalysisEnvironment | null>(null)
  const [analysisEnvironmentBusy, setAnalysisEnvironmentBusy] = useState(false)
  const [analysisProgress, setAnalysisProgress] = useState('正在检查分析环境…')
  const [separationPromptOpen, setSeparationPromptOpen] = useState(false)
  const [zoom, setZoom] = useState(85)
  const [importOpen, setImportOpen] = useState(false)
  const [importDraft, setImportDraft] = useState('')
  const [splitOpen, setSplitOpen] = useState(false)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [projectDirectory, setProjectDirectory] = useState('')
  const [projectName, setProjectName] = useState('')
  const [projectParent, setProjectParent] = useState('')
  const [newProjectName, setNewProjectName] = useState('')
  const [separationFiles, setSeparationFiles] = useState<{ vocals: string; accompaniment: string } | null>(null)
  const [splitTimeDraft, setSplitTimeDraft] = useState('')
  const [splitOffset, setSplitOffset] = useState('')
  const [textDraft, setTextDraft] = useState('')
  const [startDraft, setStartDraft] = useState('')
  const [endDraft, setEndDraft] = useState('')
  const [notice, setNotice] = useState(savedDraft?.segments.length ? '已恢复歌词草稿。重新导入同名媒体后即可试听。' : '导入媒体，然后导入 LRC 或粘贴歌词开始编辑。')
  const mediaInputRef = useRef<HTMLInputElement>(null)
  const vocalInputRef = useRef<HTMLInputElement>(null)
  const lyricInputRef = useRef<HTMLInputElement>(null)
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
  const analysisSourceLabel = analysisEnvironment?.source === 'managed' ? 'Pitchord 独立环境' : analysisEnvironment?.source === 'portable' ? '便携包环境' : analysisEnvironment?.source === 'custom' ? '自选环境' : '未找到环境'

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
    void window.pitchordDesktop.analysisStatus().then(status => {
      setAnalysisEnvironment(status)
      setPythonPath(status.path)
      setAnalysisProgress(status.runtimeReady ? '分析环境可用' : '分析环境尚未准备完整')
    }).catch(() => setAnalysisProgress('无法检查分析环境'))
    const removeProgress = window.pitchordDesktop.onAnalysisProgress(progress => setAnalysisProgress(progress.message))
    void window.pitchordDesktop.projectDefaults().then(defaults => { setProjectParent(defaults.parent); setNewProjectName(defaults.suggestedName) }).catch(() => undefined)
    return removeProgress
  }, [])

  useEffect(() => () => { if (mediaUrl) URL.revokeObjectURL(mediaUrl) }, [mediaUrl])
  useEffect(() => () => { void mixerRef.current?.close() }, [])
  useEffect(() => {
    if (mediaName && duration) localStorage.setItem('pitchord.draft.v1', JSON.stringify({ segments, mediaName, duration, pitchPoints }))
  }, [segments, mediaName, duration, pitchPoints])

  useEffect(() => {
    if (!projectDirectory || !window.pitchordDesktop) return
    const timer = window.setTimeout(() => {
      void window.pitchordDesktop?.saveProject(JSON.stringify({ version: 1, mediaName, duration, segments, pitchPoints })).catch(error => setNotice(`工程自动保存失败：${error instanceof Error ? error.message : String(error)}`))
    }, 600)
    return () => window.clearTimeout(timer)
  }, [projectDirectory, mediaName, duration, segments, pitchPoints])

  const loadMedia = async (file: File, persist = true) => {
    if (!file.type.startsWith('audio/') && !file.type.startsWith('video/')) { setNotice('请选择音频或视频文件。'); return }
    if (persist && window.pitchordDesktop && projectDirectory) {
      try { await window.pitchordDesktop.storeAsset('media', file.name, await file.arrayBuffer()) }
      catch (error) { setNotice(`原媒体保存失败：${error instanceof Error ? error.message : String(error)}`); return }
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
    setSeparationFiles(null)
    audioBufferRef.current = null
    setAudioReady(false)
    setVocalTrackReady(false)
    setWaveformStatus(file.type.startsWith('video/') ? '正在提取视频音轨波形…' : '正在解析媒体波形…')
    if (!reconnect) {
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
          if (token === mediaToken.current) { audioBufferRef.current = audio; setAudioReady(true); setPeaks(samplePeaks(audio)); setWaveformStatus('') }
          return
        } finally { void audioContext.close() }
      } catch { /* Try the container reader below. */ }
    }
    try {
      const { extractAudioBuffer, extractWaveform } = await import('@/lib/waveform')
      try {
        const audio = await extractAudioBuffer(file, () => token === mediaToken.current)
        if (token === mediaToken.current) { audioBufferRef.current = audio; setAudioReady(true); setPeaks(samplePeaks(audio)); setWaveformStatus('') }
      } catch {
        const waveform = await extractWaveform(file, () => token === mediaToken.current)
        if (token === mediaToken.current) setPeaks(waveform)
        if (token === mediaToken.current) setWaveformStatus(waveform.length ? '音高分析需要可解码的音轨。' : '此媒体没有可解码的音轨。')
      }
    } catch {
      if (token === mediaToken.current) setWaveformStatus('可继续播放和编辑；当前环境无法提取该媒体的波形。')
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
    setPitchStatus('正在分析连续音高…')
    await new Promise<void>(resolve => window.setTimeout(resolve, 0))
    try {
      const points = analyzeAudioBuffer(buffer)
      setPitchPoints(points)
      const voiced = points.filter(point => point.voiced)
      setPitchStatus(`已分析 ${points.length} 个时间点，其中 ${voiced.length} 个有声点`)
      setNotice('音高轨已生成。它是人工校对用的连续建议，可在句级和字级范围内复核。')
    } catch { setPitchStatus('音高分析失败，请换用其他媒体格式。') }
  }
  const requestPitchAnalysis = () => {
    if (!vocalTrackReady) { if (window.pitchordDesktop?.separateVocals) setSeparationPromptOpen(true); else setNotice('请先导入纯人声轨。'); return }
    void analyzePitch()
  }

  const loadVocalTrack = async (file: File, persist = true) => {
    if (!file.type.startsWith('audio/')) { setNotice('人声分析轨需要音频文件。'); return }
    try {
      if (persist && window.pitchordDesktop && projectDirectory) await window.pitchordDesktop.storeAsset('vocals', file.name, await file.arrayBuffer())
      const audio = await getMixer().load('vocals', file)
      audioBufferRef.current = audio
      setAudioReady(true)
      setVocalTrackReady(true)
      setStemReady(current => ({ ...current, vocals: true }))
      setTrackEnabled({ original: false, vocals: true, accompaniment: false })
      setPitchPoints([])
      setPitchStatus(`已载入人声分析轨：${file.name}`)
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
    try {
      const source = await mediaFileRef.current.arrayBuffer()
      const result = await window.pitchordDesktop.separateVocals({ name: mediaFileRef.current.name, data: source })
      if (!result) { setSeparationStatus('已取消'); return }
      // Copy into a plain ArrayBuffer so the browser File constructor accepts
      // the bytes under TypeScript's stricter SharedArrayBuffer definitions.
      const vocalBytes = new Uint8Array(result.vocals.data.byteLength)
      vocalBytes.set(result.vocals.data)
      const accompanimentBytes = new Uint8Array(result.accompaniment.data.byteLength)
      accompanimentBytes.set(result.accompaniment.data)
      await loadVocalTrack(new File([vocalBytes.buffer], result.vocals.name, { type: 'audio/wav' }), false)
      await loadAccompanimentTrack(new File([accompanimentBytes.buffer], result.accompaniment.name, { type: 'audio/wav' }), false)
      setTrackEnabled({ original: false, vocals: true, accompaniment: false })
      setSeparationStatus('已生成纯人声和纯伴奏')
      setSeparationFiles({ vocals: result.vocals.path, accompaniment: result.accompaniment.path })
      void window.pitchordDesktop.analysisStatus().then(setAnalysisEnvironment)
    } catch (error) {
      setSeparationStatus('运行失败')
      setNotice(`人声分离失败：${error instanceof Error ? error.message : '请检查 Demucs 和模型配置。'}`)
    }
  }
  const choosePython = async () => {
    if (!window.pitchordDesktop?.pickPython) { setNotice('选择 Python 运行时需要桌面版。'); return }
    try {
      const path = await window.pitchordDesktop.pickPython()
      if (path) {
        setPythonPath(path)
        const status = await window.pitchordDesktop.analysisStatus()
        setAnalysisEnvironment(status)
        setAnalysisProgress(status.runtimeReady ? '所选环境可用' : '所选环境缺少必要组件')
        setNotice(`已选择 Python 运行时：${path}`)
      }
    } catch { setNotice('无法选择 Python 运行时。') }
  }

  const installAnalysisRuntime = async () => {
    if (!window.pitchordDesktop?.installAnalysisRuntime) return
    setAnalysisEnvironmentBusy(true)
    setAnalysisProgress('正在启动环境安装…')
    try {
      const status = await window.pitchordDesktop.installAnalysisRuntime()
      setAnalysisEnvironment(status)
      setPythonPath(status.path)
      setAnalysisProgress('独立分析环境已准备完成')
      setNotice('Pitchord 独立分析环境已安装。接下来可准备人声分离模型。')
    } catch (error) {
      setAnalysisProgress('环境安装未完成')
      setNotice(`分析环境安装失败：${error instanceof Error ? error.message : String(error)}`)
    } finally { setAnalysisEnvironmentBusy(false) }
  }

  const prepareBaseRuntime = async () => {
    if (!window.pitchordDesktop?.prepareBaseRuntime) return
    setAnalysisEnvironmentBusy(true)
    setAnalysisProgress('正在准备内置 Python…')
    try {
      const status = await window.pitchordDesktop.prepareBaseRuntime()
      setAnalysisEnvironment(status)
      setAnalysisProgress(`内置 Python ${status.baseRuntimeVersion} 已准备完成`)
      setNotice('内置 Python 已安装到 Pitchord 本地目录，新设备无需再安装系统 Python。')
    } catch (error) {
      setAnalysisProgress('内置 Python 准备未完成')
      setNotice(`内置 Python 安装失败：${error instanceof Error ? error.message : String(error)}`)
    } finally { setAnalysisEnvironmentBusy(false) }
  }

  const prepareAnalysisModel = async () => {
    if (!window.pitchordDesktop?.prepareAnalysisModel) return
    setAnalysisEnvironmentBusy(true)
    setAnalysisProgress('正在启动模型准备…')
    try {
      const status = await window.pitchordDesktop.prepareAnalysisModel()
      setAnalysisEnvironment(status)
      setAnalysisProgress(`${status.model} 模型已准备完成`)
      setNotice('人声分离模型已保存到 Pitchord 的模型目录。')
    } catch (error) {
      setAnalysisProgress('模型准备未完成')
      setNotice(`模型准备失败：${error instanceof Error ? error.message : String(error)}`)
    } finally { setAnalysisEnvironmentBusy(false) }
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
    if (!editingLocked) setGuideLine(next)
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
  const selectChar = (id: string, additive: boolean) => { if (!editingLocked) setSelectedCharIds(current => additive ? current.includes(id) ? current.filter(item => item !== id) : [...current, id] : [id]) }

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
      if (await download(`${mediaName.replace(/\.[^.]+$/, '') || 'pitchord'}.lrc`, lrc, 'text/plain;charset=utf-8')) setNotice('已导出句级 LRC。字级时间仍保留在当前编辑会话中。')
    } catch { setNotice('保存失败，请检查目标目录是否可写。') }
  }
  const exportProject = async () => {
    try {
      const content = JSON.stringify({ version: 1, mediaName, duration, segments, pitchPoints }, null, 2)
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
      if (!project.segments.every(segment => typeof segment.id === 'string' && typeof segment.text === 'string' && Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.start >= 0 && segment.end <= project.duration && segment.end > segment.start && Array.isArray(segment.chars) && segment.chars.every(char => typeof char.id === 'string' && typeof char.text === 'string' && Number.isFinite(char.start) && Number.isFinite(char.end) && char.start >= segment.start && char.end <= segment.end && char.end >= char.start && Number.isInteger(char.startOffset) && Number.isInteger(char.endOffset)))) throw new Error('invalid segments')
      const importedPitch = Array.isArray(project.pitchPoints) && project.pitchPoints.every(point => typeof point.time === 'number' && typeof point.hz === 'number' && typeof point.confidence === 'number' && typeof point.rms === 'number' && typeof point.voiced === 'boolean') ? project.pitchPoints : []
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
    setPitchStatus('尚未分析音高')
    setSeparationStatus('未运行')
    setSeparationFiles(null)
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
                  <div className="flex min-w-0 items-start gap-2"><Settings2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><div><p className="text-sm font-medium">分析环境</p><p className="mt-1 text-xs text-muted-foreground">可自动下载内置 Python，独立存放依赖和模型，不修改系统 Python 或 PATH。</p></div></div>
                  <Badge variant={analysisEnvironment?.runtimeReady ? 'secondary' : 'outline'}>{analysisEnvironment?.runtimeReady ? <CheckCircle2 className="mr-1 size-3" /> : <AlertCircle className="mr-1 size-3" />}{analysisSourceLabel}</Badge>
                </div>
                <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 xl:grid-cols-4">
                  <span>内置 Python：{analysisEnvironment?.baseRuntimeReady ? `${analysisEnvironment.baseRuntimeVersion} 已就绪` : '尚未下载'}</span>
                  <span>Python：{analysisEnvironment?.pythonVersion || '未检测到'}</span>
                  <span>组件：{analysisEnvironment?.runtimeReady ? 'Demucs 与音高依赖已就绪' : '需要安装或修复'}</span>
                  <span>模型：{analysisEnvironment?.modelReady ? `${analysisEnvironment.model} 已就绪` : `${analysisEnvironment?.model || 'htdemucs'} 尚未预下载`}</span>
                </div>
                <p className="mt-2 break-all text-xs text-muted-foreground">{analysisProgress}{pythonPath ? ` · ${pythonPath}` : ''}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => void installAnalysisRuntime()} disabled={analysisEnvironmentBusy}>{analysisEnvironment?.runtimeReady ? '修复独立环境' : '一键安装分析环境'}</Button>
                  <Button size="sm" variant="outline" onClick={() => void prepareBaseRuntime()} disabled={analysisEnvironmentBusy}>{analysisEnvironment?.baseRuntimeReady ? '检查内置 Python' : '仅下载内置 Python'}</Button>
                  <Button size="sm" variant="outline" onClick={() => void prepareAnalysisModel()} disabled={analysisEnvironmentBusy || !analysisEnvironment?.runtimeReady}>{analysisEnvironment?.modelReady ? '重新检查模型' : '准备人声分离模型'}</Button>
                  <Button size="sm" variant="ghost" onClick={() => void window.pitchordDesktop?.openAnalysisFolder()} disabled={analysisEnvironmentBusy}><HardDrive />存储位置</Button>
                  <Button size="sm" variant="ghost" onClick={choosePython} disabled={analysisEnvironmentBusy}>高级：选择已有 Python</Button>
                </div>
              </div>}
              <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">1. 人声分离</span><Button size="sm" variant="secondary" onClick={() => void runSeparation()} disabled={!mediaUrl || separationStatus.startsWith('正在') || analysisEnvironmentBusy || (window.pitchordDesktop && !analysisEnvironment?.runtimeReady)}>运行人声分离</Button><Button size="sm" variant="ghost" onClick={() => vocalInputRef.current?.click()} disabled={!mediaUrl}>导入外部人声结果</Button><span className="text-xs text-muted-foreground">{separationStatus}</span></div><p className="mt-2 text-xs text-muted-foreground">使用上方已检查的分析环境；首次运行前建议先准备模型，避免在分离过程中等待下载。</p>{projectDirectory && <p className="mt-2 break-all text-xs text-muted-foreground">工程：{projectDirectory}</p>}{separationFiles && <div className="mt-2 space-y-1 text-xs text-muted-foreground"><p className="break-all">纯人声 WAV：{separationFiles.vocals}</p><p className="break-all">纯伴奏 WAV：{separationFiles.accompaniment}</p><p>可通过“工程文件夹”直接用外部播放器核对这两个文件。</p></div>}</div>
              <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3"><p className="mb-3 text-sm font-medium">试听音轨 <span className="text-xs font-normal text-muted-foreground">可多选叠加，切换时保持同一播放位置</span></p><div className="grid gap-3 sm:grid-cols-3">{(['original', 'vocals', 'accompaniment'] as const).map(kind => {
                const available = kind === 'original' ? !!mediaUrl : !!stemReady[kind]
                const label = kind === 'original' ? '原音频' : kind === 'vocals' ? '纯人声' : '纯伴奏'
                return <div key={kind} className="rounded-md border border-border bg-background p-2"><Button size="sm" className="w-full" variant={trackEnabled[kind] ? 'secondary' : 'outline'} aria-pressed={trackEnabled[kind]} onClick={() => toggleTrack(kind)} disabled={!available}>{label} · {trackEnabled[kind] ? '开' : '关'}</Button><div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><Slider min={0} max={kind === 'original' ? 100 : 200} step={5} value={[trackVolume[kind]]} onValueChange={values => setTrackVolume(current => ({ ...current, [kind]: values[0] }))} disabled={!available} aria-label={`${label}音量`} /><span className="w-9 text-right tabular-nums">{trackVolume[kind]}%</span></div></div>
              })}</div></div>
              <div className="mt-3 flex flex-wrap items-center gap-2"><span className="text-sm font-medium">2. 音高识别</span><Button size="sm" variant="secondary" onClick={requestPitchAnalysis} disabled={!mediaUrl || !vocalTrackReady || !audioReady || pitchStatus.startsWith('正在')} >识别连续音高</Button><span className="text-xs text-muted-foreground">仅使用纯人声轨：{vocalTrackReady ? '已准备' : '请先分离或导入'}</span></div>
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
              <Timeline mode={view} segments={segments} activeSegment={activeLine} selectedIds={view === 'lines' ? selectedLineIds : selectedCharIds} duration={duration} peaks={peaks} pitchPoints={pitchPoints} zoom={zoom} playhead={playhead} centerRequest={centerRequest} centerTargetId={centerTargetId} seekCenterRequest={seekCenterRequest} guideLine={guideLine} waveformStatus={waveformStatus} onSeekAndPlay={seekAndPlay} onSelect={(id, additive, range) => view === 'lines' ? selectLine(id, additive, range) : selectChar(id, additive)} onActivateLine={activateLine} onActivateChar={activateChar} onRetimeLines={retimeLines} onRetimeChar={retimeChar} onRetimeChars={retimeChars} rangeAdjusting={view === 'lines' ? rangeAdjusting : charRangeAdjusting} rangeDraft={view === 'lines' ? rangeDraft : charRangeDraft} onRangePreview={view === 'lines' ? setRangeDraft : setCharRangeDraft} onRangeEdgeChange={view === 'lines' ? setRangeEdge : setCharRangeEdge} onBeginRangeAdjust={() => view === 'lines' ? beginRangeAdjust() : beginCharRangeAdjust()} onSaveRangeAdjust={() => view === 'lines' ? finishRangeAdjust() : finishCharRangeAdjust()} onCancelRangeAdjust={() => view === 'lines' ? cancelRangeAdjust() : cancelCharRangeAdjust()} onContextMenu={view === 'lines' ? (event, time, id) => openContextMenu(event, id, time) : undefined} />
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>选择多句：Ctrl/⌘ 点击；连续选择：Shift 点击</span><span>矩形所指向的音频始终来自原媒体</span></div>
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
                  <div className="max-h-56 space-y-1 overflow-y-auto">{activeLine.chars.map(char => { const match = pitchMatches[char.id]; const lockedOut = editingLocked && charRangeDraft?.id !== char.id; return <Button key={char.id} type="button" variant="ghost" disabled={lockedOut} onClick={() => { if (editingLocked) return; setSelectedCharIds([char.id]); playNormally(char.start, `已从「${char.text}」起点开始播放；进入范围调整后才会循环试听。`) }} onDoubleClick={() => activateChar(char.id)} className={`flex h-auto w-full items-center justify-start gap-2 px-2 py-1.5 text-left font-normal ${selectedCharIds.includes(char.id) ? 'bg-primary/15' : ''} ${lockedOut ? 'opacity-30' : ''}`}><span className="w-8 truncate font-medium">{char.text}</span><span className="flex-1 font-mono text-xs text-muted-foreground">{formatTime(char.start)} — {formatTime(char.end)}</span>{match?.hz ? <span className="w-12 text-right font-mono text-[10px] text-primary">{noteName(match.hz)}</span> : null}<span className="text-[10px] text-muted-foreground">{char.origin === 'manual' ? '已调整' : '建议'}</span></Button> })}</div>
                  {activeChar && <p className="text-xs text-primary">已选中「{activeChar.text}」，可在时间轴中拖动。</p>}
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

      <Dialog open={separationPromptOpen} onOpenChange={setSeparationPromptOpen}><DialogContent><DialogHeader><DialogTitle>先处理人声吗？</DialogTitle><DialogDescription>纯人声轨通常更适合歌声音高识别。可以先使用当前原音频，也可以现在处理已导入的媒体。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => { setSeparationPromptOpen(false); void analyzePitch() }}>使用原音频</Button><Button onClick={() => { setSeparationPromptOpen(false); void runSeparation() }}>先进行人声分离</Button></DialogFooter></DialogContent></Dialog>

      {contextMenu && <div className="fixed z-50 min-w-40 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md" style={{ left: contextMenu.x, top: contextMenu.y }} role="menu" onPointerDown={event => event.stopPropagation()}><Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => contextAction('add')}><Plus />添加句</Button><Button variant="ghost" size="sm" className="w-full justify-start" disabled={!mergeIndexes} onClick={() => contextAction('merge')}><Merge />合并</Button><Button variant="ghost" size="sm" className="w-full justify-start" disabled={!activeLine || !splitBoundaries.length} onClick={() => contextAction('split')}><Scissors />分割</Button><Button variant="ghost" size="sm" className="w-full justify-start text-destructive hover:text-destructive" disabled={!contextMenu.id && !selectedLineIds.length} onClick={() => contextAction('delete')}><Trash2 />删除</Button></div>}
    </div>
  </TooltipProvider>
}
