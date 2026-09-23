import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent } from 'react'
import { formatTime, MIN_SPAN, roundTime, clamp } from '@/lib/lyrics'
import type { CharSpan, LyricSegment } from '@/lib/lyrics'
import type { PitchPoint } from '@/lib/pitch'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

type Clip = LyricSegment | CharSpan
type Drag = { id: string; mode: 'move' | 'start' | 'end'; x: number; start: number; end: number; index: number; moved: boolean; lastX: number; lastStep: number; detached: boolean; frozen?: ClipPreview[]; preview?: ClipPreview[] }
type ClipPreview = { id: string; start: number; end: number }

type Props = {
  mode: 'lines' | 'chars'
  segments: LyricSegment[]
  activeSegment: LyricSegment | null
  selectedIds: string[]
  duration: number
  peaks: number[]
  pitchPoints: PitchPoint[]
  zoom: number
  playhead: number
  centerRequest: number
  centerTargetId: string | null
  seekCenterRequest: number
  splitMarker: number | null
  waveformStatus: string
  onSeekAndPlay: (time: number) => void
  onSelect: (id: string, additive: boolean, range: boolean) => void
  onActivateLine: (id: string, beginAdjust: boolean) => void
  onActivateChar?: (id: string, beginAdjust: boolean) => void
  onRetimeLines: (updates: ClipPreview[]) => void
  onRetimeChar: (id: string, start: number, end: number) => void
  onRetimeChars?: (updates: ClipPreview[]) => void
  rangeAdjusting?: boolean
  rangeDraft?: ClipPreview | null
  onRangePreview?: (range: ClipPreview) => void
  onRangeEdgeChange?: (edge: 'start' | 'end' | null) => void
  onBeginRangeAdjust: () => void
  onSaveRangeAdjust: () => void
  onCancelRangeAdjust: () => void
  onContextMenu?: (event: ReactMouseEvent<HTMLDivElement>, time: number, id?: string) => void
}

