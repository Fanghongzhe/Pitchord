import type { CharSpan, LyricSegment } from './lyrics'

export type PitchPoint = {
  time: number
  hz: number
  confidence: number
  rms: number
  voiced: boolean
}

export type PitchMotion = 'unvoiced' | 'flat' | 'glide' | 'vibrato'

/** Note times are fractions of the enclosing lyric unit, so they survive timing edits. */
export type PitchAnnotation = {
  motion: PitchMotion
  notes: Array<{ note: string; start: number; end: number }>
}

export type PitchMatch = {
  hz: number | null
  confidence: number
  motion: PitchMotion
  annotation: PitchAnnotation
}

const MIN_HZ = 65
const MAX_HZ = 1100

function median(values: number[]) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/** A local baseline tracker for immediate review. Model adapters can replace this without changing the editor data shape. */
export function analyzeAudioBuffer(buffer: AudioBuffer): PitchPoint[] {
  const sampleRate = buffer.sampleRate
  const length = buffer.length
  const frameSize = 2048
  const hop = 512
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index))
  const points: PitchPoint[] = []
  const minLag = Math.max(2, Math.floor(sampleRate / MAX_HZ))
  const maxLag = Math.min(frameSize - 2, Math.ceil(sampleRate / MIN_HZ))
  let maxRms = 0

  for (let offset = 0; offset + frameSize <= length; offset += hop) {
    const frame = new Float32Array(frameSize)
    let energy = 0
    for (let index = 0; index < frameSize; index++) {
      const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (frameSize - 1))
      let sample = 0
      for (const channel of channels) sample += channel[offset + index] ?? 0
      sample = sample / Math.max(1, channels.length) * window
      frame[index] = sample
      energy += sample * sample
    }
    const rms = Math.sqrt(energy / frameSize)
    maxRms = Math.max(maxRms, rms)
    let bestLag = 0
    let bestCorrelation = 0
    for (let lag = minLag; lag <= maxLag; lag++) {
      let numerator = 0
      let left = 0
      let right = 0
      for (let index = 0; index < frameSize - lag; index += 2) {
        const a = frame[index]
        const b = frame[index + lag]
        numerator += a * b
        left += a * a
        right += b * b
      }
      const correlation = numerator / Math.sqrt(Math.max(1e-12, left * right))
      if (correlation > bestCorrelation) { bestCorrelation = correlation; bestLag = lag }
    }
    const voiced = bestLag > 0 && bestCorrelation >= 0.45 && rms >= 0.008
    points.push({ time: (offset + frameSize / 2) / sampleRate, hz: voiced ? sampleRate / bestLag : 0, confidence: bestCorrelation, rms, voiced })
  }

  const threshold = Math.max(0.008, maxRms * 0.04)
  return points.map(point => point.rms >= threshold ? point : { ...point, hz: 0, voiced: false })
}

const midiFor = (hz: number) => 69 + 12 * Math.log2(hz / 440)
const midiNote = (midi: number) => {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  return `${names[(midi + 1200) % 12]}${Math.floor(midi / 12) - 1}`
}

