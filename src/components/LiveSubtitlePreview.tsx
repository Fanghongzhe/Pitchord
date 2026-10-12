import { useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { LyricSegment } from '@/lib/lyrics'
import { type PitchPoint } from '@/lib/pitch'
import { pitchColor, prepareSubtitleTimeline, rawPitchAt, rawPitchLabel, rawPitchPlacement, subtitleFrameFromTimeline, type SubtitleStyle } from '@/lib/subtitles'

type Props = {
  segments: LyricSegment[]
  points: PitchPoint[]
  style: SubtitleStyle
  mediaRef: RefObject<HTMLMediaElement | null>
  playhead: number
  enabled?: boolean
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
  const [size, setSize] = useState({ width: 640, height: 360 })
  const [time, setTime] = useState(playhead)
  const currentSegment = segments.find(segment => time >= segment.start && time < segment.end)
  const prepared = useMemo(() => currentSegment ? prepareSubtitleTimeline([currentSegment], points) : [], [currentSegment, points])

  useEffect(() => {
    const node = containerRef.current
    if (!node) return
    const resize = new ResizeObserver(() => setSize({ width: node.clientWidth, height: node.clientHeight }))
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

  const scale = size.width / Math.max(1, style.width)
  const scaleY = size.height / Math.max(1, style.height)
  const frame = enabled ? subtitleFrameFromTimeline(prepared, time, style) : null
  const pitch = rawPitchAt(points, time)
  const trail = style.embedRawPitch ? [] : pitchTrail(points, time)
  const rawPlacement = rawPitchPlacement(style)
  const horizontal = style.horizontalPosition === 'left' ? 'flex-start' : style.horizontalPosition === 'right' ? 'flex-end' : 'center'
  const vertical = style.verticalPosition === 'top' ? 'flex-start' : style.verticalPosition === 'middle' ? 'center' : 'flex-end'
  const textStroke = style.backgroundStyle === 'outline' ? `${Math.max(0, style.outline * scale)}px ${style.outlineColor}` : undefined
  const dotDiameter = Math.max(3, style.dotSize * scale / 4)

  return <div ref={containerRef} className="pointer-events-none absolute inset-0 overflow-hidden" aria-label="实时字幕与音高预览">
    {frame && <div className="absolute inset-0 flex" style={{ alignItems: vertical, justifyContent: horizontal, padding: `${Math.max(6, style.marginBottom * scale)}px ${Math.max(8, style.marginHorizontal * scale)}px` }}>
      <div className="relative max-w-full whitespace-pre-wrap text-center" style={{
        color: style.baseColor, fontFamily: style.fontName, fontSize: Math.max(13, style.fontSize * scale),
        fontWeight: style.bold ? 700 : 400, fontStyle: style.italic ? 'italic' : 'normal',
        letterSpacing: style.spacing * scale, lineHeight: 1, WebkitTextStroke: textStroke,
        backgroundColor: style.backgroundStyle === 'box' ? `${style.backgroundColor}${Math.round(style.backgroundOpacity * 2.55).toString(16).padStart(2, '0')}` : undefined,
        boxShadow: style.shadow ? `0 ${style.shadow * scale}px ${style.shadow * 2 * scale}px #000` : undefined,
      }}>
        {frame.segment.chars.map((char, index) => {
          const gap = frame.segment.text.slice(index ? frame.segment.chars[index - 1].endOffset : 0, char.startOffset)
          return <span key={char.id}>{gap}<span className="relative inline-block" style={{ color: frame.colors[index], lineHeight: 1 }}>
            {frame.segment.text.slice(char.startOffset, char.endOffset) || char.text}
            {style.showDot && frame.activeIndex === index && <span className="absolute left-1/2 -translate-x-1/2 rounded-full" style={{ top: `calc(100% + ${(style.dotOffset - 2) * scale}px)`, backgroundColor: frame.dotColor, width: dotDiameter, height: dotDiameter, WebkitTextStroke: '0px' }} />}
            {style.showPitch && frame.labels[index] && <span className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap leading-none" style={{ bottom: `calc(100% - ${style.fontSize * scale * 0.18}px)`, color: frame.labelColors[index], fontSize: Math.max(9, style.fontSize * scale * 0.45), WebkitTextStroke: '0px' }}>{frame.labels[index]}</span>}
          </span></span>
        })}{frame.segment.text.slice(frame.segment.chars.at(-1)?.endOffset ?? 0)}
      </div>
    </div>}
    {enabled && style.embedRawPitch && pitch && <div className="absolute whitespace-nowrap rounded bg-black/65 font-bold leading-none" aria-label="当前实时音高" style={{
      left: rawPlacement.x * scale, top: rawPlacement.y * scaleY,
      transform: `translate(${style.rawPitchHorizontalPosition === 'left' ? '0' : style.rawPitchHorizontalPosition === 'right' ? '-100%' : '-50%'}, ${style.rawPitchVerticalPosition === 'top' ? '0' : style.rawPitchVerticalPosition === 'bottom' ? '-100%' : '-50%'})`,
      color: pitchColor(pitch.hz, style), fontFamily: style.fontName, fontSize: Math.max(8, style.rawPitchFontSize * scaleY), padding: `${Math.max(2, 5 * scaleY)}px ${Math.max(3, 8 * scale)}px`,
    }}>{rawPitchLabel(pitch)}</div>}
    {enabled && !style.embedRawPitch && <div className="absolute right-2 top-2 rounded bg-black/65 px-2 py-1 font-mono text-[11px] text-white" aria-label="当前实时音高">
      <div className="text-[9px] text-white/70">原始 F0 · 仅供校对</div>
      <div>{pitch ? rawPitchLabel(pitch) : 'F0 —'}</div>
      {trail.length > 1 && <svg width="140" height="26" viewBox="0 0 140 26" aria-label="最近两秒音高变化"><polyline fill="none" stroke="#67e8f9" strokeWidth="1.5" points={trail.map(point => `${140 - (time - point.time) * 70},${24 - Math.max(0, Math.min(23, (Math.log2(point.hz / 65) / Math.log2(1100 / 65)) * 23))}`).join(' ')} /></svg>}
    </div>}
  </div>
}
