import type { LyricSegment } from './lyrics'
import { noteName, type PitchPoint } from './pitch'

export type PitchColorBand = 'rainbow' | 'cool' | 'warm' | 'custom'

export type SubtitleStyle = {
  width: number
  height: number
  fontName: string
  fontSize: number
  baseColor: string
  outlineColor: string
  lowColor: string
  highColor: string
  outline: number
  marginBottom: number
  colorBand: PitchColorBand
  showDot: boolean
  showPitch: boolean
}

export const defaultSubtitleStyle: SubtitleStyle = {
  width: 1920,
  height: 1080,
  fontName: 'Microsoft YaHei',
  fontSize: 58,
  baseColor: '#F8FAFC',
  outlineColor: '#111827',
  lowColor: '#38BDF8',
  highColor: '#FB7185',
  outline: 3,
  marginBottom: 96,
  colorBand: 'rainbow',
  showDot: true,
  showPitch: true,
}

export type WordTimedSubtitle = {
  text: string
  start: number
  end: number
  words: Array<{ text: string; start: number; end: number }>
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

function hexRgb(hex: string) {
  const clean = hex.replace('#', '').padEnd(6, '0').slice(0, 6)
  return [Number.parseInt(clean.slice(0, 2), 16), Number.parseInt(clean.slice(2, 4), 16), Number.parseInt(clean.slice(4, 6), 16)]
}

function rgbHex(red: number, green: number, blue: number) {
  return `#${[red, green, blue].map(value => Math.round(value).toString(16).padStart(2, '0')).join('')}`
}

function interpolateColor(from: string, to: string, amount: number) {
  const a = hexRgb(from)
  const b = hexRgb(to)
  const t = clamp01(amount)
  return rgbHex(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)
}

export function pitchColor(hz: number, style: SubtitleStyle) {
  const normalized = clamp01((69 + 12 * Math.log2(Math.max(65, hz) / 440) - 36) / 48)
  if (style.colorBand === 'custom') return interpolateColor(style.lowColor, style.highColor, normalized)
  if (style.colorBand === 'cool') return interpolateColor('#22D3EE', '#A78BFA', normalized)
  if (style.colorBand === 'warm') return interpolateColor('#FDE047', '#F43F5E', normalized)
  const hue = 220 - normalized * 220
  const saturation = 82
  const lightness = 62
  const chroma = (1 - Math.abs(2 * lightness / 100 - 1)) * saturation / 100
  const section = hue / 60
  const x = chroma * (1 - Math.abs(section % 2 - 1))
  const [r1, g1, b1] = section < 1 ? [chroma, x, 0] : section < 2 ? [x, chroma, 0] : section < 3 ? [0, chroma, x] : [0, x, chroma]
  const match = lightness / 100 - chroma / 2
  return rgbHex((r1 + match) * 255, (g1 + match) * 255, (b1 + match) * 255)
}

function assColor(hex: string, alpha = '00') {
  const [red, green, blue] = hexRgb(hex)
  return `&H${alpha}${blue.toString(16).padStart(2, '0')}${green.toString(16).padStart(2, '0')}${red.toString(16).padStart(2, '0')}`.toUpperCase()
}

function assTime(seconds: number) {
  const centiseconds = Math.max(0, Math.round(seconds * 100))
  const hours = Math.floor(centiseconds / 360000)
  const minutes = Math.floor(centiseconds / 6000) % 60
  const secs = Math.floor(centiseconds / 100) % 60
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`
}

function escapeAss(text: string) {
  return text.replace(/\\/g, '＼').replace(/{/g, '｛').replace(/}/g, '｝').replace(/\r?\n/g, '\\N')
}

function displayedText(segment: LyricSegment, activeId: string, color: string) {
  let cursor = 0
  let output = ''
  for (const word of segment.chars) {
    output += escapeAss(segment.text.slice(cursor, word.startOffset))
    const content = escapeAss(segment.text.slice(word.startOffset, word.endOffset) || word.text)
    output += word.id === activeId ? `{\\c${assColor(color)}&}${content}{\\r}` : content
    cursor = word.endOffset
  }
  return output + escapeAss(segment.text.slice(cursor))
}

function activeX(segment: LyricSegment, charIndex: number, style: SubtitleStyle) {
  const before = segment.chars.slice(0, charIndex).reduce((sum, item) => sum + Array.from(item.text).length, 0)
  const current = Math.max(1, Array.from(segment.chars[charIndex].text).length)
  const total = Math.max(1, segment.chars.reduce((sum, item) => sum + Array.from(item.text).length, 0))
  const estimatedWidth = Math.min(style.width * 0.86, total * style.fontSize)
  return Math.round(style.width / 2 - estimatedWidth / 2 + estimatedWidth * (before + current / 2) / total)
}

function charPitchSlices(start: number, end: number, points: PitchPoint[]) {
  const voiced = points.filter(point => point.voiced && point.hz > 0 && point.time >= start && point.time < end)
  if (!voiced.length) return [{ start, end, hz: 0 }]
  const slices: Array<{ start: number; end: number; hz: number }> = []
  let sliceStart = start
  let lastHz = voiced[0].hz
  for (const point of voiced) {
    if (point.time > sliceStart + 0.035 && Math.abs(1200 * Math.log2(point.hz / lastHz)) >= 18) {
      slices.push({ start: sliceStart, end: point.time, hz: lastHz })
      sliceStart = point.time
    }
    lastHz = point.hz
  }
  slices.push({ start: sliceStart, end, hz: lastHz })
  return slices.filter(slice => slice.end - slice.start >= 0.005)
}

export function wordTimedSubtitles(segments: LyricSegment[]): WordTimedSubtitle[] {
  return segments.map(segment => ({
    text: segment.text,
    start: segment.start,
    end: segment.end,
    words: segment.chars.map(word => ({ text: word.text, start: word.start, end: word.end })),
  }))
}

export function generatePitchAss(segments: LyricSegment[], points: PitchPoint[], partialStyle: Partial<SubtitleStyle> = {}) {
  const style = { ...defaultSubtitleStyle, ...partialStyle }
  const header = `[Script Info]\nTitle: Pitchord word timed subtitles\nScriptType: v4.00+\nPlayResX: ${style.width}\nPlayResY: ${style.height}\nScaledBorderAndShadow: yes\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Main,${style.fontName},${style.fontSize},${assColor(style.baseColor)},${assColor(style.baseColor)},${assColor(style.outlineColor)},&H80000000,-1,0,0,0,100,100,0,0,1,${style.outline},1,2,40,40,${style.marginBottom},1\nStyle: Pitch,${style.fontName},${Math.round(style.fontSize * 0.45)},${assColor(style.baseColor)},${assColor(style.baseColor)},${assColor(style.outlineColor)},&H80000000,-1,0,0,0,100,100,0,0,1,${Math.max(1, style.outline - 1)},0,2,10,10,10,1\nStyle: Dot,${style.fontName},${Math.round(style.fontSize * 0.55)},${assColor(style.baseColor)},${assColor(style.baseColor)},${assColor(style.outlineColor)},&H80000000,-1,0,0,0,100,100,0,0,1,${Math.max(1, style.outline - 1)},0,8,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`
  const events: string[] = []
  for (const segment of segments) {
    segment.chars.forEach((word, index) => {
      const nextStart = segment.chars[index + 1]?.start ?? segment.end
      const displayEnd = Math.max(word.end, nextStart)
      const slices = charPitchSlices(word.start, word.end, points)
      const x = activeX(segment, index, style)
      const lineY = style.height - style.marginBottom
      slices[slices.length - 1].end = displayEnd
      for (const slice of slices) {
        const color = slice.hz > 0 ? pitchColor(slice.hz, style) : style.baseColor
        const start = assTime(slice.start)
        const end = assTime(slice.end)
        events.push(`Dialogue: 0,${start},${end},Main,,0,0,0,,${displayedText(segment, word.id, color)}`)
        if (style.showPitch && slice.hz > 0) events.push(`Dialogue: 1,${start},${end},Pitch,,0,0,0,,{\\pos(${x},${lineY - style.fontSize - 16})\\c${assColor(color)}&}${escapeAss(noteName(slice.hz))}`)
        if (style.showDot) events.push(`Dialogue: 1,${start},${end},Dot,,0,0,0,,{\\pos(${x},${lineY + Math.round(style.fontSize * 0.72)})\\c${assColor(color)}&}・`)
      }
    })
  }
  return `${header}\n${events.join('\n')}\n`
}
