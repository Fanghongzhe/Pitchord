import { describe, expect, it } from 'vitest'
import { createSegment, retimeSegment } from './lyrics'
import { defaultSubtitleStyle, detectedPitchRange, generatePitchAss, pitchColor, recommendedPitchColorRules, sentenceSrt, subtitleFrameAt, subtitleUnitCenterX, wordTimedSubtitles } from './subtitles'

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
    expect(output).toContain('\\p1')
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
    expect(subtitleFrameAt([segment], [], 0.8)?.activeIndex).toBe(-1)
    expect(output).not.toContain('Dialogue: 1,0:00:00.50,0:00:01.25,Dot')
  })

  it('starts future glyphs in the base color and holds each sung glyph at its final pitch', () => {
    const segment = createSegment('你好', 0, 2)
    segment.chars[0].pitchOverride = { motion: 'glide', notes: [
      { note: 'C4', start: 0, end: 0.5 },
      { note: 'C5', start: 0.5, end: 1 },
    ] }
    segment.chars[1].pitchOverride = { motion: 'flat', notes: [{ note: 'A4', start: 0, end: 1 }] }
    const before = subtitleFrameAt([segment], [], 0.2)!
    const after = subtitleFrameAt([segment], [], 1.2)!
    expect(before.colors[1]).toBe(defaultSubtitleStyle.baseColor)
    expect(after.colors[0]).toBe(subtitleFrameAt([segment], [], 0.9)!.colors[0])
    expect(after.colors[0]).not.toBe(before.colors[0])
    const ass = generatePitchAss([segment], [])
    const firstMain = ass.split('\n').filter(line => line.startsWith('Dialogue: 0,0:00:00.00') && line.includes(',Main,'))
    expect(firstMain.some(line => line.includes(`\\c&H00FCFAF8&}好`))).toBe(true)
  })

  it('tracks the measured F0 color within a sung character and holds its final sample afterward', () => {
    const segment = createSegment('唱你', 0, 2)
    const points = [
      { time: 0.1, hz: 220, confidence: 1, rms: 0.2, voiced: true },
      { time: 0.5, hz: 440, confidence: 1, rms: 0.2, voiced: true },
      { time: 0.9, hz: 660, confidence: 1, rms: 0.2, voiced: true },
    ]
    const beforeVoice = subtitleFrameAt([segment], points, 0.05)!
    const early = subtitleFrameAt([segment], points, 0.2)!
    const late = subtitleFrameAt([segment], points, 0.95)!
    const after = subtitleFrameAt([segment], points, 1.2)!
    expect(beforeVoice.colors[0]).toBe(defaultSubtitleStyle.baseColor)
    expect(beforeVoice.currentLabel).toBe('')
    expect(early.colors[0]).not.toBe(late.colors[0])
    expect(early.currentLabel).toBe('A3')
    expect(late.currentLabel).toBe('E5')
    expect(after.colors[0]).toBe(late.colors[0])
    expect(after.colors[1]).toBe(defaultSubtitleStyle.baseColor)
    expect(generatePitchAss([segment], points).match(/,Main,/g)?.length).toBeGreaterThan(3)
  })

  it('positions labels using actual lyric offsets, including spaces and wider Latin units', () => {
    const spaced = createSegment('你 A 好', 0, 3)
    const compact = createSegment('你A好', 0, 3)
    const spacedX = subtitleUnitCenterX(spaced, 2, defaultSubtitleStyle, null)
    const compactX = subtitleUnitCenterX(compact, 2, defaultSubtitleStyle, null)
    expect(spacedX).toBeGreaterThan(compactX)
    const ass = generatePitchAss([spaced], [], { horizontalPosition: 'left' })
    expect(ass).not.toContain('・')
  })

  it('uses the exact same ASS anchor for each glyph, its pitch label and its dot', () => {
    const segment = createSegment('你 A 好', 0, 3)
    for (const char of segment.chars) char.pitchOverride = { motion: 'flat', notes: [{ note: 'A4', start: 0, end: 1 }] }
    const lines = generatePitchAss([segment], [], { spacing: 2 }).split('\n')
    for (const [index, char] of segment.chars.entries()) {
      const time = `0:00:0${index}.00`
      const unit = lines.find(line => line.startsWith(`Dialogue: 0,${time},`) && line.includes(',Main,') && line.endsWith(`}${char.text}`))!
      const pitch = lines.find(line => line.startsWith(`Dialogue: 1,${time},`) && line.includes(',Pitch,'))!
      const dot = lines.find(line => line.startsWith(`Dialogue: 1,${time},`) && line.includes(',Dot,'))!
      const x = (line: string) => Number(/\\pos\((\d+),/.exec(line)?.[1])
      expect(x(unit)).toBeGreaterThan(0)
      expect(x(pitch)).toBe(x(unit))
      expect(x(dot)).toBe(x(unit))
    }
  })

  it('supports inclusive/exclusive per-note ranges, solid colors and linear gradients', () => {
    const style = { ...defaultSubtitleStyle, colorBand: 'ranges' as const, colorRules: recommendedPitchColorRules(), rangeFallback: 'base' as const }
    const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12)
    expect(pitchColor(hz(60), style)).toBe('#9CA3AF')
    expect(pitchColor(hz(63), style)).toBe('#9CA3AF')
    expect(pitchColor(hz(64), style)).toBe('#fde047')
    expect(pitchColor(hz(74), style)).toBe('#f43f5e')
    expect(pitchColor(hz(75), style)).toBe(style.baseColor)
    expect(pitchColor(hz(55), style)).not.toBe(pitchColor(hz(59), style))
  })

  it('detects the trusted F0 extremes for a project-specific recommendation', () => {
    const range = detectedPitchRange([
      { time: 0, hz: 130.81, confidence: 0.9, rms: 0.1, voiced: true },
      { time: 1, hz: 587.33, confidence: 0.9, rms: 0.1, voiced: true },
      { time: 2, hz: 1000, confidence: 0.1, rms: 0.1, voiced: true },
    ])!
    expect([range.minMidi, range.maxMidi, range.count]).toEqual([48, 74, 2])
    expect(recommendedPitchColorRules(range)[2].toMidi).toBe(74)
  })

  it('colors glyphs by pitch and shows the emphasis dot only under the active character', () => {
    const segment = createSegment('你好', 0, 2)
    segment.chars[0].pitchOverride = { motion: 'glide', notes: [
      { note: 'C4', start: 0, end: 0.5 },
      { note: 'C5', start: 0.5, end: 1 },
    ] }
    const style = { colorBand: 'custom' as const, lowColor: '#0000ff', highColor: '#ff0000', dotSize: 44, dotColorMode: 'custom' as const, dotColor: '#00ff00' }
    const early = subtitleFrameAt([segment], [], 0.2, style)!
    const late = subtitleFrameAt([segment], [], 0.7, style)!
    expect(early.colors[0]).not.toBe(late.colors[0])
    expect(early.activeIndex).toBe(0)
    expect(late.dotColor).toBe('#00ff00')
    const ass = generatePitchAss([segment], [], style)
    expect(ass).toContain('Style: Dot,Microsoft YaHei,44')
    expect(ass).toContain('\\c&H0000FF00&}m ')
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

  it('exports broadly compatible sentence-level SRT timing', () => {
    const segment = createSegment('一句歌词', 1.234, 3.456)
    expect(sentenceSrt([segment])).toBe('1\n00:00:01,234 --> 00:00:03,456\n一句歌词\n')
  })

  it('places ASS captions in the selected grid position and supports a background box', () => {
    const segment = createSegment('歌词', 0, 1)
    const ass = generatePitchAss([segment], [], {
      verticalPosition: 'top', horizontalPosition: 'left', backgroundStyle: 'box',
      backgroundColor: '#000000', backgroundOpacity: 75, bold: false, italic: true,
    })
    expect(ass).toMatch(/Style: Main,[^\n]+,0,-1,0,0,100,100,0,0,1,/)
    expect(ass).toMatch(/,7,80,80,96,1/)
    expect(ass).toContain('&H40000000')
    expect(ass).toContain(',Back,')
  })
})