export function Timeline({ mode, segments, activeSegment, selectedIds, duration, peaks, pitchPoints, zoom, playhead, centerRequest, centerTargetId, seekCenterRequest, splitMarker, waveformStatus, onSeekAndPlay, onSelect, onActivateLine, onActivateChar, onRetimeLines, onRetimeChar, onRetimeChars, rangeAdjusting = false, rangeDraft = null, onRangePreview, onRangeEdgeChange, onBeginRangeAdjust, onSaveRangeAdjust, onCancelRangeAdjust, onContextMenu }: Props) {
  const start = mode === 'chars' && activeSegment ? activeSegment.start : 0
  const end = mode === 'chars' && activeSegment ? activeSegment.end : Math.max(duration, 1)
  const span = Math.max(end - start, 0.2)
  const width = mode === 'chars' ? Math.max(960, span * zoom * 1.6) : Math.max(1200, span * zoom)
  const scale = width / span
  const clips = useMemo<Clip[]>(() => mode === 'chars' ? activeSegment?.chars ?? [] : segments, [mode, activeSegment, segments])
  const activeClipId = mode === 'lines' ? activeSegment?.id : selectedIds[0]
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const seenSeekRequestRef = useRef(0)
  const dragRef = useRef<Drag | null>(null)
  const clickSequenceRef = useRef<{ id: string; startedSelected: boolean; lastPointerAt: number } | null>(null)
  const [preview, setPreview] = useState<ClipPreview[] | null>(null)
  const clipNodesRef = useRef<Record<string, HTMLDivElement | null>>({})
  const ticks = useMemo(() => {
    const interval = scale >= 80 ? 1 : scale >= 35 ? 2 : 5
    const values = []
    for (let value = Math.ceil(start / interval) * interval; value <= end; value += interval) values.push(value)
    return values
  }, [start, end, scale])

  useEffect(() => {
    const viewport = scrollRef.current
    const target = clips.find(clip => clip.id === centerTargetId)
    if (!viewport || !target || centerRequest <= 0) return
    const targetCenter = ((target.start + target.end) / 2 - start) * scale
    viewport.scrollTo({
      left: clamp(targetCenter - viewport.clientWidth / 2, 0, viewport.scrollWidth - viewport.clientWidth),
      behavior: 'smooth',
    })
  }, [centerTargetId, centerRequest, clips, start, scale])

  useEffect(() => {
    const viewport = scrollRef.current
    if (!viewport || seekCenterRequest <= seenSeekRequestRef.current || playhead < start || playhead > end) return
    seenSeekRequestRef.current = seekCenterRequest
    viewport.scrollLeft = clamp((playhead - start) * scale - viewport.clientWidth / 2, 0, viewport.scrollWidth - viewport.clientWidth)
  }, [seekCenterRequest, playhead, mode, start, end, scale])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !peaks.length) return
    const actualWidth = Math.min(Math.round(width), 30000)
    const actualHeight = 112
    canvas.width = actualWidth
    canvas.height = actualHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, actualWidth, actualHeight)
    const viewStartIndex = Math.floor(start / Math.max(duration, 0.001) * peaks.length)
    const viewEndIndex = Math.ceil(end / Math.max(duration, 0.001) * peaks.length)
    const count = Math.max(1, viewEndIndex - viewStartIndex)
    const columns = Math.ceil(actualWidth / 2)
    ctx.fillStyle = '#858c97'
    for (let x = 0; x < columns; x++) {
      const from = viewStartIndex + Math.floor(x / columns * count)
      const to = Math.min(peaks.length, viewStartIndex + Math.ceil((x + 1) / columns * count))
      let peak = 0
      for (let i = from; i < to; i++) peak = Math.max(peak, peaks[i] ?? 0)
      const height = Math.max(2, Math.round(peak * 94))
      ctx.fillRect(x * 2, (actualHeight - height) / 2, 1, height)
    }
  }, [peaks, width, start, end, duration])

  const pointerDown = (event: PointerEvent<HTMLDivElement>, clip: Clip, modeOfDrag: Drag['mode']) => {
    if (event.button !== 0) return
    event.stopPropagation()
    if (rangeAdjusting && clip.id !== rangeDraft?.id) return
    const sequence = clickSequenceRef.current
    if (!sequence || sequence.id !== clip.id || event.timeStamp - sequence.lastPointerAt > 500) {
      clickSequenceRef.current = { id: clip.id, startedSelected: selectedIds.includes(clip.id), lastPointerAt: event.timeStamp }
    } else sequence.lastPointerAt = event.timeStamp
    onSelect(clip.id, event.ctrlKey || event.metaKey, event.shiftKey)
    if (rangeAdjusting && (clip.id !== activeClipId || modeOfDrag === 'move')) return
    if (event.ctrlKey || event.metaKey || event.shiftKey) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { id: clip.id, mode: modeOfDrag, x: event.clientX, start: rangeAdjusting && rangeDraft ? rangeDraft.start : clip.start, end: rangeAdjusting && rangeDraft ? rangeDraft.end : clip.end, index: clips.findIndex(item => item.id === clip.id), moved: false, lastX: event.clientX, lastStep: 0, detached: false }
    if (rangeAdjusting) onRangeEdgeChange?.(modeOfDrag === 'start' ? 'start' : 'end')
  }

  const buildMovePreview = (index: number, targetStart: number) => {
    const originals = clips
    const moved = originals[index]
    if (!moved) return []
    const width = moved.end - moved.start
    const result: ClipPreview[] = originals.map(clip => ({ id: clip.id, start: clip.start, end: clip.end }))
    result[index] = { id: moved.id, start: targetStart, end: targetStart + width }

    for (let current = index + 1; current < result.length; current++) {
      const previous = result[current - 1]
      const original = originals[current]
      if (previous.end <= original.start) continue
      const startAt = previous.end
      const compressedStart = Math.min(startAt, original.end - MIN_SPAN)
      result[current] = startAt <= original.end - MIN_SPAN
        ? { id: original.id, start: compressedStart, end: original.end }
        : { id: original.id, start: startAt, end: startAt + MIN_SPAN }
    }
    for (let current = index - 1; current >= 0; current--) {
      const next = result[current + 1]
      const original = originals[current]
      if (next.start >= original.end) continue
      const endAt = next.start
      result[current] = endAt >= original.start + MIN_SPAN
        ? { id: original.id, start: original.start, end: endAt }
        : { id: original.id, start: endAt - MIN_SPAN, end: endAt }
    }
    return result
  }

  const boundedMovePreview = (index: number, targetStart: number) => {
    const moved = clips[index]
    if (!moved) return []
    const width = moved.end - moved.start
    const target = clamp(targetStart, 0, Math.max(0, duration - width))
    let result = buildMovePreview(index, target)
    if (result[0]?.start < 0 && target < moved.start) {
      let low = target
      let high = moved.start
      for (let iteration = 0; iteration < 18; iteration++) {
        const middle = (low + high) / 2
        if (buildMovePreview(index, middle)[0]?.start >= 0) high = middle
        else low = middle
      }
      result = buildMovePreview(index, high)
    }
    if ((result.at(-1)?.end ?? duration) > duration && target > moved.start) {
      let low = moved.start
      let high = target
      for (let iteration = 0; iteration < 18; iteration++) {
        const middle = (low + high) / 2
        if ((buildMovePreview(index, middle).at(-1)?.end ?? duration) <= duration) low = middle
        else high = middle
      }
      result = buildMovePreview(index, low)
    }
    return result.map(clip => ({ ...clip, start: roundTime(clip.start), end: roundTime(clip.end) }))
  }

  const buildResizePreview = (index: number, edge: 'start' | 'end', value: number) => {
    const result: ClipPreview[] = clips.map(clip => ({ id: clip.id, start: clip.start, end: clip.end }))
    if (edge === 'start') {
      result[index].start = value
      for (let current = index - 1; current >= 0 && result[current].end > result[current + 1].start; current--) {
        result[current].end = result[current + 1].start
        if (result[current].end - result[current].start < MIN_SPAN) result[current].start = result[current].end - MIN_SPAN
      }
    } else {
      result[index].end = value
      for (let current = index + 1; current < result.length && result[current].start < result[current - 1].end; current++) {
        result[current].start = result[current - 1].end
        if (result[current].end - result[current].start < MIN_SPAN) result[current].end = result[current].start + MIN_SPAN
      }
    }
    return result.map(clip => ({ ...clip, start: roundTime(clip.start), end: roundTime(clip.end) }))
  }

  const boundedResizePreview = (drag: Drag, edge: 'start' | 'end', value: number) => {
    const lowerBound = mode === 'chars' ? start : 0
    const upperBound = mode === 'chars' ? end : duration
    const bounded = edge === 'start'
      ? clamp(value, lowerBound + drag.index * MIN_SPAN, drag.end - MIN_SPAN)
      : clamp(value, drag.start + MIN_SPAN, upperBound - (clips.length - drag.index - 1) * MIN_SPAN)
    return buildResizePreview(drag.index, edge, bounded)
  }

  const detachedResizePreview = (drag: Drag, edge: 'start' | 'end', value: number) => {
    const result = (drag.frozen ?? clips.map(clip => ({ id: clip.id, start: clip.start, end: clip.end }))).map(clip => ({ ...clip }))
    const current = result[drag.index]
    if (!current) return result
    if (edge === 'start') {
      const lower = drag.index > 0 ? result[drag.index - 1].end : (mode === 'chars' ? start : 0)
      current.start = roundTime(clamp(value, lower, drag.end - MIN_SPAN))
      current.end = roundTime(drag.end)
    } else {
      const upper = drag.index < result.length - 1 ? result[drag.index + 1].start : (mode === 'chars' ? end : duration)
      current.start = roundTime(drag.start)
      current.end = roundTime(clamp(value, drag.start + MIN_SPAN, upper))
    }
    return result
  }

  const detachedMovePreview = (drag: Drag, targetStart: number) => {
    const width = drag.end - drag.start
    const result = (drag.frozen ?? clips.map(clip => ({ id: clip.id, start: clip.start, end: clip.end }))).map(clip => ({ ...clip }))
    const lower = drag.index > 0 ? result[drag.index - 1].end : 0
    const startAt = clamp(targetStart, lower, Math.max(lower, duration - width))
    result[drag.index] = { id: drag.id, start: startAt, end: startAt + width }
    return result.map(clip => ({ ...clip, start: roundTime(clip.start), end: roundTime(clip.end) }))
  }

  const hasNeighborChanges = (preview: ClipPreview[], index: number) => preview.some((clip, clipIndex) => clipIndex !== index && (clip.start !== clips[clipIndex].start || clip.end !== clips[clipIndex].end))

  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const delta = (event.clientX - drag.x) / scale
    const step = event.clientX - drag.lastX
    const directionChanged = drag.lastStep !== 0 && step !== 0 && Math.sign(step) !== Math.sign(drag.lastStep)
    drag.lastX = event.clientX
    if (step !== 0) drag.lastStep = step
    if (Math.abs(event.clientX - drag.x) > 2) drag.moved = true
    if (rangeAdjusting && drag.id === activeClipId) {
      if (drag.mode === 'move') return
      const lowerBound = mode === 'chars' ? start : 0
      const upperBound = mode === 'chars' ? end : duration
      const nextStart = drag.mode === 'start' ? clamp(drag.start + delta, lowerBound, drag.end - MIN_SPAN) : drag.start
      const nextEnd = drag.mode === 'end' ? clamp(drag.end + delta, drag.start + MIN_SPAN, upperBound) : drag.end
      const nextRange = { id: drag.id, start: roundTime(nextStart), end: roundTime(nextEnd) }
      setPreview([nextRange])
      onRangePreview?.(nextRange)
      return
    }
    if (drag.mode === 'move') {
      if (mode === 'chars') {
        const target = clamp(drag.start + delta, start, end - (drag.end - drag.start))
        drag.preview = buildMovePreview(drag.index, target).map(item => ({ ...item, start: Math.max(start, item.start), end: Math.min(end, item.end) }))
        setPreview(drag.preview)
        return
      }
      if (!drag.detached) {
        const target = drag.start + delta
        const next = boundedMovePreview(drag.index, target)
        if (directionChanged && drag.preview && hasNeighborChanges(drag.preview, drag.index)) {
          drag.detached = true
          drag.frozen = drag.preview
        }
        drag.preview = drag.detached ? detachedMovePreview(drag, target) : next
      } else drag.preview = detachedMovePreview(drag, drag.start + delta)
      setPreview(drag.preview)
      return
    }
    if (drag.mode === 'start' || drag.mode === 'end') {
      const target = (drag.mode === 'start' ? drag.start : drag.end) + delta
      if (!drag.detached) {
        const next = boundedResizePreview(drag, drag.mode, target)
        if (directionChanged && drag.preview && hasNeighborChanges(drag.preview, drag.index)) {
          drag.detached = true
          drag.frozen = drag.preview
        }
        drag.preview = drag.detached ? detachedResizePreview(drag, drag.mode, target) : next
      } else drag.preview = detachedResizePreview(drag, drag.mode, target)
      setPreview(drag.preview)
      return
    }
  }

  const pointerUp = () => {
    const drag = dragRef.current
    const finalPreview = drag?.preview ?? preview
    if (drag?.moved && finalPreview && !rangeAdjusting) {
      const changed = finalPreview.filter(clip => {
        const original = clips.find(item => item.id === clip.id)
        return original && (original.start !== clip.start || original.end !== clip.end)
      })
      if (mode === 'lines') onRetimeLines(changed)
      else if (onRetimeChars) onRetimeChars(changed)
      else {
        const clip = changed[0]
        if (clip) onRetimeChar(clip.id, clip.start, clip.end)
      }
    }
    dragRef.current = null
    setPreview(null)
    if (rangeAdjusting) onRangeEdgeChange?.(null)
  }

  const seekAt = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    const time = roundTime(clamp(start + (event.clientX - rect.left) / scale, start, end))
    if (rangeAdjusting && rangeDraft && (time < rangeDraft.start || time > rangeDraft.end)) return
    onSeekAndPlay(time)
  }

  const visiblePlayhead = playhead >= start && playhead <= end
  const visiblePitch = pitchPoints.filter(point => point.voiced && point.time >= start && point.time <= end)
  const floatingClip = selectedIds.length === 1 ? clips.find(clip => clip.id === activeClipId) : null
  const floatingRange = floatingClip ? (rangeAdjusting && rangeDraft?.id === floatingClip.id ? rangeDraft : floatingClip) : null
  const floatingLeft = floatingRange ? clamp(((floatingRange.start + floatingRange.end) / 2 - start) * scale, 76, width - 76) : 0
  const contextAt = (event: ReactMouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const time = roundTime(clamp(start + (event.clientX - rect.left) / scale, start, end))
    onContextMenu?.(event, time)
  }
  const activateClip = (id: string, beginAdjust: boolean) => {
    if (mode === 'lines') onActivateLine(id, beginAdjust)
    else onActivateChar?.(id, beginAdjust)
  }
  return (
    <div ref={scrollRef} className="overflow-x-auto rounded-lg border border-border bg-background" aria-label={mode === 'lines' ? '句级时间轴' : '字级时间轴'} onContextMenu={event => contextAt(event)}>
      <div className="relative" style={{ width, minWidth: '100%' }}>
        <div className="timeline-ruler relative h-11 cursor-crosshair border-b border-border bg-card" onPointerDown={seekAt}>
          {ticks.map(time => <div key={time} className="absolute top-0 h-full border-l border-border/80" style={{ left: (time - start) * scale }}>
            <span className="absolute top-2 left-2 whitespace-nowrap text-xs text-muted-foreground">{formatTime(time).slice(0, 5)}</span>
          </div>)}
        </div>
        <div className="relative h-32 cursor-crosshair border-b border-border bg-muted/40" onPointerDown={seekAt}>
          {ticks.map(time => <div key={time} className="absolute top-0 bottom-0 border-l border-border/40" style={{ left: (time - start) * scale }} />)}
          {peaks.length > 0 ? <canvas ref={canvasRef} className="absolute inset-0 h-28 w-full" style={{ width }} /> : <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">{waveformStatus}</div>}
          {visiblePitch.length > 1 && <svg className="pointer-events-none absolute inset-0 h-28" style={{ width }} viewBox={`0 0 ${Math.max(1, width)} 112`} preserveAspectRatio="none" aria-label="连续音高轨"><polyline fill="none" stroke="hsl(var(--primary))" strokeOpacity=".9" strokeWidth="2" points={visiblePitch.map(point => `${(point.time - start) * scale},${102 - Math.min(88, Math.max(0, Math.log2(Math.max(65, point.hz) / 65) / Math.log2(1100 / 65) * 88))}`).join(' ')} /></svg>}
          <div className="absolute left-4 bottom-2 rounded bg-background/80 px-2 py-1 text-xs text-muted-foreground">{mode === 'chars' ? '当前句音频' : '原媒体波形'}</div>
        </div>
        <div className="relative h-30 border-b border-border bg-card/60" onPointerDown={seekAt}>
          {ticks.map(time => <div key={time} className="absolute top-0 bottom-0 border-l border-border/40" style={{ left: (time - start) * scale }} />)}
          <div className="absolute top-2 left-4 text-xs text-muted-foreground">{mode === 'lines' ? '句级歌词轨' : '单字时间轨'}</div>
          {clips.map((clip, index) => {
            const shown = preview?.find(item => item.id === clip.id) ?? (rangeAdjusting && rangeDraft?.id === clip.id ? rangeDraft : clip)
            const selected = selectedIds.includes(clip.id)
            const left = (shown.start - start) * scale
            const clipWidth = Math.max(5, (shown.end - shown.start) * scale)
            return <div
              key={clip.id}
              ref={node => { clipNodesRef.current[clip.id] = node }}
              data-clip-id={clip.id}
              className={cn('timeline-clip absolute top-9 h-16 overflow-visible rounded-md border text-left shadow-sm transition-colors', selected ? 'z-30 border-primary bg-primary/25 text-foreground' : 'z-10 border-border bg-secondary text-secondary-foreground hover:border-primary/60', rangeAdjusting && rangeDraft?.id !== clip.id && 'cursor-not-allowed opacity-25', rangeAdjusting && rangeDraft?.id === clip.id && 'ring-2 ring-amber-400')}
              style={{ left, width: clipWidth, zIndex: selected ? 30 : 10 } as CSSProperties}
              onPointerDown={event => pointerDown(event, clip, 'move')}
              onPointerMove={pointerMove}
              onPointerUp={pointerUp}
              onLostPointerCapture={pointerUp}
              onClick={event => { if (event.detail >= 3) activateClip(clip.id, true) }}
              onContextMenu={event => { event.preventDefault(); event.stopPropagation(); const rect = event.currentTarget.parentElement?.getBoundingClientRect(); const time = rect ? roundTime(clamp(start + (event.clientX - rect.left) / scale, start, end)) : shown.start; onContextMenu?.(event, time, clip.id) }}
              onDoubleClick={() => { if (rangeAdjusting && clip.id !== rangeDraft?.id) return; const sequence = clickSequenceRef.current; activateClip(clip.id, sequence?.id === clip.id && sequence.startedSelected) }}
              title={`${clip.text} · ${formatTime(shown.start)}–${formatTime(shown.end)}`}
            >
              <div className={cn('timeline-handle absolute inset-y-0 z-40 border-r border-foreground/30 bg-foreground/10 hover:bg-primary/50', selected ? '-left-2 w-4' : 'left-0 w-2')} onPointerDown={event => { event.stopPropagation(); pointerDown(event, clip, 'start') }} />
              <div className="flex h-full flex-col justify-center overflow-hidden px-3">
                <span className="truncate font-medium">{clip.text}</span>
                <span className="truncate font-mono text-[10px] text-muted-foreground">{formatTime(shown.start)} · {index + 1}</span>
              </div>
              <div className={cn('timeline-handle absolute inset-y-0 z-40 border-l border-foreground/30 bg-foreground/10 hover:bg-primary/50', selected ? '-right-2 w-4' : 'right-0 w-2')} onPointerDown={event => { event.stopPropagation(); pointerDown(event, clip, 'end') }} />
            </div>
          })}
          {floatingRange && <div data-range-toolbar className="absolute top-1 z-50 flex -translate-x-1/2 items-center gap-1 rounded-md border border-border bg-popover/95 p-1 text-popover-foreground shadow-lg backdrop-blur-sm" style={{ left: floatingLeft }} onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
            {rangeAdjusting ? <><span className="px-1.5 text-[10px] text-amber-600">循环试听中</span><Button size="sm" className="h-7 px-2" onClick={onSaveRangeAdjust}>保存调整 <span className="text-[10px] opacity-70">Enter</span></Button><Button size="sm" variant="ghost" className="h-7 px-2" onClick={onCancelRangeAdjust}>放弃调整 <span className="text-[10px] opacity-70">Esc</span></Button></> : <Button size="sm" variant="outline" className="h-7 px-2" onClick={onBeginRangeAdjust}>调整{mode === 'lines' ? '句' : '字'}范围</Button>}
          </div>}
          {!clips.length && <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">{mode === 'lines' ? '导入歌词后，在这里调整每句范围' : '先选择一句歌词'}</div>}
        </div>
        {rangeAdjusting && rangeDraft && <>
          <div className="pointer-events-none absolute inset-y-0 left-0 z-20 bg-background/65" style={{ width: Math.max(0, (rangeDraft.start - start) * scale) }} />
          <div className="pointer-events-none absolute inset-y-0 z-20 bg-background/65" style={{ left: (rangeDraft.end - start) * scale, width: Math.max(0, width - (rangeDraft.end - start) * scale) }} />
        </>}
        {rangeAdjusting && rangeDraft && <>
          <div className="pointer-events-none absolute top-0 bottom-0 z-35 w-px bg-amber-400" style={{ left: (rangeDraft.start - start) * scale }}><span className="absolute left-1 top-12 whitespace-nowrap rounded bg-amber-400 px-1.5 py-0.5 text-[10px] font-medium text-amber-950">开始 {formatTime(rangeDraft.start)}</span></div>
          <div className="pointer-events-none absolute top-0 bottom-0 z-35 w-px bg-amber-400" style={{ left: (rangeDraft.end - start) * scale }}><span className="absolute right-1 top-12 whitespace-nowrap rounded bg-amber-400 px-1.5 py-0.5 text-[10px] font-medium text-amber-950">结束 {formatTime(rangeDraft.end)}</span></div>
        </>}
        {mode === 'lines' && splitMarker !== null && splitMarker >= start && splitMarker <= end && <div data-split-marker className="pointer-events-none absolute top-0 bottom-0 z-30 w-0.5 bg-destructive" style={{ left: (splitMarker - start) * scale }}><span className="absolute left-1 top-24 whitespace-nowrap rounded bg-destructive px-1.5 py-0.5 text-[10px] font-medium text-destructive-foreground">分割点 {formatTime(splitMarker)}</span></div>}
        {visiblePlayhead && <div className="timeline-playhead absolute top-0 bottom-0 z-20 w-0.5 bg-primary" style={{ left: (playhead - start) * scale }}><div className="absolute -left-1 top-0 h-3 w-2.5 rounded-b-sm bg-primary" /></div>}
      </div>
    </div>
  )
}