export function noteHz(note: string): number | null {
  const match = /^([A-G])(#?)([0-8])$/.exec(note.replace('♯', '#').toUpperCase())
  if (!match) return null
  const semitone = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[match[1] as 'C']
  const midi = (Number(match[3]) + 1) * 12 + semitone + (match[2] ? 1 : 0)
  return 440 * 2 ** ((midi - 69) / 12)
}

export function pitchNotation(annotation: PitchAnnotation) {
  if (!annotation.notes.length) return '—'
  const notes = annotation.notes.map(item => item.note).join('-')
  return annotation.motion === 'vibrato' ? `${notes}~` : notes
}

export function parsePitchNotation(input: string, previous?: PitchAnnotation): PitchAnnotation | null {
  const compact = input.trim().replace(/\s+/g, '').replaceAll('♯', '#').toUpperCase()
  if (compact === '—' || compact === '-' || compact === '') return { motion: 'unvoiced', notes: [] }
  const vibrato = compact.endsWith('~')
  const body = vibrato ? compact.slice(0, -1) : compact
  const names = body.split('-')
  if (!names.length || names.some(name => noteHz(name) === null) || (vibrato && names.length !== 1)) return null
  const boundaries = previous?.notes.length === names.length
    ? previous.notes.map(item => item.end)
    : names.map((_, index) => (index + 1) / names.length)
  return { motion: vibrato ? 'vibrato' : names.length > 1 ? 'glide' : 'flat', notes: names.map((note, index) => ({ note, start: index ? boundaries[index - 1] : 0, end: boundaries[index] })) }
}

export function validPitchAnnotation(value: unknown): value is PitchAnnotation {
  if (!value || typeof value !== 'object') return false
  const annotation = value as PitchAnnotation
  if (!['unvoiced', 'flat', 'glide', 'vibrato'].includes(annotation.motion) || !Array.isArray(annotation.notes)) return false
  if (annotation.motion === 'unvoiced') return annotation.notes.length === 0
  if (!annotation.notes.length || annotation.notes.length > 32) return false
  if (annotation.motion === 'flat' && annotation.notes.length !== 1) return false
  if (annotation.motion === 'glide' && annotation.notes.length < 2) return false
  if (annotation.motion === 'vibrato' && annotation.notes.length !== 1) return false
  if (Math.abs(annotation.notes[0].start) > 1e-6 || Math.abs(annotation.notes.at(-1)!.end - 1) > 1e-6) return false
  return annotation.notes.every((item, index) => noteHz(item.note) !== null && Number.isFinite(item.start) && Number.isFinite(item.end) && item.start >= 0 && item.end <= 1 && item.end > item.start && (index === 0 || Math.abs(item.start - annotation.notes[index - 1].end) < 1e-6))
}

function isVibrato(times: number[], midi: number[]) {
  if (times.length < 12 || times.at(-1)! - times[0] < 0.42) return false
  const baseline = median(midi)
  const deviations = midi.map(value => (value - baseline) * 100)
  const extrema: Array<{ time: number; sign: number; size: number }> = []
  for (let index = 1; index < deviations.length - 1; index++) {
    const value = deviations[index]
    if (Math.abs(value) < 25) continue
    if ((value > deviations[index - 1] && value >= deviations[index + 1]) || (value < deviations[index - 1] && value <= deviations[index + 1])) {
      const sign = Math.sign(value)
      const last = extrema.at(-1)
      if (last?.sign === sign) {
        if (Math.abs(value) > last.size) extrema[extrema.length - 1] = { time: times[index], sign, size: Math.abs(value) }
      } else extrema.push({ time: times[index], sign, size: Math.abs(value) })
    }
  }
  if (extrema.length < 5 || Math.max(...extrema.map(item => item.size)) > 175) return false
  const fullPeriods = extrema.slice(2).map((item, index) => item.time - extrema[index].time)
  const mean = fullPeriods.reduce((sum, value) => sum + value, 0) / fullPeriods.length
  if (mean < 1 / 9 || mean > 1 / 3) return false
  const spread = Math.sqrt(fullPeriods.reduce((sum, value) => sum + (value - mean) ** 2, 0) / fullPeriods.length) / mean
  return spread < 0.38
}

function annotationFromPoints(start: number, end: number, points: PitchPoint[]): PitchAnnotation {
  const voiced = points.filter(point => point.time >= start && point.time < end && point.voiced && point.hz >= MIN_HZ && point.hz <= MAX_HZ && point.confidence >= 0.25)
  if (!voiced.length) return { motion: 'unvoiced', notes: [] }
  const raw = voiced.map(point => midiFor(point.hz))
  const smoothed = raw.map((_value, index) => {
    const local = median(raw.slice(Math.max(0, index - 2), Math.min(raw.length, index + 3)))
    return local
  })
  const base = midiNote(Math.round(voiced.length < 5 ? raw[0] : median(smoothed)))
  if (isVibrato(voiced.map(item => item.time), smoothed)) return { motion: 'vibrato', notes: [{ note: base, start: 0, end: 1 }] }
  if (voiced.length < 5 || end - start < 0.22) return { motion: 'flat', notes: [{ note: base, start: 0, end: 1 }] }

  const states = smoothed.map(value => Math.round(value))
  const step = median(voiced.slice(1).map((item, index) => item.time - voiced[index].time).filter(value => value > 0)) || 0.02
  const minimumRun = Math.max(0.12, step * 4)
  // A pitch estimate that lasts only a few frames is not a new sung note.
  for (let pass = 0; pass < 3; pass++) {
    const runs: Array<{ from: number; to: number; note: number }> = []
    for (let index = 0; index < states.length;) {
      let next = index + 1
      while (next < states.length && states[next] === states[index]) next++
      runs.push({ from: index, to: next, note: states[index] })
      index = next
    }
    let changed = false
    for (let index = 0; index < runs.length; index++) {
      const run = runs[index]
      const duration = voiced[run.to - 1].time - voiced[run.from].time + step
      if (duration >= minimumRun) continue
      const left = runs[index - 1]
      const right = runs[index + 1]
      const neighbor = left && right ? (Math.abs(left.note - run.note) <= Math.abs(right.note - run.note) ? left : right) : left ?? right
      if (!neighbor) continue
      for (let position = run.from; position < run.to; position++) states[position] = neighbor.note
      changed = true
    }
    if (!changed) break
  }
  const runs: Array<{ from: number; to: number; note: number }> = []
  for (let index = 0; index < states.length;) {
    let next = index + 1
    while (next < states.length && states[next] === states[index]) next++
    runs.push({ from: index, to: next, note: states[index] })
    index = next
  }
  if (runs.length < 2 || runs.length > 12) return { motion: 'flat', notes: [{ note: base, start: 0, end: 1 }] }
  const boundaries = runs.slice(0, -1).map(run => Math.min(1, Math.max(0, ((voiced[run.to - 1].time + voiced[run.to].time) / 2 - start) / Math.max(0.001, end - start))))
  return { motion: 'glide', notes: runs.map((run, index) => ({ note: midiNote(run.note), start: index ? boundaries[index - 1] : 0, end: index === runs.length - 1 ? 1 : boundaries[index] })) }
}

export function pitchForChar(char: CharSpan, points: PitchPoint[]): PitchAnnotation {
  return validPitchAnnotation(char.pitchOverride) ? char.pitchOverride : annotationFromPoints(char.start, char.end, points)
}

export function matchPitchToChars(segments: LyricSegment[], points: PitchPoint[]): Record<string, PitchMatch> {
  const result: Record<string, PitchMatch> = {}
  for (const segment of segments) {
    for (const char of segment.chars) {
      const inside = points.filter(point => point.time >= char.start && point.time < char.end)
      const voiced = inside.filter(point => point.voiced && point.hz > 0)
      const annotation = annotationFromPoints(char.start, char.end, inside)
      result[char.id] = voiced.length ? {
        hz: median(voiced.map(point => point.hz)),
        confidence: voiced.reduce((sum, point) => sum + point.confidence, 0) / voiced.length,
        motion: annotation.motion,
        annotation,
      } : { hz: null, confidence: 0, motion: 'unvoiced', annotation }
    }
  }
  return result
}

export function noteName(hz: number | null) {
  if (!hz || hz <= 0) return '—'
  return midiNote(Math.round(midiFor(hz)))
}
