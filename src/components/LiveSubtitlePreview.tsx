import { useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { LyricSegment } from '@/lib/lyrics'
import { noteName, type PitchPoint } from '@/lib/pitch'
import { prepareSubtitleTimeline, subtitleFrameFromTimeline, type SubtitleStyle } from '@/lib/subtitles'

type Props = {
  segments: LyricSegment[]
  points: PitchPoint[]
  style: SubtitleStyle
  mediaRef: RefObject<HTMLMediaElement | null>
  playhead: number
  enabled?: boolean
}

function nearestPitch(points: PitchPoint[], time: number) {
  let low = 0
  let high = points.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (points[middle].time < time) low = middle + 1
    else high = middle
  }
  const previous = points[low - 1]
  const next = points[low]
  const point = !previous ? next : !next ? previous : Math.abs(previous.time - time) <= Math.abs(next.time - time) ? previous : next
  return point && Math.abs(point.time - time) < 0.08 && point.voiced && point.hz > 0 ? point : null
}

function pitchTrail(points: PitchPoint[], time: number) {
  let low = 0
  let high = points.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (points[middle].time < time - 2) low = middle + 1
    else high = middle
  }
  const trail: PitchPoint[] = []
  for (let index = low; index < points.length && points[index].time <= time; index++) if (points[index].voiced && points[index].hz > 0) trail.push(points[index])
  return trail
}

export function LiveSubtitlePreview({ segments, points, style, mediaRef, playhead, enabled = true }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(640)
  const [time, setTime] = useState(playhead)
  const currentSegment = segments.find(segment => time >= segment.start && time < segment.end)
  const prepared = useMemo(() => currentSegment ? prepareSubtitleTimeline([currentSegment], points) : [], [currentSegment, points])

  useEffect(() => {
    const node = containerRef.current
    if (!node) return
    const resize = new ResizeObserver(() => setWidth(node.clientWidth))
    resize.observe(node)
    return () => resize.disconnect()
  }, [])

  useEffect(() => {
    if (!mediaRef.current?.paused) return
    setTime(playhead)
  }, [playhead, mediaRef])

  useEffect(() => {
    let frame = 0
    let previous = 0
    const tick = (stamp: number) => {
      const media = mediaRef.current
      if (media && !media.paused && stamp - previous >= 25) {
        setTime(media.currentTime)
        previous = stamp
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [mediaRef])

  const scale = width / Math.max(1, style.width)
  const frame = enabled ? subtitleFrameFromTimeline(prepared, time, style) : null
  const pitch = nearestPitch(points, time)
  const trail = pitchTrail(points, time)
  const pitchLabelIndex = frame ? frame.activeIndex >= 0 ? frame.activeIndex : frame.segment.chars.findLastIndex(char => char.end <= time) : -1
  const horizontal = style.horizontalPosition === 'left' ? 'flex-start' : style.horizontalPosition === 'right' ? 'flex-end' : 'center'
  const vertical = style.verticalPosition === 'top' ? 'flex-start' : style.verticalPosition === 'middle' ? 'center' : 'flex-end'
  const textStroke = style.backgroundStyle === 'outline' ? `${Math.max(0, style.outline * scale)}px ${style.outlineColor}` : undefined
  const dotSize = Math.max(8, style.dotSize * scale)

  return <div ref={containerRef} className="pointer-events-none absolute inset-0 overflow-hidden" aria-label="实时字幕与音高预览">
    {frame && <div className="absolute inset-0 flex" style={{ alignItems: vertical, justifyContent: horizontal, padding: `${Math.max(6, style.marginBottom * scale)}px ${Math.max(8, style.marginHorizontal * scale)}px` }}>
      <div className="relative max-w-full whitespace-pre-wrap text-center leading-[1.35]" style={{
        color: style.baseColor, fontFamily: style.fontName, fontSize: Math.max(13, style.fontSize * scale),
        fontWeight: style.bold ? 700 : 400, fontStyle: style.italic ? 'italic' : 'normal',
        letterSpacing: style.spacing * scale, WebkitTextStroke: textStroke,
        backgroundColor: style.backgroundStyle === 'box' ? `${style.backgroundColor}${Math.round(style.backgroundOpacity * 2.55).toString(16).padStart(2, '0')}` : undefined,
        boxShadow: style.shadow ? `0 ${style.shadow * scale}px ${style.shadow * 2 * scale}px #000` : undefined,
      }}>
        {frame.segment.chars.map((char, index) => {
          const gap = frame.segment.text.slice(index ? frame.segment.chars[index - 1].endOffset : 0, char.startOffset)
          return <span key={char.id}>{gap}<span className="relative inline-block" style={{ color: frame.colors[index] }}>
            {char.text}
            {style.showDot && frame.activeIndex === index && <span className="absolute left-1/2 -translate-x-1/2 leading-none" style={{ top: `calc(100% + ${style.dotOffset * scale}px)`, color: frame.dotColor, fontSize: dotSize, WebkitTextStroke: '0px' }}>・</span>}
            {style.showPitch && pitchLabelIndex === index && frame.currentLabel && <span className="absolute bottom-full left-1/2 -translate-x-1/2 whitespace-nowrap leading-none" style={{ color: frame.colors[index], fontSize: Math.max(9, style.fontSize * scale * 0.45), WebkitTextStroke: '0px' }}>{frame.currentLabel}</span>}
          </span></span>
        })}{frame.segment.text.slice(frame.segment.chars.at(-1)?.endOffset ?? 0)}
      </div>
    </div>}
    {enabled && <div className="absolute right-2 top-2 rounded bg-black/65 px-2 py-1 font-mono text-[11px] text-white" aria-label="当前实时音高">
      <div>{pitch ? `${noteName(pitch.hz)} · ${pitch.hz.toFixed(1)} Hz` : 'F0 —'}</div>
      {trail.length > 1 && <svg width="140" height="26" viewBox="0 0 140 26" aria-label="最近两秒音高变化"><polyline fill="none" stroke="#67e8f9" strokeWidth="1.5" points={trail.map(point => `${140 - (time - point.time) * 70},${24 - Math.max(0, Math.min(23, (Math.log2(point.hz / 65) / Math.log2(1100 / 65)) * 23))}`).join(' ')} /></svg>}
    </div>}
  </div>
}
