import { describe, expect, it } from 'vitest'
import { createSegment, retimeSegment } from './lyrics'
import { generatePitchAss, wordTimedSubtitles } from './subtitles'

describe('word timed subtitle export', () => {
  it('keeps the edited timing for every lyric unit', () => {
    const segment = createSegment('你 好', 1, 3)
    segment.chars[0].end = 1.6
    segment.chars[1].start = 2.1
    const output = wordTimedSubtitles([segment])
    expect(output[0].words).toEqual([
      { text: '你', start: 1, end: 1.6 },
      { text: '好', start: 2.1, end: 3 },
    ])
  })

  it('creates pitch labels, emphasis dots and a highlighted active unit', () => {
    const segment = createSegment('你好', 1, 3)
    const output = generatePitchAss([segment], [
      { time: 1.1, hz: 440, confidence: 0.9, rms: 0.2, voiced: true },
      { time: 1.7, hz: 493.88, confidence: 0.9, rms: 0.2, voiced: true },
    ])
    expect(output).toContain('A4')
    expect(output).toContain('・')
    expect(output).toContain('Dialogue: 0,0:00:01.00')
    expect(output).toMatch(/\\c&H[0-9A-F]{8}&/)
  })

  it('keeps the final pitch state until the next unit starts', () => {
    const segment = createSegment('你好', 0, 2)
    segment.chars[0].end = 0.5
    segment.chars[1].start = 1.25
    const output = generatePitchAss([segment], [
      { time: 0.2, hz: 440, confidence: 1, rms: 0.2, voiced: true },
    ])
    expect(output).toContain('0:00:01.25,Pitch')
  })

  it('exports the same manually edited pitch sequence and durations to JSON and ASS', () => {
    const segment = createSegment('唱', 1, 2)
    segment.chars[0].pitchOverride = { motion: 'glide', notes: [
      { note: 'E4', start: 0, end: 0.2 },
      { note: 'F4', start: 0.2, end: 0.7 },
      { note: 'E4', start: 0.7, end: 1 },
    ] }
    const json = wordTimedSubtitles([segment])[0].words[0]
    expect(json.pitch?.notation).toBe('E4-F4-E4')
    expect(json.pitch?.notes.map(note => [note.start, note.end])).toEqual([[1, 1.2], [1.2, 1.7], [1.7, 2]])
    const ass = generatePitchAss([segment], [])
    expect(ass).toContain('0:00:01.00,0:00:01.20,Pitch')
    expect(ass).toContain('0:00:01.20,0:00:01.70,Pitch')
    expect(ass).toContain('0:00:01.70,0:00:02.00,Pitch')
    expect(ass.match(/}E4\n/g)).toHaveLength(2)
    expect(ass.match(/}F4\n/g)).toHaveLength(1)
    const shifted = retimeSegment(segment, 2, 4)
    expect(wordTimedSubtitles([shifted])[0].words[0].pitch?.notes[0].end).toBe(2.4)
  })

  it('uses a single vibrato label rather than changing note on every pitch sample', () => {
    const segment = createSegment('唱', 0, 1)
    segment.chars[0].pitchOverride = { motion: 'vibrato', notes: [{ note: 'E4', start: 0, end: 1 }] }
    const ass = generatePitchAss([segment], [])
    expect(ass).toContain('}E4~')
    expect(ass.match(/,Pitch,/g)).toHaveLength(1)
  })
})
