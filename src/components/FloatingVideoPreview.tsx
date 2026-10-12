import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Grip, Pause, PictureInPicture2, Play, X } from 'lucide-react'
import type { LyricSegment } from '@/lib/lyrics'
import { formatTime } from '@/lib/lyrics'
import type { PitchPoint } from '@/lib/pitch'
import type { SubtitleStyle } from '@/lib/subtitles'
import { LiveSubtitlePreview } from './LiveSubtitlePreview'
import { VideoFrameMirror } from './VideoFrameMirror'

type Props = {
  mediaRef: RefObject<HTMLMediaElement | null>
  segments: LyricSegment[]
  points: PitchPoint[]
  style: SubtitleStyle
  playhead: number
  duration: number
  playing: boolean
  aspect: number
  onSeek: (time: number) => void
  onTogglePlayback: () => void
  onClose: () => void
}

const viewportSize = () => ({ width: document.documentElement.clientWidth || window.innerWidth, height: document.documentElement.clientHeight || window.innerHeight })

export function FloatingVideoPreview({ mediaRef, segments, points, style, playhead, duration, playing, aspect, onSeek, onTogglePlayback, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  const videoAreaRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null)
  const resizeRef = useRef<{ pointerId: number; x: number; y: number; width: number; height: number; left: number; top: number } | null>(null)
  const [position, setPosition] = useState(() => ({ left: Math.max(8, viewportSize().width - 444), top: 84 }))
  const [size, setSize] = useState({ width: 420, height: 320 })
  const [areaSize, setAreaSize] = useState({ width: 420, height: 220 })
  const [dragging, setDragging] = useState(false)

  useEffect(() => { panelRef.current?.focus({ preventScroll: true }) }, [])

  useEffect(() => {
    const area = videoAreaRef.current
    if (!area) return
    const observer = new ResizeObserver(() => setAreaSize({ width: area.clientWidth, height: area.clientHeight }))
    observer.observe(area)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const keepVisible = () => {
      const panel = panelRef.current
      if (!panel) return
      const viewport = viewportSize()
      setPosition(current => {
        const left = Math.max(8, Math.min(current.left, viewport.width - Math.min(panel.offsetWidth, viewport.width) - 8))
        const top = Math.max(8, Math.min(current.top, viewport.height - Math.min(panel.offsetHeight, viewport.height) - 8))
        return left === current.left && top === current.top ? current : { left, top }
      })
    }
    const observer = new ResizeObserver(keepVisible)
    if (panelRef.current) observer.observe(panelRef.current)
    window.addEventListener('resize', keepVisible)
    return () => { observer.disconnect(); window.removeEventListener('resize', keepVisible) }
  }, [])

  useEffect(() => {
    const moveDrag = (event: globalThis.PointerEvent) => {
      const resize = resizeRef.current
      const panel = panelRef.current
      if (resize && panel && resize.pointerId === event.pointerId) {
        event.preventDefault()
        const viewport = viewportSize()
        panel.style.width = `${Math.max(260, Math.min(resize.width + event.clientX - resize.x, viewport.width - resize.left - 8))}px`
        panel.style.height = `${Math.max(220, Math.min(resize.height + event.clientY - resize.y, viewport.height - resize.top - 8))}px`
        return
      }
      const drag = dragRef.current
      if (!drag || !panel || drag.pointerId !== event.pointerId) return
      event.preventDefault()
      const viewport = viewportSize()
      const left = Math.max(8, Math.min(drag.left + event.clientX - drag.x, viewport.width - panel.offsetWidth - 8))
      const top = Math.max(8, Math.min(drag.top + event.clientY - drag.y, viewport.height - panel.offsetHeight - 8))
      panel.style.left = `${left}px`
      panel.style.top = `${top}px`
    }
    const stopDrag = (event: globalThis.PointerEvent) => {
      if (resizeRef.current?.pointerId === event.pointerId) {
        resizeRef.current = null
        const panel = panelRef.current
        if (panel) setSize({ width: panel.offsetWidth, height: panel.offsetHeight })
        return
      }
      if (dragRef.current?.pointerId !== event.pointerId) return
      dragRef.current = null
      setDragging(false)
      const panel = panelRef.current
      if (panel) setPosition({ left: panel.offsetLeft, top: panel.offsetTop })
    }
    window.addEventListener('pointermove', moveDrag, { capture: true })
    window.addEventListener('pointerup', stopDrag, { capture: true })
    window.addEventListener('pointercancel', stopDrag, { capture: true })
    return () => {
      window.removeEventListener('pointermove', moveDrag, true)
      window.removeEventListener('pointerup', stopDrag, true)
      window.removeEventListener('pointercancel', stopDrag, true)
    }
  }, [])

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('[data-no-drag]')) return
    const panel = panelRef.current
    if (!panel) return
    event.preventDefault()
    panel.focus({ preventScroll: true })
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: panel.offsetLeft, top: panel.offsetTop }
    setDragging(true)
  }
  const startResize = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    const panel = panelRef.current
    if (!panel) return
    event.preventDefault()
    event.stopPropagation()
    resizeRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, width: panel.offsetWidth, height: panel.offsetHeight, left: panel.offsetLeft, top: panel.offsetTop }
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || (event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"], [data-resize-handle]')) return
    const step = event.shiftKey ? 1 : 5
    switch (event.key) {
      case 'ArrowLeft': onSeek(playhead - step); break
      case 'ArrowRight': onSeek(playhead + step); break
      case 'Home': onSeek(0); break
      case 'End': onSeek(duration); break
      case ' ':
      case 'k':
      case 'K':
        if ((event.target as HTMLElement).closest('button')) return
        onTogglePlayback()
        break
      default: return
    }
    event.preventDefault()
    event.stopPropagation()
  }
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9
  const frameWidth = Math.max(1, Math.min(areaSize.width, areaSize.height * safeAspect))
  const frameHeight = frameWidth / safeAspect

  return createPortal(<div ref={panelRef} tabIndex={0} onKeyDown={handleKeyDown} className="fixed z-40 flex min-h-[220px] min-w-[260px] flex-col overflow-hidden rounded-xl border border-neutral-700 bg-neutral-950 text-white shadow-2xl outline-none focus-visible:ring-2 focus-visible:ring-sky-400" style={{ left: position.left, top: position.top, width: size.width, height: size.height, maxWidth: 'calc(100vw - 16px)', maxHeight: 'calc(100vh - 16px)' }} aria-label="视频悬浮小窗" aria-keyshortcuts="ArrowLeft ArrowRight Space Home End">
    <div className={`flex h-9 shrink-0 select-none items-center justify-between border-b border-white/10 bg-neutral-900 px-2.5 text-xs touch-none ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`} onPointerDown={startDrag} title="拖动顶栏或画面移动小窗">
      <span className="flex min-w-0 items-center gap-2 font-medium"><PictureInPicture2 className="size-4 shrink-0 text-sky-400" /><span className="truncate">字幕画中画</span><span className="hidden truncate text-[11px] font-normal text-neutral-400 sm:inline">拖动画面移动</span></span>
      <button type="button" data-no-drag className="ml-2 rounded p-1 text-neutral-300 hover:bg-white/15 hover:text-white" aria-label="关闭视频小窗" onClick={onClose}><X className="size-4" /></button>
    </div>
    <div ref={videoAreaRef} className={`group relative flex min-h-0 flex-1 touch-none select-none items-center justify-center bg-black ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`} onPointerDown={startDrag} title="拖动画面移动小窗；右下角调整大小">
      <div className="relative" style={{ width: frameWidth, height: frameHeight }}>
        <VideoFrameMirror mediaRef={mediaRef} />
        <LiveSubtitlePreview segments={segments} points={points} style={style} mediaRef={mediaRef} playhead={playhead} />
      </div>
      <div data-no-drag className="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/90 via-black/60 to-transparent px-3 pb-2 pt-6 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <input type="range" min={0} max={Math.max(duration, 0.01)} step={0.01} value={Math.min(playhead, Math.max(duration, 0.01))} onChange={event => onSeek(Number(event.target.value))} className="h-1 w-full cursor-pointer accent-sky-400" aria-label="小窗播放进度" />
        <div className="mt-1 flex items-center gap-2">
          <button type="button" className="rounded p-1 hover:bg-white/15" onClick={onTogglePlayback} aria-label={playing ? '暂停小窗预览' : '播放小窗预览'}>{playing ? <Pause className="size-4" /> : <Play className="size-4" />}</button>
          <span className="font-mono text-[11px] tabular-nums text-white/90">{formatTime(playhead)} / {formatTime(duration)}</span>
          <span className="ml-auto text-[10px] text-white/60" title="左右键跳转 5 秒；Shift+左右键微调 1 秒；空格暂停或播放">← → 5 秒</span>
        </div>
      </div>
      <button type="button" data-no-drag data-resize-handle aria-label="调整小窗大小" title="拖动调整小窗大小" className="absolute bottom-0 right-0 z-20 flex size-6 cursor-nwse-resize items-end justify-end p-0.5 text-white/70 hover:text-white touch-none" onPointerDown={startResize}><Grip className="pointer-events-none size-4" aria-hidden="true" /></button>
    </div>
  </div>, document.body)
}
