import type { PitchPoint } from './pitch'

export type PitchGuideDensity = 'semitone' | 'natural' | 'whole' | 'octave'
export type PitchViewSettings = {
  guides: boolean
  density: PitchGuideDensity
  autoFitLine: boolean
  lowMidi: number
  highMidi: number
  waveformGain: number
  trackHeight: number
}

export const defaultPitchViewSettings: PitchViewSettings = {
  guides: false,
  density: 'natural',
  autoFitLine: false,
  lowMidi: 36,
  highMidi: 85,
  waveformGain: 1,
  trackHeight: 112,
}

export function normalizePitchViewSettings(value: unknown): PitchViewSettings {
  if (!value || typeof value !== 'object') return { ...defaultPitchViewSettings }
  const settings = value as Partial<PitchViewSettings>
  const lowMidi = Number.isFinite(settings.lowMidi) ? Math.min(92, Math.max(36, Math.round(settings.lowMidi!))) : defaultPitchViewSettings.lowMidi
  const highMidi = Number.isFinite(settings.highMidi) ? Math.min(96, Math.max(lowMidi + 4, Math.round(settings.highMidi!))) : defaultPitchViewSettings.highMidi
  return {
    guides: typeof settings.guides === 'boolean' ? settings.guides : defaultPitchViewSettings.guides,
    density: ['semitone', 'natural', 'whole', 'octave'].includes(settings.density ?? '') ? settings.density! : defaultPitchViewSettings.density,
    autoFitLine: typeof settings.autoFitLine === 'boolean' ? settings.autoFitLine : defaultPitchViewSettings.autoFitLine,
    lowMidi,
    highMidi,
    waveformGain: Number.isFinite(settings.waveformGain) ? Math.min(8, Math.max(1, Number(settings.waveformGain))) : 1,
    trackHeight: Number.isFinite(settings.trackHeight) ? Math.min(480, Math.max(112, Math.round(Number(settings.trackHeight)))) : defaultPitchViewSettings.trackHeight,
  }
}

const pitchNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
export const pitchMidi = (hz: number) => 69 + 12 * Math.log2(hz / 440)
export const pitchMidiName = (midi: number) => `${pitchNames[((Math.round(midi) % 12) + 12) % 12]}${Math.floor(Math.round(midi) / 12) - 1}`

export function pitchGuideMidis(low: number, high: number, density: PitchGuideDensity) {
  const values: number[] = []
  for (let midi = Math.ceil(low); midi <= Math.floor(high); midi++) {
    const semitone = ((midi % 12) + 12) % 12
    if (density === 'octave' && semitone !== 0) continue
    if (density === 'whole' && semitone % 2 !== 0) continue
    if (density === 'natural' && [1, 3, 6, 8, 10].includes(semitone)) continue
    values.push(midi)
  }
  return values
}

export function pitchViewY(midi: number, low: number, high: number, height = 112) {
  return height - 10 - (midi - low) / Math.max(1, high - low) * (height - 24)
}

export function autoPitchViewRange(points: PitchPoint[], start: number, end: number): [number, number] | null {
  const values = points.filter(point => point.voiced && point.hz >= 65 && point.hz <= 1100 && point.time >= start && point.time < end)
    .map(point => pitchMidi(point.hz)).sort((a, b) => a - b)
  if (!values.length) return null
  const lower = values[Math.floor((values.length - 1) * 0.05)]
  const upper = values[Math.ceil((values.length - 1) * 0.95)]
  let low = Math.max(36, Math.floor(lower - 3))
  let high = Math.min(96, Math.ceil(upper + 3))
  if (high - low < 8) {
    const center = Math.round((low + high) / 2)
    low = Math.max(36, center - 4)
    high = Math.min(96, low + 8)
  }
  return [low, high]
}
