import type { LyricSegment } from './lyrics'

export type PitchPoint = {
  time: number
  hz: number
  confidence: number
  rms: number
  voiced: boolean
}

export type PitchMotion = 'unvoiced' | 'flat' | 'glide' | 'vibrato'

export type PitchMatch = {
  hz: number | null
  confidence: number
  motion: PitchMotion
}

const MIN_HZ = 65
const MAX_HZ = 1100

function median(values: number[]) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function cents(a: number, b: number) {
  return 1200 * Math.log2(Math.max(1, a) / Math.max(1, b))
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

function motionFor(points: PitchPoint[]): PitchMotion {
  const voiced = points.filter(point => point.voiced && point.hz > 0)
  if (!voiced.length) return 'unvoiced'
  if (voiced.length < 3) return 'flat'
  const jumps = voiced.slice(1).map((point, index) => cents(point.hz, voiced[index].hz))
  const range = Math.max(...voiced.map(point => point.hz)) / Math.max(1, Math.min(...voiced.map(point => point.hz)))
  const signChanges = jumps.slice(1).filter((jump, index) => Math.sign(jump) !== Math.sign(jumps[index]) && Math.abs(jump) > 8).length
  if (signChanges >= 3 && range > 1.02) return 'vibrato'
  if (Math.abs(cents(voiced.at(-1)!.hz, voiced[0].hz)) >= 90) return 'glide'
  return 'flat'
}

export function matchPitchToChars(segments: LyricSegment[], points: PitchPoint[]): Record<string, PitchMatch> {
  const result: Record<string, PitchMatch> = {}
  for (const segment of segments) {
    for (const char of segment.chars) {
      const inside = points.filter(point => point.time >= char.start && point.time < char.end)
      const voiced = inside.filter(point => point.voiced && point.hz > 0)
      result[char.id] = voiced.length ? {
        hz: median(voiced.map(point => point.hz)),
        confidence: voiced.reduce((sum, point) => sum + point.confidence, 0) / voiced.length,
        motion: motionFor(inside),
      } : { hz: null, confidence: 0, motion: 'unvoiced' }
    }
  }
  return result
}

export function noteName(hz: number | null) {
  if (!hz || hz <= 0) return '—'
  const midi = Math.round(69 + 12 * Math.log2(hz / 440))
  const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
  return `${names[(midi + 1200) % 12]}${Math.floor(midi / 12) - 1}`
}
