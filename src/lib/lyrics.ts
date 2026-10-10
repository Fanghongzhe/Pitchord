import type { PitchAnnotation } from './pitch'

export type CharSpan = {
  id: string
  text: string
  startOffset: number
  endOffset: number
  start: number
  end: number
  origin: 'estimated' | 'manual'
  pitchOverride?: PitchAnnotation
  timingEvidence?: {
    source: 'asr' | 'interpolated' | 'lrc' | 'punctuation'
    asrProbability?: number
    matched: boolean
  }
  startLocked?: boolean
  endLocked?: boolean
}

export type LyricSegment = {
  id: string
  text: string
  start: number
  end: number
  chars: CharSpan[]
  timingSource?: 'lrc' | 'estimated' | 'manual'
}

export const MIN_SPAN = 0.04

const id = () => crypto.randomUUID()
export const roundTime = (value: number) => Math.round(value * 1000) / 1000
export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export function formatTime(seconds: number) {
  const ms = Math.max(0, Math.round(seconds * 1000))
  const mins = Math.floor(ms / 60000)
  const secs = Math.floor((ms % 60000) / 1000)
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`
}

export function parseTime(value: string): number | null {
  const match = value.trim().match(/^(?:(\d+):)?(\d{1,2})(?:[.:](\d{1,3}))?$/)
  if (!match) return null
  const mins = Number(match[1] ?? 0)
  const secs = Number(match[2])
  const fraction = match[3] ? Number(match[3].padEnd(3, '0')) / 1000 : 0
  return mins * 60 + secs + fraction
}

export function lyricUnits(text: string) {
  return Array.from(text.matchAll(/[\p{Script=Han}]|[A-Za-z]+(?:['’-][A-Za-z]+)*|\d+|[^\s]/gu), match => ({
    text: match[0],
    startOffset: match.index,
    endOffset: match.index + match[0].length,
  }))
}

export function estimateChars(text: string, start: number, end: number): CharSpan[] {
  const units = lyricUnits(text)
  const duration = Math.max(0, end - start)
  return units.map((unit, index) => ({
    id: id(),
    ...unit,
    start: roundTime(start + duration * index / units.length),
    end: roundTime(start + duration * (index + 1) / units.length),
    origin: 'estimated' as const,
  }))
}

export function createSegment(text: string, start: number, end: number): LyricSegment {
  const clean = text.trim()
  const a = roundTime(start)
  const b = roundTime(end)
  return { id: id(), text: clean, start: a, end: b, chars: estimateChars(clean, a, b) }
}

/** Keep the latest human pitch edits when applying a stored timing suggestion. */
export function carryPitchOverrides(next: LyricSegment[], current: LyricSegment[]): LyricSegment[] {
  const existing = new Map(current.flatMap(segment => segment.chars.map(char => [char.id, char] as const)))
  return next.map(segment => ({
    ...segment,
    chars: segment.chars.map(char => {
      const previous = existing.get(char.id)
      return previous?.text === char.text ? { ...char, pitchOverride: previous.pitchOverride } : { ...char, pitchOverride: undefined }
    }),
  }))
}

export function retimeSegment(segment: LyricSegment, start: number, end: number): LyricSegment {
  const a = roundTime(start)
  const b = roundTime(end)
  const oldDuration = segment.end - segment.start
  const map = (time: number) => oldDuration <= 0 ? a : roundTime(a + ((time - segment.start) / oldDuration) * (b - a))
  return {
    ...segment, start: a, end: b, timingSource: 'manual',
    chars: segment.chars.map(char => ({ ...char, start: clamp(map(char.start), a, b), end: clamp(map(char.end), a, b) })),
  }
}

export function replaceText(segment: LyricSegment, text: string): LyricSegment {
  const oldUnits = lyricUnits(segment.text)
  const newUnits = lyricUnits(text)
  let prefix = 0
  while (prefix < oldUnits.length && prefix < newUnits.length && oldUnits[prefix].text === newUnits[prefix].text) prefix++
  let suffix = 0
  while (suffix < oldUnits.length - prefix && suffix < newUnits.length - prefix && oldUnits[oldUnits.length - 1 - suffix].text === newUnits[newUnits.length - 1 - suffix].text) suffix++
  const left = newUnits.slice(0, prefix).map((unit, index) => ({ ...segment.chars[index], ...unit }))
  const right = newUnits.slice(newUnits.length - suffix).map((unit, index) => ({ ...segment.chars[oldUnits.length - suffix + index], ...unit }))
  const middle = newUnits.slice(prefix, newUnits.length - suffix)
  const middleStart = left.length ? left[left.length - 1].end : segment.start
  const middleEnd = right.length ? right[0].start : segment.end
  if (middle.length && middleEnd - middleStart < middle.length * 0.001) {
    const redistributed = estimateChars(text, segment.start, segment.end).map((char, index) => {
      if (index < prefix) return { ...char, id: segment.chars[index].id, pitchOverride: segment.chars[index].pitchOverride }
      if (index >= newUnits.length - suffix) {
        const previous = segment.chars[oldUnits.length - (newUnits.length - index)]
        return { ...char, id: previous.id, pitchOverride: previous.pitchOverride }
      }
      return char
    })
    return { ...segment, text, chars: redistributed }
  }
  const inserted = middle.map((unit, index) => ({
    id: id(), ...unit,
    start: roundTime(middleStart + (middleEnd - middleStart) * index / middle.length),
    end: roundTime(middleStart + (middleEnd - middleStart) * (index + 1) / middle.length),
    origin: 'estimated' as const,
  }))
  return { ...segment, text, chars: [...left, ...inserted, ...right] }
}

function partitionChars(chars: CharSpan[], offset: number, start: number, end: number) {
  if (!chars.length) return []
  const first = chars[0].start
  const last = chars[chars.length - 1].end
  const span = Math.max(0.001, last - first)
  return chars.map(char => ({
    ...char,
    startOffset: char.startOffset - offset,
    endOffset: char.endOffset - offset,
    start: roundTime(start + (char.start - first) / span * (end - start)),
    end: roundTime(start + (char.end - first) / span * (end - start)),
  }))
}

export function splitSegment(segment: LyricSegment, splitTime: number, textOffset: number): [LyricSegment, LyricSegment] | null {
  if (splitTime <= segment.start + MIN_SPAN || splitTime >= segment.end - MIN_SPAN) return null
  if (textOffset <= 0 || textOffset >= segment.text.length) return null
  const leftText = segment.text.slice(0, textOffset).trimEnd()
  const rightText = segment.text.slice(textOffset).trimStart()
  if (!leftText || !rightText) return null
  const t = roundTime(splitTime)
  const leftChars = segment.chars.filter(char => char.endOffset <= textOffset)
  const rightChars = segment.chars.filter(char => char.startOffset >= textOffset)
  const rightOffset = segment.text.length - segment.text.slice(textOffset).trimStart().length
  return [
    { id: id(), text: leftText, start: segment.start, end: t, timingSource: 'manual', chars: leftChars.length ? partitionChars(leftChars, 0, segment.start, t) : estimateChars(leftText, segment.start, t) },
    { id: id(), text: rightText, start: t, end: segment.end, timingSource: 'manual', chars: rightChars.length ? partitionChars(rightChars, rightOffset, t, segment.end) : estimateChars(rightText, t, segment.end) },
  ]
}

const BREAK_PUNCTUATION = /[，。！？；：、,.!?;:]/u
const CLOSING_PUNCTUATION = /[”’」』】）》〉]/u

export function suggestSplitOffset(text: string, boundaries: number[], position: number) {
  if (!boundaries.length) return null
  const firstNaturalBreak = boundaries.find(offset => {
    const previous = text[offset - 1] ?? ''
    const beforePrevious = text[offset - 2] ?? ''
    const next = text[offset] ?? ''
    return BREAK_PUNCTUATION.test(previous) ||
      (CLOSING_PUNCTUATION.test(previous) && BREAK_PUNCTUATION.test(beforePrevious)) ||
      /\s/u.test(previous) || /\s/u.test(next)
  })
  if (firstNaturalBreak !== undefined) return firstNaturalBreak
  const target = clamp(position, 0, 1) * text.length
  return boundaries.reduce((best, offset) => {
    const score = Math.abs(offset - target)
    return score < best.score ? { offset, score } : best
  }, { offset: boundaries[0], score: Number.POSITIVE_INFINITY }).offset
}

function joinText(parts: string[]) {
  return parts.map(part => part.trim()).filter(Boolean).join(' ')
}

export function mergeSegments(parts: LyricSegment[]): LyricSegment | null {
  if (parts.length < 2) return null
  const text = joinText(parts.map(part => part.text))
  let offset = 0
  const chars: CharSpan[] = []
  for (const part of parts) {
    const joinOffset = text.indexOf(part.text, offset)
    chars.push(...part.chars.map(char => ({ ...char, startOffset: char.startOffset + joinOffset, endOffset: char.endOffset + joinOffset })))
    offset = joinOffset + part.text.length
  }
  return { id: id(), text, start: parts[0].start, end: parts[parts.length - 1].end, timingSource: 'manual', chars }
}

export function parseLyrics(input: string, duration: number): LyricSegment[] {
  const lines = input.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const timed: { start: number; text: string }[] = []
  const plain: string[] = []
  for (const line of lines) {
    if (/^\[(ar|al|ti|by|offset|length):/i.test(line)) continue
    const tags = Array.from(line.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g))
    const text = line.replace(/\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/g, '').trim()
    if (!text) continue
    if (tags.length) {
      for (const tag of tags) timed.push({ start: Number(tag[1]) * 60 + Number(tag[2]) + Number((tag[3] ?? '0').padEnd(3, '0')) / 1000, text })
    } else if (!/^\[[^\]]+\]$/.test(line)) plain.push(text)
  }
  if (timed.length) {
    timed.sort((a, b) => a.start - b.start)
    return timed.filter(item => item.start <= duration - MIN_SPAN).map((item, index) => {
      const next = timed[index + 1]?.start ?? duration
      const end = Math.max(item.start + MIN_SPAN, Math.min(duration, next - 0.001))
      return { ...createSegment(item.text, item.start, end), timingSource: 'lrc' }
    })
  }
  if (!plain.length || duration <= 0) return []
  const slot = duration / plain.length
  return plain.map((text, index) => ({ ...createSegment(text, index * slot, Math.min(duration, (index + 1) * slot)), timingSource: 'estimated' }))
}

export function getAdjacentSelection(segments: LyricSegment[], ids: string[]) {
  const indexes = ids.map(id => segments.findIndex(segment => segment.id === id)).filter(index => index >= 0).sort((a, b) => a - b)
  return indexes.length >= 2 && indexes.every((index, order) => order === 0 || index === indexes[order - 1] + 1) ? indexes : null
}
