import type { LyricSegment } from './lyrics'
import { noteHz, noteName, pitchForChar, pitchNotation, type PitchAnnotation, type PitchPoint } from './pitch'

export type PitchColorBand = 'rainbow' | 'cool' | 'warm' | 'custom' | 'ranges'
export const pitchColorBandNames: Record<PitchColorBand, string> = {
  rainbow: '音高彩虹', cool: '冷色渐变', warm: '暖色渐变', custom: '双端自定义', ranges: '分段音域',
}
export type PitchColorRule = {
  id: string
  fromMidi: number
  toMidi: number
  includeEnd: boolean
  mode: 'solid' | 'linear'
  lowColor: string
  highColor: string
}
export type SubtitleVerticalPosition = 'top' | 'middle' | 'bottom'
export type SubtitleHorizontalPosition = 'left' | 'center' | 'right'
export type SubtitleBackgroundStyle = 'outline' | 'box' | 'none'

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
  marginHorizontal: number
  verticalPosition: SubtitleVerticalPosition
  horizontalPosition: SubtitleHorizontalPosition
  bold: boolean
  italic: boolean
  spacing: number
  shadow: number
  backgroundStyle: SubtitleBackgroundStyle
  backgroundColor: string
  backgroundOpacity: number
  fadeMs: number
  colorBand: PitchColorBand
  colorRules?: PitchColorRule[]
  rangeFallback?: 'base' | 'rainbow' | 'cool' | 'warm'
  showDot: boolean
  showPitch: boolean
  dotSize: number
  dotOffset: number
  dotColorMode: 'pitch' | 'custom'
  dotColor: string
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
  marginHorizontal: 80,
  verticalPosition: 'bottom',
  horizontalPosition: 'center',
  bold: true,
  italic: false,
  spacing: 0,
  shadow: 1,
  backgroundStyle: 'outline',
  backgroundColor: '#000000',
  backgroundOpacity: 65,
  fadeMs: 80,
  colorBand: 'rainbow',
  colorRules: [],
  rangeFallback: 'base',
  showDot: true,
  showPitch: true,
  dotSize: 32,
  dotOffset: 0,
  dotColorMode: 'pitch',
  dotColor: '#FFFFFF',
}

