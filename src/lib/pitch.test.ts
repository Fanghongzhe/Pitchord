import { describe, expect, it } from 'vitest'
import { createSegment } from './lyrics'
import { analyzeAudioBuffer, matchPitchToChars, noteName, parsePitchNotation, pitchNotation, validPitchAnnotation } from './pitch'

describe('pitch analysis matching', () => {
  it('formats detected frequencies as note names', () => {
    expect(noteName(440)).toBe('A4')
    expect(noteName(null)).toBe('—')
  })

  it('tracks a clean sustained tone as a continuous voiced pitch', () => {
    const sampleRate = 16000
    const data = Float32Array.from({ length: sampleRate }, (_, index) => 0.25 * Math.sin(2 * Math.PI * 440 * index / sampleRate))
    const buffer = { sampleRate, length: data.length, numberOfChannels: 1, getChannelData: () => data } as unknown as AudioBuffer
    const points = analyzeAudioBuffer(buffer)
    const voiced = points.filter(point => point.voiced)
    expect(voiced.length).toBeGreaterThan(10)
    expect(median(voiced.map(point => point.hz))).toBeGreaterThan(430)
    expect(median(voiced.map(point => point.hz))).toBeLessThan(450)
  })

  it('matches voiced points to the correct character range', () => {
    const segment = createSegment('你好', 0, 2)
    const matches = matchPitchToChars([segment], [
      { time: 0.25, hz: 440, confidence: 0.9, rms: 0.1, voiced: true },
      { time: 1.25, hz: 523.25, confidence: 0.8, rms: 0.1, voiced: true },
    ])
    expect(matches[segment.chars[0].id].hz).toBe(440)
    expect(matches[segment.chars[1].id].hz).toBe(523.25)
  })

  it('marks a character with no voiced sample as unvoiced', () => {
    const segment = createSegment('字', 0, 1)
    const matches = matchPitchToChars([segment], [{ time: 0.5, hz: 0, confidence: 0, rms: 0.001, voiced: false }])
    expect(matches[segment.chars[0].id].motion).toBe('unvoiced')
  })

  it('does not turn a stable tone with jitter or one brief pitch error into a run of notes', () => {
    const segment = createSegment('唱', 0, 1)
    const points = Array.from({ length: 100 }, (_, index) => {
      const cents = index >= 50 && index < 53 ? 200 : Math.sin(index * 1.7) * 17
      return { time: (index + 0.5) / 100, hz: 440 * 2 ** (cents / 1200), confidence: 0.9, rms: 0.2, voiced: true }
    })
    expect(pitchNotation(matchPitchToChars([segment], points)[segment.chars[0].id].annotation)).toBe('A4')
  })

  it('does not split a half-second steady tone that straddles a semitone boundary', () => {
    const segment = createSegment('唱', 0, 0.55)
    const points = Array.from({ length: 55 }, (_, index) => ({
      time: (index + 0.5) / 100,
      hz: 440 * 2 ** ((46.5 + Math.sin(index * 0.8) * 0.16 - 69) / 12),
      confidence: 0.9, rms: 0.2, voiced: true,
    }))
    expect(matchPitchToChars([segment], points)[segment.chars[0].id].annotation.notes).toHaveLength(1)
  })

  it('merges all sub-120ms alternating note runs, not just the first three passes', () => {
    const segment = createSegment('唱', 0, 0.55)
    const points = Array.from({ length: 55 }, (_, index) => ({
      time: (index + 0.5) / 100,
      hz: 440 * 2 ** (((Math.floor(index / 5) % 2 ? 46 : 47) - 69) / 12),
      confidence: 0.9, rms: 0.2, voiced: true,
    }))
    const annotation = matchPitchToChars([segment], points)[segment.chars[0].id].annotation
    expect(annotation.notes.length).toBeLessThanOrEqual(4)
    expect(annotation.notes.every(note => (note.end - note.start) * 0.55 >= 0.119)).toBe(true)
  })

  it('separates sustained note changes from periodic vibrato', () => {
    const segment = createSegment('唱', 0, 1)
    const glide = Array.from({ length: 100 }, (_, index) => ({
      time: (index + 0.5) / 100,
      hz: index < 30 || index >= 65 ? 329.63 : 349.23,
      confidence: 0.9, rms: 0.2, voiced: true,
    }))
    expect(pitchNotation(matchPitchToChars([segment], glide)[segment.chars[0].id].annotation)).toBe('E4-F4-E4')
    const vibrato = Array.from({ length: 100 }, (_, index) => ({
      time: (index + 0.5) / 100,
      hz: 329.63 * 2 ** (55 * Math.sin(2 * Math.PI * 5 * index / 100) / 1200),
      confidence: 0.9, rms: 0.2, voiced: true,
    }))
    expect(pitchNotation(matchPitchToChars([segment], vibrato)[segment.chars[0].id].annotation)).toBe('E4~')
  })

  it('parses editable shorthand and keeps valid note timing', () => {
    const annotation = parsePitchNotation('E4-F4-E4')!
    expect(annotation.notes).toHaveLength(3)
    expect(validPitchAnnotation(annotation)).toBe(true)
    expect(pitchNotation(parsePitchNotation('E4~')!)).toBe('E4~')
    expect(parsePitchNotation('E4~F4')).toBeNull()
  })
})

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
