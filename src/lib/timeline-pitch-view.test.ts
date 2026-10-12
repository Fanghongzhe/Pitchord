import { describe, expect, it } from 'vitest'
import { autoPitchViewRange, defaultPitchViewSettings, normalizePitchViewSettings, pitchGuideMidis, pitchMidiName, pitchViewY } from './timeline-pitch-view'

describe('pitch timeline display settings', () => {
  it('labels exact note guides at selectable densities', () => {
    expect(pitchMidiName(60)).toBe('C4')
    expect(pitchMidiName(62)).toBe('D4')
    expect(pitchGuideMidis(60, 72, 'semitone')).toHaveLength(13)
    expect(pitchGuideMidis(60, 72, 'natural').map(pitchMidiName)).toEqual(['C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B4', 'C5'])
    expect(pitchGuideMidis(60, 72, 'octave').map(pitchMidiName)).toEqual(['C4', 'C5'])
  })

  it('changes only view coordinates, with a robust suggested range for a line', () => {
    expect(pitchViewY(62, 48, 72)).toBeGreaterThan(pitchViewY(62, 56, 64))
    expect(pitchViewY(62, 48, 72, 320)).toBeGreaterThan(pitchViewY(62, 48, 72, 112))
    const points = Array.from({ length: 40 }, (_, index) => ({ time: index * 0.01, hz: 440, confidence: 0.9, rms: 0.1, voiced: true }))
    points.push({ time: 0.4, hz: 1046.5, confidence: 0.9, rms: 0.1, voiced: true })
    expect(autoPitchViewRange(points, 0, 0.41)).toEqual([65, 73])
    expect(points[0].hz).toBe(440)
  })

  it('recalculates the suggested range when a line is widened or split', () => {
    const points = [
      ...Array.from({ length: 10 }, (_, index) => ({ time: index * 0.02, hz: 220, confidence: 0.9, rms: 0.1, voiced: true })),
      ...Array.from({ length: 10 }, (_, index) => ({ time: 1 + index * 0.02, hz: 880, confidence: 0.9, rms: 0.1, voiced: true })),
    ]
    expect(autoPitchViewRange(points, 0, 0.5)).toEqual([53, 61])
    expect(autoPitchViewRange(points, 0, 1.5)).toEqual([54, 84])
    expect(autoPitchViewRange(points, 1, 1.5)).toEqual([77, 85])
  })

  it('rejects malformed saved display preferences', () => {
    expect(normalizePitchViewSettings(null)).toEqual(defaultPitchViewSettings)
    expect(normalizePitchViewSettings({ guides: true, density: 'bad', autoFitLine: true, lowMidi: 95, highMidi: 1, waveformGain: 999, trackHeight: 999 })).toEqual({ guides: true, density: 'natural', autoFitLine: true, lowMidi: 92, highMidi: 96, waveformGain: 8, trackHeight: 480 })
  })
})
