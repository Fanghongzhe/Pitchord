import type { LyricSegment } from './lyrics'
import { noteHz, pitchForChar, pitchNotation, type PitchAnnotation, type PitchPoint } from './pitch'

export type PitchColorBand = 'rainbow' | 'cool' | 'warm' | 'custom'
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
  showDot: true,
  showPitch: true,
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
  const lineLeft = style.horizontalPosition === 'left'
    ? style.marginHorizontal
    : style.horizontalPosition === 'right'
      ? style.width - style.marginHorizontal - estimatedWidth
      : style.width / 2 - estimatedWidth / 2
  return Math.round(lineLeft + estimatedWidth * (before + current / 2) / total)
}

function alignment(style: SubtitleStyle) {
  const horizontal = style.horizontalPosition === 'left' ? 1 : style.horizontalPosition === 'right' ? 3 : 2
  const vertical = style.verticalPosition === 'top' ? 6 : style.verticalPosition === 'middle' ? 3 : 0
  return horizontal + vertical
}

function lineY(style: SubtitleStyle) {
  if (style.verticalPosition === 'top') return style.marginBottom + style.fontSize
  if (style.verticalPosition === 'middle') return Math.round(style.height / 2)
  return style.height - style.marginBottom
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
  const borderStyle = style.backgroundStyle === 'box' ? 3 : 1
  const mainOutline = style.backgroundStyle === 'none' ? 0 : style.backgroundStyle === 'box' ? Math.max(6, style.outline * 2) : style.outline
  const mainShadow = style.backgroundStyle === 'none' ? 0 : style.shadow
  const backColor = assColor(style.backgroundColor, backgroundAlpha(style.backgroundOpacity))
  const bold = style.bold ? -1 : 0
  const italic = style.italic ? -1 : 0
  const assAlignment = alignment(style)
  const header = `[Script Info]\nTitle: Pitchord word timed subtitles\nScriptType: v4.00+\nPlayResX: ${style.width}\nPlayResY: ${style.height}\nScaledBorderAndShadow: yes\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Main,${style.fontName},${style.fontSize},${assColor(style.baseColor)},${assColor(style.baseColor)},${assColor(style.outlineColor)},${backColor},${bold},${italic},0,0,100,100,${style.spacing},0,${borderStyle},${mainOutline},${mainShadow},${assAlignment},${style.marginHorizontal},${style.marginHorizontal},${style.marginBottom},1\nStyle: Pitch,${style.fontName},${Math.round(style.fontSize * 0.45)},${assColor(style.baseColor)},${assColor(style.baseColor)},${assColor(style.outlineColor)},${backColor},${bold},${italic},0,0,100,100,0,0,1,${Math.max(1, style.outline - 1)},0,2,10,10,10,1\nStyle: Dot,${style.fontName},${Math.round(style.fontSize * 0.55)},${assColor(style.baseColor)},${assColor(style.baseColor)},${assColor(style.outlineColor)},${backColor},${bold},0,0,0,100,100,0,0,1,${Math.max(1, style.outline - 1)},0,8,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`
  const events: string[] = []
  const fade = style.fadeMs > 0 ? `{\\fad(${Math.round(style.fadeMs)},${Math.round(style.fadeMs)})}` : ''
  for (const segment of segments) {
    segment.chars.forEach((word, index) => {
      const nextStart = segment.chars[index + 1]?.start ?? segment.end
      const displayEnd = Math.max(word.end, nextStart)
      const annotation = pitchForChar(word, points)
      const slices = annotation.notes.length ? annotation.notes.map((item, noteIndex) => ({
        start: word.start + (word.end - word.start) * item.start,
        end: word.start + (word.end - word.start) * item.end,
        hz: noteHz(item.note) ?? 0,
        label: annotation.motion === 'vibrato' && noteIndex === 0 ? `${item.note}~` : item.note,
      })) : [{ start: word.start, end: word.end, hz: 0, label: '' }]
      const x = activeX(segment, index, style)
      const activeLineY = lineY(style)
      slices[slices.length - 1].end = displayEnd
      for (const slice of slices) {
        const color = slice.hz > 0 ? pitchColor(slice.hz, style) : style.baseColor
        const start = assTime(slice.start)
        const end = assTime(slice.end)
        events.push(`Dialogue: 0,${start},${end},Main,,0,0,0,,${fade}${displayedText(segment, word.id, color)}`)
        if (style.showPitch && slice.hz > 0) events.push(`Dialogue: 1,${start},${end},Pitch,,0,0,0,,${fade}{\\pos(${x},${activeLineY - style.fontSize - 16})\\c${assColor(color)}&}${escapeAss(slice.label)}`)
        if (style.showDot) events.push(`Dialogue: 1,${start},${end},Dot,,0,0,0,,${fade}{\\pos(${x},${activeLineY + Math.round(style.fontSize * 0.72)})\\c${assColor(color)}&}・`)
      }
    })
  }
  return `${header}\n${events.join('\n')}\n`
}
