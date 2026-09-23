import { describe, expect, it } from 'vitest'
import { createSegment } from './lyrics'
import { analyzeAudioBuffer, matchPitchToChars, noteName } from './pitch'

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
})

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
