import { describe, expect, it } from 'vitest'
import { createSegment } from './lyrics'
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
})