export type WordTimedSubtitle = {
  text: string
  start: number
  end: number
  words: Array<{ text: string; start: number; end: number; pitch?: { notation: string; motion: PitchAnnotation['motion']; notes: Array<{ note: string; start: number; end: number }> } }>
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
  const midi = 69 + 12 * Math.log2(Math.max(1, hz) / 440)
  if (style.colorBand === 'ranges') {
    const note = Math.round(midi)
    const rule = style.colorRules?.find(item => item.fromMidi < item.toMidi && note >= item.fromMidi && (note < item.toMidi || item.includeEnd && note === item.toMidi))
    if (rule) return rule.mode === 'solid' ? rule.lowColor : interpolateColor(rule.lowColor, rule.highColor, (midi - rule.fromMidi) / Math.max(1, rule.toMidi - rule.fromMidi))
    if (!style.rangeFallback || style.rangeFallback === 'base') return style.baseColor
    return pitchColor(hz, { ...style, colorBand: style.rangeFallback })
  }
  const normalized = clamp01((midi - 36) / 48)
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

export function detectedPitchRange(points: PitchPoint[]) {
  const voiced = points.filter(point => point.voiced && point.hz >= 65 && point.hz <= 1100)
  const trusted = voiced.filter(point => point.confidence >= 0.5)
  const usable = trusted.length ? trusted : voiced
  if (!usable.length) return null
  let minHz = Number.POSITIVE_INFINITY
  let maxHz = 0
  for (const point of usable) {
    minHz = Math.min(minHz, point.hz)
    maxHz = Math.max(maxHz, point.hz)
  }
  return {
    minHz, maxHz, count: usable.length,
    minMidi: Math.round(69 + 12 * Math.log2(minHz / 440)),
    maxMidi: Math.round(69 + 12 * Math.log2(maxHz / 440)),
  }
}

export function recommendedPitchColorRules(range: ReturnType<typeof detectedPitchRange> = null): PitchColorRule[] {
  return [
    { id: 'cool', fromMidi: Math.min(48, range?.minMidi ?? 48), toMidi: 60, includeEnd: false, mode: 'linear', lowColor: '#22D3EE', highColor: '#A78BFA' },
    { id: 'gray', fromMidi: 60, toMidi: 64, includeEnd: false, mode: 'solid', lowColor: '#9CA3AF', highColor: '#9CA3AF' },
    { id: 'warm', fromMidi: 64, toMidi: Math.max(74, range?.maxMidi ?? 74), includeEnd: true, mode: 'linear', lowColor: '#FDE047', highColor: '#F43F5E' },
  ]
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

function srtTime(seconds: number) {
  const milliseconds = Math.max(0, Math.round(seconds * 1000))
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor(milliseconds / 60_000) % 60
  const secs = Math.floor(milliseconds / 1000) % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(milliseconds % 1000).padStart(3, '0')}`
}

function escapeAss(text: string) {
  return text.replace(/\\/g, '＼').replace(/{/g, '｛').replace(/}/g, '｝').replace(/\r?\n/g, '\\N')
}

type TimedNote = { start: number; end: number; hz: number; label: string }
type TimedPitch = { time: number; hz: number }

function timedNotes(word: LyricSegment['chars'][number], points: PitchPoint[]): TimedNote[] {
  const annotation = pitchForChar(word, points)
  return annotation.notes.map((note, index) => ({
    start: word.start + (word.end - word.start) * note.start,
    end: word.start + (word.end - word.start) * note.end,
    hz: noteHz(note.note) ?? 0,
    label: annotation.motion === 'vibrato' && index === 0 ? `${note.note}~` : note.note,
  }))
}

function noteAt(notes: TimedNote[], time: number): TimedNote | null {
  if (!notes.length) return null
  return notes.find(note => time >= note.start && time < note.end) ?? (time < notes[0].start ? notes[0] : notes[notes.length - 1])
}

function sampledPitch(word: LyricSegment['chars'][number], points: PitchPoint[]): TimedPitch[] {
  if (word.pitchOverride) return []
  const voiced = points.filter(point => point.time >= word.start && point.time < word.end && point.voiced && point.hz > 0)
  const sampled: TimedPitch[] = []
  for (const point of voiced) {
    if (!sampled.length || point.time - sampled[sampled.length - 1].time >= 0.08) sampled.push({ time: point.time, hz: point.hz })
  }
  const last = voiced.at(-1)
  if (last && sampled.at(-1)?.time !== last.time) sampled.push({ time: last.time, hz: last.hz })
  return sampled
}

function pitchAt(samples: TimedPitch[], time: number): TimedPitch | null {
  if (!samples.length || time < samples[0].time) return null
  let low = 0
  let high = samples.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (samples[middle].time <= time) low = middle + 1
    else high = middle
  }
  return samples[Math.max(0, low - 1)]
}

export type SubtitleFrame = {
  segment: LyricSegment
  activeIndex: number
  colors: string[]
  currentHz: number | null
  currentLabel: string
  progress: number
  dotColor: string
}

export type PreparedSubtitleSegment = { segment: LyricSegment; notes: TimedNote[][]; samples: TimedPitch[][] }

export function prepareSubtitleTimeline(segments: LyricSegment[], points: PitchPoint[]): PreparedSubtitleSegment[] {
  return segments.map(segment => ({ segment, notes: segment.chars.map(char => timedNotes(char, points)), samples: segment.chars.map(char => sampledPitch(char, points)) }))
}

function frameForSegment(segment: LyricSegment, time: number, style: SubtitleStyle, notes: TimedNote[][], samples: TimedPitch[][]): SubtitleFrame {
  const activeIndex = segment.chars.findIndex(char => time >= char.start && time < char.end)
  const colors = notes.map((items, index) => {
    if (time < segment.chars[index].start) return style.baseColor
    if (samples[index].length) {
      const sample = pitchAt(samples[index], time)
      return sample ? pitchColor(sample.hz, style) : style.baseColor
    }
    const note = noteAt(items, time)
    return note?.hz ? pitchColor(note.hz, style) : style.baseColor
  })
  const activeChar = segment.chars[activeIndex]
  const currentNote = activeIndex >= 0 ? noteAt(notes[activeIndex], time) : null
  const previousIndex = segment.chars.findLastIndex(char => char.end <= time)
  const heldNote = currentNote ?? (previousIndex >= 0 ? noteAt(notes[previousIndex], time) : null)
  const heldSample = activeIndex >= 0 ? pitchAt(samples[activeIndex], time) : previousIndex >= 0 ? pitchAt(samples[previousIndex], time) : null
  const waitingForVoice = activeIndex >= 0 && samples[activeIndex].length > 0 && !heldSample
  return {
    segment, activeIndex, colors,
    currentHz: waitingForVoice ? null : heldSample?.hz ?? heldNote?.hz ?? null,
    currentLabel: waitingForVoice ? '' : heldSample ? noteName(heldSample.hz) : heldNote?.label ?? '',
    progress: activeChar ? clamp01((time - activeChar.start) / Math.max(0.001, activeChar.end - activeChar.start)) : 0,
    dotColor: style.dotColorMode === 'custom' ? style.dotColor : activeIndex >= 0 ? colors[activeIndex] : style.baseColor,
  }
}

export function subtitleFrameFromTimeline(prepared: PreparedSubtitleSegment[], time: number, partialStyle: Partial<SubtitleStyle> = {}): SubtitleFrame | null {
  const style = { ...defaultSubtitleStyle, ...partialStyle }
  const item = prepared.find(({ segment }) => time >= segment.start && time < segment.end)
  if (!item || !item.segment.chars.length) return null
  return frameForSegment(item.segment, time, style, item.notes, item.samples)
}

export function subtitleFrameAt(segments: LyricSegment[], points: PitchPoint[], time: number, partialStyle: Partial<SubtitleStyle> = {}): SubtitleFrame | null {
  return subtitleFrameFromTimeline(prepareSubtitleTimeline(segments, points), time, partialStyle)
}

function textWidth(text: string, style: SubtitleStyle, context: CanvasRenderingContext2D | null) {
  const glyphWidth = context
    ? context.measureText(text).width
    : Array.from(text).reduce((sum, glyph) => sum + style.fontSize * (/\s/u.test(glyph) ? 0.33 : (glyph.codePointAt(0) ?? 0) < 128 ? 0.6 : 1), 0)
  return glyphWidth + Math.max(0, Array.from(text).length - 1) * style.spacing
}

function measurementContext(style: SubtitleStyle): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null
  const context = document.createElement('canvas').getContext('2d')
  if (context) context.font = `${style.italic ? 'italic ' : ''}${style.bold ? '700' : '400'} ${style.fontSize}px ${JSON.stringify(style.fontName)}`
  return context
}

export function subtitleUnitCenterX(segment: LyricSegment, charIndex: number, style: SubtitleStyle, context: CanvasRenderingContext2D | null = measurementContext(style)) {
  const char = segment.chars[charIndex]
  const prefix = segment.text.slice(0, char.startOffset)
  const through = segment.text.slice(0, char.endOffset)
  const totalWidth = textWidth(segment.text, style, context)
  const lineLeft = style.horizontalPosition === 'left'
    ? style.marginHorizontal
    : style.horizontalPosition === 'right'
      ? style.width - style.marginHorizontal - totalWidth
      : style.width / 2 - totalWidth / 2
  return Math.round(lineLeft + (textWidth(prefix, style, context) + textWidth(through, style, context)) / 2)
}

function lineCenterX(segment: LyricSegment, style: SubtitleStyle, context: CanvasRenderingContext2D | null) {
  const width = textWidth(segment.text, style, context)
  if (style.horizontalPosition === 'left') return style.marginHorizontal + width / 2
  if (style.horizontalPosition === 'right') return style.width - style.marginHorizontal - width / 2
  return style.width / 2
}

function alignment(style: SubtitleStyle) {
  const horizontal = style.horizontalPosition === 'left' ? 1 : style.horizontalPosition === 'right' ? 3 : 2
  const vertical = style.verticalPosition === 'top' ? 6 : style.verticalPosition === 'middle' ? 3 : 0
  return horizontal + vertical
}

function lineBounds(style: SubtitleStyle) {
  const top = style.verticalPosition === 'top'
    ? style.marginBottom
    : style.verticalPosition === 'middle'
      ? (style.height - style.fontSize) / 2
      : style.height - style.marginBottom - style.fontSize
  return { top: Math.round(top), bottom: Math.round(top + style.fontSize) }
}

function lineAnchorY(style: SubtitleStyle) {
  if (style.verticalPosition === 'top') return style.marginBottom
  if (style.verticalPosition === 'middle') return style.height / 2
  return style.height - style.marginBottom
}

function unitAlignment(style: SubtitleStyle) {
  return style.verticalPosition === 'top' ? 8 : style.verticalPosition === 'middle' ? 5 : 2
}

function boxDrawing(width: number, height: number) {
  return `m 0 0 l ${width} 0 ${width} ${height} 0 ${height}`
}

function dotDrawing(size: number) {
  const diameter = Math.max(3, Math.round(size / 4))
  const radius = diameter / 2
  const tangent = radius * 0.55228475
  const n = (value: number) => Math.round(value * 10) / 10
  return `m ${n(radius)} 0 b ${n(radius + tangent)} 0 ${diameter} ${n(radius - tangent)} ${diameter} ${n(radius)} b ${diameter} ${n(radius + tangent)} ${n(radius + tangent)} ${diameter} ${n(radius)} ${diameter} b ${n(radius - tangent)} ${diameter} 0 ${n(radius + tangent)} 0 ${n(radius)} b 0 ${n(radius - tangent)} ${n(radius - tangent)} 0 ${n(radius)} 0`
}

function backgroundAlpha(opacity: number) {
  return Math.round(255 * (1 - clamp01(opacity / 100))).toString(16).padStart(2, '0')
}

export function wordTimedSubtitles(segments: LyricSegment[], points: PitchPoint[] = []): WordTimedSubtitle[] {
  return segments.map(segment => ({
    text: segment.text,
    start: segment.start,
    end: segment.end,
    words: segment.chars.map(word => {
      const annotation = pitchForChar(word, points)
      return {
        text: word.text, start: word.start, end: word.end,
        ...((points.length || word.pitchOverride) ? { pitch: {
          notation: pitchNotation(annotation), motion: annotation.motion,
          notes: annotation.notes.map(item => ({ note: item.note, start: word.start + (word.end - word.start) * item.start, end: word.start + (word.end - word.start) * item.end })),
        } } : {}),
      }
    }),
  }))
}

export function sentenceSrt(segments: LyricSegment[]) {
  return segments.map((segment, index) => `${index + 1}\n${srtTime(segment.start)} --> ${srtTime(segment.end)}\n${segment.text}`).join('\n\n') + (segments.length ? '\n' : '')
}

export function generatePitchAss(segments: LyricSegment[], points: PitchPoint[], partialStyle: Partial<SubtitleStyle> = {}) {
  const style = { ...defaultSubtitleStyle, ...partialStyle }
  const borderStyle = 1
  const mainOutline = style.backgroundStyle === 'none' ? 0 : style.outline
  const mainShadow = style.backgroundStyle === 'none' ? 0 : style.shadow
  const backColor = assColor(style.backgroundColor, backgroundAlpha(style.backgroundOpacity))
  const bold = style.bold ? -1 : 0
  const italic = style.italic ? -1 : 0
  const assAlignment = alignment(style)
  const header = `[Script Info]\nTitle: Pitchord word timed subtitles\nScriptType: v4.00+\nPlayResX: ${style.width}\nPlayResY: ${style.height}\nScaledBorderAndShadow: yes\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Main,${style.fontName},${style.fontSize},${assColor(style.baseColor)},${assColor(style.baseColor)},${assColor(style.outlineColor)},${backColor},${bold},${italic},0,0,100,100,${style.spacing},0,${borderStyle},${mainOutline},${mainShadow},${assAlignment},${style.marginHorizontal},${style.marginHorizontal},${style.marginBottom},1\nStyle: Pitch,${style.fontName},${Math.round(style.fontSize * 0.45)},${assColor(style.baseColor)},${assColor(style.baseColor)},${assColor(style.outlineColor)},${backColor},${bold},${italic},0,0,100,100,0,0,1,${Math.max(1, style.outline - 1)},0,2,10,10,10,1\nStyle: Dot,${style.fontName},${style.dotSize},${assColor(style.baseColor)},${assColor(style.baseColor)},${assColor(style.outlineColor)},${backColor},${bold},0,0,0,100,100,0,0,1,${Math.max(1, style.outline - 1)},0,8,10,10,10,1\nStyle: Back,${style.fontName},${style.fontSize},${backColor},${backColor},${backColor},${backColor},0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`
  const events: string[] = []
  const context = measurementContext(style)
  const bounds = lineBounds(style)
  for (const segment of segments) {
    if (!segment.chars.length) continue
    const notes = segment.chars.map(char => timedNotes(char, points))
    const samples = segment.chars.map(char => sampledPitch(char, points))
    const unitCenters = segment.chars.map((_, index) => subtitleUnitCenterX(segment, index, style, context))
    const anchorY = lineAnchorY(style)
    const boxPadding = Math.max(6, style.outline * 2)
    const boxWidth = Math.round(textWidth(segment.text, style, context) + boxPadding * 2)
    const boxHeight = Math.round(style.fontSize + boxPadding * 2)
    const boxX = Math.round(lineCenterX(segment, style, context))
    const boxY = Math.round((bounds.top + bounds.bottom) / 2)
    const boundaries = [...new Set([
      segment.start, segment.end,
      ...segment.chars.flatMap(char => [char.start, char.end]),
      ...notes.flatMap(items => items.flatMap(item => [item.start, item.end])),
      ...samples.flatMap(items => items.map(item => item.time)),
    ])].filter(time => time >= segment.start && time <= segment.end).sort((a, b) => a - b)
    for (let index = 0; index < boundaries.length - 1; index++) {
      const from = boundaries[index]
      const to = boundaries[index + 1]
      if (to - from < 0.005) continue
      const frame = frameForSegment(segment, (from + to) / 2, style, notes, samples)
      const start = assTime(from)
      const end = assTime(to)
      const fadeMs = Math.min(style.fadeMs, Math.max(0, Math.round((to - from) * 400)))
      const edgeFade = fadeMs > 0 && (index === 0 || index === boundaries.length - 2)
        ? `{\\fad(${index === 0 ? fadeMs : 0},${index === boundaries.length - 2 ? fadeMs : 0})}` : ''
      if (style.backgroundStyle === 'box') {
        events.push(`Dialogue: 0,${start},${end},Back,,0,0,0,,${edgeFade}{\\an5\\pos(${boxX},${boxY})\\p1}${boxDrawing(boxWidth, boxHeight)}`)
      }
      for (const [charIndex, char] of segment.chars.entries()) {
        const unitX = unitCenters[charIndex]
        const content = escapeAss(segment.text.slice(char.startOffset, char.endOffset) || char.text)
        events.push(`Dialogue: 0,${start},${end},Main,,0,0,0,,${edgeFade}{\\an${unitAlignment(style)}\\pos(${unitX},${anchorY})\\c${assColor(frame.colors[charIndex])}&}${content}`)
      }
      const labelIndex = frame.activeIndex >= 0 ? frame.activeIndex : segment.chars.findLastIndex(char => char.end <= from)
      if (labelIndex < 0) continue
      const x = unitCenters[labelIndex]
      const activeColor = frame.colors[labelIndex]
      if (style.showPitch && frame.currentLabel) events.push(`Dialogue: 1,${start},${end},Pitch,,0,0,0,,{\\pos(${x},${bounds.top + Math.round(style.fontSize * 0.18)})\\c${assColor(activeColor)}&}${escapeAss(frame.currentLabel)}`)
      if (frame.activeIndex >= 0 && style.showDot) {
        const diameter = Math.max(3, Math.round(style.dotSize / 4))
        const dotY = bounds.bottom + style.dotOffset + diameter / 2 - 2
        events.push(`Dialogue: 1,${start},${end},Dot,,0,0,0,,{\\an5\\pos(${x},${dotY})\\p1\\c${assColor(frame.dotColor)}&}${dotDrawing(style.dotSize)}`)
      }
    }
  }
  return `${header}\n${events.join('\n')}\n`
}
